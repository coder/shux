/**
 * Agent Plugins 1.0.0 manifest (`plugin.json`) validation.
 *
 * Implements §5 of the Agent Plugins specification (https://agent-plugins.org,
 * spec repo: agentplugins/agent-plugins-spec) against the canonical
 * plugin.schema.json:
 * - Closed top-level schema, but unknown top-level fields are NON-fatal:
 *   report + ignore (§5.3).
 * - `$schema` (required) dispatches the spec version; anything other than the
 *   recognized 1.0.0 const is rejected with the distinct "unsupported-version"
 *   reason so clients can report it separately from malformed manifests.
 * - `name` (required): 1-64 chars, lowercase alphanumeric/dot/hyphen,
 *   alphanumeric start/end, no `--` or `..` runs.
 * - Any other schema violation (wrong-typed permitted field) is fatal.
 * - `extensions`: a non-object value is NON-fatal (report + ignore); namespace
 *   member contents are never validated (§8.1/§11.1) — Xum implements no
 *   extension namespace, so all payloads are treated as opaque.
 * - `contributes` (Mux extension, not part of the 1.0.0 spec schema): declares
 *   the plugin's component contributions. Every malformed member is NON-fatal
 *   (report + ignore) so a spec-valid plugin never breaks on a Mux extension,
 *   and older Mux versions simply report `contributes` as an unknown field.
 */

/** Canonical `$schema` const for Agent Plugins 1.0.0 plugin manifests. */
export const AGENT_PLUGIN_SCHEMA_ID_1_0_0 =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

// Name grammar shared with the install registry schema (see the module's doc comment).
import { isValidAgentPluginName } from "@/common/utils/agentPluginName";

export { isValidAgentPluginName };

export interface AgentPluginAuthor {
  name?: string;
  email?: string;
  url?: string;
}

/** Command-name grammar shared with skill names (kebab-case, 1-64 chars). */
const SLASH_COMMAND_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLASH_COMMAND_NAME_MAX_LENGTH = 64;
// Expansions become chat-input text; bound them so one manifest cannot inject
// unbounded content into the composer.
const SLASH_COMMAND_EXPANSION_MAX_LENGTH = 16_384;

export interface AgentPluginSlashCommandContribution {
  name: string;
  description?: string;
  /** Replacement text inserted when the command is invoked (data-driven expansion template). */
  expansion: string;
}

/**
 * Mux `contributes` block: path members override the conventional component
 * locations (skills/, mcp.json, agents/, workflows/, hooks.js) with a safe
 * relative path inside the plugin root; `slashCommands` declares data-driven
 * chat commands that have no on-disk convention.
 */
export interface AgentPluginContributes {
  skills?: string;
  mcp?: string;
  agents?: string;
  workflows?: string;
  hooks?: string;
  slashCommands?: AgentPluginSlashCommandContribution[];
}

const CONTRIBUTES_PATH_KEYS = ["skills", "mcp", "agents", "workflows", "hooks"] as const;
const CONTRIBUTES_KEYS = new Set<string>([...CONTRIBUTES_PATH_KEYS, "slashCommands"]);

/**
 * A contributes path must stay a plain relative path. Realpath containment is
 * enforced again at discovery time; rejecting obvious escapes here yields
 * clearer manifest-level warnings.
 */
function isSafeContributesPath(value: string): boolean {
  if (value.length === 0 || value.includes("\0")) {
    return false;
  }
  if (/^[/\\]/.test(value) || /^[a-zA-Z]:/.test(value) || value.startsWith("~")) {
    return false;
  }
  const segments = value.replaceAll("\\", "/").split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "..");
}

