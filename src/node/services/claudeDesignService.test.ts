import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import {
  EXPERIMENT_OVERRIDES_FILE_NAME,
  readPersistedExperimentEnabled,
} from "./experimentsService";
import { SSHRuntime } from "@/node/runtime/SSHRuntime";
import { OpenSSHTransport } from "@/node/runtime/transports/OpenSSHTransport";
import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { McpOauthService } from "./mcpOauthService";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CLAUDE_DESIGN_SCOPES, CLAUDE_DESIGN_URL } from "@/common/constants/claudeDesign";
import { ClaudeDesignService, selectClaudeDesignCredential } from "./claudeDesignService";
import { readClaudeCredentialSource } from "./claudeDesign/credentialReader";
import { createMCPClient } from "./mcpClient";
import { MCPConfigService } from "./mcpConfigService";
import { MCPServerManager } from "./mcpServerManager";
import { Config } from "@/node/config";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";

const now = 1_000_000;
const token = (value = "synthetic-token", extra = {}) => ({
  accessToken: value,
  expiresAt: now + 60_000,
  scopes: [...CLAUDE_DESIGN_SCOPES],
  ...extra,
});
const data = (value = "synthetic-token") =>
  JSON.stringify({ designOauth: token(value), refreshToken: "must-never-copy" });
const fakeFetch = (fn: (...args: Parameters<typeof fetch>) => Promise<Response>): typeof fetch =>
  Object.assign(fn, fetch);
let rootDir: string;
beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-design-test-"));
});
afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

async function setup(
  options: {
    readSource?: () => Promise<string>;
    fetch?: typeof fetch;
    enabled?: () => boolean;
    now?: () => number;
    readEnabled?: () => Promise<boolean>;
  } = {}
) {
  const service = new ClaudeDesignService({
    rootDir,
    isEnabled: options.enabled ?? (() => true),
    now: options.now ?? (() => now),
    readSource: options.readSource ?? (() => Promise.resolve(data())),
    fetch: options.fetch,
    readEnabled: options.readEnabled,
  });
  await service.configure({
    source: { type: "file", path: path.join(rootDir, "synthetic.json") },
    reuseEnabled: true,
    serverEnabled: true,
  });
  const transportFetch = service.transport().fetch;
  if (!transportFetch) throw new Error("Missing transport");
  return {
    service,
    send: (init: RequestInit = {}) =>
      transportFetch(CLAUDE_DESIGN_URL, { method: "POST", body: "{}", ...init }),
    transportFetch,
  };
}

describe("read-only credential selection", () => {
  test("prefers Design and never returns refresh/client metadata", () => {
    const result = selectClaudeDesignCredential(
      JSON.stringify({
        designOauth: { ...token(), refreshToken: "secret", clientId: "client" },
        claudeAiOauth: token("main"),
      }),
      now
    );
    expect(result.kind).toBe("designOauth");
    expect(Object.keys(result).sort()).toEqual(["accessToken", "expiresAt", "kind"]);
  });
  test("uses explicitly scoped main login when Design is absent or expired", () => {
    expect(
      selectClaudeDesignCredential(
        JSON.stringify({
          designOauth: token("expired", { expiresAt: now }),
          claudeAiOauth: token("main"),
        }),
        now
      ).accessToken
    ).toBe("main");
    expect(() =>
      selectClaudeDesignCredential(
        JSON.stringify({ claudeAiOauth: token("main", { scopes: ["user:profile"] }) }),
        now
      )
    ).toThrow("missing_scopes");
  });
  test.each([
    ["{", "credentials_invalid"],
    ["{}", "credentials_unavailable"],
    [JSON.stringify({ designOauth: token("expired", { expiresAt: now }) }), "expired"],
    [JSON.stringify({ designOauth: token("unknown", { expiresAt: null }) }), "credentials_invalid"],
    [
      JSON.stringify({ designOauth: token("scope", { scopes: [CLAUDE_DESIGN_SCOPES[0]] }) }),
      "missing_scopes",
    ],
  ])("classifies unavailable credential input", (raw, state) => {
    expect(() => selectClaudeDesignCredential(raw, now)).toThrow(state);
  });
  test("real private file reader rejects public files, symlinks, and missing files", async () => {
    const file = path.join(rootDir, "credentials.json");
    await fs.writeFile(file, data(), { mode: 0o600 });
    expect(await readClaudeCredentialSource({ type: "file", path: file })).toBe(data());
    if (process.platform !== "win32") {
      await fs.chmod(file, 0o644);
      await expectFailure(readClaudeCredentialSource({ type: "file", path: file }));
      await fs.symlink(file, path.join(rootDir, "link"));
      await expectFailure(
        readClaudeCredentialSource({ type: "file", path: path.join(rootDir, "link") })
      );
    }
    await expectFailure(
      readClaudeCredentialSource({ type: "file", path: path.join(rootDir, "missing") })
    );
  });
});

