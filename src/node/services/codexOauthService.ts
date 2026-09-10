/**
 * Codex (ChatGPT) OAuth service.
 *
 * Internals are Effect-native (see muxGatewayOauthService.ts for the shape):
 * fallible pipelines are `Effect.gen` programs whose error channel carries a
 * single reason-carrying tagged error, and the public Promise methods are
 * thin `Effect.runPromise` facades folding back into the wire
 * `Result<_, string>` shape, so pre-Effect callers keep working unchanged.
 * Device-flow cancellation stays on the AbortController seam (the polling
 * loop is a forked fiber, but its lifecycle is controlled through
 * `finishDeviceFlow`'s abort, not fiber interruption).
 */
import * as crypto from "crypto";
import { Duration, Effect, Schema } from "effect";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import {
  buildCodexAuthorizeUrl,
  buildCodexRefreshBody,
  buildCodexTokenExchangeBody,
  CODEX_OAUTH_BROWSER_REDIRECT_URI,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_DEVICE_TOKEN_POLL_URL,
  CODEX_OAUTH_DEVICE_USERCODE_URL,
  CODEX_OAUTH_DEVICE_VERIFY_URL,
  CODEX_OAUTH_TOKEN_URL,
} from "@/common/constants/codexOAuth";
import type { ProvidersConfigStore } from "@/node/config";
import type { ProviderService } from "@/node/services/providerService";
import type { WindowService } from "@/node/services/windowService";
import { log } from "@/node/services/log";
import { sleepWithAbort } from "@/node/utils/abort";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import {
  extractAccountIdFromTokens,
  isCodexOauthAuthExpired,
  parseCodexOauthAuth,
  type CodexOauthAuth,
} from "@/node/utils/codexOauthAuth";
import { createDeferred, toWireResult } from "@/node/utils/oauthUtils";
import { startLoopbackServer } from "@/node/utils/oauthLoopbackServer";
import { OAuthFlowManager } from "@/node/utils/oauthFlowManager";
import { getErrorMessage } from "@/common/utils/errors";

const DEFAULT_DESKTOP_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_DEVICE_TIMEOUT_MS = 15 * 60 * 1000;
const COMPLETED_FLOW_TTL_MS = 60 * 1000;

interface DeviceFlow {
  flowId: string;
  deviceAuthId: string;
  userCode: string;
  verifyUrl: string;
  intervalSeconds: number;
  expiresAtMs: number;

  abortController: AbortController;
  pollingStarted: boolean;

  timeout: ReturnType<typeof setTimeout>;
  cleanupTimeout: ReturnType<typeof setTimeout> | null;

  resultPromise: Promise<Result<void, string>>;
  resolveResult: (result: Result<void, string>) => void;
  settled: boolean;
}

function sha256Base64Url(value: string): string {
  return crypto.createHash("sha256").update(value).digest().toString("base64url");
}

function randomBase64Url(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  return null;
}

function isInvalidGrantError(errorText: string): boolean {
  const trimmed = errorText.trim();
  if (trimmed.length === 0) {
    return false;
  }

  try {
    const json = JSON.parse(trimmed) as unknown;
    if (isPlainObject(json) && json.error === "invalid_grant") {
      return true;
    }
  } catch {
    // Ignore parse failures - fall back to substring checks.
  }

  const lower = trimmed.toLowerCase();
  return lower.includes("invalid_grant") || lower.includes("revoked");
}

/**
 * Typed failure for Codex OAuth errors. `reason` carries the exact
 * user-facing string the wire `Result` contract expects, so facades map it
 * 1:1 onto `Err(reason)` without reformatting.
 */
export class CodexOauthError extends Schema.TaggedError<CodexOauthError>()("CodexOauthError", {
  reason: Schema.String,
}) {}

export class CodexOauthService {
  private readonly desktopFlows = new OAuthFlowManager();
  private readonly deviceFlows = new Map<string, DeviceFlow>();

  private readonly refreshMutex = new AsyncMutex();

