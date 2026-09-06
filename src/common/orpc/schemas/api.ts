import { eventIterator } from "@orpc/server";
import { UIModeSchema } from "../../types/mode";
import { z } from "zod";
import { CODER_ARCHIVE_BEHAVIORS } from "@/common/config/coderArchiveBehavior";
import { WORKTREE_ARCHIVE_BEHAVIORS } from "@/common/config/worktreeArchiveBehavior";
import { HEARTBEAT_MAX_INTERVAL_MS, HEARTBEAT_MIN_INTERVAL_MS } from "@/constants/heartbeat";
import { DEFAULT_GOAL_DEFAULTS } from "@/constants/goals";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import {
  MAX_STAGED_ATTACHMENT_BASE64_CHARS,
  MAX_STAGED_ATTACHMENT_SIZE_BYTES,
} from "@/common/constants/stagedAttachments";
import { CUSTOM_PROVIDER_TYPES } from "@/common/utils/providers/customProviders";
import { ChatStatsSchema, SessionUsageFileSchema } from "./chatStats";
import { AdditionalSystemContextSchema, WorkspaceInstructionsSchema } from "./instructions";
import {
  NameGenerationErrorSchema,
  ProjectRemoveErrorSchema,
  SendMessageErrorSchema,
} from "./errors";
import { BranchListResultSchema, FilePartSchema, MuxMessageSchema } from "./message";
import {
  GoalClearInputSchema,
  GoalBoardAddUpcomingInputSchema,
  GoalBoardArchiveInputSchema,
  GoalBoardGetInputSchema,
  GoalBoardPromoteInputSchema,
  GoalBoardReorderInputSchema,
  GoalBoardReviveInputSchema,
  GoalBoardUpdateUpcomingInputSchema,
  GoalBoardSnapshotSchema,
  GoalGetInputSchema,
  GoalRecordV1Schema,
  GoalSetErrorSchema,
  GoalSetInputSchema,
} from "./goal";
import { ProjectConfigSchema } from "./project";
import { ProjectWorkspaceCountsSchema } from "@/common/utils/projectRemoval";
import {
  MemoryChangeEventSchema,
  MemoryConsolidationRecordSchema,
  MemoryConsolidationStatusSchema,
  MemoryFileInfoSchema,
  MemorySaveErrorSchema,
} from "./memory";
import { ResultSchema } from "./result";
import { SshPromptEventSchema, SshPromptResponseInputSchema } from "./ssh";
import {
  RuntimeConfigSchema,
  RuntimeAvailabilitySchema,
  RuntimeEnablementIdSchema,
} from "./runtime";
import { SecretSchema } from "./secrets";
import {
  CompletedMessagePartSchema,
  ExperimentsSchema,
  HeartbeatEventSchema,
  OnChatModeSchema,
  SendMessageOptionsSchema,
  StreamEndEventSchema,
  ToolPolicySchema,
  UpdateStatusSchema,
  WorkspaceChatMessageSchema,
} from "./stream";
import {
  TimelineListInputSchema,
  TimelinePageSchema,
  TimelinePreviewInputSchema,
  TimelinePreviewSchema,
  TimelineSubscriptionEventSchema,
} from "./timeline";
import { LayoutPresetsConfigSchema } from "./uiLayouts";
import {
  TerminalCreateParamsSchema,
  TerminalResizeParamsSchema,
  TerminalSessionSchema,
} from "./terminal";
import { BashToolResultSchema, FileTreeNodeSchema } from "./tools";
import { WorkspaceStatsSnapshotSchema } from "./workspaceStats";
import {
  FrontendWorkspaceMetadataSchema,
  GitStatusSchema,
  ProjectRefSchema,
  WorkspaceActivitySnapshotSchema,
  WorkspaceGoalDefaultsOverrideSchema,
  WorkspaceHeartbeatSettingsSchema,
} from "./workspace";
import { WorkspaceAISettingsSchema } from "./workspaceAiSettings";
import {
  AgentSkillDescriptorSchema,
  AgentSkillIssueSchema,
  AgentSkillPackageSchema,
  SkillNameSchema,
} from "./agentSkill";
import {
  AvailableWorkflowSchema,
  WorkflowRunIdSchema,
  WorkflowRunRecordSchema,
  WorkflowRunStatusSchema,
  WorkflowRunStreamEventSchema,
} from "./workflow";
import {
  AgentDefinitionDescriptorSchema,
  AgentDefinitionPackageSchema,
  AgentIdSchema,
} from "./agentDefinition";
import { PluginSlashCommandDescriptorSchema, WorkspaceCompositionSchema } from "./agentPlugins";
import {
  MCPAddGlobalParamsSchema,
  MCPAddParamsSchema,
  MCPListParamsSchema,
  MCPPromptDescriptorSchema,
  MCPRemoveGlobalParamsSchema,
  MCPRemoveParamsSchema,
  MCPServerMapSchema,
  MCPSetEnabledGlobalParamsSchema,
  MCPSetEnabledParamsSchema,
  MCPSetToolAllowlistGlobalParamsSchema,
  MCPSetToolAllowlistParamsSchema,
  MCPTestGlobalParamsSchema,
  MCPTestParamsSchema,
  MCPTestResultSchema,
  WorkspaceMCPOverridesSchema,
} from "./mcp";
import {
  AgentPluginGitSourceSchema,
  AgentPluginInstallEntrySchema,
  AgentPluginInstallPreviewSchema,
  AgentPluginListItemSchema,
  AgentPluginUpdateCheckSchema,
} from "./agentPlugins";
import { PolicyGetResponseSchema } from "./policy";
import {
  AgentAiDefaultsSchema,
  ModelFallbacksSchema,
  UpdateChannelSchema,
} from "../../config/schemas/appConfigOnDisk";
import {
  CacheTtlSchema,
  CodexOauthDefaultAuthSchema,
  FastModePreviousServiceTierSchema,
  ServiceTierSchema,
} from "../../config/schemas/providersConfig";
import { ProviderModelEntrySchema } from "../../config/schemas/providerModelEntry";
import { UserPreferencesSchema } from "../../config/schemas/userPreferences";
import { TaskSettingsSchema } from "../../config/schemas/taskSettings";
import { OpenAIReasoningModeSchema, ThinkingLevelSchema } from "../../types/thinking";

// Experiments
export const experiments = {
  getOverrides: {
    input: z.void(),
    output: z.partialRecord(z.enum(EXPERIMENT_IDS), z.boolean()),
  },
  setOverride: {
    input: z.object({
      experimentId: z.enum(EXPERIMENT_IDS),
      enabled: z.boolean().nullish(),
    }),
    output: z.void(),
  },
};
// Re-export telemetry schemas
export { telemetry } from "./telemetry";

// Re-export analytics schemas
export { analytics } from "./analytics";
export { ProviderModelEntrySchema } from "../../config/schemas/providerModelEntry";

// --- API Router Schemas ---

const BackgroundProcessStatusSchema = z.enum(["running", "exited", "killed", "failed"]);

export const ProjectGitStatusResultSchema = z.object({
  projectPath: z.string(),
  projectName: z.string(),
  gitStatus: GitStatusSchema.nullish(),
  error: z.string().nullish(),
});

export type ProjectGitStatusResult = z.infer<typeof ProjectGitStatusResultSchema>;

export const BackgroundProcessMonitorInfoSchema = z.object({
  filter: z.string(),
  filter_exclude: z.boolean(),
  cooldown_ms: z.number(),
  max_events: z.number().optional(),
  totalMatches: z.number(),
  droppedLines: z.number(),
  lastLines: z.array(z.string()),
  stopped: z.boolean(),
  /**
   * Set when a monitor wake is durably queued but its synthetic wake turn has not been
   * delivered yet. Without this, a one-shot watcher that matched and exited looks like a
   * lost wake in the UI (nothing running, no visible pending delivery). Carries the wake
   * kind so the UI does not claim a "match" for monitor-lost restart notices.
   */
  // "settled": the wake reports only process settlement (a monitored process that
  // exited without ever matching, or an earlier run's preserved settlement) — never
  // labeled as a match the filter did not produce.
  pendingWakeKind: z.enum(["match", "monitor-lost", "settled"]).optional(),
});

// Background process info (for UI display)
export const BackgroundProcessInfoSchema = z.object({
  id: z.string(),
  pid: z.number(),
  script: z.string(),
  displayName: z.string().optional(),
  /**
   * True for rows synthesized from a durable pending wake with no manager entry behind
   * them (e.g. after an app restart). Such rows have no queryable output or live process.
   * Deliberately not inferred from pid: migrated manager-backed processes also use pid 0.
   */
  synthesized: z.boolean().optional(),
  startTime: z.number(),
  status: BackgroundProcessStatusSchema,
  monitor: BackgroundProcessMonitorInfoSchema.optional(),
  exitCode: z.number().optional(),
});

export type BackgroundProcessInfo = z.infer<typeof BackgroundProcessInfoSchema>;

// Tokenizer
export const tokenizer = {
  countTokens: {
    input: z.object({ model: z.string(), text: z.string() }),
    output: z.number(),
  },
  countTokensBatch: {
    input: z.object({ model: z.string(), texts: z.array(z.string()) }),
    output: z.array(z.number()),
  },
  calculateStats: {
    input: z.object({
      workspaceId: z.string(),
      messages: z.array(MuxMessageSchema),
      model: z.string(),
    }),
    output: ChatStatsSchema,
  },
};

// Providers
export const AWSCredentialStatusSchema = z.object({
  region: z.string().optional(),
  /** Optional AWS shared config profile name (equivalent to AWS_PROFILE). */
  profile: z.string().optional(),
  bearerTokenSet: z.boolean(),
  accessKeyIdSet: z.boolean(),
  secretAccessKeySet: z.boolean(),
});

export const ProviderConfigInfoSchema = z.object({
  apiKeySet: z.boolean(),
  /** Whether this provider is enabled for model requests */
  isEnabled: z.boolean().default(true),
  /** Whether this provider is configured and ready to use */
  isConfigured: z.boolean(),
  apiKeyFile: z.string().optional(),
  /** Where the API key was actually resolved from (config, file, env, or keyless) */
  apiKeySource: z.enum(["config", "file", "env", "keyless"]).optional(),
  baseUrl: z.string().optional(),
  /** Where the active base URL was resolved from (config or env) */
  baseUrlSource: z.enum(["config", "env"]).nullish(),
  /** Active base URL for display only. Env values must not be persisted from this field. */
  baseUrlResolved: z.string().nullish(),
  providerType: z.enum(CUSTOM_PROVIDER_TYPES).optional(),
  displayName: z.string().optional(),
  isCustom: z.boolean().optional(),
  models: z.array(ProviderModelEntrySchema).optional(),
  /** Provider processing tier (OpenAI supports all values; xAI supports default/priority). */
  serviceTier: ServiceTierSchema.optional(),
  fastModePreviousServiceTier: FastModePreviousServiceTierSchema.optional(),
  wireFormat: z.enum(["responses", "chatCompletions"]).optional(),
  /** OpenAI/xAI Responses storage. Set false for ZDR orgs. */
  store: z.boolean().optional(),
  webSocketTransportEnabled: z.boolean().optional(),
  /** Anthropic-specific fields */
  cacheTtl: CacheTtlSchema.optional(),
  disableBetaFeatures: z.boolean().optional(),
  /** OpenAI-only: whether Codex OAuth tokens are present in providers.jsonc */
  codexOauthSet: z.boolean().optional(),
  /**
   * OpenAI-only: default auth precedence to use for Codex-OAuth-allowed models when BOTH
   * ChatGPT OAuth and an OpenAI API key are configured.
   */
  codexOauthDefaultAuth: CodexOauthDefaultAuthSchema.optional(),
  /** AWS-specific fields (only present for bedrock provider) */
  aws: AWSCredentialStatusSchema.optional(),
  /** Xum Gateway-specific fields */
  couponCodeSet: z.boolean().optional(),
  /** Xum Gateway-specific: which models are enabled for gateway routing */
  gatewayModels: z.array(z.string()).optional(),
  /** Coder-only: deployment access URL (e.g. https://coder.example.com) */
  deploymentUrl: z.string().optional(),
  /** Coder-only: whether Coder OAuth tokens are present in providers.jsonc */
  coderOauthSet: z.boolean().optional(),
  // A Coder OAuth blob exists in providers.jsonc, whether or not it matches
  // the configured deployment URL (coderOauthSet). Gates Disconnect: the
  // stored credential stays revocable after the URL is edited or cleared.
  coderOauthCredentialStored: z.boolean().optional(),
  /**
   * Coder-only: AI Gateway provider instance metadata ({name, type}) —
   * discovered from the deployment and user-declared respectively. Option
   * and header builders need these to derive the wire protocol for
   * gateway-scoped coder:<name>/<model> strings.
   */
  discoveredProviders: z.array(z.object({ name: z.string(), type: z.string() })).optional(),
  additionalProviders: z.array(z.object({ name: z.string(), type: z.string() })).optional(),
  /**
   * Coder-only: model IDs discovered from the deployment's AI Bridge
   * catalogs. Authoritative for gateway routing when present; `models` is the
   * user-visible union of these and manually added entries.
   */
  discoveredModels: z.array(z.string()).optional(),
  /**
   * Coder-only: model IDs the user explicitly removed. Excluded from
   * accessibility even while the discovered catalog is unknown, so the
   * frontend mirrors the backend's routing decisions (see
   * gatewayModelCatalog.ts).
   */
  removedModels: z.array(z.string()).optional(),
});