describe("Design HTTP request seam", () => {
  test("explicit Authorization wins case-insensitively without reading credentials", async () => {
    const readSource = mock(() => Promise.resolve(data()));
    const captured: { authorization: string | null } = { authorization: null };
    const { send } = await setup({
      readSource,
      fetch: fakeFetch((_input, init) => {
        captured.authorization = new Headers(init?.headers).get("authorization");
        return Promise.resolve(new Response("{}"));
      }),
    });
    await send({ headers: { aUtHoRiZaTiOn: "Bearer explicit" } });
    expect(captured.authorization).toBe("Bearer explicit");
    expect(readSource).not.toHaveBeenCalled();
  });
  test("GET stays local and credentials never reach another origin/path or redirects", async () => {
    const readSource = mock(() => Promise.resolve(data()));
    const network = mock(() => Promise.resolve(new Response("{}")));
    const { transportFetch } = await setup({ readSource, fetch: fakeFetch(network) });
    expect((await transportFetch(CLAUDE_DESIGN_URL)).status).toBe(405);
    for (const url of [
      "http://api.anthropic.com/v1/design/mcp",
      "https://api.anthropic.com.evil.test/v1/design/mcp",
      "https://api.anthropic.com/v1/design/consent",
      `${CLAUDE_DESIGN_URL}?other=1`,
      "https://api.anthropic.com:444/v1/design/mcp",
    ]) {
      await expectFailure(transportFetch(url, { method: "POST" }));
    }
    expect(network).not.toHaveBeenCalled();
    expect(readSource).not.toHaveBeenCalled();
    const redirected = await setup({
      fetch: fakeFetch((_input, init) => {
        expect(init?.redirect).toBe("error");
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: "https://other.test" } })
        );
      }),
    });
    await expectFailure(redirected.send(), "connection_failed");
  });
  test("401 rereads and retries once with a changed token from the same source", async () => {
    let reads = 0;
    const authorizations: Array<string | null> = [];
    const { send } = await setup({
      readSource: () => Promise.resolve(data(++reads === 1 ? "old" : "new")),
      fetch: fakeFetch((_input, init) => {
        authorizations.push(new Headers(init?.headers).get("authorization"));
        return Promise.resolve(
          new Response("{}", { status: authorizations.length === 1 ? 401 : 200 })
        );
      }),
    });
    expect((await send()).ok).toBe(true);
    expect(authorizations).toEqual(["Bearer old", "Bearer new"]);
    expect(reads).toBe(2);
    const saved = await fs.readFile(path.join(rootDir, "claude-design.json"), "utf8");
    expect(saved).not.toContain("synthetic-token");
    expect(saved).not.toContain("refreshToken");
    expect(await fs.readdir(rootDir)).toEqual(["claude-design.json"]);
  });
  test("unchanged 401 stops; an explicit header does not trigger a credential retry", async () => {
    const network = mock(() => Promise.resolve(new Response("{}", { status: 401 })));
    const { send } = await setup({ fetch: fakeFetch(network) });
    await expectFailure(send(), "authorization_failed");
    await expectFailure(send(), "authorization_failed");
    expect(network).toHaveBeenCalledTimes(1);
    const readSource = mock(() => Promise.resolve(data()));
    const explicit = await setup({ readSource, fetch: fakeFetch(network) });
    await expectFailure(explicit.send({ headers: { Authorization: "explicit" } }));
    expect(readSource).not.toHaveBeenCalled();
    expect(network).toHaveBeenCalledTimes(2);
  });
  test.each([
    [JSON.stringify({ error: "needs_consent", consent: "unknown_bit" }), "consent_required"],
    [JSON.stringify({ error: "forbidden", echoedToken: "do-not-expose" }), "authorization_failed"],
    ["<html>forbidden</html>", "authorization_failed"],
    ["x".repeat(20_000), "authorization_failed"],
  ])("403 is redacted and never grants consent", async (body, state) => {
    const network = mock(() => Promise.resolve(new Response(body, { status: 403 })));
    const { service, send } = await setup({ fetch: fakeFetch(network) });
    await expectFailure(send(), state);
    expect(String((await service.getStatus()).state)).toBe(state);
    expect(network).toHaveBeenCalledTimes(1);
  });
  test("unavailable credentials expose no child-process output and send nothing", async () => {
    const network = mock(() => Promise.resolve(new Response("{}")));
    const { send } = await setup({
      readSource: () => {
        throw new Error("secret in child stdout");
      },
      fetch: fakeFetch(network),
    });
    await expectFailure(send(), "credentials_unavailable");
    expect(network).not.toHaveBeenCalled();
  });
  test("concurrent reads coalesce and disable during lookup prevents both sends", async () => {
    let finish!: (raw: string) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const readSource = mock(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
          entered();
        })
    );
    const network = mock(() => Promise.resolve(new Response("{}")));
    const { service, send } = await setup({ readSource, fetch: fakeFetch(network) });
    const results = Promise.allSettled([send(), send()]);
    // Wait for the deterministic reader entry, not a timing grace period.
    await started;
    await service.configure({ source: null, reuseEnabled: false, serverEnabled: false });
    finish(data());
    expect((await results).every((result) => result.status === "rejected")).toBe(true);
    expect(readSource).toHaveBeenCalledTimes(1);
    expect(network).not.toHaveBeenCalled();
  });
  test("disabled experiment does not inspect a configured credential source", async () => {
    let enabled = true;
    const readSource = mock(() => Promise.resolve(data()));
    const network = mock(() => Promise.resolve(new Response("{}")));
    const { service, send } = await setup({
      enabled: () => enabled,
      readSource,
      fetch: fakeFetch(network),
    });
    enabled = false;
    await service.invalidate();
    expect((await service.getStatus()).state).toBe("disabled");
    expect(await service.serverInfo()).toBeUndefined();
    expect((await service.test()).success).toBe(false);
    await expectFailure(send(), "disabled");
    expect(readSource).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
});

