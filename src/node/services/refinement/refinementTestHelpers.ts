/**
 * Test helpers for the refinement journal: read `refinement` rows back from a
 * session dir and apply an inverse payload to the local filesystem so tests
 * can assert byte-identical round-trips (apply op → apply inverse → prior
 * state). Local-filesystem only — runtime-namespace paths from remote
 * runtimes are not translated here.
 */

import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import assert from "@/common/utils/assert";
import type { DurableEvent } from "@/common/types/durableEvent";
import { RefinementInverseSchema } from "@/common/types/refinement";
import { getProcessBirth } from "@/node/utils/concurrency/fileLock";
import { sharedDurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import { targetMutationLockFilePath } from "./targetMutationLocks";

export type RefinementEvent = Extract<DurableEvent, { kind: "refinement" }>;

/**
 * Occupy a target mutation lockfile with a verified-live foreign-owner token,
 * as another process's in-flight rollback would (verified-live is never
 * reclaimed while this test process runs, so writers must fail fast).
 * Returns the lockfile path; unlink it to release.
 */
export async function seedForeignTargetLock(muxHome: string, targetKey: string): Promise<string> {
  const birth = getProcessBirth(process.pid);
  const token =
    birth === null
      ? `${process.pid}:foreign`
      : `${process.pid}:foreign:${Buffer.from(birth).toString("hex")}`;
  const lockPath = targetMutationLockFilePath(muxHome, targetKey);
  await fsPromises.mkdir(path.dirname(lockPath), { recursive: true });
  await fsPromises.writeFile(lockPath, token, { encoding: "utf-8", flag: "wx" });
  return lockPath;
}

/** All `refinement` rows in the session journal, in seq order. */
export async function readRefinementEvents(sessionDir: string): Promise<RefinementEvent[]> {
  const events = await sharedDurableEventJournal(sessionDir).read();
  return events.filter((event): event is RefinementEvent => event.kind === "refinement");
}

/** Apply one refinement inverse payload (validated against the v1 contract). */
export async function applyRefinementInverse(sessionDir: string, inverse: unknown): Promise<void> {
  const parsed = RefinementInverseSchema.parse(inverse);
  const blobs = sharedDurableEventJournal(sessionDir).blobs;
  switch (parsed.op) {
    case "delete-files":
      for (const filePath of parsed.paths) {
        await fsPromises.rm(filePath, { force: true });
      }
      return;
    case "restore-files":
      for (const file of parsed.files) {
        const content = file.text ?? (file.blobRef ? await blobs.getText(file.blobRef) : null);
        assert(content !== null, `refinement inverse content missing for ${file.path}`);
        await fsPromises.mkdir(path.dirname(file.path), { recursive: true });
        await fsPromises.writeFile(file.path, content, "utf-8");
      }
      return;
    case "rename":
      await fsPromises.mkdir(path.dirname(parsed.to), { recursive: true });
      await fsPromises.rename(parsed.from, parsed.to);
      return;
  }
}
