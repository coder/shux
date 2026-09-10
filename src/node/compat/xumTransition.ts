import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  LEGACY_CMUX_HOME_DIR_NAME,
  LEGACY_MUX_HOME_DIR_NAME,
  LEGACY_MUX_PRODUCT_NAME,
  LEGACY_MUX_PRODUCT_SLUG,
  assignXumEnvironmentValue,
  getXumHomeLegacyFallbackMarkerPath,
  installLegacyMuxEnvironmentAliases,
  parseXumHomeLegacyFallbackDirName,
  resolveXumEnvironmentValue,
  type XumEnvironment,
} from "@/common/compat/legacyMux";
import { getElectronAppIdentity } from "@/common/compat/electronAppIdentity";
import { XUM_HOME_DIR_NAME } from "@/common/constants/product";

export type XumTransitionStatus = "canonical" | "migrated" | "legacy-fallback" | "conflict";

export interface XumDirectoryTransitionResult {
  canonicalPath: string;
  activePath: string;
  status: XumTransitionStatus;
  issues: string[];
}

interface XumDirectoryTransitionOptions {
  canonicalPath: string;
  legacyPaths: string[];
  platform?: NodeJS.Platform;
}

interface XumHomeTransitionOptions {
  env?: XumEnvironment;
  homeDir?: string;
  nodeEnv?: string;
  platform?: NodeJS.Platform;
}

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * True only for a usable directory tree. Broken aliases and non-directories must
 * not be renamed into the canonical path as if they were migratable data.
 */
async function isHealthyDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isEmptyRealDirectory(path: string): Promise<boolean> {
  try {
    const stats = await fs.lstat(path);
    // Junctions/symlinks can look directory-like after stat(); only replace a real empty dir.
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return false;
    }
    return (await fs.readdir(path)).length === 0;
  } catch {
    return false;
  }
}

async function directoryHasEntries(path: string): Promise<boolean> {
  try {
    return (await fs.readdir(path)).length > 0;
  } catch {
    // Unreadable trees are treated as populated so we never adopt them as empty.
    return true;
  }
}

async function pathsResolveToSameEntry(left: string, right: string): Promise<boolean> {
  try {
    return (await fs.realpath(left)) === (await fs.realpath(right));
  } catch {
    return false;
  }
}

function dedupeResolvedPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of paths) {
    const key = resolve(path);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(path);
  }
  return unique;
}

async function sameExistingEntry(left: string, right: string): Promise<boolean> {
  return resolve(left) === resolve(right) || (await pathsResolveToSameEntry(left, right));
}

async function findFirstHealthyDirectory(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    if (await isHealthyDirectory(path)) {
      return path;
    }
  }
  return undefined;
}

function recordUnusableCanonical(canonicalPath: string, issues: string[]): void {
  const issue = `${canonicalPath} exists but is not a usable directory`;
  if (!issues.includes(issue)) {
    issues.push(issue);
  }
}

/**
 * Prefer a healthy leftover tree. If none exists, create the first missing
 * legacy path so callers never receive a file or broken symlink as activePath.
 */
async function resolveLegacyFallbackPath(
  legacyPaths: string[],
  issues: string[]
): Promise<string | undefined> {
  const healthyPath = await findFirstHealthyDirectory(legacyPaths);
  if (healthyPath) {
    return healthyPath;
  }

  for (const fallbackPath of legacyPaths) {
    if (await pathEntryExists(fallbackPath)) {
      continue;
    }
    try {
      await fs.mkdir(fallbackPath, { recursive: true });
    } catch (error) {
      issues.push(`Could not create fallback ${fallbackPath}: ${String(error)}`);
      continue;
    }
    if (await isHealthyDirectory(fallbackPath)) {
      return fallbackPath;
    }
    issues.push(`Created fallback ${fallbackPath} but it is still not a usable directory`);
  }

  return undefined;
}

async function nextUnusedSiblingPath(path: string, label: string): Promise<string> {
  const stamp = Date.now();
  let suffix = 0;
  while (true) {
    const candidate =
      suffix === 0 ? `${path}.${label}-${stamp}` : `${path}.${label}-${stamp}-${suffix}`;
    if (!(await pathEntryExists(candidate))) {
      return candidate;
    }
    suffix += 1;
  }
}