export const ProvidersConfigMapSchema = z.record(z.string(), ProviderConfigInfoSchema);

export const CustomProviderMutationErrorSchema = z.discriminatedUnion("code", [
  z.object({
    code: z.literal("invalid_provider_id"),
    message: z.string(),
    reason: z.string().optional(),
  }),
  z.object({
    code: z.literal("built_in_provider"),
    message: z.string(),
    reason: z.string().optional(),
  }),
  z.object({
    code: z.literal("duplicate_provider"),
    message: z.string(),
    reason: z.string().optional(),
  }),
  z.object({
    code: z.literal("invalid_base_url"),
    message: z.string(),
    reason: z.string().optional(),
  }),
  z.object({
    code: z.literal("unknown_provider"),
    message: z.string(),
    reason: z.string().optional(),
  }),
  z.object({
    code: z.literal("not_custom_provider"),
    message: z.string(),
    reason: z.string().optional(),
  }),
  z.object({
    code: z.literal("policy_denied"),
    message: z.string(),
    reason: z.string().optional(),
  }),
  z.object({
    code: z.literal("config_repair_failed"),
    message: z.string(),
    reason: z.string().optional(),
  }),
  z.object({
    code: z.literal("persistence_failed"),
    message: z.string(),
    reason: z.string().optional(),
  }),
]);

export const providers = {
  addCustomProvider: {
    input: z.object({
      provider: z.string(),
      providerType: z.enum(CUSTOM_PROVIDER_TYPES).optional(),
      displayName: z.string().optional(),
      baseUrl: z.string(),
      apiKey: z.string().optional(),
      apiKeyFile: z.string().optional(),
      models: z.array(ProviderModelEntrySchema).optional(),
    }),
    output: ResultSchema(ProviderConfigInfoSchema, CustomProviderMutationErrorSchema),
  },
  removeCustomProvider: {
    input: z.object({
      provider: z.string(),
    }),
    output: ResultSchema(z.void(), CustomProviderMutationErrorSchema),
  },
  setProviderConfig: {
    input: z.object({
      provider: z.string(),
      keyPath: z
        .array(z.string())
        .refine(
          (path) =>
            !path.some((segment) => ["__proto__", "prototype", "constructor"].includes(segment)),
          { message: "keyPath contains a denied segment" }
        ),
      value: z.union([z.string(), z.boolean()]),
    }),
    output: ResultSchema(z.void(), z.string()),
  },
  getConfig: {
    input: z.void(),
    output: ProvidersConfigMapSchema,
  },
  setModels: {
    input: z.object({
      provider: z.string(),
      models: z.array(ProviderModelEntrySchema),
    }),
    output: ResultSchema(z.void(), z.string()),
  },
  list: {
    input: z.void(),
    output: z.array(z.string()),
  },
  // Subscription: emits when provider config changes (API keys, models, etc.)
  onConfigChanged: {
    input: z.void(),
    output: eventIterator(z.void()),
  },
};

// Policy (admin-enforced config)
export const policy = {
  get: {
    input: z.void(),
    output: PolicyGetResponseSchema,
  },
  // Subscription: emits when the effective policy changes (file refresh)
  onChanged: {
    input: z.void(),
    output: eventIterator(z.void()),
  },
  // Force a refresh of the effective policy (re-reads MUX_POLICY_FILE or Governor policy)
  refreshNow: {
    input: z.void(),
    output: ResultSchema(PolicyGetResponseSchema, z.string()),
  },
};

