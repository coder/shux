import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import writeFileAtomic from "write-file-atomic";
import {
  CLAUDE_DESIGN_MAX_CREDENTIAL_BYTES,
  CLAUDE_DESIGN_MAX_ERROR_BYTES,
  CLAUDE_DESIGN_SCOPES,
  CLAUDE_DESIGN_SERVER_NAME,
  CLAUDE_DESIGN_URL,
  CLAUDE_DESIGN_READ_TIMEOUT_MS,
  CLAUDE_DESIGN_TEST_TIMEOUT_MS,
} from "@/common/constants/claudeDesign";
import {
  ClaudeDesignSettingsSchema,
  type ClaudeDesignSettings,
  type ClaudeDesignSource,
  type ClaudeDesignState,
  type ClaudeDesignStatus,
} from "@/common/orpc/schemas/claudeDesign";
import type { MCPHttpServerInfo, MCPTestResult } from "@/common/types/mcp";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { createMCPClient, type MCPHttpTransportConfig } from "./mcpClient";
import { readClaudeCredentialSource } from "./claudeDesign/credentialReader";

interface Credential {
  accessToken: string;
  expiresAt: number;
  kind: "designOauth" | "claudeAiOauth";
}
class DesignError extends Error {
  constructor(readonly state: ClaudeDesignState) {
    super(`Claude Design: ${state}`);
  }
}
const defaults = (): ClaudeDesignSettings => ({
  source: null,
  reuseEnabled: false,
  serverEnabled: false,
});

/** Pure selection: Claude owns refresh/consent; never return its refresh tokens or client IDs. */
export function selectClaudeDesignCredential(raw: string, now: number): Credential {
  if (Buffer.byteLength(raw) > CLAUDE_DESIGN_MAX_CREDENTIAL_BYTES)
    throw new DesignError("credentials_invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DesignError("credentials_invalid");
  }
  if (!parsed || typeof parsed !== "object") throw new DesignError("credentials_invalid");
  let failure: ClaudeDesignState = "credentials_unavailable";
  for (const kind of ["designOauth", "claudeAiOauth"] as const) {
    const value: unknown = Reflect.get(parsed, kind);
    if (value == null) continue;
    if (typeof value !== "object") {
      failure = "credentials_invalid";
      continue;
    }
    const accessToken: unknown = Reflect.get(value, "accessToken");
    const expiresAt: unknown = Reflect.get(value, "expiresAt");
    const scopes: unknown = Reflect.get(value, "scopes");
    if (
      typeof accessToken !== "string" ||
      !accessToken ||
      /\s/.test(accessToken) ||
      typeof expiresAt !== "number" ||
      !Number.isFinite(expiresAt)
    ) {
      failure = "credentials_invalid";
      continue;
    }
    if (expiresAt <= now) {
      failure = "expired";
      continue;
    }
    if (!Array.isArray(scopes) || !CLAUDE_DESIGN_SCOPES.every((scope) => scopes.includes(scope))) {
      failure = "missing_scopes";
      continue;
    }
    return { accessToken, expiresAt, kind };
  }
  throw new DesignError(failure);
}

/**
 * Read-only reuse is deliberately separate from McpOauthService: the SDK must
 * never rotate, invalidate, export, or revoke another application's login.
 * This module owns the request seam so tests and callers exercise the same gates.
 */
export class ClaudeDesignService {
  private settings = defaults();
  private loaded: Promise<void> | undefined;
  private readonly lock = new MutexMap<string>();
  private controller = new AbortController();
  private reading: Promise<Credential> | undefined;
  private state: ClaudeDesignState = "not_configured";
  private rejected = false;
  private readonly listeners = new Set<() => Promise<void>>();
  generation = 0;

  constructor(
    private readonly options: {
      rootDir: string;
      isEnabled: () => boolean;
      readSource?: (source: ClaudeDesignSource, signal?: AbortSignal) => Promise<string>;
      fetch?: typeof fetch;
      now?: () => number;
    }
  ) {}

