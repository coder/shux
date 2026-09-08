import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import type { Result } from "@/common/types/result";
import { HistoryAppendProvenance } from "./historyAppendProvenance";
import { createTestHistoryService } from "./testHistoryService";

describe("HistoryService private publication seam", () => {
  let fixture: Awaited<ReturnType<typeof createTestHistoryService>>;
  let chatPath: string;
  const workspaceId = "publication";

  beforeEach(async () => {
    fixture = await createTestHistoryService();
    chatPath = path.join(fixture.config.sessionsDir, workspaceId, "chat.jsonl");
    for (const row of [
      createMuxMessage("user", "user", "question"),
      createMuxMessage("assistant", "assistant", "answer"),
    ]) {
      expect((await fixture.historyService.appendToHistory(workspaceId, row)).success).toBe(true);
    }
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  // Exercise the inactive seam under its real recovery/provenance/removal locks,
  // without adding a public acceptance option just for tests.
  function publish(
    kind: "single" | "batch" | "update",
    publication: { isCurrent: () => boolean; onCommitted: () => void }
  ) {
    const service = fixture.historyService as unknown as {
      withRecoveredHistoryWriteResultLock(
        workspaceId: string,
        errorPrefix: string,
        operation: () => Promise<Result<void>>
      ): Promise<Result<void>>;
      updateHistoryUnderWriteLock(
        workspaceId: string,
        message: MuxMessage,
        observer: typeof publication
      ): Promise<Result<void>>;
      appendManyToHistoryUnderWriteLock(
        workspaceId: string,
        messages: MuxMessage[],
        observer: typeof publication
      ): Promise<Result<void>>;
    };
    return service.withRecoveredHistoryWriteResultLock(workspaceId, "Publication failed", () => {
      if (kind === "update") {
        return service.updateHistoryUnderWriteLock(
          workspaceId,
          createMuxMessage("assistant", "assistant", "updated", { historySequence: 1 }),
          publication
        );
      }
      const rows = [createMuxMessage("replacement", "user", "next question")];
      if (kind === "batch") rows.unshift(createMuxMessage("payload", "assistant", "payload"));
      return service.appendManyToHistoryUnderWriteLock(workspaceId, rows, publication);
    });
  }

  async function readHistory() {
    const result = await fixture.historyService.getLastMessages(workspaceId, 10);
    expect(result.success).toBe(true);
    return result.success ? result.data : [];
  }

  for (const kind of ["single", "batch", "update"] as const) {
    it(`${kind}: captures the complete publication before ownership can change`, async () => {
      const provenance = new HistoryAppendProvenance(path.dirname(chatPath));
      const before = (await provenance.read()).receipt;
      expect(before?.state).toBe("stable");
      let current = true;
      let committedWhileCurrent = false;
      let committedRows: MuxMessage[] = [];
      let commits = 0;
      const result = await publish(kind, {
        isCurrent: () => {
          queueMicrotask(() => {
            current = false;
          });
          return current;
        },
        onCommitted: () => {
          commits++;
          committedWhileCurrent = current;
          committedRows = nodeFs
            .readFileSync(chatPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as MuxMessage);
        },
      });
      expect(result.success).toBe(true);
      expect(commits).toBe(1);
      expect(current).toBe(false);
      expect(committedWhileCurrent).toBe(true);
      const persisted = await readHistory();
      expect(committedRows).toEqual(persisted);
      expect(persisted.map((row) => row.id)).toEqual(
        kind === "update"
          ? ["user", "assistant"]
          : kind === "batch"
            ? ["user", "assistant", "payload", "replacement"]
            : ["user", "assistant", "replacement"]
      );
      expect(persisted.map((row) => row.metadata?.historySequence)).toEqual(
        persisted.map((_, index) => index)
      );
      if (kind === "update")
        expect(persisted[1].parts).toMatchObject([{ type: "text", text: "updated" }]);
      const after = (await provenance.read()).receipt;
      expect(after?.state).toBe("stable");
      if (kind === "update") expect(after?.epoch).not.toBe(before?.epoch);
      else expect(after?.epoch).toBe(before?.epoch);
    });

    it(`${kind}: rejects ownership after staging without publishing or notifying`, async () => {
      const before = await fs.readFile(chatPath);
      let staged = false;
      let commits = 0;
      const result = await publish(kind, {
        isCurrent: () => {
          staged = nodeFs
            .readdirSync(path.dirname(chatPath))
            .some((name) => name.startsWith("chat.jsonl.publication-"));
          return false;
        },
        onCommitted: () => commits++,
      });
      expect(result.success).toBe(false);
      expect(staged).toBe(true);
      expect(commits).toBe(0);
      expect(await fs.readFile(chatPath)).toEqual(before);
      expect(
        (await fs.readdir(path.dirname(chatPath))).filter((name) => name.includes(".publication-"))
      ).toEqual([]);
    });

    it(`${kind}: a failed rename leaves the old history and no commit receipt`, async () => {
      const before = await fs.readFile(chatPath);
      let commits = 0;
      const rename = spyOn(nodeFs, "renameSync").mockImplementationOnce(() => {
        throw new Error("publication unavailable");
      });
      try {
        const result = await publish(kind, {
          isCurrent: () => true,
          onCommitted: () => commits++,
        });
        expect(result.success).toBe(false);
        expect(commits).toBe(0);
        expect(await fs.readFile(chatPath)).toEqual(before);
      } finally {
        rename.mockRestore();
      }
    });

    it(`${kind}: observer and staging-cleanup failures cannot turn a commit into a retry`, async () => {
      let commits = 0;
      let cleanupFailures = 0;
      const remove = fs.rm;
      const failure = spyOn(fs, "rm").mockImplementation((target, options) => {
        if (String(target).startsWith(`${chatPath}.publication-`)) {
          cleanupFailures++;
          return Promise.reject(new Error("cleanup unavailable"));
        }
        return remove(target, options);
      });
      try {
        const result = await publish(kind, {
          isCurrent: () => true,
          onCommitted: () => {
            commits++;
            throw new Error("observer unavailable");
          },
        });
        expect(result.success).toBe(true);
        expect(commits).toBe(1);
        expect(cleanupFailures).toBe(1);
      } finally {
        failure.mockRestore();
      }
      const persisted = await readHistory();
      if (kind === "update") {
        expect(persisted).toHaveLength(2);
        expect(persisted[1].parts).toMatchObject([{ type: "text", text: "updated" }]);
      } else {
        expect(persisted.filter((row) => row.id === "replacement")).toHaveLength(1);
        expect(persisted).toHaveLength(kind === "batch" ? 4 : 3);
      }
    });
  }
});
