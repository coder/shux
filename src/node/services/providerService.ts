/**
 * Provider configuration service (providers.jsonc + provider-relevant main
 * config state).
 *
 * Mutation internals are Effect-native: each fallible pipeline is an
 * `Effect.gen` program and the public Promise methods are thin
 * `Effect.runPromise` facades, so pre-Effect callers (OAuth services, tests)
 * keep working unchanged while oRPC routes ride `handlerGen` directly. Every
 * mutation pipeline is uninterruptible (see `asAtomicMutation`), so a client
 * abort defers until the write and its post-write consistency steps finish —
 * matching the pre-Effect Promise chains, which aborts never cancelled.
 * The wire `Result` unions stay in the success
 * channel — callers branch on `success`, not on thrown errors — and the only
 * typed failure is `ProviderPersistenceError`, which carries the
 * `getErrorMessage` string each facade folds into its own wire error shape
 * (`persistence_failed` codes / `Failed to ...` strings), exactly like the
 * old per-method try/catch blocks did.
 *
 * Synchronous read paths (`list`, `getConfig`, `validateRouteOverrides`) stay
 * plain methods: they compose no async work, so an Effect conversion would
 * add fiber overhead without composition benefit.
 */
import { EventEmitter } from "events";
import { Effect, Schema } from "effect";
import type { Config, ProjectsConfig, ProvidersConfig } from "@/node/config";
import { FileLeaseManager, ProvidersConfigStore } from "@/node/config";
import {
  PROVIDER_DEFINITIONS,
  SUPPORTED_PROVIDERS,
  type ProviderName,
} from "@/common/constants/providers";
import type { BaseProviderConfig } from "@/common/config/schemas/providersConfig";
import type { Result } from "@/common/types/result";
import type {
  AddCustomProviderInput,
  CustomProviderMutationError,
  ProviderConfigInfo,
  ProviderModelEntry,
  ProvidersConfigMap,
} from "@/common/orpc/types";
import { isProviderDisabledInConfig } from "@/common/utils/providers/isProviderDisabled";
import { modelStringStartsWithProvider } from "@/common/utils/providers/modelString";
import { resolveConfigBaseUrl } from "@/common/utils/providers/baseUrl";
import {
  baseUrlQueryFragmentError,
  getCustomProviderIds,
  getShadowedCustomProviderIds,
  isBuiltInProvider,
  isCustomProviderConfig,
  isCustomProviderType,
  validateCustomProviderBaseUrl,
  validateCustomProviderId,
  type ProvidersConfigWithProviderType,
} from "@/common/utils/providers/customProviders";
import {
  getProviderModelEntryId,
  normalizeProviderModelEntries,
} from "@/common/utils/providers/modelEntries";
import { log } from "@/node/services/log";
import {
  checkProviderConfigured,
  isLegacyOpApiKey,
  isProviderAutoRouteEligible,
  resolveProviderCredentials,
} from "@/node/utils/providerRequirements";
import { parseCodexOauthAuth } from "@/node/utils/codexOauthAuth";
import {
  normalizeCoderDeploymentUrl,
  parseCoderGatewayProviders,
} from "@/common/constants/coderOAuth";
import { parseCoderOauthAuth } from "@/node/utils/coderOauthAuth";
import type { PolicyService } from "@/node/services/policyService";
import { getErrorMessage } from "@/common/utils/errors";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

function filterProviderModelsByPolicy(
  models: ProviderModelEntry[] | undefined,
  allowedModels: string[] | null
): ProviderModelEntry[] | undefined {
  if (!models) {
    return undefined;
  }

  if (!Array.isArray(allowedModels)) {
    return models;
  }

  return models.filter((entry) => allowedModels.includes(getProviderModelEntryId(entry)));
}

function buildCustomProviderConfigInfo(
  config: BaseProviderConfig,
  policy?: { forcedBaseUrl?: string; allowedModels?: string[] | null }
): ProviderConfigInfo {
  const baseUrl = policy?.forcedBaseUrl ?? resolveConfigBaseUrl(config);
  const models = filterProviderModelsByPolicy(
    normalizeProviderModelEntries(config.models),
    policy?.allowedModels ?? null
  );
  // Legacy op:// references are ignored at runtime, so report them as "not set".
  const apiKeySet =
    typeof config.apiKey === "string" &&
    config.apiKey.trim().length > 0 &&
    !isLegacyOpApiKey(config.apiKey);
  const apiKeyFile = typeof config.apiKeyFile === "string" ? config.apiKeyFile : undefined;
  const isEnabled = !isProviderDisabledInConfig(config);

  return {
    apiKeySet,
    apiKeyFile,
    apiKeySource: apiKeySet ? "config" : apiKeyFile ? "file" : "keyless",
    baseUrl,
    models,
    displayName: config.displayName,
    providerType: config.providerType ?? "openai-compatible",
    isCustom: true,
    isEnabled,
    isConfigured: isEnabled && baseUrl !== undefined,
  };
}

const DENIED_KEY_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

type CustomProviderMutationResult<T> = Result<T, CustomProviderMutationError>;

interface ProviderPolicy {
  forcedBaseUrl?: string;
  allowedModels?: string[] | null;
}

function addErrorReason<T extends CustomProviderMutationError>(
  error: T,
  reason: string | undefined
): T {
  if (reason === undefined) {
    return error;
  }

  return { ...error, reason };
}

function getProviderConfigRecord(config: unknown): Record<string, BaseProviderConfig> {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return {};
  }

  return config as Record<string, BaseProviderConfig>;
}

/**
 * Typed failure for providers.jsonc / main-config write pipelines. `message`
 * carries `getErrorMessage(cause)` so each facade folds it into its wire
 * error shape without reformatting. A single tag is deliberate: no caller
 * branches on WHICH write failed, only on the folded wire `Result`.
 */
class ProviderPersistenceError extends Schema.TaggedError<ProviderPersistenceError>()(
  "ProviderPersistenceError",
  { message: Schema.String }
) {}

function toPersistenceError(error: unknown): ProviderPersistenceError {
  return new ProviderPersistenceError({ message: getErrorMessage(error) });
}

/**
 * Provider mutations must run their write + post-write consistency steps
 * (change notification, gateway routePriority sync, durable-reference
 * repair) to completion once started: a client abort interrupting the
 * handler fiber mid-lock would otherwise persist the callback's write while
 * skipping the follow-ups, leaving observers and routing state inconsistent.
 * The pre-Effect implementation had exactly these semantics — an aborted
 * oRPC request never cancelled the running Promise chain.
 */
function asAtomicMutation<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> {
  return Effect.uninterruptible(effect);
}

export class ProviderService {
  private readonly policyService: PolicyService | null;
  private readonly emitter = new EventEmitter();
  private lastWarnedShadowedCustomProviderIds: Set<string> | null = null;
  private readonly stopWatchingProvidersFile: () => void;
  // Content-hash fingerprint of providers.jsonc immediately after the last
  // in-app save. The watcher callback re-hashes the file when it fires and
  // skips notification only when the hash still matches — i.e. nothing
  // changed on disk relative to our last known write. Content equality is
  // a stronger signal than mtime: filesystems with coarse timestamp
  // granularity (FAT, some network mounts) can collide on mtimeMs across
  // distinct writes, and an external edit that produces byte-identical
  // contents is a no-op anyway.
  public readonly providersConfigStore: ProvidersConfigStore;
  public readonly fileLeaseManager: FileLeaseManager;
  private lastSelfWriteFingerprint: string | null = null;

