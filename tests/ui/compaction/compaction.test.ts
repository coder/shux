/**
 * UI integration tests for compaction flows.
 *
 * Goal: validate UI logic <-> backend integration without relying on real LLMs.
 *
 * These tests run with the mock AI router enabled via createAppHarness().
 */

import "../dom";
import { waitFor } from "@testing-library/react";

import { preloadTestModules, setupProviders, type TestEnvironment } from "../../ipc/setup";

import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";

import { fireEvent } from "@testing-library/react";
import { createAppHarness } from "../harness";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getAutoCompactionThresholdKey } from "@/common/constants/storage";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import { KNOWN_MODELS } from "@/common/constants/knownModels";

interface ServiceContainerPrivates {
  backgroundProcessManager: BackgroundProcessManager;
}

function getBackgroundProcessManager(env: TestEnvironment): BackgroundProcessManager {
  return (env.services as unknown as ServiceContainerPrivates).backgroundProcessManager;
}

async function waitForForegroundToolCallId(
  env: TestEnvironment,
  workspaceId: string,
  toolCallId: string
): Promise<void> {
  const controller = new AbortController();
  let iterator: AsyncIterator<{ foregroundToolCallIds: string[] }> | null = null;

  try {
    const subscribedIterator = await env.orpc.workspace.backgroundBashes.subscribe(
      { workspaceId },
      { signal: controller.signal }
    );

    iterator = subscribedIterator;

    for await (const state of subscribedIterator) {
      if (state.foregroundToolCallIds.includes(toolCallId)) {
        return;
      }
    }

    throw new Error("backgroundBashes.subscribe ended before foreground bash was observed");
  } finally {
    controller.abort();
    void iterator?.return?.();
  }
}

async function getActiveTextarea(container: HTMLElement): Promise<HTMLTextAreaElement> {
  return waitFor(
    () => {
      const textareas = Array.from(
        container.querySelectorAll('textarea[aria-label="Message Claude"]')
      ) as HTMLTextAreaElement[];
      if (textareas.length === 0) {
        throw new Error("Chat textarea not found");
      }

      const enabled = [...textareas].reverse().find((textarea) => !textarea.disabled);
      if (!enabled) {
        throw new Error("Chat textarea is disabled");
      }

      return enabled;
    },
    { timeout: 10_000 }
  );
}

async function setDeterministicForceCompactionThreshold(
  env: TestEnvironment,
  workspaceId: string
): Promise<void> {
  // Keep force-compaction tests deterministic even if persisted settings enable 1M context
  // or raise the auto-compaction threshold. 10% threshold + 5% force buffer => trigger at 15%.
  updatePersistedState(getAutoCompactionThresholdKey(WORKSPACE_DEFAULTS.model), 10);
  const result = await env.orpc.workspace.setAutoCompactionThreshold({
    workspaceId,
    threshold: 0.1,
  });
  expect(result.success).toBe(true);
}

