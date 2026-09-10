/**
 * GitHub Copilot OAuth (device-flow) service.
 *
 * Internals are Effect-native (see muxGatewayOauthService.ts for the shape):
 * fallible pipelines are `Effect.gen` programs whose error channel carries a
 * single reason-carrying tagged error, and the public Promise methods are
 * thin `Effect.runPromise` facades folding back into the wire
 * `Result<_, string>` shape, so pre-Effect callers keep working unchanged.
 * Device-flow cancellation stays on the `flow.cancelled` seam (the polling
 * loop is a forked fiber, but its lifecycle is controlled through
 * `finishFlow`, not fiber interruption).
 */
import * as crypto from "crypto";
import { Duration, Effect, Schema } from "effect";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import type { ProviderService } from "@/node/services/providerService";
import type { WindowService } from "@/node/services/windowService";
import { log } from "@/node/services/log";
import { getErrorMessage } from "@/common/utils/errors";
import { COPILOT_MODEL_PREFIXES } from "@/common/utils/copilot/modelRouting";
import { createDeferred, toWireResult } from "@/node/utils/oauthUtils";

const GITHUB_COPILOT_CLIENT_ID = "Ov23li8tweQw6odWQebz";
const SCOPE = "read:user";
const POLLING_SAFETY_MARGIN_MS = 3000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const COMPLETED_FLOW_TTL_MS = 60 * 1000;

const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const COPILOT_API_BASE_URL = "https://api.githubcopilot.com";

interface DeviceFlow {
  flowId: string;
  deviceCode: string;
  interval: number;
  cancelled: boolean;
  timeout: ReturnType<typeof setTimeout>;
  cleanupTimeout: ReturnType<typeof setTimeout> | null;
  pollingStarted: boolean;
  resultPromise: Promise<Result<void, string>>;
  resolveResult: (result: Result<void, string>) => void;
}

/**
 * Typed failure for Copilot OAuth errors. `reason` carries the exact
 * user-facing string the wire `Result` contract expects, so facades map it
 * 1:1 onto `Err(reason)` without reformatting.
 */
export class CopilotOauthError extends Schema.TaggedError<CopilotOauthError>()(
  "CopilotOauthError",
  { reason: Schema.String }
) {}

export class CopilotOauthService {
  private readonly flows = new Map<string, DeviceFlow>();

  constructor(
    private readonly providerService: ProviderService,
    private readonly windowService?: WindowService
  ) {}

  async startDeviceFlow(): Promise<
    Result<{ flowId: string; verificationUri: string; userCode: string }, string>
  > {
    return Effect.runPromise(this.startDeviceFlowEffect());
  }

