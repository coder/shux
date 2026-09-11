/**
 * Legacy-notebook adoption manifest: the durable record of which files of a
 * sub-agent's PRE-SHARING private notebook (`<childSession>/memory`, written by
 * builds that kept `/memories/workspace` per workspace) were folded into the
 * task-tree owner's shared store, and where each landed
 * (MemoryService.adoptLegacyPrivateStore). Shared with the refinement
 * rollback engine: refinement rows journaled before the upgrade address the
 * legacy files, while the note the user sees since is the owner copy.
 */
import type { Dirent } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { RefinementInverse } from "@/common/types/refinement";

/**
 * File in the sub-agent's SESSION dir (beside its legacy `memory` dir, never
 * inside it) recording, per relPath, the sha256 of the content already copied
 * into the shared store (adoptLegacyPrivateStore). Outside the legacy root on
 * purpose: everything under `<childSession>/memory` is the model-writable
 * `/memories/workspace` namespace of a downgraded build (the path grammar
 * admits dotfiles), and this manifest's `created`/`target`/hash fields are
 * trusted as provenance — a fabricated settled record with an absent source
 * would make deletion reconciliation remove a matching owner note. The
 * session dir itself is not addressable through any memory path.
 */
export const LEGACY_ADOPTION_MANIFEST_FILE_NAME = "memory-adoption-manifest.json";

export function legacyAdoptionManifestPath(childSessionDir: string): string {
  return path.join(childSessionDir, LEGACY_ADOPTION_MANIFEST_FILE_NAME);
}

/**
 * One adopted legacy file: content hash, child sidecar fingerprint, owner-store
 * relPath, and whether the adoption CREATED that owner file (provenance: only
 * such a copy may be removed again when the legacy source disappears; a
 * pre-existing identical owner note is the owner's own). `pending`: written
 * BEFORE the copy lands (provenance must not depend on the copy's existence: a
 * retry finding the bytes already at the target could not tell an interrupted
 * adoption from an owner note); cleared once the sidecar fold completed.
 */
export interface LegacyAdoptionRecord {
  content: string;
  sidecar: string;
  target: string;
  created?: boolean;
  pending?: boolean;
  /**
   * Identity of the owner file this adoption wrote (`ino:size:mtimeNs` right
   * after the write). Deletion reconciliation requires the copy to be THIS
   * generation of the file, not merely to hold the adopted bytes: an owner
   * who deleted and recreated (or edited and restored) the note to identical
   * bytes owns the new file, and a byte match alone would let a downgraded
   * child's source deletion remove it. Absent (write before stamping, or the
   * stamp could not be taken): never unchanged — the copy is preserved.
   */
  targetStamp?: string;
  /**
   * The copy this adoption created was since replaced outside it (rewritten,
   * or deleted and recreated to identical bytes: `targetStamp` no longer
   * matches), so the file is the owner's own. Kept apart from a note the
   * owner already had when it was first adopted (`created` never set): that
   * one still folds the child's pin toggles, a replaced copy never does —
   * `created` alone cannot tell the two apart once provenance is lost.
   */
  replaced?: boolean;
  /**
   * Hash of the bytes an in-place replacement is about to write (set on the
   * pending prior record, cleared once the pass completes). With `content`
   * (the pre-write bytes) this lets a retry recognize the copy as this
   * adoption's on either side of an interrupted write.
   */
  replacementContent?: string;
  /**
   * Reconciliation of a deleted source is under way: the copy is about to be
   * (or was just) removed. Set before the removal so a crash between the
   * removal and the tombstone write is recovered as "removed by us" rather
   * than "changed by the owner".
   */
  pendingDeletion?: boolean;
  /**
   * The legacy source was deleted (or renamed away) on a downgraded build and
   * the copy reconciled. Kept rather than dropped: the child's pre-sharing
   * refinement rows for this note (a delete's restore inverse, a rename's
   * mirrored rename) still address the legacy path and need the mapping to
   * be rolled back into the shared store; a reappearing source is adopted
   * afresh (the record's other fields are stale then).
   */
  deleted?: boolean;
}

