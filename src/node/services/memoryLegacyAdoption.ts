/**
 * Legacy-notebook adoption manifest: the durable record of which files of a
 * sub-agent's PRE-SHARING private notebook (`<childSession>/memory`, written by
 * builds that kept `/memories/workspace` per workspace) were folded into the
 * task-tree owner's shared store, and where each landed
 * (MemoryService.adoptLegacyPrivateStore).
 */
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

/**
 * File in the sub-agent's SESSION dir (beside its legacy `memory` dir, never
 * inside it) recording, per relPath, the sha256 of the content already copied
 * into the shared store (adoptLegacyPrivateStore). Outside the legacy root on
 * purpose: everything under `<childSession>/memory` is the model-writable
 * `/memories/workspace` namespace of a downgraded build (the path grammar
 * admits dotfiles), and this manifest's `created`/`target`/hash fields are
 * trusted as provenance. The session dir itself is not addressable through
 * any memory path.
 */
export const LEGACY_ADOPTION_MANIFEST_FILE_NAME = "memory-adoption-manifest.json";

export function legacyAdoptionManifestPath(childSessionDir: string): string {
  return path.join(childSessionDir, LEGACY_ADOPTION_MANIFEST_FILE_NAME);
}

/**
 * One adopted legacy file: content hash, child sidecar fingerprint, owner-store
 * relPath, and whether the adoption CREATED that owner file (provenance: a
 * pre-existing identical owner note is the owner's own). `pending`: written
 * BEFORE the copy lands (provenance must not depend on the copy's existence: a
 * retry finding the bytes already at the target could not tell an interrupted
 * adoption from an owner note); cleared once the sidecar fold completed.
 *
 * Every field beyond the three strings is optional and unknown fields are
 * ignored on read, so later builds can extend the record (downgrade-time
 * reconciliation of edited/deleted sources) without invalidating manifests
 * written by this one.
 */
export interface LegacyAdoptionRecord {
  content: string;
  sidecar: string;
  target: string;
  created?: boolean;
  pending?: boolean;
  /**
   * Identity of the owner file this adoption wrote (`ino:size:mtimeNs` right
   * after the write): the copy is THIS generation of the file, not merely a
   * file holding the adopted bytes — an owner who deleted and recreated (or
   * edited and restored) the note to identical bytes owns the new file.
   * Absent (write before stamping, or the stamp could not be taken): the copy
   * is never treated as this adoption's.
   */
  targetStamp?: string;
}

/**
 * Parse one manifest record. Lifecycle flags are raw JSON: a value that is
 * neither absent nor boolean fails CLOSED — `pending` reads as set (the pass
 * is redone), `created` as unset (no destructive provenance) — so a corrupted
 * flag can never make an interrupted pass look settled.
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
  if (record.targetStamp !== undefined && typeof record.targetStamp !== "string") return null;
  const flag = (raw: unknown, malformed: boolean): boolean | undefined =>
    raw === undefined ? undefined : typeof raw === "boolean" ? raw : malformed;
  return {
    content: record.content,
    sidecar: record.sidecar,
    target: record.target,
    created: flag(record.created, false),
    pending: flag(record.pending, true),
    targetStamp: record.targetStamp,
  };
}

/**
 * A manifest that exists and could be read but does not parse as a record
 * map. Distinguished from an UNREADABLE file (EACCES, EIO — the plain fs
 * error) so strict callers can quarantine the former (its bytes are the
 * file's state) while still refusing on the latter.
 */
export class LegacyAdoptionManifestMalformedError extends Error {
  constructor(manifestPath: string, detail: string) {
    super(`the legacy adoption manifest at ${manifestPath} is malformed (${detail})`);
    this.name = "LegacyAdoptionManifestMalformedError";
  }
}

/**
 * Read of the adoption manifest. A MISSING file reads as "nothing adopted"
 * for every caller. Tolerant callers also read an unreadable (EACCES, EIO)
 * or malformed file — bad JSON, a non-object, a record missing its string
 * fields — as empty (self-healing: the next pass rewrites it). `strict`
 * callers throw on all of those: the adoption pass and the removal handover
 * decide what may be considered handed over on the manifest's authority, and
 * an empty substitute would drop provenance. A Map, not a plain object: a
 * legacy note may legitimately be named `__proto__` (any store-valid
 * relPath), and assigning that key on an ordinary object hits the prototype
 * setter instead of creating an entry the serialization would carry — the
 * note would then be re-adopted on every access. JSON.parse and
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
      throw new LegacyAdoptionManifestMalformedError(manifestPath, detail);
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
 * The file identity a LegacyAdoptionRecord.targetStamp records, or why there
 * is none: "absent" only when the stat PROVES the path is gone (ENOENT /
 * ENOTDIR); any other failure (EACCES, EIO) is "unreadable" — it says
 * nothing about the path, so callers deciding on absence must refuse.
 */
export async function adoptionTargetPresence(
  absPath: string
): Promise<{ stamp: string } | "absent" | "unreadable"> {
  try {
    const stat = await fsPromises.lstat(absPath, { bigint: true });
    return { stamp: `${stat.ino}:${stat.size}:${stat.mtimeNs}` };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable";
  }
}

/**
 * The file identity a LegacyAdoptionRecord.targetStamp records; null when the
 * file cannot be stat'ed (the record then carries no stamp: preserved).
 */
export async function adoptionTargetStamp(absPath: string): Promise<string | null> {
  const presence = await adoptionTargetPresence(absPath);
  return typeof presence === "string" ? null : presence.stamp;
}
