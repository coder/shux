import type { RuntimeConfig } from "@/common/types/runtime";
import type { RuntimeStatusEvent as StreamRuntimeStatusEvent } from "@/common/types/stream";
import type { Result } from "@/common/types/result";

/**
 * Runtime abstraction for executing tools in different environments.
 *
 * DESIGN PRINCIPLE: Keep this interface minimal and low-level.
 * - Prefer streaming primitives over buffered APIs
 * - Implement shared helpers (utils/runtime/) that work across all runtimes
 * - Avoid duplicating helper logic in each runtime implementation
 *
 * This interface allows tools to run locally, in Docker containers, over SSH, etc.
 */

/**
 * PATH TERMINOLOGY & HIERARCHY
 *
 * srcBaseDir (base directory for all workspaces):
 *   - Where mux stores ALL workspace directories
 *   - Local: ~/.xum/src (tilde expanded to full path by LocalRuntime)
 *   - SSH: /home/user/workspace (tilde paths are allowed and are resolved before use)
 *
 * Workspace Path Computation:
 *   {srcBaseDir}/{projectName}/{workspaceName}
 *
 *   - projectName: basename(projectPath)
 *     Example: "/Users/me/git/my-project" → "my-project"
 *
 *   - workspaceName: branch name or custom name
 *     Example: "feature-123" or "main"
 *
 * Full Example (Local):
 *   srcBaseDir:    ~/.xum/src (expanded to /home/user/.mux/src)
 *   projectPath:   /Users/me/git/my-project (local git repo)
 *   projectName:   my-project (extracted)
 *   workspaceName: feature-123
 *   → Workspace:   /home/user/.mux/src/my-project/feature-123
 *
 * Full Example (SSH):
 *   srcBaseDir:    /home/user/workspace (absolute path required)
 *   projectPath:   /Users/me/git/my-project (local git repo)
 *   projectName:   my-project (extracted)
 *   workspaceName: feature-123
 *   → Workspace:   /home/user/workspace/my-project/feature-123
 */

/**
 * Options for executing a command
 */
export interface ExecOptions {
  /** Working directory for command execution */
  cwd: string;
  /** Environment variables to inject */
  env?: Record<string, string>;
  /** Host-namespace paths to translate before exposing them as environment variables. */
  pathEnv?: Record<string, string>;
  /**
   * Timeout in seconds.
   *
   * When provided, prevents zombie processes by ensuring spawned processes are killed.
   * Even long-running commands should have a reasonable upper bound (e.g., 3600s for 1 hour).
   *
   * When omitted, no timeout is applied - use only for internal operations like
   * spawning background processes that are designed to run indefinitely.
   */
  timeout?: number;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Force PTY allocation (SSH only - adds -t flag) */
  forcePTY?: boolean;
}

export type BackgroundMonitorProbeResult<T> =
  | { success: true; value: T }
  | { success: false; error: string };

/**
 * Handle to a background process.
 * Abstracts away whether process is local or remote.
 *
 * Output is written directly to a unified output.log file by shell redirection.
 * This handle is for lifecycle management and output directory operations.
 */
export interface BackgroundHandle {
  /** Output directory containing output.log, meta.json, exit_code */
  readonly outputDir: string;

  /**
   * Get the exit code if the process has exited.
   * Returns null if still running.
   * Async because SSH needs to read remote exit_code file.
   */
  getExitCode(): Promise<number | null>;

  /** Strict exit-code probe used only by monitor polling. */
  getExitCodeForMonitor?(): Promise<BackgroundMonitorProbeResult<number | null>>;

  /**
   * Terminate the process (SIGTERM → wait → SIGKILL).
   */
  terminate(): Promise<void>;

  /**
   * Clean up resources (called after process exits or on error).
   */
  dispose(): Promise<void>;

  /**
   * Write meta.json to the output directory.
   */
  writeMeta(metaJson: string): Promise<void>;

