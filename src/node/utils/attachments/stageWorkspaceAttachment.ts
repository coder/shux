import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  MAX_STAGED_ATTACHMENT_SIZE_BYTES,
  STAGED_ATTACHMENT_DIR,
  STAGED_ATTACHMENT_DIRS,
} from "@/common/constants/stagedAttachments";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import { getSupportedStagedAttachmentMediaType } from "@/common/utils/attachments/supportedAttachmentMediaTypes";
import { getErrorMessage } from "@/common/utils/errors";
import { shellQuote } from "@/common/utils/shell";
import type { Runtime } from "@/node/runtime/Runtime";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { ensureGitInfoExclude } from "@/node/utils/git/ensureGitInfoExclude";

export interface StagedWorkspaceAttachment {
  filename: string;
  mediaType: string;
  sizeBytes: number;
  stagedPath: string;
}

export interface DownloadedStagedWorkspaceAttachment {
  filename: string;
  mediaType: string;
  sizeBytes: number;
  dataBase64: string;
}

export async function stageWorkspaceAttachment(input: {
  runtime: Runtime;
  workspacePath: string;
  filename: string;
  mediaType?: string | null;
  sizeBytes: number;
  dataBase64: string;
}): Promise<Result<StagedWorkspaceAttachment, string>> {
  try {
    assert(input.workspacePath.trim().length > 0, "workspacePath is required");
    const mediaType = getSupportedStagedAttachmentMediaType({
      mediaType: input.mediaType,
      filename: input.filename,
    });
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 0) {
      return Err("Attachment size is invalid.");
    }
    if (input.sizeBytes > MAX_STAGED_ATTACHMENT_SIZE_BYTES) {
      return Err(
        `Attachments larger than ${MAX_STAGED_ATTACHMENT_SIZE_BYTES.toLocaleString()} bytes cannot be staged.`
      );
    }

    const bytes = Buffer.from(input.dataBase64, "base64");
    if (bytes.byteLength !== input.sizeBytes) {
      return Err("Attachment size did not match the uploaded data.");
    }
    if (bytes.byteLength > MAX_STAGED_ATTACHMENT_SIZE_BYTES) {
      return Err(
        `Attachments larger than ${MAX_STAGED_ATTACHMENT_SIZE_BYTES.toLocaleString()} bytes cannot be staged.`
      );
    }

    const filename = sanitizeStagedFilename(input.filename);
    const excludeResult = await ensureGitInfoExclude({
      runtime: input.runtime,
      workspacePath: input.workspacePath,
      relativeDir: STAGED_ATTACHMENT_DIR,
    });
    if (excludeResult.status === "failed") {
      return Err(`Could not mark staged attachments as ignored: ${excludeResult.error}`);
    }

    const stagedDir = `${STAGED_ATTACHMENT_DIR}/${randomUUID()}`;
    const stagedPath = `${stagedDir}/${filename}`;
    await input.runtime.ensureDir(`${input.workspacePath}/${stagedDir}`);
    await writeBytes(input.runtime, `${input.workspacePath}/${stagedPath}`, bytes);

    return Ok({ filename, mediaType, sizeBytes: bytes.byteLength, stagedPath });
  } catch (error) {
    return Err(getErrorMessage(error));
  }
}

export async function readStagedWorkspaceAttachment(input: {
  runtime: Runtime;
  workspacePath: string;
  stagedPath: string;
}): Promise<Result<DownloadedStagedWorkspaceAttachment, string>> {
  try {
    assert(input.workspacePath.trim().length > 0, "workspacePath is required");
    const stagedPath = normalizeReadableStagedPath(input.stagedPath);
    if (stagedPath == null) {
      return Err("Invalid staged attachment path.");
    }

    const bytes = await readStreamToBuffer(
      input.runtime.readFile(`${input.workspacePath}/${stagedPath}`)
    );
    if (bytes.byteLength > MAX_STAGED_ATTACHMENT_SIZE_BYTES) {
      return Err(
        `Attachments larger than ${MAX_STAGED_ATTACHMENT_SIZE_BYTES.toLocaleString()} bytes cannot be staged.`
      );
    }

    const filename = stagedPath.split("/").pop() ?? "attachment";
    return Ok({
      filename,
      mediaType: getSupportedStagedAttachmentMediaType({ filename }),
      sizeBytes: bytes.byteLength,
      dataBase64: bytes.toString("base64"),
    });
  } catch (error) {
    return Err(getErrorMessage(error));
  }
}