// Xum Gateway OAuth (desktop login flow)
export const muxGatewayOauth = {
  startDesktopFlow: {
    input: z.void(),
    output: ResultSchema(
      z.object({
        flowId: z.string(),
        authorizeUrl: z.string(),
        redirectUri: z.string(),
      }),
      z.string()
    ),
  },
  waitForDesktopFlow: {
    input: z
      .object({
        flowId: z.string(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict(),
    output: ResultSchema(z.void(), z.string()),
  },
  cancelDesktopFlow: {
    input: z.object({ flowId: z.string() }).strict(),
    output: z.void(),
  },
};

// GitHub Copilot OAuth (Device Code Flow)
export const copilotOauth = {
  startDeviceFlow: {
    input: z.void(),
    output: ResultSchema(
      z.object({
        flowId: z.string(),
        verificationUri: z.string(),
        userCode: z.string(),
      }),
      z.string()
    ),
  },
  waitForDeviceFlow: {
    input: z
      .object({
        flowId: z.string(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict(),
    output: ResultSchema(z.void(), z.string()),
  },
  cancelDeviceFlow: {
    input: z.object({ flowId: z.string() }).strict(),
    output: z.void(),
  },
};

// Xum Governor OAuth (enrollment for enterprise policy service)
export const muxGovernorOauth = {
  startDesktopFlow: {
    input: z.object({ governorOrigin: z.string() }).strict(),
    output: ResultSchema(
      z.object({
        flowId: z.string(),
        authorizeUrl: z.string(),
        redirectUri: z.string(),
      }),
      z.string()
    ),
  },
  waitForDesktopFlow: {
    input: z
      .object({
        flowId: z.string(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict(),
    output: ResultSchema(z.void(), z.string()),
  },
  cancelDesktopFlow: {
    input: z.object({ flowId: z.string() }).strict(),
    output: z.void(),
  },
};

// Codex OAuth (ChatGPT subscription auth)
export const codexOauth = {
  startDesktopFlow: {
    input: z.void(),
    output: ResultSchema(z.object({ flowId: z.string(), authorizeUrl: z.string() }), z.string()),
  },
  waitForDesktopFlow: {
    input: z
      .object({
        flowId: z.string(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict(),
    output: ResultSchema(z.void(), z.string()),
  },
  cancelDesktopFlow: {
    input: z.object({ flowId: z.string() }).strict(),
    output: z.void(),
  },
  startDeviceFlow: {
    input: z.void(),
    output: ResultSchema(
      z.object({
        flowId: z.string(),
        userCode: z.string(),
        verifyUrl: z.string(),
        intervalSeconds: z.number().int().positive(),
      }),
      z.string()
    ),
  },
  waitForDeviceFlow: {
    input: z
      .object({
        flowId: z.string(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict(),
    output: ResultSchema(z.void(), z.string()),
  },
  cancelDeviceFlow: {
    input: z.object({ flowId: z.string() }).strict(),
    output: z.void(),
  },
  disconnect: {
    input: z.void(),
    output: ResultSchema(z.void(), z.string()),
  },
};

// Coder OAuth ("Login with Coder" against a user-supplied deployment)
export const coderOauth = {
  startDesktopFlow: {
    // flowId is caller-generated so Cancel can reference the attempt while
    // startDesktopFlow is still in flight (probes/client registration); the
    // backend generates one when omitted.
    input: z.object({ deploymentUrl: z.string(), flowId: z.string().optional() }).strict(),
    output: ResultSchema(z.object({ flowId: z.string(), authorizeUrl: z.string() }), z.string()),
  },
  waitForDesktopFlow: {
    input: z
      .object({
        flowId: z.string(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict(),
    output: ResultSchema(z.void(), z.string()),
  },
  cancelDesktopFlow: {
    input: z.object({ flowId: z.string() }).strict(),
    output: z.void(),
  },
  disconnect: {
    input: z.void(),
    output: ResultSchema(z.void(), z.string()),
  },
  // Re-run AI Gateway provider/model discovery with the stored credential so
  // newly configured providers/models appear without a re-login.
  refreshModels: {
    input: z.void(),
    output: ResultSchema(z.void(), z.string()),
  },
};

// Xum Gateway
export const muxGateway = {
  getAccountStatus: {
    input: z.void(),
    output: ResultSchema(
      z.object({
        remaining_microdollars: z.number().int().nonnegative(),
        ai_gateway_concurrent_requests_per_user: z.number().int().nonnegative(),
      }),
      z.string()
    ),
  },
};

const MCPOAuthPendingServerSchema = z
  .object({
    // OAuth is only supported for remote transports.
    transport: z.union([z.literal("http"), z.literal("sse"), z.literal("auto")]),
    url: z.string(),
  })
  .strict();

// MCP OAuth
export const mcpOauth = {
  startDesktopFlow: {
    input: z
      .object({
        projectPath: z.string().optional(),
        serverName: z.string(),
        pendingServer: MCPOAuthPendingServerSchema.optional(),
      })
      .strict(),
    output: ResultSchema(
      z.object({
        flowId: z.string(),
        authorizeUrl: z.string(),
        redirectUri: z.string(),
      }),
      z.string()
    ),
  },
  waitForDesktopFlow: {
    input: z
      .object({
        flowId: z.string(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict(),
    output: ResultSchema(z.void(), z.string()),
  },
  cancelDesktopFlow: {
    input: z.object({ flowId: z.string() }).strict(),
    output: z.void(),
  },
  startServerFlow: {
    input: z
      .object({
        projectPath: z.string().optional(),
        serverName: z.string(),
        pendingServer: MCPOAuthPendingServerSchema.optional(),
      })
      .strict(),
    output: ResultSchema(
      z.object({
        flowId: z.string(),
        authorizeUrl: z.string(),
        redirectUri: z.string(),
      }),
      z.string()
    ),
  },
  waitForServerFlow: {
    input: z
      .object({
        flowId: z.string(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict(),
    output: ResultSchema(z.void(), z.string()),
  },
  cancelServerFlow: {
    input: z.object({ flowId: z.string() }).strict(),
    output: z.void(),
  },
  getAuthStatus: {
    input: z.object({ serverUrl: z.string() }).strict(),
    output: z.object({
      serverUrl: z.string().optional(),
      isLoggedIn: z.boolean(),
      hasRefreshToken: z.boolean(),
      scope: z.string().optional(),
      updatedAtMs: z.number().optional(),
    }),
  },
  logout: {
    input: z.object({ serverUrl: z.string() }).strict(),
    output: ResultSchema(z.void(), z.string()),
  },
};

// Projects
export const projects = {
  create: {
    input: z.object({ projectPath: z.string(), initGit: z.boolean().optional() }),
    output: ResultSchema(
      z.object({
        projectConfig: ProjectConfigSchema,
        normalizedPath: z.string(),
      }),
      z.string()
    ),
  },
  getDefaultProjectDir: {
    input: z.void(),
    output: z.string(),
  },
  setDefaultProjectDir: {
    input: z.object({ path: z.string() }),
    output: z.void(),
  },
  clone: {
    input: z
      .object({
        repoUrl: z.string(),
        cloneParentDir: z.string().nullish(),
      })
      .strict(),
    output: eventIterator(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("progress"), line: z.string() }),
        z.object({
          type: z.literal("success"),
          projectConfig: ProjectConfigSchema,
          normalizedPath: z.string(),
        }),
        z.object({
          type: z.literal("error"),
          code: z.enum([
            "ssh_host_key_rejected",
            "ssh_credential_cancelled",
            "ssh_prompt_timeout",
            "clone_failed",
            "destination_exists",
          ]),
          error: z.string(),
          normalizedPath: z.string().nullish(),
        }),
      ])
    ),
  },
  pickDirectory: {
    input: z.object({ initialPath: z.string().nullish() }).nullish(),
    output: z.string().nullable(),
  },
  remove: {
    input: z.object({ projectPath: z.string(), force: z.boolean().nullish() }).passthrough(),
    output: ResultSchema(z.void(), ProjectRemoveErrorSchema),
  },
  // Read-only preflight for the delete confirmation dialog: projects.list no
  // longer embeds archived workspaces, so blocker counts come from the backend.
  getRemovalBlockers: {
    input: z.object({ projectPath: z.string() }),
    output: ProjectWorkspaceCountsSchema,
  },
  list: {
    input: z.void(),
    output: z.array(z.tuple([z.string(), ProjectConfigSchema])),
  },
  getFileCompletions: {
    input: z
      .object({
        projectPath: z.string(),
        query: z.string(),
        limit: z.number().int().positive().max(50).optional(),
      })
      .strict(),
    output: z.object({ paths: z.array(z.string()) }),
  },
  runtimeAvailability: {
    input: z.object({ projectPath: z.string() }),
    output: RuntimeAvailabilitySchema,
  },
  listBranches: {
    input: z.object({ projectPath: z.string() }),
    output: BranchListResultSchema,
  },
  gitInit: {
    input: z.object({ projectPath: z.string() }),
    output: ResultSchema(z.void(), z.string()),
  },
  setTrust: {
    input: z.object({ projectPath: z.string(), trusted: z.boolean() }),
    output: z.void(),
  },
  setDisplayName: {
    input: z
      .object({
        projectPath: z.string(),
        displayName: z.string().nullish(),
      })
      .passthrough(),
    output: z.void(),
  },
  setColor: {
    input: z
      .object({
        projectPath: z.string(),
        color: z.string().nullish(),
      })
      .passthrough(),
    output: z.void(),
  },
  setCustomInstructions: {
    input: z
      .object({
        projectPath: z.string(),
        customInstructions: z.string().nullish(),
      })
      .passthrough(),
    output: z.void(),
  },
  setCodeWorkspaceSyncPath: {
    input: z
      .object({
        projectPath: z.string(),
        codeWorkspaceSyncPath: z.string().nullish(),
      })
      .passthrough(),
    output: z.void(),
  },
  mcp: {
    list: {
      input: z.object({ projectPath: z.string() }),
      output: MCPServerMapSchema,
    },
    add: {
      input: MCPAddParamsSchema,
      output: ResultSchema(z.void(), z.string()),
    },
    remove: {
      input: MCPRemoveParamsSchema,
      output: ResultSchema(z.void(), z.string()),
    },
    test: {
      input: MCPTestParamsSchema,
      output: MCPTestResultSchema,
    },
    setEnabled: {
      input: MCPSetEnabledParamsSchema,
      output: ResultSchema(z.void(), z.string()),
    },
    setToolAllowlist: {
      input: MCPSetToolAllowlistParamsSchema,
      output: ResultSchema(z.void(), z.string()),
    },
  },
  mcpOauth: {
    startDesktopFlow: {
      input: z
        .object({
          projectPath: z.string(),
          serverName: z.string(),
          pendingServer: MCPOAuthPendingServerSchema.optional(),
        })
        .strict(),
      output: ResultSchema(
        z.object({
          flowId: z.string(),
          authorizeUrl: z.string(),
          redirectUri: z.string(),
        }),
        z.string()
      ),
    },
    waitForDesktopFlow: {
      input: z
        .object({
          flowId: z.string(),
          timeoutMs: z.number().int().positive().optional(),
        })
        .strict(),
      output: ResultSchema(z.void(), z.string()),
    },
    cancelDesktopFlow: {
      input: z.object({ flowId: z.string() }).strict(),
      output: z.void(),
    },
    startServerFlow: {
      input: z
        .object({
          projectPath: z.string(),
          serverName: z.string(),
          pendingServer: MCPOAuthPendingServerSchema.optional(),
        })
        .strict(),
      output: ResultSchema(
        z.object({
          flowId: z.string(),
          authorizeUrl: z.string(),
          redirectUri: z.string(),
        }),
        z.string()
      ),
    },
    waitForServerFlow: {
      input: z
        .object({
          flowId: z.string(),
          timeoutMs: z.number().int().positive().optional(),
        })
        .strict(),
      output: ResultSchema(z.void(), z.string()),
    },
    cancelServerFlow: {
      input: z.object({ flowId: z.string() }).strict(),
      output: z.void(),
    },
    getAuthStatus: {
      input: z
        .object({
          projectPath: z.string(),
          serverName: z.string(),
        })
        .strict(),
      output: z.object({
        serverUrl: z.string().optional(),
        isLoggedIn: z.boolean(),
        hasRefreshToken: z.boolean(),
        scope: z.string().optional(),
        updatedAtMs: z.number().optional(),
      }),
    },
    logout: {
      input: z
        .object({
          projectPath: z.string(),
          serverName: z.string(),
        })
        .strict(),
      output: ResultSchema(z.void(), z.string()),
    },
  },

  secrets: {
    get: {
      input: z.object({ projectPath: z.string() }),
      output: z.array(SecretSchema),
    },
    update: {
      input: z.object({
        projectPath: z.string(),
        secrets: z.array(SecretSchema),
      }),
      output: ResultSchema(z.void(), z.string()),
    },
  },
  idleCompaction: {
    get: {
      input: z.object({ projectPath: z.string() }),
      output: z.object({ hours: z.number().nullable() }),
    },
    set: {
      input: z.object({
        projectPath: z.string(),
        hours: z.number().min(1).nullable(),
      }),
      output: ResultSchema(z.void(), z.string()),
    },
  },
  subProjects: {
    assignWorkspace: {
      input: z.object({
        projectPath: z.string(),
        workspaceId: z.string(),
        subProjectPath: z.string().nullable(),
      }),
      output: ResultSchema(z.void(), z.string()),
    },
  },
};

/**
 * MCP server configuration.
 *
 * Global config lives in <xumHome>/mcp.jsonc, with optional repo overrides in <projectPath>/.xum/mcp.jsonc.
 */
export const mcp = {
  list: {
    input: MCPListParamsSchema,
    output: MCPServerMapSchema,
  },
  add: {
    input: MCPAddGlobalParamsSchema,
    output: ResultSchema(z.void(), z.string()),
  },
  remove: {
    input: MCPRemoveGlobalParamsSchema,
    output: ResultSchema(z.void(), z.string()),
  },
  test: {
    input: MCPTestGlobalParamsSchema,
    output: MCPTestResultSchema,
  },
  setEnabled: {
    input: MCPSetEnabledGlobalParamsSchema,
    output: ResultSchema(z.void(), z.string()),
  },
  setToolAllowlist: {
    input: MCPSetToolAllowlistGlobalParamsSchema,
    output: ResultSchema(z.void(), z.string()),
  },
};

/**
 * Managed Agent Plugin installs (agent-plugins experiment; global scope only).
 *
 * Human-driven surfaces only (Settings + palette) — there is deliberately no
 * agent-facing installer tool in v1. All endpoints return Result values; the
 * backend service gates on the experiment flag.
 */
export const agentPlugins = {
  /** Temp shallow clone + validation of the staged tree; writes nothing permanent. */
  preview: {
    input: z.object({
      input: z.string(),
      ref: z.string().nullish(),
      subpath: z.string().nullish(),
    }),
    output: ResultSchema(AgentPluginInstallPreviewSchema, z.string()),
  },
  /** Fetch the consented SHA, promote into ~/.mux/plugins, write the registry entry. */
  install: {
    input: z.object({
      source: AgentPluginGitSourceSchema,
      /** SHA from the preview the user consented to. */
      expectedSha: z.string(),
    }),
    output: ResultSchema(AgentPluginInstallEntrySchema, z.string()),
  },
  list: {
    input: z.void(),
    output: ResultSchema(z.array(AgentPluginListItemSchema), z.string()),
  },
  /** Display path of the ACTIVE managed plugin container (config-derived root; never hardcode it in UI). */
  containerLocation: {
    input: z.void(),
    output: z.string(),
  },
  uninstall: {
    input: z.object({
      name: z.string(),
      /** Also delete ~/.mux/plugin-data/<instanceId> (default off — preserve data). */
      deletePluginData: z.boolean(),
    }),
    output: ResultSchema(z.void(), z.string()),
  },
  /** git ls-remote per managed entry vs lockedSha; no fetch, no timers. */
  checkUpdates: {
    input: z.void(),
    output: ResultSchema(z.array(AgentPluginUpdateCheckSchema), z.string()),
  },
  update: {
    input: z.object({ name: z.string() }),
    output: ResultSchema(AgentPluginInstallEntrySchema, z.string()),
  },
};

/**
 * Secrets store.
 *
 * - When no projectPath is provided: global secrets
 * - When projectPath is provided: project-only secrets
 */
export const secrets = {
  get: {
    input: z.object({ projectPath: z.string().optional() }),
    output: z.array(SecretSchema),
  },
  /**
   * Read-only list of global secret keys injected into a project via `injectAll`.
   *
   * Project-owned keys are excluded because local/project secrets always win on collision.
   */
  getInjectedGlobals: {
    input: z.object({ projectPath: z.string() }).strict(),
    output: z.array(z.string()),
  },
  update: {
    input: z.object({
      projectPath: z.string().optional(),
      secrets: z.array(SecretSchema),
    }),
    output: ResultSchema(z.void(), z.string()),
  },
};

// Re-export Coder schemas from dedicated file
export { coder } from "./coder";

// Workspace
const DebugLlmRequestSnapshotSchema = z
  .object({
    capturedAt: z.number(),
    workspaceId: z.string(),
    messageId: z.string().optional(),
    model: z.string(),
    providerName: z.string(),
    thinkingLevel: z.string(),
    mode: z.string().optional(),
    agentId: z.string().optional(),
    maxOutputTokens: z.number().optional(),
    systemMessage: z.string(),
    messages: z.array(z.unknown()),
    response: z
      .object({
        capturedAt: z.number(),
        metadata: StreamEndEventSchema.shape.metadata,
        parts: z.array(CompletedMessagePartSchema),
      })
      .strict()
      .optional(),
  })
  .strict();

const ArchiveLossyUntrackedFilesConfirmationSchema = z.object({
  kind: z.literal("confirm-lossy-untracked-files"),
  paths: z.array(z.string()),
});

const ArchivePreflightResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }),
  ArchiveLossyUntrackedFilesConfirmationSchema,
]);

const ArchiveWorkspaceResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("archived") }),
  ArchiveLossyUntrackedFilesConfirmationSchema,
]);

/**
 * Memory curation routes (Memory tab + Settings → Memory; experiment:
 * "memory"). workspaceId is optional: when present, the router resolves that
 * workspace's runtime + checkout cwd to map virtual /memories paths onto
 * physical scope roots; when absent (Settings → Memory manages global files
 * without any workspace), only the global scope is reachable — project and
 * workspace paths fail with a recoverable error. Routes reject with
 * BAD_REQUEST while the experiment is disabled.
 */
export const memory = {
  /** Bulk list across all three scopes in one call (includes pin state). */
  list: {
    input: z.object({ workspaceId: z.string().nullish() }),
    output: ResultSchema(z.object({ files: z.array(MemoryFileInfoSchema) }), z.string()),
  },
  read: {
    input: z.object({ workspaceId: z.string().nullish(), path: z.string() }),
    output: ResultSchema(z.object({ content: z.string(), sha256: z.string() }), z.string()),
  },
  /** Whole-file save; expectedSha256 null means "create new file". */
  save: {
    input: z.object({
      workspaceId: z.string().nullish(),
      path: z.string(),
      content: z.string(),
      expectedSha256: z.string().nullable(),
    }),
    output: ResultSchema(z.object({ sha256: z.string() }), MemorySaveErrorSchema),
  },
  delete: {
    input: z.object({ workspaceId: z.string().nullish(), path: z.string() }),
    output: ResultSchema(z.void(), z.string()),
  },
  setPinned: {
    input: z.object({ workspaceId: z.string().nullish(), path: z.string(), pinned: z.boolean() }),
    output: ResultSchema(z.void(), z.string()),
  },
  /** Live change events from agent tool calls and UI edits (all scopes). */
  onChange: {
    input: z.object({ workspaceId: z.string().nullish() }),
    output: eventIterator(MemoryChangeEventSchema),
  },
  /** Latest consolidation ("dream") coverage records for the Memory tab. */
  consolidationStatus: {
    input: z.object({ workspaceId: z.string() }),
    output: ResultSchema(MemoryConsolidationStatusSchema, z.string()),
  },
  /** Manual consolidation run (/dream, Memory tab button); bypasses debounce. */
  consolidate: {
    input: z.object({ workspaceId: z.string() }),
    output: ResultSchema(MemoryConsolidationRecordSchema, z.string()),
  },
};

/** /refine (RLM r11): one applied self-modification, correlated to its r2 journal row. */
export const RefineAppliedEditSchema = z.object({
  /** Envelope id of the refinement journal row (rollback address for r6). */
  refinementId: z.string(),
  /** Human-readable action, e.g. "memory str_replace /memories/project/x.md". */
  description: z.string(),
});

export const RefineRecordSchema = z.object({
  applied: z.array(RefineAppliedEditSchema),
  /** Model's closing text (per-edit rationales, or the no-op statement). */
  summary: z.string(),
  /** True when the pass finished cleanly without applying any edit. */
  noOp: z.boolean(),
  /**
   * Edits the tools reported as applied but whose r2 journal row never landed
   * (journal/blob failures are swallowed by design so user writes stay
   * self-healing). Files changed with no rollback id — surfaced instead of
   * silently classifying the pass as a no-op.
   */
  untrackedApplied: z.number().optional(),
  /**
   * Edits a /refine run STAGED for explicit approval (security: the pass
   * never auto-applies model output). Present only on staging results;
   * applied via refinements.apply.
   */
  staged: z.array(z.object({ description: z.string() })).optional(),
  /**
   * Approved staged edits that failed to apply (tool unavailable, input
   * rejected by the tool schema, tool failure). Surfaced instead of folding
   * an all-failed apply into a successful no-op.
   */
  failed: z.array(z.object({ description: z.string(), reason: z.string() })).optional(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
});

// Node-side types derive from these schemas (z.infer single source) so fields
// can never silently be stripped by output validation.
export type RefineAppliedEditPayload = z.infer<typeof RefineAppliedEditSchema>;
export type RefineRecordPayload = z.infer<typeof RefineRecordSchema>;

export const refinements = {
  /** Manual /refine trajectory-distillation pass (RLM mode only; the backend refuses otherwise). Stages edits; nothing is applied until `apply`. */
  run: {
    // experiments: the renderer's effective flags ride the request (same
    // authority as send options.experiments) because persisting overrides to
    // the backend is asynchronous/best-effort — a backend-only gate could
    // refuse /refine while the workspace already runs with the RLM kernel.
    input: z.object({ workspaceId: z.string(), experiments: ExperimentsSchema.optional() }),
    output: ResultSchema(RefineRecordSchema, z.string()),
  },
  /** Apply the staged edits from the last run (explicit user approval step). */
  apply: {
    input: z.object({
      workspaceId: z.string(),
      /**
       * Hash of the newest staged proposal this renderer DISPLAYED (r64).
       * Required: with XUM_ALLOW_MULTIPLE_INSTANCES=1 the shared transcript
       * can hold a newer foreign proposal this window never rendered, so the
       * backend cannot infer the displayed proposal from the transcript
       * alone; apply refuses when this hash no longer matches the staged set.
       */
      approvedProposalHash: z.string().min(1),
      experiments: ExperimentsSchema.optional(),
    }),
    output: ResultSchema(RefineRecordSchema, z.string()),
  },
};

/**
 * Programmatic workspace tag keys must be non-blank. Enforced at the schema
 * boundary so callers get a structured validation error instead of the
 * service-level assert surfacing as an opaque INTERNAL_SERVER_ERROR.
 */
const WorkspaceTagKeySchema = z.string().regex(/\S/, "Workspace tag keys must be non-empty");

export const workspace = {
  list: {
    input: z
      .object({
        /** When true, only return archived workspaces. Default returns only non-archived. */
        archived: z.boolean().optional(),
      })
      .optional(),
    output: z.array(FrontendWorkspaceMetadataSchema),
  },
  create: {
    input: z.object({
      projectPath: z.string(),
      /**
       * Workspace branch name. When omitted, the backend auto-generates a name
       * based on the trunk branch (e.g., "main-1", "main-2"), similar to how
       * /fork derives a name from the parent workspace.
       */
      branchName: z.string().optional(),
      /** Trunk branch to fork from - only required for worktree/SSH runtimes, ignored for local */
      trunkBranch: z.string().optional(),
      /** Human-readable title (e.g., "Fix plan mode over SSH") - optional for backwards compat */
      title: z.string().optional(),
      runtimeConfig: RuntimeConfigSchema.optional(),
      /** Sub-project path to use for cwd and AGENTS.md context (optional). */
      subProjectPath: z.string().optional(),
      /**
       * When true, mark the workspace with `pendingAutoTitle` so the first user
       * message triggers an LLM-generated title (mirrors the /fork flow).
       */
      pendingAutoTitle: z.boolean().optional(),
      /**
       * Programmatic key/value tags persisted atomically with creation (not
       * rendered in the UI). Used by orchestration callers for stable identity.
       */
      tags: z.record(WorkspaceTagKeySchema, z.string()).optional(),
    }),
    output: z.discriminatedUnion("success", [
      z.object({ success: z.literal(true), metadata: FrontendWorkspaceMetadataSchema }),
      z.object({ success: z.literal(false), error: z.string() }),
    ]),
  },
  createScratch: {
    input: z.object({
      title: z.string().optional(),
    }),
    output: z.discriminatedUnion("success", [
      z.object({ success: z.literal(true), metadata: FrontendWorkspaceMetadataSchema }),
      z.object({ success: z.literal(false), error: z.string() }),
    ]),
  },
  createMultiProject: {
    input: z.object({
      projects: z
        .array(ProjectRefSchema)
        .min(2, "createMultiProject requires at least two projects"),
      branchName: z.string(),
      trunkBranch: z.string().optional(),
      title: z.string().optional(),
      runtimeConfig: RuntimeConfigSchema.optional(),
    }),
    output: FrontendWorkspaceMetadataSchema,
  },
  remove: {
    input: z.object({
      workspaceId: z.string(),
      options: z.object({ force: z.boolean().optional() }).optional(),
    }),
    output: z.object({ success: z.boolean(), error: z.string().optional() }),
  },
  rename: {
    input: z.object({ workspaceId: z.string(), newName: z.string() }),
    output: ResultSchema(z.object({ newWorkspaceId: z.string() }), z.string()),
  },
  updateTitle: {
    input: z.object({ workspaceId: z.string(), title: z.string() }),
    output: ResultSchema(z.void(), z.string()),
  },
  setPinned: {
    input: z.object({ workspaceId: z.string(), pinned: z.boolean() }),
    output: ResultSchema(z.void(), z.string()),
  },
  reorderPinned: {
    /**
     * Full desired pinned order for one project bucket. The server derives the
     * bucket from the first known id (so clients never need internal bucket
     * keys like the multi-project one), drops stale/unpinned ids, and appends
     * currently-pinned ids omitted from the input, absorbing concurrent
     * pin/unpin from other clients.
     */
    input: z.object({ workspaceIds: z.array(z.string()) }),
    output: ResultSchema(z.void(), z.string()),
  },
  updateTags: {
    /** Merge tag updates into a workspace; a null value deletes that key. */
    input: z.object({
      workspaceId: z.string(),
      tags: z
        .record(WorkspaceTagKeySchema, z.string().nullable())
        .refine((tags) => Object.keys(tags).length > 0, {
          message: "updateTags requires at least one tag update",
        }),
    }),
    output: ResultSchema(z.object({ tags: z.record(z.string(), z.string()) }), z.string()),
  },
  regenerateTitle: {
    input: z.object({ workspaceId: z.string() }),
    output: ResultSchema(z.object({ title: z.string() }), z.string()),
  },
  timeline: {
    list: {
      input: TimelineListInputSchema.extend({ workspaceId: z.string() }),
      output: TimelinePageSchema,
    },
    subscribe: {
      input: z.object({ workspaceId: z.string() }).strict(),
      output: eventIterator(TimelineSubscriptionEventSchema),
    },
    preview: {
      input: TimelinePreviewInputSchema.extend({ workspaceId: z.string() }),
      output: TimelinePreviewSchema.nullable(),
    },
  },
  heartbeat: {
    get: {
      input: z.object({ workspaceId: z.string() }),
      output: WorkspaceHeartbeatSettingsSchema.nullable(),
    },
    set: {
      input: WorkspaceHeartbeatSettingsSchema.extend({
        workspaceId: z.string(),
      }),
      output: ResultSchema(z.void(), z.string()),
    },
  },
  goalDefaults: {
    // Per-workspace override of the global `goalDefaults` block. `get`
    // returns `null` when no override is set (i.e., this workspace uses
    // the global default). `set` accepts a sparse override; passing
    // `null` for any field clears that override; passing all-null clears
    // the whole record.
    get: {
      input: z.object({ workspaceId: z.string() }),
      output: WorkspaceGoalDefaultsOverrideSchema.nullable(),
    },
    set: {
      input: WorkspaceGoalDefaultsOverrideSchema.extend({
        workspaceId: z.string(),
      }),
      output: ResultSchema(z.void(), z.string()),
    },
  },
  updateAgentAISettings: {
    input: z.object({
      workspaceId: z.string(),
      agentId: AgentIdSchema,
      aiSettings: WorkspaceAISettingsSchema,
      persistSelectedAgentId: z.boolean().nullish(),
    }),
    output: ResultSchema(z.void(), z.string()),
  },
  updateModeAISettings: {
    input: z.object({
      workspaceId: z.string(),
      mode: UIModeSchema,
      aiSettings: WorkspaceAISettingsSchema,
    }),
    output: ResultSchema(z.void(), z.string()),
  },
  // Mid-turn thinking change: request that the active turn's NEXT model step
  // uses this level. `accepted: false` (success) = no turn active — persisted
  // settings already cover the next turn. `accepted: true` = the level applies
  // to the current turn's next step if one occurs (expires silently otherwise).
  setActiveTurnThinkingLevel: {
    input: z.object({
      workspaceId: z.string(),
      thinkingLevel: ThinkingLevelSchema,
    }),
    output: ResultSchema(z.object({ accepted: z.boolean() }), z.string()),
  },
  preflightArchive: {
    input: z.object({ workspaceId: z.string() }),
    output: ResultSchema(ArchivePreflightResultSchema, z.string()),
  },
  archive: {
    input: z.object({
      workspaceId: z.string(),
      acknowledgedUntrackedPaths: z.array(z.string()).nullish(),
    }),
    output: ResultSchema(ArchiveWorkspaceResultSchema, z.string()),
  },
  unarchive: {
    input: z.object({ workspaceId: z.string() }),
    output: ResultSchema(z.void(), z.string()),
  },
  deleteWorktree: {
    input: z.object({ workspaceId: z.string() }),
    output: ResultSchema(z.void(), z.string()),
  },
  stopRuntime: {
    input: z.object({ workspaceId: z.string() }),
    output: ResultSchema(z.void(), z.string()),
  },
  getRuntimeStatuses: {
    input: z.object({ workspaceIds: z.array(z.string()) }),
    output: z.record(z.string(), z.enum(["running", "stopped", "unknown", "unsupported"])),
  },
  getProjectGitStatuses: {
    input: z.object({
      workspaceId: z.string(),
      baseRef: z.string().nullish(),
    }),
    output: z.array(ProjectGitStatusResultSchema),
  },
  archiveMergedInProject: {
    input: z.object({ projectPath: z.string() }),
    output: ResultSchema(
      z.object({
        archivedWorkspaceIds: z.array(z.string()),
        skippedWorkspaceIds: z.array(z.string()),
        errors: z.array(
          z.object({
            workspaceId: z.string(),
            error: z.string(),
          })
        ),
      }),
      z.string()
    ),
  },
  fork: {
    input: z.object({
      sourceWorkspaceId: z.string(),
      newName: z.string().optional(),
      sourceMessageId: z.string().optional(),
      pendingAutoTitle: z.boolean().optional(),
    }),
    output: z.discriminatedUnion("success", [
      z.object({
        success: z.literal(true),
        metadata: FrontendWorkspaceMetadataSchema,
        projectPath: z.string(),
      }),
      z.object({ success: z.literal(false), error: z.string() }),
    ]),
  },
  stageAttachment: {
    input: z.object({
      workspaceId: z.string(),
      filename: z.string(),
      mediaType: z.string().nullish(),
      sizeBytes: z.number().int().nonnegative().max(MAX_STAGED_ATTACHMENT_SIZE_BYTES),
      dataBase64: z.string().max(MAX_STAGED_ATTACHMENT_BASE64_CHARS),
    }),
    output: ResultSchema(
      z.object({
        filename: z.string(),
        mediaType: z.string(),
        sizeBytes: z.number().int().nonnegative(),
        stagedPath: z.string(),
      }),
      z.string()
    ),
  },
  downloadStagedAttachment: {
    input: z.object({
      workspaceId: z.string(),
      stagedPath: z.string(),
    }),
    output: ResultSchema(
      z.object({
        filename: z.string(),
        mediaType: z.string(),
        sizeBytes: z.number().int().nonnegative().max(MAX_STAGED_ATTACHMENT_SIZE_BYTES),
        dataBase64: z.string().max(MAX_STAGED_ATTACHMENT_BASE64_CHARS),
      }),
      z.string()
    ),
  },
  sendMessage: {
    input: z.object({
      workspaceId: z.string(),
      message: z.string(),
      options: SendMessageOptionsSchema.extend({
        fileParts: z.array(FilePartSchema).optional(),
      }),
    }),
    output: ResultSchema(z.object({}), SendMessageErrorSchema),
  },
  answerAskUserQuestion: {
    input: z
      .object({
        workspaceId: z.string(),
        toolCallId: z.string(),
        answers: z.record(z.string(), z.string()),
      })
      .strict(),
    output: ResultSchema(z.void(), z.string()),
  },
  answerDelegatedToolCall: {
    input: z
      .object({
        workspaceId: z.string(),
        toolCallId: z.string(),
        result: z.unknown(),
      })
      .strict(),
    output: ResultSchema(z.void(), z.string()),
  },
  resumeStream: {
    input: z.object({
      workspaceId: z.string(),
      options: SendMessageOptionsSchema,
    }),
    output: ResultSchema(
      z.object({
        started: z.boolean(),
      }),
      SendMessageErrorSchema
    ),
  },
  setAutoRetryEnabled: {
    input: z.object({
      workspaceId: z.string(),
      enabled: z.boolean(),
      // Runtime-only toggle for temporary retry flows (do not mutate persisted preference).
      persist: z.boolean().nullish(),
    }),
    output: ResultSchema(
      z.object({
        previousEnabled: z.boolean(),
        enabled: z.boolean(),
      }),
      z.string()
    ),
  },
  getStartupAutoRetryModel: {
    input: z.object({ workspaceId: z.string() }),
    output: ResultSchema(z.string().nullable(), z.string()),
  },
  setAutoCompactionThreshold: {
    input: z.object({
      workspaceId: z.string(),
      threshold: z.number().finite().min(0.1).max(1.0),
    }),
    output: ResultSchema(z.void(), z.string()),
  },
  interruptStream: {
    input: z.object({
      workspaceId: z.string(),
      options: z
        .object({
          soft: z.boolean().optional(),
          abandonPartial: z.boolean().optional(),
          sendQueuedImmediately: z.boolean().optional(),
        })
        .optional(),
    }),
    output: ResultSchema(z.void(), z.string()),
  },
  clearQueue: {
    input: z.object({ workspaceId: z.string() }),
    output: ResultSchema(z.void(), z.string()),
  },
  setQueuedMessageDispatchMode: {
    input: z.object({
      workspaceId: z.string(),
      queueDispatchMode: z.enum(["tool-end", "turn-end"]),
    }),
    output: ResultSchema(z.boolean(), z.string()),
  },
  truncateHistory: {
    input: z.object({
      workspaceId: z.string(),
      percentage: z.number().optional(),
    }),
    output: ResultSchema(z.void(), z.string()),
  },
  resetContext: {
    input: z.object({ workspaceId: z.string() }),
    output: ResultSchema(z.enum(["reset", "noop"]), z.string()),
  },
  replaceChatHistory: {
    input: z.object({
      workspaceId: z.string(),
      summaryMessage: MuxMessageSchema,
      /**
       * Replace strategy.
       * - destructive (default): clear history, then append summary
       * - append-compaction-boundary: keep history and append summary as durable boundary
       */
      mode: z.enum(["destructive", "append-compaction-boundary"]).nullish(),
      /** When true, delete the plan file (new + legacy paths) and clear plan tracking state. */
      deletePlanFile: z.boolean().optional(),
    }),
    output: ResultSchema(z.void(), z.string()),
  },
  getDevcontainerInfo: {
    input: z.object({ workspaceId: z.string() }),
    output: z
      .object({
        containerName: z.string(),
        containerWorkspacePath: z.string(),
        hostWorkspacePath: z.string(),
      })
      .nullable(),
  },
  getInfo: {
    input: z.object({ workspaceId: z.string() }),
    output: FrontendWorkspaceMetadataSchema.nullable(),
  },
  getLastLlmRequest: {
    input: z.object({ workspaceId: z.string() }),
    output: ResultSchema(DebugLlmRequestSnapshotSchema.nullable(), z.string()),
  },
  getFullReplay: {
    input: z.object({ workspaceId: z.string() }),
    output: z.array(WorkspaceChatMessageSchema),
  },
  history: {
    loadMore: {
      input: z.object({
        workspaceId: z.string(),
        cursor: z
          .object({
            beforeHistorySequence: z.number(),
            beforeMessageId: z.string().nullish(),
          })
          .nullish(),
      }),
      output: z.object({
        messages: z.array(WorkspaceChatMessageSchema),
        nextCursor: z
          .object({
            beforeHistorySequence: z.number(),
            beforeMessageId: z.string().nullish(),
          })
          .nullable(),
        hasOlder: z.boolean(),
      }),
    },
    /** Searches full history, including prompts before the replay boundary. */
    lastUserPrompt: {
      input: z.object({ workspaceId: z.string() }),
      output: z
        .object({
          text: z.string(),
          messageId: z.string(),
        })
        .nullable(),
    },
  },
  /**
   * Load an archived subagent transcript (chat.jsonl + optional partial.json) from this workspace's
   * session dir.
   */
  getSubagentTranscript: {
    input: z.object({
      /** Workspace that owns the transcript artifact index (usually the current workspace). */
      workspaceId: z.string().optional(),
      /** Child task/workspace id whose transcript should be loaded. */
      taskId: z.string(),
    }),
    output: z.object({
      messages: z.array(MuxMessageSchema),
      /** Task-level model string used when running the sub-agent (optional for legacy entries). */
      model: z.string().optional(),
      /** Task-level thinking/reasoning level used when running the sub-agent (optional for legacy entries). */
      thinkingLevel: ThinkingLevelSchema.optional(),
    }),
  },
  executeBash: {
    input: z.object({
      workspaceId: z.string(),
      script: z.string(),
      // Optional argv mode. When provided, backend executes command+args directly where possible
      // (without shell interpolation) and falls back to shell-quoted argv for remote runtimes.
      command: z.string().nullish(),
      args: z.array(z.string()).nullish(),
      options: z
        .object({
          timeout_secs: z.number().nullish(),
          // Multi-project script mode defaults to the shared container root; repo-context UI
          // callers opt into repo-root execution and can point it at the project that owns a
          // referenced workspace-relative path when they need git/file-path context.
          cwdMode: z.enum(["default", "repo-root"]).nullish(),
          repoRootProjectPath: z.string().nullish(),
        })
        .nullish(),
    }),
    output: ResultSchema(BashToolResultSchema, z.string()),
  },
  getFileCompletions: {
    input: z
      .object({
        workspaceId: z.string(),
        query: z.string(),
        limit: z.number().int().positive().max(50).optional(),
      })
      .strict(),
    output: z.object({ paths: z.array(z.string()) }),
  },
  // Subscriptions
  onChat: {
    input: z.object({
      workspaceId: z.string(),
      mode: OnChatModeSchema.optional(),
      // One-shot migration hint: legacy renderer localStorage opt-out value.
      // Used only when backend auto-retry preference file is missing.
      legacyAutoRetryEnabled: z.boolean().optional(),
    }),
    output: eventIterator(WorkspaceChatMessageSchema), // Stream event
  },
  onMetadata: {
    input: z.void(),
    output: eventIterator(
      z.object({
        workspaceId: z.string(),
        metadata: FrontendWorkspaceMetadataSchema.nullable(),
      })
    ),
  },
  activity: {
    list: {
      input: z.void(),
      // null signals a backend read failure; {} is a legitimate all-idle result.
      output: z.record(z.string(), WorkspaceActivitySnapshotSchema).nullable(),
    },
    subscribe: {
      input: z.void(),
      output: eventIterator(
        z.discriminatedUnion("type", [
          z.object({
            type: z.literal("activity"),
            workspaceId: z.string(),
            activity: WorkspaceActivitySnapshotSchema.nullable(),
          }),
          HeartbeatEventSchema,
        ])
      ),
    },
  },
  /**
   * Get the current plan file content for a workspace.
   * Used by UI to refresh plan display when file is edited externally.
   */
  getPlanContent: {
    input: z.object({ workspaceId: z.string() }),
    output: ResultSchema(
      z.object({
        content: z.string(),
        path: z.string(),
      }),
      z.string()
    ),
  },
  backgroundBashes: {
    /**
     * Subscribe to background bash state changes for a workspace.
     * Emits full state on connect, then incremental updates.
     */
    subscribe: {
      input: z.object({ workspaceId: z.string() }),
      output: eventIterator(
        z.object({
          /** Background processes (not including foreground ones being waited on) */
          processes: z.array(BackgroundProcessInfoSchema),
          /** Tool call IDs of foreground bashes that can be sent to background */
          foregroundToolCallIds: z.array(z.string()),
        })
      ),
    },
    terminate: {
      input: z.object({ workspaceId: z.string(), processId: z.string() }),
      output: ResultSchema(z.void(), z.string()),
    },
    /**
     * Send a foreground bash process to background.
     * The process continues running but the agent stops waiting for it.
     */
    sendToBackground: {
      input: z.object({ workspaceId: z.string(), toolCallId: z.string() }),
      output: ResultSchema(z.void(), z.string()),
    },
    /**
     * Peek output for a background bash process without consuming the bash_output cursor.
     */
    getOutput: {
      input: z.object({
        workspaceId: z.string(),
        processId: z.string(),
        fromOffset: z.number().int().nonnegative().optional(),
        tailBytes: z.number().int().positive().max(1_000_000).optional(),
      }),
      output: ResultSchema(
        z.object({
          status: BackgroundProcessStatusSchema,
          output: z.string(),
          nextOffset: z.number().int().nonnegative(),
          truncatedStart: z.boolean(),
        }),
        z.string()
      ),
    },
  },
  /**
   * Get post-compaction context state for a workspace.
   * Returns plan path (if exists) and tracked file paths that will be injected.
   */
  getPostCompactionState: {
    input: z.object({ workspaceId: z.string() }),
    output: z.object({
      planPath: z.string().nullable(),
      trackedFilePaths: z.array(z.string()),
      excludedItems: z.array(z.string()),
    }),
  },
  /**
   * Toggle whether a post-compaction item is excluded from injection.
   * Item IDs: "plan" for plan file, "file:<path>" for tracked files.
   */
  setPostCompactionExclusion: {
    input: z.object({
      workspaceId: z.string(),
      itemId: z.string(),
      excluded: z.boolean(),
    }),
    output: ResultSchema(z.void(), z.string()),
  },
  stats: {
    subscribe: {
      input: z.object({ workspaceId: z.string() }),
      output: eventIterator(WorkspaceStatsSnapshotSchema),
    },
    clear: {
      input: z.object({ workspaceId: z.string() }),
      output: ResultSchema(z.void(), z.string()),
    },
  },
  getGoal: {
    input: GoalGetInputSchema,
    output: z.object({ goal: GoalRecordV1Schema.nullable() }),
  },
  setGoal: {
    input: GoalSetInputSchema,
    output: ResultSchema(GoalRecordV1Schema, GoalSetErrorSchema),
  },
  clearGoal: {
    input: GoalClearInputSchema,
    output: z.object({ cleared: z.boolean() }),
  },
  /**
   * Goal board (multi-goal queue) endpoints. The board is the renderer-
   * facing view of a workspace's goals across the four sections (active,
   * upcoming, complete, archived). Backed by `goal.json` (active),
   * `goal-board.json` (upcoming + archived), and `goal-history.jsonl`
   * (complete). See `src/common/orpc/schemas/goal.ts` for the schema
   * rationale and the deliberate decision to keep the agent's
   * `get_goal` tool reading only the active goal.
   */
  getGoalBoard: {
    input: GoalBoardGetInputSchema,
    output: GoalBoardSnapshotSchema,
  },
  addUpcomingGoal: {
    input: GoalBoardAddUpcomingInputSchema,
    output: GoalRecordV1Schema,
  },
  archiveGoal: {
    input: GoalBoardArchiveInputSchema,
    output: z.void(),
  },
  reviveArchivedGoal: {
    input: GoalBoardReviveInputSchema,
    output: z.void(),
  },
  reorderUpcomingGoals: {
    input: GoalBoardReorderInputSchema,
    output: z.void(),
  },
  promoteUpcomingGoal: {
    input: GoalBoardPromoteInputSchema,
    output: GoalRecordV1Schema.nullable(),
  },
  updateUpcomingGoal: {
    input: GoalBoardUpdateUpcomingInputSchema,
    output: GoalRecordV1Schema.nullable(),
  },
  getSessionUsage: {
    input: z.object({ workspaceId: z.string() }),
    output: SessionUsageFileSchema.optional(),
  },
  /** Batch fetch session usage for multiple workspaces (for archived workspaces cost display) */
  getSessionUsageBatch: {
    input: z.object({ workspaceIds: z.array(z.string()) }),
    output: z.record(z.string(), SessionUsageFileSchema.optional()),
  },
  /**
   * Resolve the instruction context (AGENTS.md, CLAUDE.md, AGENTS.local.md, …)
   * loaded into the system prompt for this workspace. Used by the right-sidebar
   * Instructions tab; the same structured payload backs the prompt builder so
   * the panel can never drift from what the agent actually sees.
   */
  getInstructions: {
    input: z.object({
      workspaceId: z.string(),
      /** Optional canonical "provider:model" used for token counting. */
      model: z.string().nullish(),
    }),
    output: WorkspaceInstructionsSchema,
  },
  getAdditionalSystemContext: {
    input: z.object({ workspaceId: z.string() }),
    output: AdditionalSystemContextSchema,
  },
  setAdditionalSystemContext: {
    input: z.object({
      workspaceId: z.string(),
      content: z.string(),
      enabled: z.boolean(),
    }),
    output: AdditionalSystemContextSchema,
  },
  /** Per-workspace MCP configuration (overrides project-level mcp.jsonc) */
  mcp: {
    get: {
      input: z.object({ workspaceId: z.string() }),
      output: z.object({
        overrides: WorkspaceMCPOverridesSchema,
        /** Opaque token for optimistic-concurrency saves (set.expectedRevision). */
        revision: z.string(),
      }),
    },
    prompts: {
      list: {
        input: z.object({ workspaceId: z.string() }),
        output: z.array(MCPPromptDescriptorSchema),
      },
    },
    set: {
      input: z.object({
        workspaceId: z.string(),
        overrides: WorkspaceMCPOverridesSchema,
        /**
         * Revision returned by get. The save is rejected if the stored
         * overrides changed since then, so a stale dialog snapshot cannot
         * silently restore entries removed by a concurrent writer (e.g. an
         * Agent Plugin uninstall pruning its `plugin:` keys).
         */
        expectedRevision: z.string(),
      }),
      output: ResultSchema(z.void(), z.string()),
    },
  },
  /** Agent Plugins: contributed slash commands + composition inspector */
  plugins: {
    slashCommands: {
      list: {
        input: z.object({ workspaceId: z.string() }),
        output: z.array(PluginSlashCommandDescriptorSchema),
      },
    },
    composition: {
      get: {
        input: z.object({ workspaceId: z.string() }),
        output: WorkspaceCompositionSchema,
      },
    },
  },
};

export type WorkspaceSendMessageOutput = z.infer<typeof workspace.sendMessage.output>;
export type ArchiveLossyUntrackedFilesConfirmation = z.infer<
  typeof ArchiveLossyUntrackedFilesConfirmationSchema
>;
export type ArchivePreflightResult = z.infer<typeof ArchivePreflightResultSchema>;
export type ArchiveWorkspaceResult = z.infer<typeof ArchiveWorkspaceResultSchema>;

// Tasks (agent sub-workspaces)
export const tasks = {
  create: {
    input: z
      .object({
        parentWorkspaceId: z.string(),
        kind: z.literal("agent"),
        desktop: z.enum(["shared", "isolated"]).optional(),
        agentId: AgentIdSchema.optional(),
        /** @deprecated Legacy alias for agentId (kept for downgrade compatibility). */
        agentType: z.string().min(1).optional(),
        prompt: z.string(),
        title: z.string().min(1),
        modelString: z.string().optional(),
        thinkingLevel: z.string().optional(),
      })
      .superRefine((value, ctx) => {
        const hasAgentId = typeof value.agentId === "string" && value.agentId.trim().length > 0;
        const hasAgentType =
          typeof value.agentType === "string" && value.agentType.trim().length > 0;

        if (hasAgentId === hasAgentType) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "tasks.create: exactly one of agentId or agentType is required",
            path: ["agentId"],
          });
        }
      }),
    output: ResultSchema(
      z.object({
        taskId: z.string(),
        kind: z.literal("agent"),
        status: z.enum(["queued", "starting", "running"]),
        desktopOwnerWorkspaceId: z.string().optional(),
      }),
      z.string()
    ),
  },
};

// Agent definitions (unifies UI modes + subagents)
// Agents can be discovered from either the PROJECT path or the WORKSPACE path.
// - Project path: <projectPath>/.xum/agents - shared across all workspaces
// - Workspace path: <worktree>/.xum/agents - workspace-specific (useful for iterating)
// Default is workspace path when workspaceId is provided.
// Use disableWorkspaceAgents in SendMessageOptions to skip workspace agents during message sending.

// At least one of projectPath or workspaceId must be provided for agent discovery.
// Agent discovery input supports:
// - workspaceId only: resolve projectPath from workspace metadata, discover from worktree
// - projectPath only: discover from project path (project page, no workspace yet)
// - both: discover from worktree using workspaceId
// - disableWorkspaceAgents: when true with workspaceId, use workspace's runtime but discover
//   from projectPath instead of worktree (useful for SSH workspaces when iterating on agents)
const AgentDiscoveryInputSchema = z
  .object({
    projectPath: z.string().optional(),
    workspaceId: z.string().optional(),
    /** When true, skip workspace worktree and discover from projectPath (but still use workspace runtime) */
    disableWorkspaceAgents: z.boolean().optional(),
    /** When true, include agents disabled by front-matter (for Settings UI). */
    includeDisabled: z.boolean().optional(),
  })
  .refine((data) => Boolean(data.projectPath ?? data.workspaceId), {
    message: "Either projectPath or workspaceId must be provided",
  });

export const agents = {
  list: {
    input: AgentDiscoveryInputSchema,
    output: z.array(AgentDefinitionDescriptorSchema),
  },
  get: {
    input: AgentDiscoveryInputSchema.and(z.object({ agentId: AgentIdSchema })),
    output: AgentDefinitionPackageSchema,
  },
};

// Agent skills
export const agentSkills = {
  list: {
    input: AgentDiscoveryInputSchema,
    output: z.array(AgentSkillDescriptorSchema),
  },
  listDiagnostics: {
    input: AgentDiscoveryInputSchema,
    output: z.object({
      skills: z.array(AgentSkillDescriptorSchema),
      invalidSkills: z.array(AgentSkillIssueSchema),
    }),
  },
  get: {
    input: AgentDiscoveryInputSchema.and(z.object({ skillName: SkillNameSchema })),
    output: AgentSkillPackageSchema,
  },
};

// Workflows

// Shared wire shapes for the sub-agent tray's run-liveness/discovery endpoints:
// the renderer imports these types so contract changes propagate through one
// definition instead of drifting across manually repeated object shapes.
export const WorkflowRunLivenessEntrySchema = z.object({
  runId: WorkflowRunIdSchema,
  // null = no durable record for this ref (settled); failed reads are omitted upstream.
  status: WorkflowRunStatusSchema.nullable(),
});
export type WorkflowRunLivenessEntry = z.infer<typeof WorkflowRunLivenessEntrySchema>;

export const WorkflowActiveRunSummarySchema = z.object({
  /** Workspace whose durable run store owns the run. */
  workspaceId: z.string(),
  runId: WorkflowRunIdSchema,
  workflowName: z.string().nullable(),
  /** Nested (workflow-in-workflow) runs are absent from workspace activity. */
  nested: z.boolean(),
});

export const workflows = {
  listRuns: {
    input: z.object({ workspaceId: z.string().min(1) }).strict(),
    output: z.array(WorkflowRunRecordSchema),
  },
  getRun: {
    input: z.object({ workspaceId: z.string().min(1), runId: WorkflowRunIdSchema }).strict(),
    output: WorkflowRunRecordSchema.nullable(),
  },
  // Bulk liveness lookup: one renderer round trip covers runs owned by different
  // workspaces. status null = no durable record; a ref whose read failed is omitted
  // from the output so callers can tell transient errors from a settled/missing run.
  getRunStatuses: {
    input: z
      .object({
        runs: z.array(
          z.object({ workspaceId: z.string().min(1), runId: WorkflowRunIdSchema }).strict()
        ),
      })
      .strict(),
    output: z.array(WorkflowRunLivenessEntrySchema),
  },
  // Cold-mount discovery for the sub-agent tray: nested (parentWorkflow) runs are
  // deliberately absent from workspace activity, so a tray mounting during such a
  // run's between-workers gap needs one bulk read to find active runs across the
  // candidate owner workspaces.
  listActiveRuns: {
    input: z.object({ workspaceIds: z.array(z.string().min(1)) }).strict(),
    output: z.array(WorkflowActiveRunSummarySchema),
  },
  interrupt: {
    input: z.object({ workspaceId: z.string().min(1), runId: WorkflowRunIdSchema }).strict(),
    output: WorkflowRunRecordSchema,
  },
  resume: {
    input: z.object({ workspaceId: z.string().min(1), runId: WorkflowRunIdSchema }).strict(),
    output: z.object({
      runId: WorkflowRunIdSchema,
      status: WorkflowRunStatusSchema,
      result: z.unknown(),
    }),
  },
  retryFromCheckpoint: {
    input: z.object({ workspaceId: z.string().min(1), runId: WorkflowRunIdSchema }).strict(),
    output: z.object({
      runId: WorkflowRunIdSchema,
      status: WorkflowRunStatusSchema,
      result: z.unknown(),
    }),
  },
  start: {
    input: z
      .object({
        workspaceId: z.string().min(1),
        scriptPath: z.string().min(1),
        runInBackground: z.boolean().optional(),
        args: z.unknown().optional(),
        rawCommand: z.string().min(1).optional(),
        continuationOptions: SendMessageOptionsSchema.optional(),
      })
      .strict(),
    output: z.object({
      runId: WorkflowRunIdSchema,
      status: WorkflowRunStatusSchema,
      result: z.unknown(),
      invocationMessagePersisted: z.boolean().optional(),
    }),
  },
  subscribe: {
    input: z.object({ workspaceId: z.string().min(1) }).strict(),
    output: eventIterator(WorkflowRunStreamEventSchema),
  },
  listScripts: {
    input: z.object({ workspaceId: z.string().min(1) }).strict(),
    output: z.array(AvailableWorkflowSchema),
  },
};

// Name generation for new workspaces (decoupled from workspace creation)
export const nameGeneration = {
  generate: {
    input: z.object({
      message: z.string(),
      /** Ordered list of model candidates to try (backend resolves gateway routing in createModel) */
      candidates: z.array(z.string()),
    }),
    output: ResultSchema(
      z.object({
        /** Short git-safe name with suffix (e.g., "plan-a1b2") */
        name: z.string(),
        /** Human-readable title (e.g., "Fix plan mode over SSH") */
        title: z.string(),
        modelUsed: z.string(),
      }),
      NameGenerationErrorSchema
    ),
  },
};

// Window
export const window = {
  setTitle: {
    input: z.object({ title: z.string() }),
    output: z.void(),
  },
};

// Terminal
export const terminal = {
  create: {
    input: TerminalCreateParamsSchema,
    output: TerminalSessionSchema,
  },
  close: {
    input: z.object({ sessionId: z.string() }),
    output: z.void(),
  },
  resize: {
    input: TerminalResizeParamsSchema,
    output: z.void(),
  },
  sendInput: {
    input: z.object({ sessionId: z.string(), data: z.string() }),
    output: z.void(),
  },
  onOutput: {
    input: z.object({ sessionId: z.string() }),
    output: eventIterator(z.string()),
  },
  /**
   * Attach to a terminal session with race-free state restore.
   * First yields { type: "screenState", data: string } with serialized screen (~4KB),
   * then yields { type: "output", data: string } for each live output chunk.
   * Guarantees no missed output between state snapshot and live stream.
   */
  attach: {
    input: z.object({ sessionId: z.string() }),
    output: eventIterator(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("screenState"), data: z.string() }),
        z.object({ type: z.literal("output"), data: z.string() }),
      ])
    ),
  },

  onExit: {
    input: z.object({ sessionId: z.string() }),
    output: eventIterator(z.number()),
  },
  openWindow: {
    input: z.object({
      workspaceId: z.string(),
      /** Optional session ID to reattach to an existing terminal session (for pop-out handoff) */
      sessionId: z.string().optional(),
      /** Last known OSC title, so the pop-out badge doesn't reset to "Terminal" */
      initialTitle: z.string().optional(),
    }),
    output: z.void(),
  },
  closeWindow: {
    input: z.object({ workspaceId: z.string() }),
    output: z.void(),
  },
  /**
   * Subscribe to terminal activity changes across all workspaces.
   * First event is a snapshot of all workspace aggregates.
   * Subsequent events are per-workspace updates.
   */
  activity: {
    subscribe: {
      input: z.void(),
      output: eventIterator(
        z.discriminatedUnion("type", [
          z.object({
            type: z.literal("snapshot"),
            workspaces: z.record(
              z.string(),
              z.object({
                activeCount: z.number(),
                totalSessions: z.number(),
              })
            ),
          }),
          z.object({
            type: z.literal("update"),
            workspaceId: z.string(),
            activity: z.object({
              activeCount: z.number(),
              totalSessions: z.number(),
            }),
          }),
          HeartbeatEventSchema,
        ])
      ),
    },
  },
  /**
   * List active terminal sessions for a workspace.
   * Used by frontend to discover existing sessions to reattach to after reload.
   */
  listSessions: {
    input: z.object({ workspaceId: z.string() }),
    output: z.array(z.string()),
  },
  /**
   * Open the native system terminal for a workspace.
   * Opens the user's preferred terminal emulator (Ghostty, Terminal.app, etc.)
   * with the working directory set to the workspace path.
   */
  openNative: {
    input: z.object({ workspaceId: z.string() }),
    output: z.void(),
  },
};

// Server

export const TailscaleBindHostSchema = z.object({
  interfaceName: z.string(),
  address: z.string(),
  family: z.enum(["IPv4", "IPv6"]),
});

export const ApiServerStatusSchema = z.object({
  running: z.boolean(),
  /** Base URL that is always connectable from the local machine (loopback for wildcard binds). */
  baseUrl: z.string().nullable(),
  /** The host/interface the server is actually bound to. */
  bindHost: z.string().nullable(),
  /** The port the server is listening on. */
  port: z.number().int().min(0).max(65535).nullable(),
  /** Additional base URLs that may be reachable from other devices (LAN/VPN). */
  networkBaseUrls: z.array(z.url()),
  /** Local Tailscale interface addresses that can be selected as bind hosts. */
  tailscaleBindHosts: z.array(TailscaleBindHostSchema),
  /** Auth token required for HTTP/WS API access. */
  token: z.string().nullable(),
  /** Configured bind host from ~/.xum/config.json (if set). */
  configuredBindHost: z.string().nullable(),
  /** Configured port from ~/.xum/config.json (if set). */
  configuredPort: z.number().int().min(0).max(65535).nullable(),
  /** Whether the API server should serve the mux web UI at /. */
  configuredServeWebUi: z.boolean(),
});

export const ServerAuthSessionSchema = z.object({
  id: z.string(),
  label: z.string(),
  createdAtMs: z.number().int().nonnegative(),
  lastUsedAtMs: z.number().int().nonnegative(),
  isCurrent: z.boolean(),
});

export const server = {
  getLaunchProject: {
    input: z.void(),
    output: z.string().nullable(),
  },
  getSshHost: {
    input: z.void(),
    output: z.string().nullable(),
  },
  setSshHost: {
    input: z.object({ sshHost: z.string().nullable() }),
    output: z.void(),
  },
  getApiServerStatus: {
    input: z.void(),
    output: ApiServerStatusSchema,
  },
  setApiServerSettings: {
    input: z.object({
      bindHost: z.string().nullable(),
      port: z.number().int().min(0).max(65535).nullable(),
      serveWebUi: z.boolean().nullable().optional(),
    }),
    output: ApiServerStatusSchema,
  },
};

export const serverAuth = {
  listSessions: {
    input: z.void(),
    output: z.array(ServerAuthSessionSchema),
  },
  revokeSession: {
    input: z.object({ sessionId: z.string() }).strict(),
    output: z.object({ removed: z.boolean() }),
  },
  revokeOtherSessions: {
    input: z.void(),
    output: z.object({ revokedCount: z.number().int().nonnegative() }),
  },
};

// Config (global settings)
const ResolvedTaskSettingsSchema = TaskSettingsSchema.required({
  maxParallelAgentTasks: true,
  maxTaskNestingDepth: true,
});

const AdvisorModelStringSchema = z.string().nullable();
const AdvisorThinkingLevelSchema = ThinkingLevelSchema.nullable();
const AdvisorMaxUsesPerTurnSchema = z.number().int().positive().nullable();
const AdvisorMaxOutputTokensSchema = z.number().int().positive().nullable();
const GoalDefaultsConfigSchema = z.object({
  defaultBudgetCents: z
    .number()
    .int()
    .nonnegative()
    .default(DEFAULT_GOAL_DEFAULTS.defaultBudgetCents),
  defaultTurnCap: z
    .number()
    .int()
    .positive()
    .nullable()
    .default(DEFAULT_GOAL_DEFAULTS.defaultTurnCap),
  alwaysRequireExplicitBudget: z
    .boolean()
    .default(DEFAULT_GOAL_DEFAULTS.alwaysRequireExplicitBudget),
});

const booleanToggleRoute = {
  input: z
    .object({
      enabled: z.boolean(),
    })
    .strict(),
  output: z.void(),
};

export const config = {
  getConfig: {
    input: z.void(),
    output: z.object({
      userPreferencesInitialized: z.boolean(),
      userPreferences: UserPreferencesSchema.optional(),
      taskSettings: ResolvedTaskSettingsSchema,
      muxGatewayEnabled: z.boolean().optional(),
      muxGatewayModels: z.array(z.string()).optional(),
      routePriority: z.array(z.string()).optional(),
      routeOverrides: z.record(z.string(), z.string()).optional(),
      minThinkingLevelByModel: z.record(z.string(), ThinkingLevelSchema).optional(),
      modelFallbacks: ModelFallbacksSchema.optional(),
      defaultModel: z.string().optional(),
      advisorModelString: AdvisorModelStringSchema,
      advisorThinkingLevel: AdvisorThinkingLevelSchema,
      advisorReasoningMode: OpenAIReasoningModeSchema.nullable(),
      advisorMaxUsesPerTurn: AdvisorMaxUsesPerTurnSchema.optional(),
      advisorMaxOutputTokens: AdvisorMaxOutputTokensSchema.optional(),
      hiddenModels: z.array(z.string()).optional(),
      coderWorkspaceArchiveBehavior: z.enum(CODER_ARCHIVE_BEHAVIORS),
      worktreeArchiveBehavior: z.enum(WORKTREE_ARCHIVE_BEHAVIORS),
      runtimeEnablement: z.record(z.string(), z.boolean()),
      defaultRuntime: z.string().nullable(),
      agentAiDefaults: AgentAiDefaultsSchema,
      // Xum Governor enrollment status (safe fields only - token never exposed)
      muxGovernorUrl: z.string().nullable(),
      muxGovernorEnrolled: z.boolean(),
      chatTranscriptFullWidth: z.boolean(),
      llmDebugLogs: z.boolean(),
      heartbeatDefaultPrompt: z.string().optional(),
      heartbeatDefaultIntervalMs: z.number().optional(),
      goalDefaults: GoalDefaultsConfigSchema,
    }),
  },
  saveConfig: {
    input: z.object({
      userPreferences: UserPreferencesSchema.nullish(),
      taskSettings: ResolvedTaskSettingsSchema.nullish(),
      advisorModelString: AdvisorModelStringSchema.nullish(),
      advisorThinkingLevel: AdvisorThinkingLevelSchema.nullish(),
      advisorReasoningMode: OpenAIReasoningModeSchema.nullish(),
      advisorMaxUsesPerTurn: AdvisorMaxUsesPerTurnSchema.nullish(),
      advisorMaxOutputTokens: AdvisorMaxOutputTokensSchema.nullish(),
      agentAiDefaults: AgentAiDefaultsSchema.optional(),
    }),
    output: z.void(),
  },
  onConfigChanged: {
    input: z.void(),
    output: eventIterator(z.void()),
  },
  updateAgentAiDefaults: {
    input: z.object({
      agentAiDefaults: AgentAiDefaultsSchema,
    }),
    output: z.void(),
  },
  updateMuxGatewayPrefs: {
    input: z.object({
      muxGatewayEnabled: z.boolean(),
      muxGatewayModels: z.array(z.string()),
    }),
    output: z.void(),
  },
  updateRoutePreferences: {
    input: z.object({
      routePriority: z.array(z.string()),
      routeOverrides: z.record(z.string(), z.string()).optional(),
    }),
    output: z.void(),
  },
  updateMinThinkingLevels: {
    input: z.object({
      // Full replacement map keyed by canonical model id. Omit a model to fall back
      // to the built-in default floor (medium for reasoning-capable models).
      minThinkingLevelByModel: z.record(z.string(), ThinkingLevelSchema),
    }),
    output: z.void(),
  },
  updateModelPreferences: {
    input: z.object({
      defaultModel: z.string().optional(),
      hiddenModels: z.array(z.string()).optional(),
    }),
    output: z.void(),
  },
  updateModelFallbacks: {
    input: z.object({
      // Full-map replacement keyed by canonical source model. The backend
      // sanitizes (canonical keys, drop self/dupes, cap chain length, drop
      // empty chains) before persisting.
      modelFallbacks: ModelFallbacksSchema,
    }),
    output: z.void(),
  },
  updateCoderPrefs: {
    input: z
      .object({
        coderWorkspaceArchiveBehavior: z.enum(CODER_ARCHIVE_BEHAVIORS),
        worktreeArchiveBehavior: z.enum(WORKTREE_ARCHIVE_BEHAVIORS),
      })
      .strict(),
    output: z.void(),
  },
  updateRuntimeEnablement: {
    input: z
      .object({
        projectPath: z.string().nullish(),
        runtimeEnablement: z.record(z.string(), z.boolean()).nullish(),
        defaultRuntime: RuntimeEnablementIdSchema.nullish(),
        runtimeOverridesEnabled: z.boolean().nullish(),
      })
      .strict(),
    output: z.void(),
  },
  updateChatTranscriptFullWidth: booleanToggleRoute,
  updateLlmDebugLogs: booleanToggleRoute,
  updateHeartbeatDefaultPrompt: {
    input: z
      .object({
        defaultPrompt: z.string().nullish(),
      })
      .strict(),
    output: z.void(),
  },
  updateHeartbeatDefaultIntervalMs: {
    input: z
      .object({
        intervalMs: z
          .number()
          .int()
          .min(HEARTBEAT_MIN_INTERVAL_MS)
          .max(HEARTBEAT_MAX_INTERVAL_MS)
          .nullish(),
      })
      .strict(),
    output: z.void(),
  },
  updateGoalDefaults: {
    input: z
      .object({
        goalDefaults: GoalDefaultsConfigSchema,
      })
      .strict(),
    output: z.void(),
  },
  unenrollMuxGovernor: {
    input: z.void(),
    output: z.void(),
  },
};

const DevToolsInputTokenBreakdownSchema = z.object({
  total: z.number(),
  noCache: z.number().optional(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
});

const DevToolsOutputTokenBreakdownSchema = z.object({
  total: z.number(),
  text: z.number().optional(),
  reasoning: z.number().optional(),
});

const DevToolsUsageSchema = z.object({
  inputTokens: z.union([z.number(), DevToolsInputTokenBreakdownSchema]).optional(),
  outputTokens: z.union([z.number(), DevToolsOutputTokenBreakdownSchema]).optional(),
  totalTokens: z.number().optional(),
  raw: z.unknown().optional(),
});

const DevToolsStepInputSchema = z.object({
  prompt: z.unknown(),
  tools: z.unknown().optional(),
  toolChoice: z.unknown().optional(),
  maxOutputTokens: z.number().optional(),
  temperature: z.number().optional(),
  providerOptions: z.unknown().optional(),
});

const DevToolsStepOutputSchema = z.object({
  content: z.unknown().optional(),
  finishReason: z.string().optional(),
  textParts: z.array(z.object({ id: z.string(), text: z.string() })).optional(),
  reasoningParts: z.array(z.object({ id: z.string(), text: z.string() })).optional(),
  toolCalls: z.array(z.unknown()).optional(),
});

const DevToolsStepSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stepNumber: z.number(),
  type: z.enum(["generate", "stream"]),
  modelId: z.string(),
  provider: z.string().nullable(),
  startedAt: z.string(),
  durationMs: z.number().nullable(),
  input: DevToolsStepInputSchema.nullable(),
  output: DevToolsStepOutputSchema.nullable(),
  usage: DevToolsUsageSchema.nullable(),
  error: z.string().nullable(),
  rawRequest: z.unknown().nullable(),
  requestHeaders: z.record(z.string(), z.string()).nullable(),
  responseHeaders: z.record(z.string(), z.string()).nullable(),
  rawResponse: z.unknown().nullable(),
  rawChunks: z.unknown().nullable(),
});

const DevToolsRunSummarySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  startedAt: z.string(),
  // Tolerate malformed historical run data from devtools.jsonl without failing
  // the entire API response; invalid values are dropped at the boundary.
  toolPolicy: ToolPolicySchema.optional().catch(undefined),
  stepCount: z.number(),
  firstMessage: z.string(),
  hasError: z.boolean(),
  isInProgress: z.boolean(),
  totalDurationMs: z.number().nullable(),
  modelId: z.string().nullable(),
});

const DevToolsEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    runs: z.array(DevToolsRunSummarySchema),
  }),
  z.object({
    type: z.literal("run-created"),
    run: DevToolsRunSummarySchema,
  }),
  z.object({
    type: z.literal("run-updated"),
    run: DevToolsRunSummarySchema,
  }),
  z.object({
    type: z.literal("step-created"),
    step: DevToolsStepSchema,
  }),
  z.object({
    type: z.literal("step-updated"),
    step: DevToolsStepSchema,
  }),
  z.object({
    type: z.literal("cleared"),
  }),
]);

