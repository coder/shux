/**
 * Tool search catalog (tool-search experiment, Phase 1).
 *
 * Client-side deferred MCP tool loading: MCP tool schemas stay out of the
 * model-visible tool list until the model discovers them via the `tool_catalog_search`
 * tool. All tools remain in the `tools:` record passed to streamText; the AI
 * SDK's `prepareStep` → `activeTools` mechanism only scopes what is advertised
 * to the model on each step, so this works with every provider.
 *
 * Everything in this module is pure and deterministic (no I/O) so the gating
 * matrix, scoring, and activation semantics are unit-testable without mocking
 * aiService or streamText.
 */

import type {
  AssistantModelMessage,
  Tool,
  ToolCallPart,
  ToolModelMessage,
  ToolResultPart,
} from "ai";
import type { ModelMessage, MuxMessage } from "@/common/types/message";
import { buildRequiredToolPatterns, type ToolPolicy } from "@/common/utils/tools/toolPolicy";

export const TOOL_SEARCH_TOOL_NAME = "tool_catalog_search";
export const LEGACY_TOOL_SEARCH_TOOL_NAME = "tool_search";

/** Default / max number of matches returned by a tool_catalog_search call. */
export const TOOL_SEARCH_DEFAULT_LIMIT = 10;
export const TOOL_SEARCH_MAX_LIMIT = 25;

export interface ToolCatalogEntry {
  name: string;
  description: string;
  /** Flattened input-parameter names + descriptions used for scoring only. */
  paramText: string;
  /** MCP server that provides this tool, when known (used for the catalog overview + scoring). */
  serverName?: string;
}

/**
 * Per-stream mutable tool-search state. Created by aiService after policy
 * filtering, mutated by `tool_catalog_search.execute` (activations) and by the
 * model-fallback rebuild, and read by StreamManager's prepareStep. The object
 * identity must be stable for the lifetime of the stream — mutate in place,
 * never replace.
 */
export interface ToolSearchStreamState {
  /** Catalog entries for deferred tools only. */
  catalog: ToolCatalogEntry[];
  deferredToolNames: Set<string>;
  /** Final post-policy tool record keys (core + deferred). */
  allToolNames: string[];
  /** Deferred tools discovered via tool_catalog_search (or prior-turn history). */
  activatedToolNames: Set<string>;
}

/**
 * Per-send runtime holder shared between tool creation (getToolsForModel) and
 * stream wiring. `state` is only assigned after the post-policy gate decides
 * the feature is active (mirrors the advisorRuntime mutable-ref precedent).
 */
