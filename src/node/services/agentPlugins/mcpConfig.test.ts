import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, spyOn, test } from "bun:test";

import type { MCPStdioServerInfo } from "@/common/types/mcp";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { DisposableTempDir } from "@/node/services/tempDir";
import { Config } from "@/node/config";
import { MCPConfigService } from "@/node/services/mcpConfigService";
import { MCPServerManager } from "@/node/services/mcpServerManager";
import { createTestPluginInstallEntry } from "./testFixtures";
import type { AgentPluginInfo } from "./discovery";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 } from "./manifest";
import {
  AGENT_PLUGIN_MCP_SCHEMA_ID_1_0_0,
  buildPluginServerKey,
  computePluginInstanceId,
  createAgentPluginsMcpProvider,
  getPluginDataPath,
  loadPluginMcpServers,
  resolveAgentPluginsMcpContext,
} from "./mcpConfig";

/** Create a plugin dir on disk and return its AgentPluginInfo. */
async function makePlugin(
  baseDir: string,
  name: string,
  mcpJson: unknown,
  options?: { scope?: "project" | "global" }
): Promise<AgentPluginInfo> {
  const pluginDir = path.join(baseDir, name);
  await fs.mkdir(pluginDir, { recursive: true });
  const rootPath = await fs.realpath(pluginDir);
  const mcpConfigPath = path.join(rootPath, "mcp.json");
  await fs.writeFile(
    mcpConfigPath,
    typeof mcpJson === "string" ? mcpJson : JSON.stringify(mcpJson),
    "utf8"
  );
  return {
    name,
    scope: options?.scope ?? "global",
    rootPath,
    containerPath: baseDir,
    dirName: name,
    manifest: { schemaId: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name },
    mcpConfigPath,
  };
}

function mcpDoc(servers: Record<string, unknown>): unknown {
  return { $schema: AGENT_PLUGIN_MCP_SCHEMA_ID_1_0_0, mcpServers: servers };
}

const STDIO_ENTRY = { type: "stdio", command: "bunx", args: ["-y", "some-server"] };