  /**
   * Get the current size of output.log in bytes.
   * Used to tail output without reading the entire file.
   */
  getOutputFileSize(): Promise<number>;

  /**
   * Read output from output.log at the given byte offset.
   * Returns the content read and the new offset (for incremental reads).
   * Works on both local and SSH runtimes by using runtime.exec() internally.
   */
  readOutput(offset: number): Promise<{ content: string; newOffset: number }>;

  /** Strict output probe used only by monitor polling. */
  readOutputForMonitor?(
    offset: number
  ): Promise<BackgroundMonitorProbeResult<{ content: string; newOffset: number }>>;
}

/**
 * Streaming result from executing a command
 */
export interface ExecStream {
  /** Standard output stream */
  stdout: ReadableStream<Uint8Array>;
  /** Standard error stream */
  stderr: ReadableStream<Uint8Array>;
  /** Standard input stream */
  stdin: WritableStream<Uint8Array>;
  /** Promise that resolves with exit code when process completes */
  exitCode: Promise<number>;
  /** Promise that resolves with wall clock duration in milliseconds */
  duration: Promise<number>;
}

/**
 * File statistics
 */
export interface FileStat {
  /** File size in bytes */
  size: number;
  /** Last modified time */
  modifiedTime: Date;
  /** True if path is a directory (false implies regular file for our purposes) */
  isDirectory: boolean;
}

/**
 * Logger for streaming workspace initialization events to frontend.
 * Used to report progress during workspace creation and init hook execution.
 */
export interface InitLogger {
  /** Log a creation step (e.g., "Creating worktree", "Syncing files") */
  logStep(message: string): void;
  /** Log stdout line from init hook */
  logStdout(line: string): void;
  /** Log stderr line from init hook */
  logStderr(line: string): void;
  /** Report init hook completion */
  logComplete(exitCode: number): void;
  /** Signal that the init hook is about to run (starts timeout window). */
  enterHookPhase?(): void;
}

/**
 * Parameters for workspace creation
 */
export interface WorkspaceCreationParams {
  /** Absolute path to project directory on local machine */
  projectPath: string;
  /** Branch name to checkout in workspace */
  branchName: string;
  /** Trunk branch to base new branches on */
  trunkBranch: string;
  /** Directory name to use for workspace (typically branch name) */
  directoryName: string;
  /** Optional explicit start point (commit/branch/ref) for the checkout branch. */
  startPoint?: string;
  /**
   * When true, skip origin fetch / fast-forward logic and preserve the requested start point.
   * Used for deterministic restore flows.
   */
  skipRemoteSync?: boolean;
  /** Optional persisted workspace path override for legacy layouts. */
  workspacePathOverride?: string;
  /** Logger for streaming creation progress and init hook output */
  initLogger: InitLogger;
  /** Optional abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Optional environment variables for checkout-time auth or transport settings */
  env?: Record<string, string>;
  /** Whether the project is trusted — when false, git hooks are disabled */
  trusted?: boolean;
}

/**
 * Result from workspace creation
 */
export interface WorkspaceCreationResult {
  success: boolean;
  /** Absolute path to workspace (local path for LocalRuntime, remote path for SSHRuntime) */
  workspacePath?: string;
  error?: string;
}

/**
 * Parameters for workspace initialization
 */
export interface WorkspaceInitParams {
  /** Absolute path to project directory on local machine */
  projectPath: string;
  /** Branch name to checkout in workspace */
  branchName: string;
  /** Trunk branch to base new branches on */
  trunkBranch: string;
  /** Absolute path to workspace (from createWorkspace result) */
  workspacePath: string;
  /** Logger for streaming initialization progress and output */
  initLogger: InitLogger;
  /** Optional abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Environment variables to inject (MUX_ vars + secrets) */
  env?: Record<string, string>;

  /**
   * When true, skip running the project's .xum/init hook.
   *
   * NOTE: This skips only hook execution, not runtime provisioning.
   */
  skipInitHook?: boolean;
  /** Whether the project is trusted — when false, git hooks are disabled */
  trusted?: boolean;
}

