import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import { DisposableTempDir } from "@/node/services/tempDir";
import { Journal } from "./journal";

const RowSchema = z.object({
  seq: z.number().int().nonnegative(),
  id: z.string().min(1),
  value: z.string(),
});
type Row = z.infer<typeof RowSchema>;

function makeJournal(
  dir: string,
  appendLockTimeoutMs?: number,
  testOnlyBeforeAppendWrite?: () => Promise<void>
): Journal<Row> {
  return new Journal<Row>({
    filePath: path.join(dir, "test.jsonl"),
    schema: RowSchema,
    getSeq: (row) => row.seq,
    getId: (row) => row.id,
    ...(appendLockTimeoutMs !== undefined ? { appendLockTimeoutMs } : {}),
    ...(testOnlyBeforeAppendWrite !== undefined ? { testOnlyBeforeAppendWrite } : {}),
  });
}

describe("Journal", () => {
  test("appends rows with monotonic sequence and reads them back", async () => {
    using tmp = new DisposableTempDir("journal-test");
    const journal = makeJournal(tmp.path);

    const a = await journal.append((seq) => ({ seq, id: "a", value: "first" }));
    const b = await journal.append((seq) => ({ seq, id: "b", value: "second" }));
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);

    const rows = await journal.read();
    expect(rows.map((r) => r.value)).toEqual(["first", "second"]);
  });

  test("resumes the sequence counter from existing rows (fresh instance)", async () => {
    using tmp = new DisposableTempDir("journal-test");
    await makeJournal(tmp.path).append((seq) => ({ seq, id: "a", value: "x" }));
    const reopened = makeJournal(tmp.path);
    const next = await reopened.append((seq) => ({ seq, id: "b", value: "y" }));
    expect(next.seq).toBe(1);
  });

  test("self-heals: corrupted lines never brick the journal", async () => {
    using tmp = new DisposableTempDir("journal-test");
    const filePath = path.join(tmp.path, "test.jsonl");
    const journal = makeJournal(tmp.path);
    await journal.append((seq) => ({ seq, id: "a", value: "good-1" }));
    await journal.append((seq) => ({ seq, id: "b", value: "good-2" }));

    // Inject: malformed JSON, schema-invalid row, duplicate id, torn tail.
    await fs.appendFile(filePath, "{not json at all\n");
    await fs.appendFile(filePath, `${JSON.stringify({ seq: "NaN", id: 5 })}\n`);
    await fs.appendFile(filePath, `${JSON.stringify({ seq: 0, id: "a", value: "dupe" })}\n`);
    await fs.appendFile(filePath, '{"seq":99,"id":"torn","va'); // no newline - torn write

    const reopened = makeJournal(tmp.path);
    const rows = await reopened.read();
    expect(rows.map((r) => r.value)).toEqual(["good-1", "good-2"]); // first id wins, garbage dropped

    // Appending after a torn tail heals the file (new row lands on a fresh line).
    const next = await reopened.append((seq) => ({ seq, id: "c", value: "good-3" }));
    expect(next.seq).toBe(2);
    const healed = await reopened.read();
    expect(healed.map((r) => r.value)).toEqual(["good-1", "good-2", "good-3"]);
  });

  test("read sorts by seq and returns [] for a missing file", async () => {
    using tmp = new DisposableTempDir("journal-test");
    const filePath = path.join(tmp.path, "test.jsonl");
    expect(await makeJournal(tmp.path).read()).toEqual([]);

    // Out-of-order rows on disk (e.g. merged files) come back seq-sorted.
    await fs.mkdir(tmp.path, { recursive: true });
    await fs.writeFile(
      filePath,
      `${JSON.stringify({ seq: 2, id: "c", value: "third" })}\n` +
        `${JSON.stringify({ seq: 0, id: "a", value: "first" })}\n` +
        `${JSON.stringify({ seq: 1, id: "b", value: "second" })}\n`
    );
    const rows = await makeJournal(tmp.path).read();
    expect(rows.map((r) => r.value)).toEqual(["first", "second", "third"]);
  });

  test("interleaved appends from independent instances keep seq unique and increasing", async () => {
    using tmp = new DisposableTempDir("journal-test");
    // Two instances over one file model the debug CLI appending while the
    // backend is live: each caches its own next-seq, so without cross-process
    // revalidation the second writer reuses an already-assigned sequence.
    const a = makeJournal(tmp.path);
    const b = makeJournal(tmp.path);
    const r1 = await a.append((seq) => ({ seq, id: "a1", value: "a-first" }));
    const r2 = await b.append((seq) => ({ seq, id: "b1", value: "b-first" }));
    const r3 = await a.append((seq) => ({ seq, id: "a2", value: "a-second" }));
    expect([r1.seq, r2.seq, r3.seq]).toEqual([0, 1, 2]);
    const rows = await makeJournal(tmp.path).read();
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2]);
  });

  test("append reclaims a stale lock whose owner is provably dead", async () => {
    using tmp = new DisposableTempDir("journal-test");
    const journal = makeJournal(tmp.path, 2_000);
    // A short-lived child that has already exited gives a provably dead PID
    // (ESRCH from kill(pid, 0)); crash remnants must not block appends.
    const child = spawnSync(process.execPath, ["--version"]);
    expect(child.pid).toBeGreaterThan(0);
    await fs.mkdir(tmp.path, { recursive: true });
    const lockPath = path.join(tmp.path, "test.jsonl.lock");
    await fs.writeFile(lockPath, `${child.pid}:deadbeef`, { encoding: "utf-8", flag: "wx" });

    const row = await journal.append((seq) => ({ seq, id: "a", value: "after-reclaim" }));
    expect(row.seq).toBe(0);
    // The reclaimed lock was released after the append.
    expect(
      await fs.access(lockPath).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  test("append times out (without corrupting seq) while a live process holds the lock", async () => {
    using tmp = new DisposableTempDir("journal-test");
    const journal = makeJournal(tmp.path, 150);
    await journal.append((seq) => ({ seq, id: "a", value: "before" }));
    // Our own (live) pid holds the lock: reclamation must refuse and the
    // append must give up after the timeout instead of writing unserialized.
    await fs.mkdir(tmp.path, { recursive: true });
    const lockPath = path.join(tmp.path, "test.jsonl.lock");
    await fs.writeFile(lockPath, `${process.pid}:feedface`, { encoding: "utf-8", flag: "wx" });
    try {
      await journal.append((seq) => ({ seq, id: "b", value: "blocked" }));
      expect.unreachable("append must time out while the lock is held by a live process");
    } catch (error) {
      expect(String(error)).toContain("append lock");
    }
    await fs.unlink(lockPath);
    // Recovery after release: the failed attempt must not poison the counter.
    const row = await journal.append((seq) => ({ seq, id: "c", value: "after" }));
    expect(row.seq).toBe(1);
  });

  test("a displaced appender aborts before writing a duplicate sequence", async () => {
    using tmp = new DisposableTempDir("journal-test");
    const lockPath = path.join(tmp.path, "test.jsonl.lock");
    const journalB = makeJournal(tmp.path);
    // The seam models a wrongful displacement of A's held append lock (the
    // round-11 residual): A's lock vanishes mid-append and B appends with
    // the SAME derived sequence. A must detect the loss and abort instead
    // of writing a duplicate-seq row.
    let hijack = false;
    const journalA = makeJournal(tmp.path, undefined, async () => {
      if (!hijack) return;
      hijack = false;
      await fs.unlink(lockPath);
      await journalB.append((seq) => ({ seq, id: "b", value: "b-row" }));
    });
    await journalA.append((seq) => ({ seq, id: "a0", value: "a-first" }));
    hijack = true;

    // Only A has the seam; its second append gets hijacked.
    try {
      await journalA.append((seq) => ({ seq, id: "a1", value: "a-second" }));
      expect.unreachable("a displaced appender must abort before writing");
    } catch (error) {
      expect(String(error)).toContain("no longer owned");
    }
    const rows = await makeJournal(tmp.path).read();
    expect(rows.map((r) => r.id)).toEqual(["a0", "b"]);
    expect(new Set(rows.map((r) => r.seq)).size).toBe(rows.length); // unique seqs
  });

  test("append rejects rows that fail schema validation", async () => {
    using tmp = new DisposableTempDir("journal-test");
    const journal = makeJournal(tmp.path);
    try {
      await journal.append((seq) => ({ seq, id: "", value: "empty id" }));
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(String(e)).toContain("failed schema validation");
    }
    // The failed append must not poison subsequent appends.
    const ok = await journal.append((seq) => ({ seq, id: "a", value: "fine" }));
    expect(ok.seq).toBe(0);
  });
});
