import "../dom";

// App-level UI tests render the creation splash first, so stub Lottie before importing the
// app harness pieces to keep happy-dom from tripping over lottie-web initialization.
jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));
import { waitFor } from "@testing-library/react";
import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { preloadTestModules, createTestEnvironment, cleanupTestEnvironment } from "../../ipc/setup";
import { createTempGitRepo, cleanupTempGitRepo, trustProject } from "../../ipc/helpers";
import {
  cleanupView,
  addProjectViaUI,
  openProjectCreationView,
  setupTestDom,
  waitForLatestDraftId,
} from "../helpers";
import { renderApp, type RenderedApp } from "../renderReviewPanel";
import { ChatHarness } from "../harness";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import { HistoryService } from "@/node/services/historyService";
import { PENDING_INITIAL_USER_MESSAGE_ID } from "@/browser/utils/messages/pendingInitialUserMessage";
import { getDraftScopeId } from "@/common/constants/storage";
import type { TestEnvironment } from "../../ipc/setup";

interface CreationHarness {
  env: TestEnvironment;
  repoPath: string;
  projectPath: string;
  draftId: string;
  view: RenderedApp;
  chat: ChatHarness;
  dispose(): Promise<void>;
}

async function createCreationHarness(options?: {
  beforeRender?: (env: TestEnvironment) => void;
}): Promise<CreationHarness> {
  const repoPath = await createTempGitRepo();
  const env = await createTestEnvironment();
  const cleanupDom = setupTestDom();

  try {
    env.services.aiService.enableMockMode();
    await trustProject(env, repoPath);

    options?.beforeRender?.(env);
    const view = renderApp({ apiClient: env.orpc });
    const projectPath = await addProjectViaUI(view, repoPath);
    await openProjectCreationView(view, projectPath);
    const draftId = await waitForLatestDraftId(projectPath);
    const chat = new ChatHarness(view.container, getDraftScopeId(projectPath, draftId));

    return {
      env,
      repoPath,
      projectPath,
      draftId,
      view,
      chat,
      async dispose() {
        const workspaces = await env.orpc.workspace.list({ archived: false }).catch(() => []);
        await Promise.all(
          workspaces
            .filter((workspace) => workspace.projectPath === projectPath)
            .map((workspace) =>
              env.orpc.workspace.remove({ workspaceId: workspace.id, options: { force: true } })
            )
        );
        await cleanupView(view, cleanupDom);
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(repoPath);
      },
    };
  } catch (error) {
    cleanupDom();
    await cleanupTestEnvironment(env);
    await cleanupTempGitRepo(repoPath);
    throw error;
  }
}

type WorkspaceSendMessageFn = TestEnvironment["orpc"]["workspace"]["sendMessage"];
type WorkspaceCreateFn = TestEnvironment["orpc"]["workspace"]["create"];

function overrideWorkspaceSendMessage(
  env: TestEnvironment,
  override: WorkspaceSendMessageFn
): () => void {
  const workspaceApi = env.orpc.workspace as typeof env.orpc.workspace & {
    sendMessage: WorkspaceSendMessageFn;
  };
  const originalSendMessage = workspaceApi.sendMessage;
  workspaceApi.sendMessage = override;
  return () => {
    workspaceApi.sendMessage = originalSendMessage;
  };
}

function overrideWorkspaceCreate(env: TestEnvironment, override: WorkspaceCreateFn): () => void {
  const workspaceApi = env.orpc.workspace as typeof env.orpc.workspace & {
    create: WorkspaceCreateFn;
  };
  const originalCreate = workspaceApi.create;
  workspaceApi.create = override;
  return () => {
    workspaceApi.create = originalCreate;
  };
}

// eslint-disable-next-line local/no-unsafe-child-process
const execAsync = promisify(exec);

function gate(): { release: () => void; wait: Promise<void> } {
  let release: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { release, wait };
}

async function waitForCreatedWorkspaceId(
  env: TestEnvironment,
  projectPath: string
): Promise<string> {
  return waitFor(
    async () => {
      const workspaces = await env.orpc.workspace.list({ archived: false });
      const createdWorkspace = workspaces.find(
        (workspace) => workspace.projectPath === projectPath
      );
      if (!createdWorkspace) {
        throw new Error("Created workspace not found yet");
      }
      return createdWorkspace.id;
    },
    { timeout: 10_000 }
  );
}