/**
 * Result from workspace initialization
 */
export interface WorkspaceInitResult {
  success: boolean;
  error?: string;
}

/**
 * Parameters for forking an existing workspace
 */
export interface WorkspaceForkParams {
  /** Project root path (local path) */
  projectPath: string;
  /** Name of the source workspace to fork from */
  sourceWorkspaceName: string;
  /** Name for the new workspace */
  newWorkspaceName: string;
  /** Logger for streaming initialization events */
  initLogger: InitLogger;
  /** Signal to abort long-running operations (e.g. cp -R -P or git worktree add) */
  abortSignal?: AbortSignal;
  /** Optional environment variables for checkout-time auth or transport settings */
  env?: Record<string, string>;
  /** Whether the project is trusted — when false, git hooks are disabled */
  trusted?: boolean;
}

/**
 * Result of forking a workspace
 */
export interface WorkspaceForkResult {
  /** Whether the fork operation succeeded */
  success: boolean;
  /** Path to the new workspace (if successful) */
  workspacePath?: string;
  /** Branch that was forked from */
  sourceBranch?: string;
  /** Error message (if failed) */
  error?: string;
  /** Runtime config for the forked workspace (if different from source) */
  forkedRuntimeConfig?: RuntimeConfig;
  /** Updated runtime config for source workspace (e.g., mark as shared) */
  sourceRuntimeConfig?: RuntimeConfig;
  /**
   * When true and success=false, don't fall back to createWorkspace.
   * Use when the runtime provisions shared infrastructure that subagents must share.
   */
  failureIsFatal?: boolean;
}

/**
 * Flags that control workspace creation behavior in WorkspaceService.
 * Allows runtimes to customize the create flow without WorkspaceService
 * needing runtime-specific conditionals.
 */
export interface RuntimeCreateFlags {
  /**
   * Skip srcBaseDir resolution before createWorkspace.
   * Use when runtime access doesn't exist until postCreateSetup (e.g., Coder).
   */
  deferredRuntimeAccess?: boolean;

  /**
   * Use config-level collision detection instead of runtime.createWorkspace.
   * Use when createWorkspace can't detect existing workspaces (host doesn't exist).
   */
  configLevelCollisionDetection?: boolean;
}

/**
 * Runtime status update payload for ensureReady progress.
 *
 * Derived from the stream schema type to keep phase/runtimeType/detail consistent
 * across backend + frontend.
 */
export type RuntimeStatusEvent = Pick<StreamRuntimeStatusEvent, "phase" | "runtimeType" | "detail">;

/**
 * Callback for runtime status updates during ensureReady().
 */
export type RuntimeStatusSink = (status: RuntimeStatusEvent) => void;

/**
 * Options for ensureReady().
 */
export interface EnsureReadyOptions {
  /**
   * Callback to emit runtime-status events for UX feedback.
   * Coder uses this to show "Starting Coder workspace..." during boot.
   */
  statusSink?: RuntimeStatusSink;

  /**
   * Abort signal to cancel long-running operations.
   */
  signal?: AbortSignal;
}

/**
 * Result of ensureReady().
 * Distinguishes between permanent failures (runtime_not_ready) and
 * transient failures (runtime_start_failed) for retry logic.
 */
export type EnsureReadyResult =
  | { ready: true }
  | {
      ready: false;
      error: string;
      errorType: "runtime_not_ready" | "runtime_start_failed";
    };

/**
 * Shared error message for missing repositories during runtime readiness checks.
 */
export const WORKSPACE_REPO_MISSING_ERROR = "Workspace setup incomplete: repository not found.";

/**
 * Runtime interface - minimal, low-level abstraction for tool execution environments.
 *
 * All methods return streaming primitives for memory efficiency.
 * Use helpers in utils/runtime/ for convenience wrappers (e.g., readFileString, execBuffered).
 */
