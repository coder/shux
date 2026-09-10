#!/usr/bin/env bun
import assert from "node:assert/strict";
/**
 * Generate built-in agent skills content.
 *
 * Usage:
 *   bun scripts/gen_builtin_skills.ts         # write mode
 *   bun scripts/gen_builtin_skills.ts check   # check mode
 *
 * This script writes:
 *   - src/node/services/agentSkills/builtInSkillContent.generated.ts
 */

import * as fs from "fs";
import * as path from "path";
import * as prettier from "prettier";
import * as yaml from "yaml";

const ARGS = new Set(process.argv.slice(2));
const MODE = ARGS.has("check") ? "check" : "write";
const SYNC_XUM_DOCS_SKILL = ARGS.has("--sync-xum-docs-skill");

const PROJECT_ROOT = path.join(import.meta.dir, "..");
const BUILTIN_SKILLS_DIR = path.join(PROJECT_ROOT, "src", "node", "builtinSkills");
const DOCS_DIR = path.join(PROJECT_ROOT, "docs");
const OUTPUT_PATH = path.join(
  PROJECT_ROOT,
  "src",
  "node",
  "services",
  "agentSkills",
  "builtInSkillContent.generated.ts"
);

function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function readFileLines(filePath: string): string[] {
  return normalizeNewlines(fs.readFileSync(filePath, "utf-8")).split("\n");
}

function oneLine(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function injectBetweenHtmlCommentMarkers(
  content: string,
  markerName: string,
  block: string
): string {
  const beginMarker = `<!-- BEGIN ${markerName} -->`;
  const endMarker = `<!-- END ${markerName} -->`;

  const beginIdx = content.indexOf(beginMarker);
  const endIdx = content.indexOf(endMarker);

  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new Error(`Missing markers for ${markerName}`);
  }

  const before = content.slice(0, beginIdx + beginMarker.length);
  const after = content.slice(endIdx);

  const trimmedBlock = block.trimEnd();
  return `${before}\n${trimmedBlock}\n${after}`;
}

function parseYamlFrontmatter(content: string): Record<string, unknown> | null {
  const normalized = normalizeNewlines(content);
  if (!normalized.startsWith("---\n")) return null;

  const lines = normalized.split("\n");
  const endIndex = lines.findIndex((line, idx) => idx > 0 && line.trim() === "---");
  if (endIndex === -1) return null;

  const yamlText = lines.slice(1, endIndex).join("\n");
  const parsed = yaml.parse(yamlText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function extractDocMeta(content: string): { title?: string; description?: string } {
  const fm = parseYamlFrontmatter(content);
  if (!fm) return {};

  const title = typeof fm.title === "string" ? oneLine(fm.title) : undefined;
  const description = typeof fm.description === "string" ? oneLine(fm.description) : undefined;
  return { title, description };
}

function routeForDocsPage(page: string): string {
  return page === "index" ? "/" : `/${page}`;
}
function posixPath(input: string): string {
  return input.split(path.sep).join(path.posix.sep);
}

function directoryExists(dirPath: string): boolean {
  return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
}

function walkRelativeFiles(rootDir: string): string[] {
  const discovered = new Set<string>();
  const output: string[] = [];

  function walk(currentDir: string): void {
    const entries = fs
      .readdirSync(currentDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      assert(entry.isFile(), `Built-in skill support trees only allow regular files: ${fullPath}`);
      const relPath = posixPath(path.relative(rootDir, fullPath));
      const segments = relPath.split(path.posix.sep);
      assert(relPath !== "", `Built-in skill support file must have a relative path: ${fullPath}`);
      assert(
        !path.posix.isAbsolute(relPath),
        `Built-in skill support file must be relative: ${relPath}`
      );
      assert(!segments.includes(".."), `Path traversal in built-in skill support file: ${relPath}`);
      assert(!discovered.has(relPath), `Duplicate built-in skill support file: ${relPath}`);
      discovered.add(relPath);
      output.push(relPath);
    }
  }

  walk(rootDir);
  return output.sort((a, b) => a.localeCompare(b));
}

function extractDocsPagesFromNav(node: unknown, out: string[], seen: Set<string>): void {
  if (typeof node === "string") {
    if (!seen.has(node)) {
      seen.add(node);
      out.push(node);
    }
    return;
  }

  if (!node || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const item of node) {
      extractDocsPagesFromNav(item, out, seen);
    }
    return;
  }

  const anyNode = node as Record<string, unknown>;
  if (Array.isArray(anyNode.groups)) {
    extractDocsPagesFromNav(anyNode.groups, out, seen);
  }
  if (Array.isArray(anyNode.pages)) {
    extractDocsPagesFromNav(anyNode.pages, out, seen);
  }
}

interface DocsPageInfo {
  page: string;
  route: string;
  referencePath: string;
  title: string;
  description?: string;
}

function renderDocsTreeNode(
  node: unknown,
  indent: number,
  lines: string[],
  pageInfoByPage: Map<string, DocsPageInfo>
): void {
  const prefix = "  ".repeat(indent);

  if (typeof node === "string") {
    const info = pageInfoByPage.get(node);
    if (!info) {
      throw new Error(`Missing docs page info for '${node}'`);
    }

    const suffix = info.description ? `: ${info.description}` : "";
    lines.push(`${prefix}- ${info.title} (\`${info.route}\`) → \`${info.referencePath}\`${suffix}`);
    return;
  }

  if (!node || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const item of node) {
      renderDocsTreeNode(item, indent, lines, pageInfoByPage);
    }
    return;
  }

  const anyNode = node as Record<string, unknown>;

  if (typeof anyNode.tab === "string" && Array.isArray(anyNode.groups)) {
    lines.push(`${prefix}- **${anyNode.tab}**`);
    renderDocsTreeNode(anyNode.groups, indent + 1, lines, pageInfoByPage);
    return;
  }

  if (typeof anyNode.group === "string" && Array.isArray(anyNode.pages)) {
    lines.push(`${prefix}- **${anyNode.group}**`);
    renderDocsTreeNode(anyNode.pages, indent + 1, lines, pageInfoByPage);
    return;
  }

  // Fallback: recurse into known containers.
  if (Array.isArray(anyNode.groups)) {
    renderDocsTreeNode(anyNode.groups, indent, lines, pageInfoByPage);
  }
  if (Array.isArray(anyNode.pages)) {
    renderDocsTreeNode(anyNode.pages, indent, lines, pageInfoByPage);
  }
}

