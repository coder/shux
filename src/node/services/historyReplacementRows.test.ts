import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import {
  SESSION_HISTORY_MAX_LINE_BYTES,
  SESSION_HISTORY_RESET_NEEDLE,
  SESSION_HISTORY_SCAN_CHUNK_BYTES,
} from "@/common/constants/contextBudget";
import { isNonNegativeInteger } from "@/common/utils/numbers";
import { normalizeLegacyMuxMetadata } from "@/node/utils/messages/legacy";
import {
  createRawHistoryResetProbe,
  createUnreadableHistoryResetProbe,
  hasRawResetMarker,
  hasAmbiguousResetKeys,
  hasUnreadableHistoryResetEvidence,
  isReadableHistoryMessage,
} from "./historyScanner";
import {
  equalHistoryReplacementRows,
  scanHistoryReplacementRows,
  type HistoryReplacementRow,
} from "./historyReplacementRows";

const message = (text = "hello") => ({
  id: "message",
  role: "user",
  parts: [{ type: "text", text }],
  metadata: { historySequence: 3, compactionReplacementNonce: "nonce" },
});
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function oracle(content: Buffer) {
  const text = content.toString("utf8");
  try {
    const value: unknown = JSON.parse(text);
    if (!isReadableHistoryMessage(value)) return {};
    const row = normalizeLegacyMuxMetadata(value);
    const protectedReset =
      (hasRawResetMarker(text) && hasAmbiguousResetKeys(text)) ||
      (content.length > SESSION_HISTORY_MAX_LINE_BYTES &&
        hasUnreadableHistoryResetEvidence([content]));
    return {
      id: row.id,
      sequence:
        typeof row.metadata?.historySequence === "number"
          ? row.metadata.historySequence
          : undefined,
      protectedReset,
      matchesNonce:
        !!row.metadata &&
        "compactionReplacementNonce" in row.metadata &&
        row.metadata.compactionReplacementNonce === "nonce",
      candidate:
        !protectedReset &&
        row.id.length > 0 &&
        String(row.role) !== "system" &&
        isNonNegativeInteger(row.metadata?.historySequence) &&
        (content.equals(Buffer.from(JSON.stringify(row))) ||
          (Buffer.from(text).equals(content) && !hasAmbiguousResetKeys(text))),
    };
  } catch {
    return {};
  }
}

