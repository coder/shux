import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  AUTO_RETRY_PREFERENCE_FILE,
  readDurableRejectedTurnKeys,
} from "./rejectedTurnRepairRecord";

describe("rejected-turn repair record", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-rejected-turn-record-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("reads the outstanding repair keys and a rejected abandon marker without a session", async () => {
    // The post-restart launch sweep harvests before any session exists, so the
    // keys must come from the durable record itself.
    const preferencePath = path.join(tempDir, AUTO_RETRY_PREFERENCE_FILE);
    await fs.writeFile(
      preferencePath,
      JSON.stringify({
        startupAutoRetryAbandon: { reason: "pre_stream_rejected", userMessageId: "u-marker" },
        pendingRejectedTurnRepair: { userMessageIds: ["u-old", "u-new", "u-old"] },
      })
    );
    const keys = await readDurableRejectedTurnKeys(preferencePath);
    expect(keys.success && [...keys.data].sort()).toEqual(["u-marker", "u-new", "u-old"]);
  });

  it("ignores markers with other reasons and still reads the earlier single-key record shape", async () => {
    const preferencePath = path.join(tempDir, AUTO_RETRY_PREFERENCE_FILE);
    await fs.writeFile(
      preferencePath,
      JSON.stringify({
        startupAutoRetryAbandon: { reason: "aborted", userMessageId: "u-aborted" },
        pendingRejectedTurnRepair: { userMessageId: "u-legacy" },
      })
    );
    const keys = await readDurableRejectedTurnKeys(preferencePath);
    expect(keys.success && [...keys.data]).toEqual(["u-legacy"]);
  });

  it("yields no keys for a missing file but an unknown state for an unreadable or malformed one", async () => {
    // A missing file is the ordinary "nothing outstanding" case. Anything else
    // hides keys a side channel needs: after a failed stamp this record is the
    // only durable protection, so the caller must fail closed, not empty.
    const preferencePath = path.join(tempDir, AUTO_RETRY_PREFERENCE_FILE);
    const missing = await readDurableRejectedTurnKeys(preferencePath);
    expect(missing.success && missing.data.size).toBe(0);
    await fs.writeFile(preferencePath, "{ not json");
    expect((await readDurableRejectedTurnKeys(preferencePath)).success).toBe(false);
    await fs.writeFile(preferencePath, "null");
    expect((await readDurableRejectedTurnKeys(preferencePath)).success).toBe(false);
    // A directory at the record's path fails the read with something other than ENOENT.
    expect((await readDurableRejectedTurnKeys(tempDir)).success).toBe(false);
  });

  it("treats present-but-invalid nested fields as an unknown state, not as no keys", async () => {
    // Only the document shape was validated before: `{ userMessageIds: 42 }`
    // parsed to an empty key list, which a side channel took as an
    // authoritative empty quarantine. Nested corruption must fail closed too.
    const preferencePath = path.join(tempDir, AUTO_RETRY_PREFERENCE_FILE);
    const malformed = [
      { pendingRejectedTurnRepair: { userMessageIds: 42 } },
      { pendingRejectedTurnRepair: { userMessageIds: ["u-1", 3] } },
      { pendingRejectedTurnRepair: {} },
      { pendingRejectedTurnRepair: "u-1" },
      { startupAutoRetryAbandon: { reason: "pre_stream_rejected", userMessageId: 7 } },
      { startupAutoRetryAbandon: { reason: "" } },
      { startupAutoRetryAbandon: "pre_stream_rejected" },
      // A key-less rejected marker (a refused resume that could not read its
      // row key) names a refused turn the session has not identified yet:
      // unknown, not empty, until startup recovery keys or stamps it.
      { startupAutoRetryAbandon: { reason: "pre_stream_rejected" } },
    ];
    for (const record of malformed) {
      await fs.writeFile(preferencePath, JSON.stringify(record));
      expect((await readDurableRejectedTurnKeys(preferencePath)).success).toBe(false);
    }
    // Valid shapes still read: an empty key list and an unrelated marker reason.
    for (const record of [
      { pendingRejectedTurnRepair: { userMessageIds: [] } },
      { startupAutoRetryAbandon: { reason: "aborted", userMessageId: "u-aborted" } },
    ]) {
      await fs.writeFile(preferencePath, JSON.stringify(record));
      const result = await readDurableRejectedTurnKeys(preferencePath);
      expect(result.success && result.data.size).toBe(0);
    }
  });
});