describe("New chat streaming flash regression", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("new chats show the starting barrier instead of flashing empty transcript placeholders", async () => {
    let releaseSend: () => void = () => {};
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = () => resolve();
    });
    let restoreSendMessage: () => void = () => {};
    const app = await createCreationHarness({
      beforeRender: (env) => {
        const originalSendMessage = env.orpc.workspace.sendMessage.bind(
          env.orpc.workspace
        ) as WorkspaceSendMessageFn;
        restoreSendMessage = overrideWorkspaceSendMessage(env, (async (input) => {
          await sendGate;
          return originalSendMessage(input);
        }) as WorkspaceSendMessageFn);
      },
    });

    let sawHydrationPlaceholder = false;
    let sawNoMessagesYetPlaceholder = false;
    let startedCreationSend = false;
    const observer = new MutationObserver(() => {
      if (!startedCreationSend) {
        return;
      }
      const text = app.view.container.textContent ?? "";
      if (app.view.container.querySelector('[data-testid="transcript-hydration-placeholder"]')) {
        sawHydrationPlaceholder = true;
      }
      if (text.includes("No Messages Yet")) {
        sawNoMessagesYetPlaceholder = true;
      }
    });
    observer.observe(app.view.container, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    try {
      startedCreationSend = true;
      await app.chat.send("Delay the very first send so the new chat view can settle");

      const workspaceId = await waitForCreatedWorkspaceId(app.env, app.projectPath);

      await waitFor(
        () => {
          const messageWindow = app.view.container.querySelector('[data-testid="message-window"]');
          if (!messageWindow) {
            throw new Error("Workspace chat view not rendered yet");
          }
        },
        { timeout: 10_000 }
      );

      await waitFor(
        () => {
          const state = workspaceStore.getWorkspaceSidebarState(workspaceId);
          if (!state.isStarting) {
            throw new Error("Workspace has not entered the optimistic starting state yet");
          }
        },
        { timeout: 10_000 }
      );

      await waitFor(
        () => {
          const text = app.view.container.textContent ?? "";
          expect(text.toLowerCase()).toContain("starting");
          expect(
            app.view.container.querySelector('[data-testid="transcript-hydration-placeholder"]')
          ).toBeNull();
          expect(text).not.toContain("No Messages Yet");
        },
        { timeout: 5_000 }
      );

      expect(sawHydrationPlaceholder).toBe(false);
      expect(sawNoMessagesYetPlaceholder).toBe(false);

      releaseSend();
      const workspaceChat = new ChatHarness(app.view.container, workspaceId);
      await workspaceChat.expectTranscriptContains(
        "Mock response: Delay the very first send so the new chat view can settle"
      );
      await workspaceChat.expectStreamComplete();
    } finally {
      observer.disconnect();
      restoreSendMessage();
      releaseSend();
      await app.dispose();
    }
  }, 60_000);

  test("opens the new workspace with the first message and creation card before the backend persists them", async () => {
    const typed = "Show my first message before the workspace exists";
    const createGate = gate();
    const sendGate = gate();
    const restores: Array<() => void> = [];
    const app = await createCreationHarness({
      beforeRender: (env) => {
        const originalCreate = env.orpc.workspace.create.bind(
          env.orpc.workspace
        ) as WorkspaceCreateFn;
        restores.push(
          overrideWorkspaceCreate(env, (async (input) => {
            await createGate.wait;
            return originalCreate(input);
          }) as WorkspaceCreateFn)
        );
        const originalSendMessage = env.orpc.workspace.sendMessage.bind(
          env.orpc.workspace
        ) as WorkspaceSendMessageFn;
        restores.push(
          overrideWorkspaceSendMessage(env, (async (input) => {
            await sendGate.wait;
            return originalSendMessage(input);
          }) as WorkspaceSendMessageFn)
        );
      },
    });
    const container = app.view.container;
    const chatRows = () =>
      Array.from(container.querySelectorAll<HTMLElement>('[data-testid="chat-message"]'));

    try {
      await app.chat.send(typed);

      // Creation view, before the workspace exists: the send only locks the composer. No
      // transcript rows or creation card render on the project page; they belong to the
      // workspace view the user is taken to next.
      await waitFor(
        () => {
          const textarea = container.querySelector("textarea");
          expect(textarea).not.toBeNull();
          expect(textarea!.disabled).toBe(true);
        },
        { timeout: 10_000 }
      );
      expect(chatRows()).toHaveLength(0);
      expect(container.textContent).not.toContain("Creating workspace");
      expect(container.querySelector('[data-testid="message-window"]')).toBeNull();

      createGate.release();
      const workspaceId = await waitForCreatedWorkspaceId(app.env, app.projectPath);

      // Workspace view, before the backend persists the message: the pending user row leads the
      // transcript and the creation card sits directly below it.
      await waitFor(
        () => {
          if (!container.querySelector('[data-testid="message-window"]')) {
            throw new Error("Workspace chat view not rendered yet");
          }
          const rows = chatRows();
          const pendingIndex = rows.findIndex(
            (row) => row.getAttribute("data-message-id") === PENDING_INITIAL_USER_MESSAGE_ID
          );
          const initIndex = rows.findIndex((row) =>
            /Creating workspace|Workspace created/.test(row.textContent ?? "")
          );
          expect(pendingIndex).toBe(0);
          expect(rows[pendingIndex].textContent).toContain(typed);
          expect(initIndex).toBe(1);
        },
        { timeout: 10_000 }
      );

      sendGate.release();
      const workspaceChat = new ChatHarness(container, workspaceId);
      await workspaceChat.expectTranscriptContains(`Mock response: ${typed}`);
      await workspaceChat.expectStreamComplete();

      // The durable message replaced the pending row: exactly one user row carries the text.
      await waitFor(() => {
        const rows = chatRows();
        expect(
          rows.some(
            (row) => row.getAttribute("data-message-id") === PENDING_INITIAL_USER_MESSAGE_ID
          )
        ).toBe(false);
        const userRows = rows.filter((row) => {
          const text = row.textContent ?? "";
          return text.includes(typed) && !text.includes("Mock response");
        });
        expect(userRows).toHaveLength(1);
      });
    } finally {
      createGate.release();
      sendGate.release();
      for (const restore of restores) restore();
      await app.dispose();
    }
  }, 60_000);

  test("keeps exactly one user row through hidden snapshot rows on a skill and @file first send", async () => {
    // Skill invocations and @file mentions make the backend persist hidden synthetic snapshot
    // rows ahead of the durable user row. The pending row must survive them: the DOM is
    // observed on every commit and the visible user text may never drop out once shown.
    // In-process the two rows usually land in one render, so the deterministic proof of the
    // guard lives in the aggregator and WorkspaceStore tests; this covers the live backend path
    // and proves both snapshot kinds were actually emitted.
    const typed = "/uat-skill summarize @README.md";
    const app = await createCreationHarness();
    const container = app.view.container;
    const userTextRows = () =>
      Array.from(container.querySelectorAll<HTMLElement>("[data-testid]")).filter((el) => {
        if (el.getAttribute("data-testid") !== "chat-message") return false;
        // Persisted slash rows render the command as a chip, so match the free text only.
        const text = el.textContent ?? "";
        return text.includes("summarize") && !text.includes("Mock response");
      });

    let sawUserText = false;
    let droppedOut = false;
    const observer = new MutationObserver(() => {
      const count = userTextRows().length;
      if (count > 0) {
        sawUserText = true;
      } else if (sawUserText) {
        droppedOut = true;
      }
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true });

    try {
      const skillDir = path.join(app.repoPath, ".xum", "skills", "uat-skill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "---\nname: uat-skill\ndescription: UAT skill\n---\nReply with the single word SKILL-OK.\n"
      );
      await execAsync("git add . && git commit -q -m 'Add UAT skill'", { cwd: app.repoPath });

      await app.chat.send(typed);
      const workspaceId = await waitForCreatedWorkspaceId(app.env, app.projectPath);
      const workspaceChat = new ChatHarness(container, workspaceId);
      await workspaceChat.expectTranscriptContains("Mock response");
      await workspaceChat.expectStreamComplete();

      // The durable row replaced the pending one without an intermediate empty state.
      await waitFor(() => {
        const rows = userTextRows();
        expect(rows).toHaveLength(1);
        expect(rows[0].getAttribute("data-message-id")).not.toBe(PENDING_INITIAL_USER_MESSAGE_ID);
      });
      expect(sawUserText).toBe(true);
      expect(droppedOut).toBe(false);

      // Prove the run exercised the hidden rows this guards against.
      const history = await new HistoryService(app.env.config).getHistoryFromLatestBoundary(
        workspaceId
      );
      expect(history.success).toBe(true);
      const hiddenSnapshots = (history.success ? history.data : []).filter(
        (message) => message.metadata?.synthetic === true && message.metadata.uiVisible !== true
      );
      expect(hiddenSnapshots.some((m) => m.metadata?.agentSkillSnapshot !== undefined)).toBe(true);
      expect(hiddenSnapshots.some((m) => m.metadata?.fileAtMentionSnapshot !== undefined)).toBe(
        true
      );
    } finally {
      observer.disconnect();
      await app.dispose();
    }
  }, 60_000);
});
