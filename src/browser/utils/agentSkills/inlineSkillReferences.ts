import type { APIClient } from "@/browser/contexts/API";
import type { SkillResolutionTarget } from "@/browser/features/ChatInput/utils";
import { SkillNameSchema, resolveSkillUserInvocable } from "@/common/orpc/schemas/agentSkill";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { AgentSkillReference } from "@/common/types/message";
import { dedupeAgentSkillRefs } from "@/common/types/message";
import { isMcpPromptCommandKey } from "@/common/utils/tools/mcpPromptCommandKey";
import {
  collectCodeRanges,
  isCursorInsideCodeRange,
  isPositionInRange,
} from "@/browser/utils/markdown/codeRanges";

/** Parser-only candidate. The startIndex/endIndex are autocomplete-replacement aids
 *  and MUST NOT be persisted in metadata (they become ambiguous after edits/reviews/etc.). */
export interface InlineSkillCandidate {
  skillName: string;
  startIndex: number;
  endIndex: number;
}

/** Active candidate when the cursor is inside a `$partial` token (used by autocomplete). */
interface InlineSkillCursorMatch {
  partial: string;
  startIndex: number;
  endIndex: number;
}

const LEFT_BOUNDARY_BLOCKED_RE = /[\w$]/;

function isSkillStartChar(ch: string | undefined): boolean {
  return Boolean(ch && ch >= "a" && ch <= "z");
}

function isSkillContinuationChar(ch: string | undefined): boolean {
  return Boolean(
    ch && ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "-" || ch === "_")
  );
}

function hasSaneLeftBoundary(text: string, dollarIndex: number): boolean {
  if (dollarIndex === 0) {
    return true;
  }

  return !LEFT_BOUNDARY_BLOCKED_RE.test(text[dollarIndex - 1] ?? "");
}

function isPartialToken(rawPartial: string): boolean {
  if (rawPartial.length === 0) {
    return true;
  }

  if (!isSkillStartChar(rawPartial[0])) {
    return false;
  }

  for (let index = 1; index < rawPartial.length; index++) {
    if (!isSkillContinuationChar(rawPartial[index])) {
      return false;
    }
  }

  return true;
}

export function extractInlineSkillReferenceCandidates(text: string): InlineSkillCandidate[] {
  if (!text.includes("$")) {
    return [];
  }

  const codeRanges = collectCodeRanges(text);
  const candidates: InlineSkillCandidate[] = [];
  let codeRangeIndex = 0;

  for (let index = 0; index < text.length; index++) {
    while (codeRangeIndex < codeRanges.length && index >= codeRanges[codeRangeIndex].end) {
      codeRangeIndex++;
    }

    const codeRange = codeRanges[codeRangeIndex];
    if (codeRange && isPositionInRange(index, codeRange)) {
      index = codeRange.end - 1;
      continue;
    }

    if (text[index] !== "$" || !hasSaneLeftBoundary(text, index)) {
      continue;
    }

    if (!isSkillStartChar(text[index + 1])) {
      continue;
    }

    let tokenEnd = index + 2;
    while (tokenEnd < text.length && isSkillContinuationChar(text[tokenEnd])) {
      tokenEnd++;
    }

    const rawTokenEnd = tokenEnd;
    let skillName = text.slice(index + 1, tokenEnd);
    if (skillName.endsWith("-")) {
      skillName = skillName.slice(0, -1);
      tokenEnd--;
    }

    if (SkillNameSchema.safeParse(skillName).success || isMcpPromptCommandKey(skillName)) {
      candidates.push({ skillName, startIndex: index, endIndex: tokenEnd });
    }

    index = rawTokenEnd - 1;
  }

  return candidates;
}

export function findInlineSkillReferenceAtCursor(
  text: string,
  cursor: number
): InlineSkillCursorMatch | null {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > text.length || !text.includes("$")) {
    return null;
  }

  const codeRanges = collectCodeRanges(text);
  if (codeRanges.some((range) => isCursorInsideCodeRange(cursor, range))) {
    return null;
  }

  let tokenStart = cursor;
  while (tokenStart > 0 && isSkillContinuationChar(text[tokenStart - 1])) {
    tokenStart--;
  }

  const dollarIndex = tokenStart > 0 && text[tokenStart - 1] === "$" ? tokenStart - 1 : -1;
  if (dollarIndex === -1 || !hasSaneLeftBoundary(text, dollarIndex)) {
    return null;
  }

  let tokenEnd = cursor;
  while (tokenEnd < text.length && isSkillContinuationChar(text[tokenEnd])) {
    tokenEnd++;
  }

  const partial = text.slice(dollarIndex + 1, tokenEnd);
  if (!isPartialToken(partial)) {
    return null;
  }

  return {
    partial,
    startIndex: dollarIndex,
    endIndex: tokenEnd,
  };
}

interface InlineSkillResolveOptions {
  candidates: InlineSkillCandidate[];
  agentSkillDescriptors: AgentSkillDescriptor[];
  api: APIClient | null;
  discovery: SkillResolutionTarget | null;
}

async function resolveRemoteSkill(options: {
  skillName: string;
  api: APIClient;
  discovery: SkillResolutionTarget;
}): Promise<AgentSkillDescriptor | null> {
  try {
    const pkg =
      options.discovery.kind === "project"
        ? await options.api.agentSkills.get({
            projectPath: options.discovery.projectPath,
            skillName: options.skillName,
          })
        : await options.api.agentSkills.get({
            workspaceId: options.discovery.workspaceId,
            disableWorkspaceAgents: options.discovery.disableWorkspaceAgents,
            skillName: options.skillName,
          });

    // The remote fallback fetches raw frontmatter, so apply the same user-invocability
    // gate the local descriptor list already carries in normalized form.
    if (resolveSkillUserInvocable(pkg.frontmatter) === false) {
      return null;
    }

    return {
      name: pkg.frontmatter.name,
      description: pkg.frontmatter.description,
      scope: pkg.scope,
    };
  } catch {
    return null;
  }
}

export async function resolveInlineSkillReferences(
  options: InlineSkillResolveOptions
): Promise<AgentSkillReference[]> {
  if (options.candidates.length === 0) {
    return [];
  }

  const refs: AgentSkillReference[] = [];
  const seenSkillNames = new Set<string>();

  for (const candidate of options.candidates) {
    if (seenSkillNames.has(candidate.skillName)) {
      continue;
    }
    seenSkillNames.add(candidate.skillName);

    // user-invocable: false skills must be treated as nonexistent for inline $skill refs
    // (they remain model-invocable via agent_skill_read).
    let skill = options.agentSkillDescriptors.find(
      (descriptor) => descriptor.name === candidate.skillName && descriptor.userInvocable !== false
    );

    if (!skill && options.api && options.discovery) {
      skill =
        (await resolveRemoteSkill({
          skillName: candidate.skillName,
          api: options.api,
          discovery: options.discovery,
        })) ?? undefined;
    }

    if (!skill) {
      continue;
    }

    refs.push({ skillName: skill.name, scope: skill.scope, source: "inline" });
  }

  return dedupeAgentSkillRefs(refs);
}