export const devtools = {
  getRuns: {
    input: z
      .object({
        workspaceId: z.string(),
      })
      .strict(),
    output: z.array(DevToolsRunSummarySchema),
  },
  getRunDetail: {
    input: z
      .object({
        workspaceId: z.string(),
        runId: z.string(),
      })
      .strict(),
    output: z
      .object({
        run: DevToolsRunSummarySchema,
        steps: z.array(DevToolsStepSchema),
      })
      .nullable(),
  },
  clear: {
    input: z
      .object({
        workspaceId: z.string(),
      })
      .strict(),
    output: z.object({
      success: z.boolean(),
    }),
  },
  subscribe: {
    input: z
      .object({
        workspaceId: z.string(),
      })
      .strict(),
    output: eventIterator(DevToolsEventSchema),
  },
};

const BrowserDiscoveredSessionSchema = z.object({
  sessionName: z.string(),
  status: z.enum(["attachable", "missing_stream"]),
});

const BrowserDiscoveredOtherSessionSchema = BrowserDiscoveredSessionSchema.extend({
  cwd: z.string(),
});

export const BrowserPageTabSchema = z.object({
  tabId: z.string(),
  label: z.string().nullable(),
  title: z.string(),
  url: z.string(),
  active: z.boolean(),
  type: z.enum(["page", "webview"]),
});

