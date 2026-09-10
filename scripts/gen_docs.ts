#!/usr/bin/env bun
/**
 * Generate documentation snippets from source files.
 *
 * Usage:
 *   bun scripts/gen_docs.ts         # write mode (update docs)
 *   bun scripts/gen_docs.ts check   # check mode (verify docs are up-to-date)
 *
 * This script synchronizes:
 *   - docs/agents/system-prompt.mdx: snippet from src/node/services/systemMessage.ts
 *   - docs/config/models.mdx: table from src/common/constants/knownModels.ts
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import * as prettier from "prettier";
import { KNOWN_MODELS, DEFAULT_MODEL } from "../src/common/constants/knownModels";
import { buildCompactionPrompt, DEFAULT_COMPACTION_WORD_TARGET } from "../src/common/constants/ui";
import { formatModelDisplayName } from "../src/common/utils/ai/modelDisplay";
import { AgentDefinitionFrontmatterSchema } from "../src/common/orpc/schemas/agentDefinition";
import { PROVIDER_ENV_VARS, AZURE_OPENAI_ENV_VARS } from "../src/node/utils/providerRequirements";
import { TOOL_DEFINITIONS } from "../src/common/utils/tools/toolDefinitions";
import { toolHookEnvVarName } from "../src/common/utils/tools/toolHookEnv";

const MODE = process.argv[2] === "check" ? "check" : "write";
const DOCS_DIR = path.join(import.meta.dir, "..", "docs");

// ---------------------------------------------------------------------------
// Marker helpers
// ---------------------------------------------------------------------------

function injectBetweenMarkers(content: string, markerName: string, block: string): string {
  const beginMarker = `{/* BEGIN ${markerName} */}`;
  const endMarker = `{/* END ${markerName} */}`;

  const beginIdx = content.indexOf(beginMarker);
  const endIdx = content.indexOf(endMarker);

  if (beginIdx === -1 || endIdx === -1) {
    throw new Error(`Missing markers for ${markerName}`);
  }

  const before = content.slice(0, beginIdx + beginMarker.length);
  const after = content.slice(endIdx);

  return `${before}\n\n${block}\n\n${after}`;
}

// ---------------------------------------------------------------------------
// Generic sync helper
// ---------------------------------------------------------------------------

interface SyncDocOptions {
  docsFile: string;
  sourceLabel: string;
  markerName: string;
  generateBlock: () => string;
}

async function syncDoc(options: SyncDocOptions): Promise<boolean> {
  const { docsFile, sourceLabel, markerName, generateBlock } = options;
  const docsPath = path.join(DOCS_DIR, docsFile);

  const currentContent = fs.readFileSync(docsPath, "utf-8");
  const block = generateBlock();
  const rawContent = injectBetweenMarkers(currentContent, markerName, block);

  // Format with prettier to ensure consistent output
  const prettierConfig = await prettier.resolveConfig(docsPath);
  const newContent = await prettier.format(rawContent, {
    ...prettierConfig,
    filepath: docsPath,
  });

  if (currentContent === newContent) {
    console.log(`✓ ${docsFile} is up-to-date with ${sourceLabel}`);
    return true;
  }

  if (MODE === "check") {
    console.error(`✗ ${docsFile} is out of sync with ${sourceLabel}`);
    console.error(`  Run 'make fmt' to regenerate.`);
    return false;
  }

  fs.writeFileSync(docsPath, newContent, "utf-8");
  console.log(`✓ Updated ${docsFile} from ${sourceLabel}`);
  return true;
}

// ---------------------------------------------------------------------------
// System prompt sync
// ---------------------------------------------------------------------------

function generateSystemPromptBlock(): string {
  const systemMessagePath = path.join(
    import.meta.dir,
    "..",
    "src",
    "node",
    "services",
    "systemMessage.ts"
  );
  const source = fs.readFileSync(systemMessagePath, "utf-8");

  const regionStart = "// #region SYSTEM_PROMPT_DOCS";
  const regionEnd = "// #endregion SYSTEM_PROMPT_DOCS";

  const startIdx = source.indexOf(regionStart);
  const endIdx = source.indexOf(regionEnd);

  if (startIdx === -1 || endIdx === -1) {
    throw new Error("Could not find SYSTEM_PROMPT_DOCS region in systemMessage.ts");
  }

  const snippet = source.slice(startIdx + regionStart.length, endIdx).trim();
  return "```typescript\n" + snippet + "\n```";
}

async function syncSystemPrompt(): Promise<boolean> {
  return syncDoc({
    docsFile: "agents/system-prompt.mdx",
    sourceLabel: "src/node/services/systemMessage.ts",
    markerName: "SYSTEM_PROMPT_DOCS",
    generateBlock: generateSystemPromptBlock,
  });
}

// ---------------------------------------------------------------------------
// Known models table sync
// ---------------------------------------------------------------------------

function generateKnownModelsTable(): string {
  const rows: Array<{ name: string; id: string; aliases: string; isDefault: boolean }> = [];

  for (const model of Object.values(KNOWN_MODELS)) {
    rows.push({
      name: formatModelDisplayName(model.providerModelId),
      id: model.id,
      aliases: (model.aliases ?? []).map((a) => `\`${a}\``).join(", ") || "—",
      isDefault: model.id === DEFAULT_MODEL,
    });
  }

  // Calculate column widths
  const headers = ["Model", "ID", "Aliases", "Default"];
  const widths = headers.map((h, i) => {
    const colValues = rows.map((r) => {
      if (i === 0) return r.name;
      if (i === 1) return r.id;
      if (i === 2) return r.aliases;
      return r.isDefault ? "✓" : "";
    });
    return Math.max(h.length, ...colValues.map((v) => v.length));
  });

  const pad = (s: string, w: number) => s + " ".repeat(w - s.length);

  const headerRow = `| ${headers.map((h, i) => pad(h, widths[i])).join(" | ")} |`;
  const sepRow = `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`;
  const dataRows = rows.map((r) => {
    const cells = [
      pad(r.name, widths[0]),
      pad(r.id, widths[1]),
      pad(r.aliases, widths[2]),
      pad(r.isDefault ? "✓" : "", widths[3]),
    ];
    return `| ${cells.join(" | ")} |`;
  });

  return [headerRow, sepRow, ...dataRows].join("\n");
}

