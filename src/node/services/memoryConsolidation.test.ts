import { describe, expect, it, spyOn } from "bun:test";

import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import type { Tool } from "ai";

import {
  MEMORY_CONSOLIDATION_OP_BUDGET,
  MEMORY_MAX_FILE_BYTES,
  MEMORY_MAX_FILES_PER_SCOPE,
} from "@/common/constants/memory";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { Config } from "@/node/config";
import { createConsolidationMemoryTool, type MemoryConsolidationOp } from "./memoryConsolidation";
import { memoryLogicalKey, MemoryMetaService } from "./memoryMeta";
import { MemoryService, projectMemoryDirName, type MemoryScopeContext } from "./memoryService";
import { TestTempDir, mockToolCallOptions } from "./tools/testHelpers";
import { workspaceRemovalTombstonePath } from "./workspaceRemoval";

/**
 * Behavior under test: the consolidation rails (scope restriction, pin
 * protection, op budget, dry-run interception, journal) enforced by the
 * guarded memory tool — in code, independent of the model and the agent
 * prompt.
 */

interface Fixture extends Disposable {
  xumHome: string;
  metaService: MemoryMetaService;
  memoryService: MemoryService;
  ctx: MemoryScopeContext;
  journal: MemoryConsolidationOp[];
  tool: Tool;
  getMutationCount: () => number;
  globalMemoryDir: string;
  projectMemoryDir: string;
}

async function createFixture(options?: {
  dryRun?: boolean;
  projectPath?: string;
}): Promise<Fixture> {
  const tempDir = new TestTempDir("test-memory-consolidation");
  const xumHome = path.join(tempDir.path, "mux-home");
  const globalMemoryDir = path.join(xumHome, "memory", "global");
  const projectMemoryDir =
    options?.projectPath != null && options.projectPath !== ""
      ? path.join(xumHome, "memory", "project", projectMemoryDirName(options.projectPath))
      : "";
  await fsPromises.mkdir(globalMemoryDir, { recursive: true });

  const metaService = new MemoryMetaService(xumHome);
  const memoryService = new MemoryService(new Config(xumHome), metaService);
  const ctx: MemoryScopeContext = {
    runtime: null,
    checkoutCwd: "",
    workspaceId: "ws-consolidation",
    projectPath: options?.projectPath ?? "",
  };
  const journal: MemoryConsolidationOp[] = [];
  const { tool, getMutationCount } = createConsolidationMemoryTool({
    memoryService,
    metaService,
    ctx,
    dryRun: options?.dryRun ?? false,
    journal,
  });
  return {
    xumHome,
    metaService,
    memoryService,
    ctx,
    journal,
    globalMemoryDir,
    projectMemoryDir,
    tool,
    getMutationCount,
    [Symbol.dispose]() {
      tempDir[Symbol.dispose]();
    },
  };
}

function pathExists(target: string): Promise<boolean> {
  return fsPromises.access(target).then(
    () => true,
    () => false
  );
}

type MemoryExecuteResult = { success: true; output: string } | { success: false; error: string };

async function execute(tool: Tool, input: Record<string, unknown>): Promise<MemoryExecuteResult> {
  const parsed = TOOL_DEFINITIONS.memory.schema.parse(input);
  return (await tool.execute!(parsed, mockToolCallOptions)) as MemoryExecuteResult;
}