describe("loadPluginMcpServers", () => {
  test("normalizes a stdio entry: default-disabled, expanded args/env, reserved env last, default cwd", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "demo",
      mcpDoc({
        everything: {
          type: "stdio",
          command: "bunx",
          args: ["--data", "${PLUGIN_DATA}/d", "${PLUGIN_ROOT}"],
          env: { CONFIG: "${PLUGIN_ROOT}/config.json", PLAIN: "x" },
        },
      })
    );

    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    expect(diagnostics).toEqual([]);
    const instanceId = computePluginInstanceId(plugin.rootPath);
    const dataPath = getPluginDataPath(tmp.path, instanceId);
    const key = buildPluginServerKey(instanceId, "everything");
    expect(Object.keys(servers)).toEqual([key]);

    const info = servers[key] as MCPStdioServerInfo;
    expect(info.transport).toBe("stdio");
    expect(info.disabled).toBe(true);
    expect(info.command).toBe("bunx");
    expect(info.args).toEqual(["--data", `${dataPath}/d`, plugin.rootPath]);
    expect(info.env).toEqual({
      CONFIG: `${plugin.rootPath}/config.json`,
      PLAIN: "x",
      PLUGIN_ROOT: plugin.rootPath,
      PLUGIN_DATA: dataPath,
    });
    // Reserved variables are appended last so configured env cannot shadow them.
    expect(Object.keys(info.env ?? {}).slice(-2)).toEqual(["PLUGIN_ROOT", "PLUGIN_DATA"]);
    expect(info.cwd).toBe(plugin.rootPath);
    expect(info.plugin).toEqual({
      pluginName: "demo",
      serverName: "everything",
      sourceScope: "global",
      // Last two container segments + plugin dir (makePlugin's container is tmp.path).
      sourceLocation: path.join(
        path.basename(path.dirname(tmp.path)),
        path.basename(tmp.path),
        "demo"
      ),
    });
  });

  test("maps streamable-http to http and sse to sse; headerless remote entries load", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "remote",
      mcpDoc({
        deploy: { type: "streamable-http", url: "https://deploy.example.com/mcp" },
        legacy: { type: "sse", url: "https://legacy.example.com/sse", headers: {} },
      })
    );

    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    expect(diagnostics).toEqual([]);
    const values = Object.values(servers);
    expect(values.map((s) => s.transport).sort()).toEqual(["http", "sse"]);
  });

  test("skips remote entries with configured headers (redirect conformance) with a warning", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "remote-headers",
      mcpDoc({
        withHeaders: {
          type: "streamable-http",
          url: "https://x.example.com/mcp",
          headers: { "X-Tenant": "t" },
        },
        plain: { type: "streamable-http", url: "https://y.example.com/mcp" },
      })
    );

    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    expect(Object.values(servers)).toHaveLength(1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe("warning");
    expect(diagnostics[0].message).toContain("headers");
  });

  test("disables MCP for the plugin on invalid JSON / bad top-level / $schema mismatch", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");

    const cases: Array<{ doc: unknown; messagePart: string }> = [
      { doc: "{ not json", messagePart: "not valid JSON" },
      { doc: [1, 2], messagePart: "must be a JSON object" },
      {
        doc: { $schema: AGENT_PLUGIN_MCP_SCHEMA_ID_1_0_0, mcpServers: {}, extra: 1 },
        messagePart: "unknown top-level field 'extra'",
      },
      { doc: { mcpServers: {} }, messagePart: "'$schema'" },
      {
        doc: {
          $schema: "https://agent-plugins.org/schemas/9.0.0/mcp.schema.json",
          mcpServers: {},
        },
        messagePart: "'$schema'",
      },
      { doc: { $schema: AGENT_PLUGIN_MCP_SCHEMA_ID_1_0_0 }, messagePart: "'mcpServers'" },
    ];

    for (const [index, testCase] of cases.entries()) {
      const plugin = await makePlugin(tmp.path, `bad-${index}`, testCase.doc);
      const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });
      expect(servers).toEqual({});
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].severity).toBe("error");
      expect(diagnostics[0].message).toContain(testCase.messagePart);
    }
  });

  test("disables MCP for the plugin on an oversized mcp.json", async () => {
    // Server summaries built from mcp.json reach the install consent
    // preview's IPC/render path: an unbounded document must disable MCP for
    // this plugin instead of shipping megabytes of text to the renderer.
    using tmp = new DisposableTempDir("plugin-mcp");
    const oversized = JSON.stringify({
      $schema: AGENT_PLUGIN_MCP_SCHEMA_ID_1_0_0,
      mcpServers: {
        big: { type: "stdio", command: "bunx", args: ["x".repeat(512 * 1024)] },
      },
    });
    const plugin = await makePlugin(tmp.path, "oversized", oversized);
    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });
    expect(servers).toEqual({});
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe("error");
    expect(diagnostics[0].message).toContain("too large");
  });

  test("disables MCP when mcp.json is a symlink escaping the plugin root", async () => {
    // A managed update can replace a consented regular mcp.json with an
    // absolute symlink to attacker-chosen content outside the plugin root
    // (staged validation only rejects links into the managed container). The
    // consuming read must refuse to follow it: this document defines
    // spawnable commands, so following the link would let outside config be
    // parsed and its command spawned during the promotion race.
    using tmp = new DisposableTempDir("plugin-mcp");
    const outside = path.join(tmp.path, "outside-mcp.json");
    await fs.writeFile(
      outside,
      JSON.stringify(mcpDoc({ evil: { type: "stdio", command: "sh" } })),
      "utf8"
    );
    const plugin = await makePlugin(tmp.path, "symlinked", mcpDoc({}));
    await fs.rm(plugin.mcpConfigPath!);
    await fs.symlink(outside, plugin.mcpConfigPath!);
    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });
    expect(servers).toEqual({});
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe("error");
    expect(diagnostics[0].message).toContain("outside containment root");
  });

  test("an empty mcpServers object is valid", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(tmp.path, "empty", mcpDoc({}));
    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });
    expect(servers).toEqual({});
    expect(diagnostics).toEqual([]);
  });

  test("skips invalid entries individually while loading valid siblings (§7.2.2)", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "mixed",
      mcpDoc({
        notObject: "nope",
        unknownType: { type: "websocket", url: "wss://x" },
        unknownField: { ...STDIO_ENTRY, extra: true },
        wrongVariantField: { type: "stdio", command: "x", url: "https://x" },
        good: STDIO_ENTRY,
      })
    );

    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    const instanceId = computePluginInstanceId(plugin.rootPath);
    expect(Object.keys(servers)).toEqual([buildPluginServerKey(instanceId, "good")]);
    expect(diagnostics).toHaveLength(4);
  });

  test("rejects non-token commands: shell strings, absolute/parent/backslash paths", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    for (const command of ["/usr/bin/env", "bin/tool", "../tool", "bin\\tool", ""]) {
      const plugin = await makePlugin(
        tmp.path,
        `cmd-${Buffer.from(command).toString("hex")}`,
        mcpDoc({ srv: { type: "stdio", command } })
      );
      const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });
      expect(servers).toEqual({});
      expect(diagnostics[0].message).toContain("executable token");
    }
  });

  test("resolves './'-relative commands inside the plugin root", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "rel-cmd",
      mcpDoc({ srv: { type: "stdio", command: "./bin/tool" } })
    );
    await fs.mkdir(path.join(plugin.rootPath, "bin"), { recursive: true });
    // mode 0o755: normalization verifies the execute bit on POSIX.
    await fs.writeFile(path.join(plugin.rootPath, "bin", "tool"), "#!/bin/sh\n", {
      encoding: "utf8",
      mode: 0o755,
    });

    const { servers } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    const info = Object.values(servers)[0] as MCPStdioServerInfo;
    expect(info.command).toBe(path.join(plugin.rootPath, "bin", "tool"));
  });

  test("invalidates entries whose './'-relative command is missing or symlink-escapes the root", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");

    const missing = await makePlugin(
      tmp.path,
      "missing-cmd",
      mcpDoc({ srv: { type: "stdio", command: "./bin/nope" } })
    );
    const missingResult = await loadPluginMcpServers(missing, { xumHome: tmp.path });
    expect(missingResult.servers).toEqual({});
    expect(missingResult.diagnostics[0].message).toContain("does not exist");

    const outside = path.join(tmp.path, "outside-tool");
    await fs.writeFile(outside, "#!/bin/sh\n", "utf8");
    const escaping = await makePlugin(
      tmp.path,
      "escaping-cmd",
      mcpDoc({ srv: { type: "stdio", command: "./tool" } })
    );
    await fs.symlink(outside, path.join(escaping.rootPath, "tool"));
    const escapeResult = await loadPluginMcpServers(escaping, { xumHome: tmp.path });
    expect(escapeResult.servers).toEqual({});
    expect(escapeResult.diagnostics[0].message).toContain("outside the plugin root");
  });

  test("rejects a './'-relative command that resolves to a directory (exec would fail)", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "dir-cmd",
      mcpDoc({ srv: { type: "stdio", command: "./bin" } })
    );
    await fs.mkdir(path.join(plugin.rootPath, "bin"), { recursive: true });

    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    expect(servers).toEqual({});
    expect(diagnostics[0].message).toContain("must be a file");
  });

  test("rejects bare commands containing whitespace or control characters", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    for (const [index, command] of ["node --version", " ", "no\tde", "no\nde"].entries()) {
      const plugin = await makePlugin(
        tmp.path,
        `ws-cmd-${index}`,
        mcpDoc({ srv: { type: "stdio", command } })
      );

      const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

      expect(servers).toEqual({});
      expect(diagnostics[0].message).toContain("single executable token");
    }
  });

  test.skipIf(process.platform === "win32")(
    "rejects a './'-relative command without the execute bit",
    async () => {
      using tmp = new DisposableTempDir("plugin-mcp");
      const plugin = await makePlugin(
        tmp.path,
        "noexec-cmd",
        mcpDoc({ srv: { type: "stdio", command: "./tool" } })
      );
      await fs.writeFile(path.join(plugin.rootPath, "tool"), "#!/bin/sh\n", {
        encoding: "utf8",
        mode: 0o644,
      });

      const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

      expect(servers).toEqual({});
      expect(diagnostics[0].message).toContain("not executable");
    }
  );

  test("rejects NUL bytes in args, env entries, cwd, and relative commands", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const cases: Array<{ entry: Record<string, unknown>; expect: string }> = [
      { entry: { type: "stdio", command: "x", args: ["a\0b"] }, expect: "NUL" },
      { entry: { type: "stdio", command: "x", env: { KEY: "a\0b" } }, expect: "NUL" },
      { entry: { type: "stdio", command: "x", env: { "K\0EY": "v" } }, expect: "NUL" },
      { entry: { type: "stdio", command: "x", cwd: "./a\0b" }, expect: "NUL" },
      { entry: { type: "stdio", command: "./a\0b" }, expect: "single executable token" },
    ];
    for (const [index, testCase] of cases.entries()) {
      const plugin = await makePlugin(tmp.path, `nul-${index}`, mcpDoc({ srv: testCase.entry }));

      const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

      expect(servers).toEqual({});
      expect(diagnostics[0].message).toContain(testCase.expect);
    }
  });

  test("rejects entries with reserved env keys (PLUGIN_ROOT / PLUGIN_DATA)", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    for (const key of ["PLUGIN_ROOT", "PLUGIN_DATA"]) {
      const plugin = await makePlugin(
        tmp.path,
        `reserved-${key.toLowerCase()}`,
        mcpDoc({ srv: { type: "stdio", command: "x", env: { [key]: "/y" } } })
      );
      const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });
      expect(servers).toEqual({});
      expect(diagnostics[0].message).toContain(key);
    }
  });

  test("accepts every valid cwd form", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "cwd-forms",
      mcpDoc({
        rel: { type: "stdio", command: "x", cwd: "./sub" },
        rootExact: { type: "stdio", command: "x", cwd: "${PLUGIN_ROOT}" },
        rootSub: { type: "stdio", command: "x", cwd: "${PLUGIN_ROOT}/sub" },
        dataExact: { type: "stdio", command: "x", cwd: "${PLUGIN_DATA}" },
        dataSub: { type: "stdio", command: "x", cwd: "${PLUGIN_DATA}/nested" },
      })
    );
    await fs.mkdir(path.join(plugin.rootPath, "sub"), { recursive: true });

    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    expect(diagnostics).toEqual([]);
    const instanceId = computePluginInstanceId(plugin.rootPath);
    const dataPath = getPluginDataPath(tmp.path, instanceId);
    const cwdOf = (name: string) =>
      (servers[buildPluginServerKey(instanceId, name)] as MCPStdioServerInfo).cwd;
    expect(cwdOf("rel")).toBe(path.join(plugin.rootPath, "sub"));
    expect(cwdOf("rootExact")).toBe(plugin.rootPath);
    expect(cwdOf("rootSub")).toBe(path.join(plugin.rootPath, "sub"));
    expect(cwdOf("dataExact")).toBe(dataPath);
    expect(cwdOf("dataSub")).toBe(path.join(dataPath, "nested"));
  });

  test("rejects invalid cwd forms, post-resolution escapes, and missing plugin-root cwds", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const cases: Array<{ cwd: string; messagePart: string }> = [
      { cwd: "sub", messagePart: "'cwd' must be" },
      { cwd: "/abs", messagePart: "'cwd' must be" },
      { cwd: "../up", messagePart: "'cwd' must be" },
      { cwd: "./..", messagePart: "escapes" },
      { cwd: "./sub/../../up", messagePart: "escapes" },
      { cwd: "${PLUGIN_ROOT}/../up", messagePart: "escapes" },
      { cwd: "${PLUGIN_DATA}/..", messagePart: "escapes" },
      // Plugin-root cwds are shipped content: launch only creates PLUGIN_DATA
      // dirs and exec() rejects a missing cwd, so these entries are invalid.
      { cwd: "./missing", messagePart: "does not exist" },
      { cwd: "${PLUGIN_ROOT}/missing", messagePart: "does not exist" },
    ];
    for (const [index, testCase] of cases.entries()) {
      const plugin = await makePlugin(
        tmp.path,
        `bad-cwd-${index}`,
        mcpDoc({ srv: { type: "stdio", command: "x", cwd: testCase.cwd } })
      );
      const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });
      expect(servers).toEqual({});
      expect(diagnostics[0].message).toContain(testCase.messagePart);
    }
  });

  test("rejects a cwd that resolves to a file (exec would fail with ENOTDIR)", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "cwd-file",
      mcpDoc({
        rel: { type: "stdio", command: "x", cwd: "./afile" },
        rooted: { type: "stdio", command: "x", cwd: "${PLUGIN_ROOT}/afile" },
      })
    );
    await fs.writeFile(path.join(plugin.rootPath, "afile"), "not a dir", "utf8");

    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    expect(servers).toEqual({});
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.every((d) => d.message.includes("must be a directory"))).toBe(true);
  });

  test("rejects a data-anchored cwd whose existing target is a file", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "data-cwd-file",
      mcpDoc({ srv: { type: "stdio", command: "x", cwd: "${PLUGIN_DATA}/blob" } })
    );
    const dataPath = getPluginDataPath(tmp.path, computePluginInstanceId(plugin.rootPath));
    await fs.mkdir(dataPath, { recursive: true });
    await fs.writeFile(path.join(dataPath, "blob"), "not a dir", "utf8");

    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    expect(servers).toEqual({});
    expect(diagnostics[0].message).toContain("must be a directory");
  });

  test("rejects a cwd that symlink-escapes the plugin root", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const outsideDir = path.join(tmp.path, "outside-dir");
    await fs.mkdir(outsideDir, { recursive: true });
    const plugin = await makePlugin(
      tmp.path,
      "cwd-symlink",
      mcpDoc({ srv: { type: "stdio", command: "x", cwd: "./link" } })
    );
    await fs.symlink(outsideDir, path.join(plugin.rootPath, "link"));

    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    expect(servers).toEqual({});
    expect(diagnostics[0].message).toContain("escapes");
  });

  test("validates remote URLs: userinfo, fragment, non-loopback http rejected; loopback http accepted", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "urls",
      mcpDoc({
        userinfo: { type: "streamable-http", url: "https://user:pw@x.example.com/mcp" },
        fragment: { type: "streamable-http", url: "https://x.example.com/mcp#frag" },
        plainHttp: { type: "streamable-http", url: "http://x.example.com/mcp" },
        relative: { type: "streamable-http", url: "/mcp" },
        ftp: { type: "streamable-http", url: "ftp://x.example.com/mcp" },
        localhostHttp: { type: "streamable-http", url: "http://localhost:3000/mcp" },
        loopbackIp: { type: "streamable-http", url: "http://127.0.0.1:3000/mcp" },
        loopbackV6: { type: "streamable-http", url: "http://[::1]:3000/mcp" },
      })
    );

    const { servers } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    const instanceId = computePluginInstanceId(plugin.rootPath);
    const loaded = Object.keys(servers).sort();
    expect(loaded).toEqual(
      ["localhostHttp", "loopbackIp", "loopbackV6"]
        .map((name) => buildPluginServerKey(instanceId, name))
        .sort()
    );
  });

  test("rejects duplicate case-insensitive header names and invalid header fields", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "headers",
      mcpDoc({
        dupes: {
          type: "streamable-http",
          url: "https://x.example.com/mcp",
          headers: { "X-Tenant": "a", "x-tenant": "b" },
        },
        badName: {
          type: "streamable-http",
          url: "https://x.example.com/mcp",
          headers: { "Bad Name": "a" },
        },
        badValue: {
          type: "streamable-http",
          url: "https://x.example.com/mcp",
          headers: { "X-Ok": "a\r\nInjected: b" },
        },
      })
    );

    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    expect(servers).toEqual({});
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.every((d) => d.severity === "error")).toBe(true);
  });

  test("server keys and PLUGIN_DATA are stable across manifest renames and content changes", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(tmp.path, "stable", mcpDoc({ srv: STDIO_ENTRY }));

    const first = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    // Simulate a manifest rename + version bump: same root path.
    const renamed: AgentPluginInfo = {
      ...plugin,
      name: "renamed-plugin",
      manifest: { schemaId: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "renamed-plugin", version: "2.0" },
    };
    const second = await loadPluginMcpServers(renamed, { xumHome: tmp.path });

    expect(Object.keys(second.servers)).toEqual(Object.keys(first.servers));
    expect(Object.keys(first.servers)).toHaveLength(1);
    const firstInfo = Object.values(first.servers)[0] as MCPStdioServerInfo;
    const secondInfo = Object.values(second.servers)[0] as MCPStdioServerInfo;
    expect(secondInfo.env?.PLUGIN_DATA).toBe(firstInfo.env?.PLUGIN_DATA);
  });

  test("duplicate plugin names in different roots get distinct keys and data dirs", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const a = await makePlugin(path.join(tmp.path, "a"), "same-name", mcpDoc({ srv: STDIO_ENTRY }));
    const b = await makePlugin(path.join(tmp.path, "b"), "same-name", mcpDoc({ srv: STDIO_ENTRY }));

    const resultA = await loadPluginMcpServers(a, { xumHome: tmp.path });
    const resultB = await loadPluginMcpServers(b, { xumHome: tmp.path });

    const keyA = Object.keys(resultA.servers)[0];
    const keyB = Object.keys(resultB.servers)[0];
    expect(keyA).not.toBe(keyB);
    const dataA = (Object.values(resultA.servers)[0] as MCPStdioServerInfo).env?.PLUGIN_DATA;
    const dataB = (Object.values(resultB.servers)[0] as MCPStdioServerInfo).env?.PLUGIN_DATA;
    expect(dataA).not.toBe(dataB);
    // Displayed provenance must also distinguish the two installations.
    const locA = (Object.values(resultA.servers)[0] as MCPStdioServerInfo).plugin?.sourceLocation;
    const locB = (Object.values(resultB.servers)[0] as MCPStdioServerInfo).plugin?.sourceLocation;
    expect(locA).not.toBe(locB);
  });
});

