import * as fsPromises from "fs/promises";
import * as path from "path";

import type { Runtime } from "@/node/runtime/Runtime";
import { execBuffered } from "@/node/utils/runtime/helpers";

import { quoteRuntimeProbePath } from "./runtimePathShellQuote";
import { inspectContainmentOnRuntime } from "./runtimeSkillPathUtils";
import { hasErrorCode, isPathInsideRoot } from "./skillFileUtils";

export type ResolvedAgentsPath =
  | { kind: "missing"; rootReal: string; writePath: string }
  | { kind: "existing"; rootReal: string; realPath: string }
  | { kind: "error"; error: string };

export async function resolveAgentsPathWithinRoot(agentsRoot: string): Promise<ResolvedAgentsPath> {
  let rootReal: string;
  try {
    rootReal = await fsPromises.realpath(agentsRoot);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      // Root directory does not exist yet (for example, first run or ~/.xum removed).
      // Treat it as a missing AGENTS.md so callers can recover by returning empty content
      // or creating the directory before writing.
      return {
        kind: "missing",
        rootReal: agentsRoot,
        writePath: path.join(agentsRoot, "AGENTS.md"),
      };
    }
    throw error;
  }

  const candidate = path.join(rootReal, "AGENTS.md");

  try {
    const realPath = await fsPromises.realpath(candidate);
    if (!isPathInsideRoot(rootReal, realPath)) {
      return { kind: "error", error: "Refusing AGENTS.md path (path escapes expected root)" };
    }
    return { kind: "existing", rootReal, realPath };
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }

    // ENOENT can mean either missing file OR dangling symlink target.
    const linkStat = await fsPromises.lstat(candidate).catch(() => null);
    if (linkStat?.isSymbolicLink()) {
      return { kind: "error", error: "Refusing AGENTS.md dangling symlink" };
    }

    return { kind: "missing", rootReal, writePath: candidate };
  }
}

type RuntimePathState =
  | { kind: "dangling" }
  | { kind: "existing" }
  | { kind: "missing" }
  | { kind: "error"; error: string };

async function probeRuntimePathState(
  runtime: Runtime,
  filePath: string,
  cwd: string
): Promise<RuntimePathState> {
  const quotedPath = quoteRuntimeProbePath(filePath);
  const probe = await execBuffered(
    runtime,
    `if [ -L ${quotedPath} ] && [ ! -e ${quotedPath} ]; then echo __MUX_DANGLING__; elif [ -e ${quotedPath} ]; then echo __MUX_EXISTS__; else echo __MUX_MISSING__; fi`,
    { cwd, timeout: 5 }
  );

  if (probe.exitCode !== 0) {
    // Treat transport/shell failures as probe errors instead of "missing" so callers do not
    // recreate AGENTS.md during transient runtime instability.
    const details = probe.stderr.trim() || probe.stdout.trim() || `exit code ${probe.exitCode}`;
    return { kind: "error", error: `Runtime AGENTS.md probe failed: ${details}` };
  }

  const output = probe.stdout.trim();
  if (output === "__MUX_DANGLING__") {
    return { kind: "dangling" };
  }
  if (output === "__MUX_EXISTS__") {
    return { kind: "existing" };
  }
  if (output === "__MUX_MISSING__") {
    return { kind: "missing" };
  }
  return {
    kind: "error",
    error: `Runtime AGENTS.md probe returned unexpected output: ${JSON.stringify(probe.stdout)}`,
  };
}

/**
 * Runtime equivalent of resolveAgentsPathWithinRoot.
 * Uses portable runtime containment probes so symlink checks match runtime write behavior
 * across GNU and BSD shells.
 */
export async function resolveAgentsPathOnRuntime(
  runtime: Runtime,
  workspacePath: string
): Promise<ResolvedAgentsPath> {
  const agentsPath = runtime.normalizePath("AGENTS.md", workspacePath);
  const state = await probeRuntimePathState(runtime, agentsPath, workspacePath);

  if (state.kind === "error") {
    return { kind: "error", error: state.error };
  }

  if (state.kind === "dangling") {
    return { kind: "error", error: "Refusing AGENTS.md dangling symlink" };
  }

  if (state.kind === "missing") {
    return { kind: "missing", rootReal: workspacePath, writePath: agentsPath };
  }

  // Portable containment check matching runtimeSkillPathUtils patterns.
  let candidatePath = agentsPath;
  const visitedPaths = new Set<string>();

  for (let depth = 0; depth < 40; depth += 1) {
    if (visitedPaths.has(candidatePath)) {
      return { kind: "error", error: "Refusing AGENTS.md path (cannot resolve)" };
    }
    visitedPaths.add(candidatePath);

    const containment = await inspectContainmentOnRuntime(runtime, workspacePath, candidatePath);
    if (!containment.withinRoot) {
      return { kind: "error", error: "Refusing AGENTS.md path (path escapes workspace root)" };
    }
    if (!containment.leafSymlink) {
      return { kind: "existing", rootReal: workspacePath, realPath: candidatePath };
    }

    const linkResult = await execBuffered(
      runtime,
      `readlink ${quoteRuntimeProbePath(candidatePath)}`,
      {
        cwd: workspacePath,
        timeout: 5,
      }
    );
    const linkTarget = linkResult.stdout.trim();
    if (linkResult.exitCode !== 0 || !linkTarget) {
      return { kind: "error", error: "Refusing AGENTS.md path (cannot resolve)" };
    }

    candidatePath = runtime.normalizePath(linkTarget, path.posix.dirname(candidatePath));
  }

  return { kind: "error", error: "Refusing AGENTS.md path (cannot resolve)" };
}
