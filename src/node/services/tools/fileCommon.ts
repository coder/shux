import * as path from "path";
import assert from "@/common/utils/assert";
import { createPatch } from "diff";
import type { FileStat, Runtime } from "@/node/runtime/Runtime";
import { RemoteRuntime } from "@/node/runtime/RemoteRuntime";
import type { ToolConfiguration } from "@/common/utils/tools/tools";

/**
 * Maximum file size for file operations (1MB)
 * Files larger than this should be processed with system tools like grep, sed, etc.
 */
export const MAX_FILE_SIZE = 1024 * 1024; // 1MB

export interface PlanModeValidationError {
  success: false;
  error: string;
}

/**
 * Validate file path for plan-mode edit restrictions.
 * Returns an error only when the plan agent is locked to the configured plan file
 * and the requested edit targets any other path or alternate spelling of that path.
 *
 * Returns null if validation passes.
 */
export async function validatePlanModeAccess(
  filePath: string,
  config: ToolConfiguration
): Promise<PlanModeValidationError | null> {
  // Outside plan mode, the configured plan file should stay editable like any other file.
  // Plan-mode agents still lock edits to the exact path string from the instructions.
  // Plan-agent restriction: only allow editing the plan file (and require exact string match).
  if (config.planFileOnly && config.planFilePath) {
    if (filePath !== config.planFilePath) {
      if (await isPlanFilePath(filePath, config)) {
        return {
          success: false,
          error: `In the plan agent, you must use the exact plan file path from the instructions: ${config.planFilePath} (attempted: ${filePath}; this resolves to the plan file but absolute/alternate paths are not allowed)`,
        };
      }

      return {
        success: false,
        error: `In the plan agent, only the plan file can be edited. You must use the exact plan file path: ${config.planFilePath} (attempted: ${filePath})`,
      };
    }
  }

  return null;
}

/**
 * Generate a unified diff between old and new content using jsdiff.
 * Uses createPatch with context of 3 lines.
 *
 * @param filePath - The file path being edited (used in diff header)
 * @param oldContent - The original file content
 * @param newContent - The modified file content
 * @returns Unified diff string
 */
export function generateDiff(filePath: string, oldContent: string, newContent: string): string {
  return createPatch(filePath, oldContent, newContent, "", "", { context: 3 });
}

/**
 * Check if a file path is the configured plan file (any mode).
 * Uses runtime.resolvePath to properly expand tildes for comparison.
 *
 * Why mode-agnostic: the plan file is useful context in both plan + exec modes,
 * and plan-mode agents still need exact-path validation for plan-only edits.
 *
 * @param targetPath - The path being accessed (may contain ~ or be absolute)
 * @param config - Tool configuration containing planFilePath
 * @returns true if this is the configured plan file
 */
export async function isPlanFilePath(
  targetPath: string,
  config: ToolConfiguration
): Promise<boolean> {
  if (!config.planFilePath) {
    return false;
  }
  // Resolve both paths to absolute form for proper comparison.
  // This handles cases where one path uses ~ and the other is fully expanded.
  const [resolvedTarget, resolvedPlan] = await Promise.all([
    config.runtime.resolvePath(targetPath),
    config.runtime.resolvePath(config.planFilePath),
  ]);
  return resolvedTarget === resolvedPlan;
}

/**
 * Validates that a file size is within the allowed limit.
 * Returns an error object if the file is too large, null if valid.
 *
 * @param stats - File stats from fs.stat()
 * @returns Error object if file is too large, null if valid
 */
export function validateFileSize(stats: FileStat): { error: string } | null {
  if (stats.size > MAX_FILE_SIZE) {
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    const maxMB = (MAX_FILE_SIZE / (1024 * 1024)).toFixed(2);
    return {
      error: `File is too large (${sizeMB}MB). The maximum file size for file operations is ${maxMB}MB. Please use system tools like grep, sed, awk, or split the file into smaller chunks.`,
    };
  }
  return null;
}

/**
 * Validates that a file path doesn't contain redundant workspace prefix.
 * If the path contains the cwd prefix, returns the corrected relative path and a warning.
 * This helps save tokens by encouraging relative paths.
 *
 * Works for both local and SSH runtimes by using runtime.normalizePath()
 * for consistent path handling across different runtime types.
 *
 * @param filePath - The file path to validate
 * @param cwd - The working directory
 * @param runtime - The runtime to use for path normalization
 * @returns Object with corrected path and warning if redundant prefix found, null if valid
 */
export function validateNoRedundantPrefix(
  filePath: string,
  cwd: string,
  runtime: Runtime
): { correctedPath: string; warning: string } | null {
  // Only check absolute paths (start with /) - relative paths are fine
  // This works for both local and SSH since both use Unix-style paths
  if (!filePath.startsWith("/")) {
    return null;
  }

  // Use runtime's normalizePath to ensure consistent handling across local and SSH
  // Normalize the cwd to get canonical form (removes trailing slashes, etc.)
  const normalizedCwd = runtime.normalizePath(".", cwd);

  // For absolute paths, we can't use normalizePath directly (it resolves relative paths)
  // so just clean up trailing slashes manually
  const normalizedPath = filePath.replace(/\/+$/, "");
  const cleanCwd = normalizedCwd.replace(/\/+$/, "");

  // Check if the absolute path starts with the cwd
  // Use startsWith + check for path separator to avoid partial matches
  // e.g., /workspace/project should match /workspace/project/src but not /workspace/project2
  if (normalizedPath === cleanCwd || normalizedPath.startsWith(cleanCwd + "/")) {
    // Calculate what the relative path would be
    const relativePath =
      normalizedPath === cleanCwd ? "." : normalizedPath.substring(cleanCwd.length + 1);
    return {
      correctedPath: relativePath,
      warning: `Note: Using relative paths like '${relativePath}' instead of '${filePath}' saves tokens. The path has been auto-corrected for you.`,
    };
  }

  return null;
}

