import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { summarizeContinuousCompaction } from "../continuousCompactionSummary";
import { createAgentSessionHarness } from "../agentSession.testHarness";
import { attachLanguageModelCleanup } from "../languageModelCleanup";
import { createMuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import { sharedDurableEventJournal } from "@/node/utils/journal/durableEventJournal";
/**
 * QuickJS-heavy integration tests for Tier-1 sandboxed plugin hooks: real
 * hooks.js files, real sandbox mounts, real spine middleware. Runs in an
 * isolated CI process (see .github/workflows/pr.yml) like the other
 * QuickJS-backed suites.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { tool, type Tool } from "ai";
import { z } from "zod";
import type { Runtime } from "@/node/runtime/Runtime";
import {
  EventSpine,
  eventSpine,
  type RequestAssembleContext,
  type ToolExecuteContext,
} from "@/node/services/events/eventSpine";
import { HistoryService } from "@/node/services/historyService";
import { SandboxHostService, type SandboxMount } from "@/node/services/sandbox/sandboxHostService";
import { DisposableTempDir } from "@/node/services/tempDir";
import {
  appendReplayFixtureTurn,
  createReplayFixtureSessionContext,
  flushReplayFixtureDevtools,
  REPLAY_FIXTURE_MODEL,
  REPLAY_FIXTURE_WORKSPACE_ID,
} from "@/node/services/replay/replayFixture";
import { collectFullHistory, replayVerifySession } from "@/node/services/replay/replayVerify";
import { DurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import {
  AgentPluginHookService,
  agentPluginHookService,
  readHookSourceCapped,
} from "./hookService";
import { bumpContainerMutationEpoch, STAGING_DIR_NAME } from "./journals";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 } from "./manifest";

const WORKSPACE_ID = "plugin-hooks-test";

// Plugin hook middleware never touches the host runtime; a null-backed stub
// is sufficient (same pattern as eventSpine.test.ts).
const stubRuntime = null as unknown as Runtime;

interface Harness {
  tmp: DisposableTempDir;
  container: string;
  sessionDir: string;
  spine: EventSpine;
  sandboxHost: SandboxHostService;
  journal: DurableEventJournal;
  service: AgentPluginHookService;
  ensure(overrides?: { enabled?: boolean; journal?: DurableEventJournal }): Promise<void>;
}

const harnesses: Harness[] = [];

async function createHarness(opts?: {
  hookTimeoutMs?: number;
  spine?: EventSpine;
}): Promise<Harness> {
  const tmp = new DisposableTempDir("plugin-hooks");
  const container = path.join(tmp.path, "plugins");
  const sessionDir = path.join(tmp.path, "session");
  await fs.mkdir(container, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });
  const spine = opts?.spine ?? new EventSpine();
  const sandboxHost = new SandboxHostService();
  const journal = new DurableEventJournal(sessionDir);
  const service = new AgentPluginHookService({
    spine,
    sandboxHost,
    ...(opts?.hookTimeoutMs !== undefined ? { hookTimeoutMs: opts.hookTimeoutMs } : {}),
    // Pin discovery to the temp container so plugins installed on the host
    // machine can never leak into the test.
    computeContainers: () => [{ path: container, scope: "global" }],
  });
  const harness: Harness = {
    tmp,
    container,
    sessionDir,
    spine,
    sandboxHost,
    journal,
    service,
    ensure: (overrides) =>
      service.ensureWorkspaceHooks({
        workspaceId: WORKSPACE_ID,
        sessionDir,
        journal: overrides?.journal ?? journal,
        enabled: overrides?.enabled ?? true,
        xumHome: tmp.path,
        projectTrusted: false,
      }),
  };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0, harnesses.length)) {
    await harness.service.disposeWorkspace(WORKSPACE_ID);
    harness.sandboxHost.disposeAll();
    harness.tmp[Symbol.dispose]();
  }
});

async function writeHookPlugin(
  container: string,
  name: string,
  hooksJs: string,
  opts?: { tools?: string[] }
): Promise<void> {
  const dir = path.join(container, name);
  await fs.mkdir(dir, { recursive: true });
  const manifest = {
    $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
    name,
    ...(opts?.tools !== undefined ? { extensions: { mux: { hooks: { tools: opts.tools } } } } : {}),
  };
  await fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest), "utf8");
  await fs.writeFile(path.join(dir, "hooks.js"), hooksJs, "utf8");
}

function makeToolCtx(
  toolName: string,
  args: unknown,
  workspaceId: string = WORKSPACE_ID
): ToolExecuteContext {
  return {
    toolName,
    args,
    host: {
      runtime: stubRuntime,
      runtimeTempDir: "/tmp",
      cwd: "/repo",
      workspaceId,
    },
    executed: false,
  };
}

/** Run the tool.execute waterfall with a terminal that records execution. */
async function runTool(spine: EventSpine, ctx: ToolExecuteContext): Promise<void> {
  await spine.run("tool.execute", ctx, (c) => {
    c.result = { ok: true, argsSeen: c.args };
    c.executed = true;
  });
}

function blockedError(ctx: ToolExecuteContext): string {
  expect(ctx.blocked).toBeDefined();
  const result = ctx.blocked?.result as { error?: unknown };
  expect(typeof result.error).toBe("string");
  return result.error as string;
}

describe("readHookSourceCapped", () => {
  test("enforces the hook size ceiling at the read itself", async () => {
    // Discovery's stat-based cap and the consuming read are separated by an
    // update-sized TOCTOU window (a managed update can promote a replacement
    // hooks.js between them), so the ceiling must hold at read time: an
    // oversized source is refused, a normal one round-trips byte-exact.
    using tmp = new DisposableTempDir("hook-source-cap");
    const smallPath = path.join(tmp.path, "hooks.js");
    await fs.writeFile(smallPath, "({ 'tool.execute.before': () => undefined })", "utf8");
    expect(await readHookSourceCapped(smallPath, tmp.path)).toBe(
      "({ 'tool.execute.before': () => undefined })"
    );

    const bigPath = path.join(tmp.path, "big-hooks.js");
    await fs.writeFile(bigPath, `// ${"x".repeat(2 * 1024 * 1024)}\n({})`, "utf8");
    // try/catch instead of .rejects: bun:test types trip await-thenable.
    try {
      await readHookSourceCapped(bigPath, tmp.path);
      expect.unreachable("an oversized hooks.js must be refused at read time");
    } catch (error) {
      expect((error as Error).message).toContain("too large");
    }
  });

  test("follows a CONTAINED hooks.js symlink but refuses one escaping the plugin root", async () => {
    // Consent-time validation (staging + discovery) accepts relative symlinks
    // that stay inside the plugin, so the consuming read must too — but a
    // replacement link whose target resolves OUTSIDE the plugin root (staged
    // validation reads that as a capability removal) must be refused instead
    // of evaluating the outside file as hook code.
    using tmp = new DisposableTempDir("hook-source-symlink");
    const root = path.join(tmp.path, "plugin-root");
    await fs.mkdir(root);
    const inside = path.join(root, "impl.js");
    await fs.writeFile(inside, "({ 'tool.execute.before': () => undefined })", "utf8");
    const containedLink = path.join(root, "hooks.js");
    await fs.symlink(inside, containedLink);
    expect(await readHookSourceCapped(containedLink, root)).toContain("tool.execute.before");

    const outside = path.join(tmp.path, "outside.js");
    await fs.writeFile(outside, "({ 'tool.execute.before': () => undefined })", "utf8");
    const escapingLink = path.join(root, "escaping-hooks.js");
    await fs.symlink(outside, escapingLink);
    try {
      await readHookSourceCapped(escapingLink, root);
      expect.unreachable("a hooks.js symlink escaping the plugin root must be refused");
    } catch (error) {
      expect((error as Error).message).toContain("outside containment root");
    }
  });

  test("refuses a hooks.js reached through a symlinked ancestor directory", async () => {
    // The leaf lstat check cannot catch a replacement symlink at an ANCESTOR
    // component (lib/hooks.js where `lib` becomes a link to an outside dir):
    // lstat follows ancestor links and reports the outside file as regular
    // with matching dev/ino. The post-open containment recheck must reject
    // the resolved path escaping the plugin root.
    using tmp = new DisposableTempDir("hook-source-ancestor-symlink");
    const outsideDir = path.join(tmp.path, "outside");
    await fs.mkdir(outsideDir);
    await fs.writeFile(
      path.join(outsideDir, "hooks.js"),
      "({ 'tool.execute.before': () => undefined })",
      "utf8"
    );
    const root = path.join(tmp.path, "plugin-root");
    await fs.mkdir(root);
    await fs.symlink(outsideDir, path.join(root, "lib"));
    try {
      await readHookSourceCapped(path.join(root, "lib", "hooks.js"), root);
      expect.unreachable("an ancestor-symlinked hooks.js must be refused at read time");
    } catch (error) {
      expect((error as Error).message).toContain("outside containment root");
    }
  });
});

describe("AgentPluginHookService", () => {
  test("tool.execute.before blocks .env reads with a clear model-visible error", async () => {
    const harness = await createHarness();
    await writeHookPlugin(
      harness.container,
      "env-guard",
      `({
        "tool.execute.before": async (input) => {
          const target = String((input.args && input.args.path) || "");
          if (target.endsWith(".env")) {
            return { deny: "Reading .env files is not allowed (env-guard)" };
          }
        },
      })`,
      { tools: ["file_read"] }
    );
    await harness.ensure();

    const blocked = makeToolCtx("file_read", { path: "/repo/.env" });
    await runTool(harness.spine, blocked);
    expect(blocked.executed).toBe(false);
    const error = blockedError(blocked);
    expect(error).toContain("env-guard");
    expect(error).toContain("Reading .env files is not allowed");

    const allowed = makeToolCtx("file_read", { path: "/repo/ok.txt" });
    await runTool(harness.spine, allowed);
    expect(allowed.executed).toBe(true);
    expect(allowed.blocked).toBeUndefined();

    // Other workspaces' tool calls pass through untouched.
    const otherWorkspace = makeToolCtx("file_read", { path: "/repo/.env" }, "other-workspace");
    await runTool(harness.spine, otherWorkspace);
    expect(otherWorkspace.executed).toBe(true);
  });

  test("before-hook visibility and mutation are bounded to granted tools", async () => {
    const harness = await createHarness();
    await writeHookPlugin(
      harness.container,
      "arg-rewriter",
      `({
        "tool.execute.before": (input) => ({ args: { ...input.args, rewritten: true } }),
      })`,
      { tools: ["file_read"] }
    );
    await harness.ensure();

    const granted = makeToolCtx("file_read", { path: "/repo/a.txt" });
    await runTool(harness.spine, granted);
    expect(granted.args).toEqual({ path: "/repo/a.txt", rewritten: true });

    // bash was not granted: the hook must not even observe the call.
    const ungranted = makeToolCtx("bash", { script: "ls" });
    await runTool(harness.spine, ungranted);
    expect(ungranted.args).toEqual({ script: "ls" });
    expect(ungranted.executed).toBe(true);
  });

  test("a non-object args rewrite is discarded; the tool runs with original args", async () => {
    const harness = await createHarness();
    await writeHookPlugin(
      harness.container,
      "bad-rewriter",
      `({
        "tool.execute.before": async () => ({ args: null }),
      })`,
      { tools: ["file_read"] }
    );
    await harness.ensure();

    // null/array/scalar rewrites would throw inside destructuring executors;
    // the failure posture demands the original args survive instead.
    const call = makeToolCtx("file_read", { path: "/repo/ok.txt" });
    await runTool(harness.spine, call);
    expect(call.executed).toBe(true);
    expect(call.blocked).toBeUndefined();
    expect(call.args).toEqual({ path: "/repo/ok.txt" });
  });

  test("tool.execute.after annotates results with model-visible hook output", async () => {
    const harness = await createHarness();
    await writeHookPlugin(
      harness.container,
      "auditor",
      `({
        "tool.execute.after": (input) => ({
          annotation: "observed ok=" + String(input.result && input.result.ok),
        }),
      })`,
      { tools: ["file_read"] }
    );
    await harness.ensure();

    const ctx = makeToolCtx("file_read", { path: "/repo/a.txt" });
    await runTool(harness.spine, ctx);
    expect(ctx.executed).toBe(true);
    const result = ctx.result as { ok: boolean; hook_output?: string };
    expect(result.ok).toBe(true);
    expect(result.hook_output).toBe("[plugin:auditor] observed ok=true");
  });

  test.each([
    "enabled",
    "disabled",
    "abort-after-load",
    "abort-after-assembly",
    "assembly-error",
  ] as const)("headless compaction shares the plugin policy lifecycle: %s", async (mode) => {
    const enabled = mode !== "disabled";
    const controller = new AbortController();
    const harness = await createHarness({ spine: eventSpine });
    const h = await createAgentSessionHarness({
      workspaceId: WORKSPACE_ID,
      aiServiceOverrides: { isAgentPluginsEnabled: () => enabled },
    });
    const policy = "Do not disclose repository secrets in summaries.";
    await writeHookPlugin(
      harness.container,
      "summary-policy",
      `({ "request.assemble": () => ({ context: ${JSON.stringify(policy)} }) })`
    );
    const ensure = spyOn(agentPluginHookService, "ensureWorkspaceHooks").mockImplementation(
      async (args) => {
        await harness.service.ensureWorkspaceHooks(args);
        if (mode === "abort-after-load") controller.abort();
      }
    );
    const removeMiddleware = eventSpine.useAfter("request.assemble", (ctx) => {
      if (ctx.workspaceId !== WORKSPACE_ID) return;
      if (mode === "abort-after-assembly" || mode === "assembly-error") {
        expect(ctx.systemMessage).toContain(policy);
        if (mode === "assembly-error") throw new Error("Assembly policy rejected request");
        controller.abort();
      }
    });
    const subProjectPath = path.join(h.config.rootDir, "subproject");
    await fs.mkdir(subProjectPath, { recursive: true });
    const metadata = spyOn(h.aiService, "getWorkspaceMetadata").mockResolvedValue(
      Ok({
        id: WORKSPACE_ID,
        name: h.config.rootDir,
        projectName: "test",
        projectPath: h.config.rootDir,
        subProjectPath,
        runtimeConfig: { type: "local" },
      })
    );
    const requests: LanguageModelV3CallOptions[] = [];
    const cleanup = mock(() => undefined);
    const sdkModel = new MockLanguageModelV3({
      doStream: (request) => {
        requests.push(request);
        return Promise.resolve({
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "summary" },
              {
                type: "text-delta",
                id: "summary",
                delta: "Sanitized summary of the investigation.",
              },
              { type: "text-end", id: "summary" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                  inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 5, text: 5, reasoning: 0 },
                },
              },
            ],
          }),
        });
      },
    });
    attachLanguageModelCleanup(sdkModel, cleanup);
    const create = spyOn(h.aiService, "createModelWithPinnedMetadata").mockResolvedValue(
      Ok({ model: sdkModel, metadataModel: "openai:gpt-4o" })
    );
    const record = mock(() => Promise.resolve(undefined));
    try {
      expect(ensure).not.toHaveBeenCalled();
      const result = await summarizeContinuousCompaction({
        workspaceId: WORKSPACE_ID,
        config: h.config,
        aiService: h.aiService,
        sessionUsageService: { recordHeadlessUsage: record },
        head: [createMuxMessage("head", "user", "Summarize the investigation")],
        signal: controller.signal,
        context: {
          enabled: true,
          model: "openai:gpt-4o",
          contextWindowTokens: 128_000,
          thresholdPercent: 70,
        },
        baseOptions: { model: "openai:gpt-4o", agentId: "exec" },
        compactOptions: { model: "openai:gpt-4o", agentId: "compact" },
      }).then(
        (data) => ({ success: true as const, data }),
        (error: unknown) => ({ success: false as const, error })
      );
      expect(ensure).toHaveBeenCalledTimes(1);
      expect(ensure.mock.calls[0][0]).toMatchObject({
        projectRoot: h.config.rootDir,
        projectTrusted: false,
        enabled,
      });
      if (mode !== "enabled" && mode !== "disabled") {
        expect(result.success).toBe(false);
        if (result.success) throw new Error("Canceled or failed assembly published a summary");
        expect(result.error).toBeInstanceOf(Error);
        expect(requests).toHaveLength(0);
        expect(record).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledTimes(mode === "abort-after-load" ? 0 : 1);
        expect(create).toHaveBeenCalledTimes(mode === "abort-after-load" ? 0 : 1);
        return;
      }
      if (!result.success) throw result.error;
      expect(result.data?.text).toContain("Sanitized summary");
      expect(requests).toHaveLength(1);
      expect(
        requests[0].prompt.some(
          (message) => message.role === "system" && message.content.includes(policy)
        )
      ).toBe(enabled);
      const journal = sharedDurableEventJournal(path.join(h.config.sessionsDir, WORKSPACE_ID));
      const rows = await journal.read();
      expect(rows.filter((row) => row.kind === "hook-context")).toHaveLength(enabled ? 1 : 0);
      expect(record).toHaveBeenCalledTimes(1);
      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally {
      removeMiddleware();
      ensure.mockRestore();
      metadata.mockRestore();
      create.mockRestore();
      await harness.service.disposeWorkspace(WORKSPACE_ID);
      await h.session.dispose();
      await h.cleanup();
    }
  });

  test("request.assemble context is journaled as a hook-context row, then applied", async () => {
    const harness = await createHarness();
    await writeHookPlugin(
      harness.container,
      "context-notes",
      `({
        "request.assemble": () => ({ context: "House rule: never commit secrets." }),
      })`
    );
    await harness.ensure();

    const ctx: RequestAssembleContext = {
      workspaceId: WORKSPACE_ID,
      modelString: "anthropic:claude-sonnet-4-5",
      systemMessage: "Base prompt.",
      tools: {},
    };
    await harness.spine.run("request.assemble", ctx);

    expect(ctx.systemMessage).toBe("Base prompt.\n\nHouse rule: never commit secrets.");
    const rows = await harness.journal.read();
    const hookRows = rows.filter((row) => row.kind === "hook-context");
    expect(hookRows).toHaveLength(1);
    expect(hookRows[0].data).toEqual({
      hookId: "plugin:context-notes:request.assemble",
      placement: "system-prompt",
      text: "House rule: never commit secrets.",
    });
  });

  test("a denied capability is a catchable guest error", async () => {
    const harness = await createHarness();
    await writeHookPlugin(
      harness.container,
      "capability-probe",
      `({
        "tool.execute.before": (input) => {
          try {
            mux.bash({ script: "ls" });
            return { deny: "mux.bash unexpectedly succeeded" };
          } catch (error) {
            return { deny: "caught: " + error.message };
          }
        },
      })`,
      { tools: ["file_read"] }
    );
    await harness.ensure();

    const ctx = makeToolCtx("file_read", { path: "/repo/a.txt" });
    await runTool(harness.spine, ctx);
    const error = blockedError(ctx);
    expect(error).toContain("caught: Capability denied: mux.bash is not granted for this sandbox");
  });

  test("a crashing hook never breaks the turn", async () => {
    const harness = await createHarness();
    await writeHookPlugin(
      harness.container,
      "crasher",
      `({
        "tool.execute.before": () => { throw new Error("boom"); },
      })`,
      { tools: ["file_read"] }
    );
    await harness.ensure();

    const ctx = makeToolCtx("file_read", { path: "/repo/a.txt" });
    await runTool(harness.spine, ctx);
    expect(ctx.executed).toBe(true);
    expect(ctx.blocked).toBeUndefined();
  });

  test("a hook stuck in an infinite loop times out and the turn continues", async () => {
    const harness = await createHarness({ hookTimeoutMs: 250 });
    await writeHookPlugin(
      harness.container,
      "spinner",
      `({
        "tool.execute.before": () => { while (true) {} },
      })`,
      { tools: ["file_read"] }
    );
    await harness.ensure();

    const ctx = makeToolCtx("file_read", { path: "/repo/a.txt" });
    await runTool(harness.spine, ctx);
    expect(ctx.executed).toBe(true);
    expect(ctx.blocked).toBeUndefined();
  });

  test("a hooks.js that does not evaluate to an object is skipped; siblings still load", async () => {
    const harness = await createHarness();
    await writeHookPlugin(harness.container, "broken", `42`, { tools: ["file_read"] });
    await writeHookPlugin(
      harness.container,
      "working",
      `({
        "tool.execute.before": () => ({ deny: "blocked by working plugin" }),
      })`,
      { tools: ["file_read"] }
    );
    await harness.ensure();

    const ctx = makeToolCtx("file_read", { path: "/repo/a.txt" });
    await runTool(harness.spine, ctx);
    expect(blockedError(ctx)).toContain("blocked by working plugin");
  });

  test("a transiently failed hook load is retried on the next send", async () => {
    const harness = await createHarness();
    await writeHookPlugin(
      harness.container,
      "flaky",
      `({
        "tool.execute.before": async (input) => {
          if (String((input.args && input.args.path) || "").endsWith(".env")) {
            return { deny: "blocked by flaky" };
          }
        },
      })`,
      { tools: ["file_read"] }
    );

    // First reconcile: the sandbox load fails transiently; the plugin is
    // skipped (failure isolation) and nothing is registered.
    const mountSpy = spyOn(harness.sandboxHost, "withPersistentMount").mockImplementationOnce(() =>
      Promise.reject(new Error("transient sandbox failure"))
    );
    await harness.ensure();
    const blockedWhileBroken = makeToolCtx("file_read", { path: "/repo/.env" });
    await runTool(harness.spine, blockedWhileBroken);
    expect(blockedWhileBroken.executed).toBe(true);
    mountSpy.mockRestore();

    // Second reconcile with UNCHANGED files: the candidate is tracked as
    // failed, so it is retried (real impl) and works.
    await harness.ensure();
    const blocked = makeToolCtx("file_read", { path: "/repo/.env" });
    await runTool(harness.spine, blocked);
    expect(blocked.executed).toBe(false);
    expect(blockedError(blocked)).toContain("blocked by flaky");
  });

  test("retrying a failed plugin does not rebuild healthy sibling mounts", async () => {
    const harness = await createHarness();
    await writeHookPlugin(
      harness.container,
      "healthy",
      `({ "tool.execute.before": () => ({ deny: "blocked by healthy" }) })`,
      { tools: ["file_read"] }
    );
    await writeHookPlugin(
      harness.container,
      "unlucky",
      `({ "tool.execute.before": async () => undefined })`,
      { tools: ["file_read"] }
    );

    // First reconcile: only the "unlucky" plugin's mount load fails.
    const realWithPersistentMount = SandboxHostService.prototype.withPersistentMount.bind(
      harness.sandboxHost
    );
    const mountSpy = spyOn(harness.sandboxHost, "withPersistentMount").mockImplementation(function <
      T,
    >(
      options: Parameters<typeof realWithPersistentMount>[0],
      fn: (mount: SandboxMount) => Promise<T>
    ): Promise<T> {
      return String(options.scopeKey).includes("unlucky")
        ? Promise.reject(new Error("transient sandbox failure"))
        : realWithPersistentMount(options, fn);
    });
    await harness.ensure();
    expect(
      mountSpy.mock.calls.filter((call) => String(call[0]?.scopeKey).includes("healthy"))
    ).toHaveLength(1);
    mountSpy.mockRestore();

    // Second reconcile (unchanged files): the failed sibling is retried, but
    // the healthy plugin's persistent mount must NOT be torn down/reloaded —
    // teardown would lose its cross-turn guest state.
    const retrySpy = spyOn(harness.sandboxHost, "withPersistentMount");
    const dropSpy = spyOn(harness.sandboxHost, "dropScope");
    await harness.ensure();
    expect(
      retrySpy.mock.calls.filter((call) => String(call[0]?.scopeKey).includes("healthy"))
    ).toHaveLength(0);
    expect(dropSpy.mock.calls.filter((call) => String(call[0]).includes("healthy"))).toHaveLength(
      0
    );
    // The retried sibling loaded this time.
    expect(
      retrySpy.mock.calls.filter((call) => String(call[0]?.scopeKey).includes("unlucky"))
    ).toHaveLength(1);
    retrySpy.mockRestore();
    dropSpy.mockRestore();

    // Both plugins are now active.
    const blocked = makeToolCtx("file_read", { path: "/repo/a.txt" });
    await runTool(harness.spine, blocked);
    expect(blockedError(blocked)).toContain("blocked by healthy");
  });

  test("editing hooks.js reloads the plugin; disabling tears everything down", async () => {
    const harness = await createHarness();
    await writeHookPlugin(
      harness.container,
      "mutable",
      `({ "tool.execute.before": () => ({ deny: "first version" }) })`,
      { tools: ["file_read"] }
    );
    await harness.ensure();

    const first = makeToolCtx("file_read", { path: "/repo/a.txt" });
    await runTool(harness.spine, first);
    expect(blockedError(first)).toContain("first version");

    // Edit on disk → fingerprint change → mount rebuild + re-registration.
    await fs.writeFile(
      path.join(harness.container, "mutable", "hooks.js"),
      `({ "tool.execute.before": () => ({ deny: "second version" }) })`,
      "utf8"
    );
    await harness.ensure();
    const second = makeToolCtx("file_read", { path: "/repo/a.txt" });
    await runTool(harness.spine, second);
    expect(blockedError(second)).toContain("second version");

    // Disable (experiment off) → middleware unregistered, tool runs untouched.
    await harness.ensure({ enabled: false });
    expect(harness.spine.hasMiddleware("tool.execute")).toBe(false);
    const third = makeToolCtx("file_read", { path: "/repo/a.txt" });
    await runTool(harness.spine, third);
    expect(third.executed).toBe(true);
    expect(third.blocked).toBeUndefined();
  });
});

