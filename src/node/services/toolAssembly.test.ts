import { resolveToolPolicyForAgent } from "./agentDefinitions/resolveToolPolicy";
import { isMemoryToolDisabled, isSessionHistoryDisabled } from "@/common/utils/tools/toolPolicy";
import { resolveAgentFrontmatter } from "./agentDefinitions/agentDefinitionsService";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { ToolBridge } from "./ptc/toolBridge";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { Tool } from "ai";

import { applyToolPolicyAndExperiments, resolveBackendGatedPtcExperiments } from "./toolAssembly";
import { buildToolsetManifest } from "./turnEnvelope";
import { sandboxHostService } from "@/node/services/sandbox/sandboxHostService";
import { DisposableTempDir } from "@/node/services/tempDir";
import { appendRefinementEvent } from "@/node/services/refinement/refinementJournal";
import { listRefinements } from "@/node/services/refinement/refinementRollback";

function executableTool(description: string): Tool {
  return {
    description,
    inputSchema: z.object({}),
    execute: () => Promise.resolve({ success: true }),
  } as unknown as Tool;
}

describe("applyToolPolicyAndExperiments", () => {
  test("PTC keeps mcp_prompt_get directly visible", async () => {
    const result = await applyToolPolicyAndExperiments({
      allTools: {
        bash: executableTool("Run a command"),
        mcp_prompt_get: executableTool("Fetch a prompt\n\nAvailable MCP prompts:\n- mcp__s__p"),
      },
      effectiveToolPolicy: undefined,
      experiments: { programmaticToolCalling: true },
      emitNestedToolEvent: () => undefined,
    });

    const names = Object.keys(result);
    expect(names).toContain("code_execution");
    expect(names).not.toContain("bash");
    // Sandbox declarations keep only the first description line, which would
    // hide the prompt catalog.
    expect(names).toContain("mcp_prompt_get");
    expect(result.mcp_prompt_get.description).toContain("mcp__s__p");

    // Promoted tools must not ALSO stay bridged: request.assemble hooks see
    // only top-level tools, and a bridged duplicate would keep dispatching
    // the pre-hook implementation behind a hook's filter or wrapper.
    const evalResult = (await result.code_execution.execute!(
      { code: "return typeof mux.mcp_prompt_get;" },
      { toolCallId: "test-call-id", messages: [], context: undefined }
    )) as { success: boolean; result?: unknown };
    expect(evalResult.success).toBe(true);
    expect(evalResult.result).toBe("undefined");
  });

  test("context-coupled tools stay model-visible under PTC; media tools bridge", async () => {
    // memory/advisor: AIService keys system-prompt context (memory index /
    // hot set, advisor guidance) off their top-level presence. attach_file /
    // desktop_screenshot are bridgeable instead: the ToolBridge strips their
    // base64 from sandbox-visible values and the code_execution attachments
    // carrier delivers the real bytes to request-time extraction, so nested
    // media reaches the model without a top-level tool slot.
    const result = await applyToolPolicyAndExperiments({
      allTools: {
        bash: executableTool("Run a command"),
        memory: executableTool("Memory"),
        advisor: executableTool("Advisor"),
        attach_file: executableTool("Attach"),
        desktop_screenshot: executableTool("Screenshot"),
      },
      effectiveToolPolicy: undefined,
      experiments: { programmaticToolCalling: true },
      emitNestedToolEvent: () => undefined,
    });
    expect(Object.keys(result).sort()).toEqual(["advisor", "code_execution", "memory"]);

    // The media tools must actually be reachable inside the sandbox; hidden
    // from the model-visible set but not dropped.
    const evalResult = (await result.code_execution.execute!(
      { code: "return [typeof mux.attach_file, typeof mux.desktop_screenshot];" },
      { toolCallId: "test-call-id", messages: [], context: undefined }
    )) as { success: boolean; result?: unknown };
    expect(evalResult.success).toBe(true);
    expect(evalResult.result).toEqual(["function", "function"]);
  });

  test("a disable-all policy yields no tools at all (no code_execution)", async () => {
    // Auto-compaction inherits the original send's experiment flags and sets a
    // `.*` disable policy: that no-tools contract must win over the exclusive
    // posture's otherwise-mandatory code_execution.
    const result = await applyToolPolicyAndExperiments({
      allTools: { bash: executableTool("Run a command"), todo_write: executableTool("Todos") },
      effectiveToolPolicy: [{ regex_match: ".*", action: "disable" }],
      experiments: { programmaticToolCalling: true },
      emitNestedToolEvent: () => undefined,
    });
    expect(Object.keys(result)).toEqual([]);
  });

  test("an allowlist that re-enables code_execution keeps the exclusive entry point", async () => {
    // [disable .*, enable code_execution] empties the base-tool record, but
    // the last matching rule explicitly enables the synthesized entry point —
    // it must not be misread as a no-tools contract.
    const result = await applyToolPolicyAndExperiments({
      allTools: { bash: executableTool("Run a command") },
      effectiveToolPolicy: [
        { regex_match: ".*", action: "disable" },
        { regex_match: "code_execution", action: "enable" },
      ],
      experiments: { programmaticToolCalling: true },
      emitNestedToolEvent: () => undefined,
    });
    expect(Object.keys(result)).toEqual(["code_execution"]);
  });

  test("policy-required bridgeable tools stay model-visible in the exclusive set", async () => {
    // "require" gates run completion on a TOP-LEVEL toolResult for that name
    // (StreamManager.createStopWhenCondition); a nested xum.* call never
    // satisfies it, so the required tool must not be bridged away.
    const result = await applyToolPolicyAndExperiments({
      allTools: {
        bash: executableTool("Run a command"),
        file_read: executableTool("Read a file"),
      },
      effectiveToolPolicy: [{ regex_match: "bash", action: "require" }],
      experiments: { programmaticToolCalling: true },
      emitNestedToolEvent: () => undefined,
    });
    expect(Object.keys(result).sort()).toEqual(["bash", "code_execution"]);

    // The promoted tool leaves the bridge entirely (no duplicated dispatch
    // path that assemble hooks cannot see); other bridgeable tools remain.
    const evalResult = (await result.code_execution.execute!(
      { code: "return [typeof mux.bash, typeof mux.file_read];" },
      { toolCallId: "test-call-id", messages: [], context: undefined }
    )) as { success: boolean; result?: unknown };
    expect(evalResult.success).toBe(true);
    expect(evalResult.result).toEqual(["undefined", "function"]);
  });

  test("grant-denied tools are hidden from the model but stubbed in the sandbox", async () => {
    const result = await applyToolPolicyAndExperiments({
      allTools: {
        bash: executableTool("Run a command"),
        file_read: executableTool("Read a file"),
      },
      effectiveToolPolicy: undefined,
      experiments: { programmaticToolCalling: true },
      emitNestedToolEvent: () => undefined,
      capabilityGrants: {
        version: 1,
        bridgeTools: { allow: ["file_read"] },
        vars: false,
        hostEvents: false,
      },
    });

    // Grants are a ceiling on the model-visible set...
    expect(Object.keys(result)).not.toContain("bash");
    expect(Object.keys(result)).toContain("code_execution");

    // ...but the guest must still get the documented catchable stub error —
    // the bridge is built from the pre-grant set so denied tools are known,
    // not "mux.bash is not a function".
    const evalResult = (await result.code_execution.execute!(
      { code: "try { mux.bash({}); return 'no error'; } catch (e) { return e.message; }" },
      { toolCallId: "test-call-id", messages: [], context: undefined }
    )) as { success: boolean; result?: unknown };
    expect(evalResult.success).toBe(true);
    expect(evalResult.result).toBe("Capability denied: xum.bash is not granted for this sandbox");
  });
});