export interface Runtime {
  /**
   * Flags that control workspace creation behavior.
   * If not provided, defaults to standard behavior (no flags set).
   */
  readonly createFlags?: RuntimeCreateFlags;
  /**
   * Execute a bash command with streaming I/O.
   * cwd and pathEnv values are host-namespace paths translated by the adapter.
   * @param command The bash script to execute
   * @param options Execution options (cwd, env, timeout, etc.)
   * @returns Promise that resolves to streaming handles for stdin/stdout/stderr and completion promises
   * @throws RuntimeError if execution fails in an unrecoverable way
   */
  exec(command: string, options: ExecOptions): Promise<ExecStream>;

  /**
   * Read file contents as a stream. Adapters canonicalize tilde and relative paths.
   * @param path Absolute or relative path to file
   * @param abortSignal Optional abort signal for cancellation
   * @returns Readable stream of file contents
   * @throws RuntimeError if file cannot be read
   */
  readFile(path: string, abortSignal?: AbortSignal): ReadableStream<Uint8Array>;

  /**
   * Write file contents atomically from a stream. Adapters canonicalize tilde and relative paths.
   * @param path Absolute or relative path to file
   * @param abortSignal Optional abort signal for cancellation
   * @returns Writable stream for file contents
   * @throws RuntimeError if file cannot be written
   */
  writeFile(path: string, abortSignal?: AbortSignal): WritableStream<Uint8Array>;

  /**
   * Get file statistics. Adapters canonicalize tilde and relative paths.
   * @param path Absolute or relative path to file/directory
   * @param abortSignal Optional abort signal for cancellation
   * @returns File statistics
   * @throws RuntimeError if path does not exist or cannot be accessed
   */
  stat(path: string, abortSignal?: AbortSignal): Promise<FileStat>;

  /**
   * Ensure a directory exists (mkdir -p semantics). Adapters canonicalize tilde and relative paths.
   *
   * This intentionally lives on the Runtime abstraction so local runtimes can use
   * Node fs APIs (Windows-safe) while remote runtimes can use shell commands.
   */
  ensureDir(path: string, abortSignal?: AbortSignal): Promise<void>;

  /**
   * Resolve a path to its absolute, canonical form (expanding tildes, resolving symlinks, etc.).
   * This is used at workspace creation time to normalize srcBaseDir paths in config.
   *
   * @param path Path to resolve (may contain tildes or be relative)
   * @returns Promise resolving to absolute path
   * @throws RuntimeError if path cannot be resolved (e.g., doesn't exist, permission denied)
   *
   * @example
   * // LocalRuntime
   * await runtime.resolvePath("~/mux")      // => "/home/user/mux"
   * await runtime.resolvePath("./relative")  // => "/current/dir/relative"
   *
   * // SSHRuntime
   * await runtime.resolvePath("~/mux")      // => "/home/user/mux" (via SSH shell expansion)
   */
  resolvePath(path: string): Promise<string>;

  /**
   * Normalize a path for comparison purposes within this runtime's context.
   * Handles runtime-specific path semantics (local vs remote).
   *
   * @param targetPath Path to normalize (may be relative or absolute)
   * @param basePath Base path to resolve relative paths against
   * @returns Normalized path suitable for string comparison
   *
   * @example
   * // LocalRuntime
   * runtime.normalizePath(".", "/home/user") // => "/home/user"
   * runtime.normalizePath("../other", "/home/user/project") // => "/home/user/other"
   *
   * // SSHRuntime
   * runtime.normalizePath(".", "/home/user") // => "/home/user"
   * runtime.normalizePath("~/project", "~") // => "~/project"
   */
  normalizePath(targetPath: string, basePath: string): string;

