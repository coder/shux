/**
 * Xum Gateway OAuth + balance service.
 *
 * Internals are Effect-native: each fallible pipeline is an `Effect.gen`
 * program whose error channel carries typed domain errors, and the public
 * Promise methods are thin `Effect.runPromise` facades that fold those errors
 * back into the wire `Result<_, string>` shape, so pre-Effect callers (oRPC
 * routes, tests) keep working unchanged. Only `MuxGatewaySessionExpiredError`
 * gets its own tag because a caller genuinely branches on it (clearing stored
 * credentials); every other failure is a `MuxGatewayOAuthError` whose `reason`
 * is already the exact user-facing string.
 *
 * Desktop flow bookkeeping (deferreds, loopback server lifetime, timeouts)
 * lives in `OAuthFlowManager`, which is shared with the other OAuth services
 * and is itself Effect-native (per-flow `Scope` lifecycle) — Effect callers
 * here use its `*Effect` surface directly.
 */
import * as crypto from "crypto";
import { Effect, Schema } from "effect";
import type { Result } from "@/common/types/result";
import { Err } from "@/common/types/result";
import {
  buildAuthorizeUrl,
  buildExchangeBody,
  MUX_GATEWAY_EXCHANGE_URL,
  MUX_GATEWAY_ORIGIN,
  MUX_GATEWAY_SESSION_EXPIRED_MESSAGE,
} from "@/common/constants/muxGatewayOAuth";
import type { ProvidersConfigStore } from "@/node/config";
import type { ProviderService } from "@/node/services/providerService";
import { resolveProviderCredentials } from "@/node/utils/providerRequirements";
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
  expiresAtMs: number;
}

/**
 * Typed failure: the gateway rejected the stored credential (HTTP 401).
 * `getAccountStatus` branches on this tag to clear the stored credentials
 * before surfacing the fixed session-expired message.
 */
export class MuxGatewaySessionExpiredError extends Schema.TaggedError<MuxGatewaySessionExpiredError>()(
  "MuxGatewaySessionExpiredError",
  {}
) {}

/**
 * Typed failure for every other gateway/OAuth error. `reason` carries the
 * exact user-facing string the wire `Result` contract expects, so facades map
 * it 1:1 onto `Err(reason)` without reformatting.
 */
export class MuxGatewayOAuthError extends Schema.TaggedError<MuxGatewayOAuthError>()(
  "MuxGatewayOAuthError",
  { reason: Schema.String }
) {}

export class MuxGatewayOauthService {
  private readonly desktopFlows = new OAuthFlowManager();
  private readonly serverFlows = new Map<string, ServerFlow>();

  constructor(
    private readonly providersConfigStore: Pick<ProvidersConfigStore, "loadProvidersConfig">,
    private readonly providerService: ProviderService,
    private readonly windowService?: WindowService
  ) {}

  async getAccountStatus(): Promise<
    Result<
      {
        remaining_microdollars: number;
        ai_gateway_concurrent_requests_per_user: number;
      },
      string
    >
  > {
    return Effect.runPromise(this.getAccountStatusEffect());
  }

  /**
   * Wire-shaped Effect surface for handlerGen router handlers. Left
   * interruptible: the balance fetch is a pure read, and the session-expired
   * credential clear is a single best-effort promise that runs to completion
   * even if the fiber is interrupted while awaiting it.
   */
  getAccountStatusEffect(): Effect.Effect<
    Result<
      { remaining_microdollars: number; ai_gateway_concurrent_requests_per_user: number },
      string
    >
  > {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return toWireResult(
      this.fetchAccountStatusEffect().pipe(
        Effect.catchTag("MuxGatewaySessionExpiredError", () =>
          Effect.gen(function* () {
            yield* self.clearStoredCredentials();
            return yield* Effect.fail(
              new MuxGatewayOAuthError({ reason: MUX_GATEWAY_SESSION_EXPIRED_MESSAGE })
            );
          })
        )
      )
    );
  }