function renderDocsTree(docsJson: unknown, pageInfoByPage: Map<string, DocsPageInfo>): string {
  const tabs = (docsJson as any)?.navigation?.tabs;
  if (!Array.isArray(tabs)) {
    throw new Error("docs/docs.json: expected navigation.tabs array");
  }

  const lines: string[] = [];
  for (const tab of tabs) {
    renderDocsTreeNode(tab, 0, lines, pageInfoByPage);
  }

  return lines.join("\n");
}
function extractDocsPages(docsJson: unknown): string[] {
  const tabs = (docsJson as any)?.navigation?.tabs;
  if (!Array.isArray(tabs)) {
    throw new Error("docs/docs.json: expected navigation.tabs array");
  }

  const pages: string[] = [];
  const seen = new Set<string>();
  for (const tab of tabs) {
    extractDocsPagesFromNav((tab as any)?.groups, pages, seen);
  }
  return pages;
}

function resolveDocsPageFilePath(page: string): string {
  function pathExistsWithExactCase(baseDir: string, relativePath: string): boolean {
    // macOS and Windows filesystems are commonly case-insensitive. `fs.existsSync()` will return
    // true even when the requested path casing does not match what's actually on disk.
    //
    // This matters for xum docs generation because the docs tree is indexed by exact page IDs
    // (e.g. "agents" vs "AGENTS"). If we accept case-insensitive matches, we can accidentally
    // resolve the wrong file (and produce platform-dependent output).
    let current = baseDir;
    const parts = relativePath.split(path.sep).filter(Boolean);

    for (const part of parts) {
      const entries = fs.readdirSync(current);
      if (!entries.includes(part)) {
        return false;
      }
      current = path.join(current, part);
    }

    return true;
  }

  const candidates = [
    path.join(DOCS_DIR, `${page}.mdx`),
    path.join(DOCS_DIR, `${page}.md`),
    path.join(DOCS_DIR, page, "index.mdx"),
    path.join(DOCS_DIR, page, "index.md"),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;

    const rel = path.relative(DOCS_DIR, candidate);
    if (pathExistsWithExactCase(DOCS_DIR, rel)) {
      return candidate;
    }
  }

  throw new Error(`docs/docs.json references '${page}' but no file found under docs/`);
}

interface GenerateResult {
  output: string;
  xumDocsSkillWasUpdated: boolean;
  xumDocsSkillOutOfSync: boolean;
}
function renderJoinedLines(lines: string[], indent: string): string {
  const innerIndent = indent + "  ";
  const rendered = lines.map((line) => `${innerIndent}${JSON.stringify(line)},`).join("\n");
  return `[\n${rendered}\n${indent}].join(\"\\n\")`;
}

