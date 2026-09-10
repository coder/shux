import type { AgentDefinitionPackage, AgentId } from "@/common/types/agentDefinition";
import { parseAgentDefinitionMarkdown } from "./parseAgentDefinitionMarkdown";
import { BUILTIN_AGENT_CONTENT } from "./builtInAgentContent.generated";

/**
 * Built-in agent definitions.
 *
 * Source of truth is the markdown files in src/node/builtinAgents/*.md.
 * Content is generated into builtInAgentContent.generated.ts via scripts/generate-builtin-agents.sh.
 */

interface BuiltInSource {
  id: AgentId;
  content: string;
}

const BUILT_IN_SOURCES: BuiltInSource[] = [
  { id: "exec", content: BUILTIN_AGENT_CONTENT.exec },
  { id: "plan", content: BUILTIN_AGENT_CONTENT.plan },
  { id: "compact", content: BUILTIN_AGENT_CONTENT.compact },
  { id: "desktop", content: BUILTIN_AGENT_CONTENT.desktop },
  { id: "explore", content: BUILTIN_AGENT_CONTENT.explore },
  { id: "name_workspace", content: BUILTIN_AGENT_CONTENT.name_workspace },
  { id: "dream", content: BUILTIN_AGENT_CONTENT.dream },
  { id: "intuition", content: BUILTIN_AGENT_CONTENT.intuition },
];

let cachedPackages: AgentDefinitionPackage[] | null = null;

function parseBuiltIns(): AgentDefinitionPackage[] {
  return BUILT_IN_SOURCES.map(({ id, content }) => {
    const parsed = parseAgentDefinitionMarkdown({
      content,
      byteSize: Buffer.byteLength(content, "utf8"),
    });
    return {
      id,
      scope: "built-in" as const,
      frontmatter: parsed.frontmatter,
      body: parsed.body.trim(),
    };
  });
}

export function getBuiltInAgentDefinitions(): AgentDefinitionPackage[] {
  cachedPackages ??= parseBuiltIns();
  return cachedPackages;
}

/** Exposed for testing - clears cached parsed packages */
export function clearBuiltInAgentCache(): void {
  cachedPackages = null;
}
