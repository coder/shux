import { ClaudeDesignService } from "./claudeDesignService";
import { CLAUDE_DESIGN_SERVER_NAME } from "@/common/constants/claudeDesign";
import * as fs from "fs";
import * as path from "path";
import * as jsonc from "jsonc-parser";
import writeFileAtomic from "write-file-atomic";
import { listProjectMetadataRelativePaths } from "@/common/compat/legacyMux";
import type {
  MCPConfig,
  MCPHeaderValue,
  MCPServerInfo,
  MCPServerTransport,
} from "@/common/types/mcp";
import { Ok, Err } from "@/common/types/result";
import type { Result } from "@/common/types/result";
import assert from "@/common/utils/assert";
import type { Config } from "@/node/config";
import type {
  AgentPluginsMcpContext,
  AgentPluginsMcpProvider,
} from "@/node/services/agentPlugins/mcpConfig";
import { isCanonicalPluginServerKey } from "@/node/services/agentPlugins/mcpConfig";
import { log } from "@/node/services/log";
import { projectAutomationDisabled } from "@/node/utils/projectAutomation";
import { getErrorMessage } from "@/common/utils/errors";
import type { AIService } from "@/node/services/aiService";
import type { PolicyService } from "@/node/services/policyService";
import type { TelemetryService } from "@/node/services/telemetryService";
import { createRuntimeForWorkspace, resolveWorkspaceRootPath } from "@/node/runtime/runtimeHelpers";
import { resolveAgentPluginsMcpContext } from "@/node/services/agentPlugins/mcpConfig";
import { isProjectTrusted } from "@/node/utils/projectTrust";
import { roundToBase2 } from "@/common/telemetry/utils";
import { isSecretReferenceValue } from "@/common/types/secrets";

/**
 * Canonical `plugin:<16-hex>:<server>` keys are RESERVED for Agent Plugin
 * servers: a plugin uninstall prunes workspace overrides for these keys by
 * shape, so an ordinary user-configured server occupying one would shadow
 * the plugin server (user layers win on key collision) yet lose its own
 * enablement/allowlist state during that plugin's uninstall. Reserved keys
 * found in user config are ignored at runtime — the on-disk entry is
 * preserved verbatim (loss-preserving rewrites) but never listed or started.
 */
function omitReservedPluginKeys(
  servers: Record<string, MCPServerInfo>,
  layer: "global" | "project"
): Record<string, MCPServerInfo> {
  const result: Record<string, MCPServerInfo> = {};
  for (const [name, info] of Object.entries(servers)) {
    if (isCanonicalPluginServerKey(name)) {
      log.debug(
        `[MCP] Ignoring ${layer} MCP server '${name}': the canonical plugin key namespace is reserved for Agent Plugin servers`
      );
      continue;
    }
    result[name] = info;
  }
  return result;
}

export class MCPConfigService {
  private readonly config: Config;
  readonly claudeDesign: ClaudeDesignService;
  /**
   * Agent Plugins (agent-plugins experiment): read-only extra server source
   * merged into listings. Plugin servers are never persisted — every mutation
   * below operates on the on-disk global config only, so `plugin:*` keys
   * naturally fail with "not found".
   */
  private readonly agentPluginsMcpProvider: AgentPluginsMcpProvider | null;
  private readonly policyService: Pick<
    PolicyService,
    "isEnforced" | "isMcpTransportAllowed"
  > | null;
  private readonly telemetryService: Pick<TelemetryService, "capture"> | null;
  private readonly workspaceMetadataProvider: Pick<AIService, "getWorkspaceMetadata"> | null;