export type BrowserPageTab = z.infer<typeof BrowserPageTabSchema>;

const BrowserCommandResultSchema = z.object({
  success: z.boolean(),
  error: z.string().nullish(),
});

const BrowserControlActionSchema = z.enum(["open", "back", "forward", "reload"]);

export const browser = {
  listSessions: {
    input: z
      .object({
        workspaceId: z.string(),
      })
      .strict(),
    output: z.object({
      sessions: z.array(BrowserDiscoveredSessionSchema),
      otherSessions: z.array(BrowserDiscoveredOtherSessionSchema),
    }),
  },
  listTabs: {
    input: z
      .object({
        workspaceId: z.string(),
        sessionName: z.string(),
        allowOtherWorkspaceSession: z.boolean().nullish(),
      })
      .strict(),
    output: z.object({
      tabs: z.array(BrowserPageTabSchema),
      error: z.string().nullish(),
    }),
  },
  getBootstrap: {
    input: z
      .object({
        workspaceId: z.string(),
        sessionName: z.string(),
        allowOtherWorkspaceSession: z.boolean().nullish(),
      })
      .strict(),
    output: z.object({
      bridgePath: z.string(),
      token: z.string(),
      localBridgeBaseUrl: z.string().optional(),
    }),
  },
  control: {
    input: z
      .object({
        workspaceId: z.string(),
        sessionName: z.string(),
        action: BrowserControlActionSchema,
        url: z.string().nullish(),
        allowOtherWorkspaceSession: z.boolean().nullish(),
      })
      .strict(),
    output: BrowserCommandResultSchema,
  },
  selectTab: {
    input: z
      .object({
        workspaceId: z.string(),
        sessionName: z.string(),
        tabRef: z.string(),
        allowOtherWorkspaceSession: z.boolean().nullish(),
      })
      .strict(),
    output: BrowserCommandResultSchema,
  },
  getUrl: {
    input: z
      .object({
        workspaceId: z.string(),
        sessionName: z.string(),
        allowOtherWorkspaceSession: z.boolean().nullish(),
      })
      .strict(),
    output: z.object({
      url: z.string().nullable(),
      error: z.string().nullish(),
    }),
  },
};