  /**
   * Compute absolute workspace path from project and workspace name.
   * This is the SINGLE source of truth for workspace path computation.
   *
   * - LocalRuntime: {workdir}/{project-name}/{workspace-name}
   * - SSHRuntime: {workdir}/{project-name}/{workspace-name}
   *
   * All Runtime methods (create, delete, rename) MUST use this method internally
   * to ensure consistent path computation.
   *
   * @param projectPath Project root path (local path, used to extract project name)
   * @param workspaceName Workspace name (typically branch name)
   * @returns Absolute path to workspace directory
   */
  getWorkspacePath(projectPath: string, workspaceName: string): string;

  /**
   * Create a workspace for this runtime (fast, returns immediately)
   * - LocalRuntime: Creates git worktree
   * - SSHRuntime: Creates remote directory only
   * Does NOT run init hook or sync files.
   * @param params Workspace creation parameters
   * @returns Result with workspace path or error
   */
  createWorkspace(params: WorkspaceCreationParams): Promise<WorkspaceCreationResult>;

  /**
   * Finalize runtime config after collision handling.
   * Called with final branch name (may have collision suffix).
   *
   * Use cases:
   * - Coder: derive workspace name from branch, compute SSH host
   *
   * @param finalBranchName Branch name after collision handling
   * @param config Current runtime config
   * @returns Updated runtime config, or error
   */
  finalizeConfig?(
    finalBranchName: string,
    config: RuntimeConfig
  ): Promise<Result<RuntimeConfig, string>>;

  /**
   * Validate before persisting workspace metadata.
   * Called after finalizeConfig, before editConfig.
   * May make network calls for external validation.
   *
   * Use cases:
   * - Coder: check if workspace name already exists
   *
   * IMPORTANT: This hook runs AFTER createWorkspace(). Only implement this if:
   * - createWorkspace() is side-effect-free for this runtime, OR
   * - The runtime can tolerate/clean up side effects on validation failure
   *
   * If your runtime's createWorkspace() has side effects (e.g., creates directories)
   * and validation failure would leave orphaned resources, consider whether those
   * checks belong in createWorkspace() itself instead.
   *
   * @param finalBranchName Branch name after collision handling
   * @param config Finalized runtime config
   * @returns Success, or error message
   */
  validateBeforePersist?(
    finalBranchName: string,
    config: RuntimeConfig
  ): Promise<Result<void, string>>;

  /**
   * Optional long-running setup that runs after mux persists workspace metadata.
   * Used for provisioning steps that must happen before initWorkspace but after
   * the workspace is registered (e.g., creating Coder workspaces, pulling Docker images).
   *
   * Contract:
   * - MAY take minutes (streams progress via initLogger)
   * - MUST NOT call initLogger.logComplete() - that's handled by the caller
   * - On failure: throw; caller will log error and mark init failed
   * - Runtimes with this hook expect callers to use runFullInit/runBackgroundInit
   *
   * @param params Same as initWorkspace params
   */
  postCreateSetup?(params: WorkspaceInitParams): Promise<void>;

  /**
   * Initialize workspace asynchronously (may be slow, streams progress)
   * - LocalRuntime: Runs init hook if present
   * - SSHRuntime: Syncs files, checks out branch, runs init hook
   * Streams progress via initLogger.
   * @param params Workspace initialization parameters
   * @returns Result indicating success or error
   */
  initWorkspace(params: WorkspaceInitParams): Promise<WorkspaceInitResult>;

  /**
   * Rename workspace directory
   * - LocalRuntime: Uses git worktree move (worktrees managed by git)
   * - SSHRuntime: Uses mv (plain directories on remote, not worktrees)
   * Runtime computes workspace paths internally from workdir + projectPath + workspace names.
   * @param projectPath Project root path (local path, used for git commands in LocalRuntime and to extract project name)
   * @param oldName Current workspace name
   * @param newName New workspace name
   * @param abortSignal Optional abort signal for cancellation
   * @returns Promise resolving to Result with old/new paths on success, or error message
   */
  renameWorkspace(
    projectPath: string,
    oldName: string,
    newName: string,
    abortSignal?: AbortSignal,
    trusted?: boolean
  ): Promise<
    { success: true; oldPath: string; newPath: string } | { success: false; error: string }
  >;