function parseSlashCommandContributions(
  raw: unknown,
  warnings: string[]
): AgentPluginSlashCommandContribution[] | undefined {
  if (!Array.isArray(raw)) {
    warnings.push("'contributes.slashCommands' must be an array; ignoring");
    return undefined;
  }

  const commands: AgentPluginSlashCommandContribution[] = [];
  const seenNames = new Set<string>();
  for (const entry of raw) {
    if (!isPlainObject(entry)) {
      warnings.push("'contributes.slashCommands' entries must be objects; ignoring an entry");
      continue;
    }
    const { name, description, expansion } = entry;
    if (
      typeof name !== "string" ||
      name.length > SLASH_COMMAND_NAME_MAX_LENGTH ||
      !SLASH_COMMAND_NAME_PATTERN.test(name)
    ) {
      warnings.push(
        "'contributes.slashCommands[].name' must be 1-64 kebab-case characters; ignoring an entry"
      );
      continue;
    }
    if (
      typeof expansion !== "string" ||
      expansion.trim().length === 0 ||
      expansion.length > SLASH_COMMAND_EXPANSION_MAX_LENGTH
    ) {
      warnings.push(
        `'contributes.slashCommands[].expansion' for '${name}' must be a non-empty string (max ${SLASH_COMMAND_EXPANSION_MAX_LENGTH} chars); ignoring the entry`
      );
      continue;
    }
    if (description !== undefined && typeof description !== "string") {
      warnings.push(
        `'contributes.slashCommands[].description' for '${name}' must be a string; ignoring the entry`
      );
      continue;
    }
    if (seenNames.has(name)) {
      warnings.push(`Duplicate contributed slash command '${name}'; first declaration wins`);
      continue;
    }
    seenNames.add(name);
    commands.push({
      name,
      expansion,
      ...(description !== undefined ? { description } : {}),
    });
  }

  return commands;
}

function parseContributes(raw: unknown, warnings: string[]): AgentPluginContributes | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isPlainObject(raw)) {
    warnings.push("'contributes' must be an object; ignoring");
    return undefined;
  }

  const contributes: AgentPluginContributes = {};

  for (const key of Object.keys(raw)) {
    if (!CONTRIBUTES_KEYS.has(key)) {
      warnings.push(`Unknown 'contributes.${key}' member ignored`);
    }
  }

  for (const key of CONTRIBUTES_PATH_KEYS) {
    const value = raw[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "string" || !isSafeContributesPath(value)) {
      warnings.push(
        `'contributes.${key}' must be a relative path inside the plugin; ignoring (using the default location)`
      );
      continue;
    }
    contributes[key] = value;
  }

  if (raw.slashCommands !== undefined) {
    const commands = parseSlashCommandContributions(raw.slashCommands, warnings);
    if (commands !== undefined) {
      contributes.slashCommands = commands;
    }
  }

  return contributes;
}

export interface AgentPluginManifest {
  /** The accepted `$schema` value (identifies the spec version). */
  schemaId: string;
  name: string;
  version?: string;
  description?: string;
  author?: AgentPluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  /** Opaque §8 extension namespaces. Contents are never validated here; Mux
   * consumers (e.g. plugin hook capability requests under `extensions.mux`)
   * interpret their own namespace defensively. */
  extensions?: Record<string, unknown>;
  /** Mux extension: declarative component contributions (see module docs). */
  contributes?: AgentPluginContributes;
}

export type PluginManifestValidation =
  | { ok: true; manifest: AgentPluginManifest; warnings: string[] }
  | { ok: false; reason: "unsupported-version" | "invalid-manifest"; errors: string[] };

const PERMITTED_TOP_LEVEL_KEYS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
  "contributes",
]);

const OPTIONAL_STRING_FIELDS = [
  "version",
  "description",
  "homepage",
  "repository",
  "license",
] as const;