  constructor(
    private readonly config: Config,
    policyService?: PolicyService,
    providersConfigStore?: ProvidersConfigStore,
    fileLeaseManager?: FileLeaseManager
  ) {
    this.policyService = policyService ?? null;
    this.providersConfigStore = providersConfigStore ?? new ProvidersConfigStore(config.rootDir);
    this.fileLeaseManager = fileLeaseManager ?? new FileLeaseManager(config.rootDir);
    // The provider config subscription may have many concurrent listeners (e.g. multiple windows).
    // Avoid noisy MaxListenersExceededWarning for normal usage.
    this.emitter.setMaxListeners(50);
    // Notify subscribers when providers.jsonc is edited externally (e.g.
    // manual edits). Skip the redundant watcher event that fires ~300 ms
    // after every in-app save — mutation paths already invoke
    // notifyConfigChanged() directly. We identify a self-write by
    // comparing the file's current content fingerprint (sha256) against
    // the fingerprint captured by notifyFromMutation(); any external
    // edit that changes the bytes between the in-app save and the
    // watcher fire produces a different fingerprint and is forwarded.
    this.stopWatchingProvidersFile = this.providersConfigStore.watchProvidersFile(() => {
      const expected = this.lastSelfWriteFingerprint;
      const current = this.providersConfigStore.getProvidersFileFingerprint();
      if (expected !== null && current !== null && current === expected) {
        // This watcher fire corresponds to our own write (or a benign
        // no-op external save with identical bytes). Clear the
        // fingerprint so the next event is evaluated freshly.
        this.lastSelfWriteFingerprint = null;
        return;
      }
      this.notifyConfigChanged();
    });
  }

  /**
   * Release long-lived OS handles (e.g. the providers.jsonc file watcher).
   * Called by ServiceContainer.dispose() during shutdown and by tests.
   */
  dispose(): void {
    this.stopWatchingProvidersFile();
    this.emitter.removeAllListeners();
  }

  /**
   * Subscribe to config change events. Used by oRPC subscription handler.
   * Returns a cleanup function.
   */
  onConfigChanged(callback: () => void): () => void {
    this.emitter.on("configChanged", callback);
    return () => this.emitter.off("configChanged", callback);
  }

  /**
   * Notify subscribers that provider-relevant config has changed.
   * Called internally on provider config edits, and externally when
   * main config changes affect provider availability (e.g. muxGatewayEnabled).
   */
  notifyConfigChanged(): void {
    this.lastWarnedShadowedCustomProviderIds = null;
    this.emitter.emit("configChanged");
  }

  /**
   * Called by in-app mutation methods after writing providers.jsonc.
   * Captures a content-hash fingerprint of the file we just wrote so
   * the watcher callback can recognise — and skip — the redundant
   * notification it would otherwise fire ~300 ms later. Any external
   * edit produces a different fingerprint and is therefore never
   * accidentally suppressed.
   */
  private notifyFromMutation(): void {
    this.lastSelfWriteFingerprint = this.providersConfigStore.getProvidersFileFingerprint();
    this.notifyConfigChanged();
  }

  /**
   * `notifyFromMutation` with a synchronously throwing subscriber routed into
   * the error channel — the pre-Effect mutation methods invoked it inside
   * their try/catch, so a subscriber throw folded into the wire error.
   */
  private notifyFromMutationEffect(): Effect.Effect<void, ProviderPersistenceError> {
    return Effect.try({ try: () => this.notifyFromMutation(), catch: toPersistenceError });
  }

  /**
   * Run a providers.jsonc read-modify-write callback under the cross-process
   * lock (see FileLeaseManager.withProvidersFileLock). Lock acquisition
   * failures and callback throws land in the error channel.
   */
  private providersFileLockEffect<T>(
    callback: () => Promise<T> | T
  ): Effect.Effect<T, ProviderPersistenceError> {
    return Effect.tryPromise({
      // async thunk: mirrors the old `await this.fileLeaseManager...`, which
      // coerces non-Promise returns (e.g. a test double's synchronous lock).
      try: async () => this.fileLeaseManager.withProvidersFileLock(callback),
      catch: toPersistenceError,
    });
  }

  private listBuiltInProviders(): ProviderName[] {
    const providers = [...SUPPORTED_PROVIDERS];

    if (this.policyService?.isEnforced()) {
      return providers.filter((p) => this.policyService!.isProviderAllowed(p));
    }

    return providers;
  }

  private hasSameWarnedShadowedProviderIds(shadowedProviderIds: Set<string>): boolean {
    if (this.lastWarnedShadowedCustomProviderIds === null) {
      return false;
    }

    if (this.lastWarnedShadowedCustomProviderIds.size !== shadowedProviderIds.size) {
      return false;
    }

    for (const providerId of shadowedProviderIds) {
      if (!this.lastWarnedShadowedCustomProviderIds.has(providerId)) {
        return false;
      }
    }

    return true;
  }

  private detectAndLogShadowedProviders(
    providersConfig: ProvidersConfigWithProviderType
  ): Set<string> {
    const shadowedProviderIds = new Set(getShadowedCustomProviderIds(providersConfig));

    // list() and getConfig() can run during one UI render, so remember the
    // last detected shadow set to avoid duplicate warning noise for that cycle.
    if (
      shadowedProviderIds.size > 0 &&
      !this.hasSameWarnedShadowedProviderIds(shadowedProviderIds)
    ) {
      log.warn(
        `Custom provider ids shadow built-in providers and will keep using custom config: ${Array.from(
          shadowedProviderIds
        )
          .sort()
          .join(", ")}`
      );
    }

    this.lastWarnedShadowedCustomProviderIds = shadowedProviderIds;
    return shadowedProviderIds;
  }

  public list(): string[] {
    try {
      const providers = this.listBuiltInProviders();
      const providersConfig = this.providersConfigStore.loadProvidersConfig() ?? {};
      const customProviderIds = getCustomProviderIds(providersConfig);
      this.detectAndLogShadowedProviders(providersConfig);
      const allowedCustomProviderIds = this.policyService?.isEnforced()
        ? customProviderIds.filter((p) => this.policyService?.isProviderAllowed(p) ?? false)
        : customProviderIds;
      return Array.from(new Set([...providers, ...allowedCustomProviderIds]));
    } catch (error) {
      log.error("Failed to list providers:", error);
      return [];
    }
  }