// UI Layouts (global settings)
export const uiLayouts = {
  getAll: {
    input: z.void(),
    output: LayoutPresetsConfigSchema,
  },
  saveAll: {
    input: z
      .object({
        layoutPresets: LayoutPresetsConfigSchema,
      })
      .strict(),
    output: z.void(),
  },
};

// Splash screens
export const splashScreens = {
  getViewedSplashScreens: {
    input: z.void(),
    output: z.array(z.string()),
  },
  markSplashScreenViewed: {
    input: z.object({
      splashId: z.string(),
    }),
    output: z.void(),
  },
};

// Update
export const update = {
  check: {
    input: z.object({ source: z.enum(["auto", "manual"]).optional() }).optional(),
    output: z.void(),
  },
  download: {
    input: z.void(),
    output: z.void(),
  },
  install: {
    input: z.void(),
    output: z.void(),
  },
  onStatus: {
    input: z.void(),
    output: eventIterator(UpdateStatusSchema),
  },
  getChannel: {
    input: z.void(),
    output: UpdateChannelSchema,
  },
  setChannel: {
    input: z.object({ channel: UpdateChannelSchema }),
    output: z.void(),
  },
};

// Editor config schema for openWorkspaceInEditor
const EditorTypeSchema = z.enum(["vscode", "cursor", "zed", "custom"]);
const EditorConfigSchema = z.object({
  editor: EditorTypeSchema,
  customCommand: z.string().optional(),
});