/**
 * Move a file or broken alias aside without deleting it. Healthy directories
 * are never touched. Returns true when `path` is missing or was moved aside.
 */
async function quarantineUnusableEntry(path: string, issues: string[]): Promise<boolean> {
  if (!(await pathEntryExists(path))) {
    return true;
  }
  if (await isHealthyDirectory(path)) {
    return false;
  }

  const backupPath = await nextUnusedSiblingPath(path, "obstructed");
  try {
    await fs.rename(path, backupPath);
    issues.push(`Moved unusable ${path} aside to ${backupPath} so a directory could be created`);
    return true;
  } catch (error) {
    issues.push(`Could not move unusable ${path} aside: ${String(error)}`);
    return false;
  }
}

async function recoverDirectoryAt(path: string, issues: string[]): Promise<boolean> {
  if (await isHealthyDirectory(path)) {
    return true;
  }
  if (!(await quarantineUnusableEntry(path, issues))) {
    return false;
  }
  try {
    await fs.mkdir(path, { recursive: true });
  } catch (error) {
    issues.push(`Could not create ${path}: ${String(error)}`);
    return false;
  }
  if (await isHealthyDirectory(path)) {
    return true;
  }
  issues.push(`Created ${path} but it is still not a usable directory`);
  return false;
}

/**
 * Reclaim the standard canonical name when every leftover name is also a file
 * or broken alias. Leftover obstructors are moved aside so downgrade aliases
 * can be created. User entries are renamed, never deleted or overwritten.
 */
async function recoverObstructedCanonical(
  canonicalPath: string,
  legacyPaths: string[],
  issues: string[]
): Promise<boolean> {
  if (!(await recoverDirectoryAt(canonicalPath, issues))) {
    return false;
  }
  for (const legacyPath of legacyPaths) {
    if (await isHealthyDirectory(legacyPath)) {
      continue;
    }
    if (await pathEntryExists(legacyPath)) {
      await quarantineUnusableEntry(legacyPath, issues);
    }
  }
  return true;
}

async function requireHealthyDirectory(path: string, issues: string[]): Promise<string> {
  if (await isHealthyDirectory(path)) {
    return path;
  }
  const detail = issues.length > 0 ? `: ${issues.join("; ")}` : "";
  throw new Error(`No usable xum directory is available at ${path}${detail}`);
}

/**
 * Case-insensitive volumes expose `mux` and `Mux` as one directory. Count that
 * as a single tree so we migrate once instead of reporting a false conflict.
 */
async function findSolePopulatedIndependentLegacy(
  legacyPaths: string[],
  canonicalPath: string
): Promise<string | undefined> {
  const populated: string[] = [];
  for (const legacyPath of legacyPaths) {
    if (!(await isHealthyDirectory(legacyPath)) || !(await directoryHasEntries(legacyPath))) {
      continue;
    }
    if (await sameExistingEntry(legacyPath, canonicalPath)) {
      continue;
    }
    let alreadyCounted = false;
    for (const existing of populated) {
      if (await sameExistingEntry(existing, legacyPath)) {
        alreadyCounted = true;
        break;
      }
    }
    if (alreadyCounted) {
      continue;
    }
    populated.push(legacyPath);
  }
  return populated.length === 1 ? populated[0] : undefined;
}

async function createDirectoryAlias(
  targetPath: string,
  aliasPath: string,
  platform: NodeJS.Platform
): Promise<void> {
  // Windows directory junctions do not require Developer Mode or elevation, unlike
  // ordinary directory symlinks. Absolute targets also avoid cwd-dependent junctions.
  // Linux/macOS tests may pass platform "win32" to assert this argv contract; that
  // does not prove NTFS junction semantics.
  await fs.symlink(resolve(targetPath), aliasPath, platform === "win32" ? "junction" : "dir");
}