interface RuntimePathModule {
  isAbsolute(filePath: string): boolean;
  relative(from: string, to: string): string;
}

type ComparablePathKind = "absolute" | "home";

interface ComparablePath {
  kind: ComparablePathKind;
  value: string;
}

function getRuntimePathModule(runtime: Runtime): RuntimePathModule {
  return runtime instanceof RemoteRuntime ? path.posix : path;
}

function isRuntimeAbsolutePath(filePath: string, runtime: Runtime): boolean {
  const trimmedPath = filePath.trim();
  if (runtime instanceof RemoteRuntime) {
    return trimmedPath.startsWith("/") || trimmedPath === "~" || trimmedPath.startsWith("~/");
  }
  return path.isAbsolute(trimmedPath);
}

function toComparablePath(normalizedPath: string): ComparablePath {
  if (normalizedPath === "~") {
    return {
      kind: "home",
      value: "/__mux_home__",
    };
  }

  if (normalizedPath.startsWith("~/")) {
    return {
      kind: "home",
      value: path.posix.join("/__mux_home__", normalizedPath.slice(2)),
    };
  }

  return {
    kind: "absolute",
    value: normalizedPath,
  };
}

function isWithinAllowedRoot(
  allowedRoot: ComparablePath,
  targetPath: ComparablePath,
  pathModule: RuntimePathModule
): boolean {
  if (allowedRoot.kind !== targetPath.kind) {
    return false;
  }

  const relativePath = pathModule.relative(allowedRoot.value, targetPath.value);
  return !relativePath.startsWith("..") && !pathModule.isAbsolute(relativePath);
}

/**
 * Validates that a file path is within the allowed working directory.
 * Returns an error object if the path is outside cwd (and any optional allowlisted roots),
 * null if valid.
 *
 * @param filePath - The file path to validate (can be relative or absolute)
 * @param cwd - The working directory that file operations are restricted to
 * @param runtime - The runtime whose path semantics should be used for validation
 * @param extraAllowedDirs - Additional absolute directories that are allowlisted for access.
 * Note: this is a lexical containment check on normalized paths; it does not resolve symlink targets.
 * @returns Error object if invalid, null if valid
 */
export function validatePathInCwd(
  filePath: string,
  cwd: string,
  runtime: Runtime,
  extraAllowedDirs: string[] = []
): { error: string } | null {
  const trimmedExtraAllowedDirs = extraAllowedDirs
    .map((dir) => dir.trim())
    .filter((dir) => dir.length > 0);
  const pathModule = getRuntimePathModule(runtime);

  // extraAllowedDirs are an internal allowlist (e.g., stream-scoped runtimeTempDir).
  // For safety, require absolute paths so misconfiguration doesn't widen access.
  for (const dir of trimmedExtraAllowedDirs) {
    assert(
      isRuntimeAbsolutePath(dir, runtime),
      `extraAllowedDir must be an absolute path: '${dir}'`
    );
  }

  const normalizedCwd = runtime.normalizePath(".", cwd);
  const normalizedPath = runtime.normalizePath(filePath, normalizedCwd);
  const filePathIsAbsolute = isRuntimeAbsolutePath(filePath, runtime);
  const comparablePath = toComparablePath(normalizedPath);

  // Only allow extraAllowedDirs when the caller provides an absolute path.
  // This prevents relative-path escapes (e.g., ../...) from bypassing cwd restrictions.
  const allowedRoots = [normalizedCwd, ...(filePathIsAbsolute ? trimmedExtraAllowedDirs : [])].map(
    (dir) => toComparablePath(runtime.normalizePath(dir, normalizedCwd))
  );

  const isWithinRoot = allowedRoots.some((root) =>
    isWithinAllowedRoot(root, comparablePath, pathModule)
  );

  if (!isWithinRoot) {
    return {
      error: `File operations are restricted to the workspace directory (${normalizedCwd}). The path '${filePath}' resolves outside this directory. If you need to modify files outside the workspace, please ask the user for permission first.`,
    };
  }

  return null;
}

/**
 * Resolve a file-tool path after applying redundant-prefix auto-correction.
 *
 * Despite the historical name, this helper no longer enforces a cwd boundary.
 * Bash already exposes unrestricted filesystem access, so file tools should resolve
 * the exact path the user asked us to touch instead of imposing a stricter
 * workspace-only rule.
 */
export async function resolvePathWithinCwd(
  filePath: string,
  cwd: string,
  runtime: Runtime
): Promise<{ correctedPath: string; resolvedPath: string; warning?: string }> {
  const redundantPrefixResult = validateNoRedundantPrefix(filePath, cwd, runtime);
  const correctedPath = redundantPrefixResult?.correctedPath ?? filePath;
  const trimmedPath = correctedPath.trim();

  // A Dev Container's home belongs to its remote user, not the Mux host process.
  // Resolve tilde paths through the runtime so a tool never leaks host HOME into a
  // command that will execute inside the container.
  const resolvedPath =
    trimmedPath === "~" || trimmedPath.startsWith("~/")
      ? await runtime.resolvePath(correctedPath)
      : runtime.normalizePath(correctedPath, cwd);

  return {
    correctedPath,
    resolvedPath,
    warning: redundantPrefixResult?.warning,
  };
}
