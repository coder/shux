import type { Runtime, ExecOptions } from "@/node/runtime/Runtime";
import { streamToString, streamToStringCapped } from "@/node/runtime/streamUtils";
import { PlatformPaths } from "@/node/utils/paths.main";
import { getLegacyPlanFilePath, getPlanFilePath } from "@/common/utils/planStorage";

/**
 * Convenience helpers for working with streaming Runtime APIs.
 * These provide simple string-based APIs on top of the low-level streaming primitives.
 */

/**
 * Extract project name from a project path
 * Works for both local paths and remote paths
 */
export function getProjectName(projectPath: string): string {
  return PlatformPaths.getProjectName(projectPath);
}

/**
 * Result from executing a command with buffered output
 */
export interface ExecResult {
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Exit code (0 = success) */
  exitCode: number;
  /** Wall clock duration in milliseconds */
  duration: number;
}

/**
 * Execute a command and buffer all output into strings
 */
export async function execBuffered(
  runtime: Runtime,
  command: string,
  options: ExecOptions & {
    stdin?: string;
    /**
     * When set, stdout and stderr are each capped at this many raw bytes while
     * reading (excess is drained and discarded), bounding memory on commands
     * with unbounded output. Pair with `timeout` to also bound duration.
     */
    maxOutputBytes?: number;
  }
): Promise<ExecResult> {
  const stream = await runtime.exec(command, options);

  // Write stdin if provided
  if (options.stdin !== undefined) {
    const writer = stream.stdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode(options.stdin));
      await writer.close();
    } catch (err) {
      writer.releaseLock();
      throw err;
    }
  } else {
    // Close stdin immediately if no input
    await stream.stdin.close();
  }

  // Read stdout and stderr concurrently
  const readStream =
    options.maxOutputBytes !== undefined
      ? (s: ReadableStream<Uint8Array>) => streamToStringCapped(s, options.maxOutputBytes!)
      : streamToString;
  const [stdout, stderr, exitCode, duration] = await Promise.all([
    readStream(stream.stdout),
    readStream(stream.stderr),
    stream.exitCode,
    stream.duration,
  ]);

  return { stdout, stderr, exitCode, duration };
}

/**
 * Read file contents as a UTF-8 string
 */
export async function readFileString(
  runtime: Runtime,
  path: string,
  abortSignal?: AbortSignal
): Promise<string> {
  const stream = runtime.readFile(path, abortSignal);
  return streamToString(stream);
}

/**
 * Write string contents to a file atomically
 */
export async function writeFileString(
  runtime: Runtime,
  path: string,
  content: string,
  abortSignal?: AbortSignal
): Promise<void> {
  const stream = runtime.writeFile(path, abortSignal);
  const writer = stream.getWriter();
  try {
    await writer.write(new TextEncoder().encode(content));
    await writer.close();
  } catch (err) {
    writer.releaseLock();
    throw err;
  }
}

/**
 * Result from reading a plan file with legacy migration support
 */
export interface ReadPlanResult {
  /** Plan file content (empty string if file doesn't exist) */
  content: string;
  /** Whether a plan file exists */
  exists: boolean;
  /** The canonical plan file path (new format) */
  path: string;
}

/**
 * Read plan file content, checking new path first then legacy, migrating if needed.
 * This handles the transparent migration from {runtimeHome}/plans/{id}.md to
 * {runtimeHome}/plans/{projectName}/{workspaceName}.md
 */
export async function readPlanFile(
  runtime: Runtime,
  workspaceName: string,
  projectName: string,
  workspaceId: string
): Promise<ReadPlanResult> {
  const xumHome = runtime.getXumHome();
  const planPath = getPlanFilePath(workspaceName, projectName, xumHome);
  const legacyPath = getLegacyPlanFilePath(workspaceId, xumHome);

  // Resolve tilde to absolute path for client use (editor deep links, etc.)
  // For local runtimes this expands ~ to /home/user; for SSH it resolves remotely
  const resolvedPath = await runtime.resolvePath(planPath);

  // Try new path first
  try {
    const content = await readFileString(runtime, planPath);
    return { content, exists: true, path: resolvedPath };
  } catch {
    // Fall back to legacy path
    try {
      const content = await readFileString(runtime, legacyPath);
      // Migrate: move to new location.
      try {
        const planDir = planPath.substring(0, planPath.lastIndexOf("/"));
        await execBuffered(
          runtime,
          'mkdir -p "$XUM_PLAN_DIR" && mv "$XUM_LEGACY_PLAN" "$XUM_PLAN"',
          {
            cwd: "/tmp",
            pathEnv: {
              XUM_PLAN_DIR: planDir,
              XUM_LEGACY_PLAN: legacyPath,
              XUM_PLAN: planPath,
            },
            timeout: 5,
          }
        );
      } catch {
        // Migration failed, but we have the content
      }
      return { content, exists: true, path: resolvedPath };
    } catch {
      // File doesn't exist at either location
      return { content: "", exists: false, path: resolvedPath };
    }
  }
}

/**
 * Move a plan file from one workspace name to another (e.g., during rename).
 * Silently succeeds if source file doesn't exist.
 */
export async function movePlanFile(
  runtime: Runtime,
  oldWorkspaceName: string,
  newWorkspaceName: string,
  projectName: string
): Promise<void> {
  const xumHome = runtime.getXumHome();
  const oldPath = getPlanFilePath(oldWorkspaceName, projectName, xumHome);
  const newPath = getPlanFilePath(newWorkspaceName, projectName, xumHome);

  try {
    await runtime.stat(oldPath);
    await execBuffered(runtime, 'mv "$XUM_OLD_PLAN" "$XUM_NEW_PLAN"', {
      cwd: "/tmp",
      pathEnv: {
        XUM_OLD_PLAN: oldPath,
        XUM_NEW_PLAN: newPath,
      },
      timeout: 5,
    });
  } catch {
    // No plan file to move, that's fine
  }
}

/**
 * Copy a plan file across runtimes (e.g., during fork where source/target may be
 * different containers). Uses separate runtime handles to avoid the identity mutation
 * bug where DockerRuntime.forkWorkspace() changes this.containerName to the target.
 * Silently succeeds if source file doesn't exist at either location.
 */
export async function copyPlanFileAcrossRuntimes(
  sourceRuntime: Runtime,
  targetRuntime: Runtime,
  sourceWorkspaceName: string,
  sourceWorkspaceId: string,
  targetWorkspaceName: string,
  projectName: string
): Promise<void> {
  const sourceMuxHome = sourceRuntime.getXumHome();
  const targetXumHome = targetRuntime.getXumHome();
  const sourcePath = getPlanFilePath(sourceWorkspaceName, projectName, sourceMuxHome);
  const legacySourcePath = getLegacyPlanFilePath(sourceWorkspaceId, sourceMuxHome);
  const targetPath = getPlanFilePath(targetWorkspaceName, projectName, targetXumHome);

  for (const candidatePath of [sourcePath, legacySourcePath]) {
    try {
      const content = await readFileString(sourceRuntime, candidatePath);
      await writeFileString(targetRuntime, targetPath, content);
      return;
    } catch {
      // Try next candidate
    }
  }
}