  constructor(
    config: Config,
    options?: {
      agentPluginsMcpProvider?: AgentPluginsMcpProvider;
      claudeDesign?: ClaudeDesignService;
      policyService?: Pick<PolicyService, "isEnforced" | "isMcpTransportAllowed">;
      telemetryService?: Pick<TelemetryService, "capture">;
      workspaceMetadataProvider?: Pick<AIService, "getWorkspaceMetadata">;
    }
  ) {
    assert(
      typeof config.rootDir === "string" && config.rootDir.trim().length > 0,
      "MCPConfigService: config.rootDir must be a non-empty string"
    );

    this.config = config;
    this.claudeDesign =
      options?.claudeDesign ??
      new ClaudeDesignService({ rootDir: config.rootDir, isEnabled: () => false });
    this.agentPluginsMcpProvider = options?.agentPluginsMcpProvider ?? null;
    this.policyService = options?.policyService ?? null;
    this.telemetryService = options?.telemetryService ?? null;
    this.workspaceMetadataProvider = options?.workspaceMetadataProvider ?? null;
  }

  async listForApi(input: {
    projectPath?: string | null;
    workspaceId?: string | null;
  }): Promise<Record<string, MCPServerInfo>> {
    const projectPath = input.projectPath ?? undefined;
    const servers = await this.listServers(
      projectPath,
      isProjectTrusted(this.config, projectPath),
      {
        agentPlugins: await this.resolveWorkspaceAgentPluginsContext(
          input.workspaceId,
          projectPath
        ),
      }
    );
    if (this.policyService?.isEnforced() !== true) {
      return servers;
    }
    return Object.fromEntries(
      Object.entries(servers).filter(([, info]) =>
        this.policyService?.isMcpTransportAllowed(info.transport)
      )
    );
  }

  async addForApi(input: {
    name: string;
    transport?: MCPServerTransport;
    command?: string;
    url?: string;
    headers?: Record<string, MCPHeaderValue>;
  }): Promise<Result<void>> {
    const existingServer = (await this.listServers())[input.name];
    if (existingServer?.transport !== "stdio" && existingServer?.managed)
      return Err("Claude Design is managed in its settings card");
    const transport = input.transport ?? "stdio";
    if (this.transportDisabledByPolicy(transport)) {
      return Err("MCP transport is disabled by policy");
    }

    const result = await this.addServer(input.name, {
      transport,
      command: input.command,
      url: input.url,
      headers: input.headers,
    });
    if (result.success) {
      const action = !existingServer
        ? "add"
        : existingServer.transport !== "stdio" &&
            transport !== "stdio" &&
            existingServer.transport === transport &&
            existingServer.url === input.url &&
            JSON.stringify(existingServer.headers ?? {}) !== JSON.stringify(input.headers ?? {})
          ? "set_headers"
          : "edit";
      this.captureConfigChange(action, transport, input.headers);
    }
    return result;
  }

  async removeForApi(name: string): Promise<Result<void>> {
    const server = (await this.listServers())[name];
    if (server && this.transportDisabledByPolicy(server.transport)) {
      return Err("MCP transport is disabled by policy");
    }
    const result = await this.removeServer(name);
    if (result.success && server) {
      this.captureConfigChange(
        "remove",
        server.transport,
        server.transport === "stdio" ? undefined : server.headers
      );
    }
    return result;
  }

  async setEnabledForApi(name: string, enabled: boolean): Promise<Result<void>> {
    const server = (await this.listServers())[name];
    if (server && this.transportDisabledByPolicy(server.transport)) {
      return Err("MCP transport is disabled by policy");
    }
    const result = await this.setServerEnabled(name, enabled);
    if (result.success && server) {
      this.captureConfigChange(
        enabled ? "enable" : "disable",
        server.transport,
        server.transport === "stdio" ? undefined : server.headers
      );
    }
    return result;
  }

  async setToolAllowlistForApi(name: string, toolAllowlist: string[]): Promise<Result<void>> {
    const server = (await this.listServers())[name];
    if (server && this.transportDisabledByPolicy(server.transport)) {
      return Err("MCP transport is disabled by policy");
    }
    const result = await this.setToolAllowlist(name, toolAllowlist);
    if (result.success && server) {
      this.captureConfigChange(
        "set_tool_allowlist",
        server.transport,
        server.transport === "stdio" ? undefined : server.headers,
        {
          tool_allowlist_size_b2: roundToBase2(toolAllowlist.length),
        }
      );
    }
    return result;
  }