describe("persistent kernel graduation (RLM mode)", () => {
  const originalEnv = process.env.MUX_SANDBOX_PERSISTENT_MOUNTS;

  beforeEach(() => {
    // Pin the env override off so each test controls persistence explicitly.
    delete process.env.MUX_SANDBOX_PERSISTENT_MOUNTS;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MUX_SANDBOX_PERSISTENT_MOUNTS;
    } else {
      process.env.MUX_SANDBOX_PERSISTENT_MOUNTS = originalEnv;
    }
  });

  async function assembleCodeExecution(opts: {
    rlm?: boolean;
    sandbox?: { workspaceId: string; sessionDir: string };
  }): Promise<Tool> {
    const tools = await applyToolPolicyAndExperiments({
      allTools: { file_read: executableTool("Read a file") },
      effectiveToolPolicy: undefined,
      experiments: { programmaticToolCalling: true, rlm: opts.rlm },
      emitNestedToolEvent: () => undefined,
      sandbox: opts.sandbox,
    });
    expect(tools.code_execution).toBeDefined();
    return tools.code_execution;
  }

  async function run(tool: Tool, code: string): Promise<{ success: boolean; result?: unknown }> {
    return (await tool.execute!(
      { code },
      { toolCallId: "test-call-id", messages: [], context: undefined }
    )) as { success: boolean; result?: unknown };
  }

  test("rlm on: persistent mount is used — vars survive across two invocations in one session", async () => {
    using tmp = new DisposableTempDir("tool-assembly-rlm-on");
    const scopeKey = "ws-tool-assembly-rlm-on";
    try {
      const codeExecution = await assembleCodeExecution({
        rlm: true,
        sandbox: { workspaceId: scopeKey, sessionDir: tmp.path },
      });
      expect(codeExecution.description).toContain("Persistent kernel");

      const first = await run(codeExecution, "vars.total = 40; return vars.total;");
      expect(first.success).toBe(true);
      expect(first.result).toBe(40);

      const second = await run(codeExecution, "vars.total += 2; return vars.total;");
      expect(second.success).toBe(true);
      expect(second.result).toBe(42);
    } finally {
      await sandboxHostService.disposeScope(scopeKey);
    }
  });

  test("rlm off: ephemeral per-call runtime and unchanged description", async () => {
    using tmp = new DisposableTempDir("tool-assembly-rlm-off");
    const withSandbox = await assembleCodeExecution({
      sandbox: { workspaceId: "ws-tool-assembly-rlm-off", sessionDir: tmp.path },
    });
    const withoutSandbox = await assembleCodeExecution({});

    // With the experiment off, sandbox context alone must not change the
    // model-visible description (byte-identical to today's ephemeral tool).
    expect(withSandbox.description).toBe(withoutSandbox.description);
    expect(withSandbox.description).not.toContain("Persistent kernel");

    // Ephemeral runtimes have no kernel `vars` namespace...
    const first = await run(withSandbox, "return typeof vars;");
    expect(first.success).toBe(true);
    expect(first.result).toBe("undefined");

    // ...and state set in one call does not leak into the next (fresh runtime).
    const second = await run(withSandbox, "globalThis.leak = 1; return globalThis.leak;");
    expect(second.success).toBe(true);
    expect(second.result).toBe(1);
    const third = await run(withSandbox, "return typeof globalThis.leak;");
    expect(third.success).toBe(true);
    expect(third.result).toBe("undefined");
  });

  test("refinement_rollback is exposed only with rlm on (and works end-to-end)", async () => {
    using tmp = new DisposableTempDir("tool-assembly-rlm-rollback");
    const scopeKey = "ws-tool-assembly-rlm-rollback";
    const sessionDir = path.join(tmp.path, "sessions", scopeKey);
    const assemble = (experiments: {
      programmaticToolCalling?: boolean;
      rlm?: boolean;
    }): Promise<Record<string, Tool>> =>
      applyToolPolicyAndExperiments({
        allTools: { file_read: executableTool("Read a file") },
        effectiveToolPolicy: undefined,
        experiments,
        emitNestedToolEvent: () => undefined,
        sandbox: { workspaceId: scopeKey, sessionDir },
      });
    try {
      // RLM off (PTC on): no rollback surface, byte-identical to today.
      const rlmOff = await assemble({ programmaticToolCalling: true });
      expect(rlmOff.refinement_rollback).toBeUndefined();

      // rlm flag without the PTC parent: no PTC branch, so no surface either.
      const ptcOff = await assemble({ rlm: true });
      expect(ptcOff.refinement_rollback).toBeUndefined();
      expect(ptcOff.code_execution).toBeUndefined();

      const rlmOn = await assemble({ programmaticToolCalling: true, rlm: true });
      expect(rlmOn.refinement_rollback).toBeDefined();

      // The wired tool rolls back a seeded skill-write row in the sandbox's
      // session dir and reports what changed.
      const skillFile = path.join(tmp.path, "checkout", ".mux", "skills", "s", "SKILL.md");
      await fsPromises.mkdir(path.dirname(skillFile), { recursive: true });
      await fsPromises.writeFile(skillFile, "body", "utf-8");
      await appendRefinementEvent({
        sessionDir,
        workspaceId: scopeKey,
        kind: "skill",
        action: { op: "write", skillName: "s", filePath: "SKILL.md" },
        inverse: { op: "delete-files", paths: [skillFile] },
        evidence: { toolName: "agent_skill_write" },
      });
      const rows = await listRefinements(sessionDir);
      const result = (await rlmOn.refinement_rollback.execute!(
        { id: rows[0].id, reason: "test rollback" },
        { toolCallId: "test-call-id", messages: [], context: undefined }
      )) as { success: boolean; rollbackOf?: string; deleted?: string[] };
      expect(result.success).toBe(true);
      expect(result.rollbackOf).toBe(rows[0].id);
      expect(result.deleted).toEqual([skillFile]);
      const stillExists = await fsPromises.access(skillFile).then(
        () => true,
        () => false
      );
      expect(stillExists).toBe(false);
    } finally {
      await sandboxHostService.disposeScope(scopeKey);
    }
  });

  test("MUX_SANDBOX_PERSISTENT_MOUNTS=1 still opts in without the rlm experiment", async () => {
    using tmp = new DisposableTempDir("tool-assembly-env-mounts");
    const scopeKey = "ws-tool-assembly-env-mounts";
    process.env.MUX_SANDBOX_PERSISTENT_MOUNTS = "1";
    try {
      const codeExecution = await assembleCodeExecution({
        sandbox: { workspaceId: scopeKey, sessionDir: tmp.path },
      });
      expect(codeExecution.description).toContain("Persistent kernel");

      const first = await run(codeExecution, "vars.count = 1; return vars.count;");
      expect(first.success).toBe(true);
      expect(first.result).toBe(1);

      const second = await run(codeExecution, "vars.count += 1; return vars.count;");
      expect(second.success).toBe(true);
      expect(second.result).toBe(2);
    } finally {
      await sandboxHostService.disposeScope(scopeKey);
    }
  });
});

