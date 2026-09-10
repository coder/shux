import * as path from "node:path";

import { resolveLegacyMuxBuiltInSkillName } from "@/common/compat/legacyMux";
import type { AgentSkillDescriptor, AgentSkillPackage, SkillName } from "@/common/types/agentSkill";
import {
  resolveSkillAdvertise,
  resolveSkillUserInvocable,
  resolveSkillWhenToUse,
} from "@/common/orpc/schemas";
import { parseSkillMarkdown } from "./parseSkillMarkdown";
import { BUILTIN_SKILL_FILES } from "./builtInSkillContent.generated";

/**
 * Built-in skill definitions.
 *
 * Source of truth is:
 * - src/node/builtinSkills/*.md (SKILL.md content)
 * - docs/ (embedded for xum-docs)
 *
 * Content is generated into builtInSkillContent.generated.ts via scripts/gen_builtin_skills.ts.
 */

interface BuiltInSource {
  name: SkillName;
  files: Record<string, string>;
}

const BUILT_IN_SOURCES: BuiltInSource[] = Object.entries(BUILTIN_SKILL_FILES).map(
  ([name, files]) => ({ name, files })
);

let cachedPackages: AgentSkillPackage[] | null = null;

function parseBuiltIns(): AgentSkillPackage[] {
  return BUILT_IN_SOURCES.map(({ name, files }) => {
    const content = files["SKILL.md"];
    if (content === undefined) {
      throw new Error(`Built-in skill '${name}' is missing SKILL.md`);
    }

    const parsed = parseSkillMarkdown({
      content,
      byteSize: Buffer.byteLength(content, "utf8"),
      directoryName: name,
    });

    return {
      scope: "built-in" as const,
      directoryName: name,
      frontmatter: parsed.frontmatter,
      body: parsed.body.trim(),
    };
  });
}

export function getBuiltInSkillDefinitions(): AgentSkillPackage[] {
  cachedPackages ??= parseBuiltIns();
  return cachedPackages;
}

export function getBuiltInSkillDescriptors(): AgentSkillDescriptor[] {
  return getBuiltInSkillDefinitions().map((pkg) => ({
    name: pkg.frontmatter.name,
    description: pkg.frontmatter.description,
    scope: pkg.scope,
    advertise: resolveSkillAdvertise(pkg.frontmatter),
    userInvocable: resolveSkillUserInvocable(pkg.frontmatter),
    argumentHint: pkg.frontmatter["argument-hint"],
    whenToUse: resolveSkillWhenToUse(pkg.frontmatter),
  }));
}

export function getBuiltInSkillByName(name: SkillName): AgentSkillPackage | undefined {
  const canonicalName = resolveLegacyMuxBuiltInSkillName(name);
  return getBuiltInSkillDefinitions().find((pkg) => pkg.frontmatter.name === canonicalName);
}

function isAbsolutePathAny(filePath: string): boolean {
  if (filePath.startsWith("/") || filePath.startsWith("\\")) return true;

  // Windows drive letter paths (e.g., C:\foo or C:/foo)
  if (/^[A-Za-z]:/.test(filePath)) {
    const sep = filePath[2];
    return sep === "\\" || sep === "/";
  }

  return false;
}

function normalizeBuiltInSkillFilePath(filePath: string): string {
  if (!filePath) {
    throw new Error("filePath is required");
  }

  // Disallow absolute paths and home-relative paths.
  if (isAbsolutePathAny(filePath) || filePath.startsWith("~")) {
    throw new Error(`Invalid filePath (must be relative to the skill directory): ${filePath}`);
  }

  // Always normalize with posix separators (built-in skill file paths are stored posix-style).
  const normalized = path.posix.normalize(filePath.replaceAll("\\", "/"));
  const stripped = normalized.startsWith("./") ? normalized.slice(2) : normalized;

  if (stripped === "" || stripped === "." || stripped.endsWith("/")) {
    throw new Error(`Invalid filePath (expected a file, got directory): ${filePath}`);
  }

  if (stripped === ".." || stripped.startsWith("../")) {
    throw new Error(`Invalid filePath (path traversal): ${filePath}`);
  }

  return stripped;
}

export function readBuiltInSkillFile(
  name: SkillName,
  filePath: string
): { resolvedPath: string; content: string } {
  const resolvedPath = normalizeBuiltInSkillFilePath(filePath);

  const canonicalName = resolveLegacyMuxBuiltInSkillName(name);
  const skillFiles = BUILTIN_SKILL_FILES[canonicalName];
  if (!skillFiles) {
    throw new Error(`Built-in skill not found: ${name}`);
  }

  const content = skillFiles[resolvedPath];
  if (content === undefined) {
    throw new Error(`Built-in skill file not found: ${name}/${resolvedPath}`);
  }

  return { resolvedPath, content };
}