const LogLevelSchema = z.enum(["error", "warn", "info", "debug"]);

const RestartAppResultSchema = z.discriminatedUnion("supported", [
  z.object({
    supported: z.literal(true),
  }),
  z.object({
    supported: z.literal(false),
    message: z.string(),
  }),
]);

// General
export const general = {
  listDirectory: {
    input: z.object({ path: z.string() }),
    output: ResultSchema(FileTreeNodeSchema),
  },
  /**
   * Create a directory at the specified path.
   * Creates parent directories recursively if they don't exist (like mkdir -p).
   */
  createDirectory: {
    input: z.object({ path: z.string() }),
    output: ResultSchema(z.object({ normalizedPath: z.string() }), z.string()),
  },
  ping: {
    input: z.string(),
    output: z.string(),
  },
  /**
   * Test endpoint: emits numbered ticks at an interval.
   * Useful for verifying streaming works over HTTP and WebSocket.
   */
  tick: {
    input: z.object({
      count: z.number().int().min(1).max(100),
      intervalMs: z.number().int().min(10).max(5000),
    }),
    output: eventIterator(z.object({ tick: z.number(), timestamp: z.number() })),
  },
  restartApp: {
    input: z.void(),
    output: RestartAppResultSchema,
  },
  /**
   * Open a path in the user's configured code editor.
   * For SSH workspaces with useRemoteExtension enabled, uses Remote-SSH extension.
   *
   * @param workspaceId - The workspace (used to determine if SSH and get remote host)
   * @param targetPath - The path to open (workspace directory or specific file)
   * @param editorConfig - Editor configuration from user settings
   */
  openInEditor: {
    input: z.object({
      workspaceId: z.string(),
      targetPath: z.string(),
      editorConfig: EditorConfigSchema,
    }),
    output: ResultSchema(z.void(), z.string()),
  },
  /**
   * Record that the user is opening this workspace in an external editor (built-in deep link
   * or custom command). External editors are untrackable once open, so model-driven snapshot
   * archives consult this durable record; refuses while the workspace is being archived.
   * Called by the renderer before launching editor deep links (custom-editor opens record on
   * the backend openInEditor route itself).
   */
  recordEditorOpen: {
    // launchToken is generated by the CLIENT before admission so it survives response loss:
    // if the backend commits the reservation but the connection drops before the response
    // arrives, the renderer still knows the token and can redeem rollbackEditorOpen for the
    // launch that never happened.
    input: z.object({
      workspaceId: z.string(),
      launchToken: z.string().min(1).max(128),
    }),
    output: ResultSchema(z.void(), z.string()),
  },
  /**
   * Undo a recordEditorOpen whose deep-link launch provably never happened (the renderer's
   * placeholder window was closed before navigation), so the durable editor-open marker
   * cannot permanently gate model-driven snapshot/Coder-stop archives. Idempotent.
   */
  rollbackEditorOpen: {
    input: z.object({
      workspaceId: z.string(),
      launchToken: z.string(),
    }),
    output: ResultSchema(z.void(), z.string()),
  },
  getLogPath: {
    input: z.void(),
    output: z.object({ path: z.string() }),
  },
  clearLogs: {
    input: z.void(),
    output: z.object({
      success: z.boolean(),
      error: z.string().nullish(),
    }),
  },
  subscribeLogs: {
    input: z.object({
      level: LogLevelSchema.nullish(),
    }),
    output: eventIterator(
      z.discriminatedUnion("type", [
        z.object({
          type: z.literal("snapshot"),
          epoch: z.number(),
          entries: z.array(
            z.object({
              timestamp: z.number(),
              level: LogLevelSchema,
              message: z.string(),
              location: z.string(),
            })
          ),
        }),
        z.object({
          type: z.literal("append"),
          epoch: z.number(),
          entries: z.array(
            z.object({
              timestamp: z.number(),
              level: LogLevelSchema,
              message: z.string(),
              location: z.string(),
            })
          ),
        }),
        z.object({
          type: z.literal("reset"),
          epoch: z.number(),
        }),
      ])
    ),
  },
};

