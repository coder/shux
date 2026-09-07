import { expect, test } from "bun:test";
import { WorkspaceChatMessageSchema } from "@/common/orpc/schemas/stream";
import type { StreamMetadataEvent } from "@/common/types/stream";
import { createAgentSessionHarness, createStreamLifecycleMocks } from "./agentSession.testHarness";

test("forwards fallback metadata only for the current workspace and stream without a lifecycle transition", async () => {
  let activeMessageId: string | undefined = "current";
  const harness = await createAgentSessionHarness({
    workspaceId: "workspace",
    captureEvents: true,
    streamManager: {
      ...createStreamLifecycleMocks(),
      getStreamInfo: () =>
        activeMessageId
          ? {
              messageId: activeMessageId,
              parts: [],
              toolCompletionTimestamps: new Map(),
            }
          : undefined,
    },
  });
  try {
    const event: StreamMetadataEvent = {
      type: "stream-metadata",
      workspaceId: "workspace",
      messageId: "current",
      metadata: {
        model: "local:unknown",
        metadataModel: "local:unknown",
        contextWindowTokens: null,
        routedThroughGateway: false,
        routeProvider: null,
      },
    };
    harness.aiEmitter.emit(event.type, { ...event, workspaceId: "other" });
    harness.aiEmitter.emit(event.type, { ...event, messageId: "stale" });
    expect(harness.events).toHaveLength(0);
    harness.aiEmitter.emit(event.type, event);
    expect(harness.events.map((message) => WorkspaceChatMessageSchema.parse(message))).toEqual([
      event,
    ]);
    activeMessageId = undefined;
    harness.aiEmitter.emit(event.type, event);
    expect(harness.events).toHaveLength(1);
  } finally {
    await harness.session.dispose();
    await harness.cleanup();
  }
});
