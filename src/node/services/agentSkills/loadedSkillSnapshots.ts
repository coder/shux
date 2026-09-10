import { createHash } from "crypto";
import YAML from "yaml";

import assert from "@/common/utils/assert";
import { MAX_POST_COMPACTION_LOADED_SKILLS } from "@/common/constants/attachments";
import type { LoadedSkillSnapshot } from "@/common/types/attachment";
import type { AgentSkillFrontmatter, AgentSkillScope } from "@/common/types/agentSkill";
import type { MuxMessage } from "@/common/types/message";
import { AgentSkillPackageSchema, AgentSkillScopeSchema } from "@/common/orpc/schemas/agentSkill";
import {
  extractAgentSkillBodyFromSnapshotText,
  isNormalizedAgentSkillBodyTruncated,
  normalizeAgentSkillSnapshotBody,
  renderAgentSkillSnapshotText,
} from "@/common/utils/agentSkills/skillSnapshot";

export interface PersistedLoadedSkillSnapshotInput {
  name?: unknown;
  scope?: unknown;
  body?: unknown;
  frontmatterYaml?: unknown;
  truncated?: unknown;
}

interface CreateLoadedSkillSnapshotArgs {
  name: string;
  scope: unknown;
  body: string;
  frontmatterYaml?: string;
  alreadyNormalized?: boolean;
  truncated?: boolean;
}

function normalizeFrontmatterYaml(frontmatterYaml: string | undefined): string | undefined {
  if (typeof frontmatterYaml !== "string") {
    return undefined;
  }

  const trimmed = frontmatterYaml.trimEnd();
  return trimmed.length > 0 ? trimmed : undefined;
}

function computeLoadedSkillSnapshotSha256(args: {
  name: string;
  scope: AgentSkillScope;
  body: string;
  frontmatterYaml?: string;
}): string {
  const snapshotText = renderAgentSkillSnapshotText({
    name: args.name,
    scope: args.scope,
    body: args.body,
  });

  return createHash("sha256")
    .update(
      JSON.stringify({
        snapshotText,
        ...(args.frontmatterYaml !== undefined ? { frontmatterYaml: args.frontmatterYaml } : {}),
      })
    )
    .digest("hex");
}

export function createLoadedSkillSnapshot(
  args: CreateLoadedSkillSnapshotArgs
): LoadedSkillSnapshot {
  assert(typeof args.name === "string" && args.name.trim().length > 0, "skill name is required");
  assert(typeof args.body === "string", "skill body must be a string");

  const parsedScope = AgentSkillScopeSchema.safeParse(args.scope);
  assert(parsedScope.success, "loaded skill snapshot scope must be valid");

  const normalizedFrontmatterYaml = normalizeFrontmatterYaml(args.frontmatterYaml);
  const normalizedBody = normalizeAgentSkillSnapshotBody(args.body, {
    alreadyNormalized: args.alreadyNormalized,
    truncated: args.truncated,
  });

  const snapshot: LoadedSkillSnapshot = {
    name: args.name.trim(),
    scope: parsedScope.data,
    sha256: computeLoadedSkillSnapshotSha256({
      name: args.name.trim(),
      scope: parsedScope.data,
      body: normalizedBody.body,
      frontmatterYaml: normalizedFrontmatterYaml,
    }),
    body: normalizedBody.body,
    ...(normalizedFrontmatterYaml !== undefined
      ? { frontmatterYaml: normalizedFrontmatterYaml }
      : {}),
    ...(normalizedBody.truncated ? { truncated: true } : {}),
  };

  assert(snapshot.sha256.length > 0, "loaded skill snapshot must include a sha256");
  return snapshot;
}

export function stringifyAgentSkillFrontmatter(frontmatter: AgentSkillFrontmatter): string {
  const yaml = YAML.stringify(frontmatter).trimEnd();
  assert(yaml.length > 0, "agent skill frontmatter yaml must not be empty");
  return yaml;
}

function getMessageTextContent(message: MuxMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<MuxMessage["parts"][number], { type: "text" }> => part.type === "text"
    )
    .map((part) => part.text)
    .join("");
}

function extractLoadedSkillSnapshotFromToolOutput(output: unknown): LoadedSkillSnapshot | null {
  if (typeof output !== "object" || output == null || Array.isArray(output)) {
    return null;
  }

  const toolResult = output as { success?: unknown; skill?: unknown };
  if (toolResult.success !== true) {
    return null;
  }

  const parsedSkill = AgentSkillPackageSchema.safeParse(toolResult.skill);
  if (!parsedSkill.success) {
    return null;
  }

  const skill = parsedSkill.data;
  return createLoadedSkillSnapshot({
    name: skill.frontmatter.name,
    scope: skill.scope,
    body: skill.body,
    frontmatterYaml: stringifyAgentSkillFrontmatter(skill.frontmatter),
  });
}