  /**
   * Wire-shaped Effect surface for handlerGen router handlers. Uninterruptible:
   * preserves the pre-handlerGen run-to-completion semantics — a client abort
   * must not allocate a GitHub device code without registering the local flow
   * record (and its expiry timeout) that lets callers re-attach or the flow
   * self-clean.
   */
  startDeviceFlowEffect(): Effect.Effect<
    Result<{ flowId: string; verificationUri: string; userCode: string }, string>
  > {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.uninterruptible(
      toWireResult(
        Effect.gen(function* () {
          const flowId = crypto.randomUUID();

          const res = yield* Effect.tryPromise({
            // async thunk: mirrors the old `await fetch(...)`, which coerces
            // non-Promise returns (e.g. a test's synchronous fetch mock).
            try: async () =>
              fetch(GITHUB_DEVICE_CODE_URL, {
                method: "POST",
                headers: {
                  Accept: "application/json",
                  "Content-Type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                  client_id: GITHUB_COPILOT_CLIENT_ID,
                  scope: SCOPE,
                }),
              }),
            catch: (error) =>
              new CopilotOauthError({
                reason: `Failed to start device flow: ${getErrorMessage(error)}`,
              }),
          });

          if (!res.ok) {
            const text = yield* Effect.promise(() => res.text().catch(() => ""));
            return yield* Effect.fail(
              new CopilotOauthError({
                reason: `GitHub device code request failed (${res.status}): ${text}`,
              })
            );
          }

          const data = yield* Effect.tryPromise({
            try: async () => {
              const json = (await res.json()) as unknown;
              // Validate inside the caught region: a null/non-object JSON
              // body folds into the wire error instead of a defect.
              if (json === null || typeof json !== "object") {
                throw new TypeError("GitHub device code response was not a JSON object");
              }
              return json as {
                verification_uri?: string;
                user_code?: string;
                device_code?: string;
                interval?: number;
              };
            },
            catch: (error) =>
              new CopilotOauthError({
                reason: `Failed to start device flow: ${getErrorMessage(error)}`,
              }),
          });

          if (!data.verification_uri || !data.user_code || !data.device_code) {
            return yield* Effect.fail(
              new CopilotOauthError({ reason: "Invalid response from GitHub device code endpoint" })
            );
          }

          const { promise: resultPromise, resolve: resolveResult } =
            createDeferred<Result<void, string>>();

          const timeout = setTimeout(() => {
            self.finishFlow(flowId, Err("Timed out waiting for GitHub authorization"));
          }, DEFAULT_TIMEOUT_MS);

          self.flows.set(flowId, {
            flowId,
            deviceCode: data.device_code,
            interval: data.interval ?? 5,
            cancelled: false,
            pollingStarted: false,
            timeout,
            cleanupTimeout: null,
            resultPromise,
            resolveResult,
          });

          log.debug(`Copilot OAuth device flow started (flowId=${flowId})`);

          return {
            flowId,
            verificationUri: data.verification_uri,
            userCode: data.user_code,
          };
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
      const flow = self.flows.get(flowId);
      if (!flow) {
        return Err("Device flow not found");
      }

      // Start polling in background (guard against re-entrant calls, e.g. React StrictMode re-mount)
      yield* Effect.sync(() => {
        if (flow.pollingStarted) return;
        flow.pollingStarted = true;
        Effect.runFork(self.pollForTokenEffect(flow));
      });

      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      // Effect.timeout bounds this wait call only: on timeout it interrupts
      // the promise-wait fiber (the shared deferred is unaffected for other
      // waiters), and its timer is cleared when the deferred wins.
      const result: Result<void, string> = yield* Effect.promise(
        async () => flow.resultPromise
      ).pipe(
        Effect.timeout(Duration.millis(timeoutMs)),
        Effect.catch(() =>
          Effect.succeed<Result<void, string>>(Err("Timed out waiting for GitHub authorization"))
        )
      );

      if (!result.success) {
        yield* Effect.sync(() => self.finishFlow(flowId, result));
      }

      return result;
    });
  }

  /**
   * Wire-shaped Effect surface for handlerGen router handlers.
   * Uninterruptible: once the cancel begins, the finish bookkeeping must
   * complete — a client abort mid-cancel must not leave the flow polling (it
   * could still persist credentials after the user asked to cancel). The
   * bookkeeping itself is a single sync step.
   */
  cancelDeviceFlowEffect(flowId: string): Effect.Effect<void> {
    return Effect.uninterruptible(
      Effect.sync(() => {
        this.cancelDeviceFlow(flowId);
      })
    );
  }

  cancelDeviceFlow(flowId: string): void {
    const flow = this.flows.get(flowId);
    if (!flow) return;

    // Skip if the flow already completed (e.g. unmount cleanup after success)
    if (flow.cancelled) return;

    log.debug(`Copilot OAuth device flow cancelled (flowId=${flowId})`);
    this.finishFlow(flowId, Err("Device flow cancelled"));
  }

  dispose(): void {
    for (const flow of this.flows.values()) {
      clearTimeout(flow.timeout);
      if (flow.cleanupTimeout !== null) clearTimeout(flow.cleanupTimeout);
      flow.cancelled = true;
      try {
        flow.resolveResult(Err("App shutting down"));
      } catch {
        /* already resolved */
      }
    }
    this.flows.clear();
  }

  /**
   * Device-token polling loop, forked from `waitForDeviceFlowEffect`.
   * Cancellation flows through `flow.cancelled` (set by `finishFlow`), not
   * fiber interruption, so the loop always exits via its own checks.
   */
  private pollForTokenEffect(flow: DeviceFlow): Effect.Effect<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      while (!flow.cancelled) {
        const outcome = yield* self.pollOnceEffect(flow).pipe(
          // Transient errors (network failures, setConfig rejections) are
          // logged and retried, matching the pre-Effect try/catch loop.
          Effect.catch((error) =>
            Effect.sync((): "continue" | "stop" => {
              if (flow.cancelled) return "stop";
              log.warn(`Copilot OAuth polling error (will retry): ${getErrorMessage(error)}`);
              return "continue";
            })
          )
        );
        if (outcome === "stop") return;

        // Sleep before next iteration (placed at end so the first poll happens immediately)
        yield* Effect.sleep(Duration.millis(flow.interval * 1000 + POLLING_SAFETY_MARGIN_MS));
      }
    });
  }

  /**
   * One poll of GitHub's access-token endpoint. Returns whether the loop
   * should keep polling; any failure in the error channel takes the
   * transient-retry path in `pollForTokenEffect`.
   */
  private pollOnceEffect(flow: DeviceFlow): Effect.Effect<"continue" | "stop", unknown> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const data = yield* Effect.tryPromise({
        try: async () => {
          const res = await fetch(GITHUB_ACCESS_TOKEN_URL, {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              client_id: GITHUB_COPILOT_CLIENT_ID,
              device_code: flow.deviceCode,
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            }),
          });

          const json = (await res.json()) as unknown;
          // Validate inside the caught region: a null/non-object JSON body
          // takes the transient-retry path (like the pre-Effect try/catch)
          // instead of killing the polling fiber with a defect.
          if (json === null || typeof json !== "object") {
            throw new TypeError("GitHub token response was not a JSON object");
          }
          return json as {
            access_token?: string;
            error?: string;
            interval?: number;
          };
        },
        catch: (error) => error,
      });

      // Re-check cancellation after the fetch round-trip to avoid
      // persisting credentials for a flow that was cancelled mid-request.
      if (flow.cancelled) return "stop" as const;

      const accessToken = data.access_token;
      if (accessToken) {
        // Store token as apiKey for the github-copilot provider
        const persistResult = yield* Effect.tryPromise({
          try: async () =>
            self.providerService.setConfig("github-copilot", ["apiKey"], accessToken),
          catch: (error) => error,
        });

        if (!persistResult.success) {
          self.finishFlow(flow.flowId, Err(persistResult.error));
          return "stop" as const;
        }

        yield* self.fetchModelsAfterLoginEffect(accessToken);

        log.debug(`Copilot OAuth completed successfully (flowId=${flow.flowId})`);
        self.windowService?.focusMainWindow();
        self.finishFlow(flow.flowId, Ok(undefined));
        return "stop" as const;
      }

      if (data.error === "authorization_pending") {
        // Expected during normal flow — will retry after sleep below
      } else if (data.error === "slow_down") {
        flow.interval = data.interval ?? flow.interval + 5;
      } else if (data.error) {
        // Any other error
        self.finishFlow(flow.flowId, Err(`GitHub OAuth error: ${data.error}`));
        return "stop" as const;
      }

      return "continue" as const;
    });
  }

  /**
   * Fetch available models from Copilot API (best-effort, non-blocking on
   * failure): every failure — including a setModels rejection — is logged at
   * debug level and swallowed, matching the pre-Effect inner try/catch.
   */
  private fetchModelsAfterLoginEffect(accessToken: string): Effect.Effect<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const modelsRes = yield* Effect.tryPromise({
        try: async () =>
          fetch(`${COPILOT_API_BASE_URL}/models`, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Openai-Intent": "conversation-edits",
              Accept: "application/json",
            },
          }),
        catch: (error) => error,
      });

      if (!modelsRes.ok) return;

      const modelsData = yield* Effect.tryPromise({
        try: async () => {
          const json = (await modelsRes.json()) as unknown;
          // Validate inside the caught region: a null/non-object JSON body
          // must stay best-effort instead of becoming a defect.
          if (json === null || typeof json !== "object") {
            throw new TypeError("Copilot models response was not a JSON object");
          }
          return json as { data?: Array<{ id: string }> };
        },
        catch: (error) => error,
      });
      if (!Array.isArray(modelsData.data) || modelsData.data.length === 0) return;

      const modelIds = modelsData.data
        .map((m) => m.id)
        .filter((id) => COPILOT_MODEL_PREFIXES.some((prefix) => id.startsWith(prefix)));
      if (modelIds.length === 0) return;

      yield* Effect.tryPromise({
        try: async () => self.providerService.setModels("github-copilot", modelIds),
        catch: (error) => error,
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          log.debug("Failed to fetch Copilot models after login", error);
        })
      ),
      // Defensive: any unexpected throw outside the caught thunks (e.g. a
      // surprising payload item shape in the map/filter above) must also stay
      // best-effort — the pre-Effect code ran this whole block inside one
      // try/catch, and a defect here would kill the polling fiber after the
      // token was persisted but before finishFlow reports success.
      Effect.catchDefect((defect) =>
        Effect.sync(() => {
          log.debug("Failed to fetch Copilot models after login", defect);
        })
      )
    );
  }

  private finishFlow(flowId: string, result: Result<void, string>): void {
    const flow = this.flows.get(flowId);
    if (!flow || flow.cancelled) return;

    flow.cancelled = true;
    clearTimeout(flow.timeout);

    try {
      flow.resolveResult(result);
    } catch {
      // Already resolved
    }

    // Keep completed flow briefly so callers can still await
    if (flow.cleanupTimeout !== null) {
      clearTimeout(flow.cleanupTimeout);
    }
    flow.cleanupTimeout = setTimeout(() => {
      this.flows.delete(flowId);
    }, COMPLETED_FLOW_TTL_MS);
  }
}
