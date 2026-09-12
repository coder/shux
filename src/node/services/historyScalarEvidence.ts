import { createHash } from "node:crypto";
import type { HistoryRowDescriptor, HistoryRowToken } from "./historyRowScanner";

const SIGNIFICANT_DIGITS = 2048;
const CANONICAL_NUMBER_CHARS = 32;

/** Bounded decoded-string facts; the prefix is never a substitute for validating the full value. */
export function createHistoryStringEvidence(prefixChars: number, expected?: string) {
  if (!Number.isSafeInteger(prefixChars) || prefixChars < 0)
    throw new Error("Invalid prefix bound");
  const hash = createHash("sha256");
  let prefix = "";
  let length = 0;
  let matches = expected !== undefined;
  return {
    push(chunk: string) {
      prefix += chunk.slice(0, Math.max(0, prefixChars - prefix.length));
      matches &&= expected!.startsWith(chunk, length);
      length += chunk.length;
      // Preserve JS string equality, including distinct lone surrogates and chunk splits.
      hash.update(Buffer.from(chunk, "utf16le"));
    },
    finish() {
      return {
        prefix,
        length,
        sha256: hash.digest("hex"),
        matchesExpected: matches && length === expected!.length,
      };
    },
  };
}

/**
 * Consume one parser-validated JSON number. sourceByteLimit bounds the complete source row/file.
 * Keep a prefix and sticky discarded tail, then let native Number perform all binary rounding.
 * Every binary64 rounding boundary is dyadic: at most 309 integer and 1075 fractional decimal
 * positions suffice (including zero/subnormal and finite/Infinity boundaries). The
 * SIGNIFICANT_DIGITS retention bound exceeds every boundary's finite decimal expansion.
 * Replacing a discarded nonzero tail with any positive tail preserves the side of a boundary;
 * a zero tail preserves exact ties. No binary rounding is implemented here.
 */
export function createHistoryNumberEvidence(sourceByteLimit: number) {
  if (!Number.isSafeInteger(sourceByteLimit) || sourceByteLimit < 1)
    throw new Error("Invalid numeric source bound");
  const exponentLimit = BigInt(sourceByteLimit) + 4096n;
  let exponent = 0n;
  let exponentNegative = false;
  let inExponent = false;
  let negative = false;
  let fraction = false;
  let fractionDigits = 0;
  let significantDigits = 0;
  let digits = "";
  let discardedNonzero = false;
  let raw = "";
  let length = 0;
  return {
    push(chunk: string) {
      length += chunk.length;
      if (length > sourceByteLimit) throw new Error("Number exceeds its captured source bound");
      if (raw.length <= CANONICAL_NUMBER_CHARS)
        raw = (raw + chunk).slice(0, CANONICAL_NUMBER_CHARS + 1);
      for (const character of chunk) {
        if (character === "e" || character === "E") inExponent = true;
        else if (character === "-") {
          if (inExponent) exponentNegative = true;
          else negative = true;
        } else if (character === ".") fraction = true;
        else if (character !== "+") {
          const digit = character.charCodeAt(0) - 48;
          if (inExponent) {
            // An exponent beyond source length + 4096 cannot be canceled by its mantissa.
            exponent = exponent * 10n + BigInt(digit);
            if (exponent > exponentLimit) exponent = exponentLimit;
          } else {
            if (fraction) fractionDigits++;
            if (digit !== 0 || significantDigits > 0) {
              significantDigits++;
              if (digits.length < SIGNIFICANT_DIGITS) digits += character;
              else discardedNonzero ||= digit !== 0;
            }
          }
        }
      }
    },
    finish() {
      const scale =
        (exponentNegative ? -exponent : exponent) -
        BigInt(fractionDigits) +
        BigInt(significantDigits - digits.length - (discardedNonzero ? 1 : 0));
      const value = Number(
        `${negative ? "-" : ""}${digits || "0"}${discardedNonzero ? "1" : ""}e${scale}`
      );
      return {
        value,
        canonical: length <= CANONICAL_NUMBER_CHARS && JSON.stringify(value) === raw,
        retainedSignificantDigits: digits.length,
      };
    },
  };
}