describe("replay determinism with hooks active", () => {
  function fixtureTools(): Record<string, Tool> {
    return {
      file_read: tool({
        description: "Read a file",
        inputSchema: z.object({ path: z.string() }),
      }),
    };
  }

  test("replay verification stays green when request.assemble injects context", async () => {
    const harness = await createHarness();
    await writeHookPlugin(
      harness.container,
      "context-notes",
      `({
        "request.assemble": () => ({ context: "House rule: never commit secrets." }),
      })`
    );

    // Share ONE journal instance between the hook service and the fixture so
    // hook-context and turn-envelope rows get strictly monotonic sequences.
    const fixtureCtx = createReplayFixtureSessionContext(
      harness.sessionDir,
      REPLAY_FIXTURE_WORKSPACE_ID
    );
    await harness.service.ensureWorkspaceHooks({
      workspaceId: REPLAY_FIXTURE_WORKSPACE_ID,
      sessionDir: harness.sessionDir,
      journal: fixtureCtx.journal,
      enabled: true,
      xumHome: harness.tmp.path,
      projectTrusted: false,
    });

    // Assemble the request the way aiService does: hooks mutate the system
    // prompt BEFORE the turn envelope is emitted from the final prompt.
    const assembleCtx: RequestAssembleContext = {
      workspaceId: REPLAY_FIXTURE_WORKSPACE_ID,
      modelString: REPLAY_FIXTURE_MODEL,
      systemMessage: "You are a hook fixture agent.",
      tools: fixtureTools(),
    };
    await harness.spine.run("request.assemble", assembleCtx);
    expect(assembleCtx.systemMessage).toContain("House rule: never commit secrets.");

    await appendReplayFixtureTurn(fixtureCtx, {
      userText: "Hello?",
      assistantText: "Hi!",
      systemPrompt: assembleCtx.systemMessage,
      tools: fixtureTools(),
    });
    await flushReplayFixtureDevtools(fixtureCtx);

    // The recorded provider request (built through the production pipeline)
    // contains the hook-injected context...
    const devtools = await fs.readFile(path.join(harness.sessionDir, "devtools.jsonl"), "utf8");
    expect(devtools).toContain("House rule: never commit secrets.");

    // ...the injected context exists as a durable hook-context row...
    const rows = await fixtureCtx.journal.read();
    const hookRows = rows.filter((row) => row.kind === "hook-context");
    expect(hookRows).toHaveLength(1);
    expect(hookRows[0].data.text).toBe("House rule: never commit secrets.");

    // ...and byte-level replay verification passes with the hook active.
    const historyService = new HistoryService({
      getSessionDir: () => harness.sessionDir,
      rootDir: path.dirname(harness.sessionDir),
    });
    const history = await collectFullHistory(historyService, REPLAY_FIXTURE_WORKSPACE_ID);
    expect(history.success).toBe(true);
    if (!history.success) throw new Error("history read failed");
    const result = await replayVerifySession({
      sessionDir: harness.sessionDir,
      workspaceId: REPLAY_FIXTURE_WORKSPACE_ID,
      historyMessages: history.data,
    });
    expect(result.notes).toEqual([]);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].status).toBe("PASS");

    await harness.service.disposeWorkspace(REPLAY_FIXTURE_WORKSPACE_ID);
  });
});