function protocolFixture() {
  const methods: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.method).toBe("POST");
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-token");
      const body = (await request.json()) as { id?: number; method: string };
      methods.push(body.method);
      if (body.id === undefined) return new Response(null, { status: 202 });
      const results: Record<string, unknown> = {
        initialize: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {}, prompts: {} },
          serverInfo: { name: "fixture", version: "1" },
        },
        "tools/list": {
          tools: [
            {
              name: "design_test",
              description: "Synthetic fixture",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
        "prompts/list": { prompts: [{ name: "fixture_prompt" }] },
        "prompts/get": { messages: [{ role: "user", content: { type: "text", text: "fixture" } }] },
        "tools/call": { content: [{ type: "text", text: "fixture result" }] },
      };
      const payload = JSON.stringify({ jsonrpc: "2.0", id: body.id, result: results[body.method] });
      return new Response(
        body.method === "tools/call" ? `event: message\ndata: ${payload}\n\n` : payload,
        {
          headers: {
            "content-type": body.method === "tools/call" ? "text/event-stream" : "application/json",
            "mcp-session-id": "fixture-session",
          },
        }
      );
    },
  });
  return { server, methods, network: fakeFetch((_input, init) => fetch(server.url, init)) };
}

test("real SDK connects with POST-only transport, tools, prompts, and POST streaming", async () => {
  const fixture = protocolFixture();
  const { service } = await setup({ fetch: fixture.network });
  try {
    expect((await service.test()).success).toBe(true);
    const client = await createMCPClient({
      transport: service.transport(),
      prior: { kind: "legacy" },
    });
    try {
      const tools = await client.tools();
      expect((await client.prompts())[0].name).toBe("fixture_prompt");
      expect((await client.getPrompt("fixture_prompt", {})).messages).toHaveLength(1);
      expect(tools.design_test.execute).toBeDefined();
      await tools.design_test.execute?.(
        {},
        { toolCallId: "test", messages: [], context: undefined }
      );
      expect(fixture.methods).toContain("tools/call");
      expect(fixture.methods).not.toContain("server/discover");
    } finally {
      await client.close();
    }
  } finally {
    await fixture.server.stop(true);
  }
});