export interface ToolSearchRuntime {
  state?: ToolSearchStreamState;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMuxToolSearchName(toolName: string): boolean {
  return toolName === TOOL_SEARCH_TOOL_NAME || toolName === LEGACY_TOOL_SEARCH_TOOL_NAME;
}

/**
 * Extract a flat scoring string from a tool's input schema. MCP tools carry
 * `jsonSchema()`-wrapped JSON schemas (a `Schema` object with a `jsonSchema`
 * property); on any unexpected shape we fall back to an empty string and score
 * on name + description only.
 */
function extractParamText(tool: Tool): string {
  const schema: unknown = tool.inputSchema;
  if (!isPlainRecord(schema)) {
    return "";
  }
  const jsonSchema = schema.jsonSchema;
  if (!isPlainRecord(jsonSchema)) {
    return "";
  }
  const properties = jsonSchema.properties;
  if (!isPlainRecord(properties)) {
    return "";
  }
  const parts: string[] = [];
  for (const [paramName, paramSchema] of Object.entries(properties)) {
    parts.push(paramName);
    if (isPlainRecord(paramSchema) && typeof paramSchema.description === "string") {
      parts.push(paramSchema.description);
    }
  }
  return parts.join(" ");
}

interface ToolCatalogInputs {
  /** Final post-policy tool record (policy-disabled tools already absent). */
  tools: Record<string, Tool>;
  /** All MCP tool names for this workspace (pre-policy; classified by intersection). */
  mcpToolNames: readonly string[];
  toolPolicy?: ToolPolicy;
  /**
   * Provider-safe MCP tool name → originating server name. Used to group the
   * deferred-catalog overview by server and to score server-name matches.
   */
  mcpToolServers?: Readonly<Record<string, string>>;
  /**
   * Whether PTC (programmatic tool calling) is enabled, i.e. the record's
   * `code_execution` entry is the PTC tool rather than a same-named MCP tool.
   * Presence-sniffing the record is not enough: an MCP server/tool pair can
   * normalize to `code_execution` without PTC being active.
   */
  ptcEnabled?: boolean;
}

interface ToolCatalogClassification {
  catalog: ToolCatalogEntry[];
  deferredToolNames: Set<string>;
  allToolNames: string[];
}

/**
 * Classify the final post-policy tool record into core vs deferred tools.
 *
 * Phase 1 policy: only MCP tools are deferred. Deferred = record keys ∩ MCP
 * names, minus names matched by a policy `require` rule (required tools must
 * stay advertised so the model can satisfy the requirement), minus
 * `tool_catalog_search` itself. Intersection semantics absorb policy-disable and
 * PTC-exclusive removals: absent tools never enter the catalog.
 */
export function buildToolCatalog(inputs: ToolCatalogInputs): ToolCatalogClassification {
  const mcpNameSet = new Set(inputs.mcpToolNames);
  const requiredPatterns = buildRequiredToolPatterns(inputs.toolPolicy);
  const allToolNames = Object.keys(inputs.tools);

  const catalog: ToolCatalogEntry[] = [];
  const deferredToolNames = new Set<string>();
  for (const [name, tool] of Object.entries(inputs.tools)) {
    if (!mcpNameSet.has(name) || name === TOOL_SEARCH_TOOL_NAME) {
      continue;
    }
    if (requiredPatterns.some((pattern) => pattern.test(name))) {
      continue;
    }
    deferredToolNames.add(name);
    catalog.push({
      name,
      description: typeof tool.description === "string" ? tool.description : "",
      paramText: extractParamText(tool),
      serverName: inputs.mcpToolServers?.[name],
    });
  }

  return { catalog, deferredToolNames, allToolNames };
}

/** Max tool names listed per server in the catalog overview before eliding. */
const OVERVIEW_MAX_TOOLS_PER_SERVER = 8;

/**
 * Server labels are unbounded user-config map keys; clamp them so a single
 * pathological name cannot bloat the overview. Display-only — grouping still
 * uses the full server name.
 */
const OVERVIEW_MAX_SERVER_LABEL_CHARS = 64;

/**
 * Overall character budget for the generated overview. Tool names are capped
 * at 64 chars by provider rules and per-server lines are capped above, but the
 * number of servers is unbounded — without a total budget a large MCP config
 * could blow up the tool schema / provider request size. Servers beyond the
 * budget collapse into an omitted-count line pointing at search.
 */
const OVERVIEW_MAX_CHARS = 2000;

/**
 * Header marking the generated overview inside tool_catalog_search's
 * description. Also used to strip a previously appended overview so repeated
 * prepareToolSearch calls (post-hook / model-fallback rebuilds receive the
 * already-augmented tool as input) stay idempotent instead of stacking copies.
 */
const OVERVIEW_HEADER = "Deferred tool catalog overview (search to activate):";

/**
 * Explicit terminator for the generated overview block. Stripping removes
 * exactly the marker-delimited region, so arbitrary hook text — including
 * bullet lines a request.assemble middleware appends after the overview —
 * survives re-preparation. Content-shape heuristics (e.g. "consume contiguous
 * bullets") cannot distinguish generated bullets from hook-appended ones.
 */
const OVERVIEW_END_MARKER = "(end of deferred tool catalog overview)";

/** Separator emitted between the base description and the generated block. */
const OVERVIEW_SEPARATOR = "\n\n";

/**
 * Server names are arbitrary user-config map keys. Scrub reserved marker text
 * so a label can neither terminate nor forge the generated block (which would
 * break marker-based stripping and re-stack overviews on rebuilds), and
 * flatten newlines so one label cannot fabricate extra overview lines. Tool
 * names need no scrubbing: buildMcpToolName enforces provider-safe
 * `[a-zA-Z0-9_-]` names that cannot contain marker text.
 *
 * Scrubbing loops to a fixpoint: a single deletion pass can itself synthesize
 * a marker by joining fragments (e.g. "(end of deferred " + HEADER + "tool
 * catalog overview)" becomes the end marker once the embedded header is
 * removed). Each pass strictly shortens the string, so the loop terminates.
 */
function sanitizeServerLabel(label: string): string {
  let sanitized = label.replace(/[\r\n]+/g, " ");
  while (sanitized.includes(OVERVIEW_END_MARKER) || sanitized.includes(OVERVIEW_HEADER)) {
    sanitized = sanitized.split(OVERVIEW_END_MARKER).join("").split(OVERVIEW_HEADER).join("");
  }
  return sanitized;
}

/**
 * Pre-scrub input clamp. The fixpoint scrub is quadratic in the worst case
 * (recursively nested markers force one full rescan per nesting level), so it
 * must only ever run on a bounded prefix — a multi-hundred-KB adversarial key
 * would otherwise stall tool preparation synchronously. 512 chars leaves ample
 * room for the scrub to delete embedded markers and still fill the 64-char
 * display label; clamping can leave a partial marker at the cut, which is
 * harmless because stripping matches only complete markers.
 */
const OVERVIEW_LABEL_SCRUB_INPUT_CHARS = 512;

/**
 * Bounded, sanitized display form of a server name for model-facing output
 * (overview lines and search-result serverName fields). The full name is kept
 * internally for grouping and scoring only — anything sent to the model must
 * be bounded, since a long name repeated across up to 25 search matches could
 * inflate the tool result past provider limits.
 */
function displayServerLabel(server: string): string {
  const wasClamped = server.length > OVERVIEW_LABEL_SCRUB_INPUT_CHARS;
  const sanitized = sanitizeServerLabel(
    wasClamped ? server.slice(0, OVERVIEW_LABEL_SCRUB_INPUT_CHARS) : server
  );
  if (wasClamped || sanitized.length > OVERVIEW_MAX_SERVER_LABEL_CHARS) {
    return `${sanitized.slice(0, OVERVIEW_MAX_SERVER_LABEL_CHARS - 1)}…`;
  }
  return sanitized;
}

/**
 * Remove a previously appended catalog overview from a description, if any.
 * Removes exactly the marker-delimited generated region plus the separator we
 * emitted before it — nothing else. Hook-authored content outside the region
 * (including whitespace-sensitive Markdown such as indented blocks) is
 * preserved verbatim: no trimming.
 */
function stripToolCatalogOverview(description: string): string {
  const start = description.indexOf(OVERVIEW_HEADER);
  if (start === -1) {
    return description;
  }
  const endMarker = description.indexOf(OVERVIEW_END_MARKER, start);
  // The end marker is always emitted with the header; if a hook removed it,
  // leave the description untouched rather than guessing at block boundaries.
  if (endMarker === -1) {
    return description;
  }
  const separatorStart = start - OVERVIEW_SEPARATOR.length;
  const regionStart =
    separatorStart >= 0 && description.slice(separatorStart, start) === OVERVIEW_SEPARATOR
      ? separatorStart
      : start;
  const regionEnd = endMarker + OVERVIEW_END_MARKER.length;
  return description.slice(0, regionStart) + description.slice(regionEnd);
}

/**
 * Build a compact, deterministic index of the deferred catalog grouped by MCP
 * server, e.g. `- github (12 tools): github_create_issue, … (+4 more)`.
 * Only names are listed — descriptions and parameter schemas stay deferred
 * until activation, so the overview solves the "unknown unknowns" discovery
 * problem without reintroducing schema token bloat. Returns "" for an empty
 * catalog.
 */
export function buildToolCatalogOverview(catalog: readonly ToolCatalogEntry[]): string {
  if (catalog.length === 0) {
    return "";
  }
  const byServer = new Map<string, string[]>();
  for (const entry of catalog) {
    const server = entry.serverName ?? "other tools";
    const names = byServer.get(server) ?? [];
    names.push(entry.name);
    byServer.set(server, names);
  }
  const servers = [...byServer.entries()].sort(([a], [b]) => a.localeCompare(b));
  const lines: string[] = [];
  let usedChars = OVERVIEW_HEADER.length + OVERVIEW_END_MARKER.length;
  let omittedServers = 0;
  for (const [server, names] of servers) {
    // Once over budget, stop emitting lines and just count omitted servers.
    if (omittedServers > 0) {
      omittedServers += 1;
      continue;
    }
    const label = displayServerLabel(server);
    names.sort((a, b) => a.localeCompare(b));
    const shown = names.slice(0, OVERVIEW_MAX_TOOLS_PER_SERVER);
    const extra = names.length - shown.length;
    const suffix = extra > 0 ? ` (+${extra} more)` : "";
    const line = `- ${label} (${names.length} tool${names.length === 1 ? "" : "s"}): ${shown.join(", ")}${suffix}`;
    if (usedChars + line.length + 1 > OVERVIEW_MAX_CHARS) {
      omittedServers = 1;
      continue;
    }
    usedChars += line.length + 1;
    lines.push(line);
  }
  if (omittedServers > 0) {
    lines.push(
      `- …and ${omittedServers} more server${omittedServers === 1 ? "" : "s"} (use this tool to discover their tools)`
    );
  }
  return `${OVERVIEW_HEADER}\n${lines.join("\n")}\n${OVERVIEW_END_MARKER}`;
}

/**
 * Post-policy gate: decides whether tool-search deferral is active for this
 * stream and returns the (possibly adjusted) tool record plus the seed state.
 *
 * - An MCP tool name collides with `tool_catalog_search` (e.g. server "tool" + tool
 *   "search" normalize to "tool_catalog_search"): the MCP spread overwrites the
 *   built-in search tool in the merged record, so deferring would leave MCP
 *   tools unreachable with no working search tool ⇒ safe fallback: no state,
 *   tools unchanged — the colliding entry behaves as a normal MCP tool.
 * - PTC enabled (`ptcEnabled`, non-exclusive programmatic tool calling): its
 *   `code_execution` bridge already embeds/exposes MCP tools, bypassing
 *   activeTools ⇒ drop `tool_catalog_search`, no state. MCP tools stay advertised as
 *   without deferral. (Exclusive mode removes MCP tools from the record, so
 *   the empty-catalog branch deactivates it anyway.)
 * - `tool_catalog_search` absent (policy-disabled) ⇒ safe fallback: no state, tools
 *   unchanged — MCP tools stay advertised exactly as without the experiment.
 * - Nothing deferred (all MCP tools policy-disabled / PTC-removed) ⇒ drop
 *   `tool_catalog_search` from the record (a search tool with an empty catalog is
 *   noise) and return no state.
 * - Otherwise ⇒ tools unchanged plus a fresh state with an empty activation
 *   set (callers seed prior-turn activations via
 *   `seedToolSearchActivationsFromMessages`).
 */
export function prepareToolSearch(inputs: ToolCatalogInputs): {
  tools: Record<string, Tool>;
  state?: ToolSearchStreamState;
} {
  // Collision check must run before the empty-catalog branch below: when the
  // record's `tool_catalog_search` entry is actually an MCP tool, dropping it would
  // silently remove a legitimate MCP tool.
  if (inputs.mcpToolNames.includes(TOOL_SEARCH_TOOL_NAME)) {
    return { tools: inputs.tools };
  }
  if (!(TOOL_SEARCH_TOOL_NAME in inputs.tools)) {
    return { tools: inputs.tools };
  }
  // PTC's code_execution embeds ToolBridge TypeScript definitions for every
  // bridged MCP tool in its description and exposes them as callable `mux.*`
  // functions, so activeTools scoping could neither reduce context nor gate
  // access. Deferral would be ineffective and silently bypassable ⇒ drop
  // tool_catalog_search and run without deferral when both experiments are enabled.
  // Gated on the actual PTC flag, not record presence: a `code_execution`
  // record entry may be a same-named MCP tool (classified as normal deferred).
  if (inputs.ptcEnabled === true) {
    const { [TOOL_SEARCH_TOOL_NAME]: _removed, ...rest } = inputs.tools;
    return { tools: rest };
  }
  const classification = buildToolCatalog(inputs);
  if (classification.deferredToolNames.size === 0) {
    const { [TOOL_SEARCH_TOOL_NAME]: _removed, ...rest } = inputs.tools;
    return { tools: rest };
  }
  // Advertise the deferred surface area up front: append a compact per-server
  // index of deferred tool names to tool_catalog_search's description so the
  // model knows what capabilities exist to search for ("unknown unknowns"),
  // while full descriptions/schemas stay deferred until activation.
  const overview = buildToolCatalogOverview(classification.catalog);
  const searchTool = inputs.tools[TOOL_SEARCH_TOOL_NAME];
  // Strip any overview appended by an earlier prepareToolSearch call: rebuild
  // paths (assembly hooks, model fallback) pass the augmented tool back in, and
  // blindly appending again would send the whole catalog overview twice.
  const baseDescription = stripToolCatalogOverview(
    typeof searchTool.description === "string" ? searchTool.description : ""
  );
  // Object.assign (not spread) keeps the `Tool` union type intact while
  // overriding only the description on a shallow copy.
  const augmentedSearchTool: Tool = Object.assign({}, searchTool, {
    description: baseDescription.length > 0 ? `${baseDescription}\n\n${overview}` : overview,
  });
  return {
    tools: { ...inputs.tools, [TOOL_SEARCH_TOOL_NAME]: augmentedSearchTool },
    state: { ...classification, activatedToolNames: new Set<string>() },
  };
}

/**
 * Model-fallback rebuild: re-run classification against the fallback model's
 * re-assembled tool record, mutating the existing state object IN PLACE
 * (StreamManager's request holds a reference to it). The activation set is
 * intersected with the new deferred set. When the fallback record no longer
 * supports deferral, the state deactivates (empty deferred set ⇒
 * computeActiveToolNames returns undefined ⇒ no activeTools scoping) and
 * `tool_catalog_search` is removed from the returned record.
 */
export function rebuildToolSearchState(
  state: ToolSearchStreamState,
  inputs: ToolCatalogInputs
): { tools: Record<string, Tool> } {
  const prepared = prepareToolSearch(inputs);
  if (prepared.state === undefined) {
    state.catalog = [];
    state.deferredToolNames = new Set();
    state.allToolNames = Object.keys(prepared.tools);
    state.activatedToolNames = new Set();
    return { tools: prepared.tools };
  }
  state.catalog = prepared.state.catalog;
  state.deferredToolNames = prepared.state.deferredToolNames;
  state.allToolNames = prepared.state.allToolNames;
  state.activatedToolNames = new Set(
    [...state.activatedToolNames].filter((name) => prepared.state!.deferredToolNames.has(name))
  );
  return { tools: prepared.tools };
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

export interface ToolSearchMatch {
  name: string;
  description: string;
  /** Bounded display label of the originating MCP server, when known. */
  serverName?: string;
}

/**
 * Deterministic ranking over name + description + parameter text.
 * Simple substring + token-overlap scoring (no external deps, no BM25):
 * name hits weigh highest, then description, then params. Zero-score entries
 * are dropped; ties break lexicographically by name.
 */
export function searchToolCatalog(
  catalog: readonly ToolCatalogEntry[],
  query: string,
  limit?: number | null
): ToolSearchMatch[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return [];
  }
  const effectiveLimit = Math.min(
    Math.max(limit ?? TOOL_SEARCH_DEFAULT_LIMIT, 1),
    TOOL_SEARCH_MAX_LIMIT
  );

  // Server tokens come from the bounded display label — the exact string the
  // overview advertises — so copying the visible label into a query scores as
  // expected even when the raw name exceeds the label clamp. Tokenizing the
  // label (never the raw, unbounded config key) also bounds per-search work,
  // and the cache computes it once per distinct server instead of per tool.
  const serverTokensCache = new Map<string, Set<string>>();
  const serverTokensFor = (server: string): Set<string> => {
    let tokens = serverTokensCache.get(server);
    if (tokens === undefined) {
      tokens = new Set(tokenize(displayServerLabel(server)));
      serverTokensCache.set(server, tokens);
    }
    return tokens;
  };

  const scored: Array<{ entry: ToolCatalogEntry; score: number }> = [];
  for (const entry of catalog) {
    const nameLower = entry.name.toLowerCase();
    const nameTokens = new Set(tokenize(entry.name));
    const descriptionTokens = new Set(tokenize(entry.description));
    const paramTokens = new Set(tokenize(entry.paramText));
    // Server-name matches rank between name and description hits so a query
    // like "github" surfaces that server's tools even when normalization
    // changed the tool-name prefix.
    const serverTokens =
      entry.serverName !== undefined ? serverTokensFor(entry.serverName) : new Set<string>();

    let score = 0;
    for (const token of queryTokens) {
      if (nameTokens.has(token)) {
        score += 8;
      } else if (nameLower.includes(token)) {
        score += 5;
      }
      if (serverTokens.has(token)) {
        score += 3;
      }
      if (descriptionTokens.has(token)) {
        score += 2;
      }
      if (paramTokens.has(token)) {
        score += 1;
      }
    }
    if (score > 0) {
      scored.push({ entry, score });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  return scored.slice(0, effectiveLimit).map(({ entry }) => ({
    name: entry.name,
    description: entry.description,
    // Display label, not the raw name: an unbounded server-map key repeated
    // across up to 25 matches could inflate the result past provider limits.
    ...(entry.serverName !== undefined ? { serverName: displayServerLabel(entry.serverName) } : {}),
  }));
}

/** Read `matches[].name` strings from a defensively-parsed tool_catalog_search result value. */
function collectMatchNames(value: unknown, into: Set<string>): void {
  if (!isPlainRecord(value) || !Array.isArray(value.matches)) {
    return;
  }
  for (const match of value.matches) {
    if (isPlainRecord(match) && typeof match.name === "string" && match.name.length > 0) {
      into.add(match.name);
    }
  }
}

/** Decode a tool_catalog_search output in any persisted encoding. */
function decodeToolSearchOutput(output: unknown): unknown {
  if (isPlainRecord(output) && output.type === "json") {
    return output.value;
  }
  if (isPlainRecord(output) && output.type === "text" && typeof output.value === "string") {
    try {
      return JSON.parse(output.value);
    } catch {
      return undefined;
    }
  }
  return output;
}

function collectMatchNamesFromOutput(output: unknown, into: Set<string>): void {
  collectMatchNames(decodeToolSearchOutput(output), into);
}

function isMuxToolSearchOutput(output: unknown): boolean {
  const value = decodeToolSearchOutput(output);
  return (
    isPlainRecord(value) &&
    typeof value.query === "string" &&
    Array.isArray(value.matches) &&
    value.matches.every(
      (match) =>
        isPlainRecord(match) &&
        typeof match.name === "string" &&
        typeof match.description === "string"
    ) &&
    typeof value.totalDeferred === "number"
  );
}

function renameLegacyToolSearchCallPart(part: ToolCallPart): ToolCallPart {
  return part.toolName === LEGACY_TOOL_SEARCH_TOOL_NAME
    ? { ...part, toolName: TOOL_SEARCH_TOOL_NAME }
    : part;
}

function renameLegacyToolSearchResultPart(part: ToolResultPart): ToolResultPart {
  return part.toolName === LEGACY_TOOL_SEARCH_TOOL_NAME
    ? { ...part, toolName: TOOL_SEARCH_TOOL_NAME }
    : part;
}

/**
 * Scan conversation history for prior `tool_catalog_search` tool results and return
 * the tool names they matched, so tools discovered in earlier turns (or
 * before a mid-turn stream retry) re-activate without a new search. Accepts
 * both provider-shaped ModelMessages (tool-result parts, `{type:"json"}` /
 * `{type:"text"}` output encodings plus raw result objects) and XumMessages
 * (dynamic-tool parts with raw outputs) — aiService seeds from XumMessages
 * because the agent-transition sentinel is computed before the Xum→Model
 * conversion runs. Callers intersect the result with the current deferred set.
 */
export function extractPreActivatedToolNames(
  messages: ReadonlyArray<ModelMessage | MuxMessage>
): Set<string> {
  const names = new Set<string>();
  for (const message of messages) {
    if ("parts" in message && Array.isArray(message.parts)) {
      for (const part of message.parts) {
        if (
          part.type === "dynamic-tool" &&
          isMuxToolSearchName(part.toolName) &&
          part.state === "output-available"
        ) {
          collectMatchNamesFromOutput(part.output, names);
        }
      }
      continue;
    }
    if (message.role !== "tool" || !Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (part.type !== "tool-result" || !isMuxToolSearchName(part.toolName)) {
        continue;
      }
      collectMatchNamesFromOutput(part.output, names);
    }
  }
  return names;
}

/**
 * AI SDK 7 reserves the legacy `tool_search` name for OpenAI's native tool.
 * Rewrite only completed historical Xum search calls, request-only, so old
 * workspaces remain usable without relabeling unrelated MCP tools.
 */
export function normalizeLegacyToolSearchMessages(messages: ModelMessage[]): ModelMessage[] {
  const legacyCallIds = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (
        part.type === "tool-result" &&
        part.toolName === LEGACY_TOOL_SEARCH_TOOL_NAME &&
        isMuxToolSearchOutput(part.output)
      ) {
        legacyCallIds.add(part.toolCallId);
      }
    }
  }

  if (legacyCallIds.size === 0) {
    return messages;
  }

  return messages.map((message) => {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const content: Exclude<AssistantModelMessage["content"], string> = message.content.map(
        (part) => {
          if (!legacyCallIds.has("toolCallId" in part ? part.toolCallId : "")) {
            return part;
          }
          if (part.type === "tool-call") {
            return renameLegacyToolSearchCallPart(part);
          }
          if (part.type === "tool-result") {
            return renameLegacyToolSearchResultPart(part);
          }
          return part;
        }
      );
      const normalizedMessage: AssistantModelMessage = { ...message, content };
      return normalizedMessage;
    }

    if (message.role === "tool") {
      const content: ToolModelMessage["content"] = message.content.map((part) => {
        if (part.type === "tool-result" && legacyCallIds.has(part.toolCallId)) {
          return renameLegacyToolSearchResultPart(part);
        }
        return part;
      });
      const normalizedMessage: ToolModelMessage = { ...message, content };
      return normalizedMessage;
    }

    return message;
  });
}

/**
 * Seed the activation set from prior tool_catalog_search results found in the
 * stream's input messages, intersected with the current deferred set.
 */
export function seedToolSearchActivationsFromMessages(
  state: ToolSearchStreamState,
  messages: ReadonlyArray<ModelMessage | MuxMessage>
): void {
  for (const name of extractPreActivatedToolNames(messages)) {
    if (state.deferredToolNames.has(name)) {
      state.activatedToolNames.add(name);
    }
  }
}

/**
 * Compute the per-step `activeTools` list for streamText's prepareStep.
 * Returns undefined when the feature is inactive (no state, or deactivated by
 * a fallback rebuild) so the caller returns exactly what it returns today.
 */
export function computeActiveToolNames(
  state: ToolSearchStreamState | undefined
): string[] | undefined {
  if (state === undefined || state.deferredToolNames.size === 0) {
    return undefined;
  }
  return state.allToolNames.filter(
    (name) => !state.deferredToolNames.has(name) || state.activatedToolNames.has(name)
  );
}