describe("consolidation memory tool rails", () => {
  it("a mutation wedged before commit refuses once the pass is cancelled (r59)", async () => {
    // Tool executions receive no hard cancellation: a live run wedged in
    // pre-commit I/O is detached by the caller's bounded drain, and once
    // the wedge unblocked it used to commit durable memory AND append its
    // refinement journal row into the (by then deleted) session directory,
    // recreating it. The abort signal must make the mutation refuse INSIDE
    // the target lock instead.
    using fixture = await createFixture();
    // Seed the target directly on disk: going through the service would
    // journal the create and pre-create the session directory this test
    // asserts is never materialized.
    const targetPath = path.join(fixture.globalMemoryDir, "wedged.md");
    await fsPromises.writeFile(targetPath, "contents that must survive\n");

    const controller = new AbortController();
    const { tool } = createConsolidationMemoryTool({
      memoryService: fixture.memoryService,
      metaService: fixture.metaService,
      ctx: fixture.ctx,
      dryRun: false,
      journal: [],
      abortSignal: controller.signal,
    });
    // Wedge the guard's pin lookup (the delete path's pre-commit I/O).
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => (releaseGate = resolve));
    const entriesSpy = spyOn(fixture.metaService, "getEntries").mockImplementation(async () => {
      await gate;
      return new Map();
    });
    try {
      const pending = execute(tool, { command: "delete", path: "/memories/global/wedged.md" });
      // Teardown races in while the execution is wedged.
      controller.abort();
      releaseGate();
      const result = await pending;
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain("cancelled before commit");
    } finally {
      entriesSpy.mockRestore();
    }
    // Nothing durable landed: the target survived and no refinement journal
    // row recreated the workspace's session directory.
    expect(await fsPromises.readFile(targetPath, "utf-8")).toContain("must survive");
    const sessionDir = path.join(fixture.xumHome, "sessions", fixture.ctx.workspaceId);
    expect(
      await fsPromises.access(sessionDir).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  it("a durable removal tombstone refuses memory mutations at commit (r61)", async () => {
    // Cross-process teardown: with multiple backends over one Xum root, the
    // remover cannot abort a foreign backend's dream run — its mutations
    // must observe the durable tombstone at commit time and refuse, without
    // any abort signal, so they cannot recreate the deleted session dir.
    using fixture = await createFixture();
    const tombstonePath = workspaceRemovalTombstonePath(fixture.xumHome, fixture.ctx.workspaceId);
    await fsPromises.mkdir(path.dirname(tombstonePath), { recursive: true });
    await fsPromises.writeFile(
      tombstonePath,
      JSON.stringify({ workspaceId: fixture.ctx.workspaceId, removedAt: Date.now() })
    );

    const created = await fixture.memoryService.create(
      fixture.ctx,
      "/memories/global/after-removal.md",
      "must not land\n",
      "agent"
    );
    expect(created.success).toBe(false);
    if (!created.success) expect(created.error).toContain("was removed");
    expect(
      await fsPromises.access(path.join(fixture.globalMemoryDir, "after-removal.md")).then(
        () => true,
        () => false
      )
    ).toBe(false);

    // The harvest inbox path (saveFile) refuses through the same check.
    const saved = await fixture.memoryService.saveFile(
      fixture.ctx,
      "/memories/workspace/harvest/inbox.md",
      "late inbox\n",
      null,
      "agent"
    );
    expect(saved.success).toBe(false);
    // No session directory materialized by either refusal.
    const sessionDir = path.join(fixture.xumHome, "sessions", fixture.ctx.workspaceId);
    expect(
      await fsPromises.access(sessionDir).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  it("a cancelled pass refuses new executions at entry (r59)", async () => {
    using fixture = await createFixture();
    const targetPath = path.join(fixture.globalMemoryDir, "entry.md");
    await fsPromises.writeFile(targetPath, "original\n");
    const controller = new AbortController();
    controller.abort();
    const { tool } = createConsolidationMemoryTool({
      memoryService: fixture.memoryService,
      metaService: fixture.metaService,
      ctx: fixture.ctx,
      dryRun: false,
      journal: [],
      abortSignal: controller.signal,
    });
    const result = await execute(tool, {
      command: "str_replace",
      path: "/memories/global/entry.md",
      old_str: "original",
      new_str: "clobbered",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("cancelled");
    expect(await fsPromises.readFile(targetPath, "utf-8")).toContain("original");
  });

  it("applies in-scope mutations and journals them", async () => {
    using fixture = await createFixture();
    const result = await execute(fixture.tool, {
      command: "create",
      path: "/memories/global/lesson.md",
      file_text: "a durable lesson\n",
    });
    expect(result.success).toBe(true);
    expect(
      await fsPromises.readFile(path.join(fixture.globalMemoryDir, "lesson.md"), "utf-8")
    ).toContain("durable lesson");
    expect(fixture.journal).toEqual([
      { command: "create", path: "/memories/global/lesson.md", applied: true, note: undefined },
    ]);
  });

  it("applies project-scope mutations when the run has a single project identity", async () => {
    using fixture = await createFixture({ projectPath: "/projects/demo" });

    const result = await execute(fixture.tool, {
      command: "create",
      path: "/memories/project/lesson.md",
      file_text: "repo-specific lesson\n",
    });

    expect(result.success).toBe(true);
    expect(
      await fsPromises.readFile(path.join(fixture.projectMemoryDir, "lesson.md"), "utf-8")
    ).toBe("repo-specific lesson\n");
    expect(fixture.journal).toEqual([
      { command: "create", path: "/memories/project/lesson.md", applied: true, note: undefined },
    ]);
  });

  it("rejects project-scope mutations but allows reads to pass through", async () => {
    using fixture = await createFixture();
    const mutation = await execute(fixture.tool, {
      command: "delete",
      path: "/memories/project/note.md",
    });
    expect(mutation.success).toBe(false);
    if (!mutation.success) expect(mutation.error).toContain("single-project runs");
    expect(fixture.journal[0]?.applied).toBe(false);

    // Reads are unguarded by the tool, so out-of-scope privacy relies on the
    // ctx: project is structurally disabled, while global reads pass through.
    const projectRead = await execute(fixture.tool, {
      command: "view",
      path: "/memories/project/",
    });
    expect(projectRead.success).toBe(false);
    const read = await execute(fixture.tool, { command: "view", path: "/memories/global/" });
    expect(read.success).toBe(true);
  });

  it("never deletes or renames pinned files but allows editing them", async () => {
    using fixture = await createFixture();
    await fsPromises.writeFile(path.join(fixture.globalMemoryDir, "pinned.md"), "keep me\n");
    await fixture.metaService.setPinned(
      memoryLogicalKey("global", "pinned.md", {
        projectPath: fixture.ctx.projectPath,
        workspaceId: fixture.ctx.workspaceId,
      }),
      true
    );

    const deletion = await execute(fixture.tool, {
      command: "delete",
      path: "/memories/global/pinned.md",
    });
    expect(deletion.success).toBe(false);
    if (!deletion.success) expect(deletion.error).toContain("pinned");

    const rename = await execute(fixture.tool, {
      command: "rename",
      old_path: "/memories/global/pinned.md",
      new_path: "/memories/global/moved.md",
    });
    expect(rename.success).toBe(false);

    const edit = await execute(fixture.tool, {
      command: "str_replace",
      path: "/memories/global/pinned.md",
      old_str: "keep me",
      new_str: "keep me, polished",
    });
    expect(edit.success).toBe(true);
    expect(
      await fsPromises.readFile(path.join(fixture.globalMemoryDir, "pinned.md"), "utf-8")
    ).toContain("polished");
  });

  it("rejects deleting or renaming a directory that contains a pinned file", async () => {
    using fixture = await createFixture();
    const nestedDir = path.join(fixture.globalMemoryDir, "nested");
    await fsPromises.mkdir(nestedDir, { recursive: true });
    await fsPromises.writeFile(path.join(nestedDir, "pinned.md"), "keep me\n");
    await fixture.metaService.setPinned(
      memoryLogicalKey("global", "nested/pinned.md", {
        projectPath: fixture.ctx.projectPath,
        workspaceId: fixture.ctx.workspaceId,
      }),
      true
    );

    // Directory delete is recursive on disk; the guard must check the whole
    // subtree, not just the directory's own (unpinned) key.
    const deletion = await execute(fixture.tool, {
      command: "delete",
      path: "/memories/global/nested",
    });
    expect(deletion.success).toBe(false);
    if (!deletion.success) expect(deletion.error).toContain("pinned");
    expect(await pathExists(path.join(nestedDir, "pinned.md"))).toBe(true);

    const rename = await execute(fixture.tool, {
      command: "rename",
      old_path: "/memories/global/nested",
      new_path: "/memories/global/renamed",
    });
    expect(rename.success).toBe(false);
    expect(await pathExists(path.join(nestedDir, "pinned.md"))).toBe(true);
  });

  it("never deletes or renames pinned project files but allows editing them", async () => {
    using fixture = await createFixture({ projectPath: "/projects/demo" });
    await fsPromises.mkdir(fixture.projectMemoryDir, { recursive: true });
    await fsPromises.writeFile(path.join(fixture.projectMemoryDir, "pinned.md"), "keep me\n");
    await fixture.metaService.setPinned(
      memoryLogicalKey("project", "pinned.md", {
        projectPath: fixture.ctx.projectPath,
        workspaceId: fixture.ctx.workspaceId,
      }),
      true
    );

    const deletion = await execute(fixture.tool, {
      command: "delete",
      path: "/memories/project/pinned.md",
    });
    expect(deletion.success).toBe(false);
    if (!deletion.success) expect(deletion.error).toContain("pinned");

    const rename = await execute(fixture.tool, {
      command: "rename",
      old_path: "/memories/project/pinned.md",
      new_path: "/memories/project/moved.md",
    });
    expect(rename.success).toBe(false);

    const edit = await execute(fixture.tool, {
      command: "str_replace",
      path: "/memories/project/pinned.md",
      old_str: "keep me",
      new_str: "keep me, polished",
    });
    expect(edit.success).toBe(true);
    expect(
      await fsPromises.readFile(path.join(fixture.projectMemoryDir, "pinned.md"), "utf-8")
    ).toContain("polished");
  });

  it("never over-commits the budget when mutating tool calls run concurrently", async () => {
    using fixture = await createFixture();
    // Consume all but the last budget slot.
    for (let i = 0; i < MEMORY_CONSOLIDATION_OP_BUDGET - 1; i++) {
      const result = await execute(fixture.tool, {
        command: "create",
        path: `/memories/global/file-${i}.md`,
        file_text: "x\n",
      });
      expect(result.success).toBe(true);
    }

    // The AI SDK executes parallel tool calls concurrently; check + reserve
    // must happen in one synchronous block so exactly one of these wins.
    const [a, b] = await Promise.all([
      execute(fixture.tool, {
        command: "create",
        path: "/memories/global/race-a.md",
        file_text: "x\n",
      }),
      execute(fixture.tool, {
        command: "create",
        path: "/memories/global/race-b.md",
        file_text: "x\n",
      }),
    ]);
    expect([a.success, b.success].filter(Boolean)).toHaveLength(1);
    expect(fixture.getMutationCount()).toBe(MEMORY_CONSOLIDATION_OP_BUDGET);
    const loser = a.success ? b : a;
    if (!loser.success) expect(loser.error).toContain("budget");
  });

  it("exhausts the mutation budget and rejects further mutations while reads continue", async () => {
    using fixture = await createFixture();
    for (let i = 0; i < MEMORY_CONSOLIDATION_OP_BUDGET; i++) {
      const result = await execute(fixture.tool, {
        command: "create",
        path: `/memories/global/file-${i}.md`,
        file_text: "x\n",
      });
      expect(result.success).toBe(true);
    }

    const overBudget = await execute(fixture.tool, {
      command: "create",
      path: "/memories/global/one-too-many.md",
      file_text: "x\n",
    });
    expect(overBudget.success).toBe(false);
    if (!overBudget.success) expect(overBudget.error).toContain("budget");
    expect(await pathExists(path.join(fixture.globalMemoryDir, "one-too-many.md"))).toBe(false);

    const read = await execute(fixture.tool, { command: "view", path: "/memories/global/" });
    expect(read.success).toBe(true);
  });

  it("dry-run journals proposed mutations without touching disk and still consumes budget", async () => {
    using fixture = await createFixture({ dryRun: true });
    const result = await execute(fixture.tool, {
      command: "create",
      path: "/memories/global/proposed.md",
      file_text: "x\n",
    });
    expect(result.success).toBe(true);
    expect(await pathExists(path.join(fixture.globalMemoryDir, "proposed.md"))).toBe(false);
    expect(fixture.journal).toEqual([
      { command: "create", path: "/memories/global/proposed.md", applied: false, note: "dry-run" },
    ]);

    // Budget parity with real runs: dry-run proposals are budgeted too.
    for (let i = 1; i < MEMORY_CONSOLIDATION_OP_BUDGET; i++) {
      await execute(fixture.tool, {
        command: "create",
        path: `/memories/global/p-${i}.md`,
        file_text: "x\n",
      });
    }
    const overBudget = await execute(fixture.tool, {
      command: "delete",
      path: "/memories/global/proposed.md",
    });
    expect(overBudget.success).toBe(false);
  });

  it("dry-run rejects proposals the real write path would reject", async () => {
    // Codex round 18: the dry-run staging path returned before
    // executeMemoryCommand, skipping the real service's arg validation and
    // the memory file cap — an oversized/invalid mutation staged
    // successfully, was rendered into chat, and /refine apply later rejected
    // it through the real handler, consuming the staged set as a no-op after
    // the user approved.
    using fixture = await createFixture({ dryRun: true });

    // Over the real write cap: must fail staging with the real cap error.
    const overCap = await execute(fixture.tool, {
      command: "create",
      path: "/memories/global/too-big.md",
      file_text: "x".repeat(MEMORY_MAX_FILE_BYTES + 1),
    });
    expect(overCap.success).toBe(false);
    if (!overCap.success) expect(overCap.error).toContain(`${MEMORY_MAX_FILE_BYTES}`);

    // Missing required args: must fail staging with the real arg error.
    const missingArgs = await execute(fixture.tool, {
      command: "create",
      path: "/memories/global/no-text.md",
    });
    expect(missingArgs.success).toBe(false);
    if (!missingArgs.success) expect(missingArgs.error).toContain("file_text");

    // Both rejections journal as unapplied with the error, never as staged.
    expect(fixture.journal.every((op) => !op.applied && op.note !== "dry-run")).toBe(true);
  });

  it("dry-run rejects state-dependent mutations whose RESULT exceeds the cap", async () => {
    // Codex round 19: the round-18 check measured only the NEW text, but the
    // real write path caps the RESULTING file — inserting 2KiB into a 99KiB
    // file staged successfully, rendered approvable, then apply rejected it
    // and consumed the proposal. Validation must simulate the result.
    using fixture = await createFixture({ dryRun: true });
    const nearCap = `UNIQUE_MARKER${"x".repeat(MEMORY_MAX_FILE_BYTES - 1024)}`;
    await fsPromises.writeFile(path.join(fixture.globalMemoryDir, "near-cap.md"), nearCap);

    const smallInsert = await execute(fixture.tool, {
      command: "insert",
      path: "/memories/global/near-cap.md",
      insert_line: 0,
      insert_text: "y".repeat(2 * 1024),
    });
    expect(smallInsert.success).toBe(false);
    if (!smallInsert.success) expect(smallInsert.error).toContain(`${MEMORY_MAX_FILE_BYTES}`);

    // Same result-size rule for str_replace growth on an existing file
    // (unique old_str so the failure is the cap, not the occurrence check).
    const growingReplace = await execute(fixture.tool, {
      command: "str_replace",
      path: "/memories/global/near-cap.md",
      old_str: "UNIQUE_MARKER",
      new_str: "y".repeat(2 * 1024),
    });
    expect(growingReplace.success).toBe(false);
    if (!growingReplace.success) {
      expect(growingReplace.error).toContain(`${MEMORY_MAX_FILE_BYTES}`);
    }

    // A result that stays under the cap still stages.
    const fits = await execute(fixture.tool, {
      command: "insert",
      path: "/memories/global/near-cap.md",
      insert_line: 0,
      insert_text: "small note",
    });
    expect(fits.success).toBe(true);
    // Dry-run: the target file is untouched.
    const onDisk = await fsPromises.readFile(
      path.join(fixture.globalMemoryDir, "near-cap.md"),
      "utf-8"
    );
    expect(onDisk).toBe(nearCap);
  });

  it("dry-run rejects a create into a full memory scope", async () => {
    // Codex round 20: validateMutation accepted a create whenever the target
    // was free, but the real create() also rejects when the scope already
    // holds MEMORY_MAX_FILES_PER_SCOPE files — the proposal staged, rendered
    // approvable, then apply rejected it and consumed the set.
    using fixture = await createFixture({ dryRun: true });
    await Promise.all(
      Array.from({ length: MEMORY_MAX_FILES_PER_SCOPE }, (_, i) =>
        fsPromises.writeFile(path.join(fixture.globalMemoryDir, `filler-${i}.md`), "x\n")
      )
    );

    const intoFull = await execute(fixture.tool, {
      command: "create",
      path: "/memories/global/one-more.md",
      file_text: "must not stage\n",
    });
    expect(intoFull.success).toBe(false);
    if (!intoFull.success) expect(intoFull.error).toContain("full");
  });

  it("dry-run rejects renaming a directory into its own subtree", async () => {
    // Codex round 21: source exists and the exact destination doesn't, so
    // 'notes' -> 'notes/archive/notes' staged, rendered approvable, then the
    // filesystem rejected moving a dir into itself at apply — consuming the
    // approved set. Segment-aware: 'notes-x' must not match 'notes'.
    using fixture = await createFixture({ dryRun: true });
    await fsPromises.mkdir(path.join(fixture.globalMemoryDir, "notes"), { recursive: true });
    await fsPromises.writeFile(path.join(fixture.globalMemoryDir, "notes", "a.md"), "a\n");

    const intoSelf = await execute(fixture.tool, {
      command: "rename",
      old_path: "/memories/global/notes",
      new_path: "/memories/global/notes/archive/notes",
    });
    expect(intoSelf.success).toBe(false);
    if (!intoSelf.success) expect(intoSelf.error).toContain("inside itself");

    // Segment-aware sibling: 'notes-x' shares the prefix but is NOT inside
    // 'notes' — it must stage normally.
    const sibling = await execute(fixture.tool, {
      command: "rename",
      old_path: "/memories/global/notes",
      new_path: "/memories/global/notes-x",
    });
    expect(sibling.success).toBe(true);
  });

  it("dry-run rejects own-subtree renames reached through an aliased path", async () => {
    // Codex round 22 (mirrors the memoryService handler test): staging
    // validation shares the physical-identity guard, so an aliased spelling
    // of the source (case variant on case-insensitive hosts; symlink here,
    // which CI can exercise) must refuse at staging instead of consuming the
    // approved set at apply.
    using fixture = await createFixture({ dryRun: true });
    await fsPromises.mkdir(path.join(fixture.globalMemoryDir, "notes"), { recursive: true });
    await fsPromises.writeFile(path.join(fixture.globalMemoryDir, "notes", "a.md"), "a\n");
    await fsPromises.symlink("notes", path.join(fixture.globalMemoryDir, "alias"));

    const throughAlias = await execute(fixture.tool, {
      command: "rename",
      old_path: "/memories/global/notes",
      new_path: "/memories/global/alias/archive/notes",
    });
    expect(throughAlias.success).toBe(false);
    if (!throughAlias.success) expect(throughAlias.error).toContain("inside itself");
  });

  it("dry-run rejects delete/rename proposals the real handlers would reject", async () => {
    // Codex round 20: delete/rename skipped staging validation entirely —
    // deleting a nonexistent path, renaming a missing source, or renaming
    // onto an existing destination staged and presented for approval, then
    // failed at apply and consumed the set.
    using fixture = await createFixture({ dryRun: true });
    await fsPromises.writeFile(path.join(fixture.globalMemoryDir, "exists-a.md"), "a\n");
    await fsPromises.writeFile(path.join(fixture.globalMemoryDir, "exists-b.md"), "b\n");

    // Rename onto an existing destination: refused with the real error.
    const ontoExisting = await execute(fixture.tool, {
      command: "rename",
      old_path: "/memories/global/exists-a.md",
      new_path: "/memories/global/exists-b.md",
    });
    expect(ontoExisting.success).toBe(false);
    if (!ontoExisting.success) expect(ontoExisting.error).toContain("already exists");

    // Rename of a missing source: refused.
    const missingSource = await execute(fixture.tool, {
      command: "rename",
      old_path: "/memories/global/missing.md",
      new_path: "/memories/global/fresh.md",
    });
    expect(missingSource.success).toBe(false);

    // Delete of a nonexistent path: refused.
    const missingDelete = await execute(fixture.tool, {
      command: "delete",
      path: "/memories/global/never-existed.md",
    });
    expect(missingDelete.success).toBe(false);
    if (!missingDelete.success) {
      expect(missingDelete.error).toContain("No memory file or directory");
    }

    // Valid delete/rename still stage — and touch nothing on disk.
    const validRename = await execute(fixture.tool, {
      command: "rename",
      old_path: "/memories/global/exists-a.md",
      new_path: "/memories/global/renamed-a.md",
    });
    expect(validRename.success).toBe(true);
    const validDelete = await execute(fixture.tool, {
      command: "delete",
      path: "/memories/global/exists-b.md",
    });
    expect(validDelete.success).toBe(true);
    expect(await pathExists(path.join(fixture.globalMemoryDir, "exists-a.md"))).toBe(true);
    expect(await pathExists(path.join(fixture.globalMemoryDir, "exists-b.md"))).toBe(true);
  });

  it("journals failed dispatches as unapplied with the error note", async () => {
    using fixture = await createFixture();
    const result = await execute(fixture.tool, {
      command: "str_replace",
      path: "/memories/global/missing.md",
      old_str: "nothing",
      new_str: "something",
    });
    expect(result.success).toBe(false);
    expect(fixture.journal).toHaveLength(1);
    expect(fixture.journal[0]?.applied).toBe(false);
    expect(fixture.journal[0]?.note).toBeDefined();
  });
});