  /**
   * Get the full providers config with safe info (no actual API keys)
   */
  public getConfig(snapshot?: ProvidersConfig): ProvidersConfigMap {
    // Request builders can project their creation-time snapshot without racing
    // a second disk read that changes instance types or scoped model aliases.
    const providersConfig = snapshot ?? this.providersConfigStore.loadProvidersConfig() ?? {};
    const mainConfig = this.config.loadConfigOrDefault();
    const result: ProvidersConfigMap = {};
    const shadowedCustomProviderIds = this.detectAndLogShadowedProviders(providersConfig);

    for (const provider of this.listBuiltInProviders()) {
      if (shadowedCustomProviderIds.has(provider)) {
        continue;
      }
      const config = (providersConfig[provider] ?? {}) as {
        apiKey?: string;
        apiKeyFile?: string;
        baseUrl?: string;
        baseURL?: string;
        models?: unknown[];
        serviceTier?: string;
        fastModePreviousServiceTier?: unknown;
        wireFormat?: string;
        store?: unknown;
        webSocketTransportEnabled?: unknown;
        cacheTtl?: unknown;
        disableBetaFeatures?: unknown;
        /** OpenAI-only: default auth precedence for Codex-OAuth-allowed models. */
        codexOauthDefaultAuth?: unknown;
        region?: string;
        /** Optional AWS shared config profile name (equivalent to AWS_PROFILE). */
        profile?: string;
        bearerToken?: string;
        accessKeyId?: string;
        secretAccessKey?: string;
        /** Persisted provider toggle: only `false` is stored; missing means enabled. */
        enabled?: unknown;
        /** OpenAI-only: stored Codex OAuth tokens (never sent to frontend). */
        codexOauth?: unknown;
        /** Coder-only: deployment access URL. */
        deploymentUrl?: string;
        /** Coder-only: stored Coder OAuth tokens (never sent to frontend). */
        coderOauth?: unknown;
        /** Coder-only: model IDs discovered from the deployment's AI Bridge. */
        discoveredModels?: unknown;
        /** Coder-only: model IDs the user explicitly removed. */
        removedModels?: unknown;
        /** Coder-only: discovered AI Gateway provider instances ({name, type}). */
        discoveredProviders?: unknown;
        /** Coder-only: user-declared AI Gateway provider instances ({name, type}). */
        additionalProviders?: unknown;
      };

      const forcedBaseUrl = this.policyService?.isEnforced()
        ? this.policyService.getForcedBaseUrl(provider)
        : undefined;

      const allowedModels = this.policyService?.isEnforced()
        ? (this.policyService.getEffectivePolicy()?.providerAccess?.find((p) => p.id === provider)
            ?.allowedModels ?? null)
        : null;

      const normalizedModels =
        config.models === undefined ? undefined : normalizeProviderModelEntries(config.models);
      const filteredModels = filterProviderModelsByPolicy(normalizedModels, allowedModels);

      const codexOauthSet =
        provider === "openai" && parseCodexOauthAuth(config.codexOauth) !== null;
      let isEnabled = !isProviderDisabledInConfig(config);
      if (provider === "mux-gateway" && mainConfig.muxGatewayEnabled === false) {
        isEnabled = false;
      }

      const explicitBaseUrl = resolveConfigBaseUrl(config);

      const providerInfo: ProviderConfigInfo = {
        // Legacy op:// references are ignored at runtime, so report them as "not set".
        apiKeySet: !!config.apiKey && !isLegacyOpApiKey(config.apiKey),
        // Users can disable providers without removing credentials from providers.jsonc.
        isEnabled,
        isConfigured: false, // computed below
        baseUrl: forcedBaseUrl ?? explicitBaseUrl,
        apiKeyFile: typeof config.apiKeyFile === "string" ? config.apiKeyFile : undefined,
        models: filteredModels,
      };

      // Provider processing tier. OpenAI and xAI share the service_tier field,
      // but xAI only accepts default/priority.
      const serviceTier = config.serviceTier;
      const validOpenAIServiceTier =
        provider === "openai" &&
        (serviceTier === "auto" ||
          serviceTier === "default" ||
          serviceTier === "flex" ||
          serviceTier === "priority");
      const validXAIServiceTier =
        provider === "xai" && (serviceTier === "default" || serviceTier === "priority");
      if (validOpenAIServiceTier || validXAIServiceTier) {
        providerInfo.serviceTier = serviceTier;
      }

      const fastModePreviousServiceTier = config.fastModePreviousServiceTier;
      const validOpenAIFastModePreviousTier =
        provider === "openai" &&
        (fastModePreviousServiceTier === "auto" ||
          fastModePreviousServiceTier === "default" ||
          fastModePreviousServiceTier === "flex" ||
          fastModePreviousServiceTier === "unset");
      const validXAIFastModePreviousTier =
        provider === "xai" &&
        (fastModePreviousServiceTier === "default" || fastModePreviousServiceTier === "unset");
      if (validOpenAIFastModePreviousTier || validXAIFastModePreviousTier) {
        providerInfo.fastModePreviousServiceTier = fastModePreviousServiceTier;
      }

      // OpenAI-specific: wire format (responses vs chatCompletions)
      const wireFormat = config.wireFormat;
      if (
        provider === "openai" &&
        (wireFormat === "responses" || wireFormat === "chatCompletions")
      ) {
        providerInfo.wireFormat = wireFormat;
      }

      // OpenAI-specific: response storage setting (required for ZDR).
      // xAI frontier Grok always uses store=false in the request path (no settings surface).
      if (provider === "openai" && typeof config.store === "boolean") {
        providerInfo.store = config.store;
      }

      if (provider === "openai" && typeof config.webSocketTransportEnabled === "boolean") {
        providerInfo.webSocketTransportEnabled = config.webSocketTransportEnabled;
      }

      // Anthropic-specific fields
      const cacheTtl = config.cacheTtl;
      if (provider === "anthropic" && (cacheTtl === "5m" || cacheTtl === "1h")) {
        providerInfo.cacheTtl = cacheTtl;
      }

      // Anthropic-specific: disable all beta features for ZDR orgs.
      if (provider === "anthropic" && config.disableBetaFeatures === true) {
        providerInfo.disableBetaFeatures = true;
      }

      if (provider === "openai") {
        providerInfo.codexOauthSet = codexOauthSet;

        const codexOauthDefaultAuth = config.codexOauthDefaultAuth;
        if (codexOauthDefaultAuth === "oauth" || codexOauthDefaultAuth === "apiKey") {
          providerInfo.codexOauthDefaultAuth = codexOauthDefaultAuth;
        }
      }
      // AWS/Bedrock-specific fields
      if (provider === "bedrock") {
        providerInfo.aws = {
          region: config.region,
          profile: config.profile,
          bearerTokenSet: !!config.bearerToken,
          accessKeyIdSet: !!config.accessKeyId,
          secretAccessKeySet: !!config.secretAccessKey,
        };
      }

      // Coder-specific fields: deployment URL + OAuth connection status.
      // "Connected" only when the stored tokens were minted by the deployment
      // actually used for routing (tokens are issuer-bound; see
      // coderOauthAuth.ts). Policy can force that URL, in which case the raw
      // editable field is ignored here exactly like it is for routing (see
      // coderEffectiveProviderConfig in providerModelFactory.ts) — otherwise
      // editing the unlocked field would report "Not connected" while
      // requests keep working against the forced deployment.
      if (provider === "coder") {
        const coderOauth = parseCoderOauthAuth(config.coderOauth);
        const effectiveDeploymentUrl = forcedBaseUrl ?? config.deploymentUrl;
        const configuredDeploymentUrl =
          typeof effectiveDeploymentUrl === "string"
            ? normalizeCoderDeploymentUrl(effectiveDeploymentUrl)
            : null;
        providerInfo.coderOauthSet =
          coderOauth !== null &&
          configuredDeploymentUrl !== null &&
          coderOauth.deploymentUrl === configuredDeploymentUrl;
        // Credential presence, independent of routability: editing the
        // deployment URL flips coderOauthSet to false, but the stored blob
        // (a full-privilege credential on its own issuer) must remain
        // disconnectable/revocable from the UI without restoring the URL.
        providerInfo.coderOauthCredentialStored = coderOauth !== null;
        if (typeof effectiveDeploymentUrl === "string" && effectiveDeploymentUrl) {
          providerInfo.deploymentUrl = effectiveDeploymentUrl;
        }
        // The discovered AI Bridge catalog gates gateway routing (see
        // gatewayModelCatalog.ts); the frontend needs it to mirror the
        // backend's accessibility decisions. Presence matters (present []
        // means "authoritatively empty"), so only a missing key is dropped.
        // The persisted catalog is policy-unfiltered by design (a temporary
        // policy must not carve models out of durable state); the CURRENT
        // policy is applied here at exposure time, like `models` above.
        if (Array.isArray(config.discoveredModels)) {
          const discovered = config.discoveredModels.filter(
            (id): id is string => typeof id === "string"
          );
          providerInfo.discoveredModels = Array.isArray(allowedModels)
            ? discovered.filter((id) => allowedModels.includes(id))
            : discovered;
        }
        // Gateway provider instance metadata ({name, type}): option/header
        // builders and the frontend derive the wire protocol for
        // gateway-scoped coder:<name>/<model> strings from these. Not policy
        // filtered — instance metadata is routing plumbing, not model access.
        const discoveredProviders = parseCoderGatewayProviders(config.discoveredProviders);
        if (discoveredProviders.length > 0) {
          providerInfo.discoveredProviders = discoveredProviders;
        }
        const additionalProviders = parseCoderGatewayProviders(config.additionalProviders);
        if (additionalProviders.length > 0) {
          providerInfo.additionalProviders = additionalProviders;
        }
        // Durable user removals gate accessibility even while the discovered
        // catalog is unknown (see gatewayModelCatalog.ts); the frontend needs
        // them to mirror the backend's routing decisions. No policy filter:
        // removals are user intent, not catalog content.
        if (Array.isArray(config.removedModels)) {
          const removed = config.removedModels.filter((id): id is string => typeof id === "string");
          if (removed.length > 0) {
            providerInfo.removedModels = removed;
          }
        }
      }

      // Xum Gateway-specific fields (check couponCode first, fallback to legacy voucher).
      // Gateway stores enabled/models in the global config (~/.xum/config.json), not
      // in providers.jsonc, so override the generic isEnabled with the gateway-specific value.
      if (provider === "mux-gateway") {
        const muxConfig = config as { couponCode?: string; voucher?: string };
        providerInfo.couponCodeSet = !!(muxConfig.couponCode ?? muxConfig.voucher);
        const globalConfig = this.config.loadConfigOrDefault();
        providerInfo.isEnabled = globalConfig.muxGatewayEnabled !== false;
        providerInfo.gatewayModels = globalConfig.muxGatewayModels ?? [];
      }

      // Compute isConfigured using shared utility (checks config + env vars).
      // Disabled providers intentionally surface as not configured in the UI.
      // Use providerInfo.isEnabled (not the local `isEnabled`) because gateway
      // overrides it from global config — using the providers.jsonc value would
      // make a disabled gateway appear configured.
      // Coder credentials are issuer-bound: when policy forces the base URL,
      // configured-state must resolve against that URL (mirroring routing),
      // not the raw editable deploymentUrl field.
      const effectiveCheckConfig =
        provider === "coder" && forcedBaseUrl !== undefined
          ? { ...config, deploymentUrl: forcedBaseUrl }
          : config;
      const configCheck = checkProviderConfigured(provider, effectiveCheckConfig);
      providerInfo.isConfigured = providerInfo.isEnabled && configCheck.isConfigured;
      providerInfo.apiKeySource = configCheck.apiKeySource;
      if (forcedBaseUrl === undefined && configCheck.baseUrlSource && configCheck.baseUrlResolved) {
        providerInfo.baseUrlSource = configCheck.baseUrlSource;
        providerInfo.baseUrlResolved = configCheck.baseUrlResolved;
      }

      if (provider === "openai" && isEnabled && codexOauthSet) {
        providerInfo.isConfigured = true;
      }

      result[provider] = providerInfo;
    }

    for (const providerId of getCustomProviderIds(providersConfig)) {
      const providerConfig = providersConfig[providerId];
      if (!isCustomProviderConfig(providerConfig)) {
        continue;
      }

      if (this.policyService?.isEnforced() && !this.policyService.isProviderAllowed(providerId)) {
        continue;
      }

      // Reuse getProviderPolicy() so the "lookup providerAccess entry → narrow to
      // { forcedBaseUrl, allowedModels }" shape lives in one place. When policy is
      // not enforced, it returns {}, which buildCustomProviderConfigInfo handles
      // identically (both forcedBaseUrl and allowedModels fall back to defaults).
      result[providerId] = buildCustomProviderConfigInfo(
        providerConfig,
        this.getProviderPolicy(providerId)
      );
    }

    // Policy-hidden Coder selections still need instance types to resolve an
    // allowed upstream fallback, and credential presence for Disconnect. Keep
    // this view non-routable: no models, endpoint settings or authentication data.
    // A custom provider shadowing "coder" owns the key and has no gateway metadata.
    if (!result.coder && !shadowedCustomProviderIds.has("coder")) {
      const coderConfig = providersConfig.coder as
        | { coderOauth?: unknown; discoveredProviders?: unknown; additionalProviders?: unknown }
        | undefined;
      const coderOauth = parseCoderOauthAuth(coderConfig?.coderOauth);
      const discoveredProviders = parseCoderGatewayProviders(coderConfig?.discoveredProviders);
      const additionalProviders = parseCoderGatewayProviders(coderConfig?.additionalProviders);
      if (coderOauth !== null || discoveredProviders.length > 0 || additionalProviders.length > 0) {
        result.coder = {
          apiKeySet: false,
          isEnabled: false,
          isConfigured: false,
          ...(coderOauth !== null && { coderOauthCredentialStored: true }),
          ...(discoveredProviders.length > 0 && { discoveredProviders }),
          ...(additionalProviders.length > 0 && { additionalProviders }),
        };
      }
    }

    return result;
  }

