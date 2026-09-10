import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  readAgentWorkflowRunReferences,
  recordAgentWorkflowRunReference,
} from "@/node/services/agentWorkflowRunReferences";

describe("agent workflow run references", () => {
  test("preserves concurrent run reference writes", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workflow-runs-"));
    try {
      const runIds = Array.from({ length: 20 }, (_, index) => `wfr_concurrent_${index}`);

      await Promise.all(
        runIds.map((runId, index) =>
          recordAgentWorkflowRunReference({
            workspaceSessionDir,
            runId,
            createdAtMs: 1_000 + index,
          })
        )
      );

      const references = await readAgentWorkflowRunReferences(workspaceSessionDir);
      expect(new Set(references.map((reference) => reference.runId))).toEqual(new Set(runIds));
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("collapses persisted duplicate entries to the newest sane timestamp", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workflow-runs-"));
    try {
      // Corrupted files can carry duplicates in either order; order-sensitive consumers must
      // never observe a stale duplicate ahead of a legitimate re-record.
      await fs.writeFile(
        path.join(workspaceSessionDir, "agent-workflow-runs.json"),
        JSON.stringify({
          references: [
            { runId: "wfr_dup", createdAtMs: 1_000 },
            { runId: "wfr_dup", createdAtMs: 2_000 },
            { runId: "wfr_dup_reversed", createdAtMs: 2_000 },
            { runId: "wfr_dup_reversed", createdAtMs: 1_000 },
          ],
        })
      );

      const references = await readAgentWorkflowRunReferences(workspaceSessionDir);
      expect(references).toHaveLength(2);
      expect(references).toContainEqual({ runId: "wfr_dup", createdAtMs: 2_000 });
      expect(references).toContainEqual({ runId: "wfr_dup_reversed", createdAtMs: 2_000 });
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("roundtrips the initiating agent and drops invalid persisted shapes", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workflow-runs-"));
    try {
      await recordAgentWorkflowRunReference({
        workspaceSessionDir,
        runId: "wfr_agent",
        createdAtMs: 1_000,
        agentId: "plan",
        strictAgentResolution: { expectedScope: "built-in" },
      });
      let references = await readAgentWorkflowRunReferences(workspaceSessionDir);
      expect(references).toContainEqual({
        runId: "wfr_agent",
        createdAtMs: 1_000,
        agentId: "plan",
        strictAgentResolution: { expectedScope: "built-in" },
      });

      // Identity is advisory: a malformed persisted agentId drops the field, not the entry,
      // so the run keeps its wake and identity falls back to the history walk.
      await fs.writeFile(
        path.join(workspaceSessionDir, "agent-workflow-runs.json"),
        JSON.stringify({
          references: [
            { runId: "wfr_agent_number", createdAtMs: 1_000, agentId: 7 },
            { runId: "wfr_agent_empty", createdAtMs: 1_000, agentId: "" },
            // Non-empty but schema-invalid: stream resolution would normalize it to exec,
            // silently swapping a restricted agent's wake onto exec's tool surface.
            { runId: "wfr_agent_malformed", createdAtMs: 1_000, agentId: "bad id" },
            // Invalid pin shapes degrade to the legacy walk fallback (field dropped); a
            // persisted false means verified-unpinned (null), like absence at record time.
            {
              runId: "wfr_pin_invalid",
              createdAtMs: 1_000,
              agentId: "plan",
              strictAgentResolution: { expectedScope: 42 },
            },
            {
              runId: "wfr_pin_false",
              createdAtMs: 1_000,
              agentId: "plan",
              strictAgentResolution: false,
            },
          ],
        })
      );
      references = await readAgentWorkflowRunReferences(workspaceSessionDir);
      expect(references).toContainEqual({ runId: "wfr_agent_number", createdAtMs: 1_000 });
      expect(references).toContainEqual({ runId: "wfr_agent_empty", createdAtMs: 1_000 });
      expect(references).toContainEqual({ runId: "wfr_agent_malformed", createdAtMs: 1_000 });
      expect(references).toContainEqual({
        runId: "wfr_pin_invalid",
        createdAtMs: 1_000,
        agentId: "plan",
      });
      expect(references).toContainEqual({
        runId: "wfr_pin_false",
        createdAtMs: 1_000,
        agentId: "plan",
        strictAgentResolution: null,
      });
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("drops persisted future-dated references and repairs them on the next record", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workflow-runs-"));
    try {
      const futureMs = Date.now() + 86_400_000;
      await fs.writeFile(
        path.join(workspaceSessionDir, "agent-workflow-runs.json"),
        JSON.stringify({
          references: [
            { runId: "wfr_corrupt_future", createdAtMs: futureMs },
            { runId: "wfr_sane", createdAtMs: 1_000 },
          ],
        })
      );

      // A per-read clamp would re-evaluate to "now" on every read and outrank every later
      // user/reset boundary; the corrupted entry must be dropped instead.
      expect(await readAgentWorkflowRunReferences(workspaceSessionDir)).toEqual([
        { runId: "wfr_sane", createdAtMs: 1_000 },
      ]);

      await recordAgentWorkflowRunReference({
        workspaceSessionDir,
        runId: "wfr_corrupt_future",
        createdAtMs: 2_000,
      });
      const repaired = await readAgentWorkflowRunReferences(workspaceSessionDir);
      expect(repaired).toContainEqual({ runId: "wfr_corrupt_future", createdAtMs: 2_000 });
      const raw = await fs.readFile(
        path.join(workspaceSessionDir, "agent-workflow-runs.json"),
        "utf-8"
      );
      expect(raw).not.toContain(String(futureMs));
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("keeps references within the backward-clock skew tolerance", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workflow-runs-"));
    try {
      // A backward clock correction makes a legitimately recorded reference look slightly
      // future-dated; dropping it would strand the run's terminal wake.
      const slightlyFutureMs = Date.now() + 5 * 60_000;
      await fs.writeFile(
        path.join(workspaceSessionDir, "agent-workflow-runs.json"),
        JSON.stringify({ references: [{ runId: "wfr_clock_skew", createdAtMs: slightlyFutureMs }] })
      );

      expect(await readAgentWorkflowRunReferences(workspaceSessionDir)).toEqual([
        { runId: "wfr_clock_skew", createdAtMs: slightlyFutureMs },
      ]);
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("rejects entries with a present-but-invalid boundary snapshot", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workflow-runs-"));
    try {
      // "" and non-string values are corruption, not legacy records: migrating them into the
      // wall-clock fallback could outrank a newer boundary during tolerated clock skew.
      await fs.writeFile(
        path.join(workspaceSessionDir, "agent-workflow-runs.json"),
        JSON.stringify({
          references: [
            { runId: "wfr_empty_boundary", createdAtMs: 1_000, afterBoundaryMessageId: "" },
            { runId: "wfr_numeric_boundary", createdAtMs: 1_000, afterBoundaryMessageId: 42 },
            { runId: "wfr_valid_boundary", createdAtMs: 1_000, afterBoundaryMessageId: "row-1" },
            { runId: "wfr_null_boundary", createdAtMs: 1_000, afterBoundaryMessageId: null },
          ],
        })
      );

      const references = await readAgentWorkflowRunReferences(workspaceSessionDir);
      expect(new Set(references.map((reference) => reference.runId))).toEqual(
        new Set(["wfr_valid_boundary", "wfr_null_boundary"])
      );
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("propagates non-ENOENT read failures instead of flattening them to empty", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workflow-runs-"));
    try {
      // A directory at the file path fails reads with EISDIR. Callers deciding wake delivery
      // must observe the failure rather than "no references".
      await fs.mkdir(path.join(workspaceSessionDir, "agent-workflow-runs.json"));
      let readError: unknown;
      try {
        await readAgentWorkflowRunReferences(workspaceSessionDir);
      } catch (error: unknown) {
        readError = error;
      }
      expect(String(readError)).toContain("EISDIR");
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("record propagates a sidecar read failure instead of clobbering existing references", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workflow-runs-"));
    try {
      await recordAgentWorkflowRunReference({
        workspaceSessionDir,
        runId: "wfr_existing",
        createdAtMs: 1_000,
      });
      const filePath = path.join(workspaceSessionDir, "agent-workflow-runs.json");
      // Unreadable file, writable directory: the atomic rewrite could replace contents it
      // never saw, destroying every other run's only durable provenance.
      await fs.chmod(filePath, 0o000);
      let recordError: unknown;
      try {
        await recordAgentWorkflowRunReference({
          workspaceSessionDir,
          runId: "wfr_new",
          createdAtMs: 2_000,
        });
      } catch (error: unknown) {
        recordError = error;
      } finally {
        await fs.chmod(filePath, 0o600);
      }
      expect(String(recordError)).toContain("EACCES");
      const references = await readAgentWorkflowRunReferences(workspaceSessionDir);
      expect(references.map((reference) => reference.runId)).toEqual(["wfr_existing"]);
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("self-heals unparseable file contents to empty", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workflow-runs-"));
    try {
      // Unlike a failed read, corrupted contents cannot be repaired by rereading.
      await fs.writeFile(path.join(workspaceSessionDir, "agent-workflow-runs.json"), "{not json");
      expect(await readAgentWorkflowRunReferences(workspaceSessionDir)).toEqual([]);
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("clamps future-dated createdAtMs to the current time", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workflow-runs-"));
    try {
      const runId = "wfr_future";
      await recordAgentWorkflowRunReference({
        workspaceSessionDir,
        runId,
        createdAtMs: Date.now() + 86_400_000,
      });

      const references = await readAgentWorkflowRunReferences(workspaceSessionDir);
      expect(references).toHaveLength(1);
      expect(references[0]?.createdAtMs).toBeLessThanOrEqual(Date.now());
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("keeps the newest createdAtMs across re-records", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workflow-runs-"));
    try {
      const runId = "wfr_re_recorded";
      await recordAgentWorkflowRunReference({ workspaceSessionDir, runId, createdAtMs: 2_000 });
      await recordAgentWorkflowRunReference({ workspaceSessionDir, runId, createdAtMs: 1_000 });

      const references = await readAgentWorkflowRunReferences(workspaceSessionDir);
      expect(references).toEqual([{ runId, createdAtMs: 2_000 }]);
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });
});
