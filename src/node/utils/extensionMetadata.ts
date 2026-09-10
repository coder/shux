import { readFileSync, existsSync } from "fs";

import { getXumExtensionMetadataPath } from "@/common/constants/paths";
import type { WorkspaceActivitySnapshot } from "@/common/types/workspace";
import type { GoalSnapshot } from "@/common/types/goal";
import { GoalSnapshotSchema } from "@/common/orpc/schemas/goal";
import { isThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";
import { log } from "@/node/services/log";

/**
 * Extension metadata for a single workspace.
 * Shared between main app (ExtensionMetadataService) and VS Code extension.
 */
export interface ExtensionAgentStatus {
  emoji: string;
  message: string;
  url?: string;
}

export interface ExtensionMetadata {
  recency: number;
  streaming: boolean;
  streamingGeneration?: number;
  lastModel: string | null;
  lastThinkingLevel: ThinkingLevel | null;
  agentStatus: ExtensionAgentStatus | null;
  displayStatus?: ExtensionAgentStatus | null;
  todoStatus?: ExtensionAgentStatus | null;
  hasTodos?: boolean;
  // Persists the latest display-status URL so later updates without a URL
  // can still carry the last deep link even after displayStatus is cleared.
  lastStatusUrl?: string | null;
  // Backend-only dedup state for AgentStatusService: hash of the input that
  // produced the persisted AI sidebar status. Seeds the in-memory dedup after
  // a restart so unchanged chats are not regenerated. Never exposed on
  // WorkspaceActivitySnapshot (IPC shape).
  sidebarStatusInputHash?: string | null;
  // Backend-only monotonic write counter, advanced by every persisted
  // mutation of this entry. Recovery merges cannot order metadata copies by
  // `recency` — that is a USER-INTERACTION timestamp which status/goal/
  // streaming writers deliberately preserve — so cross-copy ordering uses
  // this generation instead (see recoverStrandedRecreatedLeftover). Never
  // exposed on WorkspaceActivitySnapshot (IPC shape). Builds without this
  // field drop it on their writes; ordering then degrades to the recency
  // tiebreak, never resurrecting against a generation-less newer write.
  writeGeneration?: number;
  goal?: GoalSnapshot | null;
}

/**
 * File structure for extensionMetadata.json
 */
export interface ExtensionMetadataFile {
  version: 1;
  workspaces: Record<string, ExtensionMetadata>;
}

/**
 * Coerce an unknown value into a valid ExtensionAgentStatus, or null if invalid.
 * Shared between the sync reader (extensionMetadata.ts) and ExtensionMetadataService.
 */
export function coerceAgentStatus(value: unknown): ExtensionAgentStatus | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.emoji !== "string" || typeof record.message !== "string") {
    return null;
  }

  if (record.url !== undefined && typeof record.url !== "string") {
    return null;
  }

  return {
    emoji: record.emoji,
    message: record.message,
    ...(typeof record.url === "string" ? { url: record.url } : {}),
  };
}

/**
 * Coerce an unknown value into a string URL, or null if not a string.
 */
export function coerceStatusUrl(url: unknown): string | null {
  return typeof url === "string" ? url : null;
}

function coerceGoalSnapshot(value: unknown): GoalSnapshot | null {
  const parsed = GoalSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function coerceExtensionMetadata(value: unknown): ExtensionMetadata | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.recency !== "number" || typeof record.streaming !== "boolean") {
    return null;
  }

  const displayStatus =
    "displayStatus" in record
      ? record.displayStatus === null
        ? null
        : (coerceAgentStatus(record.displayStatus) ?? undefined)
      : undefined;
  const todoStatus =
    "todoStatus" in record
      ? record.todoStatus === null
        ? null
        : (coerceAgentStatus(record.todoStatus) ?? undefined)
      : undefined;

  const goal =
    "goal" in record
      ? record.goal === null
        ? null
        : (coerceGoalSnapshot(record.goal) ?? undefined)
      : undefined;

  return {
    recency: record.recency,
    streaming: record.streaming,
    ...(typeof record.streamingGeneration === "number"
      ? { streamingGeneration: record.streamingGeneration }
      : {}),
    lastModel: typeof record.lastModel === "string" ? record.lastModel : null,
    lastThinkingLevel: isThinkingLevel(record.lastThinkingLevel) ? record.lastThinkingLevel : null,
    agentStatus: coerceAgentStatus(record.agentStatus),
    ...(displayStatus !== undefined ? { displayStatus } : {}),
    ...(todoStatus !== undefined ? { todoStatus } : {}),
    ...(typeof record.hasTodos === "boolean" ? { hasTodos: record.hasTodos } : {}),
    lastStatusUrl: coerceStatusUrl(record.lastStatusUrl),
    ...(typeof record.sidebarStatusInputHash === "string"
      ? { sidebarStatusInputHash: record.sidebarStatusInputHash }
      : {}),
    ...(typeof record.writeGeneration === "number" && Number.isFinite(record.writeGeneration)
      ? { writeGeneration: record.writeGeneration }
      : {}),
    ...(goal !== undefined ? { goal } : {}),
  };
}

export function toWorkspaceActivitySnapshot(
  metadata: ExtensionMetadata
): WorkspaceActivitySnapshot {
  const displayStatus = metadata.displayStatus !== undefined ? metadata.displayStatus : null;
  const todoStatus =
    metadata.todoStatus !== undefined
      ? metadata.todoStatus
      : metadata.hasTodos === false
        ? null
        : // Upgrade bridge: existing extensionMetadata.json entries may only have the old
          // agentStatus field. Project that forward into todoStatus until a fresh todo_write
          // or stream-stop snapshot rewrites the workspace metadata.
          coerceAgentStatus(metadata.agentStatus);
  return {
    recency: metadata.recency,
    streaming: metadata.streaming,
    ...(typeof metadata.streamingGeneration === "number"
      ? { streamingGeneration: metadata.streamingGeneration }
      : {}),
    lastModel: metadata.lastModel ?? null,
    lastThinkingLevel: metadata.lastThinkingLevel ?? null,
    ...(displayStatus ? { displayStatus } : {}),
    ...(todoStatus ? { todoStatus } : {}),
    ...(typeof metadata.hasTodos === "boolean" ? { hasTodos: metadata.hasTodos } : {}),
    ...(metadata.goal !== undefined ? { goal: metadata.goal } : {}),
  };
}

/**
 * Read extension metadata from JSON file.
 * Returns a map of workspace ID to metadata.
 * Used by both the main app and VS Code extension (vscode/src/muxConfig.ts).
 */
export function readExtensionMetadata(): Map<string, ExtensionMetadata> {
  const metadataPath = getXumExtensionMetadataPath();

  if (!existsSync(metadataPath)) {
    return new Map();
  }

  try {
    const content = readFileSync(metadataPath, "utf-8");
    const data = JSON.parse(content) as ExtensionMetadataFile;

    // Validate structure
    if (typeof data !== "object" || data.version !== 1) {
      log.error("Invalid metadata file format");
      return new Map();
    }

    const map = new Map<string, ExtensionMetadata>();
    for (const [workspaceId, metadata] of Object.entries(data.workspaces || {})) {
      const normalized = coerceExtensionMetadata(metadata);
      if (normalized) {
        map.set(workspaceId, normalized);
      }
    }

    return map;
  } catch (error) {
    log.error("Failed to read metadata:", error);
    return new Map();
  }
}
