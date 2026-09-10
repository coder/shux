/**
 * Service for interacting with the Coder CLI.
 * Used to create/manage Coder workspaces as SSH targets for Xum workspaces.
 */
import { ensureMuxCoderSSHConfigFile } from "@/node/runtime/muxSshConfigWriter";
import { execAsync, execFileAsync } from "@/node/utils/disposableExec";
import { getBashPath } from "@/node/utils/main/bashPath";
import { toWindowsPath } from "@/node/utils/paths";
import { log } from "@/node/services/log";
import { spawn, type ChildProcess } from "child_process";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import {
  CoderWorkspaceStatusSchema,
  type CoderInfo,
  type CoderListPresetsResult,
  type CoderListTemplatesResult,
  type CoderListWorkspacesResult,
  type CoderWorkspaceStatus,
} from "@/common/orpc/schemas/coder";
import { getErrorMessage } from "@/common/utils/errors";

export interface CoderApiSession {
  token: string;
  dispose: () => Promise<void>;
}

interface CoderWhoamiData {
  url: string;
  username?: string;
  id?: string;
}

/** Discriminated union for workspace status check results */
export type WorkspaceStatusResult =
  | { kind: "ok"; status: CoderWorkspaceStatus }
  | { kind: "not_found" }
  | { kind: "error"; error: string };

/**
 * Serialize a Coder parameter default_value to string.
 * Preserves numeric/boolean/array values instead of coercing to "".
 */
function serializeParameterDefault(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Arrays/objects (e.g., list(string) type) → JSON
  return JSON.stringify(value);
}

// Minimum supported Coder CLI version
const MIN_CODER_VERSION = "2.25.0";

/**
 * Normalize a version string for comparison.
 * Strips leading "v", dev suffixes like "-devel+hash", and build metadata.
 * Example: "v2.28.6+df47153" → "2.28.6"
 */
function normalizeVersion(v: string): string {
  return v
    .replace(/^v/i, "") // Strip leading v/V
    .split("-")[0] // Remove pre-release suffix
    .split("+")[0]; // Remove build metadata
}

/**
 * Compare two semver versions. Returns:
 * - negative if a < b
 * - 0 if a === b
 * - positive if a > b
 */
export function compareVersions(a: string, b: string): number {
  const aParts = normalizeVersion(a).split(".").map(Number);
  const bParts = normalizeVersion(b).split(".").map(Number);

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aPart = aParts[i] ?? 0;
    const bPart = bParts[i] ?? 0;
    if (aPart !== bPart) return aPart - bPart;
  }
  return 0;
}

const SIGKILL_GRACE_PERIOD_MS = 5000;

function createGracefulTerminator(
  child: ChildProcess,
  options?: { sigkillAfterMs?: number }
): {
  terminate: () => void;
  cleanup: () => void;
} {
  const sigkillAfterMs = options?.sigkillAfterMs ?? SIGKILL_GRACE_PERIOD_MS;
  let sigkillTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleSigkill = () => {
    if (sigkillTimer) return;
    sigkillTimer = setTimeout(() => {
      sigkillTimer = null;
      // Only attempt SIGKILL if the process still appears to be running.
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }, sigkillAfterMs);
  };

  const terminate = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    scheduleSigkill();
  };

  const cleanup = () => {
    if (sigkillTimer) {
      clearTimeout(sigkillTimer);
      sigkillTimer = null;
    }
  };

  return { terminate, cleanup };
}

/**
 * Stream output from a coder CLI command line by line.
 * Yields lines as they arrive from stdout/stderr.
 * Throws on non-zero exit with stderr content in the error message.
 *
 * @param args Command arguments (e.g., ["start", "-y", "my-ws"])
 * @param errorPrefix Prefix for error messages (e.g., "coder start failed")
 * @param abortSignal Optional signal to cancel the command
 * @param abortMessage Message to throw when aborted
 */
async function* streamCoderCommand(
  args: string[],
  errorPrefix: string,
  abortSignal?: AbortSignal,
  abortMessage = "Coder command aborted"
): AsyncGenerator<string, void, unknown> {
  if (abortSignal?.aborted) {
    throw new Error(abortMessage);
  }

  // Yield the command we're about to run so it's visible in UI
  yield `$ coder ${args.join(" ")}`;

  const child = spawn("coder", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const exitPromise = new Promise<number | null>((resolve) => {
    child.on("close", resolve);
    child.on("error", () => resolve(null));
  });

  const terminator = createGracefulTerminator(child);

  const abortHandler = () => {
    terminator.terminate();
  };
  abortSignal?.addEventListener("abort", abortHandler, { once: true });
  if (abortSignal?.aborted) {
    abortHandler();
  }

  try {
    // Use an async queue to stream lines as they arrive
    const lineQueue: string[] = [];
    const stderrLines: string[] = [];
    let streamsDone = false;
    let resolveNext: (() => void) | null = null;

    const pushLine = (line: string) => {
      lineQueue.push(line);
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    };

    let pending = 2;
    const markDone = () => {
      pending--;
      if (pending === 0) {
        streamsDone = true;
        if (resolveNext) {
          resolveNext();
          resolveNext = null;
        }
      }
    };

    const processStream = (stream: NodeJS.ReadableStream | null, isStderr: boolean) => {
      if (!stream) {
        markDone();
        return;
      }
      let buffer = "";
      stream.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const line of parts) {
          const trimmed = line.trim();
          if (trimmed) {
            pushLine(trimmed);
            if (isStderr) stderrLines.push(trimmed);
          }
        }
      });
      stream.on("end", () => {
        if (buffer.trim()) {
          pushLine(buffer.trim());
          if (isStderr) stderrLines.push(buffer.trim());
        }
        markDone();
      });
      stream.on("error", markDone);
    };

    processStream(child.stdout, false);
    processStream(child.stderr, true);

    // Yield lines as they arrive
    while (!streamsDone || lineQueue.length > 0) {
      if (lineQueue.length > 0) {
        yield lineQueue.shift()!;
      } else if (!streamsDone) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
    }

    // Wait for process to exit; listener is attached before stream draining to avoid missing close.
    const exitCode = await exitPromise;

    if (abortSignal?.aborted) {
      throw new Error(abortMessage);
    }

    if (exitCode !== 0) {
      const errorDetail = stderrLines.length > 0 ? `: ${stderrLines.join(" | ")}` : "";
      throw new Error(`${errorPrefix} (exit ${String(exitCode)})${errorDetail}`);
    }
  } finally {
    terminator.cleanup();
    abortSignal?.removeEventListener("abort", abortHandler);
  }
}