async function syncKnownModels(): Promise<boolean> {
  return syncDoc({
    docsFile: "config/models.mdx",
    sourceLabel: "src/common/constants/knownModels.ts",
    markerName: "KNOWN_MODELS_TABLE",
    generateBlock: generateKnownModelsTable,
  });
}

// ---------------------------------------------------------------------------
// Built-in agents sync
// ---------------------------------------------------------------------------

interface ParsedAgent {
  id: string;
  frontmatter: ReturnType<typeof AgentDefinitionFrontmatterSchema.parse>;
  body: string;
  /** Original file content (preserves comments and formatting) */
  rawContent: string;
}

function parseFrontmatter(content: string): { frontmatter: unknown; body: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  return {
    frontmatter: yaml.parse(match[1]),
    body: match[2].trim(),
  };
}

function loadBuiltinAgents(): ParsedAgent[] {
  const agentsDir = path.join(import.meta.dir, "..", "src", "node", "builtinAgents");
  const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));

  const agents: ParsedAgent[] = [];
  for (const filename of files) {
    const content = fs.readFileSync(path.join(agentsDir, filename), "utf-8");
    const parsed = parseFrontmatter(content);
    if (!parsed) {
      throw new Error(`Failed to parse frontmatter in ${filename}`);
    }

    const result = AgentDefinitionFrontmatterSchema.safeParse(parsed.frontmatter);
    if (!result.success) {
      throw new Error(`Invalid frontmatter in ${filename}: ${result.error.message}`);
    }

    agents.push({
      id: filename.slice(0, -3), // Remove .md extension
      frontmatter: result.data,
      body: parsed.body,
      rawContent: content.trim(),
    });
  }

  // Sort: visible agents first (exec, plan), then hidden ones
  return agents.sort((a, b) => {
    const aHidden = a.frontmatter.ui?.hidden ?? false;
    const bHidden = b.frontmatter.ui?.hidden ?? false;
    if (aHidden !== bHidden) return aHidden ? 1 : -1;
    return a.frontmatter.name.localeCompare(b.frontmatter.name);
  });
}