  /** Preserves the resolver's null sentinel: null suppresses plugin discovery for off-host workspaces. */
  async resolveWorkspaceAgentPluginsContext(
    workspaceId: string | null | undefined,
    projectPath: string | null | undefined
  ): Promise<AgentPluginsMcpContext | null | undefined> {
    const trimmed = workspaceId?.trim();
    if (!trimmed || !this.workspaceMetadataProvider) {
      return undefined;
    }
    try {
      const metadataResult = await this.workspaceMetadataProvider.getWorkspaceMetadata(trimmed);
      if (!metadataResult.success) {
        return undefined;
      }
      const metadata = metadataResult.data;
      if (metadata.projectPath !== projectPath?.trim()) {
        log.debug("Ignoring Agent Plugins workspace context for mismatched project", {
          workspaceId: trimmed,
          requestedProjectPath: projectPath,
          workspaceProjectPath: metadata.projectPath,
        });
        return undefined;
      }
      const runtime = createRuntimeForWorkspace(metadata);
      return resolveAgentPluginsMcpContext(metadata, resolveWorkspaceRootPath(metadata, runtime));
    } catch (error) {
      log.debug("Failed to resolve Agent Plugins MCP context for workspace", {
        workspaceId: trimmed,
        error,
      });
      return undefined;
    }
  }

  private transportDisabledByPolicy(transport: MCPServerTransport | "auto"): boolean {
    return (
      this.policyService?.isEnforced() === true &&
      !this.policyService.isMcpTransportAllowed(transport)
    );
  }

  private captureConfigChange(
    action: "add" | "edit" | "set_headers" | "remove" | "enable" | "disable" | "set_tool_allowlist",
    transport: MCPServerTransport,
    headers?: Record<string, MCPHeaderValue>,
    extra: Record<string, number> = {}
  ): void {
    this.telemetryService?.capture({
      event: "mcp_server_config_changed",
      properties: {
        action,
        transport,
        has_headers: Boolean(headers && Object.keys(headers).length > 0),
        uses_secret_headers: Boolean(
          headers && Object.values(headers).some((value) => isSecretReferenceValue(value))
        ),
        ...extra,
      },
    });
  }

  private getGlobalConfigPath(): string {
    return path.join(this.config.rootDir, "mcp.jsonc");
  }