describe("Compaction UI (mock AI router)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("manual /compact with continue message auto-sends after compaction", async () => {
    const app = await createAppHarness({ branchPrefix: "compaction-ui" });

    try {
      const seedMessage = "Seed conversation for compaction";
      const continueText = "Continue after manual compaction";

      await app.chat.send(seedMessage);
      await app.chat.expectTranscriptContains(`Mock response: ${seedMessage}`);

      await app.chat.send(`/compact -t 500\n${continueText}`);

      await app.chat.expectTranscriptContains("Mock compaction summary:");
      await app.chat.expectTranscriptContains(`Mock response: ${continueText}`);
      // Compaction transcript now renders a single top boundary row.
      await app.chat.expectTranscriptContains("Compaction boundary");

      // Live compaction now prunes to the latest boundary, so pre-compaction
      // transcript is no longer visible in the current view.
      await app.chat.expectTranscriptNotContains(seedMessage);
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("auto-compacts after context_exceeded and resumes", async () => {
    const app = await createAppHarness({
      branchPrefix: "compaction-ui",
      beforeRenderEnvironment: async (env) => {
        // Auto-recovery needs an available compaction model even with the mock router;
        // make that independent of local credentials and the catalog's context-window ordering.
        await setupProviders(env, { anthropic: { apiKey: "dummy" } });
        await env.orpc.config.updateAgentAiDefaults({
          agentAiDefaults: { compact: { modelString: KNOWN_MODELS.HAIKU.id } },
        });
      },
    });

    try {
      const triggerMessage = "Trigger context error";
      const userDraft = "My draft message that should be preserved";

      await app.chat.send(triggerMessage);

      // User starts typing while auto-compaction is in progress
      await app.chat.typeWithoutSending(userDraft);

      await app.chat.expectTranscriptContains("Mock compaction summary:", 60_000);
      await app.chat.expectTranscriptContains(`Continue with: ${triggerMessage}`, 60_000);
      await app.chat.expectTranscriptContains(`Mock response: ${triggerMessage}`, 60_000);

      // Verify user's draft was NOT overwritten by auto-compaction
      await app.chat.expectInputValue(userDraft);
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("force compaction triggers during streaming", async () => {
    const app = await createAppHarness({ branchPrefix: "compaction-ui" });

    try {
      const seedMessage = "Seed conversation for compaction";
      const triggerMessage = "[force] Trigger force compaction";

      const seedResult = await app.env.orpc.workspace.sendMessage({
        workspaceId: app.workspaceId,
        message: seedMessage,
        options: { model: WORKSPACE_DEFAULTS.model, agentId: WORKSPACE_DEFAULTS.agentId },
      });
      expect(seedResult.success).toBe(true);
      await app.chat.expectTranscriptContains(`Mock response: ${seedMessage}`);
      await setDeterministicForceCompactionThreshold(app.env, app.workspaceId);

      const triggerResult = await app.env.orpc.workspace.sendMessage({
        workspaceId: app.workspaceId,
        message: triggerMessage,
        options: { model: WORKSPACE_DEFAULTS.model, agentId: WORKSPACE_DEFAULTS.agentId },
      });
      expect(triggerResult.success).toBe(true);

      const compactionAssertionTimeoutMs = 120_000;
      await app.chat.expectTranscriptContains(
        "Mock compaction summary:",
        compactionAssertionTimeoutMs
      );
      await app.chat.expectTranscriptContains(
        "Mock response: Continue",
        compactionAssertionTimeoutMs
      );
      // Compaction transcript now renders a single top boundary row.
      await app.chat.expectTranscriptContains("Compaction boundary", compactionAssertionTimeoutMs);

      // Force compaction now prunes to the latest boundary window, so the
      // pre-compaction triggering turn is no longer shown.
      await app.chat.expectTranscriptNotContains(triggerMessage, compactionAssertionTimeoutMs);
    } finally {
      await app.dispose();
    }
  }, 120_000);

  test("/compact command sends any foreground bash to background", async () => {
    const app = await createAppHarness({ branchPrefix: "compaction-ui" });

    let unregister: (() => void) | undefined;

    try {
      const manager = getBackgroundProcessManager(app.env);

      const toolCallId = "bash-foreground-compact";
      let backgrounded = false;

      const registration = manager.registerForegroundProcess(
        app.workspaceId,
        toolCallId,
        "echo foreground bash for compact",
        "foreground bash for compact",
        () => {
          backgrounded = true;
          unregister?.();
        }
      );

      unregister = registration.unregister;

      // Ensure the UI's subscription has observed the foreground bash before sending /compact.
      await waitForForegroundToolCallId(app.env, app.workspaceId, toolCallId);

      const seedMessage = "Seed conversation for /compact test";

      const seedResult = await app.env.orpc.workspace.sendMessage({
        workspaceId: app.workspaceId,
        message: seedMessage,
        options: { model: WORKSPACE_DEFAULTS.model, agentId: WORKSPACE_DEFAULTS.agentId },
      });
      expect(seedResult.success).toBe(true);
      await app.chat.expectTranscriptContains(`Mock response: ${seedMessage}`);

      // Send /compact command via the UI (like a user would)
      await app.chat.send("/compact -t 500");

      await app.chat.expectTranscriptContains("Mock compaction summary:", 60_000);

      await waitFor(
        () => {
          expect(backgrounded).toBe(true);
        },
        { timeout: 60_000 }
      );
    } finally {
      unregister?.();
      await app.dispose();
    }
  }, 60_000);

  test("/compact with Ctrl+Enter (turn-end) does NOT auto-background foreground bash", async () => {
    const app = await createAppHarness({ branchPrefix: "compaction-ui" });

    let unregister: (() => void) | undefined;

    try {
      const manager = getBackgroundProcessManager(app.env);

      const toolCallId = "bash-foreground-compact-turn-end";
      let backgrounded = false;

      const registration = manager.registerForegroundProcess(
        app.workspaceId,
        toolCallId,
        "echo foreground bash for compact turn-end",
        "foreground bash for compact turn-end",
        () => {
          backgrounded = true;
          unregister?.();
        }
      );

      unregister = registration.unregister;

      // Ensure the UI's subscription has observed the foreground bash before sending /compact.
      await waitForForegroundToolCallId(app.env, app.workspaceId, toolCallId);

      const seedMessage = "Seed conversation for /compact turn-end test";

      const seedResult = await app.env.orpc.workspace.sendMessage({
        workspaceId: app.workspaceId,
        message: seedMessage,
        options: { model: WORKSPACE_DEFAULTS.model, agentId: WORKSPACE_DEFAULTS.agentId },
      });
      expect(seedResult.success).toBe(true);
      await app.chat.expectTranscriptContains(`Mock response: ${seedMessage}`);

      await app.chat.typeWithoutSending("/compact -t 500");
      const textarea = await getActiveTextarea(app.view.container);
      fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

      await app.chat.expectTranscriptContains("Mock compaction summary:", 60_000);

      expect(backgrounded).toBe(false);
    } finally {
      unregister?.();
      await app.dispose();
    }
  }, 60_000);

  test("force compaction sends any foreground bash to background", async () => {
    const app = await createAppHarness({ branchPrefix: "compaction-ui" });

    let unregister: (() => void) | undefined;

    try {
      const manager = getBackgroundProcessManager(app.env);

      const toolCallId = "bash-foreground";
      let backgrounded = false;

      const registration = manager.registerForegroundProcess(
        app.workspaceId,
        toolCallId,
        "echo foreground bash",
        "foreground bash",
        () => {
          backgrounded = true;
          unregister?.();
        }
      );

      unregister = registration.unregister;

      // Ensure the UI's subscription has observed the foreground bash before streaming starts.
      await waitForForegroundToolCallId(app.env, app.workspaceId, toolCallId);

      const seedMessage = "Seed conversation for compaction";
      const triggerMessage = "[force] Trigger force compaction";

      const seedResult = await app.env.orpc.workspace.sendMessage({
        workspaceId: app.workspaceId,
        message: seedMessage,
        options: { model: WORKSPACE_DEFAULTS.model, agentId: WORKSPACE_DEFAULTS.agentId },
      });
      expect(seedResult.success).toBe(true);
      await app.chat.expectTranscriptContains(`Mock response: ${seedMessage}`);
      await setDeterministicForceCompactionThreshold(app.env, app.workspaceId);

      // Send via the UI path so the foreground bash auto-background logic runs exactly
      // as it does for real user sends, while backend mid-stream compaction handles the rest.
      await app.chat.send(triggerMessage);

      await app.chat.expectTranscriptContains("Mock compaction summary:", 60_000);

      await waitFor(
        () => {
          expect(backgrounded).toBe(true);
        },
        { timeout: 60_000 }
      );
    } finally {
      unregister?.();
      await app.dispose();
    }
  }, 120_000);
});

describe("Auto-follow-up and compaction notification behavior (mock AI router)", () => {
  const notifications: Array<{ title: string; body?: string }> = [];
  let originalWindowNotification: unknown;

  beforeAll(async () => {
    await preloadTestModules();
    originalWindowNotification = (globalThis as { Notification?: unknown }).Notification;
  });

  beforeEach(() => {
    notifications.length = 0;

    // Mock Notification constructor - must be on globalThis since happy-dom
    // aliases window = globalThis in our test setup
    class MockNotification {
      onclick: (() => void) | null = null;
      constructor(title: string, options?: { body?: string }) {
        notifications.push({ title, body: options?.body });
      }
      close() {}
    }

    const mockWithPermission = Object.assign(MockNotification, {
      permission: "granted",
      requestPermission: () => Promise.resolve("granted" as NotificationPermission),
    });
    (globalThis as { Notification: unknown }).Notification = mockWithPermission;
  });

  afterEach(() => {
    if (originalWindowNotification !== undefined) {
      (globalThis as { Notification?: unknown }).Notification = originalWindowNotification;
    } else {
      delete (globalThis as { Notification?: unknown }).Notification;
    }
  });

  /** Set up harness with notification mocks, send seed message, return cleanup + count */
  async function setupNotificationTest(seedMessage: string) {
    const app = await createAppHarness({ branchPrefix: "compact-notify" });

    // Mock document.hasFocus AFTER harness creates the DOM window
    // Happy-dom's hasFocus returns !!this.activeElement - clear it to return false
    const originalActiveElement = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(globalThis.document),
      "activeElement"
    );
    Object.defineProperty(globalThis.document, "activeElement", {
      get: () => null,
      configurable: true,
    });

    // Set Notification on the happy-dom window
    (window as { Notification: unknown }).Notification = (
      globalThis as { Notification: unknown }
    ).Notification;

    // Enable notifications via UI (click bell button in workspace header)
    const notifyButton = app.view.container.querySelector(
      '[data-testid="notify-on-response-button"]'
    );
    if (!notifyButton) throw new Error("Notify button not found");
    fireEvent.click(notifyButton);

    // Send seed message and wait for notification
    await app.chat.send(seedMessage);
    await app.chat.expectTranscriptContains(`Mock response: ${seedMessage}`);
    await waitFor(() => expect(notifications.length).toBeGreaterThanOrEqual(1), { timeout: 5_000 });

    const countAfterSeed = notifications.length;
    expect(countAfterSeed).toBe(1);

    const cleanup = async () => {
      if (originalActiveElement) {
        Object.defineProperty(globalThis.document, "activeElement", originalActiveElement);
      }
      await app.dispose();
    };

    return { app, countAfterSeed, cleanup };
  }

  /** Wait for new notifications after seed, return count and last notification */
  async function waitForNewNotifications(countAfterSeed: number) {
    await waitFor(() => expect(notifications.length).toBeGreaterThanOrEqual(countAfterSeed + 1), {
      timeout: 5_000,
    });
    return {
      newCount: notifications.length - countAfterSeed,
      last: notifications[notifications.length - 1],
    };
  }

  test("queued auto-follow-up should fire only ONE notification (for the follow-up response)", async () => {
    const { app, countAfterSeed, cleanup } = await setupNotificationTest(
      "Seed for queued follow-up notification test"
    );
    const streamingMessage = `[mock:wait-start] queued follow-up notification${" keep-streaming".repeat(600)}`;
    const followUpText = "Queued follow-up after streaming";

    try {
      await app.chat.send(streamingMessage);
      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await waitFor(
        () => {
          expect(workspaceStore.getWorkspaceSidebarState(app.workspaceId).canInterrupt).toBe(true);
        },
        { timeout: 30_000 }
      );

      await app.chat.send(followUpText);
      await app.chat.expectTranscriptContains(`Mock response: ${followUpText}`);
      await app.chat.expectStreamComplete();

      const { newCount, last } = await waitForNewNotifications(countAfterSeed);
      expect(newCount).toBe(1);
      expect(last.body).toContain(`Mock response: ${followUpText}`);
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("compaction with continue message should fire only ONE notification (for continue response)", async () => {
    const { app, countAfterSeed, cleanup } = await setupNotificationTest(
      "Seed for notification test"
    );
    const continueText = "Continue after compaction";

    try {
      // Send /compact with continue - should NOT fire for compaction, only for continue
      await app.chat.send(`/compact -t 500\n${continueText}`);
      await app.chat.expectTranscriptContains("Mock compaction summary:");
      await app.chat.expectTranscriptContains(`Mock response: ${continueText}`);

      const { newCount, last } = await waitForNewNotifications(countAfterSeed);
      expect(newCount).toBe(1);
      expect(last.body).toContain(`Mock response: ${continueText}`);
      expect(last.body).not.toBe("Compaction complete");
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("compaction without continue message should not fire a notification", async () => {
    const { app, countAfterSeed, cleanup } = await setupNotificationTest(
      "Seed for standalone compaction"
    );

    try {
      await app.chat.send("/compact -t 500");
      await app.chat.expectTranscriptContains("Mock compaction summary:");
      await app.chat.expectStreamComplete();

      expect(notifications.length).toBe(countAfterSeed);
    } finally {
      await cleanup();
    }
  }, 60_000);

  // Note: Force compaction interrupts an active stream. In the real backend, this would send
  // a stream-abort event and the interrupted stream would NOT trigger a notification.
  // However, the mock AI completes streams normally (no mid-stream abort simulation),
  // so the "interrupted" stream's completion still fires a notification.
  test.skip("force compaction with auto-continue should fire only ONE notification", async () => {
    const { app, countAfterSeed, cleanup } = await setupNotificationTest(
      "Seed for force compaction"
    );

    try {
      // Force compaction auto-generates a "Continue" message
      await app.chat.send("[force] Trigger force compaction");
      await app.chat.expectTranscriptContains("Mock compaction summary:", 60_000);
      await app.chat.expectTranscriptContains("Mock response: Continue", 60_000);

      const { newCount, last } = await waitForNewNotifications(countAfterSeed);
      expect(newCount).toBe(1);
      expect(last.body).toBe("Mock response: Continue");
    } finally {
      await cleanup();
    }
  }, 60_000);
});
