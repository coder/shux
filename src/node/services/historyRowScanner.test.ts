import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SESSION_HISTORY_SCAN_CHUNK_BYTES } from "@/common/constants/contextBudget";
import {
  scanHistoryRows,
  type HistoryRowDescriptor,
  type HistoryRowToken,
} from "./historyRowScanner";

// Small-fixture oracle only; production visitors must not assemble unbounded values.
function assemble(tokens: HistoryRowToken[]): unknown {
  const stack: Array<{ value: Record<string, unknown> | unknown[]; key?: string }> = [];
  let result: unknown;
  let scalar = "";
  const put = (value: unknown) => {
    const parent = stack.at(-1);
    if (!parent) result = value;
    else if (Array.isArray(parent.value)) parent.value.push(value);
    else parent.value[parent.key!] = value;
  };
  for (const token of tokens) {
    switch (token.name) {
      case "startObject":
      case "startArray": {
        const value = token.name === "startObject" ? {} : [];
        put(value);
        stack.push({ value });
        break;
      }
      case "endObject":
      case "endArray":
        stack.pop();
        break;
      case "startKey":
      case "startString":
      case "startNumber":
        scalar = "";
        break;
      case "stringChunk":
      case "numberChunk":
        scalar += token.value;
        break;
      case "endKey":
        stack.at(-1)!.key = scalar;
        break;
      case "endString":
        put(scalar);
        break;
      case "endNumber":
        put(Number(scalar));
        break;
      case "trueValue":
      case "falseValue":
      case "nullValue":
        put(token.value);
        break;
      default:
        throw new Error(`Unexpected packed token: ${token.name}`);
    }
  }
  return result;
}