  private get filePath() {
    return path.join(this.options.rootDir, "claude-design.json");
  }
  private load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        this.settings = ClaudeDesignSettingsSchema.parse(
          JSON.parse(await fs.readFile(this.filePath, "utf8"))
        );
      } catch {
        this.settings = defaults();
      }
    })();
    return this.loaded;
  }
  onChange(listener: () => Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async invalidate(): Promise<void> {
    this.generation++;
    this.controller.abort();
    this.controller = new AbortController();
    this.reading = undefined;
    this.rejected = false;
    this.state = "not_configured";
    await Promise.all([...this.listeners].map((listener) => listener()));
  }
  async getStatus(): Promise<ClaudeDesignStatus> {
    // Listing status never opens a credential source, even when configured.
    if (this.options.isEnabled()) await this.load();
    return {
      state: !this.options.isEnabled() || !this.settings.reuseEnabled ? "disabled" : this.state,
      settings: { ...this.settings },
      backendHost: os.hostname(),
      platform: process.platform,
    };
  }
  async configure(settings: Partial<ClaudeDesignSettings>): Promise<ClaudeDesignStatus> {
    await this.lock.withLock("settings", async () => {
      if (!this.options.isEnabled()) throw new DesignError("disabled");
      await this.load();
      const next = ClaudeDesignSettingsSchema.parse({ ...this.settings, ...settings });
      if (settings.serverEnabled === true && !next.reuseEnabled)
        throw new DesignError("not_configured");
      if (!next.reuseEnabled) next.serverEnabled = false;
      if (next.reuseEnabled && !next.source) throw new DesignError("not_configured");
      if (next.source?.type === "file" && !path.isAbsolute(next.source.path))
        throw new DesignError("credentials_invalid");
      await fs.mkdir(this.options.rootDir, { recursive: true, mode: 0o700 });
      // Persist only preferences, then publish and retire old clients.
      await writeFileAtomic(this.filePath, JSON.stringify(next, null, 2), { mode: 0o600 });
      this.settings = next;
      await this.invalidate();
    });
    return this.getStatus();
  }
  async serverInfo(): Promise<MCPHttpServerInfo | undefined> {
    if (!this.options.isEnabled()) return undefined;
    await this.load();
    if (!this.options.isEnabled()) return undefined;
    return {
      transport: "http",
      url: CLAUDE_DESIGN_URL,
      managed: "claude-design",
      disabled: !this.settings.serverEnabled || !this.settings.reuseEnabled,
      toolAllowlist: this.settings.toolAllowlist,
    };
  }
  private guard(signal: AbortSignal): void {
    if (!this.options.isEnabled() || !this.settings.reuseEnabled) throw new DesignError("disabled");
    if (signal.aborted) throw new DesignError("connection_failed");
    if (!this.settings.source) throw new DesignError("not_configured");
    if (this.rejected) throw new DesignError(this.state);
  }
  private async credential(signal: AbortSignal): Promise<Credential> {
    this.guard(signal);
    const source = this.settings.source;
    if (!source) throw new DesignError("not_configured");
    const read = (this.reading ??= (async () => {
      try {
        const raw = await (this.options.readSource ?? readClaudeCredentialSource)(
          source,
          this.controller.signal
        );
        return selectClaudeDesignCredential(raw, (this.options.now ?? Date.now)());
      } catch (error) {
        throw error instanceof DesignError ? error : new DesignError("credentials_unavailable");
      }
    })());
    try {
      const result = await raceWithAbortAndTimeout(read, {
        signal,
        timeoutMs: CLAUDE_DESIGN_READ_TIMEOUT_MS,
      });
      this.guard(signal);
      if (result.kind !== "ok") throw new DesignError("credentials_unavailable");
      return result.value;
    } finally {
      if (this.reading === read) this.reading = undefined;
    }
  }
  transport(headers?: Record<string, string>, extraSignal?: AbortSignal): MCPHttpTransportConfig {
    const lifecycle = extraSignal
      ? AbortSignal.any([this.controller.signal, extraSignal])
      : this.controller.signal;
    const baseFetch = this.options.fetch ?? fetch;
    const wrapped = Object.assign(async (...args: Parameters<typeof fetch>): Promise<Response> => {
      try {
        this.guard(lifecycle);
        const request = new Request(args[0], args[1]);
        if (request.url !== CLAUDE_DESIGN_URL) throw new DesignError("authorization_failed");
        if (request.method !== "POST")
          return new Response(null, { status: 405, headers: { Allow: "POST" } });
        const signal = AbortSignal.any([lifecycle, request.signal]);
        const explicitAuth = request.headers.has("authorization");
        const body = await request.text();
        const credential = explicitAuth ? undefined : await this.credential(signal);
        const send = async (token?: Credential) => {
          this.guard(signal);
          const outgoing = new Headers(request.headers);
          if (token) outgoing.set("Authorization", `Bearer ${token.accessToken}`);
          // Do not inherit the generic transport's redirect:follow policy.
          return baseFetch(CLAUDE_DESIGN_URL, {
            method: "POST",
            headers: outgoing,
            body,
            redirect: "error",
            signal,
          });
        };
        let response = await send(credential);
        this.guard(signal);
        if (response.status === 401 && credential) {
          let next: Credential;
          try {
            next = await this.credential(signal);
          } catch (error) {
            await response.body?.cancel();
            if (!signal.aborted) this.rejected = true;
            throw error;
          }
          if (next.kind === credential.kind && next.accessToken !== credential.accessToken) {
            await response.body?.cancel();
            response = await send(next);
            this.guard(signal);
          }
        }
        if (response.status === 401 || response.status === 403) {
          const state =
            response.status === 403 && (await needsConsent(response))
              ? "consent_required"
              : "authorization_failed";
          this.guard(signal);
          this.state = state;
          this.rejected = true;
          await response.body?.cancel();
          throw new DesignError(state);
        }
        // SDK errors include server response bodies. Never expose those to logs/UI.
        if (!response.ok) {
          await response.body?.cancel();
          throw new DesignError("connection_failed");
        }
        return response;
      } catch (error) {
        const safe = error instanceof DesignError ? error : new DesignError("connection_failed");
        if (!lifecycle.aborted) this.state = safe.state;
        throw safe;
      }
    }, baseFetch);
    return { type: "http", url: CLAUDE_DESIGN_URL, headers, fetch: wrapped };
  }
  markConnected(generation: number): void {
    if (generation === this.generation && this.options.isEnabled() && this.settings.reuseEnabled)
      this.state = "connected";
  }
  async test(): Promise<MCPTestResult> {
    if (!this.options.isEnabled()) return { success: false, error: "Claude Design: disabled" };
    await this.load();
    await this.invalidate();
    const generation = this.generation;
    let client: Awaited<ReturnType<typeof createMCPClient>> | undefined;
    try {
      client = await createMCPClient({
        transport: this.transport(undefined, AbortSignal.timeout(CLAUDE_DESIGN_TEST_TIMEOUT_MS)),
        prior: { kind: "legacy" },
      });
      const tools = Object.keys(await client.tools());
      this.guard(this.controller.signal);
      if (generation !== this.generation) throw new DesignError("disabled");
      this.state = "connected";
      return { success: true, tools, protocolVersion: client.negotiatedProtocolVersion() };
    } catch (error) {
      const state =
        error instanceof DesignError
          ? error.state
          : this.state === "not_configured"
            ? "connection_failed"
            : this.state;
      if (generation === this.generation && !this.rejected) this.state = state;
      return { success: false, error: `Claude Design: ${this.state}` };
    } finally {
      await client?.close().catch(() => undefined);
    }
  }
}

async function needsConsent(response: Response): Promise<boolean> {
  const reader = response.clone().body?.getReader();
  if (!reader) return false;
  try {
    let text = "";
    let bytes = 0;
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > CLAUDE_DESIGN_MAX_ERROR_BYTES) return false;
      text += decoder.decode(chunk.value, { stream: true });
    }
    const body: unknown = JSON.parse(text + decoder.decode());
    return (
      body !== null && typeof body === "object" && Reflect.get(body, "error") === "needs_consent"
    );
  } catch {
    return false;
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

export { CLAUDE_DESIGN_SERVER_NAME };
