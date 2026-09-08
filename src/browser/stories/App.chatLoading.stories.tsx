import { wrapAsyncIterator } from "@orpc/shared";
import { expect, userEvent, waitFor, within } from "@storybook/test";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { DEFAULT_MODEL } from "@/common/constants/knownModels";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createMockORPCClient } from "./mocks/orpc";
import { createAssistantMessage } from "./mocks/messages";
import { createWorkspace, groupWorkspacesByProject, STABLE_TIMESTAMP } from "./mocks/workspaces";
import {
  collapseLeftSidebar,
  collapseRightSidebar,
  expandLeftSidebar,
  expandProjects,
  selectWorkspace,
} from "./helpers/uiState";

export default { ...appMeta, title: "App/ChatLoading" };

function getLoadingStatus(canvasElement: HTMLElement) {
  return canvasElement.querySelector<HTMLElement>('[data-testid="transcript-loading-status"]');
}

async function switchWorkspace(canvasElement: HTMLElement, workspaceId: string) {
  expandLeftSidebar();
  const row = await waitFor(async () => {
    const element = canvasElement.querySelector<HTMLElement>(
      '[data-workspace-id="' + workspaceId + '"][role="button"]'
    );
    await expect(element).not.toBeNull();
    return element!;
  });
  await userEvent.click(row);
  collapseLeftSidebar();
}

async function checkLoadingLayout(canvasElement: HTMLElement) {
  await waitFor(async () => {
    const status = getLoadingStatus(canvasElement);
    await expect(status).toBeVisible();
    const dock = status!.closest('[data-component="ChatDockSurface"]')!;
    const composer = canvasElement.querySelector(
      '[data-component="ChatInputSurface"], [data-testid="chat-composer-dock"] [role="note"]'
    )!;
    const statusRect = status!.getBoundingClientRect();
    const dockRect = dock.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    await expect(statusRect.bottom).toBeLessThanOrEqual(composerRect.top);
    await expect(Math.abs(dockRect.left - composerRect.left)).toBeLessThan(1);
    await expect(Math.abs(dockRect.right - composerRect.right)).toBeLessThan(1);
    await expect(status!.scrollWidth).toBeLessThanOrEqual(status!.clientWidth);
    await expect(composerRect.right).toBeLessThanOrEqual(
      canvasElement.getBoundingClientRect().right
    );
  });
}

// Catch-up must not change dock height or move already-visible rows, including
// bottom-pinned transcripts whose scroll position follows content size changes.
async function finishReplayWithoutLayoutShift(
  canvasElement: HTMLElement,
  finishReplay: () => void
) {
  const canvas = within(canvasElement);
  const dock = canvas.getByTestId("chat-composer-dock");
  const message = canvas.getByText("Previously loaded response.");
  const scrollport = canvas.getByTestId("message-window");
  const before = {
    dockHeight: dock.getBoundingClientRect().height,
    messageTop: message.getBoundingClientRect().top,
    scrollHeight: scrollport.scrollHeight,
  };
  finishReplay();
  await waitFor(() => expect(getLoadingStatus(canvasElement)).toBeNull());
  // Let layout and the native scroll/resize observers process the removal.
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
  await expect(dock.getBoundingClientRect().height).toBe(before.dockHeight);
  const replayedMessage = await canvas.findByText("Previously loaded response.");
  await expect(replayedMessage.getBoundingClientRect().top, "cached message position").toBe(
    before.messageTop
  );
  await expect(scrollport.scrollHeight).toBe(before.scrollHeight);
}