  /**
   * Delete workspace directory
   * - LocalRuntime: Uses git worktree remove (with --force only if force param is true)
   * - SSHRuntime: Checks for uncommitted changes unless force is true, then uses rm -rf
   * Runtime computes workspace path internally from workdir + projectPath + workspaceName.
   *
   * **CRITICAL: Implementations must NEVER auto-apply --force or skip dirty checks without explicit force=true.**
   * If workspace has uncommitted changes and force=false, implementations MUST return error.
   * The force flag is the user's explicit intent - implementations must not override it.
   *
   * @param projectPath Project root path (local path, used for git commands in LocalRuntime and to extract project name)
   * @param workspaceName Workspace name to delete
   * @param force If true, force deletion even with uncommitted changes or special conditions (submodules, etc.)
   * @param abortSignal Optional abort signal for cancellation
   * @returns Promise resolving to Result with deleted path on success, or error message
   */
  deleteWorkspace(
    projectPath: string,
    workspaceName: string,
    force: boolean,
    abortSignal?: AbortSignal,
    trusted?: boolean
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }>;

  /**
   * Ensure the runtime is ready for operations.
   * - LocalRuntime: Always returns ready (no-op)
   * - DockerRuntime: Starts container if stopped
   * - SSHRuntime: Could verify connection (future)
   * - CoderSSHRuntime: Checks workspace status, starts if stopped, waits for ready
   *
   * Called automatically by AIService before streaming.
   *
   * @param options Optional config: statusSink for progress events, signal for cancellation
   * @returns Result indicating ready or failure with error type for retry decisions
   */
  ensureReady(options?: EnsureReadyOptions): Promise<EnsureReadyResult>;

  /**
   * Fork an existing workspace to create a new one.
   * Creates a new workspace branching from the source workspace's current branch.
   * Capability and error behavior are runtime-defined; shared orchestration
   * (see forkOrchestrator.ts) handles policy differences between user and task forks.
   *
   * @param params Fork parameters (source workspace name, new workspace name, etc.)
   * @returns Result with new workspace path and source branch, or error
   */
  forkWorkspace(params: WorkspaceForkParams): Promise<WorkspaceForkResult>;

  /**
   * Get the runtime's temp directory (absolute path, resolved).
   * - LocalRuntime: /tmp (or OS temp dir)
   * - SSHRuntime: Resolved remote temp dir (e.g., /tmp)
   *
   * Used for background process output, temporary files, etc.
   */
  tempDir(): Promise<string>;

  /**
   * Get the mux home directory for this runtime.
   * Used for storing plan files and other mux-specific data.
   * - LocalRuntime/SSHRuntime: ~/.xum (tilde expanded by runtime)
   * - DockerRuntime: /var/mux (world-readable, avoids /root permission issues)
   */
  getXumHome(): string;

  /**
   * Env vars that should be forwarded into container processes.
   * Used by ptyService to inject credential env into devcontainer terminal sessions.
   * Returns empty record for runtimes that don't need env forwarding (local, ssh).
   */
  getContainerEnv?(): Record<string, string>;
}

/**
 * Error thrown by runtime implementations
 */
export class RuntimeError extends Error {
  constructor(
    message: string,
    public readonly type: "exec" | "file_io" | "network" | "unknown",
    cause?: unknown
  ) {
    // The wrapped original error travels through the NATIVE Error options bag
    // and is typed `unknown` (matching Error.cause), NOT an `Error`-typed
    // parameter property: wrap sites catch errors from Node builtins, which
    // under jest's vm sandbox come from another realm where `instanceof
    // Error` is false — an Error-typed cause forces wrap sites into
    // `err instanceof Error ? err : undefined` filters that silently drop
    // the fs error (and its ENOENT/EACCES code) that unwrapping checks need.
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "RuntimeError";
  }
}