interface CoderCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: "timeout" | "aborted";
}

type InterpretedCoderCommandResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; error: string; combined: string };

function interpretCoderResult(result: CoderCommandResult): InterpretedCoderCommandResult {
  const combined = `${result.stderr}\n${result.stdout}`.trim();

  if (result.error) {
    return { ok: false, error: result.error, combined };
  }

  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: combined || `Exit code ${String(result.exitCode)}`,
      combined,
    };
  }

  return { ok: true, stdout: result.stdout, stderr: result.stderr };
}

function sanitizeCoderCliErrorForUi(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Unknown error";
  }

  const err = error as Partial<{ stderr: string; message: string }>;
  const raw = (err.stderr?.trim() ? err.stderr : err.message) ?? "";

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return "Unknown error";
  }

  // Coder often prints a generic "Encountered an error running..." line followed by
  // a more actionable "error: ..." line. Prefer the latter when present.
  const preferred =
    [...lines].reverse().find((line) => /^error:\s*/i.test(line)) ?? lines[lines.length - 1];

  return (
    preferred
      .replace(/^error:\s*/i, "")
      .slice(0, 200)
      .trim() || "Unknown error"
  );
}

export class CoderService {
  // Ephemeral API sessions scoped to workspace provisioning.
  // This keeps token reuse explicit without persisting anything to disk.
  private provisioningSessionPromises = new Map<string, Promise<CoderApiSession>>();
  private provisioningSessions = new Map<string, CoderApiSession>();
  private cachedInfo: CoderInfo | null = null;
  // Cache whoami results so later URL lookups can reuse the last CLI response.
  private cachedWhoami: CoderWhoamiData | null = null;

  private async resolveCoderBinaryPath(): Promise<string | null> {
    if (process.platform === "win32") {
      // Prefer native Windows lookup — returns paths cmd.exe can execute directly.
      try {
        using proc = execAsync("where.exe coder");
        const { stdout } = await proc.result;
        const firstLine = stdout.split(/\r?\n/)[0]?.trim();
        if (firstLine) return firstLine;
      } catch {
        // where.exe may not find coder; fall through to Git Bash lookup.
      }

      // Fallback: Git Bash lookup. Normalize MSYS paths (/c/...) to Windows (C:\...).
      let shell: string | undefined;
      try {
        shell = getBashPath();
      } catch {
        return null;
      }

      try {
        using proc = execAsync("command -v coder", { shell });
        const { stdout } = await proc.result;
        const firstLine = stdout.split(/\r?\n/)[0]?.trim();
        // Convert MSYS path format to native Windows path for cmd.exe compatibility.
        // SSH ProxyCommand runs through cmd.exe, not Git Bash.
        return firstLine ? toWindowsPath(firstLine) : null;
      } catch {
        return null;
      }
    }

    // POSIX: command -v is universally available
    try {
      using proc = execAsync("command -v coder");
      const { stdout } = await proc.result;
      const firstLine = stdout.split(/\r?\n/)[0]?.trim();
      return firstLine || null;
    } catch {
      return null;
    }
  }

