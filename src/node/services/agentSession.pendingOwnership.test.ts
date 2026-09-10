import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "events";
import { readFile } from "fs/promises";
import * as path from "path";
import { TURNS_BETWEEN_ATTACHMENTS } from "@/common/constants/attachments";
import type { PostCompactionAttachment } from "@/common/types/attachment";
import { createMuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import type { StreamEndEvent } from "@/common/types/stream";
import assert from "@/common/utils/assert";
import type { CompactionHandler } from "./compactionHandler";
import type { TurnCoordinator } from "./turnCoordinator";
import type { TurnCompletion } from "./streamManager";
import { createAgentSessionHarness, createStartedTurnHandle } from "./agentSession.testHarness";

const workspaceId = "consumer-pending-owner";
const model = "openai:gpt-4o";
interface SessionAccess {
  compactionHandler: CompactionHandler;
  coordinator: TurnCoordinator;
  turnsSinceLastAttachment: number;
  getPostCompactionAttachmentsIfNeeded(
    includeReadFiles: boolean
  ): Promise<PostCompactionAttachment[] | null>;
  clearStartupAutoRetryAbandon(): Promise<void>;
  maybeRetryCompactionOnContextExceeded(): Promise<boolean>;
}

afterEach(() => {
  mock.restore();
});

describe("pending snapshot consumers", () => {
  test.each([
    { outcome: "success", periodic: false, replacement: true },
    { outcome: "context-exceeded", periodic: false, replacement: true },
    { outcome: "success", periodic: true, replacement: true },
    { outcome: "context-exceeded", periodic: true, replacement: true },
    { outcome: "context-exceeded", periodic: true, replacement: false },
  ] as const)(
    "$outcome retains its request snapshot (periodic=$periodic, replacement=$replacement)",
    async ({ outcome, periodic, replacement }) => {
      const completion = Promise.withResolvers<TurnCompletion>();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const emitter = new EventEmitter();
      let calls = 0;
      const h = await createAgentSessionHarness({
        workspaceId,
        aiEmitter: emitter,
        aiServiceOverrides: {
          streamMessage: mock(() => {
            const messageId = ++calls > 1 ? "retry" : "assistant";
            emitter.emit("stream-start", {
              type: "stream-start",
              workspaceId,
              messageId,
              model,
              startTime: Date.now(),
            });
            return Promise.resolve(
              Ok(
                calls > 1
                  ? createStartedTurnHandle(h.session.closingSignal, messageId)
                  : { messageId, completion: completion.promise }
              )
            );
          }),
        },
      });
      const session = h.session as unknown as SessionAccess;
      const handler = session.compactionHandler;
      const consumer = spyOn(session.coordinator, "consumeCompletion");
      async function publish(id: string) {
        const edit = createMuxMessage(id, "assistant", "");
        edit.parts = [
          {
            type: "dynamic-tool",
            toolCallId: id,
            toolName: "file_edit_replace_string",
            state: "output-available",
            input: { path: `/${id}.ts` },
            output: { success: true, diff: `change ${id}` },
          },
          {
            type: "dynamic-tool",
            toolCallId: `${id}-read`,
            toolName: "file_read",
            state: "output-available",
            input: { path: `/${id}.ts` },
            output: { success: true },
          },
        ];
        expect(
          await handler.withContinuousPendingState(
            [edit],
            (boundaryMessageId) =>
              handler.persistContinuousCompaction({
                messages: [edit],
                boundaryMessageId,
                text: `${id} summary`,
                model,
                tail: [],
                systemMessageTokens: 0,
                attachmentTokens: 0,
                shouldPersist: () => true,
              }),
            id
          )
        ).toBe(true);
      }
      let policy: Promise<void> | undefined;
      try {
        await publish("a");
        if (periodic) {
          await session.getPostCompactionAttachmentsIfNeeded(true);
          await handler.ackPendingStateConsumed();
          session.turnsSinceLastAttachment = TURNS_BETWEEN_ATTACHMENTS;
          // Periodic injection reads current-epoch edits even when RLM read-path injection is off.
          const recent = createMuxMessage("recent", "assistant", "");
          recent.parts = [
            {
              type: "dynamic-tool",
              toolCallId: "recent-edit",
              toolName: "file_edit_replace_string",
              state: "output-available",
              input: { path: "/recent.ts" },
              output: { success: true, diff: "recent change" },
            },
          ];
          await h.historyService.appendToHistory(workspaceId, recent);
        }
        const consume = spyOn(
          handler,
          outcome === "success" ? "ackPendingStateConsumed" : "discardPendingState"
        );
        await h.historyService.appendToHistory(
          workspaceId,
          createMuxMessage("user", "user", "continue")
        );
        expect((await h.session.resumeStream({ model, agentId: "exec" })).success).toBe(true);
        if (outcome === "success") {
          spyOn(session, "clearStartupAutoRetryAbandon").mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
          });
        } else {
          spyOn(session, "maybeRetryCompactionOnContextExceeded").mockImplementationOnce(
            async () => {
              entered.resolve();
              await release.promise;
              return false;
            }
          );
        }
        const end: StreamEndEvent = {
          type: "stream-end",
          workspaceId,
          messageId: "assistant",
          metadata: { model },
          parts: [{ type: "text", text: "done" }],
        };
        completion.resolve(
          outcome === "success"
            ? { status: "completed", streamEnd: end }
            : {
                status: "failed",
                streamError: {
                  messageId: "assistant",
                  error: "too large",
                  errorType: "context_exceeded",
                },
              }
        );
        await entered.promise;
        const result = consumer.mock.results.at(-1);
        assert(result?.type === "return", "Expected an active completion consumer");
        policy = result.value;
        const pendingPath = path.join(h.config.sessionsDir, workspaceId, "post-compaction.json");
        let bytes: string | undefined;
        if (replacement) {
          await publish("b");
          // A successor request captures B while A's policy is suspended. A retains its entry value.
          const attachments = await session.getPostCompactionAttachmentsIfNeeded(false);
          expect(
            attachments
              ?.find((attachment) => attachment.type === "edited_files_reference")
              ?.files.some((file) => file.path === "/b.ts")
          ).toBe(true);
          bytes = await readFile(pendingPath, "utf8");
        }
        release.resolve();
        await policy;
        expect(consume).toHaveBeenCalledTimes(1);
        if (replacement) {
          expect(
            (await handler.peekPendingState())?.diffs.some((diff) => diff.path === "/b.ts")
          ).toBe(true);
          assert(bytes !== undefined, "Expected replacement file");
          expect(await readFile(pendingPath, "utf8")).toBe(bytes);
        } else {
          // The failed periodic injection still owns A's retained read-path carryover after ack.
          await publish("c");
          expect((await handler.peekPendingState())?.readFiles).toEqual(["/c.ts"]);
        }
        if (outcome === "context-exceeded") {
          expect(calls).toBe(2);
          expect(h.session.isBusy()).toBe(true);
        }
      } finally {
        release.resolve();
        completion.resolve({ status: "aborted", abortReason: "system" });
        await policy;
        await h.session.dispose();
        await h.cleanup();
      }
    }
  );
});
