/**
 * OAuth service for Xum Governor enrollment.
 *
 * Similar pattern to XumGatewayOauthService but:
 * - Takes a user-provided governor origin (not hardcoded)
 * - Persists credentials to config.json (muxGovernorUrl + muxGovernorToken)
 *
 * Internals are Effect-native (see muxGatewayOauthService.ts for the shape):
 * fallible pipelines are `Effect.gen` programs whose error channel carries a
 * single reason-carrying tagged error, and the public Promise methods are
 * thin `Effect.runPromise` facades folding back into the wire
 * `Result<_, string>` shape, so pre-Effect callers keep working unchanged.
 */

import * as crypto from "crypto";
import { Effect, Schema } from "effect";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import {
  buildGovernorAuthorizeUrl,
  buildGovernorExchangeBody,
  buildGovernorExchangeUrl,
  normalizeGovernorUrl,
} from "@/common/constants/muxGovernorOAuth";
import type { Config } from "@/node/config";
import type { PolicyService } from "@/node/services/policyService";
import type { WindowService } from "@/node/services/windowService";
import { log } from "@/node/services/log";
import { createDeferred, renderOAuthCallbackHtml, toWireResult } from "@/node/utils/oauthUtils";
import { startLoopbackServer } from "@/node/utils/oauthLoopbackServer";
import { OAuthFlowManager } from "@/node/utils/oauthFlowManager";
import { getErrorMessage } from "@/common/utils/errors";

const DEFAULT_DESKTOP_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SERVER_TIMEOUT_MS = 10 * 60 * 1000;

interface ServerFlow {
  state: string;
  governorOrigin: string;
  expiresAtMs: number;
}

/**
 * Typed failure for governor OAuth errors. `reason` carries the exact
 * user-facing string the wire `Result` contract expects, so facades map it
 * 1:1 onto `Err(reason)` without reformatting.
 */
export class MuxGovernorOAuthError extends Schema.TaggedError<MuxGovernorOAuthError>()(
  "MuxGovernorOAuthError",
  { reason: Schema.String }
) {}

export class MuxGovernorOauthService {
  private readonly desktopFlows = new OAuthFlowManager();
  private readonly serverFlows = new Map<string, ServerFlow>();

  constructor(
    private readonly config: Config,
    private readonly windowService?: WindowService,
    private readonly policyService?: PolicyService
  ) {}

  async startDesktopFlow(input: {
    governorOrigin: string;
  }): Promise<Result<{ flowId: string; authorizeUrl: string; redirectUri: string }, string>> {
    return Effect.runPromise(this.startDesktopFlowEffect(input));
  }

  /**
   * Wire-shaped Effect surface for handlerGen router handlers. Uninterruptible
   * (mirrors startDesktopFlowEffect in muxGatewayOauthService.ts): a client
   * abort between the loopback-server acquisition and `desktopFlows.register`
   * would leak the server with nothing left to close it. Flow startup is quick
   * and local, so running it to completion on abort is cheap; an abandoned
   * flow still self-cleans via the registered timeout.
   */
  startDesktopFlowEffect(input: {
    governorOrigin: string;
  }): Effect.Effect<Result<{ flowId: string; authorizeUrl: string; redirectUri: string }, string>> {
    return Effect.uninterruptible(toWireResult(this.launchDesktopFlowEffect(input)));
  }