interface CompatibilityAliasOptions {
  canonicalPath: string;
  legacyPaths: string[];
  platform: NodeJS.Platform;
  issues: string[];
  migratedFrom: string | undefined;
  createdCanonical: boolean;
}

async function applyCompatibilityAliases(
  options: CompatibilityAliasOptions
): Promise<XumDirectoryTransitionResult | undefined> {
  const canonicalUsableForAliases = await isHealthyDirectory(options.canonicalPath);

  for (const legacyPath of options.legacyPaths) {
    if (await pathEntryExists(legacyPath)) {
      if (!(await sameExistingEntry(legacyPath, options.canonicalPath))) {
        options.issues.push(
          `Both ${legacyPath} and ${options.canonicalPath} exist independently; left both unchanged`
        );
      }
      continue;
    }

    if (!canonicalUsableForAliases) {
      // Compatibility aliases must point at a real directory, never a file.
      continue;
    }

    try {
      await createDirectoryAlias(options.canonicalPath, legacyPath, options.platform);
    } catch (error) {
      options.issues.push(`Could not create compatibility alias ${legacyPath}: ${String(error)}`);

      // If this run just moved or created the canonical directory, roll it back to
      // the primary legacy path rather than strand existing users without a path an
      // older binary can open. A pre-existing canonical directory is never moved.
      const primaryLegacyPath = options.legacyPaths[0];
      if (
        (options.migratedFrom != null || options.createdCanonical) &&
        legacyPath === primaryLegacyPath
      ) {
        try {
          await fs.rename(options.canonicalPath, primaryLegacyPath);
          return {
            canonicalPath: options.canonicalPath,
            activePath: await requireHealthyDirectory(primaryLegacyPath, options.issues),
            status: "legacy-fallback",
            issues: options.issues,
          };
        } catch (rollbackError) {
          options.issues.push(
            `Could not roll back to ${primaryLegacyPath}: ${String(rollbackError)}`
          );
        }
      }
    }
  }

  return undefined;
}

/**
 * Move a legacy directory to its canonical xum path and leave old-name directory
 * aliases pointing forward. Older mux builds therefore keep reading and writing the
 * same files after an upgrade and subsequent downgrade.
 *
 * This function is deliberately non-destructive: independent populated paths are
 * reported as conflicts rather than merged, replaced, or deleted.
 */
