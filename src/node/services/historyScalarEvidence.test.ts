import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { scanHistoryRows } from "./historyRowScanner";
import {
  createHistoryCanonicalEvidence,
  createHistoryNumberEvidence,
  createHistoryStringEvidence,
} from "./historyScalarEvidence";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function numberEvidence(raw: string, chunkSize: number) {
  const evidence = createHistoryNumberEvidence(raw.length);
  for (let i = 0; i < raw.length; i += chunkSize) evidence.push(raw.slice(i, i + chunkSize));
  return evidence.finish();
}

async function canonicalRows(raw: string | Buffer, normalizationChanged = false) {
  const directory = await mkdtemp(join(tmpdir(), "history-scalar-test-"));
  directories.push(directory);
  const file = join(directory, "rows.jsonl");
  await writeFile(file, raw);
  const result: boolean[] = [];
  await scanHistoryRows(file, () => {
    const evidence = createHistoryCanonicalEvidence(Buffer.byteLength(raw));
    return {
      token: evidence.token.bind(evidence),
      finish: (row) => {
        result.push(evidence.finish(row, normalizationChanged));
      },
    };
  });
  return result;
}

function decimalDyadic(numerator: bigint, denominatorPower: number) {
  const digits = (numerator * 5n ** BigInt(denominatorPower))
    .toString()
    .padStart(denominatorPower + 1, "0");
  return `${digits.slice(0, -denominatorPower)}.${digits.slice(-denominatorPower)}`;
}

function changeLastDecimalDigit(value: string, delta: bigint) {
  const [whole, fraction] = value.split(".");
  const digits = (BigInt(whole + fraction) + delta)
    .toString()
    .padStart(whole.length + fraction.length, "0");
  return `${digits.slice(0, -fraction.length)}.${digits.slice(-fraction.length)}`;
}

describe("bounded history scalar evidence", () => {
  test.each([1, 2, 7, 63, 4096])(
    "native number conversion and canonicality agree across %s-character chunks",
    (chunkSize) => {
      const values = [
        "0",
        "-0",
        "0.0",
        "-0e99999",
        "1",
        "-1",
        "1e0",
        "1E+0",
        "1e309",
        "-1e309",
        "1e-99999",
        "-1e-99999",
        "1.7976931348623157e308",
        "5e-324",
        "2.2250738585072014e-308",
        "9007199254740993",
        "9007199254740995",
        "1.00000000000000011102230246251565404236316680908203125",
        "0." + "0".repeat(5000) + "12345e5004",
        "12345" + "0".repeat(5000) + "e-5004",
        "1e+" + "0".repeat(5000) + "308",
        "1e-" + "9".repeat(5000),
        "1e" + "9".repeat(5000),
        "1." + "0".repeat(7000) + "1",
      ];
      for (const raw of values) {
        const actual = numberEvidence(raw, chunkSize);
        const expected: unknown = JSON.parse(raw);
        expect(Object.is(actual.value, expected)).toBe(true);
        expect(actual.canonical).toBe(JSON.stringify(expected) === raw);
        expect(actual.retainedSignificantDigits).toBeLessThanOrEqual(2048);
      }
    }
  );

  test("native rounding preserves midpoint ties and sticky tails beyond retained digits", () => {
    const midpoints = [
      decimalDyadic((1n << 53n) + 1n, 53),
      decimalDyadic((1n << 53n) + 3n, 53),
      decimalDyadic(1n, 1075),
      decimalDyadic(3n, 1075),
      decimalDyadic((1n << 53n) - 1n, 1075),
    ];
    for (const midpoint of midpoints) {
      const tie = midpoint + "0".repeat(3000);
      for (const raw of [tie, changeLastDecimalDigit(tie, -1n), changeLastDecimalDigit(tie, 1n)]) {
        for (const sign of ["", "-"]) {
          const literal = sign + raw;
          expect(Object.is(numberEvidence(literal, 13).value, JSON.parse(literal))).toBe(true);
        }
      }
    }
    const overflow = ((1n << 1024n) - (1n << 970n)).toString() + "." + "0".repeat(3000);
    for (const raw of [
      overflow,
      changeLastDecimalDigit(overflow, -1n),
      changeLastDecimalDigit(overflow, 1n),
    ])
      expect(Object.is(numberEvidence(raw, 19).value, JSON.parse(raw))).toBe(true);
  });

  test("many generated finite numbers and noncanonical spellings use native conversion", () => {
    let seed = 123456789;
    for (let i = 0; i < 2000; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const value = (seed - 0x80000000) * 10 ** ((i % 600) - 300);
      const raw = JSON.stringify(value);
      const expected: unknown = JSON.parse(raw);
      expect(Object.is(numberEvidence(raw, 3).value, expected)).toBe(true);
      expect(numberEvidence(raw, 3).canonical).toBe(true);
    }
  });

  test("giant numeric and string inputs retain only bounded prefixes", () => {
    const number = createHistoryNumberEvidence(16 * 1024 * 1024);
    number.push("1.");
    const zeros = "0".repeat(8192);
    for (let i = 0; i < 1024; i++) number.push(zeros);
    number.push("1");
    expect(number.finish()).toMatchObject({
      value: 1,
      canonical: false,
      retainedSignificantDigits: 2048,
    });
    const string = createHistoryStringEvidence(128, "different");
    for (let i = 0; i < 1024; i++) string.push(zeros);
    const result = string.finish();
    expect(result.prefix).toHaveLength(128);
    expect(result.length).toBe(8 * 1024 * 1024);
    expect(result.matchesExpected).toBe(false);
  });

  test("decoded string equality and hashing preserve split surrogate pairs and lone surrogates", () => {
    const value = "a😀\ud800b\udfff";
    const probe = createHistoryStringEvidence(2, value);
    for (const unit of value.split("")) probe.push(unit);
    const actual = probe.finish();
    expect(actual.matchesExpected).toBe(true);
    expect(actual.prefix).toBe(value.slice(0, 2));
    expect(actual.sha256).toBe(
      createHash("sha256").update(Buffer.from(value, "utf16le")).digest("hex")
    );
    const other = createHistoryStringEvidence(0, value);
    other.push(value.replace("\ud800", "\ud801"));
    expect(other.finish().matchesExpected).toBe(false);
  });

  test("source limits are enforced rather than silently saturating an undersized promise", () => {
    expect(() => createHistoryNumberEvidence(-1)).toThrow();
    expect(() => createHistoryNumberEvidence(1).push("10")).toThrow();
    expect(() => createHistoryStringEvidence(-1)).toThrow();
  });
});