  /**
   * Get Coder CLI info. Caches result for the session.
   * Returns discriminated union: available | outdated | unavailable.
   */
  async getCoderInfo(): Promise<CoderInfo> {
    if (this.cachedInfo) {
      return this.cachedInfo;
    }

    // Resolve the Coder binary path for better error messages (helps when multiple binaries are on PATH).
    const binaryPath = await this.resolveCoderBinaryPath();

    try {
      const stdout = await this.runCoderJsonCommand(["version", "--output=json"], {
        timeoutMs: 10_000,
      });

      // Parse JSON output
      const data = JSON.parse(stdout) as { version?: string };
      const version = data.version;

      if (!version) {
        this.cachedInfo = {
          state: "unavailable",
          reason: { kind: "error", message: "Version output missing from CLI" },
        };
        return this.cachedInfo;
      }

      // Check minimum version
      if (compareVersions(version, MIN_CODER_VERSION) < 0) {
        log.debug(`Coder CLI version ${version} is below minimum ${MIN_CODER_VERSION}`);
        this.cachedInfo = {
          state: "outdated",
          version,
          minVersion: MIN_CODER_VERSION,
          ...(binaryPath ? { binaryPath } : {}),
        };
        return this.cachedInfo;
      }

      let whoami: CoderWhoamiData | null = null;
      try {
        whoami = await this.getWhoamiData();
      } catch (error) {
        // Treat whoami failures as a blocking issue for the Coder runtime.
        // If the CLI isn't logged in, users will hit confusing failures later during provisioning.
        const err = error as Partial<{ stderr: string; message: string }>;
        const raw = (err.stderr?.trim() ? err.stderr : err.message) ?? "";
        const normalized = raw.toLowerCase();

        const isNotLoggedIn =
          normalized.includes("not logged in") ||
          normalized.includes("try logging in") ||
          normalized.includes("please login") ||
          normalized.includes("coder login");

        const lastLine =
          raw
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .at(-1) ?? "";

        const sanitizedLine =
          lastLine
            .replace(/^error:\s*/i, "")
            .slice(0, 200)
            .trim() || "Unknown error";

        const notLoggedInMessage = binaryPath
          ? `${binaryPath} is ${sanitizedLine.replace(/^you are\s+/i, "")}`
          : sanitizedLine;

        log.debug("Failed to fetch Coder whoami data", { error });

        const result: CoderInfo = isNotLoggedIn
          ? { state: "unavailable", reason: { kind: "not-logged-in", message: notLoggedInMessage } }
          : { state: "unavailable", reason: { kind: "error", message: sanitizedLine } };

        // Don't cache whoami failures: users can often recover without restarting the app
        // (e.g., temporary network issues or `coder login`).
        return result;
      }

      const availableInfo: CoderInfo = {
        state: "available",
        version,
        ...(whoami?.username ? { username: whoami.username } : {}),
        ...(whoami?.url ? { url: whoami.url } : {}),
      };

      this.cachedInfo = availableInfo;
      return this.cachedInfo;
    } catch (error) {
      log.debug("Coder CLI not available", { error });
      this.cachedInfo = this.classifyCoderError(error);
      return this.cachedInfo;
    }
  }

  /**
   * Classify an error from the Coder CLI as missing or error with message.
   */
  private classifyCoderError(error: unknown): CoderInfo {
    // ENOENT or "command not found" = CLI not installed
    if (error instanceof Error) {
      const code = (error as NodeJS.ErrnoException).code;
      const message = error.message.toLowerCase();
      if (
        code === "ENOENT" ||
        message.includes("command not found") ||
        message.includes("enoent")
      ) {
        return { state: "unavailable", reason: "missing" };
      }
      // Other errors: include sanitized message (single line, capped length)
      const sanitized = sanitizeCoderCliErrorForUi(error);
      return {
        state: "unavailable",
        reason: { kind: "error", message: sanitized },
      };
    }
    return { state: "unavailable", reason: { kind: "error", message: "Unknown error" } };
  }

  /**
   * Create a short-lived Coder API token for deployment endpoints.
   */
  private async createApiSession(tokenName: string): Promise<CoderApiSession> {
    using tokenProc = execFileAsync(
      "coder",
      ["tokens", "create", "--lifetime", "5m", "--name", tokenName],
      { timeoutMs: 30_000 }
    );
    const { stdout: token } = await tokenProc.result;
    const trimmed = token.trim();

    return {
      token: trimmed,
      dispose: async () => {
        try {
          using deleteProc = execFileAsync("coder", ["tokens", "delete", tokenName], {
            timeoutMs: 30_000,
          });
          await deleteProc.result;
        } catch {
          // Best-effort cleanup; token will expire in 5 minutes anyway.
          log.debug("Failed to delete temporary Coder API token", { tokenName });
        }
      },
    };
  }

  private async withApiSession<T>(
    tokenName: string,
    fn: (session: CoderApiSession) => Promise<T>
  ): Promise<T> {
    const session = await this.createApiSession(tokenName);
    try {
      return await fn(session);
    } finally {
      await session.dispose();
    }
  }

  async ensureProvisioningSession(workspaceName: string): Promise<CoderApiSession> {
    const existing = this.provisioningSessions.get(workspaceName);
    if (existing) {
      return existing;
    }

    const pending = this.provisioningSessionPromises.get(workspaceName);
    if (pending) {
      return pending;
    }

    const tokenName = `mux-${workspaceName}-${Date.now().toString(36)}`;
    const sessionPromise = this.createApiSession(tokenName)
      .then((session) => {
        this.provisioningSessions.set(workspaceName, session);
        this.provisioningSessionPromises.delete(workspaceName);
        return session;
      })
      .catch((error: unknown) => {
        this.provisioningSessionPromises.delete(workspaceName);
        throw error;
      });
    this.provisioningSessionPromises.set(workspaceName, sessionPromise);
    return sessionPromise;
  }

  takeProvisioningSession(workspaceName: string): CoderApiSession | undefined {
    const session = this.provisioningSessions.get(workspaceName);
    if (session) {
      this.provisioningSessions.delete(workspaceName);
    }
    return session;
  }

  async disposeProvisioningSession(workspaceName: string): Promise<void> {
    const session = this.provisioningSessions.get(workspaceName);
    if (!session) {
      return;
    }
    this.provisioningSessions.delete(workspaceName);
    await session.dispose();
  }