interface Frame {
  array: boolean;
  count: number;
  lastIndex: number;
  sawStringKey: boolean;
}

/**
 * Prove raw JSON.stringify equivalence without materializing a row or scalar. This proves bytes,
 * not message readability or authority. The history caller must report normalizationChanged
 * when its legacy normalizer changes a row; this module deliberately knows no message fields.
 */
export function createHistoryCanonicalEvidence(sourceByteLimit: number) {
  const hash = createHash("sha256");
  const frames: Frame[] = [];
  let byteLength = 0;
  let canonical = true;
  let rootValues = 0;
  let surrogate = "";
  let key: ReturnType<typeof createHistoryStringEvidence> | undefined;
  let number: ReturnType<typeof createHistoryNumberEvidence> | undefined;
  const write = (text: string) => {
    const bytes = Buffer.from(text);
    hash.update(bytes);
    byteLength += bytes.length;
  };
  const beforeValue = () => {
    const frame = frames.at(-1);
    if (!frame) rootValues++;
    else if (frame.array && frame.count++ > 0) write(",");
  };
  const stringChunk = (chunk: string) => {
    let text = surrogate + chunk;
    const last = text.charCodeAt(text.length - 1);
    surrogate = last >= 0xd800 && last <= 0xdbff ? text.slice(-1) : "";
    if (surrogate) text = text.slice(0, -1);
    write(JSON.stringify(text).slice(1, -1));
  };
  const endString = () => {
    write(JSON.stringify(surrogate).slice(1, -1));
    surrogate = "";
    write('"');
  };
  return {
    token(token: HistoryRowToken) {
      switch (token.name) {
        case "startObject":
        case "startArray":
          beforeValue();
          write(token.name === "startArray" ? "[" : "{");
          frames.push({
            array: token.name === "startArray",
            count: 0,
            lastIndex: -1,
            sawStringKey: false,
          });
          break;
        case "endObject":
        case "endArray":
          write(token.name === "endArray" ? "]" : "}");
          frames.pop();
          break;
        case "startKey":
          if (frames.at(-1)!.count++ > 0) write(",");
          key = createHistoryStringEvidence(10);
          write('"');
          break;
        case "endKey": {
          const value = key!.finish();
          const index = Number(value.prefix);
          const isIndex =
            value.length <= 10 &&
            Number.isInteger(index) &&
            index >= 0 &&
            index < 0xffffffff &&
            String(index) === value.prefix;
          const frame = frames.at(-1)!;
          if (isIndex) {
            canonical &&= !frame.sawStringKey && index > frame.lastIndex;
            frame.lastIndex = index;
          } else frame.sawStringKey = true;
          key = undefined;
          endString();
          write(":");
          break;
        }
        case "startString":
          beforeValue();
          write('"');
          break;
        case "stringChunk":
          key?.push(token.value);
          stringChunk(token.value);
          break;
        case "endString":
          endString();
          break;
        case "startNumber":
          beforeValue();
          number = createHistoryNumberEvidence(sourceByteLimit);
          break;
        case "numberChunk":
          number!.push(token.value);
          break;
        case "endNumber": {
          const value = number!.finish();
          canonical &&= value.canonical;
          write(JSON.stringify(value.value));
          number = undefined;
          break;
        }
        case "trueValue":
        case "falseValue":
        case "nullValue":
          beforeValue();
          write(JSON.stringify(token.value));
          break;
        case "whitespace":
          break;
        default:
          throw new Error("Canonical evidence requires unpacked parser tokens");
      }
    },
    finish(row: HistoryRowDescriptor, normalizationChanged = false) {
      const sha256 = hash.digest("hex");
      return (
        canonical &&
        !normalizationChanged &&
        rootValues === 1 &&
        frames.length === 0 &&
        row.validJson &&
        row.validUtf8 &&
        !row.hasDuplicateKeys &&
        row.byteLength <= sourceByteLimit &&
        row.byteLength === byteLength &&
        row.sha256 === sha256
      );
    },
  };
}