// Menu events (main→renderer notifications)
export const menu = {
  onOpenSettings: {
    input: z.void(),
    output: eventIterator(z.void()),
  },
};

// Voice input (transcription via OpenAI Whisper)
export const voice = {
  transcribe: {
    input: z.object({ audioBase64: z.string() }),
    output: ResultSchema(z.string(), z.string()),
  },
};

// Debug endpoints (test-only, not for production use)
export const debug = {
  /**
   * Trigger an artificial stream error for testing recovery.
   * Used by integration tests to simulate network errors mid-stream.
   */
  triggerStreamError: {
    input: z.object({
      workspaceId: z.string(),
      errorMessage: z.string().optional(),
    }),
    output: z.boolean(), // true if error was triggered on an active stream
  },
};

const DesktopPrereqStatusSchema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
  }),
  z.object({
    available: z.literal(false),
    reason: z.enum(["unsupported_platform", "startup_failed", "binary_not_found"]),
  }),
]);

const DesktopCapabilitySchema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    width: z.number(),
    height: z.number(),
    sessionId: z.string(),
    sharedDesktop: z.object({ ownerWorkspaceId: z.string(), ownerName: z.string() }).optional(),
  }),
  z.object({
    available: z.literal(false),
    reason: z.enum([
      "disabled",
      "unsupported_platform",
      "unsupported_runtime",
      "startup_failed",
      "binary_not_found",
    ]),
  }),
]);

const DesktopWindowInputSchema = z.object({
  workspaceId: z.string().min(1),
  instanceId: z.string().min(1),
});
const DesktopWindowStateSchema = z.object({ instanceId: z.string().min(1) });

export const DesktopViewerEventSchema = z.object({
  type: z.enum(["ready", "release"]),
  viewerId: z.string().min(1),
});

export const desktop = {
  watchViewer: {
    input: z.object({ workspaceId: z.string().min(1) }),
    output: eventIterator(DesktopViewerEventSchema),
  },
  acknowledgeViewerRelease: {
    input: z.object({ viewerId: z.string().min(1) }),
    output: z.void(),
  },
  openWindow: {
    input: DesktopWindowInputSchema,
    output: DesktopWindowStateSchema,
  },
  closeWindow: {
    input: DesktopWindowInputSchema,
    output: z.void(),
  },
  getWindow: {
    input: z.object({ workspaceId: z.string().min(1) }),
    output: DesktopWindowStateSchema.nullable(),
  },
  getPrereqStatus: {
    input: z.void(),
    output: DesktopPrereqStatusSchema,
  },
  getCapability: {
    input: z.object({ workspaceId: z.string() }),
    output: DesktopCapabilitySchema,
  },
  getBootstrap: {
    input: z.object({ workspaceId: z.string() }),
    output: z.object({
      capability: DesktopCapabilitySchema,
      bridgePath: z.string().optional(),
      token: z.string().optional(),
      localBridgeBaseUrl: z.string().optional(),
    }),
  },
};

export const ssh = {
  prompt: {
    subscribe: {
      input: z.void(),
      output: eventIterator(SshPromptEventSchema),
    },
    respond: {
      input: SshPromptResponseInputSchema,
      output: ResultSchema(z.void(), z.string()),
    },
  },
};