  private getRepoOverridePaths(projectPath: string): string[] {
    return listProjectMetadataRelativePaths("mcp.jsonc").map((relativePath) =>
      path.join(projectPath, relativePath)
    );
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.promises.access(targetPath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureMuxRootDir(): Promise<void> {
    if (!(await this.pathExists(this.config.rootDir))) {
      await fs.promises.mkdir(this.config.rootDir, { recursive: true });
    }
  }

  /**
   * Normalize a raw config entry into a strongly-typed server definition.
   *
   * Supported raw formats:
   * - string: stdio command
   * - object w/ command: stdio
   * - object w/ url: http/sse/auto (defaults to auto)
   */
  private normalizeEntry(entry: unknown): MCPServerInfo {
    if (typeof entry === "string") {
      return { transport: "stdio", command: entry, disabled: false };
    }

    if (!entry || typeof entry !== "object") {
      // Fail closed for invalid shapes.
      return { transport: "stdio", command: "", disabled: true };
    }

    const obj = entry as Record<string, unknown>;
    const disabled = typeof obj.disabled === "boolean" ? obj.disabled : false;
    const toolAllowlist = Array.isArray(obj.toolAllowlist)
      ? obj.toolAllowlist.filter((v): v is string => typeof v === "string")
      : undefined;

    const transport =
      obj.transport === "stdio" ||
      obj.transport === "http" ||
      obj.transport === "sse" ||
      obj.transport === "auto"
        ? obj.transport
        : undefined;

    const command = typeof obj.command === "string" ? obj.command : undefined;
    const url = typeof obj.url === "string" ? obj.url : undefined;

    const headersRaw = obj.headers;
    let headers: Record<string, string | { secret: string }> | undefined;

    if (headersRaw && typeof headersRaw === "object" && !Array.isArray(headersRaw)) {
      const next: Record<string, string | { secret: string }> = {};
      for (const [k, v] of Object.entries(headersRaw as Record<string, unknown>)) {
        if (typeof v === "string") {
          next[k] = v;
          continue;
        }
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const secret = (v as Record<string, unknown>).secret;
          if (typeof secret === "string") {
            next[k] = { secret };
          }
        }
      }
      if (Object.keys(next).length > 0) {
        headers = next;
      }
    }

    // If it has a url, prefer HTTP-based transports (default to auto).
    if (url) {
      const httpTransport = transport && transport !== "stdio" ? transport : "auto";
      return {
        transport: httpTransport,
        url,
        headers,
        disabled,
        toolAllowlist,
      };
    }

    // Otherwise, treat it as stdio.
    return {
      transport: "stdio",
      command: command ?? "",
      disabled,
      toolAllowlist,
    };
  }

  private async readConfigFile(filePath: string): Promise<MCPConfig> {
    try {
      const exists = await this.pathExists(filePath);
      if (!exists) {
        return { servers: {} };
      }

      const raw = await fs.promises.readFile(filePath, "utf-8");
      const parsed = jsonc.parse(raw) as { servers?: Record<string, unknown> } | undefined;

      if (!parsed || typeof parsed !== "object" || !parsed.servers) {
        return { servers: {} };
      }

      // Normalize all entries on read
      const servers: Record<string, MCPServerInfo> = {};
      for (const [name, entry] of Object.entries(parsed.servers)) {
        servers[name] = this.normalizeEntry(entry);
      }
      return { servers };
    } catch (error) {
      // Defensive: never crash on startup due to corrupt config.
      log.error("Failed to read MCP config", { filePath, error });
      return { servers: {} };
    }
  }

  private async getGlobalConfig(): Promise<MCPConfig> {
    return this.readConfigFile(this.getGlobalConfigPath());
  }

  private async getRepoOverrideConfig(projectPath: string): Promise<MCPConfig> {
    for (const filePath of this.getRepoOverridePaths(projectPath)) {
      if (await this.pathExists(filePath)) return this.readConfigFile(filePath);
    }
    return { servers: {} };
  }

  private async saveGlobalConfig(config: MCPConfig): Promise<void> {
    await this.ensureMuxRootDir();

    const filePath = this.getGlobalConfigPath();

    // Write minimal format:
    // - string for stdio servers without extra settings
    // - object when:
    //   - disabled/toolAllowlist set, or
    //   - non-stdio transport, or
    //   - headers present
    //
    // toolAllowlist: undefined = all tools (omit), [] = no tools, [...] = those tools
    const output: Record<string, unknown> = {};

    for (const [name, entry] of Object.entries(config.servers)) {
      const hasSettings = entry.disabled || entry.toolAllowlist !== undefined;

      if (entry.transport === "stdio") {
        if (!hasSettings) {
          output[name] = entry.command;
          continue;
        }

        const obj: Record<string, unknown> = {
          command: entry.command,
        };
        if (entry.disabled) obj.disabled = true;
        if (entry.toolAllowlist !== undefined) obj.toolAllowlist = entry.toolAllowlist;
        output[name] = obj;
        continue;
      }

      const obj: Record<string, unknown> = {
        transport: entry.transport,
        url: entry.url,
      };
      if (entry.headers) obj.headers = entry.headers;
      if (entry.disabled) obj.disabled = true;
      if (entry.toolAllowlist !== undefined) obj.toolAllowlist = entry.toolAllowlist;

      output[name] = obj;
    }

    await writeFileAtomic(filePath, JSON.stringify({ servers: output }, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    this.globalConfigGeneration += 1;
  }

  /**
   * Incremented after successful global config writes. Prompt paths compare it
   * across refreshes because global mutations do not replace workspace options.
   */
  private globalConfigGeneration = 0;

  get configGeneration(): number {
    return this.globalConfigGeneration + this.claudeDesign.generation;
  }

  /**
   * List configured servers.
   *
   * - When no projectPath is provided: returns global servers from <xumHome>/mcp.jsonc
   * - When projectPath is provided and trusted=false: returns only global servers
   * - When projectPath is provided and trusted=true: merges global + <projectPath>/.xum/mcp.jsonc
   * - Agent Plugins servers (when the experiment provider is wired) are merged
   *   at the lowest precedence: user config always wins on key collisions.
   *
   * `options.agentPlugins` controls plugin discovery: `null` disables it for
   * this call (workspace executes off-host: SSH/devcontainer), an explicit
   * context scans that host checkout, and omitting it defaults to scanning
   * under `projectPath` (project-level flows: Settings, workspace MCP modal).
   */
  async listServers(
    projectPath?: string,
    trusted = false,
    options?: { agentPlugins?: AgentPluginsMcpContext | null }
  ): Promise<Record<string, MCPServerInfo>> {
    const layers = await this.listServerLayers(projectPath, trusted, options);
    // Repo overrides win by server name over global config, which wins over plugin servers.
    const servers = { ...layers.plugin, ...layers.global, ...layers.project };
    const design = await this.claudeDesign.serverInfo();
    // Never replace an existing user/plugin server or lend it credentials.
    if (design && !Object.hasOwn(servers, CLAUDE_DESIGN_SERVER_NAME))
      servers[CLAUDE_DESIGN_SERVER_NAME] = design;
    return servers;
  }

  /**
   * List configured servers split by config layer (plugin < global < project,
   * later layers win on key collision). Used by listServers and by the plugin
   * composition inspector, which needs shadowed entries too.
   */
  async listServerLayers(
    projectPath?: string,
    trusted = false,
    options?: { agentPlugins?: AgentPluginsMcpContext | null }
  ): Promise<{
    plugin: Record<string, MCPServerInfo>;
    global: Record<string, MCPServerInfo>;
    project: Record<string, MCPServerInfo>;
  }> {
    let pluginServers: Record<string, MCPServerInfo> = {};
    if (this.agentPluginsMcpProvider && options?.agentPlugins !== null) {
      const pluginContext = options?.agentPlugins ?? {
        projectRoot: projectPath,
        projectKey: projectPath,
      };
      try {
        pluginServers = await this.agentPluginsMcpProvider({ ...pluginContext, trusted });
      } catch (error) {
        // Plugin discovery failures must never break MCP config listing.
        log.warn("[MCP] Agent Plugins server discovery failed", { error });
      }
    }

    const globalCfg = await this.getGlobalConfig();
    const globalServers = omitReservedPluginKeys(globalCfg.servers, "global");

    // projectAutomationDisabled: benchmark harness kill-switch: dataset
    // repos keep config trust for delegation, but repo-configured MCP
    // servers must not start with provider credentials in the environment.
    const projectConfigAllowed = trusted && !projectAutomationDisabled();
    if (!projectPath || !projectConfigAllowed) {
      if (projectPath && !trusted) {
        log.debug("[MCP] Skipping project-local MCP config for untrusted project", { projectPath });
      } else if (projectPath) {
        log.debug("[MCP] Skipping project-local MCP config (project automation disabled)", {
          projectPath,
        });
      }
      return { plugin: pluginServers, global: globalServers, project: {} };
    }

    const repoCfg = await this.getRepoOverrideConfig(projectPath);
    return {
      plugin: pluginServers,
      global: globalServers,
      project: omitReservedPluginKeys(repoCfg.servers, "project"),
    };
  }

  async addServer(
    name: string,
    input: {
      transport?: MCPServerTransport;
      command?: string;
      url?: string;
      headers?: Record<string, MCPHeaderValue>;
    }
  ): Promise<Result<void>> {
    if (!name.trim()) {
      return Err("Server name is required");
    }
    if (isCanonicalPluginServerKey(name.trim())) {
      // See omitReservedPluginKeys: a user server on a canonical plugin key
      // would be stripped of its workspace overrides by that plugin's
      // uninstall.
      return Err("Server names of the form 'plugin:<id>:<name>' are reserved for Agent Plugins");
    }

    const transport: MCPServerTransport = input.transport ?? "stdio";

    if (transport === "stdio") {
      if (!input.command?.trim()) {
        return Err("Command is required");
      }
    } else {
      if (!input.url?.trim()) {
        return Err("URL is required");
      }
    }

    const cfg = await this.getGlobalConfig();
    const existing = cfg.servers[name];

    const base = {
      disabled: existing?.disabled ?? false,
      toolAllowlist: existing?.toolAllowlist,
    };

    const next: MCPServerInfo =
      transport === "stdio"
        ? {
            transport: "stdio",
            command: input.command!,
            ...base,
          }
        : {
            transport,
            url: input.url!,
            headers: input.headers,
            ...base,
          };

    cfg.servers[name] = next;

    try {
      await this.saveGlobalConfig(cfg);
      return Ok(undefined);
    } catch (error) {
      log.error("Failed to save MCP server", { name, error });
      return Err(getErrorMessage(error));
    }
  }

  async setServerEnabled(name: string, enabled: boolean): Promise<Result<void>> {
    const managed = (await this.listServers())[name];
    if (managed?.transport !== "stdio" && managed?.managed === "claude-design") {
      try {
        await this.claudeDesign.configure({ serverEnabled: enabled });
        return Ok(undefined);
      } catch (error) {
        return Err(getErrorMessage(error));
      }
    }
    const cfg = await this.getGlobalConfig();
    const entry = cfg.servers[name];
    if (!entry) {
      return Err(`Server ${name} not found`);
    }
    cfg.servers[name] = { ...entry, disabled: !enabled };
    try {
      await this.saveGlobalConfig(cfg);
      return Ok(undefined);
    } catch (error) {
      log.error("Failed to update MCP server enabled state", { name, error });
      return Err(getErrorMessage(error));
    }
  }

  async removeServer(name: string): Promise<Result<void>> {
    const cfg = await this.getGlobalConfig();
    if (!cfg.servers[name]) {
      return Err(`Server ${name} not found`);
    }
    delete cfg.servers[name];
    try {
      await this.saveGlobalConfig(cfg);
      return Ok(undefined);
    } catch (error) {
      log.error("Failed to remove MCP server", { name, error });
      return Err(getErrorMessage(error));
    }
  }

  async setToolAllowlist(name: string, toolAllowlist: string[]): Promise<Result<void>> {
    const managed = (await this.listServers())[name];
    if (managed?.transport !== "stdio" && managed?.managed === "claude-design") {
      try {
        await this.claudeDesign.configure({ toolAllowlist });
        return Ok(undefined);
      } catch (error) {
        return Err(getErrorMessage(error));
      }
    }
    const cfg = await this.getGlobalConfig();
    const entry = cfg.servers[name];
    if (!entry) {
      return Err(`Server ${name} not found`);
    }

    // [] = no tools allowed, [...tools] = those tools allowed
    cfg.servers[name] = {
      ...entry,
      toolAllowlist,
    };

    try {
      await this.saveGlobalConfig(cfg);
      return Ok(undefined);
    } catch (error) {
      log.error("Failed to update MCP server tool allowlist", { name, error });
      return Err(getErrorMessage(error));
    }
  }
}