export async function copyStagedWorkspaceAttachments(input: {
  sourceRuntime: Runtime;
  targetRuntime: Runtime;
  sourceWorkspacePath: string;
  targetWorkspacePath: string;
  stagedPaths?: readonly string[];
}): Promise<Result<void, string>> {
  try {
    assert(input.sourceWorkspacePath.trim().length > 0, "sourceWorkspacePath is required");
    assert(input.targetWorkspacePath.trim().length > 0, "targetWorkspacePath is required");

    const stagedPaths = input.stagedPaths
      ? Ok(normalizeStagedAttachmentPaths(input.stagedPaths))
      : await listStagedAttachmentPaths(input.sourceRuntime, input.sourceWorkspacePath);
    if (!stagedPaths.success) {
      return stagedPaths;
    }
    if (stagedPaths.data.length === 0) {
      return Ok(undefined);
    }

    for (const relativeDir of STAGED_ATTACHMENT_DIRS) {
      const excludeResult = await ensureGitInfoExclude({
        runtime: input.targetRuntime,
        workspacePath: input.targetWorkspacePath,
        relativeDir,
      });
      if (excludeResult.status === "failed") {
        return Err(`Could not mark staged attachments as ignored: ${excludeResult.error}`);
      }
    }

    const shouldSkipUnreadableSource = input.stagedPaths != null;
    for (const stagedPath of stagedPaths.data) {
      let bytes: Buffer;
      try {
        bytes = await readStreamToBuffer(
          input.sourceRuntime.readFile(`${input.sourceWorkspacePath}/${stagedPath}`)
        );
      } catch (error) {
        // Fork history can contain stale generated attachment notices after users clean up
        // staged files manually. Preserve the fork rather than failing the whole workspace copy.
        if (shouldSkipUnreadableSource) {
          continue;
        }
        throw error;
      }
      if (bytes.byteLength > MAX_STAGED_ATTACHMENT_SIZE_BYTES) {
        return Err(
          `Attachments larger than ${MAX_STAGED_ATTACHMENT_SIZE_BYTES.toLocaleString()} bytes cannot be staged.`
        );
      }
      await input.targetRuntime.ensureDir(
        `${input.targetWorkspacePath}/${stagedPath.split("/").slice(0, -1).join("/")}`
      );
      await writeBytes(input.targetRuntime, `${input.targetWorkspacePath}/${stagedPath}`, bytes);
    }

    return Ok(undefined);
  } catch (error) {
    return Err(getErrorMessage(error));
  }
}

export function extractStagedAttachmentPathsFromText(text: string): string[] {
  const paths = new Set<string>();
  const pattern = /`(?<path>\.(?:xum|mux)\/user-attachments\/[^`]+)`/gu;
  for (const match of text.matchAll(pattern)) {
    const stagedPath = match.groups?.path ? normalizeReadableStagedPath(match.groups.path) : null;
    if (stagedPath != null) {
      paths.add(stagedPath);
    }
  }
  return [...paths];
}

export function sanitizeStagedFilename(filename: string): string {
  const rawBase = filename.split(/[\\/]/u).pop()?.trim() ?? "";
  const withoutControls = Array.from(rawBase)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join("");
  const safeChars = withoutControls.replace(/[^A-Za-z0-9._ -]/gu, "-").replace(/^\.+/u, "");
  const fallback = safeChars.trim().length === 0 ? "attachment" : safeChars;
  if (fallback.length <= 120) {
    return fallback;
  }

  const extensionIndex = fallback.lastIndexOf(".");
  const extension = extensionIndex > 0 ? fallback.slice(extensionIndex) : "";
  if (extension.length === 0 || extension.length >= 120) {
    return fallback.slice(0, 120).replace(/\.+$/u, "") || "attachment";
  }
  const stem = fallback
    .slice(0, extensionIndex)
    .slice(0, 120 - extension.length)
    .replace(/\.+$/u, "");
  return `${stem || "attachment"}${extension}`.slice(0, 120);
}

function normalizeReadableStagedPath(stagedPath: string): string | null {
  const normalized = stagedPath.replace(/\\/gu, "/");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized.includes("//") ||
    segments.includes("..") ||
    !STAGED_ATTACHMENT_DIRS.some((dir) => normalized.startsWith(`${dir}/`)) ||
    (segments.at(-1)?.length ?? 0) === 0
  ) {
    return null;
  }
  return normalized;
}

function normalizeStagedAttachmentPaths(stagedPaths: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const stagedPath of stagedPaths) {
    const readablePath = normalizeReadableStagedPath(stagedPath);
    if (readablePath != null) {
      normalized.add(readablePath);
    }
  }
  return [...normalized];
}

async function listStagedAttachmentPaths(
  runtime: Runtime,
  workspacePath: string
): Promise<Result<string[], string>> {
  const findCommands = STAGED_ATTACHMENT_DIRS.map(
    (dir) => `if [ -d ${shellQuote(dir)} ]; then find ${shellQuote(dir)} -type f -print; fi`
  );
  const result = await execBuffered(runtime, findCommands.join("; "), {
    cwd: workspacePath,
    timeout: 30,
  });
  if (result.exitCode !== 0) {
    return Err(result.stderr.trim() || "Failed to list staged attachments.");
  }

  const stagedPaths: string[] = [];
  for (const line of result.stdout.split("\n")) {
    const stagedPath = normalizeReadableStagedPath(line.trim());
    if (stagedPath != null) {
      stagedPaths.push(stagedPath);
    }
  }
  return Ok(stagedPaths);
}

async function readStreamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function writeBytes(runtime: Runtime, path: string, bytes: Uint8Array): Promise<void> {
  const writer = runtime.writeFile(path).getWriter();
  try {
    await writer.write(bytes);
    await writer.close();
  } catch (error) {
    writer.releaseLock();
    throw error;
  }
}