function createHydrationStory(workspaceId: string): AppStory {
  const workspace = createWorkspace({
    id: workspaceId,
    name: "loading-history",
    projectName: "xum",
  });
  const otherWorkspace = createWorkspace({
    id: workspaceId + "-other",
    name: "caught-up-history",
    projectName: "xum",
  });
  const monitorWorkspace = createWorkspace({
    id: workspaceId + "-monitor",
    name: "waiting-on-monitor",
    projectName: "xum",
  });
  const transcriptWorkspace = createWorkspace({
    id: workspaceId + "-transcript",
    name: "read-only-history",
    projectName: "xum",
    transcriptOnly: true,
  });
  const workspaces = [workspace, otherWorkspace, monitorWorkspace, transcriptWorkspace];
  // Exercise real bottom-pinning, not only a short transcript with spare space.
  const history = createAssistantMessage(
    "history",
    Array.from({ length: 20 }, (_, index) => `Earlier response paragraph ${index + 1}.`).join(
      "\n\n"
    ) + "\n\nPreviously loaded response.",
    { historySequence: 1 }
  );
  let emitChat: (event: WorkspaceChatMessage) => void;
  let subscriptions = 0;
  let transcriptSubscriptions = 0;
  let emitTranscript: (event: WorkspaceChatMessage) => void;

  function setup() {
    subscriptions = 0;
    transcriptSubscriptions = 0;
    selectWorkspace(workspace);
    collapseLeftSidebar();
    collapseRightSidebar();
    expandProjects([workspace.projectPath]);
    const client = createMockORPCClient({
      projects: groupWorkspacesByProject(workspaces),
      workspaces,
      workspaceActivitySnapshots: {
        [monitorWorkspace.id]: {
          recency: STABLE_TIMESTAMP,
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          activeBashMonitorCount: 1,
        },
      },
      onChat: (workspaceId, emit) => {
        if (workspaceId === workspace.id) {
          emitChat = emit;
          subscriptions += 1;
        } else if (workspaceId === monitorWorkspace.id) {
          emit(history);
        } else if (workspaceId === transcriptWorkspace.id) {
          emitTranscript = emit;
          transcriptSubscriptions += 1;
          if (transcriptSubscriptions === 1) {
            emit(history);
            emit({
              type: "caught-up",
              hasOlderHistory: false,
              cursor: { history: { messageId: history.id, historySequence: 1 } },
            });
          }
        } else {
          emit(
            createAssistantMessage("other-history", "Another workspace response.", {
              historySequence: 1,
            })
          );
          emit({ type: "caught-up", hasOlderHistory: false });
        }
      },
    });
    // Client swaps between stories must release the previous activity snapshot subscription.
    client.workspace.activity.subscribe = (_input, options) => {
      async function* iterate() {
        yield* [];
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return Promise.resolve(wrapAsyncIterator(iterate(), {}));
    };
    return client;
  }
  const exerciseHydration: AppStory["play"] = async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const exposedStatuses = () =>
      within(canvas.getByTestId("message-window")).queryAllByRole("status");
    await step("First fetch is visible before the transcript and decorations reveal", async () => {
      await checkLoadingLayout(canvasElement);
      await expect(canvas.getByTestId("transcript-hydration-placeholder")).toBeVisible();
      await expect(exposedStatuses()).toHaveLength(1);
      await expect(exposedStatuses()[0]).toBe(
        canvas.getByTestId("transcript-hydration-placeholder")
      );
      await expect(canvas.getByRole("textbox")).toBeEnabled();
      emitChat(history);
      emitChat({
        type: "caught-up",
        hasOlderHistory: false,
        cursor: { history: { messageId: history.id, historySequence: 1 } },
      });
      await waitFor(() => expect(getLoadingStatus(canvasElement)).toBeNull());
      await expect(
        await canvas.findByText("Previously loaded response.", {}, { timeout: 5000 })
      ).toBeVisible();
      await expect(exposedStatuses()).toHaveLength(0);
    });

    await step(
      "Switching away clears the status; revisiting keeps cached rows while replaying",
      async () => {
        await switchWorkspace(canvasElement, otherWorkspace.id);
        await expect(
          await canvas.findByText("Another workspace response.", {}, { timeout: 5000 })
        ).toBeVisible();
        await expect(getLoadingStatus(canvasElement)).toBeNull();
        await switchWorkspace(canvasElement, workspace.id);
        await waitFor(() => expect(subscriptions).toBe(2));
        await checkLoadingLayout(canvasElement);
        await expect(canvas.getByText("Previously loaded response.")).toBeVisible();
        await expect(canvas.queryByTestId("transcript-hydration-placeholder")).toBeNull();
        await expect(exposedStatuses()).toHaveLength(1);
        await expect(exposedStatuses()[0]).toBe(getLoadingStatus(canvasElement));
        // The loading badge must yield to navigation instead of overlapping it on phones.
        const scrollport = canvas.getByTestId("message-window");
        await expect(scrollport.scrollHeight).toBeGreaterThan(scrollport.clientHeight);
        scrollport.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
        scrollport.scrollTop = 0;
        scrollport.dispatchEvent(new Event("scroll"));
        const jumpToBottom = await canvas.findByRole("button", { name: /Jump to bottom/ });
        await expect(getLoadingStatus(canvasElement)).toBeNull();
        await userEvent.click(jumpToBottom);
        await checkLoadingLayout(canvasElement);
        await finishReplayWithoutLayoutShift(canvasElement, () => {
          emitChat(history);
          emitChat({
            type: "caught-up",
            replay: "since",
            hasOlderHistory: false,
            cursor: { history: { messageId: history.id, historySequence: 1 } },
          });
        });
        // Re-enter catch-up for the competing progress-state checks below.
        await switchWorkspace(canvasElement, otherWorkspace.id);
        await expect(await canvas.findByText("Another workspace response.")).toBeVisible();
        await switchWorkspace(canvasElement, workspace.id);
        await waitFor(() => expect(subscriptions).toBe(3));
        await checkLoadingLayout(canvasElement);
      }
    );

    await step("Running init and stream preparation suppress the competing status", async () => {
      emitChat({
        type: "init-start",
        hookPath: "/project/.xum/init",
        timestamp: STABLE_TIMESTAMP,
        replay: true,
      });
      emitChat({
        type: "init-output",
        line: "Preparing workspace",
        isError: false,
        timestamp: STABLE_TIMESTAMP,
        replay: true,
      });
      await waitFor(() => expect(getLoadingStatus(canvasElement), "running init").toBeNull());
      emitChat({ type: "init-end", exitCode: 0, timestamp: STABLE_TIMESTAMP, replay: true });
      await checkLoadingLayout(canvasElement);
      emitChat({
        type: "stream-lifecycle",
        workspaceId: workspace.id,
        phase: "preparing",
        hadAnyOutput: false,
      });
      await waitFor(() => expect(getLoadingStatus(canvasElement), "preparing stream").toBeNull());
      emitChat({
        type: "stream-start",
        workspaceId: workspace.id,
        messageId: "stream",
        model: DEFAULT_MODEL,
        historySequence: 2,
        startTime: STABLE_TIMESTAMP,
      });
      await expect(await canvas.findByText(/streaming\.\.\./)).toBeVisible();
      await expect(getLoadingStatus(canvasElement)).toBeNull();
      emitChat(history);
      emitChat({
        type: "caught-up",
        replay: "since",
        hasOlderHistory: false,
        cursor: { history: { messageId: history.id, historySequence: 1 } },
      });
      emitChat({
        type: "stream-delta",
        workspaceId: workspace.id,
        messageId: "stream",
        delta: "Live response.",
        tokens: 3,
        timestamp: STABLE_TIMESTAMP,
      });
      await expect(await canvas.findByText("Live response.")).toBeVisible();
      await expect(getLoadingStatus(canvasElement)).toBeNull();
      emitChat({
        type: "stream-end",
        workspaceId: workspace.id,
        messageId: "stream",
        metadata: { model: DEFAULT_MODEL },
        parts: [{ type: "text", text: "Live response." }],
      });
      emitChat({
        type: "stream-lifecycle",
        workspaceId: workspace.id,
        phase: "idle",
        hadAnyOutput: true,
      });
    });

    await step("A monitor barrier suppresses duplicate replay status", async () => {
      await switchWorkspace(canvasElement, monitorWorkspace.id);
      await expect(
        await canvas.findByText(/Waiting on background bash monitor/, {}, { timeout: 5000 })
      ).toBeVisible();
      await expect(getLoadingStatus(canvasElement)).toBeNull();
    });

    await step("Read-only cached transcripts retain aligned replay feedback", async () => {
      await switchWorkspace(canvasElement, transcriptWorkspace.id);
      await expect(
        await canvas.findByText("Previously loaded response.", {}, { timeout: 5000 })
      ).toBeVisible();
      await expect(getLoadingStatus(canvasElement)).toBeNull();
      await switchWorkspace(canvasElement, otherWorkspace.id);
      await expect(await canvas.findByText("Another workspace response.")).toBeVisible();
      await switchWorkspace(canvasElement, transcriptWorkspace.id);
      await waitFor(() => expect(transcriptSubscriptions).toBe(2));
      await checkLoadingLayout(canvasElement);
      await expect(canvas.getByText("Previously loaded response.")).toBeVisible();
      await expect(canvas.queryByTestId("transcript-hydration-placeholder")).toBeNull();
      await expect(canvas.queryByRole("textbox")).toBeNull();
      await finishReplayWithoutLayoutShift(canvasElement, () => {
        emitTranscript(history);
        emitTranscript({
          type: "caught-up",
          replay: "since",
          hasOlderHistory: false,
          cursor: { history: { messageId: history.id, historySequence: 1 } },
        });
      });
      await waitFor(() => expect(getLoadingStatus(canvasElement)).toBeNull());
      await expect(canvas.getByText("Previously loaded response.")).toBeVisible();
    });

    await step(
      "A later replay shows the same aligned status without clearing cached messages",
      async () => {
        await switchWorkspace(canvasElement, otherWorkspace.id);
        await expect(
          await canvas.findByText("Another workspace response.", {}, { timeout: 5000 })
        ).toBeVisible();
        await switchWorkspace(canvasElement, workspace.id);
        await waitFor(() => expect(subscriptions).toBe(4));
        await checkLoadingLayout(canvasElement);
        await expect(canvas.getByText("Previously loaded response.")).toBeVisible();
      }
    );
  };

  return { render: () => <AppWithMocks setup={setup} />, play: exerciseHydration };
}

export const Replay: AppStory = {
  ...createHydrationStory("ws-loading-desktop"),
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["laptop"] } } },
};

export const Phone: AppStory = {
  ...createHydrationStory("ws-loading-phone"),
  decorators: [
    (Story) => (
      <div style={{ width: 390, maxWidth: "100%", height: 844, overflow: "hidden" }}>
        <Story />
      </div>
    ),
  ],
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: { pixel: { matrix: { viewports: ["phone"] } } },
};