describe("toolset composition (PTC × RLM)", () => {
  const originalEnv = process.env.MUX_SANDBOX_PERSISTENT_MOUNTS;

  beforeEach(() => {
    // Pin the env override off so RLM gating is exercised via the flag alone.
    delete process.env.MUX_SANDBOX_PERSISTENT_MOUNTS;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MUX_SANDBOX_PERSISTENT_MOUNTS;
    } else {
      process.env.MUX_SANDBOX_PERSISTENT_MOUNTS = originalEnv;
    }
  });

  // Bridgeable (bash/file_read/mcp_prompt_get) + non-bridgeable interaction
  // tools (excluded from the sandbox by ToolBridge, must stay top-level).
  const compositionTools = (): Record<string, Tool> => ({
    bash: executableTool("Run a command"),
    file_read: executableTool("Read a file"),
    ask_user_question: executableTool("Ask the user"),
    todo_write: executableTool("Write todos"),
    agent_report: executableTool("Report to parent — taskService reads args from history"),
    mcp_prompt_get: executableTool("Fetch a prompt"),
  });

  const assemble = (
    scopeKey: string,
    sessionDir: string,
    experiments: {
      programmaticToolCalling?: boolean;
      rlm?: boolean;
    },
    capabilityGrants?: Parameters<typeof applyToolPolicyAndExperiments>[0]["capabilityGrants"]
  ): Promise<Record<string, Tool>> =>
    applyToolPolicyAndExperiments({
      allTools: compositionTools(),
      effectiveToolPolicy: undefined,
      experiments,
      emitNestedToolEvent: () => undefined,
      sandbox: { workspaceId: scopeKey, sessionDir },
      capabilityGrants,
    });

  // Exclusive: bridgeable tools reachable only via code_execution; the
  // interaction tools and mcp_prompt_get stay model-visible.
  const EXCLUSIVE_NAMES = [
    "agent_report",
    "ask_user_question",
    "code_execution",
    "mcp_prompt_get",
    "todo_write",
  ];

  test("PTC only: exclusive narrowed set, no kernel surfaces", async () => {
    using tmp = new DisposableTempDir("compose-ptc");
    const tools = await assemble("ws-compose-ptc", tmp.path, { programmaticToolCalling: true });
    expect(Object.keys(tools).sort()).toEqual(EXCLUSIVE_NAMES);
    expect(tools.code_execution.description).not.toContain("Persistent kernel");
    expect(tools.code_execution.description).not.toContain("Kernel-first");
  });

  test("PTC + RLM: kernel-first narrowed set + rollback + kernel-first preamble", async () => {
    using tmp = new DisposableTempDir("compose-ptc-rlm");
    try {
      const tools = await assemble("ws-compose-ptc-rlm", tmp.path, {
        programmaticToolCalling: true,
        rlm: true,
      });
      expect(Object.keys(tools).sort()).toEqual([...EXCLUSIVE_NAMES, "refinement_rollback"].sort());
      // agent_report must stay top-level: taskService reads its args from history.
      expect(tools.agent_report).toBeDefined();
      const desc = (tools.code_execution as { description?: string }).description ?? "";
      expect(desc.startsWith("**Kernel-first workflow:**")).toBe(true);
      expect(desc).toContain("Persistent kernel");
    } finally {
      await sandboxHostService.disposeScope("ws-compose-ptc-rlm");
    }
  });

  test("PTC + RLM re-applies the grants ceiling to non-bridgeable tools and refinement_rollback", async () => {
    using tmp = new DisposableTempDir("compose-excl-rlm-grants");
    try {
      const tools = await assemble(
        "ws-compose-excl-rlm-grants",
        tmp.path,
        { programmaticToolCalling: true, rlm: true },
        {
          version: 1,
          bridgeTools: { allow: ["file_read"] },
          vars: false,
          hostEvents: false,
        }
      );
      // Grants are a ceiling over the WHOLE model-visible set: non-granted
      // interaction tools, mcp_prompt_get, and the synthesized
      // refinement_rollback are all hidden; code_execution stays (exclusive
      // mode's mandatory entry point — the bridge enforces grants inside).
      expect(Object.keys(tools).sort()).toEqual(["code_execution"]);
    } finally {
      await sandboxHostService.disposeScope("ws-compose-excl-rlm-grants");
    }
  });

  test("tool policy disables the synthesized refinement_rollback (exact and broad rules)", async () => {
    // refinement_rollback is synthesized AFTER the assembly-wide policy pass,
    // so the policy ceiling must be re-applied to it — otherwise even a
    // disable-everything policy would leave a model-facing tool that can
    // delete/restore memory and skill files.
    const assembleWithPolicy = (
      scopeKey: string,
      sessionDir: string,
      policy: Parameters<typeof applyToolPolicyAndExperiments>[0]["effectiveToolPolicy"]
    ) =>
      applyToolPolicyAndExperiments({
        allTools: compositionTools(),
        effectiveToolPolicy: policy,
        experiments: { programmaticToolCalling: true, rlm: true },
        emitNestedToolEvent: () => undefined,
        sandbox: { workspaceId: scopeKey, sessionDir },
      });

    using tmp = new DisposableTempDir("compose-rollback-policy");
    try {
      const exact = await assembleWithPolicy("ws-rollback-policy", tmp.path, [
        { regex_match: "refinement_rollback", action: "disable" },
      ]);
      expect(exact.refinement_rollback).toBeUndefined();
      // Only the targeted tool is removed.
      expect(exact.code_execution).toBeDefined();

      const broad = await assembleWithPolicy("ws-rollback-policy", tmp.path, [
        { regex_match: ".*", action: "disable" },
      ]);
      expect(broad.refinement_rollback).toBeUndefined();

      // Sanity: without a policy the tool is present (guards a silently
      // over-broad filter that would make the disable assertions vacuous).
      const none = await assembleWithPolicy("ws-rollback-policy", tmp.path, undefined);
      expect(none.refinement_rollback).toBeDefined();
    } finally {
      await sandboxHostService.disposeScope("ws-rollback-policy");
    }
  });

  test("turn-envelope manifest fingerprints the narrowed PTC + RLM toolset", async () => {
    using tmp = new DisposableTempDir("compose-envelope");
    try {
      const tools = await assemble("ws-compose-envelope", tmp.path, {
        programmaticToolCalling: true,
        rlm: true,
      });
      const manifest = buildToolsetManifest(tools);
      // The manifest must describe the actually-narrowed set: bridged-away
      // tools (bash/file_read) never appear, and entries come back sorted.
      expect(manifest.map((entry) => entry.name)).toEqual(
        [...EXCLUSIVE_NAMES, "refinement_rollback"].sort()
      );
      for (const entry of manifest) {
        expect(entry.schemaHash).toMatch(/^[0-9a-f]{64}$/);
      }
      // Hashes are schema-sensitive: identical empty-object fixture schemas
      // collapse to one hash while code_execution's real schema differs.
      const byName = new Map(manifest.map((entry) => [entry.name, entry.schemaHash]));
      expect(byName.get("agent_report")).toBe(byName.get("todo_write"));
      expect(byName.get("code_execution")).not.toBe(byName.get("agent_report"));
    } finally {
      await sandboxHostService.disposeScope("ws-compose-envelope");
    }
  });
});