  /**
   * Verify the current Coder CLI session is authenticated.
   * Forces a fresh whoami check instead of using cached data.
   */
  async verifyAuthenticatedSession(): Promise<void> {
    await this.getWhoamiData({ useCache: false });
  }

  /**
   * Clear cached Coder info. Used for testing.
   */
  clearCache(): void {
    this.cachedInfo = null;
    this.cachedWhoami = null;
  }

  // Preserve the old behavior: explicit whoami checks should hit the CLI even if cached.
  // The cache only exists so later URL lookups can reuse the last whoami response.
  private async getWhoamiData(options?: {
    useCache?: boolean;
    signal?: AbortSignal;
  }): Promise<CoderWhoamiData> {
    if (options?.useCache && this.cachedWhoami) {
      return this.cachedWhoami;
    }

    const stdout = await this.runCoderJsonCommand(["whoami", "--output=json"], {
      timeoutMs: 10_000,
      signal: options?.signal,
    });

    const data = JSON.parse(stdout) as Array<Partial<CoderWhoamiData>>;
    if (!data[0]?.url) {
      throw new Error("Could not determine Coder deployment URL from `coder whoami`");
    }

    this.cachedWhoami = {
      url: data[0].url,
      username: data[0].username,
      id: data[0].id,
    };

    return this.cachedWhoami;
  }

  /**
   * Get the Coder deployment URL via `coder whoami`.
   * Throws if Coder CLI is not configured/logged in.
   */
  private async getDeploymentUrl(signal?: AbortSignal): Promise<string> {
    const { url } = await this.getWhoamiData({ useCache: true, signal });
    return url;
  }

  /**
   * Get the active template version ID for a template.
   * Throws if template not found.
   */
  private async getActiveTemplateVersionId(
    templateName: string,
    org?: string,
    signal?: AbortSignal
  ): Promise<string> {
    // Note: `coder templates list` doesn't support --org flag, so we filter client-side
    const stdout = await this.runCoderJsonCommand(["templates", "list", "--output=json"], {
      signal,
    });

    if (!stdout.trim()) {
      throw new Error(`Template "${templateName}" not found (no templates exist)`);
    }

    const raw = JSON.parse(stdout) as Array<{
      Template: {
        name: string;
        organization_name: string;
        active_version_id: string;
      };
    }>;

    // Filter by name and optionally by org for disambiguation
    const template = raw.find(
      (t) => t.Template.name === templateName && (!org || t.Template.organization_name === org)
    );
    if (!template) {
      const orgSuffix = org ? ` in organization "${org}"` : "";
      throw new Error(`Template "${templateName}" not found${orgSuffix}`);
    }

    return template.Template.active_version_id;
  }

  /**
   * Get parameter names covered by a preset.
   * Returns empty set if preset not found (allows creation to proceed without preset params).
   */
  private async getPresetParamNames(
    templateName: string,
    presetName: string,
    org?: string,
    signal?: AbortSignal
  ): Promise<Set<string>> {
    try {
      const args = ["templates", "presets", "list", templateName, "--output=json"];
      if (org) args.push("--org", org);
      const stdout = await this.runCoderJsonCommand(args, { signal });

      // Same non-JSON guard as listPresets (CLI prints info message for no presets)
      if (!stdout.trim() || !stdout.trimStart().startsWith("[")) {
        return new Set();
      }

      const raw = JSON.parse(stdout) as Array<{
        TemplatePreset: {
          Name: string;
          Parameters?: Array<{ Name: string }>;
        };
      }>;

      const preset = raw.find((p) => p.TemplatePreset.Name === presetName);
      if (!preset?.TemplatePreset.Parameters) {
        return new Set();
      }

      return new Set(preset.TemplatePreset.Parameters.map((p) => p.Name));
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      log.debug("Failed to get preset param names", { templateName, presetName, error });
      return new Set();
    }
  }

  /**
   * Parse rich parameter data from the Coder API.
   * Filters out entries with missing/invalid names to avoid generating invalid --parameter flags.
   */
  private parseRichParameters(data: unknown): Array<{
    name: string;
    defaultValue: string;
    type: string;
    ephemeral: boolean;
    required: boolean;
  }> {
    if (!Array.isArray(data)) {
      throw new Error("Expected array of rich parameters");
    }
    return data
      .filter((p): p is Record<string, unknown> => {
        if (p === null || typeof p !== "object") return false;
        const obj = p as Record<string, unknown>;
        return typeof obj.name === "string" && obj.name !== "";
      })
      .map((p) => ({
        name: p.name as string,
        defaultValue: serializeParameterDefault(p.default_value),
        type: typeof p.type === "string" ? p.type : "string",
        ephemeral: Boolean(p.ephemeral),
        required: Boolean(p.required),
      }));
  }