function generate(): GenerateResult {
  const skills = fs
    .readdirSync(BUILTIN_SKILLS_DIR)
    .filter((entry) => entry.endsWith(".md"))
    .sort((a, b) => a.localeCompare(b));

  const fileMaps: Record<string, Record<string, string[]>> = {};

  let xumDocsSkillWasUpdated = false;
  let xumDocsSkillOutOfSync = false;

  for (const filename of skills) {
    const skillName = filename.slice(0, -3);
    const skillPath = path.join(BUILTIN_SKILLS_DIR, filename);

    const skillContent = normalizeNewlines(fs.readFileSync(skillPath, "utf-8"));

    const files: Record<string, string[]> = {
      "SKILL.md": skillContent.split("\n"),
    };

    const supportDir = path.join(BUILTIN_SKILLS_DIR, skillName);
    if (directoryExists(supportDir)) {
      assert(
        skillName !== "xum-docs",
        "xum-docs embeds docs via special handling; do not add src/node/builtinSkills/xum-docs/"
      );

      for (const relPath of walkRelativeFiles(supportDir)) {
        assert(!(relPath in files), `Duplicate path in built-in skill '${skillName}': ${relPath}`);
        const supportFilePath = path.join(supportDir, relPath);
        files[relPath] = readFileLines(supportFilePath);
      }
    }

    // xum-docs: embed docs site content as progressive-disclosure reference files.
    if (skillName === "xum-docs") {
      const docsConfigPath = path.join(DOCS_DIR, "docs.json");
      const docsConfigRaw = fs.readFileSync(docsConfigPath, "utf-8");
      files["references/docs/docs.json"] = readFileLines(docsConfigPath);

      const docsConfig = JSON.parse(docsConfigRaw);
      const pages = extractDocsPages(docsConfig);

      const pageInfoByPage = new Map<string, DocsPageInfo>();

      for (const page of pages) {
        const resolvedPath = resolveDocsPageFilePath(page);
        const rel = posixPath(path.relative(DOCS_DIR, resolvedPath));
        const key = `references/docs/${rel}`;

        const docLines = readFileLines(resolvedPath);
        files[key] = docLines;

        const meta = extractDocMeta(docLines.join("\n"));
        pageInfoByPage.set(page, {
          page,
          route: routeForDocsPage(page),
          referencePath: key,
          title: meta.title ?? page,
          description: meta.description,
        });
      }

      const docsTree = renderDocsTree(docsConfig, pageInfoByPage);
      const updatedSkillContent = injectBetweenHtmlCommentMarkers(
        skillContent,
        "DOCS_TREE",
        docsTree
      );
      files["SKILL.md"] = updatedSkillContent.split("\n");

      if (SYNC_XUM_DOCS_SKILL && updatedSkillContent !== skillContent) {
        if (MODE === "check") {
          xumDocsSkillOutOfSync = true;
        } else {
          fs.writeFileSync(skillPath, updatedSkillContent, "utf-8");
          xumDocsSkillWasUpdated = true;
        }
      }
    }

    fileMaps[skillName] = files;
  }

  let output = "";
  output += "// AUTO-GENERATED - DO NOT EDIT\n";
  output += "// Run: bun scripts/gen_builtin_skills.ts\n";
  output += "// Source: src/node/builtinSkills/ and docs/\n\n";
  output += "export const BUILTIN_SKILL_FILES: Record<string, Record<string, string>> = {\n";

  const sortedSkillNames = Object.keys(fileMaps).sort((a, b) => a.localeCompare(b));
  for (const skillName of sortedSkillNames) {
    output += `  ${JSON.stringify(skillName)}: {\n`;
    const files = fileMaps[skillName] ?? {};
    for (const filePath of Object.keys(files).sort((a, b) => a.localeCompare(b))) {
      output += `    ${JSON.stringify(filePath)}: ${renderJoinedLines(files[filePath]!, "    ")},\n`;
    }
    output += "  },\n";
  }

  output += "};\n";

  return { output, xumDocsSkillWasUpdated, xumDocsSkillOutOfSync };
}

async function main(): Promise<void> {
  const { output: raw, xumDocsSkillWasUpdated, xumDocsSkillOutOfSync } = generate();

  const prettierConfig = await prettier.resolveConfig(OUTPUT_PATH);
  const formatted = await prettier.format(raw, {
    ...prettierConfig,
    filepath: OUTPUT_PATH,
  });

  const current = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, "utf-8") : null;
  const outputOutOfSync = current !== formatted;

  const xumDocsSkillPath = path.join(BUILTIN_SKILLS_DIR, "xum-docs.md");

  if (MODE === "check") {
    if (!outputOutOfSync && !xumDocsSkillOutOfSync) {
      console.log(`✓ ${path.relative(PROJECT_ROOT, OUTPUT_PATH)} is up-to-date`);
      return;
    }

    if (xumDocsSkillOutOfSync) {
      console.error(`✗ ${path.relative(PROJECT_ROOT, xumDocsSkillPath)} is out of sync`);
    }

    if (outputOutOfSync) {
      console.error(`✗ ${path.relative(PROJECT_ROOT, OUTPUT_PATH)} is out of sync`);
    }

    console.error("  Run 'make fmt' to regenerate.");
    process.exit(1);
  }

  if (outputOutOfSync) {
    fs.writeFileSync(OUTPUT_PATH, formatted, "utf-8");
    console.log(`✓ Updated ${path.relative(PROJECT_ROOT, OUTPUT_PATH)}`);
  } else {
    console.log(`✓ ${path.relative(PROJECT_ROOT, OUTPUT_PATH)} is up-to-date`);
  }

  if (xumDocsSkillWasUpdated) {
    console.log(`✓ Updated ${path.relative(PROJECT_ROOT, xumDocsSkillPath)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