test("config provenance cannot be supplied by project JSON; name collision remains ordinary", async () => {
  const { service } = await setup();
  const config = new Config(rootDir);
  const mcp = new MCPConfigService(config, { claudeDesign: service });
  expect((await mcp.listServers()).claude_design).toMatchObject({ managed: "claude-design" });
  await fs.writeFile(
    path.join(rootDir, "mcp.jsonc"),
    JSON.stringify({
      servers: {
        claude_design: { transport: "http", url: CLAUDE_DESIGN_URL, managed: "claude-design" },
      },
    })
  );
  expect((await mcp.listServers()).claude_design).not.toHaveProperty("managed");
});

test("manager uses Design transport, bypasses OAuth, and retires clients on disable", async () => {
  const fixture = protocolFixture();
  const { service } = await setup({ fetch: fixture.network });
  const config = new MCPConfigService(new Config(rootDir), { claudeDesign: service });
  const manager = new MCPServerManager(config);
  try {
    const result = await manager.getToolsForWorkspace({
      workspaceId: "test",
      projectPath: rootDir,
      workspacePath: rootDir,
      runtime: new LocalRuntime(rootDir),
      trusted: true,
    });
    expect(Object.keys(result.tools).length).toBe(1);
    const status = await service.getStatus();
    await service.configure({ ...status.settings, reuseEnabled: false, serverEnabled: false });
    const disabled = await manager.getToolsForWorkspace({
      workspaceId: "test",
      projectPath: rootDir,
      workspacePath: rootDir,
      runtime: new LocalRuntime(rootDir),
      trusted: true,
    });
    expect(Object.keys(disabled.tools)).toHaveLength(0);
  } finally {
    await manager.stopServers("test");
    manager.dispose();
    await fixture.server.stop(true);
  }
});

test.each(["ssh", "container"] as const)(
  "%s workspaces keep Design HTTP on the backend and never use runtime exec",
  async (kind) => {
    const fixture = protocolFixture();
    const { service } = await setup({ fetch: fixture.network });
    const config = new Config(rootDir);
    const mcp = new MCPConfigService(config, { claudeDesign: service });
    const manager = new MCPServerManager(mcp);
    const oauth = new McpOauthService(config, mcp);
    const authProvider = spyOn(oauth, "getAuthProviderForServer");
    const authTokens = spyOn(oauth, "hasAuthTokens");
    manager.setMcpOauthService(oauth);
    const runtime =
      kind === "ssh"
        ? new SSHRuntime(
            { host: "unused.invalid", srcBaseDir: rootDir },
            new OpenSSHTransport({ host: "unused.invalid" })
          )
        : new DevcontainerRuntime({ srcBaseDir: rootDir, configPath: "unused.json" });
    const exec = spyOn(runtime, "exec").mockRejectedValue(new Error("Runtime exec must not run"));
    try {
      const result = await manager.getToolsForWorkspace({
        workspaceId: kind,
        projectPath: rootDir,
        workspacePath: rootDir,
        runtime,
        trusted: true,
      });
      expect(Object.keys(result.tools)).toHaveLength(1);
      expect(exec).not.toHaveBeenCalled();
      expect(authProvider).not.toHaveBeenCalled();
      expect(authTokens).not.toHaveBeenCalled();
    } finally {
      await manager.stopServers(kind);
      manager.dispose();
      await fixture.server.stop(true);
      exec.mockRestore();
      authProvider.mockRestore();
      authTokens.mockRestore();
    }
  }
);

test("401 does not retry a different credential kind or retry a second failure", async () => {
  for (const changeKind of [true, false]) {
    let reads = 0;
    const network = mock(() => Promise.resolve(new Response("{}", { status: 401 })));
    const { send } = await setup({
      readSource: () =>
        Promise.resolve(
          ++reads === 1
            ? data("first")
            : changeKind
              ? JSON.stringify({ claudeAiOauth: token("second") })
              : data("second")
        ),
      fetch: fakeFetch(network),
    });
    await expectFailure(send(), "authorization_failed");
    expect(network).toHaveBeenCalledTimes(changeKind ? 1 : 2);
    expect(reads).toBe(2);
  }
});