describe("epoch-based hook retirement", () => {
  test("a managed plugin mutation (epoch bump) retires live hooks before the next invocation", async () => {
    // An uninstall/update/install committed in ANY process bumps the managed
    // container's mutation epoch. Already-registered hooks must stop seeing
    // tool traffic at the next invocation — not survive until the workspace's
    // next send calls ensureWorkspaceHooks — or a mid-stream uninstall would
    // keep exposing tool args/results to (and accepting denials/rewrites
    // from) the removed plugin.
    const harness = await createHarness();
    await writeHookPlugin(
      harness.container,
      "epoch-demo",
      "({ 'tool.execute.before': () => ({ deny: 'blocked by hook' }) })",
      { tools: ["dangerous_tool"] }
    );
    await harness.ensure();

    // Live: the hook denies the granted tool.
    const before = makeToolCtx("dangerous_tool", { a: 1 });
    await runTool(harness.spine, before);
    expect(blockedError(before)).toContain("blocked by hook");

    const stagingRoot = path.join(harness.tmp.path, STAGING_DIR_NAME);
    await fs.mkdir(stagingRoot, { recursive: true });
    await bumpContainerMutationEpoch(stagingRoot);

    // Stale epoch: the registration is torn down before the hook sees input.
    const after = makeToolCtx("dangerous_tool", { a: 2 });
    await runTool(harness.spine, after);
    expect(after.blocked).toBeUndefined();
    expect(after.executed).toBe(true);

    // The next ensure re-registers from disk with the fresh epoch.
    await harness.ensure();
    const reensured = makeToolCtx("dangerous_tool", { a: 3 });
    await runTool(harness.spine, reensured);
    expect(blockedError(reensured)).toContain("blocked by hook");
  });
});