  // In-memory cache so getValidAuth() skips disk reads when tokens are valid.
  // Invalidated on every write (exchange, refresh, disconnect).
  private cachedAuth: CodexOauthAuth | null = null;

  constructor(
    private readonly providersConfigStore: ProvidersConfigStore,
    private readonly providerService: ProviderService,
    private readonly windowService?: WindowService
  ) {}

  async disconnect(): Promise<Result<void, string>> {
    return Effect.runPromise(this.disconnectEffect());
  }

  /**
   * Wire-shaped Effect surface for handlerGen router handlers. Uninterruptible
   * (mirrors asAtomicMutation in providerService.ts): a client abort must not
   * skip the persisted-credential clear after the in-memory cache was already
   * invalidated.
   */
  disconnectEffect(): Effect.Effect<Result<void, string>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.uninterruptible(
      Effect.gen(function* () {
        // Clear stored ChatGPT OAuth tokens so Codex-only models are hidden again.
        self.cachedAuth = null;
        // setConfigValue resolves with a wire Result; a rejection stays a
        // defect, matching the previously un-caught await.
        return yield* Effect.promise(() =>
          self.providerService.setConfigValue("openai", ["codexOauth"], undefined)
        );
      })
    );
  }

  async startDesktopFlow(): Promise<Result<{ flowId: string; authorizeUrl: string }, string>> {
    return Effect.runPromise(this.startDesktopFlowEffect());
  }

  /**
   * Wire-shaped Effect surface for handlerGen router handlers. Uninterruptible
   * (mirrors startDesktopFlowEffect in muxGatewayOauthService.ts): a client
   * abort between the loopback-server acquisition and `desktopFlows.register`
   * would leak the server with nothing left to close it. Flow startup is quick
   * and local, so running it to completion on abort is cheap; an abandoned
   * flow still self-cleans via the registered timeout.
   */
  startDesktopFlowEffect(): Effect.Effect<
    Result<{ flowId: string; authorizeUrl: string }, string>
  > {
    return Effect.uninterruptible(toWireResult(this.launchDesktopFlowEffect()));
  }

  private launchDesktopFlowEffect(): Effect.Effect<
    { flowId: string; authorizeUrl: string },
    CodexOauthError
  > {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const flowId = randomBase64Url();

      const codeVerifier = randomBase64Url();
      const codeChallenge = sha256Base64Url(codeVerifier);
      const redirectUri = CODEX_OAUTH_BROWSER_REDIRECT_URI;

      const loopback = yield* Effect.tryPromise({
        try: () =>
          startLoopbackServer({
            port: 1455,
            host: "localhost",
            callbackPath: "/auth/callback",
            validateLoopback: true,
            expectedState: flowId,
            deferSuccessResponse: true,
          }),
        catch: (error) =>
          new CodexOauthError({
            reason: `Failed to start OAuth callback listener: ${getErrorMessage(error)}`,
          }),
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

      const authorizeUrl = buildCodexAuthorizeUrl({
        redirectUri,
        state: flowId,
        codeChallenge,
      });

      // Background fiber: wait for the loopback callback, exchange code for
      // tokens, then finish the flow. Races against resultDeferred (which
      // resolves on cancel/timeout) so the fiber exits cleanly if the flow is
      // cancelled.
      Effect.runFork(
        self.desktopCallbackPipeline({
          flowId,
          redirectUri,
          codeVerifier,
          loopback,
          resultDeferred,
        })
      );

      log.debug(`[Codex OAuth] Desktop flow started (flowId=${flowId})`);

      return { flowId, authorizeUrl };
    });
  }

  /**
   * Desktop-flow completion pipeline, forked from `startDesktopFlowEffect`.
   * Races the loopback callback against resultDeferred so that if the flow is
   * cancelled/timed out externally, this fiber exits cleanly instead of
   * dangling on loopback.result.
   */
  private desktopCallbackPipeline(args: {
    flowId: string;
    redirectUri: string;
    codeVerifier: string;
    loopback: Awaited<ReturnType<typeof startLoopbackServer>>;
    resultDeferred: ReturnType<typeof createDeferred<Result<void, string>>>;
  }): Effect.Effect<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const callbackResult = yield* Effect.promise(() =>
        Promise.race([args.loopback.result, args.resultDeferred.promise.then((): null => null)])
      );

      // null means the flow was finished externally (cancel/timeout).
      if (!callbackResult) return;

      if (!callbackResult.success) {
        yield* self.desktopFlows.finishEffect(args.flowId, Err(callbackResult.error));
        return;
      }

      const exchangeResult: Result<void, string> = yield* toWireResult(
        self.handleDesktopCallbackAndExchange({
          flowId: args.flowId,
          redirectUri: args.redirectUri,
          codeVerifier: args.codeVerifier,
          code: callbackResult.data.code,
          error: null,
          errorDescription: undefined,
        })
      );

      if (exchangeResult.success) {
        args.loopback.sendSuccessResponse();
      } else {
        args.loopback.sendFailureResponse(exchangeResult.error);
      }

      yield* self.desktopFlows.finishEffect(args.flowId, exchangeResult);
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
        if (self.desktopFlows.has(flowId)) {
          log.debug(`[Codex OAuth] Desktop flow cancelled (flowId=${flowId})`);
        }
        yield* self.desktopFlows.cancelEffect(flowId);
      })
    );
  }

  async startDeviceFlow(): Promise<
    Result<
      {
        flowId: string;
        userCode: string;
        verifyUrl: string;
        intervalSeconds: number;
      },
      string
    >
  > {
    return Effect.runPromise(this.startDeviceFlowEffect());
  }

  /**
   * Wire-shaped Effect surface for handlerGen router handlers. Uninterruptible:
   * preserves the pre-handlerGen run-to-completion semantics — a client abort
   * must not allocate a device code upstream without registering the local
   * flow record (and its expiry timeout) that lets callers re-attach or the
   * flow self-clean.
   */
  startDeviceFlowEffect(): Effect.Effect<
    Result<{ flowId: string; userCode: string; verifyUrl: string; intervalSeconds: number }, string>
  > {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.uninterruptible(
      toWireResult(
        Effect.gen(function* () {
          const flowId = randomBase64Url();

          const { deviceAuthId, userCode, intervalSeconds, expiresAtMs } =
            yield* self.requestDeviceUserCode();
          const verifyUrl = CODEX_OAUTH_DEVICE_VERIFY_URL;

          const { promise: resultPromise, resolve: resolveResult } =
            createDeferred<Result<void, string>>();

          const abortController = new AbortController();

          const timeoutMs = Math.min(
            DEFAULT_DEVICE_TIMEOUT_MS,
            Math.max(0, expiresAtMs - Date.now())
          );
          const timeout = setTimeout(() => {
            Effect.runFork(self.finishDeviceFlowEffect(flowId, Err("Device code expired")));
          }, timeoutMs);

          self.deviceFlows.set(flowId, {
            flowId,
            deviceAuthId,
            userCode,
            verifyUrl,
            intervalSeconds,
            expiresAtMs,
            abortController,
            pollingStarted: false,
            timeout,
            cleanupTimeout: null,
            resultPromise,
            resolveResult,
            settled: false,
          });

          log.debug(`[Codex OAuth] Device flow started (flowId=${flowId})`);

          return { flowId, userCode, verifyUrl, intervalSeconds };
        })
      )
    );
  }

  async waitForDeviceFlow(
    flowId: string,
    opts?: { timeoutMs?: number }
  ): Promise<Result<void, string>> {
    return Effect.runPromise(this.waitForDeviceFlowEffect(flowId, opts));
  }

  /**
   * Wire-shaped Effect surface for handlerGen router handlers. Left
   * interruptible: the polling fiber is forked inside a single sync step (so
   * an interrupt cannot mark polling started without launching it), and
   * abandoning the wait leaves the shared deferred and flow timeouts intact.
   */
  waitForDeviceFlowEffect(
    flowId: string,
    opts?: { timeoutMs?: number }
  ): Effect.Effect<Result<void, string>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const flow = self.deviceFlows.get(flowId);
      if (!flow) {
        return Err("OAuth flow not found");
      }

      yield* Effect.sync(() => {
        if (flow.pollingStarted) return;
        flow.pollingStarted = true;
        Effect.runFork(
          self.pollDeviceFlowEffect(flowId).pipe(
            Effect.catchDefect((defect) =>
              Effect.gen(function* () {
                // The polling loop is responsible for resolving the flow; if we
                // reach here something unexpected happened.
                const message = getErrorMessage(defect);
                log.warn(`[Codex OAuth] Device polling crashed (flowId=${flowId}): ${message}`);
                yield* self.finishDeviceFlowEffect(
                  flowId,
                  Err(`Device polling crashed: ${message}`)
                );
              })
            )
          )
        );
      });

      const timeoutMs = opts?.timeoutMs ?? DEFAULT_DEVICE_TIMEOUT_MS;

      // Effect.timeout bounds this wait call only: on timeout it interrupts
      // the promise-wait fiber (the shared deferred is unaffected for other
      // waiters), and its timer is cleared when the deferred wins.
      const result: Result<void, string> = yield* Effect.promise(
        async () => flow.resultPromise
      ).pipe(
        Effect.timeout(Duration.millis(timeoutMs)),
        Effect.catch(() =>
          Effect.succeed<Result<void, string>>(Err("Timed out waiting for device authorization"))
        )
      );

      if (!result.success) {
        // Ensure polling is cancelled on timeout/errors.
        yield* self.finishDeviceFlowEffect(flowId, result);
      }

      return result;
    });
  }

  async cancelDeviceFlow(flowId: string): Promise<void> {
    return Effect.runPromise(this.cancelDeviceFlowEffect(flowId));
  }

  /**
   * Wire-shaped Effect surface for handlerGen router handlers.
   * Uninterruptible: once the cancel begins, the finish bookkeeping must
   * complete — a client abort mid-cancel must not leave the flow polling (it
   * could still persist credentials after the user asked to cancel).
   */
  cancelDeviceFlowEffect(flowId: string): Effect.Effect<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.uninterruptible(
      Effect.gen(function* () {
        const flow = self.deviceFlows.get(flowId);
        if (!flow) return;

        log.debug(`[Codex OAuth] Device flow cancelled (flowId=${flowId})`);
        yield* self.finishDeviceFlowEffect(flowId, Err("OAuth flow cancelled"));
      })
    );
  }

  async getValidAuth(): Promise<Result<CodexOauthAuth, string>> {
    return Effect.runPromise(this.getValidAuthEffect());
  }

  getValidAuthEffect(): Effect.Effect<Result<CodexOauthAuth, string>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const stored = self.readStoredAuth();
      if (!stored) {
        return Err("Codex OAuth is not configured");
      }

      if (!isCodexOauthAuthExpired(stored)) {
        return Ok(stored);
      }

      // acquireUseRelease guarantees the mutex is released on every exit path
      // (refresh success/failure, defects, interruption) — the Effect
      // equivalent of the pre-Effect `await using` lock.
      return yield* Effect.acquireUseRelease(
        Effect.promise(() => self.refreshMutex.acquire()),
        () =>
          Effect.gen(function* () {
            // Re-read after acquiring lock in case another caller refreshed first.
            const latest = self.readStoredAuth();
            if (!latest) {
              return Err("Codex OAuth is not configured");
            }

            if (!isCodexOauthAuthExpired(latest)) {
              return Ok(latest);
            }

            return yield* toWireResult(self.refreshTokens(latest));
          }),
        (lock) => Effect.promise(() => lock[Symbol.asyncDispose]())
      );
    });
  }

  async dispose(): Promise<void> {
    await this.desktopFlows.shutdownAll();

    const deviceIds = [...this.deviceFlows.keys()];
    for (const id of deviceIds) {
      Effect.runSync(this.finishDeviceFlowEffect(id, Err("App shutting down")));
    }

    for (const flow of this.deviceFlows.values()) {
      clearTimeout(flow.timeout);
      if (flow.cleanupTimeout !== null) {
        clearTimeout(flow.cleanupTimeout);
      }
    }

    this.deviceFlows.clear();
  }

  private readStoredAuth(): CodexOauthAuth | null {
    if (this.cachedAuth) {
      return this.cachedAuth;
    }
    const providersConfig = this.providersConfigStore.loadProvidersConfig() ?? {};
    const openaiConfig = providersConfig.openai as Record<string, unknown> | undefined;
    const auth = parseCodexOauthAuth(openaiConfig?.codexOauth);
    this.cachedAuth = auth;
    return auth;
  }

  private persistAuth(auth: CodexOauthAuth): Effect.Effect<Result<void, string>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      // setConfigValue resolves with a wire Result; a rejection stays a
      // defect, matching the previously un-caught await.
      const result = yield* Effect.promise(() =>
        self.providerService.setConfigValue("openai", ["codexOauth"], auth)
      );
      // Invalidate cache so the next readStoredAuth() picks up the persisted value from disk.
      // We clear rather than set because setConfigValue may have side-effects (e.g. file-write
      // failures) and we want the next read to be authoritative.
      self.cachedAuth = null;
      return result;
    });
  }

  private handleDesktopCallbackAndExchange(input: {
    flowId: string;
    redirectUri: string;
    codeVerifier: string;
    code: string | null;
    error: string | null;
    errorDescription?: string;
  }): Effect.Effect<void, CodexOauthError> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      if (input.error) {
        const message = input.errorDescription
          ? `${input.error}: ${input.errorDescription}`
          : input.error;
        return yield* Effect.fail(new CodexOauthError({ reason: `Codex OAuth error: ${message}` }));
      }

      if (!input.code) {
        return yield* Effect.fail(new CodexOauthError({ reason: "Missing OAuth code" }));
      }

      const auth = yield* self.exchangeCodeForTokens({
        code: input.code,
        redirectUri: input.redirectUri,
        codeVerifier: input.codeVerifier,
      });

      const persistResult = yield* self.persistAuth(auth);
      if (!persistResult.success) {
        return yield* Effect.fail(new CodexOauthError({ reason: persistResult.error }));
      }

      log.debug(`[Codex OAuth] Desktop exchange completed (flowId=${input.flowId})`);

      self.windowService?.focusMainWindow();
    });
  }

  private exchangeCodeForTokens(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Effect.Effect<CodexOauthAuth, CodexOauthError> {
    return Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        // async thunk: mirrors the old `await fetch(...)`, which coerces
        // non-Promise returns (e.g. a test's synchronous fetch mock).
        try: async () =>
          fetch(CODEX_OAUTH_TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: buildCodexTokenExchangeBody({
              code: input.code,
              redirectUri: input.redirectUri,
              codeVerifier: input.codeVerifier,
            }),
          }),
        catch: (error) =>
          new CodexOauthError({
            reason: `Codex OAuth exchange failed: ${getErrorMessage(error)}`,
          }),
      });

      if (!response.ok) {
        // Preserve the HTTP status fallback when the response body is unreadable.
        const errorText = yield* Effect.promise(() => response.text().catch(() => ""));
        const prefix = `Codex OAuth exchange failed (${response.status})`;
        return yield* Effect.fail(
          new CodexOauthError({ reason: errorText ? `${prefix}: ${errorText}` : prefix })
        );
      }

      const json = yield* Effect.tryPromise({
        try: async (): Promise<unknown> => response.json(),
        catch: (error) =>
          new CodexOauthError({
            reason: `Codex OAuth exchange failed: ${getErrorMessage(error)}`,
          }),
      });
      if (!isPlainObject(json)) {
        return yield* Effect.fail(
          new CodexOauthError({ reason: "Codex OAuth exchange returned an invalid JSON payload" })
        );
      }

      const accessToken = typeof json.access_token === "string" ? json.access_token : null;
      const refreshToken = typeof json.refresh_token === "string" ? json.refresh_token : null;
      const expiresIn = parseOptionalNumber(json.expires_in);
      const idToken = typeof json.id_token === "string" ? json.id_token : undefined;

      if (!accessToken) {
        return yield* Effect.fail(
          new CodexOauthError({ reason: "Codex OAuth exchange response missing access_token" })
        );
      }

      if (!refreshToken) {
        return yield* Effect.fail(
          new CodexOauthError({ reason: "Codex OAuth exchange response missing refresh_token" })
        );
      }

      if (expiresIn === null) {
        return yield* Effect.fail(
          new CodexOauthError({ reason: "Codex OAuth exchange response missing expires_in" })
        );
      }

      const accountId = extractAccountIdFromTokens({ accessToken, idToken }) ?? undefined;

      const auth: CodexOauthAuth = {
        type: "oauth",
        access: accessToken,
        refresh: refreshToken,
        expires: Date.now() + Math.max(0, Math.floor(expiresIn * 1000)),
        accountId,
      };
      return auth;
    });
  }

  private refreshTokens(current: CodexOauthAuth): Effect.Effect<CodexOauthAuth, CodexOauthError> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        // async thunk: mirrors the old `await fetch(...)`, which coerces
        // non-Promise returns (e.g. a test's synchronous fetch mock).
        try: async () =>
          fetch(CODEX_OAUTH_TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: buildCodexRefreshBody({ refreshToken: current.refresh }),
          }),
        catch: (error) =>
          new CodexOauthError({
            reason: `Codex OAuth refresh failed: ${getErrorMessage(error)}`,
          }),
      });

      if (!response.ok) {
        const errorText = yield* Effect.promise(() => response.text().catch(() => ""));

        // When the refresh token is invalid/revoked, clear persisted auth so subsequent
        // requests fall back to the existing "not connected" behavior.
        if (isInvalidGrantError(errorText)) {
          log.debug("[Codex OAuth] Refresh token rejected; clearing stored auth");
          const disconnectResult = yield* self.disconnectEffect();
          if (!disconnectResult.success) {
            log.warn(
              `[Codex OAuth] Failed to clear stored auth after refresh failure: ${disconnectResult.error}`
            );
          }
        }

        const prefix = `Codex OAuth refresh failed (${response.status})`;
        return yield* Effect.fail(
          new CodexOauthError({ reason: errorText ? `${prefix}: ${errorText}` : prefix })
        );
      }

      const json = yield* Effect.tryPromise({
        try: async (): Promise<unknown> => response.json(),
        catch: (error) =>
          new CodexOauthError({
            reason: `Codex OAuth refresh failed: ${getErrorMessage(error)}`,
          }),
      });
      if (!isPlainObject(json)) {
        return yield* Effect.fail(
          new CodexOauthError({ reason: "Codex OAuth refresh returned an invalid JSON payload" })
        );
      }

      const accessToken = typeof json.access_token === "string" ? json.access_token : null;
      const refreshToken = typeof json.refresh_token === "string" ? json.refresh_token : null;
      const expiresIn = parseOptionalNumber(json.expires_in);
      const idToken = typeof json.id_token === "string" ? json.id_token : undefined;

      if (!accessToken) {
        return yield* Effect.fail(
          new CodexOauthError({ reason: "Codex OAuth refresh response missing access_token" })
        );
      }

      if (expiresIn === null) {
        return yield* Effect.fail(
          new CodexOauthError({ reason: "Codex OAuth refresh response missing expires_in" })
        );
      }

      const accountId = extractAccountIdFromTokens({ accessToken, idToken }) ?? current.accountId;

      const next: CodexOauthAuth = {
        type: "oauth",
        access: accessToken,
        refresh: refreshToken ?? current.refresh,
        expires: Date.now() + Math.max(0, Math.floor(expiresIn * 1000)),
        accountId,
      };

      const persistResult = yield* self.persistAuth(next);
      if (!persistResult.success) {
        return yield* Effect.fail(new CodexOauthError({ reason: persistResult.error }));
      }

      return next;
    }).pipe(
      // Mirror the pre-Effect whole-body try/catch: an unexpected throw —
      // e.g. a rejected persistAuth/disconnect config write, which
      // Effect.promise surfaces as a defect — must fold into the wire error
      // so getValidAuth() keeps returning Err(...) instead of rejecting.
      Effect.catchDefect((defect) =>
        Effect.fail(
          new CodexOauthError({ reason: `Codex OAuth refresh failed: ${getErrorMessage(defect)}` })
        )
      )
    );
  }

  private requestDeviceUserCode(): Effect.Effect<
    {
      deviceAuthId: string;
      userCode: string;
      intervalSeconds: number;
      expiresAtMs: number;
    },
    CodexOauthError
  > {
    return Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        // async thunk: mirrors the old `await fetch(...)` coercion (see above).
        try: async () =>
          fetch(CODEX_OAUTH_DEVICE_USERCODE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
          }),
        catch: (error) =>
          new CodexOauthError({
            reason: `Codex OAuth device auth request failed: ${getErrorMessage(error)}`,
          }),
      });

      if (!response.ok) {
        const errorText = yield* Effect.promise(() => response.text().catch(() => ""));
        const prefix = `Codex OAuth device auth request failed (${response.status})`;
        return yield* Effect.fail(
          new CodexOauthError({ reason: errorText ? `${prefix}: ${errorText}` : prefix })
        );
      }

      const json = yield* Effect.tryPromise({
        try: async (): Promise<unknown> => response.json(),
        catch: (error) =>
          new CodexOauthError({
            reason: `Codex OAuth device auth request failed: ${getErrorMessage(error)}`,
          }),
      });
      if (!isPlainObject(json)) {
        return yield* Effect.fail(
          new CodexOauthError({
            reason: "Codex OAuth device auth response returned an invalid JSON payload",
          })
        );
      }

      const deviceAuthId = typeof json.device_auth_id === "string" ? json.device_auth_id : null;
      const userCode = typeof json.user_code === "string" ? json.user_code : null;
      const interval = parseOptionalNumber(json.interval);
      const expiresIn = parseOptionalNumber(json.expires_in);

      if (!deviceAuthId || !userCode) {
        return yield* Effect.fail(
          new CodexOauthError({
            reason: "Codex OAuth device auth response missing required fields",
          })
        );
      }

      const intervalSeconds = interval !== null ? Math.max(1, Math.floor(interval)) : 5;
      const expiresAtMs =
        expiresIn !== null
          ? Date.now() + Math.max(0, Math.floor(expiresIn * 1000))
          : Date.now() + DEFAULT_DEVICE_TIMEOUT_MS;

      return { deviceAuthId, userCode, intervalSeconds, expiresAtMs };
    });
  }

  /**
   * Device-token polling loop, forked from `waitForDeviceFlowEffect`.
   * Cancellation flows through the flow's AbortController (aborted by
   * `finishDeviceFlow`), not fiber interruption, so the loop always exits via
   * its own checks.
   */
  private pollDeviceFlowEffect(flowId: string): Effect.Effect<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const flow = self.deviceFlows.get(flowId);
      if (!flow || flow.settled) {
        return;
      }

      const intervalSeconds = flow.intervalSeconds;

      while (Date.now() < flow.expiresAtMs) {
        if (flow.abortController.signal.aborted) {
          yield* self.finishDeviceFlowEffect(flowId, Err("OAuth flow cancelled"));
          return;
        }

        const attempt = yield* self.pollDeviceTokenOnce(flow);
        if (attempt.kind === "success") {
          const persistResult = yield* self.persistAuth(attempt.auth);
          if (!persistResult.success) {
            yield* self.finishDeviceFlowEffect(flowId, Err(persistResult.error));
            return;
          }

          log.debug(`[Codex OAuth] Device authorization completed (flowId=${flowId})`);
          self.windowService?.focusMainWindow();
          yield* self.finishDeviceFlowEffect(flowId, Ok(undefined));
          return;
        }

        if (attempt.kind === "fatal") {
          yield* self.finishDeviceFlowEffect(flowId, Err(attempt.message));
          return;
        }

        // OpenCode guide: intervalSeconds * 1000 + 3000. sleepWithAbort keeps
        // cancellation on the AbortController seam; an abort rejection exits
        // the loop like the pre-Effect try/catch did.
        const slept = yield* Effect.promise(() =>
          sleepWithAbort(intervalSeconds * 1000 + 3000, flow.abortController.signal).then(
            () => true,
            () => false
          )
        );
        if (!slept) {
          // Abort is handled via cancelDeviceFlow()/finishDeviceFlow().
          return;
        }
      }

      yield* self.finishDeviceFlowEffect(flowId, Err("Device code expired"));
    });
  }

  private pollDeviceTokenOnce(
    flow: DeviceFlow
  ): Effect.Effect<
    | { kind: "success"; auth: CodexOauthAuth }
    | { kind: "pending" }
    | { kind: "fatal"; message: string }
  > {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: async () =>
          fetch(CODEX_OAUTH_DEVICE_TOKEN_POLL_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ device_auth_id: flow.deviceAuthId, user_code: flow.userCode }),
            signal: flow.abortController.signal,
          }),
        catch: (error) =>
          new CodexOauthError({
            // Abort is treated as cancellation.
            reason: flow.abortController.signal.aborted
              ? "OAuth flow cancelled"
              : `Device authorization failed: ${getErrorMessage(error)}`,
          }),
      });

      if (response.status === 403 || response.status === 404) {
        return { kind: "pending" as const };
      }

      if (response.status !== 200) {
        const errorText = yield* Effect.promise(() => response.text().catch(() => ""));
        const prefix = `Codex OAuth device token poll failed (${response.status})`;
        return {
          kind: "fatal" as const,
          message: errorText ? `${prefix}: ${errorText}` : prefix,
        };
      }

      const json = yield* Effect.promise(
        async (): Promise<unknown> => response.json().catch(() => null)
      );
      if (!isPlainObject(json)) {
        return {
          kind: "fatal" as const,
          message: "Codex OAuth device token poll returned invalid JSON",
        };
      }

      const authorizationCode =
        typeof json.authorization_code === "string" ? json.authorization_code : null;
      const codeVerifier = typeof json.code_verifier === "string" ? json.code_verifier : null;

      if (!authorizationCode || !codeVerifier) {
        return {
          kind: "fatal" as const,
          message: "Codex OAuth device token poll response missing required fields",
        };
      }

      const auth = yield* self.exchangeCodeForTokens({
        code: authorizationCode,
        redirectUri: "https://auth.openai.com/deviceauth/callback",
        codeVerifier,
      });

      return { kind: "success" as const, auth };
    }).pipe(
      // Fold exchange/poll failures into the fatal branch (message is the
      // exact wire error string, matching the pre-Effect returns).
      Effect.catchTag("CodexOauthError", (error) =>
        Effect.succeed({ kind: "fatal" as const, message: error.reason })
      )
    );
  }

  /** Idempotent device-flow finish: all-sync bookkeeping + deferred resolve. */
  private finishDeviceFlowEffect(
    flowId: string,
    result: Result<void, string>
  ): Effect.Effect<void> {
    return Effect.sync(() => {
      const flow = this.deviceFlows.get(flowId);
      if (!flow || flow.settled) {
        return;
      }

      flow.settled = true;
      clearTimeout(flow.timeout);
      flow.abortController.abort();

      try {
        flow.resolveResult(result);
      } finally {
        if (flow.cleanupTimeout !== null) {
          clearTimeout(flow.cleanupTimeout);
        }
        flow.cleanupTimeout = setTimeout(() => {
          this.deviceFlows.delete(flowId);
        }, COMPLETED_FLOW_TTL_MS);
      }
    });
  }
}