export async function ensureXumDirectoryTransition(
  options: XumDirectoryTransitionOptions
): Promise<XumDirectoryTransitionResult> {
  const platform = options.platform ?? process.platform;
  const issues: string[] = [];
  const canonicalPath = options.canonicalPath;
  const legacyPaths = dedupeResolvedPaths(options.legacyPaths);
  const canonicalExistedInitially = await pathEntryExists(canonicalPath);
  let migratedFrom: string | undefined;
  let createdCanonical = false;

  if (!canonicalExistedInitially) {
    const sourcePath = await findFirstHealthyDirectory(legacyPaths);

    if (sourcePath) {
      try {
        await fs.rename(sourcePath, canonicalPath);
        migratedFrom = sourcePath;
      } catch (error) {
        issues.push(`Could not move ${sourcePath} to ${canonicalPath}: ${String(error)}`);
        return {
          canonicalPath,
          activePath: await requireHealthyDirectory(sourcePath, issues),
          status: "legacy-fallback",
          issues,
        };
      }
    } else {
      try {
        await fs.mkdir(canonicalPath, { recursive: true });
        createdCanonical = true;
      } catch (error) {
        issues.push(`Could not create ${canonicalPath}: ${String(error)}`);
        const fallbackPath = await resolveLegacyFallbackPath(legacyPaths, issues);
        if (fallbackPath != null) {
          return {
            canonicalPath,
            activePath: await requireHealthyDirectory(fallbackPath, issues),
            status: "legacy-fallback",
            issues,
          };
        }
        if (await recoverObstructedCanonical(canonicalPath, legacyPaths, issues)) {
          createdCanonical = true;
        } else {
          for (const leftoverPath of legacyPaths) {
            if (await recoverDirectoryAt(leftoverPath, issues)) {
              return {
                canonicalPath,
                activePath: await requireHealthyDirectory(leftoverPath, issues),
                status: "legacy-fallback",
                issues,
              };
            }
          }
          throw new Error(
            `Could not create a usable directory at ${canonicalPath} or any leftover path: ${issues.join("; ")}`
          );
        }
      }
    }
  } else if (!(await isHealthyDirectory(canonicalPath))) {
    // A regular file or broken symlink is not migratable storage. Prefer a
    // healthy leftover; only quarantine the obstruction when no usable path remains.
    recordUnusableCanonical(canonicalPath, issues);
  } else if (await isEmptyRealDirectory(canonicalPath)) {
    // An empty canonical dir plus one populated legacy tree is a leftover split
    // (Electron may mkdir the new app name before we run). Adopt the legacy tree
    // instead of leaving two independent homes. Two populated trees stay conflicts.
    const sourcePath = await findSolePopulatedIndependentLegacy(legacyPaths, canonicalPath);
    if (sourcePath) {
      try {
        await fs.rmdir(canonicalPath);
        await fs.rename(sourcePath, canonicalPath);
        migratedFrom = sourcePath;
      } catch (error) {
        // Adoption can fail after Electron creates an empty canonical dir (Windows
        // locks are the usual case). Keep or restore that empty directory so a later
        // startup can retry, but activate the populated leftover instead of an empty home.
        issues.push(`Could not move ${sourcePath} into empty ${canonicalPath}: ${String(error)}`);
        if (!(await pathEntryExists(canonicalPath))) {
          try {
            await fs.mkdir(canonicalPath, { recursive: true });
          } catch (restoreError) {
            issues.push(`Could not restore ${canonicalPath}: ${String(restoreError)}`);
          }
        }
        return {
          canonicalPath,
          activePath: await requireHealthyDirectory(sourcePath, issues),
          status: "legacy-fallback",
          issues,
        };
      }
    }
  }

  if (await isHealthyDirectory(canonicalPath)) {
    const aliasResult = await applyCompatibilityAliases({
      canonicalPath,
      legacyPaths,
      platform,
      issues,
      migratedFrom,
      createdCanonical,
    });
    if (aliasResult) {
      return aliasResult;
    }
  }

  // conflict keeps a usable canonical tree active. If canonical is not a
  // directory, prefer the first healthy leftover, then reclaim the standard
  // names by quarantining files/broken aliases. Never return a non-directory.
  if (!(await isHealthyDirectory(canonicalPath))) {
    recordUnusableCanonical(canonicalPath, issues);
    const fallbackPath = await resolveLegacyFallbackPath(legacyPaths, issues);
    if (fallbackPath != null) {
      return {
        canonicalPath,
        activePath: await requireHealthyDirectory(fallbackPath, issues),
        status: "legacy-fallback",
        issues,
      };
    }
    if (await recoverObstructedCanonical(canonicalPath, legacyPaths, issues)) {
      createdCanonical = true;
      const recoveredAliasResult = await applyCompatibilityAliases({
        canonicalPath,
        legacyPaths,
        platform,
        issues,
        migratedFrom,
        createdCanonical,
      });
      if (recoveredAliasResult) {
        return recoveredAliasResult;
      }
    } else {
      for (const leftoverPath of legacyPaths) {
        if (await recoverDirectoryAt(leftoverPath, issues)) {
          return {
            canonicalPath,
            activePath: await requireHealthyDirectory(leftoverPath, issues),
            status: "legacy-fallback",
            issues,
          };
        }
      }
      throw new Error(
        `Could not create a usable directory at ${canonicalPath} or any leftover path: ${issues.join("; ")}`
      );
    }
  }

  const hasConflict = issues.some((issue) => issue.includes("exist independently"));
  return {
    canonicalPath,
    activePath: await requireHealthyDirectory(canonicalPath, issues),
    status: hasConflict ? "conflict" : migratedFrom ? "migrated" : "canonical",
    issues,
  };
}