describe("resolveBackendGatedPtcExperiments", () => {
  const backendEnabled = new Set(["rlm-mode", "programmatic-tool-calling"]);
  const isEnabled = (id: string) => backendEnabled.has(id);

  test("backfills undefined flags from the backend override", () => {
    // A renderer with no origin-local override sends undefined; the persisted
    // backend override must win or tool assembly diverges from the effective
    // UI / refine gate.
    const resolved = resolveBackendGatedPtcExperiments(undefined, isEnabled);
    expect(resolved.rlm).toBe(true);
    expect(resolved.programmaticToolCalling).toBe(true);
  });

  test("explicit renderer values (true or false) win over the backend", () => {
    const resolved = resolveBackendGatedPtcExperiments({ rlm: false }, isEnabled);
    // Explicit false is NOT backfilled to the backend's true.
    expect(resolved.rlm).toBe(false);
    // Undefined still backfills.
    expect(resolved.programmaticToolCalling).toBe(true);

    // Explicit true wins over a backend-disabled flag.
    const explicitTrue = resolveBackendGatedPtcExperiments(
      { programmaticToolCalling: true },
      () => false
    );
    expect(explicitTrue.programmaticToolCalling).toBe(true);
  });

  test("preserves unrelated experiment flags untouched", () => {
    const resolved = resolveBackendGatedPtcExperiments({ memory: true }, isEnabled);
    expect(resolved.memory).toBe(true);
  });
});