function generateBuiltinAgentsBlock(): string {
  const agents = loadBuiltinAgents();
  const sections: string[] = [];

  for (const agent of agents) {
    const { id, frontmatter, rawContent } = agent;
    const lines: string[] = [];

    // Header
    const hiddenBadge = frontmatter.ui?.hidden ? " (internal)" : "";
    lines.push(`### ${frontmatter.name}${hiddenBadge}`);
    lines.push("");
    if (frontmatter.description) {
      lines.push(`**${frontmatter.description}**`);
      lines.push("");
    }

    // Show the full agent file as an example (using raw content to preserve comments)
    lines.push(`<Accordion title="View ${id}.md">`);
    lines.push("");
    lines.push("```md");
    lines.push(rawContent);
    lines.push("```");
    lines.push("");
    lines.push("</Accordion>");

    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}

async function syncBuiltinAgents(): Promise<boolean> {
  return syncDoc({
    docsFile: "agents/index.mdx",
    sourceLabel: "src/node/builtinAgents/*.md",
    markerName: "BUILTIN_AGENTS",
    generateBlock: generateBuiltinAgentsBlock,
  });
}

// ---------------------------------------------------------------------------
// Compaction customization docs sync
// ---------------------------------------------------------------------------

function generateCompactAgentSystemPromptBlock(): string {
  const compact = loadBuiltinAgents().find((agent) => agent.id === "compact");
  if (!compact) {
    throw new Error("Could not find built-in compact agent");
  }

  return "```text\n" + compact.body.trim() + "\n```";
}

async function syncCompactAgentSystemPrompt(): Promise<boolean> {
  return syncDoc({
    docsFile: "workspaces/compaction/customization.mdx",
    sourceLabel: "src/node/builtinAgents/compact.md",
    markerName: "COMPACT_AGENT_SYSTEM_PROMPT",
    generateBlock: generateCompactAgentSystemPromptBlock,
  });
}

function generateCompactionUserPromptBlock(): string {
  const prompt = buildCompactionPrompt(DEFAULT_COMPACTION_WORD_TARGET);
  return "```text\n" + prompt.trim() + "\n```";
}

async function syncCompactionCustomizationDocs(): Promise<boolean> {
  // These markers live in the same file, so they must be updated sequentially.
  const systemPromptResult = await syncCompactAgentSystemPrompt();
  const userPromptResult = await syncCompactionUserPrompt();
  return systemPromptResult && userPromptResult;
}
async function syncCompactionUserPrompt(): Promise<boolean> {
  return syncDoc({
    docsFile: "workspaces/compaction/customization.mdx",
    sourceLabel: "src/common/constants/ui.ts",
    markerName: "COMPACTION_USER_PROMPT",
    generateBlock: generateCompactionUserPromptBlock,
  });
}

// ---------------------------------------------------------------------------
// User notify tool docs sync
// ---------------------------------------------------------------------------

function generateUserNotifyBlock(): string {
  const toolDefsPath = path.join(
    import.meta.dir,
    "..",
    "src",
    "common",
    "utils",
    "tools",
    "toolDefinitions.ts"
  );
  const source = fs.readFileSync(toolDefsPath, "utf-8");

  const regionStart = "// #region NOTIFY_DOCS";
  const regionEnd = "// #endregion NOTIFY_DOCS";

  const startIdx = source.indexOf(regionStart);
  const endIdx = source.indexOf(regionEnd);

  if (startIdx === -1 || endIdx === -1) {
    throw new Error("Could not find NOTIFY_DOCS region in toolDefinitions.ts");
  }

  const snippet = source.slice(startIdx + regionStart.length, endIdx).trim();
  return "```typescript\n" + snippet + "\n```";
}

async function syncNotifyDocs(): Promise<boolean> {
  return syncDoc({
    docsFile: "config/notifications.mdx",
    sourceLabel: "src/common/utils/tools/toolDefinitions.ts",
    markerName: "NOTIFY_TOOL",
    generateBlock: generateUserNotifyBlock,
  });
}

// ---------------------------------------------------------------------------
// Provider env vars sync
// ---------------------------------------------------------------------------

/** Display names for providers (title case) */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  deepseek: "DeepSeek",
  moonshotai: "Moonshot AI",
  zai: "Z.ai",
  openrouter: "OpenRouter",
  bedrock: "Bedrock",
};

