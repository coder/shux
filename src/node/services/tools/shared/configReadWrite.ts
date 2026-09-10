import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as jsonc from "jsonc-parser";
import type { z } from "zod";
import writeFileAtomic from "write-file-atomic";

import {
  CONFIG_FILE_REGISTRY,
  type ConfigDocumentFor,
  type ConfigFileKey,
} from "@/common/config/schemaRegistry";

// Tools operate on raw on-disk documents (no Config class normalization), so reads/writes
// intentionally parse and serialize the exact file formats used on disk.
const PROVIDERS_JSONC_COMMENT_HEADER = `// Providers configuration for mux
// Configure your AI providers here
// Example:
// {
//   "anthropic": {
//     "apiKey": "sk-ant-..."
//   },
//   "openai": {
//     "apiKey": "sk-..."
//   },
//   "xai": {
//     "apiKey": "sk-xai-..."
//   },
//   "ollama": {
//     "baseUrl": "http://localhost:11434/api"  // Optional - only needed for remote/custom URL
//   }
// }
`;

interface JsonParseErrorLike {
  message?: unknown;
}

function getConfigDocumentPath(xumHomeDir: string, fileKey: ConfigFileKey): string {
  const entry = CONFIG_FILE_REGISTRY[fileKey];
  return path.join(xumHomeDir, entry.fileName);
}

// Shared parse-only logic: reads file from disk, returns raw parsed object (no schema validation).
async function readParsedConfigDocument(
  xumHomeDir: string,
  fileKey: ConfigFileKey
): Promise<unknown> {
  const entry = CONFIG_FILE_REGISTRY[fileKey];
  const filePath = getConfigDocumentPath(xumHomeDir, fileKey);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }

    throw error;
  }

  return entry.fileKind === "jsonc"
    ? parseJsoncDocument(raw, filePath)
    : parseJsonDocument(raw, filePath);
}

// Parse-only read for mutation workflows: schema validation is deferred
// until after mutations are applied, allowing writes to repair invalid configs.
export async function readConfigDocumentUnvalidated(
  xumHomeDir: string,
  fileKey: ConfigFileKey
): Promise<unknown> {
  return readParsedConfigDocument(xumHomeDir, fileKey);
}

// Prevent writes from escaping the mux config boundary via symlinked targets.
async function assertWritableConfigTarget(filePath: string, fileKey: ConfigFileKey): Promise<void> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to write symlinked mux config target for "${fileKey}"`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return; // file doesn't exist yet — creation is fine
    }

    throw error;
  }
}

export async function writeConfigDocument<TKey extends ConfigFileKey>(
  xumHomeDir: string,
  fileKey: TKey,
  document: unknown
): Promise<ConfigDocumentFor<TKey>> {
  const entry = CONFIG_FILE_REGISTRY[fileKey];
  const filePath = getConfigDocumentPath(xumHomeDir, fileKey);
  // config.json carries a per-save write stamp (see Config.configFileWriteGeneration). A raw
  // rewrite refreshes it like a Config save does — the document read from disk carries the
  // previous one — or a reader comparing generations around this write would not see it.
  const stamped =
    fileKey === "config" &&
    typeof document === "object" &&
    document !== null &&
    !Array.isArray(document)
      ? { ...document, writeId: randomUUID() }
      : document;
  const validatedDocument = parseAndValidateDocument(fileKey, entry.schema, stamped, filePath);
  const serialized = JSON.stringify(validatedDocument, null, 2);

  await fs.mkdir(xumHomeDir, { recursive: true });
  await assertWritableConfigTarget(filePath, fileKey);

  if (entry.fileKind === "jsonc") {
    writeFileAtomic.sync(filePath, `${PROVIDERS_JSONC_COMMENT_HEADER}${serialized}`, {
      encoding: "utf-8",
      mode: 0o600,
    });

    return validatedDocument;
  }

  await writeFileAtomic(filePath, serialized, "utf-8");
  return validatedDocument;
}

function parseAndValidateDocument<TKey extends ConfigFileKey>(
  fileKey: TKey,
  schema: z.ZodTypeAny,
  document: unknown,
  sourceLabel: string
): ConfigDocumentFor<TKey> {
  const parseResult = schema.safeParse(document);
  if (parseResult.success) {
    return document as ConfigDocumentFor<TKey>;
  }

  throw new Error(
    `Config schema validation failed for "${fileKey}" (${sourceLabel}): ${parseResult.error.message}`
  );
}

function parseJsonDocument(raw: string, filePath: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Unable to parse JSON config at ${filePath}: ${formatParseErrorMessage(error)}`
    );
  }
}

function parseJsoncDocument(raw: string, filePath: string): unknown {
  const parseErrors: jsonc.ParseError[] = [];
  const parsed: unknown = jsonc.parse(raw, parseErrors);

  if (parseErrors.length === 0) {
    return parsed;
  }

  const firstError = parseErrors[0];
  const errorCode = jsonc.printParseErrorCode(firstError.error);
  throw new Error(
    `Unable to parse JSONC config at ${filePath}: ${errorCode} (offset ${firstError.offset}, length ${firstError.length})`
  );
}

function formatParseErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const maybeMessage = (error as JsonParseErrorLike).message;
    if (typeof maybeMessage === "string") {
      return maybeMessage;
    }
  }

  return "Unknown parsing error";
}
