import * as path from "path";
import * as fs from "fs/promises";

import { mergeAdditionalSystemInstructions } from "@/common/utils/additionalSystemInstructions";
import { ensurePrivateDir, isErrnoWithCode } from "@/node/utils/fs";

interface SessionDirProvider {
  sessionsDir: string;
}

export const ADDITIONAL_SYSTEM_CONTEXT_FILENAME = "additional-system-context.md";
/**
 * Sidecar marker indicating the scratchpad is disabled. When this file exists
 * (its contents are irrelevant), the scratchpad's content is preserved on disk
 * but not injected into the system prompt. We use a sidecar marker rather than
 * a JSON envelope so the content file stays plain markdown for grep/diff.
 */
export const ADDITIONAL_SYSTEM_CONTEXT_DISABLED_FILENAME = "additional-system-context.disabled";

export interface AdditionalSystemContextRecord {
  content: string;
  enabled: boolean;
}

export function getAdditionalSystemContextPath(
  config: SessionDirProvider,
  workspaceId: string
): string {
  return path.join(config.sessionsDir, workspaceId, ADDITIONAL_SYSTEM_CONTEXT_FILENAME);
}

export function getAdditionalSystemContextDisabledPath(
  config: SessionDirProvider,
  workspaceId: string
): string {
  return path.join(
    path.join(config.sessionsDir, workspaceId),
    ADDITIONAL_SYSTEM_CONTEXT_DISABLED_FILENAME
  );
}

async function readContentFile(config: SessionDirProvider, workspaceId: string): Promise<string> {
  try {
    return await fs.readFile(getAdditionalSystemContextPath(config, workspaceId), "utf-8");
  } catch (error) {
    if (isErrnoWithCode(error, "ENOENT")) {
      return "";
    }
    throw error;
  }
}

async function readEnabledFlag(config: SessionDirProvider, workspaceId: string): Promise<boolean> {
  // Default to enabled when the marker file is absent.
  try {
    await fs.access(getAdditionalSystemContextDisabledPath(config, workspaceId));
    return false;
  } catch (error) {
    if (isErrnoWithCode(error, "ENOENT")) {
      return true;
    }
    throw error;
  }
}

export async function readAdditionalSystemContext(
  config: SessionDirProvider,
  workspaceId: string
): Promise<AdditionalSystemContextRecord> {
  const [content, enabled] = await Promise.all([
    readContentFile(config, workspaceId),
    readEnabledFlag(config, workspaceId),
  ]);
  return { content, enabled };
}

export async function writeAdditionalSystemContext(
  config: SessionDirProvider,
  workspaceId: string,
  record: AdditionalSystemContextRecord
): Promise<void> {
  const filePath = getAdditionalSystemContextPath(config, workspaceId);
  const disabledPath = getAdditionalSystemContextDisabledPath(config, workspaceId);
  await ensurePrivateDir(path.dirname(filePath));

  // Empty scratchpads should behave like missing files so fork/copy and prompt
  // injection don't carry around blank durable state. We also drop the
  // disabled marker so the next non-empty edit defaults to enabled.
  if (record.content.length === 0) {
    await Promise.all([fs.rm(filePath, { force: true }), fs.rm(disabledPath, { force: true })]);
    return;
  }

  await fs.writeFile(filePath, record.content, "utf-8");
  if (record.enabled) {
    await fs.rm(disabledPath, { force: true });
  } else {
    await fs.writeFile(disabledPath, "", "utf-8");
  }
}

/**
 * Effective scratchpad text for prompt injection: the content when enabled,
 * an empty string when disabled. Centralised so callers don't have to remember
 * the toggle.
 */
export function effectiveAdditionalSystemContext(record: AdditionalSystemContextRecord): string {
  return record.enabled ? record.content : "";
}

export { mergeAdditionalSystemInstructions };