  /**
   * Fetch template rich parameters from Coder API.
   * Uses an optional API session to avoid generating multiple tokens.
   */
  private async getTemplateRichParameters(
    deploymentUrl: string,
    versionId: string,
    workspaceName: string,
    session?: CoderApiSession,
    signal?: AbortSignal
  ): Promise<
    Array<{
      name: string;
      defaultValue: string;
      type: string;
      ephemeral: boolean;
      required: boolean;
    }>
  > {
    const run = async (api: CoderApiSession) => {
      const url = new URL(
        `/api/v2/templateversions/${versionId}/rich-parameters`,
        deploymentUrl
      ).toString();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        controller.abort();
      }

      const response = await fetch(url, {
        headers: {
          "Coder-Session-Token": api.token,
        },
        signal: controller.signal,
      }).finally(() => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch rich parameters: ${response.status} ${response.statusText}`
        );
      }

      const data: unknown = await response.json();
      return this.parseRichParameters(data);
    };

    const tokenName = `mux-${workspaceName}`;
    return session ? run(session) : this.withApiSession(tokenName, run);
  }

  /**
   * Encode a parameter string for the Coder CLI's --parameter flag.
   * The CLI uses CSV parsing, so values containing quotes or commas need escaping:
   * - Wrap the entire string in double quotes
   * - Escape internal double quotes as ""
   */
  private encodeParameterValue(nameValue: string): string {
    if (!nameValue.includes('"') && !nameValue.includes(",")) {
      return nameValue;
    }
    // CSV quoting: wrap in quotes, escape internal quotes as ""
    return `"${nameValue.replace(/"/g, '""')}"`;
  }

  /**
   * Compute extra --parameter flags needed for workspace creation.
   * Filters to non-ephemeral params not covered by preset, using their defaults.
   * Values are passed through as-is (list(string) types expect JSON-encoded arrays).
   */
  computeExtraParams(
    allParams: Array<{
      name: string;
      defaultValue: string;
      type: string;
      ephemeral: boolean;
      required: boolean;
    }>,
    coveredByPreset: Set<string>
  ): Array<{ name: string; encoded: string }> {
    const extra: Array<{ name: string; encoded: string }> = [];

    for (const p of allParams) {
      // Skip ephemeral params
      if (p.ephemeral) continue;
      // Skip params covered by preset
      if (coveredByPreset.has(p.name)) continue;

      // Encode for CLI's CSV parser (escape quotes/commas)
      const encoded = this.encodeParameterValue(`${p.name}=${p.defaultValue}`);
      extra.push({ name: p.name, encoded });
    }

    return extra;
  }

  /**
   * Validate that all required params have values (either from preset or defaults).
   * Throws if any required param is missing a value.
   */
  validateRequiredParams(
    allParams: Array<{
      name: string;
      defaultValue: string;
      type: string;
      ephemeral: boolean;
      required: boolean;
    }>,
    coveredByPreset: Set<string>
  ): void {
    const missing: string[] = [];

    for (const p of allParams) {
      if (p.ephemeral) continue;
      if (p.required && !p.defaultValue && !coveredByPreset.has(p.name)) {
        missing.push(p.name);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `Required template parameters missing values: ${missing.join(", ")}. ` +
          `Select a preset that provides these values or contact your template admin.`
      );
    }
  }

  /**
   * List available Coder templates.
   */
  async listTemplates(): Promise<CoderListTemplatesResult> {
    try {
      const stdout = await this.runCoderJsonCommand(["templates", "list", "--output=json"]);

      // Handle empty output (no templates)
      if (!stdout.trim()) {
        return { ok: true, templates: [] };
      }

      // CLI returns [{Template: {...}}, ...] wrapper structure
      const raw = JSON.parse(stdout) as Array<{
        Template: {
          name: string;
          display_name?: string;
          organization_name?: string;
        };
      }>;

      return {
        ok: true,
        templates: raw.map((entry) => ({
          name: entry.Template.name,
          displayName: entry.Template.display_name ?? entry.Template.name,
          organizationName: entry.Template.organization_name ?? "default",
        })),
      };
    } catch (error) {
      const message = sanitizeCoderCliErrorForUi(error);
      // Surface CLI failures so the UI doesn't show "No templates" incorrectly.
      log.warn("Failed to list Coder templates", { error });
      return { ok: false, error: message || "Unknown error" };
    }
  }

  /**
   * List presets for a template.
   * @param templateName - Template name
   * @param org - Organization name for disambiguation (optional)
   */
  async listPresets(templateName: string, org?: string): Promise<CoderListPresetsResult> {
    try {
      const args = ["templates", "presets", "list", templateName, "--output=json"];
      if (org) args.push("--org", org);
      const stdout = await this.runCoderJsonCommand(args);

      // Handle empty output or non-JSON info messages (no presets).
      // CLI prints "No presets found for template ..." to stdout even with --output=json
      // because the Go handler returns early before the formatter runs.
      if (!stdout.trim() || !stdout.trimStart().startsWith("[")) {
        return { ok: true, presets: [] };
      }

      // CLI returns [{TemplatePreset: {ID, Name, ...}}, ...] wrapper structure
      const raw = JSON.parse(stdout) as Array<{
        TemplatePreset: {
          ID: string;
          Name: string;
          Description?: string;
          Default?: boolean;
        };
      }>;

      return {
        ok: true,
        presets: raw.map((entry) => ({
          id: entry.TemplatePreset.ID,
          name: entry.TemplatePreset.Name,
          description: entry.TemplatePreset.Description,
          isDefault: entry.TemplatePreset.Default ?? false,
        })),
      };
    } catch (error) {
      const message = sanitizeCoderCliErrorForUi(error);
      // Surface CLI failures so the UI doesn't show "No presets" incorrectly.
      log.warn("Failed to list Coder presets", { templateName, error });
      return { ok: false, error: message || "Unknown error" };
    }
  }

  /**
   * Check if a Coder workspace exists by name.
   *
   * Uses `coder list --search name:<workspace>` so we don't have to fetch all workspaces.
   * Note: Coder's `--search` is prefix-based server-side, so we must exact-match locally.
   */
  async workspaceExists(workspaceName: string): Promise<boolean> {
    try {
      const stdout = await this.runCoderJsonCommand([
        "list",
        "--search",
        `name:${workspaceName}`,
        "--output=json",
      ]);

      if (!stdout.trim()) {
        return false;
      }

      const workspaces = JSON.parse(stdout) as Array<{ name: string }>;
      return workspaces.some((w) => w.name === workspaceName);
    } catch (error) {
      // Best-effort: if Coder isn't configured/logged in, treat as "doesn't exist" so we
      // don't block creation (later steps will fail with a more actionable error).
      log.debug("Failed to check if Coder workspace exists", { workspaceName, error });
      return false;
    }
  }

  /**
   * List Coder workspaces (all statuses).
   */
  async listWorkspaces(): Promise<CoderListWorkspacesResult> {
    // Derive known statuses from schema to avoid duplication and prevent ORPC validation errors
    const KNOWN_STATUSES = new Set<string>(CoderWorkspaceStatusSchema.options);

    try {
      const stdout = await this.runCoderJsonCommand(["list", "--output=json"]);

      // Handle empty output (no workspaces)
      if (!stdout.trim()) {
        return { ok: true, workspaces: [] };
      }

      const workspaces = JSON.parse(stdout) as Array<{
        name: string;
        template_name: string;
        template_display_name: string;
        latest_build: {
          status: string;
        };
      }>;

      // Filter to known statuses to avoid ORPC schema validation failures
      return {
        ok: true,
        workspaces: workspaces
          .filter((w) => KNOWN_STATUSES.has(w.latest_build.status))
          .map((w) => ({
            name: w.name,
            templateName: w.template_name,
            templateDisplayName: w.template_display_name || w.template_name,
            status: w.latest_build.status as CoderWorkspaceStatus,
          })),
      };
    } catch (error) {
      const message = sanitizeCoderCliErrorForUi(error);
      // Users reported seeing "No workspaces found" even when the CLI failed,
      // so surface an error state instead of silently returning an empty list.
      log.warn("Failed to list Coder workspaces", { error });
      return { ok: false, error: message || "Unknown error" };
    }
  }

  /**
   * Run a `coder` CLI command with timeout + optional cancellation.
   *
   * We use spawn (not execAsync) so ensureReady() can't hang forever on a stuck
   * Coder CLI invocation.
   */
  private runCoderCommand(
    args: string[],
    options: { timeoutMs: number; signal?: AbortSignal }
  ): Promise<CoderCommandResult> {
    return new Promise((resolve) => {
      if (options.timeoutMs <= 0) {
        resolve({ exitCode: null, stdout: "", stderr: "", error: "timeout" });
        return;
      }

      if (options.signal?.aborted) {
        resolve({ exitCode: null, stdout: "", stderr: "", error: "aborted" });
        return;
      }

      const child = spawn("coder", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let resolved = false;

      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

      const terminator = createGracefulTerminator(child);

      const resolveOnce = (result: CoderCommandResult) => {
        if (resolved) return;
        resolved = true;
        resolve(result);
      };

      const cleanup = (cleanupOptions?: { keepSigkillTimer?: boolean }) => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (!cleanupOptions?.keepSigkillTimer) {
          terminator.cleanup();
        }
        child.removeListener("close", onClose);
        child.removeListener("error", onError);
        options.signal?.removeEventListener("abort", onAbort);
      };

      function onAbort() {
        terminator.terminate();
        // Keep SIGKILL escalation alive if SIGTERM doesn't work.
        cleanup({ keepSigkillTimer: true });
        resolveOnce({ exitCode: null, stdout, stderr, error: "aborted" });
      }

      function onError() {
        cleanup();
        resolveOnce({ exitCode: null, stdout, stderr });
      }

      function onClose(code: number | null) {
        cleanup();
        resolveOnce({ exitCode: code, stdout, stderr });
      }

      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });

      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });

      child.on("error", onError);
      child.on("close", onClose);

      timeoutTimer = setTimeout(() => {
        terminator.terminate();

        // Keep SIGKILL escalation alive if SIGTERM doesn't work.
        // We still remove the abort listener to avoid leaking it beyond the call.
        options.signal?.removeEventListener("abort", onAbort);

        resolveOnce({ exitCode: null, stdout, stderr, error: "timeout" });
      }, options.timeoutMs);

      options.signal?.addEventListener("abort", onAbort);
    });
  }

  private async runCoderJsonCommand(
    args: string[],
    options: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<string> {
    using proc = execFileAsync("coder", args, {
      timeoutMs: options.timeoutMs ?? 30_000,
      signal: options.signal,
    });
    const { stdout } = await proc.result;
    return stdout;
  }

  /**
   * Get workspace status using control-plane query.
   *
   * Note: `coder list --search 'name:X'` is prefix-based on the server,
   * so we must exact-match the workspace name client-side.
   */
  async getWorkspaceStatus(
    workspaceName: string,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<WorkspaceStatusResult> {
    const timeoutMs = options?.timeoutMs ?? 10_000;

    try {
      const result = await this.runCoderCommand(
        ["list", "--search", `name:${workspaceName}`, "--output", "json"],
        { timeoutMs, signal: options?.signal }
      );

      const interpreted = interpretCoderResult(result);
      if (!interpreted.ok) {
        return { kind: "error", error: interpreted.error };
      }

      if (!interpreted.stdout.trim()) {
        return { kind: "not_found" };
      }

      const workspaces = JSON.parse(interpreted.stdout) as Array<{
        name: string;
        latest_build: { status: string };
      }>;

      // Exact match required (search is prefix-based)
      const match = workspaces.find((w) => w.name === workspaceName);
      if (!match) {
        return { kind: "not_found" };
      }

      // Validate status against known schema values
      const status = match.latest_build.status;
      const parsed = CoderWorkspaceStatusSchema.safeParse(status);
      if (!parsed.success) {
        log.warn("Unknown Coder workspace status", { workspaceName, status });
        return { kind: "error", error: `Unknown status: ${status}` };
      }

      return { kind: "ok", status: parsed.data };
    } catch (error) {
      const message = getErrorMessage(error);
      log.debug("Failed to get Coder workspace status", { workspaceName, error: message });
      return { kind: "error", error: message };
    }
  }

  /**
   * Start a Coder workspace.
   *
   * Uses spawn + timeout so callers don't hang forever on a stuck CLI invocation.
   */
  async startWorkspace(
    workspaceName: string,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<Result<void>> {
    const timeoutMs = options?.timeoutMs ?? 60_000;

    try {
      const result = await this.runCoderCommand(["start", workspaceName, "--yes"], {
        timeoutMs,
        signal: options?.signal,
      });

      const interpreted = interpretCoderResult(result);
      if (!interpreted.ok) {
        return Err(interpreted.error);
      }

      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(message);
    }
  }

  /**
   * Stop a Coder workspace.
   *
   * Uses spawn + timeout so callers don't hang forever on a stuck CLI invocation.
   */
  async stopWorkspace(
    workspaceName: string,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<Result<void>> {
    const timeoutMs = options?.timeoutMs ?? 60_000;

    try {
      const result = await this.runCoderCommand(["stop", workspaceName, "--yes"], {
        timeoutMs,
        signal: options?.signal,
      });

      const interpreted = interpretCoderResult(result);
      if (!interpreted.ok) {
        return Err(interpreted.error);
      }

      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(message);
    }
  }

  /**
   * Wait for Coder workspace startup scripts to complete.
   * Runs `coder ssh <workspace> --wait=yes -- true` and streams output.
   */
  async *waitForStartupScripts(
    workspaceName: string,
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    log.debug("Waiting for Coder startup scripts", { workspaceName });
    yield* streamCoderCommand(
      ["ssh", workspaceName, "--wait=yes", "--", "true"],
      "coder ssh --wait failed",
      abortSignal,
      "Coder startup script wait aborted"
    );
  }

  /**
   * Create a new Coder workspace. Yields build log lines as they arrive.
   *
   * Pre-fetches template parameters and passes defaults via --parameter flags
   * to avoid interactive prompts during creation.
   *
   * @param name Workspace name
   * @param template Template name
   * @param preset Optional preset name
   * @param abortSignal Optional signal to cancel workspace creation
   * @param org Optional organization name for disambiguation
   * @param session Optional API session to reuse across deployment endpoints
   */
  async *createWorkspace(
    name: string,
    template: string,
    preset?: string,
    abortSignal?: AbortSignal,
    org?: string,
    session?: CoderApiSession
  ): AsyncGenerator<string, void, unknown> {
    log.debug("Creating Coder workspace", { name, template, preset, org });

    if (abortSignal?.aborted) {
      throw new Error("Coder workspace creation aborted");
    }

    // 1. Get deployment URL
    const deploymentUrl = await this.getDeploymentUrl(abortSignal);

    if (abortSignal?.aborted) {
      throw new Error("Coder workspace creation aborted");
    }

    // 2. Get active template version ID
    const versionId = await this.getActiveTemplateVersionId(template, org, abortSignal);

    if (abortSignal?.aborted) {
      throw new Error("Coder workspace creation aborted");
    }

    // 3. Get parameter names covered by preset (if any)
    const coveredByPreset = preset
      ? await this.getPresetParamNames(template, preset, org, abortSignal)
      : new Set<string>();

    if (abortSignal?.aborted) {
      throw new Error("Coder workspace creation aborted");
    }

    // 4. Fetch all template parameters from API
    const allParams = await this.getTemplateRichParameters(
      deploymentUrl,
      versionId,
      name,
      session,
      abortSignal
    );

    // 5. Validate required params have values
    this.validateRequiredParams(allParams, coveredByPreset);

    // 6. Compute extra --parameter flags for non-ephemeral params not in preset
    const extraParams = this.computeExtraParams(allParams, coveredByPreset);

    log.debug("Computed extra params for coder create", {
      name,
      template,
      preset,
      org,
      extraParamCount: extraParams.length,
      extraParamNames: extraParams.map((p) => p.name),
    });

    // 7. Build and run single coder create command
    const args = ["create", name, "-t", template, "--yes"];
    if (org) {
      args.push("--org", org);
    }
    if (preset) {
      args.push("--preset", preset);
    }
    for (const p of extraParams) {
      args.push("--parameter", p.encoded);
    }

    yield* streamCoderCommand(
      args,
      "coder create failed",
      abortSignal,
      "Coder workspace creation aborted"
    );
  }

  /** Promise-based sleep helper */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };

      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Delete a Coder workspace, retrying across transient build states.
   *
   * This is used for "cancel creation" because aborting the local `coder create`
   * process does not guarantee the control-plane build is canceled.
   */
  async deleteWorkspaceEventually(
    name: string,
    options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
      /**
       * If true, treat an initial "not found" as inconclusive and keep polling.
       * This avoids races where `coder create` finishes server-side after mux aborts the CLI.
       */
      waitForExistence?: boolean;
      /**
       * When `waitForExistence` is true: if we only see "not found" for this many ms
       * without ever observing the workspace exist, treat it as success and return early.
       * Defaults to `timeoutMs` (no separate short-circuit).
       */
      waitForExistenceTimeoutMs?: number;
    }
  ): Promise<Result<void>> {
    const timeoutMs = options?.timeoutMs ?? 60_000;
    const startTime = Date.now();

    // Safety: never delete Coder workspaces mux didn't create.
    // Xum-created workspaces always use the mux- prefix.
    if (!name.startsWith("mux-")) {
      log.warn("Refusing to delete Coder workspace without mux- prefix", { name });
      return Ok(undefined);
    }

    const isTimedOut = () => Date.now() - startTime > timeoutMs;
    const remainingMs = () => Math.max(0, timeoutMs - (Date.now() - startTime));

    const unstableStates = new Set<CoderWorkspaceStatus>([
      "starting",
      "pending",
      "stopping",
      "canceling",
    ]);

    let sawWorkspaceExist = false;
    let lastError: string | undefined;
    let attempt = 0;

    while (!isTimedOut()) {
      if (options?.signal?.aborted) {
        return Err("Delete operation aborted");
      }

      const statusResult = await this.getWorkspaceStatus(name, {
        timeoutMs: Math.min(remainingMs(), 10_000),
        signal: options?.signal,
      });

      if (statusResult.kind === "ok") {
        sawWorkspaceExist = true;

        if (statusResult.status === "deleted" || statusResult.status === "deleting") {
          return Ok(undefined);
        }

        // If a build is transitioning (starting/stopping/etc), deletion may fail temporarily.
        // We'll keep polling + retrying the delete command.
        if (unstableStates.has(statusResult.status)) {
          log.debug("Coder workspace in transitional state; will retry delete", {
            name,
            status: statusResult.status,
          });
        }
      }

      if (statusResult.kind === "not_found") {
        if (options?.waitForExistence !== true) {
          return Ok(undefined);
        }

        // For cancel-init, avoid treating an initial not_found as success: `coder create` may still
        // complete server-side after we abort the local CLI. Keep polling until we either observe
        // the workspace exist (and then disappear), or we hit the existence-wait window.
        if (sawWorkspaceExist) {
          return Ok(undefined);
        }

        // Short-circuit: if we've never seen the workspace and the shorter existence-wait
        // window has elapsed, assume the server-side create never completed.
        const existenceTimeout = options?.waitForExistenceTimeoutMs ?? timeoutMs;
        if (Date.now() - startTime > existenceTimeout) {
          return Ok(undefined);
        }

        attempt++;
        const backoffMs = Math.min(2_000, 250 + attempt * 150);
        await this.sleep(backoffMs, options?.signal);
        continue;
      }

      if (statusResult.kind === "error") {
        // If status checks fail (auth/network), still attempt delete best-effort.
        lastError = statusResult.error;
      }

      const deleteAttempt = await this.runCoderCommand(["delete", name, "--yes"], {
        timeoutMs: Math.min(remainingMs(), 20_000),
        signal: options?.signal,
      });

      const interpreted = interpretCoderResult(deleteAttempt);
      if (!interpreted.ok) {
        lastError = interpreted.error;
      } else {
        // Successful delete is terminal; status polling is best-effort.
        lastError = undefined;
        return Ok(undefined);
      }

      attempt++;
      const backoffMs = Math.min(2_000, 250 + attempt * 150);
      await this.sleep(backoffMs, options?.signal);
    }

    if (options?.waitForExistence === true && !sawWorkspaceExist && !lastError) {
      return Ok(undefined);
    }

    return Err(lastError ?? "Timed out deleting Coder workspace");
  }

  /**
   * Delete a Coder workspace.
   *
   * Safety: Only deletes workspaces with "mux-" prefix to prevent accidentally
   * deleting user workspaces that weren't created by mux.
   */
  async deleteWorkspace(name: string): Promise<void> {
    const result = await this.deleteWorkspaceEventually(name, {
      timeoutMs: 30_000,
      waitForExistence: false,
    });

    if (!result.success) {
      throw new Error(result.error);
    }
  }

  /**
   * Ensure mux-owned SSH config is set up for Coder workspaces.
   * Run before every Coder workspace connection (idempotent).
   */
  async ensureMuxCoderSSHConfig(): Promise<void> {
    log.debug("Ensuring mux-owned Coder SSH config");
    const coderBinary = await this.resolveCoderBinaryPath();
    if (coderBinary == null) {
      log.debug("Skipping mux-owned Coder SSH config setup because coder binary is unavailable");
      return;
    }

    await ensureMuxCoderSSHConfigFile({
      coderBinaryPath: coderBinary,
    });
  }
}

// Singleton instance
export const coderService = new CoderService();