function generateProviderEnvVarsBlock(): string {
  const lines: string[] = [];

  // Main table: primary API key env vars
  lines.push("| Provider   | Environment Variable                               |");
  lines.push("| ---------- | -------------------------------------------------- |");

  for (const [provider, vars] of Object.entries(PROVIDER_ENV_VARS)) {
    const displayName = PROVIDER_DISPLAY_NAMES[provider] ?? provider;
    let envVars: string;

    if (vars.apiKey?.length) {
      envVars = vars.apiKey.map((v) => `\`${v}\``).join(" or ");
    } else if (vars.region?.length) {
      envVars = `\`${vars.region[0]}\` (credentials via AWS SDK chain)`;
    } else {
      continue;
    }

    lines.push(`| ${displayName.padEnd(10)} | ${envVars.padEnd(50)} |`);
  }

  // Additional env vars in details block
  lines.push("");
  lines.push("<details>");
  lines.push("<summary>Additional environment variables</summary>");
  lines.push("");
  lines.push("| Provider     | Variable                   | Purpose             |");
  lines.push("| ------------ | -------------------------- | ------------------- |");

  // Collect additional vars (baseUrl, organization, etc.)
  for (const [provider, vars] of Object.entries(PROVIDER_ENV_VARS)) {
    const displayName = PROVIDER_DISPLAY_NAMES[provider] ?? provider;

    if (vars.baseUrl?.length) {
      lines.push(
        `| ${displayName.padEnd(12)} | \`${vars.baseUrl[0]}\``.padEnd(42) +
          " | Custom API endpoint |"
      );
    }
    if (vars.organization?.length) {
      lines.push(
        `| ${displayName.padEnd(12)} | \`${vars.organization[0]}\``.padEnd(42) +
          " | Organization ID     |"
      );
    }
  }

  // Azure OpenAI (special case)
  lines.push(
    `| Azure OpenAI | \`${AZURE_OPENAI_ENV_VARS.apiKey}\``.padEnd(42) + " | API key             |"
  );
  lines.push(
    `| Azure OpenAI | \`${AZURE_OPENAI_ENV_VARS.endpoint}\``.padEnd(42) + " | Endpoint URL        |"
  );
  lines.push(
    `| Azure OpenAI | \`${AZURE_OPENAI_ENV_VARS.deployment}\``.padEnd(42) +
      " | Deployment name     |"
  );
  lines.push(
    `| Azure OpenAI | \`${AZURE_OPENAI_ENV_VARS.apiVersion}\``.padEnd(42) +
      " | API version         |"
  );

  lines.push("");
  lines.push("Azure OpenAI env vars configure the OpenAI provider with Azure backend.");
  lines.push("");
  lines.push("</details>");

  return lines.join("\n");
}

async function syncProviderEnvVars(): Promise<boolean> {
  return syncDoc({
    docsFile: "config/providers.mdx",
    sourceLabel: "src/node/utils/providerRequirements.ts",
    markerName: "PROVIDER_ENV_VARS",
    generateBlock: generateProviderEnvVarsBlock,
  });
}

// ---------------------------------------------------------------------------
// Tool hook env vars (tool-specific flattened env vars)
// ---------------------------------------------------------------------------

type ToolHookEnvVarDoc = {
  envVar: string;
  jsonPath: string;
  type: string;
  description: string;
};