  private fetchAccountStatusEffect(): Effect.Effect<
    { remaining_microdollars: number; ai_gateway_concurrent_requests_per_user: number },
    MuxGatewaySessionExpiredError | MuxGatewayOAuthError
  > {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const providersConfig = self.providersConfigStore.loadProvidersConfig() ?? {};
      const muxConfig = (providersConfig["mux-gateway"] ?? {}) as Record<string, unknown>;
      const creds = resolveProviderCredentials("mux-gateway", {
        couponCode: typeof muxConfig.couponCode === "string" ? muxConfig.couponCode : undefined,
        voucher: typeof muxConfig.voucher === "string" ? muxConfig.voucher : undefined,
      });

      if (!creds.isConfigured || !creds.couponCode) {
        return yield* Effect.fail(
          new MuxGatewayOAuthError({ reason: "Xum Gateway is not logged in" })
        );
      }
      // Captured after the guard: the narrowing does not survive into the thunk closure.
      const couponCode = creds.couponCode;

      const response = yield* Effect.tryPromise({
        // async thunk: mirrors the old `await fetch(...)`, which coerces
        // non-Promise returns (e.g. a test's synchronous fetch mock).
        try: async () =>
          fetch(`${MUX_GATEWAY_ORIGIN}/api/v1/balance`, {
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${couponCode}`,
            },
          }),
        catch: (error) =>
          new MuxGatewayOAuthError({
            reason: `Xum Gateway balance request failed: ${getErrorMessage(error)}`,
          }),
      });

      if (response.status === 401) {
        return yield* Effect.fail(new MuxGatewaySessionExpiredError());
      }

      if (!response.ok) {
        // Preserve the HTTP status fallback when the response body is unreadable.
        const body = yield* Effect.promise(() => response.text().catch(() => ""));
        const prefix = body.trim().slice(0, 200);
        return yield* Effect.fail(
          new MuxGatewayOAuthError({
            reason: `Xum Gateway balance request failed (HTTP ${response.status}): ${
              prefix || response.statusText
            }`,
          })
        );
      }

      const json = yield* Effect.tryPromise({
        try: async (): Promise<unknown> => response.json(),
        catch: (error) =>
          new MuxGatewayOAuthError({
            reason: `Xum Gateway balance response was not valid JSON: ${getErrorMessage(error)}`,
          }),
      });

      // Guard before field access: a null/non-object JSON body must fold into
      // the invalid-payload error instead of a fiber-killing defect.
      if (json === null || typeof json !== "object") {
        return yield* Effect.fail(
          new MuxGatewayOAuthError({ reason: "Xum Gateway returned an invalid balance payload" })
        );
      }
      const payload = json as {
        remaining_microdollars?: unknown;
        ai_gateway_concurrent_requests_per_user?: unknown;
      };
      const remaining = payload.remaining_microdollars;
      const concurrency = payload.ai_gateway_concurrent_requests_per_user;

      if (
        typeof remaining !== "number" ||
        !Number.isFinite(remaining) ||
        !Number.isInteger(remaining) ||
        remaining < 0 ||
        typeof concurrency !== "number" ||
        !Number.isFinite(concurrency) ||
        !Number.isInteger(concurrency) ||
        concurrency < 0
      ) {
        return yield* Effect.fail(
          new MuxGatewayOAuthError({ reason: "Xum Gateway returned an invalid balance payload" })
        );
      }

      return {
        remaining_microdollars: remaining,
        ai_gateway_concurrent_requests_per_user: concurrency,
      };
    });
  }

  /**
   * Best-effort credential clearing on session expiry: failures are swallowed
   * so the session-expired message still reaches the caller. Mirrors the
   * pre-Effect behavior exactly (sequential awaits under a single catch, so a
   * couponCode rejection also skips the voucher clear).
   */
  private clearStoredCredentials(): Effect.Effect<void> {
    return Effect.promise(async () => {
      try {
        await this.providerService.setConfig("mux-gateway", ["couponCode"], "");
        await this.providerService.setConfig("mux-gateway", ["voucher"], "");
      } catch {
        // Credential clearing is best-effort; session expiry still reaches the caller.
      }
    });
  }

  async startDesktopFlow(): Promise<
    Result<{ flowId: string; authorizeUrl: string; redirectUri: string }, string>
  > {
    return Effect.runPromise(this.startDesktopFlowEffect());
  }

  /**
   * Wire-shaped Effect surface for handlerGen router handlers. Uninterruptible
   * (mirrors asAtomicMutation in providerService.ts): a client abort between
   * the loopback-server acquisition and `desktopFlows.register` would leak the
   * server with nothing left to close it. Flow startup is quick and local, so
   * running it to completion on abort is cheap; an abandoned flow still
   * self-cleans via the registered timeout.
   */
  startDesktopFlowEffect(): Effect.Effect<
    Result<{ flowId: string; authorizeUrl: string; redirectUri: string }, string>
  > {
    return Effect.uninterruptible(toWireResult(this.launchDesktopFlowEffect()));
  }

  private launchDesktopFlowEffect(): Effect.Effect<
    { flowId: string; authorizeUrl: string; redirectUri: string },
    MuxGatewayOAuthError
  > {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const flowId = crypto.randomUUID();
      const resultDeferred = createDeferred<Result<void, string>>();

      const loopback = yield* Effect.tryPromise({
        try: () =>
          startLoopbackServer({
            expectedState: flowId,
            deferSuccessResponse: true,
            renderHtml: (r) =>
              renderOAuthCallbackHtml({
                title: r.success ? "Login complete" : "Login failed",
                message: r.success
                  ? "You can return to Xum. You may now close this tab."
                  : (r.error ?? "Unknown error"),
                success: r.success,
                extraHead:
                  '<meta name="theme-color" content="#0e0e0e" />\n    <link rel="stylesheet" href="https://gateway.mux.coder.com/static/css/site.css" />',
              }),
          }),
        catch: (error) =>
          new MuxGatewayOAuthError({
            reason: `Failed to start OAuth callback listener: ${getErrorMessage(error)}`,
          }),
      });

      const authorizeUrl = buildAuthorizeUrl({ redirectUri: loopback.redirectUri, state: flowId });

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
      // flow. Cancellation/timeout still flow through resultDeferred (the
      // promise-native OAuthFlowManager lifecycle), so the fiber exits via the
      // race below rather than interruption.
      Effect.runFork(self.desktopCallbackPipeline(flowId, loopback, resultDeferred));

      log.debug(`Xum Gateway OAuth desktop flow started (flowId=${flowId})`);

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

      log.debug(`Xum Gateway OAuth callback received (flowId=${flowId})`);

      let result: Result<void, string>;
      if (callbackOrDone.success) {
        result = yield* toWireResult(
          self.handleCallbackAndExchange({
            state: callbackOrDone.data.state,
            code: callbackOrDone.data.code,
            error: null,
          })
        );

        if (result.success) {
          loopback.sendSuccessResponse();
        } else {
          loopback.sendFailureResponse(result.error);
        }
      } else {
        result = Err(`Xum Gateway OAuth error: ${callbackOrDone.error}`);
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
        log.debug(`Xum Gateway OAuth desktop flow cancelled (flowId=${flowId})`);
        yield* self.desktopFlows.cancelEffect(flowId);
      })
    );
  }

  startServerFlow(input: { redirectUri: string }): { authorizeUrl: string; state: string } {
    const state = crypto.randomUUID();
    // Prune expired flows (best-effort; avoids unbounded growth if callbacks never arrive).
    const now = Date.now();
    for (const [key, flow] of this.serverFlows) {
      if (flow.expiresAtMs <= now) {
        this.serverFlows.delete(key);
      }
    }

    const authorizeUrl = buildAuthorizeUrl({ redirectUri: input.redirectUri, state });

    this.serverFlows.set(state, {
      state,
      expiresAtMs: Date.now() + DEFAULT_SERVER_TIMEOUT_MS,
    });

    log.debug(`Xum Gateway OAuth server flow started (state=${state})`);

    return { authorizeUrl, state };
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
            return yield* Effect.fail(new MuxGatewayOAuthError({ reason: "Missing OAuth state" }));
          }

          const flow = self.serverFlows.get(state);
          if (!flow) {
            return yield* Effect.fail(new MuxGatewayOAuthError({ reason: "Unknown OAuth state" }));
          }

          if (Date.now() > flow.expiresAtMs) {
            self.serverFlows.delete(state);
            return yield* Effect.fail(new MuxGatewayOAuthError({ reason: "OAuth flow expired" }));
          }

          // Regardless of outcome, this flow should not be reused.
          self.serverFlows.delete(state);

          yield* self.handleCallbackAndExchange({
            state,
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
    code: string | null;
    error: string | null;
    errorDescription?: string;
  }): Effect.Effect<void, MuxGatewayOAuthError> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      if (input.error) {
        const message = input.errorDescription
          ? `${input.error}: ${input.errorDescription}`
          : input.error;
        return yield* Effect.fail(
          new MuxGatewayOAuthError({ reason: `Xum Gateway OAuth error: ${message}` })
        );
      }

      if (!input.code) {
        return yield* Effect.fail(new MuxGatewayOAuthError({ reason: "Missing OAuth code" }));
      }

      const token = yield* self.exchangeCodeForToken(input.code);

      // setConfig resolves with a wire Result; a rejection stays a defect,
      // matching the previously un-caught await.
      const persistResult = yield* Effect.promise(() =>
        self.providerService.setConfig("mux-gateway", ["couponCode"], token)
      );
      if (!persistResult.success) {
        return yield* Effect.fail(new MuxGatewayOAuthError({ reason: persistResult.error }));
      }

      log.debug(`Xum Gateway OAuth exchange completed (state=${input.state})`);

      self.windowService?.focusMainWindow();
    });
  }

  private exchangeCodeForToken(code: string): Effect.Effect<string, MuxGatewayOAuthError> {
    return Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        // async thunk: mirrors the old `await fetch(...)` coercion (see above).
        try: async () =>
          fetch(MUX_GATEWAY_EXCHANGE_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: buildExchangeBody({ code }),
          }),
        catch: (error) =>
          new MuxGatewayOAuthError({
            reason: `Xum Gateway exchange failed: ${getErrorMessage(error)}`,
          }),
      });

      if (!response.ok) {
        const errorText = yield* Effect.promise(() => response.text().catch(() => ""));
        const prefix = `Xum Gateway exchange failed (${response.status})`;
        return yield* Effect.fail(
          new MuxGatewayOAuthError({ reason: errorText ? `${prefix}: ${errorText}` : prefix })
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
          new MuxGatewayOAuthError({
            reason: `Xum Gateway exchange failed: ${getErrorMessage(error)}`,
          }),
      });
      const token = typeof json.access_token === "string" ? json.access_token : null;
      if (!token) {
        return yield* Effect.fail(
          new MuxGatewayOAuthError({ reason: "Xum Gateway exchange response missing access_token" })
        );
      }

      return token;
    });
  }
}