describe("token budget history policy", () => {
  test.each([
    { add: [], allowed: false },
    { add: ["file_read"], allowed: false },
    { add: ["memory"], allowed: true },
    { add: ["mem.*"], allowed: true },
    { add: [".*"], allowed: true },
  ])("harvest permission mirrors the assembled memory tool: $add", async ({ add, allowed }) => {
    // The persisted workspaceMemoryWritable bit is derived from the policy
    // before tool assembly; it must agree with whether `memory` survives it.
    const policy = resolveToolPolicyForAgent({
      agents: [{ tools: { add } }],
      isSubagent: true,
      disableTaskToolsForDepth: false,
    });
    const memory = executableTool("Memory");
    const result = await applyToolPolicyAndExperiments({
      allTools: { memory, file_read: executableTool("Read") },
      effectiveToolPolicy: policy,
      emitNestedToolEvent: () => undefined,
    });
    expect(isMemoryToolDisabled(policy)).toBe(!allowed);
    expect(result.memory === undefined).toBe(!allowed);
  });

  test.each([
    { add: [], allowed: false },
    { add: ["file_read"], allowed: false },
    { add: ["session_history"], allowed: true },
    { add: ["session_.*"], allowed: true },
    { add: [".*"], allowed: true },
  ])("recovery follows the agent allowlist: $add", async ({ add, allowed }) => {
    const policy = resolveToolPolicyForAgent({
      agents: [{ tools: { add } }],
      isSubagent: false,
      disableTaskToolsForDepth: false,
    });
    expect(isSessionHistoryDisabled(policy)).toBe(!allowed);
    const history = executableTool("History");
    const result = await applyToolPolicyAndExperiments({
      allTools: { session_history: history, file_read: executableTool("Read") },
      effectiveToolPolicy: policy,
      experiments: { tokenBudget: true },
      emitNestedToolEvent: () => undefined,
    });
    if (allowed) {
      expect(result.session_history).toBe(history);
    } else {
      expect(result.session_history).toBeUndefined();
    }
  });

  test.each(["exec", "plan", "explore"])(
    "%s retains recovery through its built-in inherited policy",
    async (agentId) => {
      using tempDir = new DisposableTempDir("history-policy");
      const agent = await resolveAgentFrontmatter(
        new LocalRuntime(tempDir.path),
        tempDir.path,
        agentId
      );
      const policy = resolveToolPolicyForAgent({
        agents: [agent],
        isSubagent: agentId === "explore",
        disableTaskToolsForDepth: false,
      });
      const history = executableTool("History");
      const result = await applyToolPolicyAndExperiments({
        allTools: { session_history: history },
        effectiveToolPolicy: policy,
        experiments: { tokenBudget: true },
        emitNestedToolEvent: () => undefined,
      });
      expect(isSessionHistoryDisabled(policy)).toBe(false);
      expect(result.session_history).toBe(history);
    }
  );

  test.each(["session_history", "^session_history$", "session_.*", ".*"])(
    "explicit %s disable blocks assembly and rollover gate",
    async (name) => {
      const policy = resolveToolPolicyForAgent({
        agents: [{ tools: { remove: [name] } }, { tools: { add: [".*"] } }],
        isSubagent: false,
        disableTaskToolsForDepth: false,
      });
      expect(isSessionHistoryDisabled(policy)).toBe(true);
      const result = await applyToolPolicyAndExperiments({
        allTools: { session_history: executableTool("History") },
        effectiveToolPolicy: policy,
        experiments: { tokenBudget: true },
        emitNestedToolEvent: () => undefined,
      });
      expect(result.session_history).toBeUndefined();
    }
  );

  test("the last matching regex rule controls history access", async () => {
    const policy = [
      { regex_match: "session_history", action: "disable" as const },
      { regex_match: ".*", action: "enable" as const },
    ];
    const assemble = (effectiveToolPolicy: typeof policy) =>
      applyToolPolicyAndExperiments({
        allTools: { session_history: executableTool("History") },
        effectiveToolPolicy,
        experiments: { tokenBudget: true },
        emitNestedToolEvent: () => undefined,
      });
    expect(isSessionHistoryDisabled(policy)).toBe(false);
    expect((await assemble(policy)).session_history).toBeDefined();
    const disabledAgain = [...policy, { regex_match: "session_.*", action: "disable" as const }];
    expect(isSessionHistoryDisabled(disabledAgain)).toBe(true);
    expect((await assemble(disabledAgain)).session_history).toBeUndefined();
  });

  test("PTC leaves recovery direct and does not offer it inside the sandbox", async () => {
    const history = executableTool("History");
    const bridge = new ToolBridge({ session_history: history });
    expect(bridge.getNonBridgeableTools().session_history).toBe(history);
    const result = await applyToolPolicyAndExperiments({
      allTools: { session_history: history, file_read: executableTool("Read") },
      effectiveToolPolicy: [
        { regex_match: ".*", action: "disable" },
        { regex_match: "file_read", action: "enable" },
        { regex_match: "session_history", action: "enable" },
      ],
      experiments: { tokenBudget: true, programmaticToolCalling: true },
      emitNestedToolEvent: () => undefined,
    });
    expect(result.session_history).toBe(history);
    const execution = (await result.code_execution.execute!(
      { code: "return typeof mux.session_history;" },
      { toolCallId: "history-ptc", messages: [], context: undefined }
    )) as { success: boolean; result?: unknown };
    expect(execution).toMatchObject({ success: true, result: "undefined" });
  });

  test("token budget honors renderer override before backend default", () => {
    expect(resolveBackendGatedPtcExperiments(undefined, () => true).tokenBudget).toBe(true);
    expect(resolveBackendGatedPtcExperiments({ tokenBudget: false }, () => true).tokenBudget).toBe(
      false
    );
    expect(resolveBackendGatedPtcExperiments({ tokenBudget: true }, () => false).tokenBudget).toBe(
      true
    );
  });
});