function escapeMarkdownTableCodeCell(value: string): string {
  // Values are wrapped in backticks, so we mostly just need to keep the table
  // delimiter safe.
  return value.replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

function escapeMarkdownTableTextCell(value: string): string {
  // docs/hooks/tools.mdx is MDX; raw `<...>` sequences can be parsed as JSX.
  // Escape them so tool descriptions like "(<5s)" render correctly.
  // `_` and `*` must also be escaped: identifiers like `task_ids`/`wfr_...` can pair up
  // into emphasis spans, which Prettier then normalizes into mid-word `*` delimiters,
  // shipping mangled text (e.g. "task*ids") to the docs site and built-in skills.
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replaceAll("_", "\\_")
    .replaceAll("*", "\\*")
    .replaceAll("\\n", " ")
    .replaceAll("\n", " ")
    .trim();
}

function getZodSchemaType(schema: unknown): string | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;

  if (!("type" in schema)) return undefined;
  const type = (schema as { type: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

function getZodSchemaDescription(schema: unknown): string | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;
  if (!("description" in schema)) return undefined;

  const description = (schema as { description: unknown }).description;
  return typeof description === "string" && description.trim() ? description.trim() : undefined;
}

function unwrapZodSchemaForDocs(schema: unknown): unknown {
  let current = schema;

  // Best-effort unwrap of wrappers we commonly use in tool schemas.
  for (let i = 0; i < 20; i += 1) {
    const type = getZodSchemaType(current);

    if (type === "optional" || type === "nullable" || type === "default") {
      if (typeof current !== "object" || current === null) break;
      const def = (current as { _def?: unknown })._def;
      if (typeof def !== "object" || def === null) break;
      if (!("innerType" in def)) break;
      current = (def as { innerType: unknown }).innerType;
      continue;
    }

    // z.preprocess() in Zod v4 is represented as a "pipe" (transform -> schema)
    if (type === "pipe") {
      if (typeof current !== "object" || current === null) break;
      const def = (current as { _def?: unknown })._def;
      if (typeof def !== "object" || def === null) break;
      if (!("out" in def)) break;
      current = (def as { out: unknown }).out;
      continue;
    }

    break;
  }

  return current;
}

function collectToolHookEnvVarsFromZodSchema(schema: unknown): ToolHookEnvVarDoc[] {
  const entries = new Map<string, ToolHookEnvVarDoc>();

  function add(entry: ToolHookEnvVarDoc): void {
    // De-dupe by env var name (unions, etc.)
    if (!entries.has(entry.envVar)) {
      entries.set(entry.envVar, entry);
    }
  }

  function walk(
    currentSchema: unknown,
    options: {
      keyPath: string[];
      jsonPath: string;
      descriptionHint?: string;
    }
  ): void {
    const description = getZodSchemaDescription(currentSchema) ?? options.descriptionHint;
    const unwrapped = unwrapZodSchemaForDocs(currentSchema);
    const type = getZodSchemaType(unwrapped) ?? "unknown";

    if (type === "object") {
      if (typeof unwrapped !== "object" || unwrapped === null) return;
      if (!("shape" in unwrapped)) return;
      const shape = (unwrapped as { shape: unknown }).shape;
      if (typeof shape !== "object" || shape === null) return;

      for (const [key, child] of Object.entries(shape)) {
        walk(child, {
          keyPath: [...options.keyPath, key],
          jsonPath: options.jsonPath ? `${options.jsonPath}.${key}` : key,
        });
      }
      return;
    }

    if (type === "record") {
      if (typeof unwrapped !== "object" || unwrapped === null) return;
      const def = (unwrapped as { _def?: unknown })._def;
      if (typeof def !== "object" || def === null) return;
      if (!("valueType" in def)) return;

      // Dynamic keys: document a <KEY> template.
      walk((def as { valueType: unknown }).valueType, {
        keyPath: [...options.keyPath, "<KEY>"],
        jsonPath: options.jsonPath ? `${options.jsonPath}[<KEY>]` : "[<KEY>]",
        descriptionHint: description,
      });
      return;
    }

    if (type === "array" || type === "tuple") {
      // Arrays also get a _COUNT env var.
      add({
        envVar: toolHookEnvVarName("XUM_TOOL_INPUT", [...options.keyPath, "COUNT"], {
          allowPlaceholders: true,
        }),
        jsonPath: options.jsonPath ? `${options.jsonPath}.length` : "length",
        type: "number",
        description: description
          ? `Number of elements in ${options.jsonPath} (${description})`
          : `Number of elements in ${options.jsonPath}`,
      });

      let elementSchema: unknown;
      if (type === "array") {
        if (typeof unwrapped !== "object" || unwrapped === null) return;
        if (!("element" in unwrapped)) return;
        elementSchema = (unwrapped as { element: unknown }).element;
      } else {
        // tuple
        if (typeof unwrapped !== "object" || unwrapped === null) return;
        const def = (unwrapped as { _def?: unknown })._def;
        if (typeof def !== "object" || def === null) return;
        if (!("items" in def)) return;
        elementSchema = (def as { items: unknown }).items;
      }

      // If the elementSchema is actually an array (tuple items), walk each item
      // but keep a single <INDEX> placeholder in the key.
      if (Array.isArray(elementSchema)) {
        for (const itemSchema of elementSchema) {
          walk(itemSchema, {
            keyPath: [...options.keyPath, "<INDEX>"],
            jsonPath: options.jsonPath ? `${options.jsonPath}[<INDEX>]` : "[<INDEX>]",
            descriptionHint: description,
          });
        }
      } else {
        walk(elementSchema, {
          keyPath: [...options.keyPath, "<INDEX>"],
          jsonPath: options.jsonPath ? `${options.jsonPath}[<INDEX>]` : "[<INDEX>]",
          descriptionHint: description,
        });
      }
      return;
    }

    if (type === "union" || type === "intersection") {
      if (typeof unwrapped !== "object" || unwrapped === null) return;
      const def = (unwrapped as { _def?: unknown })._def;
      if (typeof def !== "object" || def === null) return;

      if (
        type === "union" &&
        "options" in def &&
        Array.isArray((def as { options: unknown }).options)
      ) {
        for (const option of (def as { options: unknown[] }).options) {
          walk(option, options);
        }
        return;
      }

      if (type === "intersection" && "left" in def && "right" in def) {
        walk((def as { left: unknown }).left, options);
        walk((def as { right: unknown }).right, options);
        return;
      }
    }

    // Leaf
    if (options.keyPath.length === 0) return;

    add({
      envVar: toolHookEnvVarName("XUM_TOOL_INPUT", options.keyPath, { allowPlaceholders: true }),
      jsonPath: options.jsonPath || "(root)",
      type,
      description: description ?? "",
    });
  }

  walk(schema, { keyPath: [], jsonPath: "" });
  return [...entries.values()].sort((a, b) => a.envVar.localeCompare(b.envVar));
}

function generateToolHookEnvVarsBlock(): string {
  const lines: string[] = [];

  const tools = Object.entries(TOOL_DEFINITIONS).sort(([a], [b]) => a.localeCompare(b));

  for (const [toolName, def] of tools) {
    // Skip internal/bespoke tools (e.g. propose_name, propose_status) — users
    // can't write hooks for them, so listing their env vars is misleading.
    if ((def as { internal?: boolean }).internal) continue;
    const vars = collectToolHookEnvVarsFromZodSchema(def.schema);
    if (vars.length === 0) continue;

    lines.push("<details>");
    lines.push(`<summary>${toolName} (${vars.length})</summary>`);
    lines.push("");
    lines.push("| Env var | JSON path | Type | Description |");
    lines.push("| ------ | --------- | ---- | ----------- |");

    for (const v of vars) {
      const envVar = escapeMarkdownTableCodeCell(v.envVar);
      const jsonPath = escapeMarkdownTableCodeCell(v.jsonPath);
      const type = escapeMarkdownTableTextCell(v.type);
      const desc = escapeMarkdownTableTextCell(v.description || "—");

      lines.push(`| \`${envVar}\` | \`${jsonPath}\` | ${type} | ${desc} |`);
    }

    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  return lines.join("\n").trim();
}

async function syncToolHookEnvVars(): Promise<boolean> {
  return syncDoc({
    docsFile: "hooks/tools.mdx",
    sourceLabel: "src/common/utils/tools/toolDefinitions.ts",
    markerName: "TOOL_HOOK_ENV_VARS",
    generateBlock: generateToolHookEnvVarsBlock,
  });
}

// ---------------------------------------------------------------------------
// Auto-cleanup workflow sync
// ---------------------------------------------------------------------------

function generateAutoCleanupWorkflowBlock(): string {
  const workflowPath = path.join(import.meta.dir, "..", ".github", "workflows", "auto-cleanup.yml");
  const content = fs.readFileSync(workflowPath, "utf-8");
  return "```yaml\n" + content.trim() + "\n```";
}

async function syncAutoCleanupWorkflow(): Promise<boolean> {
  return syncDoc({
    docsFile: "guides/github-actions.mdx",
    sourceLabel: ".github/workflows/auto-cleanup.yml",
    markerName: "AUTO_CLEANUP_WORKFLOW",
    generateBlock: generateAutoCleanupWorkflowBlock,
  });
}

// ---------------------------------------------------------------------------
// Deep review skill sync
// ---------------------------------------------------------------------------

function generateDeepReviewSkillBlock(): string {
  const skillPath = path.join(import.meta.dir, "..", ".xum", "skills", "deep-review", "SKILL.md");
  const content = fs.readFileSync(skillPath, "utf-8");
  // Use 5 backticks to wrap the skill content since it may contain nested code blocks with 3 backticks.
  return "`````md\n" + content.trim() + "\n`````";
}

async function syncDeepReviewSkill(): Promise<boolean> {
  return syncDoc({
    docsFile: "agents/agent-skills.mdx",
    sourceLabel: ".xum/skills/deep-review/SKILL.md",
    markerName: "DEEP_REVIEW_SKILL",
    generateBlock: generateDeepReviewSkillBlock,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const results = await Promise.all([
    syncSystemPrompt(),
    syncKnownModels(),
    syncBuiltinAgents(),
    syncCompactionCustomizationDocs(),
    syncNotifyDocs(),
    syncProviderEnvVars(),
    syncToolHookEnvVars(),
    syncAutoCleanupWorkflow(),
    syncDeepReviewSkill(),
  ]);

  if (results.some((r) => !r)) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