async function withHomeDir(homeDir: string, callback: () => Promise<void>): Promise<void> {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const homedirSpy = spyOn(os, "homedir");

  homedirSpy.mockReturnValue(homeDir);
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  try {
    await callback();
  } finally {
    homedirSpy.mockRestore();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
}

async function writeDiscoverablePlugin(
  containerPath: string,
  name: string,
  mcpJson: unknown
): Promise<void> {
  const pluginDir = path.join(containerPath, name);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "plugin.json"),
    JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name }),
    "utf8"
  );
  await fs.writeFile(
    path.join(pluginDir, "mcp.json"),
    typeof mcpJson === "string" ? mcpJson : JSON.stringify(mcpJson),
    "utf8"
  );
}

describe("createAgentPluginsMcpProvider", () => {
  test.each([".xum", ".mux"])(
    "overlapping %s project containers cannot bypass managed MCP imports via overrides",
    async (metadataDir) => {
      using home = new DisposableTempDir("plugin-mcp-container-overlap");
      await withHomeDir(home.path, async () => {
        const xumHome = path.join(home.path, metadataDir);
        await writeDiscoverablePlugin(
          path.join(xumHome, "plugins"),
          "managed",
          mcpDoc({
            allowed: STDIO_ENTRY,
            blocked: STDIO_ENTRY,
          })
        );
        await writeDiscoverablePlugin(
          path.join(home.path, ".agents", "plugins"),
          "project-only",
          mcpDoc({ unmanaged: STDIO_ENTRY })
        );
        const provider = createAgentPluginsMcpProvider({ xumHome, isEnabled: () => true });
        const context = { projectRoot: home.path, projectKey: home.path };
        const unfiltered = await provider({ ...context, trusted: true });
        const keyFor = (name: string) => {
          const key = Object.entries(unfiltered).find(
            ([, info]) => info.plugin?.serverName === name
          )?.[0];
          if (key === undefined) throw new Error(`Fixture server ${name} missing`);
          return key;
        };
        const overrides = { enabledServers: Object.keys(unfiltered) };
        const registryPath = path.join(xumHome, "plugins.json");
        await fs.writeFile(
          registryPath,
          JSON.stringify({
            plugins: [
              createTestPluginInstallEntry("managed", { skills: [], mcpServers: ["allowed"] }),
            ],
          })
        );
        const manager = new MCPServerManager(
          new MCPConfigService(new Config(xumHome), { agentPluginsMcpProvider: provider })
        );
        try {
          const servers = await manager.listServers(home.path, overrides, true, context);
          expect(Object.keys(servers).sort()).toEqual(
            [keyFor("allowed"), keyFor("unmanaged")].sort()
          );
          const loaded = await provider({ ...context, trusted: true });
          expect(loaded[keyFor("allowed")]?.plugin?.sourceScope).toBe("project");
          expect(loaded[keyFor("blocked")]).toBeUndefined();
          await fs.writeFile(registryPath, "{");
          expect(
            Object.keys(await manager.listServers(home.path, overrides, true, context))
          ).toEqual([keyFor("unmanaged")]);
        } finally {
          manager.dispose();
        }
      });
    }
  );

  test("returns no servers when the experiment is disabled", async () => {
    using home = new DisposableTempDir("plugin-provider-home");
    using xumHome = new DisposableTempDir("plugin-provider-mux");
    await withHomeDir(home.path, async () => {
      await writeDiscoverablePlugin(
        path.join(xumHome.path, "plugins"),
        "demo",
        mcpDoc({ srv: STDIO_ENTRY })
      );

      const provider = createAgentPluginsMcpProvider({
        xumHome: xumHome.path,
        isEnabled: () => false,
      });
      expect(await provider({ trusted: false })).toEqual({});
    });
  });

  test("discovers global plugin servers and gates project containers on trust", async () => {
    using home = new DisposableTempDir("plugin-provider-home");
    using xumHome = new DisposableTempDir("plugin-provider-mux");
    using project = new DisposableTempDir("plugin-provider-project");
    await withHomeDir(home.path, async () => {
      await writeDiscoverablePlugin(
        path.join(xumHome.path, "plugins"),
        "global-plugin",
        mcpDoc({ srv: STDIO_ENTRY })
      );
      await writeDiscoverablePlugin(
        path.join(home.path, ".agents", "plugins"),
        "universal-plugin",
        mcpDoc({ srv: STDIO_ENTRY })
      );
      await writeDiscoverablePlugin(
        path.join(project.path, ".mux", "plugins"),
        "project-plugin",
        mcpDoc({ srv: STDIO_ENTRY })
      );

      const provider = createAgentPluginsMcpProvider({
        xumHome: xumHome.path,
        isEnabled: () => true,
      });

      const pluginNamesOf = (servers: Record<string, { plugin?: { pluginName: string } }>) =>
        Object.values(servers)
          .map((s) => s.plugin?.pluginName)
          .sort();

      // Untrusted project: only global containers contribute.
      const untrusted = await provider({ projectRoot: project.path, trusted: false });
      expect(pluginNamesOf(untrusted)).toEqual(["global-plugin", "universal-plugin"]);

      // Trusted project: project containers contribute too.
      const trusted = await provider({ projectRoot: project.path, trusted: true });
      expect(pluginNamesOf(trusted)).toEqual([
        "global-plugin",
        "project-plugin",
        "universal-plugin",
      ]);

      // No project at all: global only.
      const globalOnly = await provider({ trusted: false });
      expect(pluginNamesOf(globalOnly)).toEqual(["global-plugin", "universal-plugin"]);
    });
  });

  test("global plugin identity survives symlink retargeting (versioned installs)", async () => {
    using home = new DisposableTempDir("plugin-provider-home");
    using xumHome = new DisposableTempDir("plugin-provider-mux");
    await withHomeDir(home.path, async () => {
      // Versioned install layout: plugins/demo is a symlink an updater
      // retargets from v1 to v2. The realpath changes; identity must not.
      const versions = path.join(xumHome.path, "versions");
      await writeDiscoverablePlugin(versions, "v1", mcpDoc({ srv: STDIO_ENTRY }));
      await writeDiscoverablePlugin(versions, "v2", mcpDoc({ srv: STDIO_ENTRY }));
      const container = path.join(xumHome.path, "plugins");
      await fs.mkdir(container, { recursive: true });
      const link = path.join(container, "demo");
      await fs.symlink(path.join(versions, "v1"), link);

      const provider = createAgentPluginsMcpProvider({
        xumHome: xumHome.path,
        isEnabled: () => true,
      });

      const before = Object.keys(await provider({ trusted: false })).sort();
      expect(before).toHaveLength(1);

      await fs.unlink(link);
      await fs.symlink(path.join(versions, "v2"), link);

      const after = Object.keys(await provider({ trusted: false })).sort();
      expect(after).toEqual(before);
    });
  });

  test("a plugin with broken mcp.json never affects sibling plugins", async () => {
    using home = new DisposableTempDir("plugin-provider-home");
    using xumHome = new DisposableTempDir("plugin-provider-mux");
    await withHomeDir(home.path, async () => {
      const container = path.join(xumHome.path, "plugins");
      await writeDiscoverablePlugin(container, "broken", "{ not json");
      await writeDiscoverablePlugin(container, "healthy", mcpDoc({ srv: STDIO_ENTRY }));

      const provider = createAgentPluginsMcpProvider({
        xumHome: xumHome.path,
        isEnabled: () => true,
      });
      const servers = await provider({ trusted: false });

      expect(Object.values(servers).map((s) => s.plugin?.pluginName)).toEqual(["healthy"]);
    });
  });

  test("project plugin keys are stable across checkouts of the same project", async () => {
    using home = new DisposableTempDir("plugin-provider-home");
    using xumHome = new DisposableTempDir("plugin-provider-mux");
    using projectDir = new DisposableTempDir("plugin-provider-checkout-a");
    using worktreeDir = new DisposableTempDir("plugin-provider-checkout-b");
    await withHomeDir(home.path, async () => {
      // The worktree has already migrated to .xum while the project checkout
      // still uses .mux; both locations must retain one persisted identity.
      await writeDiscoverablePlugin(
        path.join(projectDir.path, ".mux", "plugins"),
        "shared-plugin",
        mcpDoc({ srv: STDIO_ENTRY })
      );
      await writeDiscoverablePlugin(
        path.join(worktreeDir.path, ".xum", "plugins"),
        "shared-plugin",
        mcpDoc({ srv: STDIO_ENTRY })
      );

      const provider = createAgentPluginsMcpProvider({
        xumHome: xumHome.path,
        isEnabled: () => true,
      });

      // Engine flow: scans the worktree, keys by the project identity.
      const fromWorktree = await provider({
        projectRoot: worktreeDir.path,
        projectKey: projectDir.path,
        trusted: true,
      });
      // UI flow (Settings / workspace modal): scans the project checkout.
      const fromProject = await provider({
        projectRoot: projectDir.path,
        projectKey: projectDir.path,
        trusted: true,
      });

      expect(Object.keys(fromWorktree)).toHaveLength(1);
      expect(Object.keys(fromWorktree)).toEqual(Object.keys(fromProject));

      // PLUGIN_DATA is shared too, but PLUGIN_ROOT follows the scanned checkout.
      const worktreeInfo = Object.values(fromWorktree)[0] as MCPStdioServerInfo;
      const projectInfo = Object.values(fromProject)[0] as MCPStdioServerInfo;
      expect(worktreeInfo.env?.PLUGIN_DATA).toBe(projectInfo.env?.PLUGIN_DATA ?? "");
      expect(worktreeInfo.env?.PLUGIN_ROOT).toBe(
        path.join(await fs.realpath(worktreeDir.path), ".xum", "plugins", "shared-plugin")
      );
      expect(projectInfo.env?.PLUGIN_ROOT).toBe(
        path.join(await fs.realpath(projectDir.path), ".mux", "plugins", "shared-plugin")
      );

      // A different project identity yields different keys even for the same rel path.
      const otherProject = await provider({
        projectRoot: projectDir.path,
        projectKey: "/some/other/project",
        trusted: true,
      });
      expect(Object.keys(otherProject)).not.toEqual(Object.keys(fromProject));
    });
  });
});

