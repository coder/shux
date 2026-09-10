/**
 * Agent Memory constants (experiment: "memory").
 *
 * Models only ever see virtual paths under the virtual root (e.g.
 * /memories/global/preferences.md). The MemoryService maps each scope to a
 * physical root:
 * - global    -> <xumHome>/memory/global/ (host-local, permanent, shared across projects)
 * - project   -> <xumHome>/memory/project/<project dir>/ (host-local, private
 *                per-project notes; never committed to the repo, survives
 *                workspaces; carried by the settings backup only when the
 *                user opts into the project bundle)
 * - workspace -> <sessionDir>/memory/ (host-local, deleted with the workspace)
 */

/** Virtual root prefix all memory paths are expressed under. */
export const MEMORY_VIRTUAL_ROOT = "/memories";

export const MEMORY_SCOPES = ["global", "project", "workspace"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export type MemoryAccessLevel = "read" | "readwrite";

/**
 * Per-scope write policy for the memory tool, derived from the agent class:
 * - Exec-like (editing-capable): all scopes read-write.
 * - Plan-like: all scopes read-write; project memory is host-local and never
 *   mutates the checkout.
 * - Explore/read-only: all scopes read-only (view only).
 */
export type MemoryScopeAccess = Record<MemoryScope, MemoryAccessLevel>;

/** Maximum size of a single memory file (bytes). */
export const MEMORY_MAX_FILE_BYTES = 100 * 1024;

/** Maximum number of files per scope. */
export const MEMORY_MAX_FILES_PER_SCOPE = 1000;

/**
 * Maximum length of a memory file's one-line description in the injected
 * memory index (frontmatter `description`, truncated for prompt budget and
 * index hardening).
 */
export const MEMORY_INDEX_DESCRIPTION_MAX_CHARS = 200;

/**
 * Bytes read from the head of each file when building the memory index.
 * Memory files can be edited outside MemoryService write caps, so index builds
 * must never fully read arbitrarily large files; the frontmatter description
 * must start within this prefix or it degrades to "" (file stays listed).
 */
export const MEMORY_INDEX_DESCRIPTION_PREFIX_BYTES = 4 * 1024;

/** Directory listing depth for `view` on a directory (per Anthropic memory-tool semantics). */
export const MEMORY_VIEW_MAX_DEPTH = 2;

/**
 * Hot-set budgets: user-pinned + frequently-used memory files are preloaded
 * into context (the second tier between the always-present index and
 * tool-call cold reads). The hot set is recomputed on first use of a model in
 * a session segment and at compaction boundaries so repeated turns keep
 * prompt-cache-stable bytes.
 */
/** Maximum bytes of a single preloaded memory file (longer files are truncated). */
export const MEMORY_HOT_SET_MAX_ITEM_BYTES = 16 * 1024;
/** Maximum total bytes of selected hot-memory file content. */
export const MEMORY_HOT_SET_MAX_TOTAL_BYTES = 48 * 1024;
/** Maximum tokens consumed by the rendered <hot_memories> block. */
export const MEMORY_HOT_SET_MAX_TOTAL_TOKENS = 12_000;
/** Maximum number of memory files preloaded into the system prompt. */
export const MEMORY_HOT_SET_MAX_ITEMS = 8;
/** Maximum ranked candidates to read/tokenize while filling the hot set. */
export const MEMORY_HOT_SET_MAX_SELECTION_ATTEMPTS = 64;
/** Half-life of the recency decay applied to access counts when ranking auto-hot files. */
export const MEMORY_HOT_SET_DECAY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Memory consolidation ("dream" agent, issue #3534): maximum mutating memory
 * commands per consolidation run. Reads are unlimited; the budget bounds churn
 * from a misbehaving model.
 */
export const MEMORY_CONSOLIDATION_OP_BUDGET = 8;
/** Generous step ceiling for the consolidation stream (reads + budgeted mutations). */
export const MEMORY_CONSOLIDATION_MAX_STEPS = 32;
/** Minimum gap between consolidation runs for one workspace (debounce across triggers). */
export const MEMORY_CONSOLIDATION_DEBOUNCE_MS = 6 * 60 * 60 * 1000;
/** Launch sweep: a workspace qualifies after this much user inactivity. */
export const MEMORY_CONSOLIDATION_IDLE_MS = 24 * 60 * 60 * 1000;
/**
 * Launch sweep: at most this many workspaces consolidate per app launch, so a
 * backlog of idle workspaces can never stampede the provider on startup.
 */
export const MEMORY_CONSOLIDATION_LAUNCH_SWEEP_CAP = 3;
/**
 * Hard wall-clock ceiling per consolidation run. Without it a half-alive
 * provider stream (keepalives but no progress) would hold the workspace's
 * in-flight lock forever and block every future trigger.
 */
export const MEMORY_CONSOLIDATION_TIMEOUT_MS = 5 * 60 * 1000;

/** Read-only intuition runs are deliberately smaller than consolidation passes. */
export const MEMORY_INTUITION_RECOGNITION_THRESHOLD = 0.7;
export const MEMORY_INTUITION_CANDIDATE_THRESHOLD = 0.3;
export const MEMORY_INTUITION_MAX_STEPS = 6;
export const MEMORY_INTUITION_TIMEOUT_MS = 20_000;
export const MEMORY_INTUITION_MAX_OUTPUT_TOKENS = 2048;
export const MEMORY_INTUITION_MAX_USES_PER_TURN = 3;
export const MEMORY_INTUITION_MAX_RESULTS = 6;
export const MEMORY_INTUITION_MAX_EXCERPT_CHARS = 1200;
export const MEMORY_INTUITION_MAX_CUE_CHARS = 2000;
export const MEMORY_INTUITION_MAX_READ_BYTES = 256 * 1024;
export const MEMORY_INTUITION_MAX_INDEX_ENTRIES = 200;
export const MEMORY_INTUITION_MAX_INDEX_BYTES = 32 * 1024;
export const MEMORY_INTUITION_INDEX_AUTH_CONCURRENCY = 4;