/**
 * Parse one manifest record. Lifecycle flags are raw JSON: a value that is
 * neither absent nor boolean fails CLOSED — `pending`/`pendingDeletion` read
 * as set (the pass is redone), `created`/`deleted` as unset (no destructive
 * provenance; the source is reconciled as a plain unlisted note), `replaced`
 * as set (the child's pin no longer reaches the file) — so a corrupted flag
 * can never make an interrupted pass look settled.
 */
function parseLegacyAdoptionRecord(value: unknown): LegacyAdoptionRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.content !== "string" ||
    typeof record.sidecar !== "string" ||
    typeof record.target !== "string"
  ) {
    return null;
  }
  // A present but non-string replacement hash is a malformed RECORD (not a
  // flag to fail closed on): without it, a replacement pass that crashed
  // after writing the new owner bytes leaves a copy reconciliation cannot
  // recognize as this adoption's — a later source deletion would tombstone
  // it as owner-owned and removal would report a complete handover while the
  // adoption-created note stays visible without provenance.
  if (record.replacementContent !== undefined && typeof record.replacementContent !== "string") {
    return null;
  }
  if (record.targetStamp !== undefined && typeof record.targetStamp !== "string") return null;
  const flag = (raw: unknown, malformed: boolean): boolean | undefined =>
    raw === undefined ? undefined : typeof raw === "boolean" ? raw : malformed;
  return {
    content: record.content,
    sidecar: record.sidecar,
    target: record.target,
    created: flag(record.created, false),
    pending: flag(record.pending, true),
    pendingDeletion: flag(record.pendingDeletion, true),
    deleted: flag(record.deleted, false),
    replaced: flag(record.replaced, true),
    replacementContent: record.replacementContent,
    targetStamp: record.targetStamp,
  };
}

/**
 * Read of the adoption manifest. A MISSING file reads as "nothing adopted"
 * for every caller. Tolerant callers also read an unreadable (EACCES, EIO)
 * or malformed file — bad JSON, a non-object, a record missing its string
 * fields — as empty (self-healing: the next pass rewrites it). `strict`
 * callers throw on all of those: the adoption pass and the removal handover
 * decide what may be deleted on the manifest's authority, and an empty
 * substitute would drop provenance — a malformed record whose downgraded
 * source is already gone can no longer be reconciled (its target is in the
 * bad record), and removal would delete the child session while the
 * adoption-created owner copy stays visible for good. A Map, not a plain
 * object: a legacy note may
 * legitimately be named `__proto__` (any store-valid relPath), and assigning
 * that key on an ordinary object hits the prototype setter instead of
 * creating an entry the serialization would carry — the note would then be
 * re-adopted (and the owner clock advanced) on every access. JSON.parse and
 * Object.fromEntries create own properties, so the round-trip is exact.
 */