  private launchDesktopFlowEffect(input: {
    governorOrigin: string;
  }): Effect.Effect<
    { flowId: string; authorizeUrl: string; redirectUri: string },
    MuxGovernorOAuthError
  > {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      // Normalize and validate the governor origin
      const governorOrigin = yield* Effect.try({
        try: () => normalizeGovernorUrl(input.governorOrigin),
        catch: (error) =>
          new MuxGovernorOAuthError({ reason: `Invalid Governor URL: ${getErrorMessage(error)}` }),
      });

      const flowId = crypto.randomUUID();

      const loopback = yield* Effect.tryPromise({
        try: () =>
          startLoopbackServer({
            expectedState: flowId,
            deferSuccessResponse: true,
            renderHtml: (r) =>
              renderOAuthCallbackHtml({
                title: r.success ? "Enrollment complete" : "Enrollment failed",
                message: r.success
                  ? "You can return to Xum. You may now close this tab."
                  : (r.error ?? "Unknown error"),
                success: r.success,
              }),
          }),
        catch: (error) =>
          new MuxGovernorOAuthError({
            reason: `Failed to start OAuth callback listener: ${getErrorMessage(error)}`,
          }),
      });

      const authorizeUrl = buildGovernorAuthorizeUrl({
        governorOrigin,
        redirectUri: loopback.redirectUri,
        state: flowId,
      });

      const resultDeferred = createDeferred<Result<void, string>>();

      self.desktopFlows.register(flowId, {
        server: loopback.server,
        resultDeferred,
        // Keep server-side timeout tied to flow lifetime so abandoned flows
        // (e.g. callers that never invoke waitForDesktopFlow) still self-clean.
        timeoutHandle: setTimeout(() => {
          Effect.runFork(
            self.desktopFlows.finishEffect(flowId, Err("Timed out waiting for OAuth callback"))
          );
        }, DEFAULT_DESKTOP_TIMEOUT_MS),
      });

      // Background fiber: await loopback callback, do token exchange, finish
      // flow. Races against resultDeferred so that if the flow is cancelled/
      // timed out externally, this fiber exits cleanly instead of dangling on
      // loopback.result.
      Effect.runFork(
        self.desktopCallbackPipeline(flowId, governorOrigin, loopback, resultDeferred)
      );

      log.debug(
        `Xum Governor OAuth desktop flow started (flowId=${flowId}, origin=${governorOrigin})`
      );

      return { flowId, authorizeUrl, redirectUri: loopback.redirectUri };
    });
  }

  /**
   * Desktop-flow completion pipeline, forked from `startDesktopFlowEffect`.
   * Races the loopback callback against resultDeferred so that if the flow is
   * cancelled/timed out externally, this fiber exits cleanly instead of
   * dangling on loopback.result.
   */
  private desktopCallbackPipeline(
    flowId: string,
    governorOrigin: string,
    loopback: Awaited<ReturnType<typeof startLoopbackServer>>,
    resultDeferred: ReturnType<typeof createDeferred<Result<void, string>>>
  ): Effect.Effect<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const callbackOrDone = yield* Effect.promise(() =>
        Promise.race([loopback.result, resultDeferred.promise.then((): null => null)])
      );

      // Flow was already finished externally (timeout or cancel).
      if (callbackOrDone === null) return;

      let result: Result<void, string>;
      if (callbackOrDone.success) {
        result = yield* toWireResult(
          self.handleCallbackAndExchange({
            state: flowId,
            governorOrigin,
            code: callbackOrDone.data.code,
            error: null,
          })
        );
      } else {
        result = Err(`Xum Governor OAuth error: ${callbackOrDone.error}`);
      }

      // Render the final browser response based on exchange outcome.
      if (result.success) {
        loopback.sendSuccessResponse();
      } else {
        loopback.sendFailureResponse(result.error);
      }

      yield* self.desktopFlows.finishEffect(flowId, result);
    });
  }

  async waitForDesktopFlow(
    flowId: string,
    opts?: { timeoutMs?: number }
  ): Promise<Result<void, string>> {
    return Effect.runPromise(this.waitForDesktopFlowEffect(flowId, opts));
  }

  /**
   * Wire-shaped Effect surface for handlerGen router handlers. Left
   * interruptible: abandoning the wait does not affect the flow itself (the
   * shared deferred and registered timeout keep the flow's lifecycle intact).
   */
  waitForDesktopFlowEffect(
    flowId: string,
    opts?: { timeoutMs?: number }
  ): Effect.Effect<Result<void, string>> {
    return this.desktopFlows.waitForEffect(flowId, opts?.timeoutMs ?? DEFAULT_DESKTOP_TIMEOUT_MS);
  }

  async cancelDesktopFlow(flowId: string): Promise<void> {
    return Effect.runPromise(this.cancelDesktopFlowEffect(flowId));
  }

  /**
   * Wire-shaped Effect surface for handlerGen router handlers.
   * Uninterruptible: once the cancel begins, the teardown must complete — a
   * client abort mid-cancel must not leave the flow registered (its callback
   * could still persist credentials after the user asked to cancel).
   */
  cancelDesktopFlowEffect(flowId: string): Effect.Effect<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.uninterruptible(
      Effect.gen(function* () {
        if (!self.desktopFlows.has(flowId)) return;
        log.debug(`Xum Governor OAuth desktop flow cancelled (flowId=${flowId})`);
        yield* self.desktopFlows.cancelEffect(flowId);
      })
    );
  }

  startServerFlow(input: {
    governorOrigin: string;
    redirectUri: string;
  }): Result<{ authorizeUrl: string; state: string }, string> {
    // Normalize and validate the governor origin
    let governorOrigin: string;
    try {
      governorOrigin = normalizeGovernorUrl(input.governorOrigin);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Invalid Governor URL: ${message}`);
    }

    const state = crypto.randomUUID();

    // Prune expired flows (best-effort; avoids unbounded growth if callbacks never arrive).
    const now = Date.now();
    for (const [key, flow] of this.serverFlows) {
      if (flow.expiresAtMs <= now) {
        this.serverFlows.delete(key);
      }
    }

    const authorizeUrl = buildGovernorAuthorizeUrl({
      governorOrigin,
      redirectUri: input.redirectUri,
      state,
    });

    this.serverFlows.set(state, {
      state,
      governorOrigin,
      expiresAtMs: Date.now() + DEFAULT_SERVER_TIMEOUT_MS,
    });

    log.debug(`Xum Governor OAuth server flow started (state=${state}, origin=${governorOrigin})`);

    return Ok({ authorizeUrl, state });
  }

  async handleServerCallbackAndExchange(input: {
    state: string | null;
    code: string | null;
    error: string | null;
    errorDescription?: string;
  }): Promise<Result<void, string>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.runPromise(
      toWireResult(
        Effect.gen(function* () {
          const state = input.state;
          if (!state) {
            return yield* Effect.fail(new MuxGovernorOAuthError({ reason: "Missing OAuth state" }));
          }

          const flow = self.serverFlows.get(state);
          if (!flow) {
            return yield* Effect.fail(new MuxGovernorOAuthError({ reason: "Unknown OAuth state" }));
          }

          if (Date.now() > flow.expiresAtMs) {
            self.serverFlows.delete(state);
            return yield* Effect.fail(new MuxGovernorOAuthError({ reason: "OAuth flow expired" }));
          }

          // Regardless of outcome, this flow should not be reused.
          const governorOrigin = flow.governorOrigin;
          self.serverFlows.delete(state);

          yield* self.handleCallbackAndExchange({
            state,
            governorOrigin,
            code: input.code,
            error: input.error,
            errorDescription: input.errorDescription,
          });
        })
      )
    );
  }

  async dispose(): Promise<void> {
    await this.desktopFlows.shutdownAll();
    this.serverFlows.clear();
  }

  private handleCallbackAndExchange(input: {
    state: string;
    governorOrigin: string;
    code: string | null;
    error: string | null;
    errorDescription?: string;
  }): Effect.Effect<void, MuxGovernorOAuthError> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      if (input.error) {
        const message = input.errorDescription
          ? `${input.error}: ${input.errorDescription}`
          : input.error;
        return yield* Effect.fail(
          new MuxGovernorOAuthError({ reason: `Xum Governor OAuth error: ${message}` })
        );
      }

      if (!input.code) {
        return yield* Effect.fail(new MuxGovernorOAuthError({ reason: "Missing OAuth code" }));
      }

      const token = yield* self.exchangeCodeForToken(input.code, input.governorOrigin);

      // Persist to config.json
      yield* Effect.tryPromise({
        try: async () =>
          self.config.editConfig((config) => ({
            ...config,
            muxGovernorUrl: input.governorOrigin,
            muxGovernorToken: token,
          })),
        catch: (error) =>
          new MuxGovernorOAuthError({
            reason: `Failed to save Governor credentials: ${getErrorMessage(error)}`,
          }),
      });

      log.debug(`Xum Governor OAuth exchange completed (state=${input.state})`);

      self.windowService?.focusMainWindow();

      // refreshNow resolves with a wire Result; a rejection stays a defect,
      // matching the previously un-caught await.
      const refreshResult = yield* Effect.promise(async () => self.policyService?.refreshNow());
      if (refreshResult && !refreshResult.success) {
        log.warn("Policy refresh after Governor enrollment failed", {
          error: refreshResult.error,
        });
      }
    });
  }

  private exchangeCodeForToken(
    code: string,
    governorOrigin: string
  ): Effect.Effect<string, MuxGovernorOAuthError> {
    return Effect.gen(function* () {
      const exchangeUrl = buildGovernorExchangeUrl(governorOrigin);

      const response = yield* Effect.tryPromise({
        // async thunk: mirrors the old `await fetch(...)`, which coerces
        // non-Promise returns (e.g. a test's synchronous fetch mock).
        try: async () =>
          fetch(exchangeUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: buildGovernorExchangeBody({ code }),
          }),
        catch: (error) =>
          new MuxGovernorOAuthError({
            reason: `Xum Governor exchange failed: ${getErrorMessage(error)}`,
          }),
      });

      if (!response.ok) {
        // Preserve the HTTP status fallback when the response body is unreadable.
        const errorText = yield* Effect.promise(() => response.text().catch(() => ""));
        const prefix = `Xum Governor exchange failed (${response.status})`;
        return yield* Effect.fail(
          new MuxGovernorOAuthError({ reason: errorText ? `${prefix}: ${errorText}` : prefix })
        );
      }

      const json = yield* Effect.tryPromise({
        try: async () => {
          const parsed = (await response.json()) as unknown;
          // Validate inside the caught region: a null/non-object JSON body
          // folds into the wire error instead of a defect.
          if (parsed === null || typeof parsed !== "object") {
            throw new TypeError("Response was not a JSON object");
          }
          return parsed as { access_token?: unknown };
        },
        catch: (error) =>
          new MuxGovernorOAuthError({
            reason: `Xum Governor exchange failed: ${getErrorMessage(error)}`,
          }),
      });
      const token = typeof json.access_token === "string" ? json.access_token : null;
      if (!token) {
        return yield* Effect.fail(
          new MuxGovernorOAuthError({
            reason: "Xum Governor exchange response missing access_token",
          })
        );
      }

      return token;
    });
  }
}
