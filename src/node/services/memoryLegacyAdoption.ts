/**
 * Legacy-notebook adoption manifest: the durable record of which files of a
 * sub-agent's PRE-SHARING private notebook (`<childSession>/memory`, written by
 * builds that kept `/memories/workspace` per workspace) were folded into the
 * task-tree owner's shared store, and where each landed
 * (MemoryService.adoptLegacyPrivateStore). Shared with the refinement
 * rollback engine: refinement rows journaled before the upgrade address the
 * legacy files, while the note the user sees since is the owner copy.
 */
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import type { RefinementInverse } from "@/common/types/refinement";

/**
 * Dotfile inside a sub-agent's legacy `memory` dir recording, per relPath, the
 * sha256 of the content already copied into the shared store
 * (adoptLegacyPrivateStore). Dotfiles are invisible to every build's listing.
 */
export const LEGACY_ADOPTION_MANIFEST_FILE_NAME = ".adopted-into-shared-store.json";

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

function isLegacyAdoptionRecord(value: unknown): value is LegacyAdoptionRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.content === "string" &&
    typeof record.sidecar === "string" &&
    typeof record.target === "string"
  );
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
      Object.entries(parsed).filter((entry): entry is [string, LegacyAdoptionRecord] =>
        isLegacyAdoptionRecord(entry[1])
      )
    );
  } catch {
    return new Map();
  }
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
    path.join(legacyRoot, LEGACY_ADOPTION_MANIFEST_FILE_NAME),
    { strict: args.strict === true }
  );
  const remapPath = (filePath: string): string => {
    const relative = path.relative(legacyRoot, path.resolve(filePath));
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return filePath;
    const record = adopted.get(relative.split(path.sep).join("/"));
    if (record === undefined || record.pending === true) {
      throw new LegacyPathNotAdoptedError(filePath, "not-adopted");
    }
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