const AUTHOR_KEYS = ["name", "email", "url"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validatePluginManifest(raw: unknown): PluginManifestValidation {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      reason: "invalid-manifest",
      errors: ["plugin.json must be a JSON object"],
    };
  }

  const warnings: string[] = [];
  const errors: string[] = [];

  // §5.3: unknown top-level fields are ignored with a report, not fatal.
  for (const key of Object.keys(raw)) {
    if (!PERMITTED_TOP_LEVEL_KEYS.has(key)) {
      warnings.push(`Unknown top-level field '${key}' ignored`);
    }
  }

  const schemaId = raw.$schema;
  if (typeof schemaId !== "string") {
    return {
      ok: false,
      reason: "invalid-manifest",
      errors: ["'$schema' is required and must be a string"],
    };
  }
  if (schemaId !== AGENT_PLUGIN_SCHEMA_ID_1_0_0) {
    // Distinct reason so callers can report "newer/unknown spec version" separately.
    return {
      ok: false,
      reason: "unsupported-version",
      errors: [`Unsupported Agent Plugins '$schema': '${schemaId}'`],
    };
  }

  const name = raw.name;
  if (typeof name !== "string" || !isValidAgentPluginName(name)) {
    errors.push(
      "'name' is required and must be 1-64 characters of lowercase [a-z0-9.-], starting/ending alphanumeric, without '--' or '..'"
    );
  }

  for (const field of OPTIONAL_STRING_FIELDS) {
    const value = raw[field];
    if (value !== undefined && typeof value !== "string") {
      errors.push(`'${field}' must be a string`);
    }
  }

  const keywords = raw.keywords;
  if (
    keywords !== undefined &&
    (!Array.isArray(keywords) || keywords.some((keyword) => typeof keyword !== "string"))
  ) {
    errors.push("'keywords' must be an array of strings");
  }

  let author: AgentPluginAuthor | undefined;
  if (raw.author !== undefined) {
    if (!isPlainObject(raw.author)) {
      errors.push("'author' must be an object");
    } else {
      // Canonical schema closes the author object (additionalProperties: false).
      const authorRecord = raw.author;
      const authorErrors: string[] = [];
      for (const key of Object.keys(authorRecord)) {
        if (!AUTHOR_KEYS.includes(key as (typeof AUTHOR_KEYS)[number])) {
          authorErrors.push(`'author.${key}' is not a permitted field`);
        }
      }
      for (const key of AUTHOR_KEYS) {
        const value = authorRecord[key];
        if (value !== undefined && typeof value !== "string") {
          authorErrors.push(`'author.${key}' must be a string`);
        }
      }

      if (authorErrors.length > 0) {
        errors.push(...authorErrors);
      } else {
        author = {
          ...(typeof authorRecord.name === "string" ? { name: authorRecord.name } : {}),
          ...(typeof authorRecord.email === "string" ? { email: authorRecord.email } : {}),
          ...(typeof authorRecord.url === "string" ? { url: authorRecord.url } : {}),
        };
      }
    }
  }

  // §8.1/§11.1: a non-object `extensions` value is reported and ignored; object
  // contents are opaque and never validated (do not enforce the JSON Schema's
  // per-namespace member typing here).
  if (raw.extensions !== undefined && !isPlainObject(raw.extensions)) {
    warnings.push("'extensions' must be an object; ignoring");
  }

  // Mux extension: malformed contributes members warn + fall back to defaults,
  // never invalidating an otherwise spec-valid manifest.
  const contributes = parseContributes(raw.contributes, warnings);

  if (errors.length > 0) {
    return { ok: false, reason: "invalid-manifest", errors };
  }

  // Narrowing: `name` passed validation above or we'd have returned errors.
  if (typeof name !== "string") {
    throw new Error("validatePluginManifest: name must be a string after validation");
  }

  const manifest: AgentPluginManifest = {
    schemaId,
    name,
    ...(typeof raw.version === "string" ? { version: raw.version } : {}),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(typeof raw.homepage === "string" ? { homepage: raw.homepage } : {}),
    ...(typeof raw.repository === "string" ? { repository: raw.repository } : {}),
    ...(typeof raw.license === "string" ? { license: raw.license } : {}),
    ...(Array.isArray(keywords)
      ? { keywords: keywords.filter((k): k is string => typeof k === "string") }
      : {}),
    ...(isPlainObject(raw.extensions) ? { extensions: raw.extensions } : {}),
    ...(contributes !== undefined ? { contributes } : {}),
  };

  return { ok: true, manifest, warnings };
}