describe("resolveAgentPluginsMcpContext", () => {
  const projectPath = "/home/user/projects/my-app";
  const workspacePath = "/home/user/.mux/src/my-app/feature-branch";

  function createMetadata(
    runtimeConfig: WorkspaceMetadata["runtimeConfig"],
    extra?: Partial<WorkspaceMetadata>
  ): WorkspaceMetadata {
    return {
      id: "workspace-id",
      name: "feature-branch",
      projectName: "my-app",
      projectPath,
      runtimeConfig,
      ...extra,
    };
  }

  test("scans the active checkout keyed by the project for host runtimes", () => {
    for (const runtimeConfig of [
      { type: "local" } as const,
      { type: "worktree", srcBaseDir: "/home/user/.mux/src" } as const,
    ]) {
      expect(resolveAgentPluginsMcpContext(createMetadata(runtimeConfig), workspacePath)).toEqual({
        projectRoot: workspacePath,
        projectKey: projectPath,
      });
    }
  });

  test("returns null for workspaces that exec off-host", () => {
    const offHostConfigs: Array<WorkspaceMetadata["runtimeConfig"]> = [
      { type: "ssh", host: "remote", srcBaseDir: "/home/remote/.mux/src" },
      { type: "docker", image: "ubuntu:22.04" },
      // Devcontainer checkouts are host paths, but exec runs inside the container.
      { type: "devcontainer", configPath: ".devcontainer/devcontainer.json" },
    ];
    for (const runtimeConfig of offHostConfigs) {
      expect(
        resolveAgentPluginsMcpContext(createMetadata(runtimeConfig), workspacePath)
      ).toBeNull();
    }

    // Multi-project fan-out execs per-project; the shared root is not a checkout.
    expect(
      resolveAgentPluginsMcpContext(
        createMetadata(
          { type: "local" },
          {
            projects: [
              { projectPath: "/proj/a", projectName: "a" },
              { projectPath: "/proj/b", projectName: "b" },
            ],
          }
        ),
        workspacePath
      )
    ).toBeNull();
  });
});
