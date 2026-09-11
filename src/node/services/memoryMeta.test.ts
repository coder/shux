import { describe, it, expect, spyOn } from "bun:test";
import { Effect } from "effect";

import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { MemoryMetaService, MemoryMetaWriteError, memoryLogicalKey } from "./memoryMeta";
import { TestTempDir } from "./tools/testHelpers";
import { getErrorMessage } from "@/common/utils/errors";

describe("memoryLogicalKey", () => {
  it("keys each scope by its stable identity, never the physical path", () => {
    const ids = { projectPath: "/home/user/proj", workspaceId: "ws-1" };
    expect(memoryLogicalKey("global", "prefs.md", ids)).toBe("global:prefs.md");
    expect(memoryLogicalKey("project", "conventions.md", ids)).toBe(
      "project:/home/user/proj:conventions.md"
    );
    expect(memoryLogicalKey("workspace", "scratch.md", ids)).toBe("workspace:ws-1:scratch.md");
  });

  it("never collides when components contain the ':' separator", () => {
    // projectPath "/tmp/a:b" + "c.md" vs projectPath "/tmp/a" + "b:c.md"
    // concatenate identically without escaping; the key drives pins/stats
    // cleanup, so aliasing would pin or clear another project's memory.
    const keyA = memoryLogicalKey("project", "c.md", {
      projectPath: "/tmp/a:b",
      workspaceId: "ws-1",
    });
    const keyB = memoryLogicalKey("project", "b:c.md", {
      projectPath: "/tmp/a",
      workspaceId: "ws-1",
    });
    expect(keyA).not.toBe(keyB);

    // The escape character itself must also be escaped ('a%3Ab' vs 'a:b').
    const keyC = memoryLogicalKey("project", "c.md", {
      projectPath: "/tmp/a%3Ab",
      workspaceId: "ws-1",
    });
    expect(keyC).not.toBe(keyA);

    // '/' stays literal so segment-aware subtree matching keeps working.
    expect(memoryLogicalKey("global", "dir/file.md", { projectPath: "", workspaceId: "" })).toBe(
      "global:dir/file.md"
    );
  });
});

