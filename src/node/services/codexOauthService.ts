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
import {
  CODEX_OAUTH_DEFAULT_ACCOUNT_ID,
  CODEX_OAUTH_ACCOUNT_LABEL_MAX_LENGTH,
  CODEX_OAUTH_REFRESH_TIMEOUT_MS,
  CODEX_OAUTH_START_TIMEOUT_MS,
} from "@/common/constants/codexOauthAccounts";
import { FileLeaseManager, type ProvidersConfigStore } from "@/node/config";
import type { ProviderService } from "@/node/services/providerService";
import type { WindowService } from "@/node/services/windowService";
import { log } from "@/node/services/log";
import { sleepWithAbort } from "@/node/utils/abort";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import {
  extractAccountIdFromTokens,
  getCodexOauthAccounts,
  getCodexOauthAccountId,
  getCodexOauthAuth,
  isCodexOauthAuthExpired,
  isValidCodexOauthAccountId,
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

export interface CodexOauthLoginOptions {
  label?: string;
  accountId?: string;
}

interface CodexOauthCredentialSnapshot {
  // An undefined ID pins a legacy credential. An omitted snapshot does not constrain the ID.
  credentialId: string | undefined;
}

interface AccountSelection {
  accountId: string;
  revision: number;
  credentialId?: string;
  auth: CodexOauthAuth | null;
  label?: string;
  selectAsDefault: boolean;
}

interface DeviceFlow {
  destination: AccountSelection;
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

function createNamedAccount(accountId: string, label: unknown, credentials: CodexOauthAuth) {
  const trimmedLabel = typeof label === "string" ? label.trim() : "";
  // Write only known fields. Disk entries can contain unsafe token copies outside credentials.
  return { label: trimmedLabel || accountId, credentials };
}

function isValidLabel(label: string): boolean {
  return label.trim().length > 0 && label.trim().length <= CODEX_OAUTH_ACCOUNT_LABEL_MAX_LENGTH;
}

function matchesAuth(actual: CodexOauthAuth | null, expected: CodexOauthAuth | null): boolean {
  if (!actual || !expected) return actual === expected;
  return (
    actual.access === expected.access &&
    actual.refresh === expected.refresh &&
    actual.expires === expected.expires &&
    actual.accountId === expected.accountId &&
    actual.credentialId === expected.credentialId &&
    actual.legacyCredentialId === expected.legacyCredentialId &&
    actual.invalidReason === expected.invalidReason
  );
}

export class CodexOauthService {
  private readonly desktopFlows = new OAuthFlowManager();
  private readonly deviceFlows = new Map<string, DeviceFlow>();

  private readonly refreshMutexes = new Map<string, AsyncMutex>();
  private readonly accountRevisions = new Map<string, number>();
  private readonly loginSelections = new Map<string, AccountSelection>();
  private readonly loginStartupGenerations = new Map<string, number>();
  private nextLoginStartupGeneration = 0;
  private readonly authMutationMutexes = new Map<string, AsyncMutex>();

  constructor(
    private readonly providersConfigStore: ProvidersConfigStore,
    private readonly providerService: ProviderService,
    private readonly windowService?: WindowService,
    private readonly fileLeaseManager = new FileLeaseManager(providersConfigStore.rootDir)
  ) {}

  async disconnect(accountId?: string): Promise<Result<void, string>> {
    return Effect.runPromise(this.disconnectEffect(accountId));
  }

  // No argument retains legacy behavior. Account-aware callers pass the selected slot ID.
  disconnectEffect(
    accountId = CODEX_OAUTH_DEFAULT_ACCOUNT_ID
  ): Effect.Effect<Result<void, string>> {
    return Effect.suspend(() => {
      if (!isValidCodexOauthAccountId(accountId))
        return Effect.succeed(Err("Invalid Codex OAuth account ID"));
      return this.withAccountMutationEffect(
        accountId,
        this.updateConfigValueEffect(this.accountPath(accountId), () => ({
          value: undefined,
        })).pipe(
          Effect.map((result) => {
            // Failed deletion must preserve active requests and logins. Fence stale writes before releasing the mutex.
            if (result.success) {
              this.accountRevisions.set(accountId, this.getAccountRevision(accountId) + 1);
            }
            return result;
          })
        )
      );
    });
  }

  async setDefaultAccount(accountId: string): Promise<Result<void, string>> {
    return Effect.runPromise(this.setDefaultAccountEffect(accountId));
  }

  setDefaultAccountEffect(accountId: string): Effect.Effect<Result<void, string>> {
    return Effect.suspend(() => {
      if (!isValidCodexOauthAccountId(accountId))
        return Effect.succeed(Err("Invalid Codex OAuth account ID"));
      return this.updateConfigValueEffect(["codexOauthDefaultAccountId"], () => {
        const auth = this.readStoredAuth(accountId);
        return auth && !auth.invalidReason ? { value: accountId } : null;
      });
    });
  }

  async renameAccount(accountId: string, label: string): Promise<Result<void, string>> {
    return Effect.runPromise(this.renameAccountEffect(accountId, label));
  }

  renameAccountEffect(accountId: string, label: string): Effect.Effect<Result<void, string>> {
    return Effect.suspend(() => {
      if (!isValidCodexOauthAccountId(accountId))
        return Effect.succeed(Err("Invalid Codex OAuth account ID"));
      if (!isValidLabel(label)) return Effect.succeed(Err("Invalid Codex OAuth account label"));
      if (accountId === CODEX_OAUTH_DEFAULT_ACCOUNT_ID) {
        return this.updateConfigValueEffect(["codexOauthLabel"], () =>
          this.readStoredAuth(accountId) ? { value: label.trim() } : null
        );
      }
      return this.updateConfigValueEffect(this.accountPath(accountId), (current) => {
        const credentials = isPlainObject(current)
          ? parseCodexOauthAuth(current.credentials)
          : null;
        return credentials ? { value: createNamedAccount(accountId, label, credentials) } : null;
      });
    });
  }

  async startDesktopFlow(
    options?: CodexOauthLoginOptions
  ): Promise<Result<{ flowId: string; authorizeUrl: string }, string>> {
    return Effect.runPromise(this.startDesktopFlowEffect(options));
  }

  /**
   * Wire-shaped Effect surface for handlerGen router handlers. Uninterruptible
   * (mirrors startDesktopFlowEffect in muxGatewayOauthService.ts): a client
   * abort between the loopback-server acquisition and `desktopFlows.register`
   * would leak the server with nothing left to close it. Flow startup is quick
   * and local, so running it to completion on abort is cheap; an abandoned
   * flow still self-cleans via the registered timeout.
   */
  startDesktopFlowEffect(
    options?: CodexOauthLoginOptions
  ): Effect.Effect<Result<{ flowId: string; authorizeUrl: string }, string>> {
    return Effect.uninterruptible(toWireResult(this.launchDesktopFlowEffect(options)));
  }

  private launchDesktopFlowEffect(
    options?: CodexOauthLoginOptions
  ): Effect.Effect<{ flowId: string; authorizeUrl: string }, CodexOauthError> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const flowId = randomBase64Url();

      const codeVerifier = randomBase64Url();
      const codeChallenge = sha256Base64Url(codeVerifier);
      const redirectUri = CODEX_OAUTH_BROWSER_REDIRECT_URI;

      const { destination, resource: loopback } = yield* self.startLogin(
        options,
        Effect.tryPromise({
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
        }),
        (loopback) => loopback.cancel()
      );

      const resultDeferred = createDeferred<Result<void, string>>();

      self.desktopFlows.register(flowId, {
        server: loopback.server,
        resultDeferred: {
          ...resultDeferred,
          resolve: (result) => {
            self.clearLoginSelection(destination);
            resultDeferred.resolve(result);
          },
        },
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
          destination,
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
    destination: AccountSelection;
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
          destination: args.destination,
          isActive: () => self.desktopFlows.has(args.flowId),
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

  async startDeviceFlow(options?: CodexOauthLoginOptions): Promise<
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
    return Effect.runPromise(this.startDeviceFlowEffect(options));
  }

  /**
   * Wire-shaped Effect surface for handlerGen router handlers. Uninterruptible:
   * preserves the pre-handlerGen run-to-completion semantics — a client abort
   * must not allocate a device code upstream without registering the local
   * flow record (and its expiry timeout) that lets callers re-attach or the
   * flow self-clean.
   */
  startDeviceFlowEffect(
    options?: CodexOauthLoginOptions
  ): Effect.Effect<
    Result<{ flowId: string; userCode: string; verifyUrl: string; intervalSeconds: number }, string>
  > {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.uninterruptible(
      toWireResult(
        Effect.gen(function* () {
          const flowId = randomBase64Url();

          const {
            destination,
            resource: { deviceAuthId, userCode, intervalSeconds, expiresAtMs },
          } = yield* self.startLogin(options, self.requestDeviceUserCode(), () =>
            Promise.resolve()
          );
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
            destination,
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

  async getValidAuth(
    accountId?: string,
    expectedCredential?: CodexOauthCredentialSnapshot
  ): Promise<Result<CodexOauthAuth, string>> {
    return Effect.runPromise(this.getValidAuthEffect(accountId, expectedCredential));
  }

  getValidAuthEffect(
    accountId?: string,
    expectedCredential?: CodexOauthCredentialSnapshot
  ): Effect.Effect<Result<CodexOauthAuth, string>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect generators do not inherit this.
    const self = this;
    return Effect.gen(function* () {
      // Pin both the slot and credential. A replacement must not change an active request's account.
      const selectedId = getCodexOauthAccountId(self.readOpenaiConfig(), accountId);
      if (!isValidCodexOauthAccountId(selectedId)) return Err("Invalid Codex OAuth account ID");
      const stored = self.readStoredAuth(selectedId);
      const selection = {
        accountId: selectedId,
        revision: self.getAccountRevision(selectedId),
        credentialId: expectedCredential ? expectedCredential.credentialId : stored?.credentialId,
      };
      const initial = self.validateRequestAuth(stored, selection);
      if (!initial.success || !isCodexOauthAuthExpired(initial.data)) return initial;

      let mutex = self.refreshMutexes.get(selectedId);
      if (!mutex) {
        mutex = new AsyncMutex();
        self.refreshMutexes.set(selectedId, mutex);
      }
      const refreshMutex = mutex;
      return yield* Effect.acquireUseRelease(
        Effect.promise(() => refreshMutex.acquire()),
        () =>
          Effect.gen(function* () {
            const afterMutex = self.validateRequestAuth(self.readStoredAuth(selectedId), selection);
            if (!afterMutex.success || !isCodexOauthAuthExpired(afterMutex.data)) return afterMutex;
            // Hold the file lease through persistence. Other processes adopt only the same credential's rotation.
            return yield* Effect.tryPromise({
              try: () =>
                self.fileLeaseManager.withCodexOauthRefreshLock(selectedId, async () => {
                  const afterLease = self.validateRequestAuth(
                    self.readStoredAuth(selectedId),
                    selection
                  );
                  if (!afterLease.success || !isCodexOauthAuthExpired(afterLease.data))
                    return afterLease;
                  return await Effect.runPromise(
                    toWireResult(
                      self.refreshTokens(
                        { ...selection, auth: afterLease.data, selectAsDefault: false },
                        afterLease.data
                      )
                    )
                  );
                }),
              catch: (error) => getErrorMessage(error),
            }).pipe(
              Effect.catch((error) => Effect.succeed(Err(`Codex OAuth refresh failed: ${error}`)))
            );
          }),
        (lock) => Effect.promise(() => lock[Symbol.asyncDispose]())
      );
    });
  }

  private validateRequestAuth(
    auth: CodexOauthAuth | null,
    selection: Pick<AccountSelection, "accountId" | "credentialId" | "revision">
  ): Result<CodexOauthAuth, string> {
    if (!auth) return Err(`Codex OAuth account "${selection.accountId}" is not configured`);
    const retainsLegacySnapshot =
      selection.credentialId === undefined &&
      auth.legacyCredentialId !== undefined &&
      auth.legacyCredentialId === auth.credentialId;
    if (
      (auth.credentialId !== selection.credentialId && !retainsLegacySnapshot) ||
      this.getAccountRevision(selection.accountId) !== selection.revision
    ) {
      return Err("Codex OAuth account changed during the request");
    }
    if (auth.invalidReason)
      return Err(`Codex OAuth account "${selection.accountId}" needs reconnect`);
    return Ok(auth);
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

  private readOpenaiConfig(): unknown {
    return this.providersConfigStore.loadProvidersConfig()?.openai;
  }

  private readStoredAuth(accountId: string): CodexOauthAuth | null {
    // Read storage so another process cannot leave this service with stale credentials.
    return getCodexOauthAuth(this.readOpenaiConfig(), accountId);
  }

  private getAccountRevision(accountId: string): number {
    return this.accountRevisions.get(accountId) ?? 0;
  }

  private accountPath(accountId: string): string[] {
    // Do not mirror named credentials into the legacy slot. Older versions refresh that slot independently.
    // Keep existing legacy credentials until explicit disconnect; downgrade support does not include named accounts.
    return accountId === CODEX_OAUTH_DEFAULT_ACCOUNT_ID
      ? ["codexOauth"]
      : ["codexOauthAccounts", accountId];
  }

  private updateConfigValueEffect(
    keyPath: string[],
    update: (current: unknown) => { value: unknown } | null
  ): Effect.Effect<Result<void, string>> {
    return this.configMutationEffect(() =>
      this.providerService.updateConfigValue("openai", keyPath, update, { enforcePolicy: true })
    );
  }

  private configMutationEffect(
    mutation: () => Promise<Result<{ applied: boolean }, string>>
  ): Effect.Effect<Result<void, string>> {
    return Effect.uninterruptible(
      Effect.tryPromise({
        try: mutation,
        catch: (error) => getErrorMessage(error),
      }).pipe(
        Effect.map((result): Result<void, string> => {
          if (!result.success) return result;
          return result.data.applied
            ? Ok(undefined)
            : Err("Codex OAuth account changed or is not configured");
        }),
        Effect.catch((error) => Effect.succeed(Err(error)))
      )
    );
  }

  private withAccountMutationEffect<T>(
    accountId: string,
    mutation: Effect.Effect<T>
  ): Effect.Effect<T> {
    let mutex = this.authMutationMutexes.get(accountId);
    if (!mutex) {
      mutex = new AsyncMutex();
      this.authMutationMutexes.set(accountId, mutex);
    }
    const mutationMutex = mutex;
    // Keep persistence and local snapshot updates together. Network requests stay outside this lock.
    return Effect.uninterruptible(
      Effect.acquireUseRelease(
        Effect.promise(() => mutationMutex.acquire()),
        () => mutation,
        (lock) => Effect.promise(() => lock[Symbol.asyncDispose]())
      )
    );
  }

  private startLogin<T>(
    options: CodexOauthLoginOptions | undefined,
    start: Effect.Effect<T, CodexOauthError>,
    cleanup: (resource: T) => Promise<void>
  ): Effect.Effect<{ destination: AccountSelection; resource: T }, CodexOauthError> {
    return Effect.tryPromise({
      try: async () => {
        const initial = await Effect.runPromise(this.selectLoginDestination(options));
        const generation = ++this.nextLoginStartupGeneration;
        this.loginStartupGenerations.set(initial.accountId, generation);
        const assertCurrentStartup = () => {
          if (this.loginStartupGenerations.get(initial.accountId) !== generation) {
            throw new Error("Codex OAuth login startup was superseded");
          }
        };
        const prepare = async (destination: AccountSelection) => {
          const resource = await Effect.runPromise(start);
          try {
            assertCurrentStartup();
            const current = this.readStoredAuth(destination.accountId);
            if (
              this.getAccountRevision(destination.accountId) !== destination.revision ||
              current?.credentialId !== destination.credentialId ||
              (!destination.credentialId && !matchesAuth(current, destination.auth))
            ) {
              throw new Error("Codex OAuth account changed during login startup");
            }
            if (destination.auth && !destination.credentialId) {
              const auth = await this.initializeCredentialId(destination);
              destination = { ...destination, auth, credentialId: auth.credentialId };
            }
            // Claim the selection before yielding. An older startup must not replace a newer invocation.
            assertCurrentStartup();
            this.loginSelections.set(destination.accountId, destination);
            return { destination, resource };
          } catch (error) {
            await cleanup(resource);
            throw error;
          }
        };
        try {
          if (!initial.auth || initial.credentialId) return await prepare(initial);
          // Backfill an ID for cross-process reconnect checks without invalidating active legacy snapshots.
          // Hold rotations until startup and stamping finish.
          return await this.fileLeaseManager.withCodexOauthRefreshLock(
            initial.accountId,
            async () => {
              assertCurrentStartup();
              const destination = await Effect.runPromise(this.selectLoginDestination(options));
              if (destination.revision !== initial.revision) {
                throw new Error("Codex OAuth account changed during login startup");
              }
              return prepare(destination);
            }
          );
        } finally {
          if (this.loginStartupGenerations.get(initial.accountId) === generation) {
            this.loginStartupGenerations.delete(initial.accountId);
          }
        }
      },
      catch: (error) => new CodexOauthError({ reason: getErrorMessage(error) }),
    });
  }

  /** The caller holds the refresh lease through startup and this conditional write. */
  private async initializeCredentialId(destination: AccountSelection): Promise<CodexOauthAuth> {
    let selected: CodexOauthAuth | null = null;
    const { accountId } = destination;
    const result = await this.providerService.updateProviderSection(
      "openai",
      (section) => {
        const current = getCodexOauthAuth(section, accountId);
        if (
          !current ||
          !matchesAuth(current, destination.auth) ||
          this.getAccountRevision(accountId) !== destination.revision
        ) {
          throw new Error("Codex OAuth account changed during login startup");
        }
        const credentialId = crypto.randomUUID();
        selected = { ...current, credentialId, legacyCredentialId: credentialId };
        const next = { ...section };
        if (accountId === CODEX_OAUTH_DEFAULT_ACCOUNT_ID) {
          next.codexOauth = selected;
        } else {
          const accounts = isPlainObject(section?.codexOauthAccounts)
            ? section.codexOauthAccounts
            : {};
          const entry = accounts[accountId];
          next.codexOauthAccounts = {
            ...accounts,
            [accountId]: createNamedAccount(
              accountId,
              isPlainObject(entry) ? entry.label : undefined,
              selected
            ),
          };
        }
        return { value: next };
      },
      { enforcePolicy: true }
    );
    if (!result.success) throw new Error(result.error);
    if (!selected) throw new Error("Codex OAuth account is not configured");
    return selected;
  }

  private selectLoginDestination(
    options?: CodexOauthLoginOptions
  ): Effect.Effect<AccountSelection, CodexOauthError> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect generators do not inherit this.
    const self = this;
    return Effect.gen(function* () {
      if (options?.accountId !== undefined && options.label !== undefined) {
        return yield* Effect.fail(
          new CodexOauthError({ reason: "Specify an account ID or a label, not both" })
        );
      }
      if (options?.label !== undefined && !isValidLabel(options.label)) {
        return yield* Effect.fail(
          new CodexOauthError({ reason: "Invalid Codex OAuth account label" })
        );
      }
      const accountId =
        options?.accountId ??
        (options?.label !== undefined ? crypto.randomUUID() : CODEX_OAUTH_DEFAULT_ACCOUNT_ID);
      if (!isValidCodexOauthAccountId(accountId)) {
        return yield* Effect.fail(
          new CodexOauthError({ reason: "Invalid Codex OAuth account ID" })
        );
      }
      const auth = self.readStoredAuth(accountId);
      if (options?.accountId !== undefined && !auth) {
        return yield* Effect.fail(
          new CodexOauthError({ reason: "Codex OAuth account is not configured" })
        );
      }
      const revision = self.getAccountRevision(accountId);
      return {
        accountId,
        revision,
        credentialId: auth?.credentialId,
        auth,
        label: options?.label?.trim(),
        selectAsDefault:
          options?.label !== undefined &&
          getCodexOauthAccounts(self.readOpenaiConfig()).length === 0,
      };
    });
  }

  private persistAuth(
    selection: AccountSelection,
    auth: CodexOauthAuth
  ): Effect.Effect<Result<void, string>> {
    return this.withAccountMutationEffect(
      selection.accountId,
      this.updateConfigValueEffect(this.accountPath(selection.accountId), (current) => {
        const legacy = selection.accountId === CODEX_OAUTH_DEFAULT_ACCOUNT_ID;
        const stored = parseCodexOauthAuth(
          legacy ? current : isPlainObject(current) ? current.credentials : undefined
        );
        // Compare under the file lock. Old refreshes must not restore deleted or reconnected slots.
        if (
          this.getAccountRevision(selection.accountId) !== selection.revision ||
          !matchesAuth(stored, selection.auth)
        )
          return null;
        if (legacy) return { value: auth };
        return {
          value: createNamedAccount(
            selection.accountId,
            isPlainObject(current) ? current.label : undefined,
            auth
          ),
        };
      })
    );
  }

  private persistLoginAuth(
    selection: AccountSelection,
    auth: CodexOauthAuth,
    isActive: () => boolean
  ): Effect.Effect<Result<void, string>> {
    // Only successful authorization replaces identity. Cancelled logins retain the legacy alias.
    const nextAuth = {
      ...auth,
      credentialId: crypto.randomUUID(),
      legacyCredentialId: undefined,
      invalidReason: undefined,
    };
    return this.withAccountMutationEffect(
      selection.accountId,
      this.configMutationEffect(() =>
        this.providerService.updateProviderSection(
          "openai",
          (section) => {
            if (
              !isActive() ||
              this.loginSelections.get(selection.accountId) !== selection ||
              this.getAccountRevision(selection.accountId) !== selection.revision
            )
              return null;
            const current = isPlainObject(section) ? section : {};
            const legacy = selection.accountId === CODEX_OAUTH_DEFAULT_ACCOUNT_ID;
            // Hand-edited arrays cannot retain named properties when JSON serializes the config.
            const accounts = isPlainObject(current.codexOauthAccounts)
              ? current.codexOauthAccounts
              : {};
            const entry = accounts[selection.accountId];
            const stored = parseCodexOauthAuth(
              legacy ? current.codexOauth : isPlainObject(entry) ? entry.credentials : undefined
            );
            // Token rotation preserves the login ID. Deletion, replacement, or an older writer cannot match it.
            if (
              selection.credentialId === undefined
                ? stored !== null
                : stored?.credentialId !== selection.credentialId
            )
              return null;
            const next = { ...current };
            if (legacy) {
              next.codexOauth = nextAuth;
            } else {
              // Do not mirror named credentials into the legacy slot.
              // Older versions refresh that slot independently and cannot honor project selection.
              // Named login preserves existing legacy credentials until explicit disconnect.
              next.codexOauthAccounts = {
                ...accounts,
                // Legacy config readers redact credentials, including nested account identity fields.
                [selection.accountId]: createNamedAccount(
                  selection.accountId,
                  isPlainObject(entry) ? entry.label : selection.label,
                  nextAuth
                ),
              };
              // Commit the first slot and its selection together. A failed write must leave neither field.
              if (
                selection.selectAsDefault &&
                current.codexOauthDefaultAccountId === undefined &&
                !parseCodexOauthAuth(current.codexOauth)
              ) {
                next.codexOauthDefaultAccountId = selection.accountId;
              }
            }
            return { value: next };
          },
          { enforcePolicy: true }
        )
      ).pipe(
        Effect.map((result) => {
          if (result.success) {
            this.accountRevisions.set(
              selection.accountId,
              this.getAccountRevision(selection.accountId) + 1
            );
            this.clearLoginSelection(selection);
          }
          return result;
        })
      )
    );
  }

  private handleDesktopCallbackAndExchange(input: {
    destination: AccountSelection;
    isActive: () => boolean;
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

      const persistResult = yield* self.persistLoginAuth(input.destination, auth, input.isActive);
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

  private refreshTokens(
    selection: AccountSelection,
    current: CodexOauthAuth
  ): Effect.Effect<CodexOauthAuth, CodexOauthError> {
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
            signal: AbortSignal.timeout(CODEX_OAUTH_REFRESH_TIMEOUT_MS),
          }),
        catch: (error) =>
          new CodexOauthError({
            reason: `Codex OAuth refresh failed: ${getErrorMessage(error)}`,
          }),
      });

      if (!response.ok) {
        const errorText = yield* Effect.promise(() => response.text().catch(() => ""));

        // Keep the credential identity so an in-progress reconnect can replace rejected tokens.
        if (isInvalidGrantError(errorText)) {
          const invalidationResult = yield* self.persistAuth(selection, {
            ...current,
            invalidReason: "invalid_grant",
          });
          if (!invalidationResult.success) {
            log.warn(`[Codex OAuth] Failed to mark rejected auth: ${invalidationResult.error}`);
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

      // Refresh cannot change the ChatGPT identity for this local slot.
      const accountId =
        current.accountId ?? extractAccountIdFromTokens({ accessToken, idToken }) ?? undefined;

      const next: CodexOauthAuth = {
        type: "oauth",
        credentialId: current.credentialId,
        legacyCredentialId: current.legacyCredentialId,
        access: accessToken,
        refresh: refreshToken ?? current.refresh,
        expires: Date.now() + Math.max(0, Math.floor(expiresIn * 1000)),
        accountId,
      };

      const persistResult = yield* self.persistAuth(selection, next);
      if (!persistResult.success) {
        return yield* Effect.fail(new CodexOauthError({ reason: persistResult.error }));
      }

      const validated = self.validateRequestAuth(next, selection);
      if (!validated.success)
        return yield* Effect.fail(new CodexOauthError({ reason: validated.error }));
      return validated.data;
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
            signal: AbortSignal.timeout(CODEX_OAUTH_START_TIMEOUT_MS),
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
          const persistResult = yield* self.persistLoginAuth(
            flow.destination,
            attempt.auth,
            () => !flow.settled
          );
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

  private clearLoginSelection(destination: AccountSelection): void {
    // An older flow must not release a newer login for the same slot.
    if (this.loginSelections.get(destination.accountId) === destination) {
      this.loginSelections.delete(destination.accountId);
    }
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
      this.clearLoginSelection(flow.destination);
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