describe("streamed canonical JSON evidence", () => {
  test.each([
    "null",
    "true",
    "false",
    "0",
    "-0",
    "1e0",
    "1e400",
    '""',
    '"hello"',
    "[]",
    "{}",
    '[1,{"text":"hello"},null]',
    '{"2":0,"10":0,"name":0}',
    '{"10":0,"2":0}',
    '{"name":0,"2":0}',
    '{"01":0,"1":0}',
    '{"1":0,"01":0}',
    '{"4294967294":0,"4294967295":0}',
    '{"4294967295":0,"4294967294":0}',
    '{"a":0,"a":1}',
    '{"a":0,"\\u0061":1}',
    '{"nested":{"b":1,"b":2}}',
    '{ "a": 1 }',
    '"\\u0061"',
    '"a/b"',
    '"a\\/b"',
    '"\\ud800"',
    '"\\ud800\\udc00"',
    JSON.stringify("😀\ud800\n\t\u2028\u2029"),
    '{"__proto__":{"a":1},"constructor":null}',
  ])("matches native JSON.stringify round trip for %s", async (raw) => {
    const expected = JSON.stringify(JSON.parse(raw)) === raw;
    expect(await canonicalRows(raw)).toEqual([expected]);
    expect(await canonicalRows(raw + "\n")).toEqual([expected]);
  });

  test("invalid UTF-8, malformed JSON and a declared legacy normalization never prove canonical bytes", async () => {
    expect(await canonicalRows(Buffer.from([0x22, 0xff, 0x22]))).toEqual([false]);
    expect(await canonicalRows('{"unfinished":\n{"valid":true}\n')).toEqual([false, true]);
    expect(await canonicalRows('{"metadata":{"cmuxMetadata":{}}}', true)).toEqual([false]);
  });

  test("giant canonical scalars cross raw read and Unicode boundaries without row assembly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "history-canonical-giant-"));
    directories.push(directory);
    const file = join(directory, "row.jsonl");
    const chunk = "x".repeat(65529) + "😀\n";
    await using handle = await open(file, "w");
    await handle.write('{"text":"');
    for (let i = 0; i < 129; i++) await handle.write(JSON.stringify(chunk).slice(1, -1));
    await handle.write('","tail":"\\ud800"}\n');
    const size = (await handle.stat()).size;
    const results: boolean[] = [];
    await scanHistoryRows(file, () => {
      const evidence = createHistoryCanonicalEvidence(size);
      return {
        token: evidence.token.bind(evidence),
        finish: (row) => {
          results.push(evidence.finish(row));
        },
      };
    });
    expect(size).toBeGreaterThan(8 * 1024 * 1024);
    expect(results).toEqual([true]);
  });
});