test("401 with expired reread reports expiry and cannot silently switch on a later request", async () => {
  let reads = 0;
  const network = mock(() => Promise.resolve(new Response("{}", { status: 401 })));
  const { service, send } = await setup({
    readSource: () =>
      Promise.resolve(
        ++reads === 1
          ? data()
          : JSON.stringify({ designOauth: token("expired", { expiresAt: now }) })
      ),
    fetch: fakeFetch(network),
  });
  await expectFailure(send(), "expired");
  expect((await service.getStatus()).state).toBe("expired");
  await expectFailure(send(), "expired");
  expect(network).toHaveBeenCalledTimes(1);
});

test("disabled status and startup are inert even with malformed persisted settings", async () => {
  await fs.writeFile(path.join(rootDir, "claude-design.json"), "{");
  const readSource = mock(() => Promise.resolve(data()));
  const service = new ClaudeDesignService({ rootDir, isEnabled: () => false, readSource });
  expect((await service.getStatus()).state).toBe("disabled");
  expect(await service.serverInfo()).toBeUndefined();
  expect(readSource).not.toHaveBeenCalled();
});

test("disable aborts an in-flight HTTP request", async () => {
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let aborted = false;
  const { service, send } = await setup({
    fetch: fakeFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true }
          );
          started();
        })
    ),
  });
  const result = send().catch(() => undefined);
  await entered;
  await service.configure({ source: null, reuseEnabled: false, serverEnabled: false });
  await result;
  expect(aborted).toBe(true);
});

async function expectFailure(promise: Promise<unknown>, message?: string): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (failure: unknown) => failure
  );
  expect(error).toBeInstanceOf(Error);
  if (message && error instanceof Error) expect(error.message).toContain(message);
}

test("credential configuration preserves independently updated tool settings", async () => {
  const { service } = await setup();
  await Promise.all([
    service.configure({ toolAllowlist: ["design_test"] }),
    service.configure({ serverEnabled: false }),
  ]);
  const before = await service.getStatus();
  await service.configure({ reuseEnabled: true, source: before.settings.source });
  expect((await service.getStatus()).settings).toMatchObject({
    serverEnabled: false,
    toolAllowlist: ["design_test"],
  });
  await service.configure({ serverEnabled: true });
  await service.configure({ reuseEnabled: false });
  expect((await service.getStatus()).settings).toMatchObject({
    source: before.settings.source,
    serverEnabled: false,
  });
});

test("sequential requests reuse credentials until expiry or settings invalidation", async () => {
  let currentTime = now;
  const readSource = mock(() => Promise.resolve(data()));
  const { service, send } = await setup({
    readSource,
    now: () => currentTime,
    fetch: fakeFetch(() => Promise.resolve(new Response("{}"))),
  });
  await send();
  await send();
  expect(readSource).toHaveBeenCalledTimes(1);
  await service.configure({ toolAllowlist: ["design_test"] });
  await service.transport().fetch?.(CLAUDE_DESIGN_URL, { method: "POST" });
  expect(readSource).toHaveBeenCalledTimes(2);
  currentTime += 60_000;
  await expectFailure(service.transport().fetch!(CLAUDE_DESIGN_URL, { method: "POST" }), "expired");
  expect(readSource).toHaveBeenCalledTimes(3);
});

test("checkout overrides cannot enable Design before the backend user enables its server", async () => {
  const fixture = protocolFixture();
  const readSource = mock(() => Promise.resolve(data()));
  const { service } = await setup({ fetch: fixture.network, readSource });
  await service.configure({ serverEnabled: false });
  const manager = new MCPServerManager(
    new MCPConfigService(new Config(rootDir), { claudeDesign: service })
  );
  const request = {
    workspaceId: "checkout-override",
    projectPath: rootDir,
    workspacePath: rootDir,
    runtime: new LocalRuntime(rootDir),
    trusted: false,
    overrides: { enabledServers: ["claude_design"] },
  };
  try {
    expect(Object.keys((await manager.getToolsForWorkspace(request)).tools)).toHaveLength(0);
    expect(readSource).not.toHaveBeenCalled();
    await service.configure({ serverEnabled: true });
    expect(Object.keys((await manager.getToolsForWorkspace(request)).tools)).toHaveLength(1);
    await service.configure({ serverEnabled: false });
    expect(Object.keys((await manager.getToolsForWorkspace(request)).tools)).toHaveLength(0);
  } finally {
    await manager.stopServers(request.workspaceId);
    manager.dispose();
    await fixture.server.stop(true);
  }
});

