import MarkdownIt from "markdown-it";

type HeadingMatcher = (headingText: string, level: number) => boolean;

interface SectionBounds {
  headingStartLine: number;
  contentStartLine: number;
  endLine: number;
  level: number;
}

function collectSectionBounds(
  markdown: string,
  headingMatcher: HeadingMatcher
): { bounds: SectionBounds[]; lines: string[] } {
  const lines = markdown.split(/\r?\n/);
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  const tokens = md.parse(markdown, {});
  const bounds: SectionBounds[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== "heading_open") continue;

    const level = Number(token.tag?.replace(/^h/, "")) || 1;
    const inline = tokens[i + 1];
    if (inline?.type !== "inline") continue;

    const headingText = (inline.content || "").trim();
    if (!headingMatcher(headingText, level)) continue;

    const headingStartLine = token.map?.[0] ?? 0;
    const headingEndLine = inline.map?.[1] ?? token.map?.[1] ?? headingStartLine + 1;

    let endLine = lines.length;
    for (let j = i + 1; j < tokens.length; j++) {
      const nextToken = tokens[j];
      if (nextToken.type === "heading_open") {
        const nextLevel = Number(nextToken.tag?.replace(/^h/, "")) || 1;
        if (nextLevel <= level) {
          endLine = nextToken.map?.[0] ?? endLine;
          break;
        }
      }
    }

    bounds.push({ headingStartLine, contentStartLine: headingEndLine, endLine, level });
  }

  return { bounds, lines };
}

function extractSectionsByHeading(markdown: string, headingMatcher: HeadingMatcher): string[] {
  if (!markdown) return [];

  const { bounds, lines } = collectSectionBounds(markdown, headingMatcher);
  if (bounds.length === 0) return [];

  return bounds
    .map(({ contentStartLine, endLine }) =>
      lines.slice(contentStartLine, endLine).join("\n").trim()
    )
    .filter((slice) => slice.length > 0);
}

/**
 * Collapse extracted section bodies into a single block (joined in source order),
 * or null when nothing matched. Shared by the extract* helpers so their
 * "no match -> null, otherwise join" tail stays in one place.
 */
function joinMatchedSections(matches: string[]): string | null {
  return matches.length > 0 ? matches.join("\n\n") : null;
}

function removeSectionsByHeading(markdown: string, headingMatcher: HeadingMatcher): string {
  if (!markdown) return markdown;

  const { bounds, lines } = collectSectionBounds(markdown, headingMatcher);
  if (bounds.length === 0) return markdown;

  // Keep only outermost matched bounds. A matched heading nested inside
  // another matched section (e.g. "## Tool: bash" inside "# Mode: plan") is
  // already removed by the outer splice; splicing both would shift line
  // offsets and delete unrelated content that follows the outer section.
  const outermostBounds = bounds.filter(
    (bound) =>
      !bounds.some(
        (other) => other.headingStartLine < bound.headingStartLine && other.endLine >= bound.endLine
      )
  );

  const updatedLines = [...lines];
  const sortedBounds = [...outermostBounds].sort((a, b) => b.headingStartLine - a.headingStartLine);
  for (const { headingStartLine, endLine } of sortedBounds) {
    updatedLines.splice(headingStartLine, endLine - headingStartLine);
  }

  return updatedLines.join("\n");
}

/**
 * Extract the content under every heading titled "Mode: <mode>" (case-insensitive),
 * where <mode> is the active agent/mode id (e.g. "plan", "exec", or a custom
 * agent name). Mode sections are only honored in Xum-dedicated sources (agent
 * definitions and Xum instruction files) — never in shared AGENTS.md files.
 *
 * All matching sections are joined in source order so a concatenated
 * multi-file blob (e.g. parent + sub-project .xum/AGENTS.md) keeps every
 * file's mode guidance.
 */
export function extractModeSection(markdown: string, mode: string): string | null {
  if (!markdown || !mode) return null;

  const expectedHeading = `mode: ${mode}`.toLowerCase();
  const matches = extractSectionsByHeading(
    markdown,
    (headingText) => headingText.toLowerCase() === expectedHeading
  );
  return joinMatchedSections(matches);
}

/**
 * Extract every section whose heading matches "Model: <regex>" and whose regex matches
 * the provided model identifier, joined in source order (matching multi-file
 * concatenation semantics — see extractModeSection). Matching is case-insensitive by
 * default unless the regex heading explicitly specifies flags via /pattern/flags syntax.
 *
 * Like Mode sections, Model sections are only honored in Xum-dedicated sources —
 * shared AGENTS.md files are read by non-Xum agents too, where a "Model:" heading
 * would be misleading.
 */
export function extractModelSection(markdown: string, modelId: string): string | null {
  if (!markdown || !modelId) return null;

  const headingPattern = /^model:\s*(.+)$/i;

  const compileRegex = (pattern: string): RegExp | null => {
    const trimmed = pattern.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith("/") && trimmed.lastIndexOf("/") > 0) {
      const lastSlash = trimmed.lastIndexOf("/");
      const source = trimmed.slice(1, lastSlash);
      const flags = trimmed.slice(lastSlash + 1);
      try {
        return new RegExp(source, flags || undefined);
      } catch {
        return null;
      }
    }

    try {
      return new RegExp(trimmed, "i");
    } catch {
      return null;
    }
  };

  const matches = extractSectionsByHeading(markdown, (headingText) => {
    const match = headingPattern.exec(headingText);
    if (!match) return false;
    const regex = compileRegex(match[1] ?? "");
    return Boolean(regex?.test(modelId));
  });
  return joinMatchedSections(matches);
}

/**
 * Extract the content under every heading titled "Tool: <tool_name>" (case-insensitive),
 * preserving source order so flattened multi-project instruction blobs keep each repo's rules.
 */
export function extractToolSection(markdown: string, toolName: string): string | null {
  if (!markdown || !toolName) return null;

  const expectedHeading = `tool: ${toolName}`.toLowerCase();
  const matches = extractSectionsByHeading(
    markdown,
    (headingText) => headingText.toLowerCase() === expectedHeading
  );
  return joinMatchedSections(matches);
}

/**
 * Kind of instruction source for scoped-section handling:
 * - "mux": Xum-dedicated sources (agent definitions, `~/.xum/AGENTS.md`,
 *   `<dir>/.xum/AGENTS.md`). All scoped directives (`Model:`, `Mode:`, `Tool:`)
 *   are honored and therefore stripped from the plain instruction text.
 * - "shared": shared AGENTS.md/AGENT.md/CLAUDE.md files read by non-Xum agents
 *   too. Only `Tool:` sections are honored/stripped; `Model:`/`Mode:` headings
 *   are left untouched as ordinary markdown (breaking change — they used to be
 *   parsed here).
 */
export type InstructionSourceKind = "mux" | "shared";

export function stripScopedInstructionSections(
  markdown: string,
  sourceKind: InstructionSourceKind
): string {
  if (!markdown) return markdown;

  return removeSectionsByHeading(markdown, (headingText) => {
    const normalized = headingText.trim().toLowerCase();
    if (normalized.startsWith("tool:")) return true;
    if (sourceKind === "mux") {
      return normalized.startsWith("model:") || normalized.startsWith("mode:");
    }
    return false;
  });
}