  private getProviderPolicy(provider: string): ProviderPolicy {
    if (!this.policyService?.isEnforced()) {
      return {};
    }

    const providerPolicy = this.policyService
      .getEffectivePolicy()
      ?.providerAccess?.find((entry) => entry.id === provider);
    return {
      forcedBaseUrl: providerPolicy?.forcedBaseUrl,
      allowedModels: providerPolicy?.allowedModels ?? null,
    };
  }

  private getPolicyDeniedError(message: string, reason?: string): CustomProviderMutationError {
    return addErrorReason({ code: "policy_denied", message }, reason);
  }

  private getDisallowedModelsByPolicy(provider: string, models: ProviderModelEntry[]): string[] {
    if (!this.policyService?.isEnforced()) {
      return [];
    }

    const allowedModels = this.getProviderPolicy(provider).allowedModels ?? null;
    if (!Array.isArray(allowedModels)) {
      return [];
    }

    return models
      .map((entry) => getProviderModelEntryId(entry))
      .filter((modelId) => !allowedModels.includes(modelId));
  }

  public addCustomProvider(
    input: AddCustomProviderInput
  ): Promise<CustomProviderMutationResult<ProviderConfigInfo>> {
    return Effect.runPromise(this.addCustomProviderEffect(input));
  }

  public addCustomProviderEffect(
    input: AddCustomProviderInput
  ): Effect.Effect<CustomProviderMutationResult<ProviderConfigInfo>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    const provider = input.provider.trim();
    return Effect.gen(function* () {
      if (isBuiltInProvider(provider)) {
        return {
          success: false as const,
          error: {
            code: "built_in_provider" as const,
            message: `Provider ${provider} is built in and cannot be added as custom.`,
          },
        };
      }

      const validation = validateCustomProviderId(provider);
      if (!validation.ok) {
        return {
          success: false as const,
          error: addErrorReason(
            { code: "invalid_provider_id" as const, message: "Invalid custom provider id." },
            validation.reason
          ),
        };
      }

      const baseUrl = input.baseUrl.trim();

      // Read-modify-write under the cross-process lock so concurrent writers
      // (other windows, CLI processes) cannot clobber each other's saves.
      // The callback returns an error result to bail, or null once saved.
      const lockError = yield* self.providersFileLockEffect(
        (): CustomProviderMutationResult<ProviderConfigInfo> | null => {
          const providersConfig = getProviderConfigRecord(
            self.providersConfigStore.loadProvidersConfig() ?? {}
          );
          if (Object.hasOwn(providersConfig, provider)) {
            return {
              success: false,
              error: {
                code: "duplicate_provider",
                message: `Provider ${provider} already exists in providers config.`,
              },
            };
          }

          const baseUrlValidation = validateCustomProviderBaseUrl(baseUrl);
          if (!baseUrlValidation.ok) {
            return {
              success: false,
              error: {
                code: "invalid_base_url",
                message: baseUrlValidation.reason,
              },
            };
          }

          if (self.policyService?.isEnforced() && !self.policyService.isProviderAllowed(provider)) {
            return {
              success: false,
              error: self.getPolicyDeniedError(`Provider ${provider} is not allowed by policy.`),
            };
          }

          const providerPolicy = self.getProviderPolicy(provider);
          const persistedBaseUrl = providerPolicy.forcedBaseUrl ?? baseUrl;
          if (providerPolicy.forcedBaseUrl && baseUrl !== providerPolicy.forcedBaseUrl) {
            return {
              success: false,
              error: self.getPolicyDeniedError(
                `Provider ${provider} base URL is locked by policy.`,
                `Expected ${providerPolicy.forcedBaseUrl}.`
              ),
            };
          }

          const normalizedModels = normalizeProviderModelEntries(input.models);
          const disallowedModels = self.getDisallowedModelsByPolicy(provider, normalizedModels);
          if (disallowedModels.length > 0) {
            return {
              success: false,
              error: self.getPolicyDeniedError(
                `One or more models are not allowed by policy: ${disallowedModels.join(", ")}`
              ),
            };
          }

          const displayName = input.displayName?.trim();
          const apiKey = input.apiKey?.trim();
          const apiKeyFile = input.apiKeyFile?.trim();
          const providerType = input.providerType ?? "openai-compatible";
          const providerConfig: BaseProviderConfig = {
            providerType,
            baseUrl: persistedBaseUrl,
            enabled: true,
            ...(displayName ? { displayName } : {}),
            ...(apiKey ? { apiKey } : {}),
            ...(apiKeyFile ? { apiKeyFile } : {}),
            ...(normalizedModels.length > 0 ? { models: normalizedModels } : {}),
          };

          providersConfig[provider] = providerConfig;
          self.providersConfigStore.saveProvidersConfig(providersConfig);
          return null;
        }
      );
      if (lockError) {
        return lockError;
      }

      // Reload + notify stay inside the guarded region: the pre-Effect
      // try/catch covered them, so a throwing reload or subscriber folds
      // into the persistence_failed wire error below.
      return yield* Effect.try({
        try: (): CustomProviderMutationResult<ProviderConfigInfo> => {
          const providerInfo = self.getConfig()[provider];
          if (!providerInfo) {
            return {
              success: false,
              error: {
                code: "persistence_failed",
                message: `Provider ${provider} was saved but could not be reloaded.`,
              },
            };
          }

          self.notifyFromMutation();
          return { success: true, data: providerInfo };
        },
        catch: toPersistenceError,
      });
    }).pipe(
      Effect.catchTag("ProviderPersistenceError", (error) =>
        Effect.succeed<CustomProviderMutationResult<ProviderConfigInfo>>({
          success: false,
          error: addErrorReason(
            { code: "persistence_failed", message: `Failed to add provider ${provider}.` },
            error.message
          ),
        })
      ),
      asAtomicMutation
    );
  }

  public removeCustomProvider(providerInput: string): Promise<CustomProviderMutationResult<void>> {
    return Effect.runPromise(this.removeCustomProviderEffect(providerInput));
  }

  public removeCustomProviderEffect(
    providerInput: string
  ): Effect.Effect<CustomProviderMutationResult<void>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const provider = providerInput.trim();
      const providersConfig = getProviderConfigRecord(
        self.providersConfigStore.loadProvidersConfig() ?? {}
      );
      const providerConfig = providersConfig[provider];
      // Manual providers.jsonc edits can shadow a built-in id. Removing that entry
      // restores the built-in default, so only reject bona fide built-in configs.
      const isShadowedCustomProvider =
        isBuiltInProvider(provider) && isCustomProviderConfig(providerConfig);

      if (isBuiltInProvider(provider) && !isShadowedCustomProvider) {
        return {
          success: false as const,
          error: {
            code: "built_in_provider" as const,
            message: `Provider ${provider} is built in and cannot be removed as custom.`,
          },
        };
      }

      if (!isShadowedCustomProvider) {
        const validation = validateCustomProviderId(provider);
        if (!validation.ok) {
          return {
            success: false as const,
            error: addErrorReason(
              { code: "invalid_provider_id" as const, message: "Invalid custom provider id." },
              validation.reason
            ),
          };
        }
      }

      if (!Object.hasOwn(providersConfig, provider)) {
        return {
          success: false as const,
          error: {
            code: "unknown_provider" as const,
            message: `Provider ${provider} does not exist.`,
          },
        };
      }

      if (!isCustomProviderConfig(providersConfig[provider])) {
        return {
          success: false as const,
          error: {
            code: "not_custom_provider" as const,
            message: `Provider ${provider} is not a custom provider.`,
          },
        };
      }

      // Re-validate and delete under the cross-process lock (see setConfigValue).
      // A lock/save failure folds into persistence_failed here — narrower than
      // the whole-pipeline fold because the repair step below owns a different
      // wire error code.
      const lockOutcome = yield* self
        .providersFileLockEffect((): CustomProviderMutationResult<void> | null => {
          const latestProvidersConfig = getProviderConfigRecord(
            self.providersConfigStore.loadProvidersConfig() ?? {}
          );
          if (!isCustomProviderConfig(latestProvidersConfig[provider])) {
            return {
              success: false,
              error: {
                code: "not_custom_provider",
                message: `Provider ${provider} is not a custom provider.`,
              },
            };
          }

          delete latestProvidersConfig[provider];
          self.providersConfigStore.saveProvidersConfig(latestProvidersConfig);
          return null;
        })
        .pipe(
          Effect.catchTag("ProviderPersistenceError", (error) =>
            Effect.succeed<CustomProviderMutationResult<void> | null>({
              success: false,
              error: addErrorReason(
                { code: "persistence_failed", message: `Failed to remove provider ${provider}.` },
                error.message
              ),
            })
          )
        );
      if (lockOutcome) {
        return lockOutcome;
      }

      const repairOutcome = yield* Effect.tryPromise({
        // async thunk: a synchronously throwing editConfig mock still lands in
        // the error channel, mirroring the old `await` + try/catch.
        try: async () =>
          self.config.editConfig((config) =>
            self.repairRemovedCustomProviderReferences(config, provider)
          ),
        catch: toPersistenceError,
      }).pipe(
        Effect.map((): CustomProviderMutationResult<void> | null => null),
        Effect.catchTag("ProviderPersistenceError", (error) =>
          Effect.sync((): CustomProviderMutationResult<void> | null => {
            // The provider is already deleted from providers.jsonc. Notify subscribers so they
            // re-sync even when durable model reference cleanup needs another attempt.
            self.notifyFromMutation();
            return {
              success: false,
              error: addErrorReason(
                {
                  code: "config_repair_failed",
                  message: `Provider ${provider} was removed, but saved model references could not be repaired.`,
                },
                error.message
              ),
            };
          })
        )
      );
      if (repairOutcome) {
        return repairOutcome;
      }

      self.notifyFromMutation();
      return { success: true as const, data: undefined };
    }).pipe(asAtomicMutation);
  }

  private repairRemovedCustomProviderReferences(
    config: ProjectsConfig,
    provider: string
  ): ProjectsConfig {
    // Removing a custom provider also clears durable model references so stale provider ids
    // do not become invalid app or workspace defaults on the next startup.
    if (modelStringStartsWithProvider(config.defaultModel, provider)) {
      delete config.defaultModel;
    }

    if (config.hiddenModels) {
      const hiddenModels = config.hiddenModels.filter(
        (modelString) => !modelStringStartsWithProvider(modelString, provider)
      );
      if (hiddenModels.length > 0) {
        config.hiddenModels = hiddenModels;
      } else {
        delete config.hiddenModels;
      }
    }

    if (config.routeOverrides) {
      const routeOverrides = Object.fromEntries(
        Object.entries(config.routeOverrides).filter(
          ([modelString, routeTarget]) =>
            !modelStringStartsWithProvider(modelString, provider) && routeTarget !== provider
        )
      );
      if (Object.keys(routeOverrides).length > 0) {
        config.routeOverrides = routeOverrides;
      } else {
        delete config.routeOverrides;
      }
    }

    if (config.agentAiDefaults) {
      for (const entry of Object.values(config.agentAiDefaults)) {
        if (modelStringStartsWithProvider(entry.modelString, provider)) {
          delete entry.modelString;
        }
        if (entry.subagent && modelStringStartsWithProvider(entry.subagent.modelString, provider)) {
          delete entry.subagent.modelString;
        }
      }
    }

    for (const projectConfig of config.projects.values()) {
      for (const workspace of projectConfig.workspaces) {
        if (
          workspace.aiSettings &&
          modelStringStartsWithProvider(workspace.aiSettings.model, provider)
        ) {
          workspace.aiSettings = {
            ...workspace.aiSettings,
            model: WORKSPACE_DEFAULTS.model,
          };
        }

        if (workspace.aiSettingsByAgent) {
          for (const [agentId, settings] of Object.entries(workspace.aiSettingsByAgent)) {
            if (modelStringStartsWithProvider(settings.model, provider)) {
              workspace.aiSettingsByAgent[agentId] = {
                ...settings,
                model: WORKSPACE_DEFAULTS.model,
              };
            }
          }
        }
      }
    }

    return config;
  }

  /**
   * Policy validation for a models edit. Returns a denial message or null.
   * MUST run inside the locked mutation, not merely before it: another
   * process can hold the cross-process providers lock for seconds, and
   * policy can refresh while the mutation waits — a check done before the
   * wait could persist models a newer policy denies (same pattern as the
   * Coder OAuth commit predicate).
   */
  private validateModelsEditPolicy(
    provider: string,
    normalizedModels: ProviderModelEntry[]
  ): string | null {
    if (!this.policyService?.isEnforced()) {
      return null;
    }

    if (!this.policyService.isProviderAllowed(provider)) {
      return `Provider ${provider} is not allowed by policy`;
    }

    const allowedModels =
      this.policyService.getEffectivePolicy()?.providerAccess?.find((p) => p.id === provider)
        ?.allowedModels ?? null;

    if (Array.isArray(allowedModels)) {
      const disallowed = normalizedModels
        .map((entry) => getProviderModelEntryId(entry))
        .filter((modelId) => !allowedModels.includes(modelId));
      if (disallowed.length > 0) {
        return `One or more models are not allowed by policy: ${disallowed.join(", ")}`;
      }
    }

    return null;
  }

  /**
   * Set custom models for a provider
   */
  public setModels(provider: string, models: ProviderModelEntry[]): Promise<Result<void, string>> {
    return Effect.runPromise(this.setModelsEffect(provider, models));
  }

  public setModelsEffect(
    provider: string,
    models: ProviderModelEntry[]
  ): Effect.Effect<Result<void, string>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const normalizedModels = yield* Effect.try({
        try: () => normalizeProviderModelEntries(models),
        catch: toPersistenceError,
      });

      // Read-modify-write under the cross-process lock (see setConfigValue).
      // The callback returns a policy denial to bail, or null once saved.
      const policyDenial = yield* self.providersFileLockEffect((): string | null => {
        const denial = self.validateModelsEditPolicy(provider, normalizedModels);
        if (denial != null) {
          return denial;
        }

        const providersConfig = self.providersConfigStore.loadProvidersConfig() ?? {};

        if (!providersConfig[provider]) {
          providersConfig[provider] = {};
        }

        if (provider === "coder") {
          self.applyCoderModelEdit(
            providersConfig.coder as Record<string, unknown>,
            normalizedModels
          );
        } else {
          providersConfig[provider].models = normalizedModels;
        }
        self.providersConfigStore.saveProvidersConfig(providersConfig);
        return null;
      });
      if (policyDenial != null) {
        return { success: false as const, error: policyDenial };
      }
      yield* self.notifyFromMutationEffect();

      return { success: true as const, data: undefined };
    }).pipe(
      Effect.catchTag("ProviderPersistenceError", (error) =>
        Effect.succeed<Result<void, string>>({
          success: false,
          error: `Failed to set models: ${error.message}`,
        })
      ),
      asAtomicMutation
    );
  }

  /**
   * Apply a Models-settings edit to the coder section. Coder needs more than
   * a plain overwrite because its persisted state is deliberately richer than
   * what the editor sees:
   *
   * - Policy-hidden entries are preserved: getConfig() exposes only the
   *   current policy's allowed subset, so the caller's list cannot contain
   *   entries the policy hides. Overwriting would carve those out of the
   *   policy-unfiltered persisted list until the next login even after the
   *   policy broadens (policy is applied at exposure/routing, not storage).
   * - Every deleted entry is recorded in `removedModels` so catalog
   *   refreshes and re-logins do not resurrect it. Tracking keys off the
   *   PRIOR persisted list, not just the current `discoveredModels`:
   *   provenance is lossy (a discovered model with a user-authored object
   *   override survives a catalog that temporarily omits its ID, but only
   *   `models` still knows it) — a deletion made in that state must still be
   *   excluded when a later catalog lists the ID again. The set is
   *   recomputed from the final list each edit, so re-adding a model clears
   *   its exclusion; prior exclusions survive edits made while the catalog
   *   is unknown (discoveredModels absent).
   *
   * Runs under the providers-file lock (called from setModels).
   */
  private applyCoderModelEdit(
    section: Record<string, unknown>,
    normalizedModels: ProviderModelEntry[]
  ): void {
    const allowedModels = this.policyService?.isEnforced()
      ? (this.policyService.getEffectivePolicy()?.providerAccess?.find((p) => p.id === "coder")
          ?.allowedModels ?? null)
      : null;

    const visibleIds = new Set(normalizedModels.map((entry) => getProviderModelEntryId(entry)));
    const hiddenPreserved = Array.isArray(allowedModels)
      ? normalizeProviderModelEntries(section.models).filter((entry) => {
          const id = getProviderModelEntryId(entry);
          return !allowedModels.includes(id) && !visibleIds.has(id);
        })
      : [];
    const finalModels = [...normalizedModels, ...hiddenPreserved];
    const finalIds = new Set(finalModels.map((entry) => getProviderModelEntryId(entry)));

    const discovered = Array.isArray(section.discoveredModels)
      ? section.discoveredModels.filter((id): id is string => typeof id === "string")
      : [];
    const priorRemoved = Array.isArray(section.removedModels)
      ? section.removedModels.filter((id): id is string => typeof id === "string")
      : [];
    const priorModelIds = normalizeProviderModelEntries(section.models).map((entry) =>
      getProviderModelEntryId(entry)
    );
    const removed = [...new Set([...priorRemoved, ...discovered, ...priorModelIds])].filter(
      (id) => !finalIds.has(id)
    );

    section.models = finalModels;
    if (removed.length > 0) {
      section.removedModels = removed;
    } else {
      delete section.removedModels;
    }
  }

  /**
   * After a credential change, sync gateway presence in routePriority.
   * Configured gateways auto-insert immediately before "direct" in routePriority,
   * preserving existing user-defined order.
   * Gateways that are explicitly disabled or fully deconfigured are removed;
   * configured-but-not-auto-eligible gateways keep any manual route.
   */
  private syncGatewayLifecycleEffect(
    provider: string
  ): Effect.Effect<void, ProviderPersistenceError> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      if (!(provider in PROVIDER_DEFINITIONS)) return;
      const providerName = provider as ProviderName;
      const def = PROVIDER_DEFINITIONS[providerName];
      if (def.kind !== "gateway") return;

      // Everything up to the branch decision is synchronous config/policy
      // reading; one Effect.try keeps a thrown read in the error channel
      // exactly like the old `await this.syncGatewayLifecycle(...)` inside
      // the callers' try/catch. It returns the main-config edit to apply,
      // or null when routePriority already matches.
      const edit = yield* Effect.try({
        try: (): ((c: ProjectsConfig) => ProjectsConfig) | null => {
          const providersConfig = self.providersConfigStore.loadProvidersConfig() ?? {};
          const rawProviderConfig = providersConfig[providerName] ?? {};
          // Coder credentials are issuer-bound and its deploymentUrl field stays
          // editable under an enforced forcedBaseUrl: lifecycle checks must resolve
          // against the forced URL (mirroring getConfig and routing), or editing
          // the unlocked field would evict coder from routePriority while Settings
          // and runtime model creation stay connected to the forced deployment.
          const forcedBaseUrl = self.policyService?.isEnforced()
            ? self.policyService.getForcedBaseUrl(providerName)
            : undefined;
          const providerConfig =
            providerName === "coder" && forcedBaseUrl !== undefined
              ? { ...rawProviderConfig, deploymentUrl: forcedBaseUrl }
              : rawProviderConfig;
          const isAutoRouteEligible = isProviderAutoRouteEligible(providerName, providerConfig);
          const config = self.config.loadConfigOrDefault();
          const priority = config.routePriority ?? ["direct"];

          if (isAutoRouteEligible && !priority.includes(providerName)) {
            // Insert before "direct" to stay reachable while preserving the
            // relative order of any user-configured routes already present.
            const directIndex = priority.indexOf("direct");
            const insertIndex = directIndex === -1 ? priority.length : directIndex;
            const nextPriority = [...priority];
            nextPriority.splice(insertIndex, 0, providerName);
            return (c) => ({
              ...c,
              routePriority: nextPriority,
              // Clear legacy disable — routePriority presence is now the authoritative
              // routing signal, so a stale muxGatewayEnabled: false must not veto it.
              ...(providerName === "mux-gateway" ? { muxGatewayEnabled: undefined } : {}),
            });
          } else if (!isAutoRouteEligible && priority.includes(providerName)) {
            // Only remove a gateway from routePriority when it is truly deconfigured
            // or explicitly disabled. Configured-but-not-auto-eligible providers
            // (e.g., Bedrock with IAM role auth that has no observable credentials)
            // should keep any manually added route.
            const credentials = resolveProviderCredentials(providerName, providerConfig);
            const shouldRemove =
              !credentials.isConfigured || isProviderDisabledInConfig(providerConfig);
            if (shouldRemove) {
              return (c) => ({
                ...c,
                routePriority: priority.filter((p) => p !== providerName),
              });
            }
          }
          return null;
        },
        catch: toPersistenceError,
      });

      if (edit !== null) {
        yield* Effect.tryPromise({
          try: async () => self.config.editConfig(edit),
          catch: toPersistenceError,
        });
      }
    });
  }

  /**
   * Policy validation for a provider key-path edit. Returns a denial message
   * or null. MUST run inside the locked mutation for the same reason as
   * validateModelsEditPolicy.
   */
  private validateProviderEditPolicy(provider: string, keyPath: string[]): string | null {
    if (!this.policyService?.isEnforced()) {
      return null;
    }

    if (!this.policyService.isProviderAllowed(provider)) {
      return `Provider ${provider} is not allowed by policy`;
    }

    const forcedBaseUrl = this.policyService.getForcedBaseUrl(provider);
    const isBaseUrlEdit =
      keyPath.length === 1 && (keyPath[0] === "baseUrl" || keyPath[0] === "baseURL");
    if (isBaseUrlEdit && forcedBaseUrl) {
      return `Provider ${provider} base URL is locked by policy`;
    }

    return null;
  }

  /**
   * Set provider config values that aren't representable as strings.
   *
   * Intended for persisted auth blobs (e.g. Codex OAuth tokens) that should never
   * cross the frontend boundary.
   */
  public setConfigValue(
    provider: string,
    keyPath: string[],
    value: unknown
  ): Promise<Result<void, string>> {
    return Effect.runPromise(this.setConfigValueEffect(provider, keyPath, value));
  }

  private setConfigValueEffect(
    provider: string,
    keyPath: string[],
    value: unknown
  ): Effect.Effect<Result<void, string>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const deniedSegment = keyPath.find((segment) => DENIED_KEY_PATH_SEGMENTS.has(segment));
      if (deniedSegment) {
        // Match the agentic config mutation path so legacy ORPC callers cannot write into prototypes.
        return { success: false as const, error: `Denied key path segment: "${deniedSegment}"` };
      }

      // Read-modify-write under the cross-process lock: every providers.jsonc
      // writer must cooperate or a whole-file save from one process could
      // resurrect credentials another process just rotated/cleared.
      // The callback returns a policy denial to bail, or null once saved.
      const policyDenial = yield* self.providersFileLockEffect((): string | null => {
        const denial = self.validateProviderEditPolicy(provider, keyPath);
        if (denial != null) {
          return denial;
        }

        const providersConfig = self.providersConfigStore.loadProvidersConfig() ?? {};

        // Ensure provider exists
        if (!providersConfig[provider]) {
          providersConfig[provider] = {};
        }

        // Set nested property value
        let current = providersConfig[provider] as Record<string, unknown>;
        for (let i = 0; i < keyPath.length - 1; i++) {
          const key = keyPath[i];
          if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
            current[key] = {};
          }
          current = current[key] as Record<string, unknown>;
        }

        if (keyPath.length > 0) {
          const lastKey = keyPath[keyPath.length - 1];
          const isProviderEnabledToggle = keyPath.length === 1 && lastKey === "enabled";

          if (isProviderEnabledToggle) {
            // Persist only `enabled: false` and delete on enable so providers.jsonc stays minimal.
            if (value === false || value === "false") {
              current[lastKey] = false;
            } else {
              delete current[lastKey];
            }
          } else if (value === undefined) {
            delete current[lastKey];
          } else {
            current[lastKey] = value;
          }
        }

        // Save updated config
        self.providersConfigStore.saveProvidersConfig(providersConfig);
        return null;
      });
      if (policyDenial != null) {
        return { success: false as const, error: policyDenial };
      }
      yield* self.notifyFromMutationEffect();
      yield* self.syncGatewayLifecycleEffect(provider);

      return { success: true as const, data: undefined };
    }).pipe(
      Effect.catchTag("ProviderPersistenceError", (error) =>
        Effect.succeed<Result<void, string>>({
          success: false,
          error: `Failed to set provider config: ${error.message}`,
        })
      ),
      asAtomicMutation
    );
  }

  /**
   * Conditionally update a provider config value: `update` receives the
   * current value at `keyPath` and returns `{ value }` to write or null to
   * skip. The read, the predicate, and the file write run while holding the
   * cross-process providers.jsonc lock (see Config.withProvidersFileLock), so
   * neither another in-process caller nor another mux process going through
   * this method can interleave between compare and write. This is the
   * compare-and-set used for credential writes that race concurrent
   * logins/refreshes (e.g. Coder OAuth token rotation across the desktop app
   * and `mux run`/`mux workflow`).
   *
   * Unlike setConfigValue, this path skips policy gating: it is an internal
   * credential-management primitive (clearing dead tokens, persisting
   * rotations), not a user-driven config edit.
   */
  public updateConfigValue(
    provider: string,
    keyPath: string[],
    update: (current: unknown) => { value: unknown } | null
  ): Promise<Result<{ applied: boolean }, string>> {
    return Effect.runPromise(this.updateConfigValueEffect(provider, keyPath, update));
  }

  private updateConfigValueEffect(
    provider: string,
    keyPath: string[],
    update: (current: unknown) => { value: unknown } | null
  ): Effect.Effect<Result<{ applied: boolean }, string>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const deniedSegment = keyPath.find((segment) => DENIED_KEY_PATH_SEGMENTS.has(segment));
      if (deniedSegment) {
        return { success: false as const, error: `Denied key path segment: "${deniedSegment}"` };
      }
      if (keyPath.length === 0) {
        return {
          success: false as const,
          error: "updateConfigValue requires a non-empty key path",
        };
      }

      const applied = yield* self.providersFileLockEffect(() => {
        // Load, decide, and write under the lock — no awaits in between, so
        // the predicate result cannot be invalidated by any cooperating writer.
        const providersConfig = self.providersConfigStore.loadProvidersConfig() ?? {};
        let current: unknown = providersConfig[provider];
        for (const key of keyPath) {
          current =
            current !== null && typeof current === "object"
              ? (current as Record<string, unknown>)[key]
              : undefined;
        }

        const decision = update(current);
        if (!decision) {
          return false;
        }

        if (!providersConfig[provider]) {
          providersConfig[provider] = {};
        }
        let target = providersConfig[provider] as Record<string, unknown>;
        for (let i = 0; i < keyPath.length - 1; i++) {
          const key = keyPath[i];
          if (!(key in target) || typeof target[key] !== "object" || target[key] === null) {
            target[key] = {};
          }
          target = target[key] as Record<string, unknown>;
        }
        const lastKey = keyPath[keyPath.length - 1];
        if (decision.value === undefined) {
          delete target[lastKey];
        } else {
          target[lastKey] = decision.value;
        }

        self.providersConfigStore.saveProvidersConfig(providersConfig);
        return true;
      });

      yield* self.afterAppliedMutationEffect(provider, applied);
      return { success: true as const, data: { applied } };
    }).pipe(
      Effect.catchTag("ProviderPersistenceError", (error) =>
        Effect.succeed<Result<{ applied: boolean }, string>>({
          success: false,
          error: `Failed to update provider config: ${error.message}`,
        })
      ),
      asAtomicMutation
    );
  }

  /**
   * Post-write side effects for the internal mutation primitives
   * (updateConfigValue / updateProviderSection). Best-effort by design: the
   * mutation has already landed on disk, so a failure syncing routePriority
   * in the MAIN config (or notifying listeners) must not convert a persisted
   * write into a reported failure — Coder's login commit revokes tokens for
   * any non-success result, which would strand a credential that IS stored
   * (and reported as connected) in a revoked state.
   */
  private afterAppliedMutationEffect(provider: string, applied: boolean): Effect.Effect<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      if (!applied) {
        return;
      }
      yield* self.notifyFromMutationEffect();
      yield* self.syncGatewayLifecycleEffect(provider);
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          log.error(`Post-write route sync failed for provider ${provider}:`, error);
        })
      )
    );
  }

  /**
   * Section-level sibling of updateConfigValue: the predicate receives the
   * whole provider config section and returns a replacement section (or null
   * to skip), all under the cross-process providers.jsonc lock. This lets
   * callers make MULTIPLE fields change atomically with one credential check —
   * e.g. Coder OAuth commits a discovered model catalog only while the login
   * that fetched it is still the stored credential, and disconnect clears
   * tokens + models in one write.
   *
   * Internal credential-management primitive: skips policy gating like
   * updateConfigValue.
   */
  public updateProviderSection(
    provider: string,
    update: (
      section: Record<string, unknown> | undefined
    ) => { value: Record<string, unknown> } | null
  ): Promise<Result<{ applied: boolean }, string>> {
    return Effect.runPromise(this.updateProviderSectionEffect(provider, update));
  }

  private updateProviderSectionEffect(
    provider: string,
    update: (
      section: Record<string, unknown> | undefined
    ) => { value: Record<string, unknown> } | null
  ): Effect.Effect<Result<{ applied: boolean }, string>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const applied = yield* self.providersFileLockEffect(() => {
        const providersConfig = self.providersConfigStore.loadProvidersConfig() ?? {};
        const section = providersConfig[provider] as Record<string, unknown> | undefined;

        const decision = update(section);
        if (!decision) {
          return false;
        }

        const deniedKey = Object.keys(decision.value).find((key) =>
          DENIED_KEY_PATH_SEGMENTS.has(key)
        );
        if (deniedKey) {
          throw new Error(`Denied key path segment: "${deniedKey}"`);
        }

        providersConfig[provider] = decision.value as BaseProviderConfig;
        self.providersConfigStore.saveProvidersConfig(providersConfig);
        return true;
      });

      // Best-effort: a landed write must not be reported as failed (see
      // afterAppliedMutationEffect).
      yield* self.afterAppliedMutationEffect(provider, applied);
      return { success: true as const, data: { applied } };
    }).pipe(
      Effect.catchTag("ProviderPersistenceError", (error) =>
        Effect.succeed<Result<{ applied: boolean }, string>>({
          success: false,
          error: `Failed to update provider config: ${error.message}`,
        })
      ),
      asAtomicMutation
    );
  }

  public setConfig(
    provider: string,
    keyPath: string[],
    value: string | boolean
  ): Promise<Result<void, string>> {
    return Effect.runPromise(this.setConfigEffect(provider, keyPath, value));
  }

  public setConfigEffect(
    provider: string,
    keyPath: string[],
    value: string | boolean
  ): Effect.Effect<Result<void, string>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const deniedSegment = keyPath.find((segment) => DENIED_KEY_PATH_SEGMENTS.has(segment));
      if (deniedSegment) {
        // Match the agentic config mutation path so legacy ORPC callers cannot write into prototypes.
        return { success: false as const, error: `Denied key path segment: "${deniedSegment}"` };
      }

      const isProviderTypeEdit = keyPath.length === 1 && keyPath[0] === "providerType";
      if (isProviderTypeEdit && !isCustomProviderType(value)) {
        return { success: false as const, error: `Invalid custom provider type: ${String(value)}` };
      }

      // Value-only guard shared by every provider: no SDK adapter survives a
      // query/fragment in its base URL (endpoint paths are raw-appended).
      // Empty string falls through: it clears the key.
      const isBaseUrlEdit =
        keyPath.length === 1 && (keyPath[0] === "baseUrl" || keyPath[0] === "baseURL");
      if (isBaseUrlEdit && typeof value === "string" && value !== "") {
        const queryFragmentError = baseUrlQueryFragmentError(value);
        if (queryFragmentError != null) {
          return { success: false as const, error: queryFragmentError };
        }
      }

      // Read-modify-write under the cross-process lock (see setConfigValue).
      // The callback returns a policy denial to bail, or null once saved.
      const policyDenial = yield* self.providersFileLockEffect((): string | null => {
        const denial = self.validateProviderEditPolicy(provider, keyPath);
        if (denial != null) {
          return denial;
        }

        const providersConfig = self.providersConfigStore.loadProvidersConfig() ?? {};

        // The add-time id collision rule applies only when this write would
        // CONVERT a non-custom entry into a custom provider. An entry that is
        // already custom stays editable even when its id shadows a built-in
        // (upgraded installs deliberately preserve such entries). Checked
        // against the config read INSIDE the lock: a pre-lock read could race
        // another process removing the entry and recreate it as custom.
        if (isProviderTypeEdit && !isCustomProviderConfig(providersConfig[provider])) {
          if (providersConfig[provider] == null) {
            // A providerType write must never CREATE an entry: a queued or
            // late UI edit racing a removal would otherwise resurrect the
            // provider as an unconfigured skeleton. Creation goes through
            // addCustomProvider.
            return `Provider ${provider} does not exist.`;
          }
          const validation = validateCustomProviderId(provider);
          if (!validation.ok) {
            return `Invalid custom provider id for ${String(value)}: ${validation.reason}`;
          }
        }

        // Track if this is first time setting couponCode for mux-gateway
        const isFirstMuxGatewayCoupon =
          provider === "mux-gateway" &&
          keyPath.length === 1 &&
          keyPath[0] === "couponCode" &&
          value !== "" &&
          !providersConfig[provider]?.couponCode;

        // Ensure provider exists
        if (!providersConfig[provider]) {
          providersConfig[provider] = {};
        }

        // Set nested property value
        let current = providersConfig[provider] as Record<string, unknown>;
        for (let i = 0; i < keyPath.length - 1; i++) {
          const key = keyPath[i];
          if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
            current[key] = {};
          }
          current = current[key] as Record<string, unknown>;
        }

        if (keyPath.length > 0) {
          const lastKey = keyPath[keyPath.length - 1];
          const isProviderEnabledToggle = keyPath.length === 1 && lastKey === "enabled";
          const isCanonicalBaseUrlEdit = keyPath.length === 1 && lastKey === "baseUrl";
          if (isCanonicalBaseUrlEdit) {
            // The UI writes `baseUrl`. Remove the SDK-style alias so old `baseURL`
            // values cannot keep shadowing user edits or clears after save.
            delete current.baseURL;
          }

          if (isProviderEnabledToggle) {
            // Persist only `enabled: false` and delete on enable so providers.jsonc stays minimal.
            if (value === false || value === "false") {
              current[lastKey] = false;
            } else {
              delete current[lastKey];
            }
          } else if (value === "") {
            // Delete key if value is empty string (used for clearing API keys).
            delete current[lastKey];
          } else {
            current[lastKey] = value;
          }
        }

        // Add default models when setting up mux-gateway for the first time
        if (isFirstMuxGatewayCoupon) {
          const providerConfig = providersConfig[provider] as Record<string, unknown>;
          const existingModels = normalizeProviderModelEntries(providerConfig.models);
          if (existingModels.length === 0) {
            providerConfig.models = [
              "anthropic/claude-sonnet-5",
              "anthropic/claude-opus-5",
              "openai/gpt-5.5",
            ];
          }
        }

        // Save updated config
        self.providersConfigStore.saveProvidersConfig(providersConfig);
        return null;
      });
      if (policyDenial != null) {
        return { success: false as const, error: policyDenial };
      }
      yield* self.notifyFromMutationEffect();
      yield* self.syncGatewayLifecycleEffect(provider);

      return { success: true as const, data: undefined };
    }).pipe(
      Effect.catchTag("ProviderPersistenceError", (error) =>
        Effect.succeed<Result<void, string>>({
          success: false,
          error: `Failed to set provider config: ${error.message}`,
        })
      ),
      asAtomicMutation
    );
  }

  updateRoutePreferences(
    input: Omit<Parameters<Config["updateRoutePreferences"]>[0], "validateRouteOverrides">
  ): Promise<void> {
    return this.config.updateRoutePreferences({
      ...input,
      validateRouteOverrides: (overrides) => this.validateRouteOverrides(overrides),
    });
  }

  public validateRouteOverrides(routeOverrides: Record<string, string>): Result<void, string> {
    const providersConfig = this.providersConfigStore.loadProvidersConfig() ?? {};
    for (const routeTarget of Object.values(routeOverrides)) {
      const targetConfig = providersConfig[routeTarget];
      if (isCustomProviderConfig(targetConfig)) {
        return {
          success: false,
          error: `Custom providers are direct-only and cannot be the target of a routeOverride: ${routeTarget}.`,
        };
      }
    }

    return { success: true, data: undefined };
  }
}