test("empty Design allowlist denies every tool, including with workspace enablement", async () => {
  const fixture = protocolFixture();
  const { service } = await setup({ fetch: fixture.network });
  await service.configure({ toolAllowlist: [] });
  const manager = new MCPServerManager(
    new MCPConfigService(new Config(rootDir), { claudeDesign: service })
  );
  try {
    const result = await manager.getToolsForWorkspace({
      workspaceId: "deny-all",
      projectPath: rootDir,
      workspacePath: rootDir,
      runtime: new LocalRuntime(rootDir),
      trusted: true,
      overrides: {
        enabledServers: ["claude_design"],
        toolAllowlist: { claude_design: ["design_test"] },
      },
    });
    expect(Object.keys(result.tools)).toHaveLength(0);
  } finally {
    await manager.stopServers("deny-all");
    manager.dispose();
    await fixture.server.stop(true);
  }
});

test("a sibling disconnect retires a loaded service before it can send again", async () => {
  const network = mock(() => Promise.resolve(new Response("{}")));
  const { service, send } = await setup({ fetch: fakeFetch(network) });
  await send();
  const sibling = new ClaudeDesignService({ rootDir, isEnabled: () => true });
  await sibling.configure({ reuseEnabled: false });
  await expectFailure(send());
  expect(network).toHaveBeenCalledTimes(1);
  expect((await service.getStatus()).settings.reuseEnabled).toBe(false);
  await service.configure({ toolAllowlist: [] });
  expect((await service.getStatus()).settings.reuseEnabled).toBe(false);
});

test.each(["disconnect", "experiment"] as const)(
  "sibling %s aborts an in-flight request through a filesystem notification",
  async (change) => {
    const flags = path.join(rootDir, EXPERIMENT_OVERRIDES_FILE_NAME);
    await fs.writeFile(
      flags,
      JSON.stringify({ version: 1, overrides: { [EXPERIMENT_IDS.CLAUDE_DESIGN_MCP]: true } })
    );
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let aborted = false;
    const { service, send } = await setup({
      readEnabled: () =>
        readPersistedExperimentEnabled(EXPERIMENT_IDS.CLAUDE_DESIGN_MCP, { xumHome: rootDir }),
      fetch: fakeFetch(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new Error("aborted"));
              },
              { once: true }
            );
            entered();
          })
      ),
    });
    const unsubscribe = service.onChange(() => Promise.resolve());
    try {
      const pending = send().catch(() => undefined);
      await started;
      if (change === "disconnect") {
        const sibling = new ClaudeDesignService({ rootDir, isEnabled: () => true });
        await sibling.configure({ reuseEnabled: false });
      } else {
        await fs.writeFile(
          flags,
          JSON.stringify({ version: 1, overrides: { [EXPERIMENT_IDS.CLAUDE_DESIGN_MCP]: false } })
        );
      }
      await pending;
      expect(aborted).toBe(true);
      expect((await service.getStatus()).state).toBe("disabled");
    } finally {
      unsubscribe();
    }
  }
);

test("sibling disconnect during cold tools/list prevents publication", async () => {
  const fixture = protocolFixture();
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const { service } = await setup({
    fetch: fakeFetch(async (input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected fixture request body");
      const body: unknown = JSON.parse(init.body);
      if (body && typeof body === "object" && Reflect.get(body, "method") === "tools/list") {
        entered();
        await released;
      }
      return fixture.network(input, init);
    }),
  });
  const manager = new MCPServerManager(
    new MCPConfigService(new Config(rootDir), { claudeDesign: service })
  );
  try {
    const pending = manager.getToolsForWorkspace({
      workspaceId: "cold-disconnect",
      projectPath: rootDir,
      workspacePath: rootDir,
      runtime: new LocalRuntime(rootDir),
      trusted: true,
    });
    await started;
    const sibling = new ClaudeDesignService({ rootDir, isEnabled: () => true });
    await sibling.configure({ reuseEnabled: false });
    finish();
    expect(Object.keys((await pending).tools)).toHaveLength(0);
    expect((await service.getStatus()).state).toBe("disabled");
  } finally {
    finish();
    await manager.stopServers("cold-disconnect");
    manager.dispose();
    await fixture.server.stop(true);
  }
});