describe("raw history row scanner", () => {
  let directory: string;
  let filePath: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "history-row-scanner-"));
    filePath = path.join(directory, "chat.jsonl");
  });
  afterEach(async () => {
    mock.restore();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  async function collect(options?: Parameters<typeof scanHistoryRows>[2]) {
    const rows: Array<{ descriptor: HistoryRowDescriptor; tokens: HistoryRowToken[] }> = [];
    await scanHistoryRows(
      filePath,
      () => {
        const tokens: HistoryRowToken[] = [];
        return {
          token: (token) => {
            tokens.push(token);
          },
          finish: (descriptor) => {
            rows.push({ descriptor, tokens });
          },
        };
      },
      options
    );
    return rows;
  }
  function shortReads(limit: number) {
    const open = fs.open;
    spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      if (args[0] !== filePath) return handle;
      const read = handle.read.bind(handle);
      spyOn(handle, "read").mockImplementation(
        new Proxy(read, {
          apply(target, receiver, values: unknown[]) {
            if (typeof values[2] === "number") values[2] = Math.min(values[2], limit);
            return Reflect.apply(target, receiver, values) as ReturnType<typeof read>;
          },
        })
      );
      return handle;
    });
  }

  it.each([1, 2, 3, 7, 16, 64, SESSION_HISTORY_SCAN_CHUNK_BYTES])(
    "preserves nested values, escapes and UTF-8 with %d-byte reads",
    async (limit) => {
      shortReads(limit);
      const texts = [
        JSON.stringify({
          escapedkey: '€😀\ud800\n\\"',
          nested: [null, true, false, -12.5e2, { n: 0 }],
        })
          .replace("escapedkey", "escaped\\u006bey")
          .replace("😀", "😀\\ud83d\\ude00"),
        '"root string"',
        "true",
        "false",
        "null",
        "-0",
        "1.125e-15",
        "[]",
        "{}",
      ];
      await fs.writeFile(filePath, texts.join("\n"));
      const rows = await collect();
      expect(rows.map(({ tokens }) => assemble(tokens))).toEqual(
        texts.map((text) => JSON.parse(text) as unknown)
      );
      expect(
        rows.every(
          ({ descriptor }) =>
            descriptor.validJson && descriptor.validUtf8 && !descriptor.hasDuplicateKeys
        )
      ).toBe(true);
      let start = 0;
      rows.forEach(({ descriptor }, i) => {
        const byteLength = Buffer.byteLength(texts[i]);
        const terminatedByLf = i < texts.length - 1;
        expect(descriptor).toMatchObject({
          start,
          end: start + byteLength + Number(terminatedByLf),
          byteLength,
          sha256: digest(texts[i]),
          terminatedByLf,
        });
        start = descriptor.end;
      });
    }
  );

  it("uses the same content digest for LF and complete EOF rows without trimming whitespace", async () => {
    const text = ' {"a":1}\r';
    await fs.writeFile(filePath, text + "\n" + text);
    const rows = await collect();
    expect(rows.map(({ descriptor }) => descriptor.sha256)).toEqual([digest(text), digest(text)]);
    expect(rows.map(({ descriptor }) => descriptor.terminatedByLf)).toEqual([true, false]);
    expect(rows.every(({ descriptor }) => descriptor.validJson)).toBe(true);
    expect(rows[0].descriptor.sha256).not.toBe(digest(text.trim()));
  });

  it.each([
    '{"a":',
    "[1,]",
    '"unterminated',
    '"\\u12"',
    "01",
    "truex",
    "",
    " ",
    "\uFEFF{}",
    "[\u00a01]",
    "[\v1]",
  ])("reports malformed row %j and recovers at the next LF", async (text) => {
    shortReads(1);
    await fs.writeFile(filePath, text + '\n{"after":true}\n');
    const rows = await collect();
    expect(rows).toHaveLength(2);
    expect(rows[0].descriptor).toMatchObject({
      validJson: false,
      validUtf8: true,
      sha256: digest(text),
    });
    expect(rows[1].descriptor.validJson).toBe(true);
    expect(assemble(rows[1].tokens)).toEqual({ after: true });
  });

  it.each([[0xc3, 0x28], [0xed, 0xa0, 0x80], [0xf0, 0x9f], [0xff]].map((bytes) => ({ bytes })))(
    "rejects invalid UTF-8 bytes %j without hiding the next row",
    async ({ bytes }) => {
      shortReads(1);
      const invalid = Buffer.concat([Buffer.from('"'), Buffer.from(bytes), Buffer.from('"')]);
      await fs.writeFile(filePath, Buffer.concat([invalid, Buffer.from("\n{}")]));
      const rows = await collect();
      expect(rows[0].descriptor).toMatchObject({
        validUtf8: false,
        validJson: false,
        sha256: digest(invalid),
      });
      expect(rows[1].descriptor.validJson).toBe(true);
    }
  );

  it("rejects a partial UTF-8 code point at EOF", async () => {
    await fs.writeFile(filePath, Buffer.from([34, 0xf0, 0x9f]));
    const rows = await collect();
    expect(rows).toHaveLength(1);
    expect(rows[0].descriptor).toMatchObject({
      validUtf8: false,
      validJson: false,
      terminatedByLf: false,
    });
  });

  it("detects duplicate decoded keys per object across split surrogate chunks", async () => {
    shortReads(1);
    const texts = [
      '{"a":1,"\\u0061":2}',
      '{"😀":1,"\\ud83d\\ude00":2}',
      '{"\\ud800":1,"\\ud801":2}',
      '{"x":{"a":1},"y":{"a":2}}',
    ];
    await fs.writeFile(filePath, texts.join("\n"));
    const rows = await collect();
    expect(rows.map(({ descriptor }) => descriptor.hasDuplicateKeys)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(rows.every(({ descriptor }) => descriptor.validJson)).toBe(true);
  });

  it("streams oversized keys, tool-like strings and numbers without full-row allocation", async () => {
    const chunk = Buffer.alloc(SESSION_HISTORY_SCAN_CHUNK_BYTES, 120);
    const repeats = 64;
    const hash = createHash("sha256");
    await using writer = await fs.open(filePath, "w");
    const write = async (bytes: Buffer | string) => {
      hash.update(bytes);
      await writer.writeFile(bytes);
    };
    await write('{"');
    for (let i = 0; i < repeats; i++) await write(chunk);
    await write('":{"type":"dynamic-tool","output":"');
    for (let i = 0; i < repeats; i++) await write(chunk);
    await write('","number":');
    chunk.fill(49);
    for (let i = 0; i < repeats; i++) await write(chunk);
    await write("}}"); // A complete crash tail without LF is valid too.
    let maxAllocation = 0;
    let maxRawCopy = 0;
    let maxToken = 0;
    let scalarUnits = 0;
    let packedScalar = false;
    let descriptor: HistoryRowDescriptor | undefined;
    for (const allocator of ["alloc", "allocUnsafe", "allocUnsafeSlow"] as const) {
      const allocate = Buffer[allocator];
      spyOn(Buffer, allocator).mockImplementation(
        new Proxy(allocate, {
          apply(target, receiver, args: unknown[]) {
            const result = Reflect.apply(target, receiver, args) as Buffer;
            maxAllocation = Math.max(maxAllocation, result.length);
            return result;
          },
        })
      );
    }
    const from = Buffer.from.bind(Buffer);
    spyOn(Buffer, "from").mockImplementation(
      new Proxy(from, {
        apply(target, receiver, args: unknown[]) {
          const result = Reflect.apply(target, receiver, args) as Buffer;
          maxAllocation = Math.max(maxAllocation, result.length);
          return result;
        },
      })
    );
    const concat = Buffer.concat.bind(Buffer);
    spyOn(Buffer, "concat").mockImplementation((...args: Parameters<typeof concat>) => {
      const result = concat(...args);
      maxAllocation = Math.max(maxAllocation, result.length);
      return result;
    });
    expect(
      await scanHistoryRows(filePath, () => ({
        raw(bytes) {
          maxRawCopy = Math.max(maxRawCopy, bytes.buffer.byteLength);
          new Uint8Array(bytes.buffer).fill(255);
        },
        token(token) {
          if (["stringValue", "keyValue", "numberValue"].includes(token.name)) packedScalar = true;
          if (token.name === "stringChunk" || token.name === "numberChunk") {
            maxToken = Math.max(maxToken, token.value.length);
            scalarUnits += token.value.length;
          }
        },
        finish(row) {
          descriptor = row;
        },
      }))
    ).toBe(true);
    expect(descriptor).toMatchObject({
      validJson: true,
      validUtf8: true,
      terminatedByLf: false,
      sha256: hash.digest("hex"),
    });
    expect(scalarUnits).toBeGreaterThanOrEqual(3 * repeats * chunk.length);
    expect(packedScalar).toBe(false);
    expect(maxToken).toBeLessThanOrEqual(SESSION_HISTORY_SCAN_CHUNK_BYTES);
    expect(maxAllocation).toBeLessThanOrEqual(2 * SESSION_HISTORY_SCAN_CHUNK_BYTES);
    expect(maxRawCopy).toBeGreaterThan(0);
    expect(maxRawCopy).toBeLessThanOrEqual(SESSION_HISTORY_SCAN_CHUNK_BYTES);
  });

  it.each(["token", "finish", "abort", "throw", "raw-stop", "raw-throw"] as const)(
    "closes its file on %s early termination",
    async (how) => {
      await fs.writeFile(filePath, '{"text":"value"}\n{}');
      const controller = new AbortController();
      const open = fs.open;
      let opened: fs.FileHandle | undefined;
      spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (args[0] === filePath) opened = handle;
        return handle;
      });
      const scanning = scanHistoryRows(
        filePath,
        () => ({
          raw() {
            if (how === "raw-stop") return false;
            if (how === "raw-throw") throw new Error("visitor failed");
          },
          token() {
            if (how === "token") return false;
            if (how === "abort") controller.abort(new Error("stop scan"));
            if (how === "throw") throw new Error("visitor failed");
          },
          finish() {
            return false;
          },
        }),
        { signal: controller.signal }
      );
      if (how === "abort" || how === "throw" || how === "raw-throw") {
        const failure: unknown = await scanning.catch((error: unknown) => error);
        expect(failure).toMatchObject({
          message: how === "abort" ? "stop scan" : "visitor failed",
        });
      } else expect(await scanning).toBe(false);
      const scannerHandle = opened;
      expect(scannerHandle?.fd).toBe(-1);
      // Other services can open files before this assertion; they do not own the scanner handle.
      await using unrelated = await fs.open(`${filePath}.unrelated`, "w+");
      expect(unrelated.fd).toBeGreaterThanOrEqual(0);
      expect(opened?.fd).toBe(-1);
    }
  );

  it.each(["strict", "replacement"] as const)(
    "%s raw taps preserve every content byte and offset after parse/decode errors",
    async (decoding) => {
      shortReads(3);
      const contents = [
        Buffer.from('{"broken": bad, "later":true}'),
        Buffer.concat([
          Buffer.from('{"text":"'),
          Buffer.from([255]),
          Buffer.from('","id":"after"}'),
        ]),
        Buffer.from("{}"),
      ];
      await fs.writeFile(
        filePath,
        Buffer.concat(
          contents.flatMap((row, i) => (i < contents.length - 1 ? [row, Buffer.from("\n")] : [row]))
        )
      );
      const observed: Buffer[] = [];
      const descriptors: HistoryRowDescriptor[] = [];
      await scanHistoryRows(
        filePath,
        (start) => {
          const chunks: Buffer[] = [];
          let next = start;
          return {
            raw(bytes, offset) {
              expect(offset).toBe(next);
              next += bytes.length;
              chunks.push(Buffer.from(bytes)); // This small fixture deliberately collects bounded raw copies.
            },
            token() {
              // This test inspects framing and completion rather than tokens.
            },
            finish(row) {
              observed.push(Buffer.concat(chunks));
              descriptors.push(row);
            },
          };
        },
        { decoding }
      );
      expect(observed).toEqual(contents);
      expect(descriptors.map((row) => row.sha256)).toEqual(contents.map(digest));
      expect(descriptors.map((row) => row.validJson)).toEqual([false, false, true]);
    }
  );

  it.each([
    { name: "before identity", prefix: '{"text":"', suffix: '","id":"after"}' },
    { name: "inside identity", prefix: '{"id":"a', suffix: 'b"}' },
    { name: "after identity", prefix: '{"id":"before","text":"', suffix: '"}' },
  ])(
    "replacement decoding retains values with invalid bytes $name without declaring valid JSON",
    async ({ prefix, suffix }) => {
      shortReads(1);
      const raw = Buffer.concat([
        Buffer.from(prefix),
        Buffer.from([237, 160, 128]),
        Buffer.from(suffix),
      ]);
      await fs.writeFile(filePath, raw);
      const [strict] = await collect();
      expect(strict.descriptor).toMatchObject({
        validUtf8: false,
        validJson: false,
        decodedJsonComplete: false,
      });
      const [replacement] = await collect({ decoding: "replacement" });
      expect(replacement.descriptor).toMatchObject({
        validUtf8: false,
        validJson: false,
        decodedJsonComplete: true,
      });
      expect(assemble(replacement.tokens)).toEqual(JSON.parse(raw.toString("utf8")) as unknown);
    }
  );

  it("replacement decoding still rejects malformed JSON and detects replacement-equivalent keys", async () => {
    const duplicate = Buffer.concat([
      Buffer.from('{"'),
      Buffer.from([255]),
      Buffer.from('":1,"'),
      Buffer.from([254]),
      Buffer.from('":2}'),
    ]);
    await fs.writeFile(
      filePath,
      Buffer.concat([duplicate, Buffer.from('\n{"id":"provisional",oops}')])
    );
    const rows = await collect({ decoding: "replacement" });
    expect(rows[0].descriptor).toMatchObject({
      validUtf8: false,
      validJson: false,
      decodedJsonComplete: true,
      hasDuplicateKeys: true,
    });
    expect(assemble(rows[0].tokens)).toEqual(JSON.parse(duplicate.toString("utf8")) as unknown);
    expect(rows[1].descriptor).toMatchObject({
      validUtf8: true,
      validJson: false,
      decodedJsonComplete: false,
    });
  });

  it.each(["strict", "replacement"] as const)(
    "snapshots %s decoding before opening the file",
    async (decoding) => {
      const raw = Buffer.from([34, 255, 34]);
      await fs.writeFile(filePath, Buffer.concat([raw, Buffer.from("\n"), raw]));
      const options: { decoding: "strict" | "replacement" } = { decoding };
      const rows: HistoryRowDescriptor[] = [];
      await scanHistoryRows(
        filePath,
        () => {
          options.decoding = decoding === "strict" ? "replacement" : "strict";
          return {
            token() {
              // This test inspects framing and completion rather than tokens.
            },
            finish(row) {
              rows.push(row);
            },
          };
        },
        options
      );
      expect(rows.map((row) => row.decodedJsonComplete)).toEqual([
        decoding === "replacement",
        decoding === "replacement",
      ]);
      expect(rows.every((row) => !row.validUtf8 && !row.validJson)).toBe(true);
    }
  );

  it("isolates raw visitor mutations from tokens, hashes, and buffered later rows", async () => {
    const contents = ['{"id":"original"}', '{"id":"next"}'];
    await fs.writeFile(filePath, contents.join("\n"));
    const values: unknown[] = [];
    const descriptors: HistoryRowDescriptor[] = [];
    await scanHistoryRows(filePath, () => {
      const tokens: HistoryRowToken[] = [];
      return {
        raw(bytes) {
          expect(bytes.byteLength).toBeLessThanOrEqual(SESSION_HISTORY_SCAN_CHUNK_BYTES);
          // Even access to the backing buffer must not expose the scanner's unread bytes.
          new Uint8Array(bytes.buffer).fill(255);
        },
        token(token) {
          tokens.push(token);
        },
        finish(row) {
          values.push(assemble(tokens));
          descriptors.push(row);
        },
      };
    });
    expect(values).toEqual(contents.map((row) => JSON.parse(row) as unknown));
    expect(descriptors.map((row) => row.sha256)).toEqual(contents.map(digest));
    expect(descriptors.every((row) => row.validJson && row.validUtf8)).toBe(true);
  });

  it.each([
    { content: "true\nfalse", keepGoing: true },
    { content: "true\n", keepGoing: true },
    { content: "true", keepGoing: true },
    { content: "true\nfalse", keepGoing: false },
    { content: "true\n", keepGoing: false },
    { content: "true", keepGoing: false },
  ])(
    "rejects late completion cancellation ($content, continue=$keepGoing)",
    async ({ content, keepGoing }) => {
      await fs.writeFile(filePath, content);
      const controller = new AbortController();
      const reason = { canceled: "after inner completion check" };
      const starts: number[] = [];
      const result = await scanHistoryRows(
        filePath,
        (start) => {
          starts.push(start);
          return {
            token() {
              /* Completion ordering is under test. */
            },
            finish() {
              const completion = Promise.resolve(keepGoing);
              // Attach after the scanner's await reaction: its inner check already ran when abort fires.
              queueMicrotask(() => {
                completion.then(
                  () => controller.abort(reason),
                  (error: unknown) => controller.abort(error)
                );
              });
              return completion;
            },
          };
        },
        { signal: controller.signal }
      ).catch((error: unknown) => error);
      expect(result).toBe(reason);
      expect(starts).toEqual([0]);
    }
  );

  it.each([true, false])(
    "observes cancellation during file disposal (continue=%s)",
    async (keepGoing) => {
      await fs.writeFile(filePath, "true\n");
      const controller = new AbortController();
      const reason = { canceled: "while disposing file" };
      const open = fs.open;
      let opened: fs.FileHandle | undefined;
      spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (args[0] !== filePath) return handle;
        opened = handle;
        const dispose = handle[Symbol.asyncDispose].bind(handle);
        spyOn(handle, Symbol.asyncDispose).mockImplementation(async () => {
          await dispose();
          controller.abort(reason);
        });
        return handle;
      });
      const result = await scanHistoryRows(
        filePath,
        () => ({
          token() {
            /* Resource cleanup is under test. */
          },
          finish: () => keepGoing,
        }),
        { signal: controller.signal }
      ).catch((error: unknown) => error);
      expect(result).toBe(reason);
      expect(opened?.fd).toBe(-1);
    }
  );

  it.each(["continue", "stop", "abort", "reject"] as const)(
    "awaits row completion before proceeding (%s)",
    async (outcome) => {
      await fs.writeFile(filePath, "true\nfalse");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<boolean>();
      const controller = new AbortController();
      const starts: number[] = [];
      const scanning = scanHistoryRows(
        filePath,
        (start) => {
          starts.push(start);
          return {
            token() {
              // This test inspects framing and completion rather than tokens.
            },
            async finish() {
              if (start !== 0) return true;
              entered.resolve();
              return await release.promise;
            },
          };
        },
        { signal: controller.signal }
      ).catch((error: unknown) => error);
      await entered.promise;
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(starts).toEqual([0]);
      } finally {
        if (outcome === "abort") controller.abort(new Error("abort during completion"));
        if (outcome === "reject") release.reject(new Error("completion failed"));
        else release.resolve(outcome !== "stop");
      }
      const result = await scanning;
      if (outcome === "abort" || outcome === "reject")
        expect(result).toMatchObject({
          message: outcome === "abort" ? "abort during completion" : "completion failed",
        });
      else expect(result).toBe(outcome === "continue");
      expect(starts).toEqual(outcome === "continue" ? [0, 5] : [0]);
    }
  );

  it.each([false, undefined])(
    "rejects beginRow cancellation before callbacks returning %s",
    async (rawResult) => {
      await fs.writeFile(filePath, "true");
      const controller = new AbortController();
      const reason = new Error("canceled while opening row");
      const callbacks: string[] = [];
      const result = await scanHistoryRows(
        filePath,
        () => {
          controller.abort(reason);
          return {
            raw() {
              callbacks.push("raw");
              return rawResult;
            },
            token() {
              callbacks.push("token");
            },
            finish() {
              callbacks.push("finish");
            },
          };
        },
        { signal: controller.signal }
      ).catch((error: unknown) => error);
      expect(result).toBe(reason);
      expect(callbacks).toEqual([]);
    }
  );

  it.each(["open", "stat"] as const)(
    "rejects cancellation during empty-file %s and closes the handle",
    async (stage) => {
      await fs.writeFile(filePath, "");
      const controller = new AbortController();
      const reason = { canceledDuring: stage };
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const open = fs.open;
      let opened: fs.FileHandle | undefined;
      spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (args[0] !== filePath) return handle;
        opened = handle;
        if (stage === "open") {
          entered.resolve();
          await release.promise;
        } else {
          const stat = handle.stat.bind(handle);
          spyOn(handle, "stat").mockImplementation(
            new Proxy(stat, {
              async apply(target, _receiver, args: Parameters<typeof stat>) {
                entered.resolve();
                await release.promise;
                return target(...args);
              },
            })
          );
        }
        return handle;
      });
      const begin = mock(() => {
        throw new Error("empty file must not begin a row");
      });
      const scanning = scanHistoryRows(filePath, begin, { signal: controller.signal }).catch(
        (error: unknown) => error
      );
      await entered.promise;
      controller.abort(reason);
      release.resolve();
      expect(await scanning).toBe(reason);
      expect(begin).not.toHaveBeenCalled();
      expect(opened?.fd).toBe(-1);
    }
  );

  it("emits no phantom row for an empty file or a trailing LF", async () => {
    await fs.writeFile(filePath, "");
    expect(await collect()).toEqual([]);
    await fs.writeFile(filePath, "{}\n");
    expect(await collect()).toHaveLength(1);
  });
});