function extractLoadedSkillSnapshotFromSyntheticMessage(
  message: MuxMessage
): LoadedSkillSnapshot | null {
  const snapshotMeta = message.metadata?.agentSkillSnapshot;
  if (!snapshotMeta) {
    return null;
  }

  const snapshotText = getMessageTextContent(message);
  if (snapshotText.length === 0) {
    return null;
  }

  const body = extractAgentSkillBodyFromSnapshotText(snapshotText, {
    name: snapshotMeta.skillName,
    scope: snapshotMeta.scope,
  });
  if (body == null) {
    return null;
  }

  return createLoadedSkillSnapshot({
    name: snapshotMeta.skillName,
    scope: snapshotMeta.scope,
    body,
    frontmatterYaml: snapshotMeta.frontmatterYaml,
    alreadyNormalized: true,
    truncated: isNormalizedAgentSkillBodyTruncated(body),
  });
}

/**
 * Nested agent_skill_read calls inside a code_execution part (exclusive PTC):
 * skill reads happen as nested xum.agent_skill_read calls, so the outer part
 * is named "code_execution" and the results live in its output's toolCalls
 * records. Classic PTC records retain the full result (snapshot recoverable);
 * kernel-compacted records drop result contents, so nothing survives there —
 * extractLoadedSkillSnapshotFromToolOutput rejects those records naturally.
 */
function extractLoadedSkillSnapshotsFromCodeExecutionOutput(
  output: unknown
): LoadedSkillSnapshot[] {
  if (typeof output !== "object" || output === null) return [];
  const toolCalls = (output as { toolCalls?: unknown }).toolCalls;
  if (!Array.isArray(toolCalls)) return [];

  const snapshots: LoadedSkillSnapshot[] = [];
  for (const record of toolCalls as Array<Record<string, unknown>>) {
    if (typeof record !== "object" || record === null) continue;
    if (record.toolName !== "agent_skill_read" || record.error !== undefined) continue;
    // Nested history is untrusted: an explicit ok:false marks the call failed
    // even when a schema-valid result rides alongside (r18). Other nested
    // extractors treat ok:false as authoritative failure — do the same here so
    // contradictory rows cannot inject a skill snapshot into later requests.
    if (record.ok === false) continue;
    const snapshot = extractLoadedSkillSnapshotFromToolOutput(record.result);
    if (snapshot) {
      snapshots.push(snapshot);
    }
  }
  return snapshots;
}

function extractLoadedSkillSnapshotsFromMessage(message: MuxMessage): LoadedSkillSnapshot[] {
  const snapshots: LoadedSkillSnapshot[] = [];

  for (const part of message.parts) {
    if (part.type !== "dynamic-tool" || part.state !== "output-available") {
      continue;
    }

    if (part.toolName === "code_execution") {
      snapshots.push(...extractLoadedSkillSnapshotsFromCodeExecutionOutput(part.output));
      continue;
    }

    if (part.toolName !== "agent_skill_read") {
      continue;
    }

    const snapshot = extractLoadedSkillSnapshotFromToolOutput(part.output);
    if (snapshot) {
      snapshots.push(snapshot);
    }
  }

  if (snapshots.length > 0) {
    return snapshots;
  }

  const syntheticSnapshot = extractLoadedSkillSnapshotFromSyntheticMessage(message);
  return syntheticSnapshot ? [syntheticSnapshot] : [];
}

export function mergeLoadedSkillSnapshots(snapshots: LoadedSkillSnapshot[]): LoadedSkillSnapshot[] {
  const byScopeAndName = new Map<string, LoadedSkillSnapshot>();

  for (const snapshot of snapshots) {
    const key = `${snapshot.scope}:${snapshot.name}`;
    if (byScopeAndName.has(key)) {
      byScopeAndName.delete(key);
    }
    byScopeAndName.set(key, snapshot);
  }

  const deduped = [...byScopeAndName.values()];
  if (deduped.length <= MAX_POST_COMPACTION_LOADED_SKILLS) {
    return deduped;
  }

  return deduped.slice(-MAX_POST_COMPACTION_LOADED_SKILLS);
}

export function extractLoadedSkillSnapshotsFromMessages(
  messages: MuxMessage[]
): LoadedSkillSnapshot[] {
  assert(Array.isArray(messages), "extractLoadedSkillSnapshotsFromMessages requires messages");

  const snapshots: LoadedSkillSnapshot[] = [];
  for (const message of messages) {
    snapshots.push(...extractLoadedSkillSnapshotsFromMessage(message));
  }

  return mergeLoadedSkillSnapshots(snapshots);
}