export async function initializeXumUserDataTransition(options: {
  appDataDir: string;
  platform?: NodeJS.Platform;
}): Promise<XumDirectoryTransitionResult> {
  // Linux Chromium userData used the case-sensitive product name `Mux` while
  // other platforms stored `mux`. Include both and let same-entry dedupe keep
  // case-insensitive volumes from treating them as two trees.
  // Canonical userData is always the lowercase slug, even when app.setName() is
  // display-cased on macOS/Windows.
  const { userDataDirName } = getElectronAppIdentity(options.platform ?? process.platform);
  return await ensureXumDirectoryTransition({
    canonicalPath: join(options.appDataDir, userDataDirName),
    legacyPaths: [
      join(options.appDataDir, LEGACY_MUX_PRODUCT_SLUG),
      join(options.appDataDir, LEGACY_MUX_PRODUCT_NAME),
    ],
    platform: options.platform,
  });
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error != null && "code" in error && error.code === "ENOENT";
}

/**
 * Record the selected leftover name beside ~/.xum so independent processes
 * (VS Code) can follow the fallback without running this mutating transition.
 * Contents are only a known leftover directory name, never an arbitrary path.
 */
async function persistDefaultHomeLegacyFallbackMarker(
  homeDir: string,
  suffix: string,
  activePath: string,
  issues: string[]
): Promise<void> {
  const dirName = parseXumHomeLegacyFallbackDirName(basename(activePath), suffix);
  if (dirName == null) {
    issues.push(`Refusing to persist an unknown leftover home name for ${activePath}`);
    return;
  }

  const markerPath = getXumHomeLegacyFallbackMarkerPath(homeDir, suffix);
  const tempPath = `${markerPath}.${process.pid}-${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${dirName}\n`, "utf8");
    await fs.rename(tempPath, markerPath);
  } catch (error) {
    issues.push(`Could not persist leftover-home marker ${markerPath}: ${String(error)}`);
    try {
      await fs.unlink(tempPath);
    } catch {
      // Best-effort cleanup of the temp file; startup must continue.
    }
  }
}

async function clearDefaultHomeLegacyFallbackMarker(
  homeDir: string,
  suffix: string,
  issues: string[]
): Promise<void> {
  const markerPath = getXumHomeLegacyFallbackMarkerPath(homeDir, suffix);
  try {
    await fs.unlink(markerPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    issues.push(`Could not remove leftover-home marker ${markerPath}: ${String(error)}`);
  }
}

/**
 * Initialize the default ~/.xum storage transition.
 * Explicit XUM_ROOT / MUX_ROOT locations are never moved, created, or aliased.
 */
export async function initializeXumHomeTransition(
  options: XumHomeTransitionOptions = {}
): Promise<XumDirectoryTransitionResult> {
  const env = options.env ?? process.env;
  installLegacyMuxEnvironmentAliases(env);

  const explicitRoot = resolveXumEnvironmentValue("ROOT", env);
  if (explicitRoot) {
    return {
      canonicalPath: explicitRoot,
      activePath: explicitRoot,
      status: "canonical",
      issues: [],
    };
  }

  const homeDir = options.homeDir ?? homedir();
  const suffix = (options.nodeEnv ?? env.NODE_ENV) === "development" ? "-dev" : "";
  const canonicalPath = join(homeDir, XUM_HOME_DIR_NAME + suffix);
  const legacyPaths = [join(homeDir, LEGACY_MUX_HOME_DIR_NAME + suffix)];
  if (!suffix) {
    legacyPaths.push(join(homeDir, LEGACY_CMUX_HOME_DIR_NAME));
  }

  const result = await ensureXumDirectoryTransition({
    canonicalPath,
    legacyPaths,
    platform: options.platform,
  });

  if (result.status === "legacy-fallback") {
    // Session-scoped ROOT aliases keep this process and its children on the leftover.
    // The sibling marker is for independent processes that only call getXumHome().
    assignXumEnvironmentValue(env, "ROOT", result.activePath);
    await persistDefaultHomeLegacyFallbackMarker(homeDir, suffix, result.activePath, result.issues);
  } else {
    await clearDefaultHomeLegacyFallbackMarker(homeDir, suffix, result.issues);
  }

  return result;
}