describe("MemoryMetaService", () => {
  it("persists pins across instances via the sidecar file", async () => {
    using tempDir = new TestTempDir("test-memory-meta");
    const service = new MemoryMetaService(tempDir.path);

    expect(await service.getPinnedKeys()).toEqual(new Set());

    await service.setPinned("global:prefs.md", true);
    await service.setPinned("workspace:ws-1:scratch.md", true);
    expect(await service.getPinnedKeys()).toEqual(
      new Set(["global:prefs.md", "workspace:ws-1:scratch.md"])
    );

    // A fresh instance must read the same pins back from disk.
    const reloaded = new MemoryMetaService(tempDir.path);
    expect(await reloaded.getPinnedKeys()).toEqual(
      new Set(["global:prefs.md", "workspace:ws-1:scratch.md"])
    );
  });

  it("unpinning removes the key", async () => {
    using tempDir = new TestTempDir("test-memory-meta");
    const service = new MemoryMetaService(tempDir.path);
    await service.setPinned("global:prefs.md", true);
    await service.setPinned("global:prefs.md", false);
    expect(await service.getPinnedKeys()).toEqual(new Set());

    const reloaded = new MemoryMetaService(tempDir.path);
    expect(await reloaded.getPinnedKeys()).toEqual(new Set());
  });

  it("self-heals a corrupt sidecar file instead of failing", async () => {
    using tempDir = new TestTempDir("test-memory-meta");
    await fsPromises.writeFile(path.join(tempDir.path, "memory-meta.json"), "{not json", "utf-8");

    const service = new MemoryMetaService(tempDir.path);
    expect(await service.getPinnedKeys()).toEqual(new Set());

    // Writes must still work after healing.
    await service.setPinned("global:prefs.md", true);
    const reloaded = new MemoryMetaService(tempDir.path);
    expect(await reloaded.getPinnedKeys()).toEqual(new Set(["global:prefs.md"]));
  });

  it("ignores entries with unexpected shapes when loading", async () => {
    using tempDir = new TestTempDir("test-memory-meta");
    await fsPromises.writeFile(
      path.join(tempDir.path, "memory-meta.json"),
      JSON.stringify({
        entries: {
          "global:good.md": { pinned: true },
          "global:bad.md": { pinned: "yes" },
          "global:not-object.md": 42,
        },
      }),
      "utf-8"
    );

    const service = new MemoryMetaService(tempDir.path);
    expect(await service.getPinnedKeys()).toEqual(new Set(["global:good.md"]));
  });

  describe("usage stats", () => {
    it("records reads and writes with counts and timestamps", async () => {
      using tempDir = new TestTempDir("test-memory-meta");
      const service = new MemoryMetaService(tempDir.path);

      const before = Date.now();
      await service.recordAccess("global:prefs.md", { write: false });
      await service.recordAccess("global:prefs.md", { write: true });
      const after = Date.now();

      const entry = (await service.getEntries()).get("global:prefs.md");
      expect(entry).toBeDefined();
      expect(entry?.accessCount).toBe(2);
      expect(entry?.lastAccessedAt).toBeGreaterThanOrEqual(before);
      expect(entry?.lastAccessedAt).toBeLessThanOrEqual(after);
      expect(entry?.lastWriteAt).toBeGreaterThanOrEqual(before);
      expect(entry?.lastWriteAt).toBeLessThanOrEqual(after);
      expect(entry?.pinned).toBe(false);

      // Stats survive a reload from disk.
      const reloaded = new MemoryMetaService(tempDir.path);
      expect((await reloaded.getEntries()).get("global:prefs.md")?.accessCount).toBe(2);
    });

    it("read-only access leaves lastWriteAt unset", async () => {
      using tempDir = new TestTempDir("test-memory-meta");
      const service = new MemoryMetaService(tempDir.path);
      await service.recordAccess("global:prefs.md", { write: false });
      const entry = (await service.getEntries()).get("global:prefs.md");
      expect(entry?.lastWriteAt).toBeNull();
      expect(entry?.lastAccessedAt).not.toBeNull();
    });

    it("pinning counts as a use; unpinning preserves stats", async () => {
      using tempDir = new TestTempDir("test-memory-meta");
      const service = new MemoryMetaService(tempDir.path);

      await service.setPinned("global:prefs.md", true);
      let entry = (await service.getEntries()).get("global:prefs.md");
      expect(entry?.pinned).toBe(true);
      expect(entry?.accessCount).toBe(1);
      expect(entry?.lastAccessedAt).not.toBeNull();

      await service.setPinned("global:prefs.md", false);
      entry = (await service.getEntries()).get("global:prefs.md");
      expect(entry?.pinned).toBe(false);
      expect(entry?.accessCount).toBe(1);
    });

    it("renameKeys moves file entries and directory subtrees", async () => {
      using tempDir = new TestTempDir("test-memory-meta");
      const service = new MemoryMetaService(tempDir.path);
      await service.recordAccess("global:notes/a.md", { write: true });
      await service.recordAccess("global:notes/deep/b.md", { write: false });
      await service.recordAccess("global:other.md", { write: false });

      await service.renameKeys("global:notes", "global:archive");

      const entries = await service.getEntries();
      expect(entries.has("global:notes/a.md")).toBe(false);
      expect(entries.get("global:archive/a.md")?.accessCount).toBe(1);
      expect(entries.get("global:archive/deep/b.md")?.accessCount).toBe(1);
      expect(entries.get("global:other.md")?.accessCount).toBe(1);
    });

    it("removeKeys drops file entries and directory subtrees", async () => {
      using tempDir = new TestTempDir("test-memory-meta");
      const service = new MemoryMetaService(tempDir.path);
      await service.setPinned("global:notes/a.md", true);
      await service.recordAccess("global:notes-unrelated.md", { write: false });

      await service.removeKeys("global:notes");

      const entries = await service.getEntries();
      expect(entries.has("global:notes/a.md")).toBe(false);
      // Prefix matching must be segment-aware: "notes-unrelated.md" survives.
      expect(entries.has("global:notes-unrelated.md")).toBe(true);
      expect(await service.getPinnedKeys()).toEqual(new Set());
    });

    it("sanitizes malformed stats fields on load", async () => {
      using tempDir = new TestTempDir("test-memory-meta");
      await fsPromises.writeFile(
        path.join(tempDir.path, "memory-meta.json"),
        JSON.stringify({
          entries: {
            "global:ok.md": { pinned: false, accessCount: 3, lastAccessedAt: 1000 },
            "global:bad-count.md": { pinned: true, accessCount: "many", lastAccessedAt: -5 },
            "global:all-defaults.md": { pinned: false, accessCount: 0 },
          },
        }),
        "utf-8"
      );

      const service = new MemoryMetaService(tempDir.path);
      const entries = await service.getEntries();
      expect(entries.get("global:ok.md")).toEqual({
        pinned: false,
        accessCount: 3,
        lastAccessedAt: 1000,
        lastWriteAt: null,
      });
      // Invalid fields heal to defaults; the pin itself survives.
      expect(entries.get("global:bad-count.md")).toEqual({
        pinned: true,
        accessCount: 0,
        lastAccessedAt: null,
        lastWriteAt: null,
      });
      // Entirely-default entries are dropped.
      expect(entries.has("global:all-defaults.md")).toBe(false);
    });
  });

  describe("interruption safety", () => {
    // Regression (codex P2 on #4022): a fiber interrupted mid-write must not
    // leave the in-memory cache diverged from disk — the write + cache update
    // are one uninterruptible unit. Race aborts at varied delays and assert
    // cache and disk agree after every settled attempt; this can never
    // false-fail, and any divergence is a real interruption-safety bug.
    it("keeps cache and disk consistent when writes race with interruption", async () => {
      using tempDir = new TestTempDir("test-memory-meta");
      const service = new MemoryMetaService(tempDir.path);

      for (let i = 0; i < 25; i++) {
        const controller = new AbortController();
        const attempt = Effect.runPromise(service.effects.setPinned(`global:race-${i}.md`, true), {
          signal: controller.signal,
        }).then(
          () => undefined,
          () => undefined // interruption/abort rejections are expected here
        );
        if (i % 5 === 0) controller.abort();
        else setTimeout(() => controller.abort(), i % 5);
        await attempt;

        // Fresh instance = authoritative disk state; original = cached state.
        const diskEntries = await new MemoryMetaService(tempDir.path).getEntries();
        const cachedEntries = await service.getEntries();
        expect(cachedEntries).toEqual(diskEntries);
      }
    });
  });
  it("does not cache an empty view taken while the sidecar was unreadable", async () => {
    using tempDir = new TestTempDir("test-memory-meta");
    const service = new MemoryMetaService(tempDir.path);
    await service.setPinned("global:prefs.md", true);
    // Transient read failure (EACCES interval): this read heals to empty, but
    // the next one must retry the file — not serve the empty view and then
    // write it back over the real pins.
    const reader = spyOn(fsPromises, "readFile").mockImplementationOnce((() =>
      Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" }))) as never);
    const reloaded = new MemoryMetaService(tempDir.path);
    expect(await reloaded.getPinnedKeys()).toEqual(new Set());
    reader.mockRestore();
    expect(await reloaded.getPinnedKeys()).toEqual(new Set(["global:prefs.md"]));
    await reloaded.setPinned("workspace:ws-1:scratch.md", true);
    expect(await new MemoryMetaService(tempDir.path).getPinnedKeys()).toEqual(
      new Set(["global:prefs.md", "workspace:ws-1:scratch.md"])
    );
  });

  it("refuses a mutation whose read of the sidecar failed instead of overwriting it", async () => {
    using tempDir = new TestTempDir("test-memory-meta");
    await new MemoryMetaService(tempDir.path).setPinned("global:prefs.md", true);
    // The mutating call itself hits the transient failure: its healed empty
    // view must not become the file, or every existing pin is erased.
    const reader = spyOn(fsPromises, "readFile").mockImplementationOnce((() =>
      Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" }))) as never);
    const fresh = new MemoryMetaService(tempDir.path);
    try {
      const failure = await fresh.setPinned("workspace:ws-1:scratch.md", true).then(
        () => null,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(MemoryMetaWriteError);
      expect((failure as MemoryMetaWriteError).reason).toContain("could not be read");
    } finally {
      reader.mockRestore();
    }
    expect(await new MemoryMetaService(tempDir.path).getPinnedKeys()).toEqual(
      new Set(["global:prefs.md"])
    );
    // Once readable again the same instance mutates normally.
    await fresh.setPinned("workspace:ws-1:scratch.md", true);
    expect(await new MemoryMetaService(tempDir.path).getPinnedKeys()).toEqual(
      new Set(["global:prefs.md", "workspace:ws-1:scratch.md"])
    );
    // getEntriesOrThrow refuses the healed substitute a plain read serves.
    const strict = new MemoryMetaService(tempDir.path);
    const strictReader = spyOn(fsPromises, "readFile").mockImplementationOnce((() =>
      Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" }))) as never);
    try {
      const failure = await strict.getEntriesOrThrow().then(
        () => null,
        (error: unknown) => error
      );
      expect(getErrorMessage(failure)).toContain("could not be read");
    } finally {
      strictReader.mockRestore();
    }
    expect((await strict.getEntriesOrThrow()).has("global:prefs.md")).toBe(true);
  });

  it("mergeKeys folds a subtree into a second key, keeping the source", async () => {
    using tempDir = new TestTempDir("test-memory-meta");
    const service = new MemoryMetaService(tempDir.path);
    // Child-keyed entries under one directory: one with no owner counterpart,
    // one whose owner entry already has larger counters and its own pin.
    await service.setPinned("workspace:ws-child:dir/only.md", true);
    await service.recordAccess("workspace:ws-child:dir/both.md", { write: true });
    await service.setPinned("workspace:ws-child:dir/both.md", true);
    for (let i = 0; i < 3; i++) {
      await service.recordAccess("workspace:ws-owner:dir/both.md", { write: false });
    }
    // A sibling whose key merely starts with the same characters is not in
    // the subtree (segment-aware matching).
    await service.setPinned("workspace:ws-child:dir-2/x.md", true);
    await service.mergeKeys("workspace:ws-child:dir", "workspace:ws-owner:dir", {
      pinned: "target",
    });
    let entries = await service.getEntries();
    // Missing target: copied. Existing target: larger counters, its own pin.
    expect(entries.get("workspace:ws-owner:dir/only.md")?.pinned).toBe(true);
    expect(entries.get("workspace:ws-owner:dir/both.md")?.pinned).toBe(false);
    expect(entries.get("workspace:ws-owner:dir/both.md")?.accessCount).toBe(3);
    expect(entries.get("workspace:ws-owner:dir/both.md")?.lastWriteAt).not.toBeNull();
    expect(entries.has("workspace:ws-owner:dir-2/x.md")).toBe(false);
    // The source stays for a downgraded build, and the fold is idempotent.
    expect(entries.get("workspace:ws-child:dir/only.md")?.pinned).toBe(true);
    await service.mergeKeys("workspace:ws-child:dir", "workspace:ws-owner:dir", {
      pinned: "target",
    });
    expect(await service.getEntries()).toEqual(entries);
    // `pinned: "source"`: the child's pin overrides the owner's.
    await service.mergeKeys("workspace:ws-child:dir/both.md", "workspace:ws-owner:dir/both.md", {
      pinned: "source",
    });
    entries = await service.getEntries();
    expect(entries.get("workspace:ws-owner:dir/both.md")?.pinned).toBe(true);
  });
});
