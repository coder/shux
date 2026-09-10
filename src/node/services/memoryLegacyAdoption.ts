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
 * provenance; the source is reconciled as a plain unlisted note) — so a
 * corrupted flag can never make an interrupted pass look settled.
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
    replacementContent:
      typeof record.replacementContent === "string" ? record.replacementContent : undefined,
  };
}

/**
 * Self-healing read of the adoption manifest: a missing or malformed file
 * reads as "nothing adopted" (malformed content IS the file's state; the next
 * pass rewrites it). An UNREADABLE file (EACCES, EIO) says nothing about that
 * state: tolerant callers read it as empty too, `strict` callers throw — the
 * removal handover decides what may be deleted from the manifest, and an
 * empty substitute would delete the child session with the only provenance
 * for a stale owner copy. A Map, not a plain object: a legacy note may
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
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return new Map();
    return new Map(
      Object.entries(parsed).flatMap(([relPath, raw]) => {
        const record = parseLegacyAdoptionRecord(raw);
        return record === null ? [] : [[relPath, record] as const];
      })
    );
  } catch {
    return new Map();
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
  constructor(legacyPath: string, reason: "not-adopted" | "owner-owned") {
    super(
      reason === "owner-owned"
        ? `'${legacyPath}' addresses this sub-agent's pre-sharing private notebook; the shared workspace store holds an identical note the owner already had (adoption created nothing), so a rollback there would alter the owner's own note`
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
      ([rel, entry]) => entry.target === rel && entry.created === true && entry.pending !== true
    );
    const expected = new Set(
      descendants.filter(([, entry]) => entry.deleted !== true).map(([rel]) => rel)
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
  const remapPath = (filePath: string): string => {
    const relative = path.relative(legacyRoot, path.resolve(filePath));
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return filePath;
    const relPath = relative.split(path.sep).join("/");
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
    return path.join(ownerRoot, ...record.target.split("/"));
  };
  return {
    path: remapPath,
    inverse: (inverse) => {
      switch (inverse.op) {
        case "delete-files":
          return { ...inverse, paths: inverse.paths.map(remapPath) };
        case "rename":
          return { ...inverse, from: remapPath(inverse.from), to: remapPath(inverse.to) };
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