describe("replacement history row evidence", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "replacement-rows-"));
  });
  afterEach(async () => {
    mock.restore();
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function collect(content: string | Buffer, name = "chat.jsonl") {
    const file = path.join(directory, name);
    await fs.writeFile(file, content);
    const rows: HistoryReplacementRow[] = [];
    await scanHistoryReplacementRows(
      file,
      (row) => {
        rows.push(row);
      },
      { id: "message", nonce: "nonce" }
    );
    return rows;
  }

  it.each(["append-after-empty-stat", "replace-after-stat"] as const)(
    "keeps row tokens and reverse reset evidence on one captured handle: %s",
    async (mutation) => {
      const file = path.join(directory, "chat.jsonl");
      const original = JSON.stringify(message("x".repeat(SESSION_HISTORY_MAX_LINE_BYTES))).replace(
        '"metadata":{',
        '"metadata":{"contextBoundaryKind":"other","other":"reset",'
      );
      const replacement = original
        .replace('"id":"message"', '"id":"changed"')
        .replace('"other":"reset"', '"other":"unset"');
      await fs.writeFile(file, mutation === "append-after-empty-stat" ? "" : original);
      const open = fs.open;
      let captured: fs.FileHandle | undefined;
      spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (!captured) {
          captured = handle;
          const stat = handle.stat.bind(handle);
          spyOn(handle, "stat").mockImplementation(
            new Proxy(stat, {
              async apply(target, _receiver, args: Parameters<typeof stat>) {
                const snapshot = await target(...args);
                if (mutation === "append-after-empty-stat") {
                  await fs.appendFile(file, JSON.stringify(message()));
                } else {
                  const next = path.join(directory, "next.jsonl");
                  await fs.writeFile(next, replacement);
                  await fs.rename(next, file);
                }
                return snapshot;
              },
            })
          );
        }
        return handle;
      });
      const rows: HistoryReplacementRow[] = [];
      expect(
        await scanHistoryReplacementRows(
          file,
          (row) => {
            rows.push(row);
          },
          {
            id: "message",
            nonce: "nonce",
          }
        )
      ).toBe(true);
      expect(captured?.fd).toBe(-1);
      if (mutation === "append-after-empty-stat") {
        expect(rows).toEqual([]);
        expect(await fs.readFile(file, "utf8")).toBe(JSON.stringify(message()));
      } else {
        expect(rows).toHaveLength(1);
        expect(rows[0].row.sha256).toBe(digest(original));
        expect(rows[0].identity?.id.matchesExpected).toBe(true);
        expect(rows[0].protectedReset).toBe(true);
        expect(rows[0].replacementCandidate).toBe(false);
        expect(await fs.readFile(file, "utf8")).toBe(replacement);
      }
    }
  );

  it.each(["system", "user", "assistant"] as const)(
    "legacy array role %s has identical small and oversized witness eligibility",
    async (role) => {
      for (const size of [8, SESSION_HISTORY_MAX_LINE_BYTES + 1]) {
        const raw = JSON.stringify({ ...message("x".repeat(size)), role: [role] });
        const [row] = await collect(raw);
        expect(row.identity?.id.matchesExpected).toBe(true);
        expect(row.matchesNonce).toBe(true);
        expect(row.replacementCandidate).toBe(role !== "system");
      }
    }
  );

  it.each(["empty", "continue", "stop", "equal", "unequal"] as const)(
    "preserves cancellation during outer file disposal: %s",
    async (mode) => {
      const text = JSON.stringify(message());
      const [left] = await collect(text);
      const [right] = await collect(text.replace("hello", "other"), "archive.jsonl");
      right.row.sha256 = left.row.sha256; // Exact byte comparison must still detect a mismatch.
      if (mode === "empty") await fs.writeFile(left.file, "");
      const controller = new AbortController();
      const reason = { canceled: "outer disposal" };
      const open = fs.open;
      let outer: fs.FileHandle | undefined;
      spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (!outer) {
          outer = handle;
          const dispose = handle[Symbol.asyncDispose].bind(handle);
          spyOn(handle, Symbol.asyncDispose).mockImplementation(async () => {
            await dispose();
            controller.abort(reason);
          });
        }
        return handle;
      });
      const result = await (
        mode === "equal" || mode === "unequal"
          ? equalHistoryReplacementRows(left, mode === "equal" ? left : right, controller.signal)
          : scanHistoryReplacementRows(left.file, () => mode !== "stop", {
              signal: controller.signal,
            })
      ).catch((error: unknown) => error);
      expect(result).toBe(reason);
      expect(outer?.fd).toBe(-1);
    }
  );
  it("matches the owning reader's small and oversized classification", async () => {
    const small = JSON.stringify(message());
    const huge = JSON.stringify(message("x".repeat(SESSION_HISTORY_MAX_LINE_BYTES)));
    const raws = [
      small,
      " " + small,
      small.replace('"id":"message"', '"id":"m\\u0065ssage"'),
      small.replace('"id":"message"', '"id":"old","id":"message"'),
      small.replace('"role":"user"', '"role":["user"]'),
      small.replace('"role":"user"', '"role":"system"'),
      small.replace('"historySequence":3', '"historySequence":1e999'),
      small.replace('"metadata":{', '"metadata":{"cmuxMetadata":{},'),
      huge,
      " " + huge,
      huge.replace('"metadata":{', '"metadata":{"idleCompacted":true,'),
      huge.replace('"metadata":{', '"metadata":{"compacted":true,'),
      huge.replace('"metadata":{', '"metadata":{"cmuxMetadata":{},'),
      small.replace('"metadata":{', '"metadata":{"contextBoundaryKind":"reset",'),
      huge.replace('"metadata":{', '"metadata":{"contextBoundaryKind":"reset",'),
      huge.replace('"metadata":{', '"metadata":{"contextBoundaryKind":"other","other":"reset",'),
      huge.replace('"metadata":{', '"metadata":{"context\\u0000BoundaryKind":"reset",'),
      huge.replace('"type":"text"', '"type":"bad"'),
      '{"id":"message",',
      small + "garbage",
      "null",
      "",
    ].map((raw) => Buffer.from(raw));
    raws.push(
      Buffer.concat([Buffer.from('{"id":"'), Buffer.from([255]), Buffer.from(small.slice(7))])
    );
    const content = Buffer.concat(raws.flatMap((raw) => [raw, Buffer.from("\n")]));
    const rows = await collect(content);
    expect(rows).toHaveLength(raws.length);
    let offset = 0;
    for (const [index, raw] of raws.entries()) {
      const expected = oracle(raw);
      const row = rows[index];
      expect(row.identity !== undefined, `identity row ${index}`).toBe(expected.id !== undefined);
      expect(row.replacementCandidate, `candidate row ${index}`).toBe(expected.candidate ?? false);
      expect(row.protectedReset, `reset row ${index}`).toBe(expected.protectedReset ?? false);
      expect(row.matchesNonce).toBe(expected.matchesNonce ?? false);
      expect(row.row.start).toBe(offset);
      expect(row.row.byteLength).toBe(raw.length);
      expect(row.row.sha256).toBe(digest(raw));
      if (expected.id !== undefined) {
        expect(row.identity?.id.length).toBe(expected.id.length);
        expect(row.identity?.id.sha256).toBe(digest(Buffer.from(expected.id, "utf16le")));
        expect(row.identity?.sequence).toBe(expected.sequence);
      }
      offset += raw.length + 1;
    }
    expect(rows[0].replacementCandidate).toBe(true);
    expect(rows[1].replacementCandidate).toBe(true);
    expect(rows[8].replacementCandidate).toBe(true);
    expect(rows[9].replacementCandidate).toBe(false);
  });

  it("preserves both raw-marker and reverse-token reset rules on oversized rows", async () => {
    const huge = JSON.stringify(message("x".repeat(SESSION_HISTORY_MAX_LINE_BYTES)));
    const rawOnly = huge.replace(
      '"metadata":{',
      '"metadata":{"context\\u0000BoundaryKind":"reset",'
    );
    const reverseOnly = huge.replace(
      '"metadata":{',
      '"metadata":{"contextBoundaryKind":"other","other":"reset",'
    );
    expect(hasRawResetMarker(rawOnly)).toBe(true);
    const reverseProbe = createUnreadableHistoryResetProbe();
    reverseProbe.push(Buffer.from(rawOnly));
    expect(reverseProbe.hasReset()).toBe(false);
    expect(hasRawResetMarker(reverseOnly)).toBe(false);
    expect(hasUnreadableHistoryResetEvidence([Buffer.from(reverseOnly)])).toBe(true);
    const rows = await collect(rawOnly + "\n" + reverseOnly);
    for (const row of rows) {
      expect(row.protectedReset).toBe(true);
      expect(row.replacementCandidate).toBe(false);
      expect(row.identity?.id.matchesExpected).toBe(true);
    }
  });

  it("streams raw-reset transforms exactly across escape and UTF-8 boundaries", () => {
    const escaped = [...SESSION_HISTORY_RESET_NEEDLE]
      .map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))
      .join("");
    const samples = [
      SESSION_HISTORY_RESET_NEEDLE,
      escaped,
      escaped.replaceAll("\\u", "\\U"),
      escaped.replaceAll("\\u00", "\\X"),
      SESSION_HISTORY_RESET_NEEDLE.replace("Boundary", "\\u0000Boundary"),
      SESSION_HISTORY_RESET_NEEDLE.replace("Boundary", "\u2003Boundary"),
      SESSION_HISTORY_RESET_NEEDLE.replace("Boundary", "\\u2003Boundary"),
      SESSION_HISTORY_RESET_NEEDLE.replace("Boundary", "\\u00\\u002020Boundary"),
      '"contextBoundaryKind"' + "x".repeat(1000) + ':"reset"',
      '\\u00\\u002022contextBoundaryKind":"reset"',
      "😀" + escaped + "\\u00",
      "\ufeff" + SESSION_HISTORY_RESET_NEEDLE,
    ];
    for (const text of samples)
      for (const size of [1, 2, 3, 5, 7, 29, 64]) {
        const probe = createRawHistoryResetProbe();
        const raw = Buffer.from(text);
        for (let offset = 0; offset < raw.length; offset += size)
          probe.push(raw.subarray(offset, offset + size));
        expect(probe.finish(), `${size}: ${text}`).toBe(hasRawResetMarker(text));
      }
    let seed = 12345;
    for (let trial = 0; trial < 100; trial++) {
      let text = "";
      for (const character of SESSION_HISTORY_RESET_NEEDLE) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const code = character.charCodeAt(0).toString(16);
        text +=
          seed % 3 === 0
            ? "\\u" + code.padStart(4, "0")
            : seed % 3 === 1
              ? "\\x" + code
              : character;
        if (seed % 5 === 0) text += ["\u0000", "\\u0000", "\u2003", "\\u2003"][seed % 4];
      }
      const raw = Buffer.from(text);
      for (const size of [1, 7, 31]) {
        const probe = createRawHistoryResetProbe();
        for (let offset = 0; offset < raw.length; offset += size)
          probe.push(raw.subarray(offset, offset + size));
        expect(probe.finish()).toBe(hasRawResetMarker(text));
      }
    }
    const controls = '"context' + "\u0000 \t\u2003".repeat(100000) + 'BoundaryKind":"reset"';
    const probe = createRawHistoryResetProbe();
    const raw = Buffer.from(controls);
    for (let offset = 0; offset < raw.length; offset += SESSION_HISTORY_SCAN_CHUNK_BYTES)
      probe.push(raw.subarray(offset, offset + SESSION_HISTORY_SCAN_CHUNK_BYTES));
    expect(probe.finish()).toBe(hasRawResetMarker(controls));
  });

  it.each(["", " ", "\u0000", "\\u0000", "\\U0000", "\\x00", "\\X00", "\\u0020", "\\U0020"])(
    "preserves raw reset parity at every byte split with separator %j",
    (separator) => {
      const text = SESSION_HISTORY_RESET_NEEDLE.split("").join(separator);
      const bytes = Buffer.from(text);
      for (let split = 0; split <= bytes.length; split++) {
        const probe = createRawHistoryResetProbe();
        probe.push(bytes.subarray(0, split));
        probe.push(bytes.subarray(split));
        expect(probe.finish(), `split ${split}`).toBe(hasRawResetMarker(text));
      }
    }
  );

  it("compares exact ranges modulo LF and rejects changed bytes even with equal claimed digests", async () => {
    const raw = JSON.stringify(message("x".repeat(SESSION_HISTORY_MAX_LINE_BYTES)));
    const [left] = await collect(raw + "\n");
    const [right] = await collect(raw, "archive.jsonl");
    expect(await equalHistoryReplacementRows(left, right)).toBe(true);
    const [spaced] = await collect(" " + raw, "spaced.jsonl");
    expect(await equalHistoryReplacementRows(left, spaced)).toBe(false);
    const [different] = await collect(raw.replace('"user"', '"xxxx"'), "different.jsonl");
    different.row.sha256 = left.row.sha256;
    expect(await equalHistoryReplacementRows(left, different)).toBe(false);
    await fs.writeFile(left.file, raw.replace('"user"', '"xxxx"'));
    await fs.writeFile(right.file, raw.replace('"user"', '"xxxx"'));
    expect(await equalHistoryReplacementRows(left, right)).toBe(false);
    await fs.truncate(left.file, 3);
    const truncated = await equalHistoryReplacementRows(left, right).catch(
      (error: unknown) => error
    );
    expect(truncated).toHaveProperty("message", expect.stringContaining("captured range"));
  });

  it("fills short reads when comparing captured ranges at different offsets", async () => {
    const raw = JSON.stringify(message("Unicode 😀 " + "x".repeat(200)));
    const [left] = await collect(raw);
    const [, right] = await collect("null\n" + raw + "\n", "archive.jsonl");
    const open = fs.open;
    let reads = 0;
    spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      const read = handle.read.bind(handle);
      spyOn(handle, "read").mockImplementation(
        new Proxy(read, {
          apply(target, receiver, values: unknown[]) {
            reads++;
            if (typeof values[2] === "number") values[2] = Math.min(values[2], 7);
            return Reflect.apply(target, receiver, values) as ReturnType<typeof read>;
          },
        })
      );
      return handle;
    });
    expect(await equalHistoryReplacementRows(left, right)).toBe(true);
    expect(reads).toBeGreaterThan(2);
  });

  it("never materializes giant rows through native JSON.parse or Buffer.concat", async () => {
    const raw = JSON.stringify(message("x".repeat(3 * SESSION_HISTORY_MAX_LINE_BYTES)));
    await fs.writeFile(path.join(directory, "large.jsonl"), raw);
    const parse = JSON.parse;
    const concat = Buffer.concat.bind(Buffer);
    let largestParse = 0;
    let largestConcat = 0;
    spyOn(JSON, "parse").mockImplementation((...args: Parameters<typeof parse>) => {
      largestParse = Math.max(largestParse, Buffer.byteLength(args[0]));
      return parse(...args) as unknown;
    });
    spyOn(Buffer, "concat").mockImplementation((...args: Parameters<typeof concat>) => {
      largestConcat = Math.max(
        largestConcat,
        args[0].reduce((sum, chunk) => sum + chunk.byteLength, 0)
      );
      return concat(...args);
    });
    let candidate = false;
    await scanHistoryReplacementRows(path.join(directory, "large.jsonl"), (row) => {
      candidate = row.replacementCandidate;
    });
    expect(candidate).toBe(true);
    expect(largestParse).toBeLessThanOrEqual(SESSION_HISTORY_MAX_LINE_BYTES);
    expect(largestConcat).toBeLessThanOrEqual(SESSION_HISTORY_MAX_LINE_BYTES);
  });

  it("awaits visitors, stops before the next row and closes all acquired handles", async () => {
    const [row] = await collect(JSON.stringify(message()) + "\n" + JSON.stringify(message()));
    const open = fs.open;
    const handles: fs.FileHandle[] = [];
    spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      handles.push(handle);
      return handle;
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let visits = 0;
    const pending = scanHistoryReplacementRows(row.file, async () => {
      visits++;
      entered.resolve();
      await release.promise;
      return false;
    });
    await entered.promise;
    expect(visits).toBe(1);
    release.resolve();
    expect(await pending).toBe(false);
    expect(visits).toBe(1);
    expect(handles.every((handle) => handle.fd === -1)).toBe(true);
  });

  it("treats a missing artifact as empty but preserves cancellation and real I/O errors", async () => {
    const missing = path.join(directory, "missing.jsonl");
    expect(
      await scanHistoryReplacementRows(missing, () => {
        throw new Error("unexpected row");
      })
    ).toBe(true);
    const controller = new AbortController();
    const reason = { canceled: "while opening missing artifact" };
    const open = fs.open;
    spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
      try {
        return await open(...args);
      } finally {
        controller.abort(reason);
      }
    });
    expect(
      await scanHistoryReplacementRows(missing, () => true, { signal: controller.signal }).catch(
        (error: unknown) => error
      )
    ).toBe(reason);
    mock.restore();
    spyOn(fs, "open").mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    const denied = await scanHistoryReplacementRows(missing, () => true).catch(
      (error: unknown) => error
    );
    expect(denied).toHaveProperty("message", "denied");
  });
});
