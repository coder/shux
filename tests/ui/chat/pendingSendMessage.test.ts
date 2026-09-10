import "../dom";

jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));

import { waitFor } from "@testing-library/react";

import { preloadTestModules, type TestEnvironment } from "../../ipc/setup";

import { workspaceStore } from "@/browser/stores/WorkspaceStore";

import { createAppHarness, type AppHarness } from "../harness";

type WorkspaceServiceSendMessage = TestEnvironment["services"]["workspaceService"]["sendMessage"];

// The oRPC router client builds a fresh proxy on every property access, so overrides must land on
// the service the router handler calls into.
function overrideServiceSendMessage(
  env: TestEnvironment,
  override: (original: WorkspaceServiceSendMessage) => WorkspaceServiceSendMessage
): () => void {
  const service = env.services.workspaceService as typeof env.services.workspaceService & {
    sendMessage: WorkspaceServiceSendMessage;
  };
  const original = service.sendMessage.bind(service) as WorkspaceServiceSendMessage;
  service.sendMessage = override(original);
  return () => {
    service.sendMessage = original;
  };
}

function getPendingSendRow(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-component="PendingSendMessage"]');
}

function getComposerTextarea(container: HTMLElement): HTMLTextAreaElement {
  const textarea = container
    .querySelector('[data-testid="chat-composer-dock"]')
    ?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Claude"]');
  if (!textarea) {
    throw new Error("Composer textarea not found");
  }
  return textarea;
}

function getPersistedMessageBlocks(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll("[data-message-block]"));
}

async function expectPendingSendRow(app: AppHarness, text: string): Promise<void> {
  await waitFor(
    () => {
      const row = getPendingSendRow(app.view.container);
      if (!row) {
        throw new Error("Pending send row not rendered");
      }
      expect(row.textContent).toContain(text);
      expect(row.querySelector('[data-component="PendingSendStatus"]')?.textContent).toContain(
        "Sending"
      );
      expect(getComposerTextarea(app.view.container).disabled).toBe(true);
    },
    { timeout: 10_000 }
  );
}

describe("Optimistic pending send row", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("shows the message in the transcript tail until the backend echoes it", async () => {
    let releaseSend: () => void = () => {};
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let restoreSendMessage: () => void = () => {};
    const app = await createAppHarness({
      branchPrefix: "pending-send",
      beforeRenderEnvironment: (env) => {
        restoreSendMessage = overrideServiceSendMessage(
          env,
          (original) =>
            (async (...args) => {
              await sendGate;
              return original(...args);
            }) as WorkspaceServiceSendMessage
        );
      },
    });

    try {
      const text = "Hold this message until the server acknowledges it";
      await app.chat.send(text);

      await expectPendingSendRow(app, text);
      // Nothing persisted yet, so the only copy of the text is the pending row.
      expect(getPersistedMessageBlocks(app.view.container)).toHaveLength(0);

      releaseSend();

      await waitFor(
        () => {
          expect(getPendingSendRow(app.view.container)).toBeNull();
          const blocks = getPersistedMessageBlocks(app.view.container);
          expect(blocks.some((block) => block.textContent?.includes(text))).toBe(true);
        },
        { timeout: 10_000 }
      );
      await app.chat.expectStreamComplete();
    } finally {
      restoreSendMessage();
      releaseSend();
      await app.dispose();
    }
  }, 60_000);

  test("returns the message to the composer when the send fails", async () => {
    let releaseSend: () => void = () => {};
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let restoreSendMessage: () => void = () => {};
    const app = await createAppHarness({
      branchPrefix: "pending-send-fail",
      beforeRenderEnvironment: (env) => {
        restoreSendMessage = overrideServiceSendMessage(
          env,
          () =>
            (async () => {
              await sendGate;
              return { success: false, error: { type: "unknown", raw: "simulated outage" } };
            }) as WorkspaceServiceSendMessage
        );
      },
    });

    try {
      const text = "This send is going to fail";
      await app.chat.send(text);

      await expectPendingSendRow(app, text);

      releaseSend();

      await waitFor(
        () => {
          expect(getPendingSendRow(app.view.container)).toBeNull();
          const textarea = getComposerTextarea(app.view.container);
          expect(textarea.disabled).toBe(false);
          expect(textarea.value).toBe(text);
        },
        { timeout: 10_000 }
      );
      expect(getPersistedMessageBlocks(app.view.container)).toHaveLength(0);
    } finally {
      restoreSendMessage();
      releaseSend();
      await app.dispose();
    }
  }, 60_000);

  test("keeps the composer locked while a send awaits the queue during stream startup", async () => {
    let releaseSend: () => void = () => {};
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let gateNextSend = false;
    let restoreSendMessage: () => void = () => {};
    const app = await createAppHarness({
      branchPrefix: "pending-send-queue",
      beforeRenderEnvironment: (env) => {
        restoreSendMessage = overrideServiceSendMessage(
          env,
          (original) =>
            (async (...args) => {
              if (gateNextSend) {
                gateNextSend = false;
                await sendGate;
              }
              return original(...args);
            }) as WorkspaceServiceSendMessage
        );
      },
    });

    try {
      // Hold the first turn before stream-start so the composer is in its "starting" phase,
      // which normally re-enables input for queued follow-ups.
      await app.chat.send("[mock:wait-start] first turn");
      await waitFor(
        () => {
          expect(workspaceStore.getWorkspaceSidebarState(app.workspaceId).isStarting).toBe(true);
          expect(getComposerTextarea(app.view.container).disabled).toBe(false);
        },
        { timeout: 10_000 }
      );

      gateNextSend = true;
      const text = "Follow-up that must stay locked until acknowledged";
      await app.chat.send(text);
      await expectPendingSendRow(app, text);

      releaseSend();

      await waitFor(
        () => {
          expect(getPendingSendRow(app.view.container)).toBeNull();
          const queued = app.view.container.querySelector('[data-component="QueuedMessageBanner"]');
          expect(queued?.textContent).toContain(text);
          expect(getComposerTextarea(app.view.container).disabled).toBe(false);
        },
        { timeout: 10_000 }
      );

      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await app.chat.expectTranscriptContains(`Mock response: ${text}`, 30_000);
      await app.chat.expectStreamComplete();
    } finally {
      restoreSendMessage();
      releaseSend();
      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await app.dispose();
    }
  }, 90_000);
});