export async function readLegacyAdoptionManifest(
  manifestPath: string,
  options?: { strict?: boolean }
): Promise<Map<string, LegacyAdoptionRecord>> {
  let raw: string;
  try {
    raw = await fsPromises.readFile(manifestPath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (options?.strict === true && code !== "ENOENT" && code !== "ENOTDIR") throw error;
    return new Map();
  }
  const malformed = (detail: string): Map<string, LegacyAdoptionRecord> => {
    if (options?.strict === true) {
      throw new Error(`the legacy adoption manifest at ${manifestPath} is malformed (${detail})`);
    }
    return new Map();
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return malformed("not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return malformed("not an object");
  }
  const entries: Array<[string, LegacyAdoptionRecord]> = [];
  for (const [relPath, value] of Object.entries(parsed)) {
    const record = parseLegacyAdoptionRecord(value);
    if (record === null) return malformed(`record '${relPath}'`);
    entries.push([relPath, record]);
  }
  return new Map(entries);
}

/**
 * The file identity a LegacyAdoptionRecord.targetStamp records; null when the
 * file cannot be stat'ed (the record then carries no stamp: preserved).
 */
export async function adoptionTargetStamp(absPath: string): Promise<string | null> {
  try {
    const stat = await fsPromises.lstat(absPath, { bigint: true });
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  } catch {
    return null;
  }
}

/**
 * Every non-directory entry (files, symlinks, anything) under `absDir`,
 * recursively, as relPaths prefixed with `dirRel`; empty when the directory
 * is absent. Throws on any other traversal failure (the caller then refuses
 * rather than guess).
 */
async function listEntriesUnder(absDir: string, dirRel: string): Promise<Set<string>> {
  const found = new Set<string>();
  const walk = async (abs: string, rel: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fsPromises.readdir(abs, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw error;
    }
    for (const entry of entries) {
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(path.join(abs, entry.name), childRel);
      } else {
        found.add(childRel);
      }
    }
  };
  await walk(absDir, dirRel);
  return found;
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

/** Thrown for a legacy path the shared store does not represent (see below). */
export class LegacyPathNotAdoptedError extends Error {
  constructor(legacyPath: string, reason: "not-adopted" | "owner-owned" | "replaced") {
    super(
      reason === "owner-owned"
        ? `'${legacyPath}' addresses this sub-agent's pre-sharing private notebook; the shared workspace store holds an identical note the owner already had (adoption created nothing), so a rollback there would alter the owner's own note`
        : reason === "replaced"
          ? `'${legacyPath}' addresses this sub-agent's pre-sharing private notebook; its adopted copy in the shared workspace store was since replaced (rewritten, or deleted and recreated) outside this sub-agent's rows, so the file there is the owner's own and a rollback would alter or remove it`
          : `'${legacyPath}' addresses this sub-agent's pre-sharing private notebook, and that note was not folded into the shared workspace store (never adopted, or unplaceable there): the shared notebook does not show it, so rolling it back there would change nothing visible`
    );
    this.name = "LegacyPathNotAdoptedError";
  }
}

/**
 * Retargets refinement inverses (and any other recorded path) of a sub-agent
 * whose legacy private notebook was adopted into the owner's store: a path
 * under `<childSession>/memory` becomes the owner-store path its note was
 * folded into, so a rollback reverts the copy the shared notebook actually
 * serves rather than the hidden legacy file (which the next adoption pass
 * would re-import as a conflicting duplicate). Paths outside the legacy root
 * pass through unchanged. A legacy path the manifest does not know throws
 * LegacyPathNotAdoptedError — fail closed rather than mutate an invisible
 * file. So does a record the adoption did NOT create (`created` unset: the
 * owner already had an identical note of its own): the child's rows never
 * touched that file, and applying their inverses there — a create row's
 * delete-files in particular — would alter or remove the owner's own note.
 * Likewise a created record whose target is no longer THIS adoption's
 * generation of the file (`targetStamp`, the same rule deletion
 * reconciliation applies): an owner save is unjournaled and may keep the
 * bytes, so neither peer rows nor post-state hashes would notice — the
 * replacement is the owner's, and the mapping is refused (r74). The stamps
 * are read when the remapper is created; callers create it under the store's
 * mutation lock (the rollback engine re-derives it there), and the engine
 * re-stamps the targets its own retargeted applies rewrite
 * (refreshLegacyAdoptionTargetStamps) so the child's remaining rows for the
 * same note stay mappable.
 * Only the manifest's `target` is trusted for the destination's relPath;
 * callers re-run their confinement checks on the mapped result. `strict`
 * (removal's row migration) throws on an unreadable manifest instead of
 * treating every legacy path as unadopted.
 */
export async function createLegacyPathRemapper(args: {
  childSessionDir: string;
  ownerSessionDir: string;
  strict?: boolean;
}): Promise<{
  path(filePath: string): string;
  inverse(inverse: RefinementInverse): RefinementInverse;
}> {
  const legacyRoot = path.join(path.resolve(args.childSessionDir), "memory");
  const ownerRoot = path.join(path.resolve(args.ownerSessionDir), "memory");
  const adopted = await readLegacyAdoptionManifest(
    legacyAdoptionManifestPath(path.resolve(args.childSessionDir)),
    { strict: args.strict === true }
  );
  // Directory endpoints (pre-sharing directory renames) map only when the
  // owner's on-disk subtree is EXACTLY the adopted descendants: a structural
  // rename moves whatever is there, so an owner note added beside the
  // adopted copies (no refinement row of its own) would travel along
  // unnoticed. Precomputed for every directory prefix the manifest knows.
  // Created records whose owner target is still this lineage's generation
  // (see LegacyAdoptionRecord.targetStamp). A record reconciled as deleted
  // is current while its target stays absent — or holds the generation a
  // retargeted rollback recreated there (re-stamped below); anything else at
  // that path is the owner's.
  // Value: whether that generation is a file on disk (a tombstoned record
  // whose copy a rollback restored counts as present).
  const currentGeneration = new Map<string, "present" | "absent">();
  for (const [rel, record] of adopted) {
    if (record.created !== true || record.pending === true) continue;
    const stamp = await adoptionTargetStamp(path.join(ownerRoot, ...record.target.split("/")));
    if (record.targetStamp !== undefined && stamp === record.targetStamp) {
      currentGeneration.set(rel, "present");
    } else if (record.deleted === true && stamp === null) {
      currentGeneration.set(rel, "absent");
    }
  }
  const ownerSubtreeExact = new Map<string, boolean>();
  const directoryPrefixes = new Set<string>();
  for (const rel of adopted.keys()) {
    const parts = rel.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      directoryPrefixes.add(parts.slice(0, depth).join("/"));
    }
  }
  for (const dirRel of directoryPrefixes) {
    const descendants = [...adopted].filter(([rel]) => rel.startsWith(`${dirRel}/`));
    const oneToOne = descendants.every(
      ([rel, entry]) => entry.target === rel && currentGeneration.has(rel)
    );
    const expected = new Set(
      descendants.filter(([rel]) => currentGeneration.get(rel) === "present").map(([rel]) => rel)
    );
    ownerSubtreeExact.set(
      dirRel,
      oneToOne &&
        setsEqual(
          expected,
          await listEntriesUnder(path.join(ownerRoot, ...dirRel.split("/")), dirRel)
        )
    );
  }
  const legacyRelPath = (filePath: string): string | null => {
    const relative = path.relative(legacyRoot, path.resolve(filePath));
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return relative.split(path.sep).join("/");
  };
  const remapPath = (filePath: string): string => {
    const relPath = legacyRelPath(filePath);
    if (relPath === null) return filePath;
    const record = adopted.get(relPath);
    if (record === undefined) {
      // A directory endpoint (a pre-sharing directory rename): the manifest
      // records files only. Mappable when every adopted descendant landed at
      // its own relPath in the owner store as this adoption's copy — the
      // owner directory then IS the adopted directory. Descendants placed
      // elsewhere (conflict imports) or owner-owned make the structural
      // move ambiguous: refused.
      if (ownerSubtreeExact.get(relPath) === true) {
        return path.join(ownerRoot, ...relPath.split("/"));
      }
      throw new LegacyPathNotAdoptedError(filePath, "not-adopted");
    }
    if (record.pending === true) throw new LegacyPathNotAdoptedError(filePath, "not-adopted");
    if (record.created !== true) throw new LegacyPathNotAdoptedError(filePath, "owner-owned");
    if (!currentGeneration.has(relPath)) throw new LegacyPathNotAdoptedError(filePath, "replaced");
    return path.join(ownerRoot, ...record.target.split("/"));
  };
  // The destination of a rename INVERSE is the name the child's rename
  // vacated. A rename made before the first upgrade leaves no record for it
  // (adoption saw only the post-rename names), yet the row is still
  // rollbackable once its `from` side maps (r75): the vacated name lands
  // beside the adopted copies. The engine requires it absent before moving,
  // so an owner note there refuses like for any rename.
  const remapRenameDestination = (filePath: string): string => {
    const relPath = legacyRelPath(filePath);
    if (relPath === null || adopted.has(relPath) || directoryPrefixes.has(relPath)) {
      return remapPath(filePath);
    }
    return path.join(ownerRoot, ...relPath.split("/"));
  };
  return {
    path: remapPath,
    inverse: (inverse) => {
      switch (inverse.op) {
        case "delete-files":
          return { ...inverse, paths: inverse.paths.map(remapPath) };
        case "rename": {
          const from = remapPath(inverse.from);
          return { ...inverse, from, to: remapRenameDestination(inverse.to) };
        }
        case "restore-files":
          return {
            ...inverse,
            files: inverse.files.map((file) => ({ ...file, path: remapPath(file.path) })),
            ...(inverse.deletePaths === undefined
              ? {}
              : { deletePaths: inverse.deletePaths.map(remapPath) }),
          };
      }
    },
  };
}

/**
 * Re-stamp adopted targets the rollback engine just rewrote or removed while
 * applying an inverse on the child's behalf (createLegacyPathRemapper mapped
 * the child's legacy paths onto them, or the row is the child's own rollback
 * row over the shared store): the write is the child's own lineage acting, so
 * the new generation stays mappable for the child's remaining rows over the
 * same note (create + edit unwind LIFO). `paths` may be directories (a rename
 * endpoint): every record whose target lies beneath is re-stamped, so after a
 * retargeted rename the vacated side's records lose their stamp and the
 * restored side's (tombstoned by the downgraded build's rename) take the
 * moved files' generation (r75). A rename whose restored side has NO record
 * (the child renamed before the first upgrade, so adoption only ever saw the
 * new names) gets tombstoned records for the moved copies (r76): keyed by the
 * legacy path the child's older rows address, carrying the moved file's
 * generation — `deleted` because no legacy source exists there (reconciliation
 * skips tombstones; a later source is a fresh note), yet mappable while the
 * copy is that generation or absent again. Runs under the owner store's
 * mutation lock the engine holds (the lock adoption passes take too). A target
 * that is gone loses its stamp — nothing maps there until adoption places the
 * note anew. Best-effort by contract: a failure here only leaves stale stamps,
 * which refuse (never mutate) later.
 */
export async function refreshLegacyAdoptionTargetStamps(args: {
  childSessionDir: string;
  ownerSessionDir: string;
  paths: readonly string[];
  renamed?: { from: string; to: string };
}): Promise<void> {
  const ownerRoot = path.join(path.resolve(args.ownerSessionDir), "memory");
  const ownerRel = (filePath: string): string | null => {
    const relative = path.relative(ownerRoot, path.resolve(filePath));
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return relative.split(path.sep).join("/");
  };
  const touched = new Set<string>();
  for (const filePath of args.paths) {
    const rel = ownerRel(filePath);
    if (rel !== null) touched.add(rel);
  }
  const renamed =
    args.renamed === undefined
      ? null
      : { from: ownerRel(args.renamed.from), to: ownerRel(args.renamed.to) };
  if (renamed?.from != null) touched.add(renamed.from);
  if (renamed?.to != null) touched.add(renamed.to);
  if (touched.size === 0) return;
  const beneath = (target: string, rel: string): boolean =>
    target === rel || target.startsWith(`${rel}/`);
  const manifestPath = legacyAdoptionManifestPath(path.resolve(args.childSessionDir));
  const adopted = await readLegacyAdoptionManifest(manifestPath, { strict: true });
  let dirty = false;
  const stampOf = async (target: string): Promise<string | undefined> =>
    (await adoptionTargetStamp(path.join(ownerRoot, ...target.split("/")))) ?? undefined;
  for (const record of adopted.values()) {
    if (record.created !== true || record.pending === true) continue;
    if (![...touched].some((rel) => beneath(record.target, rel))) continue;
    const stamp = await stampOf(record.target);
    if (stamp === record.targetStamp) continue;
    record.targetStamp = stamp;
    dirty = true;
  }
  if (renamed?.from != null && renamed.to != null) {
    const targets = new Set([...adopted.values()].map((record) => record.target));
    for (const record of [...adopted.values()]) {
      // Every copy beneath the vacated endpoint — at its own relPath (the
      // directory proof requires one-to-one) or a lone file's conflict import
      // under imported/<child>/ (r77) — now sits at the same relative
      // position under the restored name. The restored name IS the legacy
      // path the child's older rows address: a restored side without a record
      // mapped one-to-one (remapRenameDestination); one that had a record
      // (any target) is re-stamped above and gets no second record.
      if (record.created !== true || record.pending === true) continue;
      if (!beneath(record.target, renamed.from)) continue;
      const movedRel = renamed.to + record.target.slice(renamed.from.length);
      if (adopted.has(movedRel) || targets.has(movedRel)) continue;
      const stamp = await stampOf(movedRel);
      if (stamp === undefined) continue; // not moved after all: nothing to vouch for
      adopted.set(movedRel, {
        content: record.content,
        sidecar: record.sidecar,
        target: movedRel,
        created: true,
        deleted: true,
        targetStamp: stamp,
      });
      dirty = true;
    }
  }
  if (!dirty) return;
  await writeFileAtomic(manifestPath, JSON.stringify(Object.fromEntries(adopted)), {
    encoding: "utf-8",
  });
}
