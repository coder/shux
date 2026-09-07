import { describe, expect, test, mock, afterEach } from "bun:test";
import { EventEmitter } from "events";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  LoadedSkillSnapshot,
  PostCompactionAttachment,
  TodoListAttachment,
} from "@/common/types/attachment";
import { TURNS_BETWEEN_ATTACHMENTS } from "@/common/constants/attachments";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import type { Config } from "@/node/config";

import type { AIService } from "./aiService";
import { AgentSession } from "./agentSession";
import { createStreamLifecycleMocks } from "./agentSession.testHarness";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { HistoryService } from "./historyService";
import type { InitStateManager } from "./initStateManager";
import { DisposableTempDir } from "./tempDir";
import { createTestHistoryService } from "./testHistoryService";
import { createLoadedSkillSnapshot } from "@/node/services/agentSkills/loadedSkillSnapshots";

function createSuccessfulFileEditMessage(id: string, filePath: string, diff: string): MuxMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolCallId: `tool-${id}`,
        toolName: "file_edit_replace_string",
        state: "output-available",
        input: { path: filePath },
        output: { success: true, diff },
      },
    ],
    metadata: {
      timestamp: Date.now(),
    },
  };
}

function createLoadedSkillFixture(args: {
  name: string;
  body: string;
  scope?: "project" | "global" | "built-in";
}): LoadedSkillSnapshot {
  return createLoadedSkillSnapshot({
    name: args.name,
    scope: args.scope ?? "project",
    body: args.body,
    frontmatterYaml: `name: ${args.name}\ndescription: ${args.name} description`,
  });
}

function getEditedFilePaths(attachments: PostCompactionAttachment[]): string[] {
  const editedFilesAttachment = attachments.find(
    (
      attachment
    ): attachment is Extract<PostCompactionAttachment, { type: "edited_files_reference" }> =>
      attachment.type === "edited_files_reference"
  );

  return editedFilesAttachment?.files.map((file) => file.path) ?? [];
}

function getLoadedSkillNames(attachments: PostCompactionAttachment[]): string[] {
  const loadedSkillsAttachment = attachments.find(
    (
      attachment
    ): attachment is Extract<PostCompactionAttachment, { type: "loaded_skills_snapshot" }> =>
      attachment.type === "loaded_skills_snapshot"
  );

  return loadedSkillsAttachment?.skills.map((skill) => skill.name) ?? [];
}

function getLoadedSkillAttachment(
  attachments: PostCompactionAttachment[]
): Extract<PostCompactionAttachment, { type: "loaded_skills_snapshot" }> | undefined {
  return attachments.find(
    (
      attachment
    ): attachment is Extract<PostCompactionAttachment, { type: "loaded_skills_snapshot" }> =>
      attachment.type === "loaded_skills_snapshot"
  );
}

function getTodoAttachment(
  attachments: PostCompactionAttachment[]
): TodoListAttachment | undefined {
  return attachments.find(
    (attachment): attachment is TodoListAttachment => attachment.type === "todo_list"
  );
}

function getAttachmentTypes(
  attachments: PostCompactionAttachment[]
): Array<PostCompactionAttachment["type"]> {
  return attachments.map((attachment) => attachment.type);
}

const WORKSPACE_ID = "workspace-post-compaction-test";

function createSessionForHistory(historyService: HistoryService, sessionDir: string): AgentSession {
  const aiEmitter = new EventEmitter();
  const aiService: AIService = {
    ...createStreamLifecycleMocks(),
    on(eventName: string | symbol, listener: (...args: unknown[]) => void) {
      aiEmitter.on(String(eventName), listener);
      return this;
    },
    off(eventName: string | symbol, listener: (...args: unknown[]) => void) {
      aiEmitter.off(String(eventName), listener);
      return this;
    },
    getWorkspaceMetadata: mock(() =>
      Promise.resolve({ success: false as const, error: "metadata unavailable" })
    ),
    stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
  } as unknown as AIService;

  const initStateManager: InitStateManager = {
    on() {
      return this;
    },
    off() {
      return this;
    },
  } as unknown as InitStateManager;

  const backgroundProcessManager: BackgroundProcessManager = {
    setMessageQueued: mock(() => undefined),
    cleanup: mock(() => Promise.resolve()),
  } as unknown as BackgroundProcessManager;

  const config: Config = {
    rootDir: path.dirname(sessionDir),
    sessionsDir: path.dirname(sessionDir),
    srcDir: "/tmp",
    loadConfigOrDefault: mock(() => ({})),
  } as unknown as Config;

  return new AgentSession({
    workspaceId: WORKSPACE_ID,
    config,
    historyService,
    aiService,
    initStateManager,
    backgroundProcessManager,
  });
}

interface PrivateSessionAccess {
  compactionOccurred: boolean;
  turnsSinceLastAttachment: number;
  postCompactionLoadedSkills: LoadedSkillSnapshot[];
  getPostCompactionAttachmentsIfNeeded: () => Promise<PostCompactionAttachment[] | null>;
}

async function getImmediatePostCompactionAttachments(
  session: AgentSession
): Promise<PostCompactionAttachment[]> {
  const privateSession = session as unknown as PrivateSessionAccess;
  const attachments = await privateSession.getPostCompactionAttachmentsIfNeeded();
  expect(attachments).not.toBeNull();
  return attachments ?? [];
}

async function generatePeriodicPostCompactionAttachments(
  session: AgentSession,
  loadedSkills: LoadedSkillSnapshot[] = []
): Promise<PostCompactionAttachment[]> {
  const privateSession = session as unknown as PrivateSessionAccess;

  privateSession.compactionOccurred = true;
  privateSession.turnsSinceLastAttachment = TURNS_BETWEEN_ATTACHMENTS - 1;
  privateSession.postCompactionLoadedSkills = loadedSkills;

  const attachments = await privateSession.getPostCompactionAttachmentsIfNeeded();
  expect(attachments).not.toBeNull();

  return attachments ?? [];
}

async function writePendingPostCompactionState(args: {
  sessionDir: string;
  diffs: Array<{ path: string; diff: string; truncated: boolean }>;
  loadedSkills: LoadedSkillSnapshot[];
  readFiles?: string[];
}): Promise<void> {
  await fs.mkdir(args.sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(args.sessionDir, "post-compaction.json"),
    JSON.stringify({
      version: 1,
      createdAt: Date.now(),
      diffs: args.diffs,
      loadedSkills: args.loadedSkills,
      ...(args.readFiles ? { readFiles: args.readFiles } : {}),
    })
  );
}

function getReadFilePaths(attachments: PostCompactionAttachment[]): string[] {
  const readFilesAttachment = attachments.find(
    (
      attachment
    ): attachment is Extract<PostCompactionAttachment, { type: "read_files_reference" }> =>
      attachment.type === "read_files_reference"
  );
  return readFilesAttachment?.paths ?? [];
}

describe("AgentSession post-compaction attachments", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await historyCleanup?.();
  });

  test("a context boundary discards read carryover so later turns inject no pre-boundary paths", async () => {
    using sessionDir = new DisposableTempDir("agent-session-boundary-read-carryover");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    // A compaction persisted cumulative pre-boundary read paths...
    await writePendingPostCompactionState({
      sessionDir: path.join(sessionDir.path, WORKSPACE_ID),
      diffs: [],
      loadedSkills: [],
      readFiles: ["/tmp/pre-boundary-read.ts"],
    });

    const session = createSessionForHistory(
      historyService,
      path.join(sessionDir.path, WORKSPACE_ID)
    );
    const privateSession = session as unknown as {
      getPostCompactionAttachmentsIfNeeded: (
        includeReadFiles: boolean
      ) => Promise<PostCompactionAttachment[] | null>;
    };
    try {
      // ...which a turn injects (guards the fixture against silent rot).
      const injected = await privateSession.getPostCompactionAttachmentsIfNeeded(true);
      expect(injected).not.toBeNull();
      expect(getReadFilePaths(injected ?? [])).toEqual(["/tmp/pre-boundary-read.ts"]);

      // A new context segment starts (context reset / full history clear):
      // the reset was meant to discard that context, so...
      await session.clearPostCompactionState();

      // ...no later turn may re-inject pre-boundary paths — neither
      // immediately from pending state nor via the periodic re-merge.
      for (let turn = 0; turn <= TURNS_BETWEEN_ATTACHMENTS; turn++) {
        expect(await privateSession.getPostCompactionAttachmentsIfNeeded(true)).toBeNull();
      }
      // The persisted pending state is discarded too, so a NEW session after
      // an app restart cannot resurrect the carryover either.
      const stateExists = await fs
        .access(path.join(sessionDir.path, WORKSPACE_ID, "post-compaction.json"))
        .then(
          () => true,
          () => false
        );
      expect(stateExists).toBe(false);
    } finally {
      await session.dispose();
    }
  });

  test("extracts edited file diffs from the latest durable compaction boundary slice", async () => {
    using sessionDir = new DisposableTempDir("agent-session-latest-boundary");

    const history: MuxMessage[] = [
      createSuccessfulFileEditMessage(
        "stale-before-boundary",
        "/tmp/stale-before-boundary.ts",
        "@@ -1 +1 @@\n-old\n+older\n"
      ),
      createMuxMessage("boundary-1", "assistant", "epoch 1 summary", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
      }),
      createSuccessfulFileEditMessage(
        "stale-epoch-1",
        "/tmp/stale-epoch-1.ts",
        "@@ -1 +1 @@\n-old\n+stale\n"
      ),
      createMuxMessage("boundary-2", "assistant", "epoch 2 summary", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 2,
      }),
      createSuccessfulFileEditMessage(
        "recent-epoch-2",
        "/tmp/recent-epoch-2.ts",
        "@@ -1 +1 @@\n-before\n+after\n"
      ),
    ];

    const workspaceId = "workspace-post-compaction-test";
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;
    for (const msg of history) {
      await historyService.appendToHistory(workspaceId, msg);
    }

    const session = createSessionForHistory(
      historyService,
      path.join(sessionDir.path, WORKSPACE_ID)
    );

    try {
      const attachments = await generatePeriodicPostCompactionAttachments(session);
      expect(getEditedFilePaths(attachments)).toEqual(["/tmp/recent-epoch-2.ts"]);
    } finally {
      await session.dispose();
    }
  });

  test("falls back safely when boundary markers are malformed", async () => {
    using sessionDir = new DisposableTempDir("agent-session-malformed-boundary");

    const history: MuxMessage[] = [
      createSuccessfulFileEditMessage("stale-edit", "/tmp/stale.ts", "@@ -1 +1 @@\n-old\n+stale\n"),
      createMuxMessage("malformed-boundary", "assistant", "malformed summary", {
        compacted: "user",
        compactionBoundary: true,
        // Missing compactionEpoch: marker should be ignored without crashing.
      }),
      createSuccessfulFileEditMessage(
        "recent-edit",
        "/tmp/recent.ts",
        "@@ -1 +1 @@\n-before\n+after\n"
      ),
    ];

    const workspaceId = "workspace-post-compaction-test";
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;
    for (const msg of history) {
      await historyService.appendToHistory(workspaceId, msg);
    }

    const session = createSessionForHistory(
      historyService,
      path.join(sessionDir.path, WORKSPACE_ID)
    );

    try {
      const attachments = await generatePeriodicPostCompactionAttachments(session);
      expect(getEditedFilePaths(attachments)).toEqual(["/tmp/recent.ts", "/tmp/stale.ts"]);
    } finally {
      await session.dispose();
    }
  });

  test("immediately injects persisted loaded skills alongside todo and file attachments", async () => {
    using sessionDir = new DisposableTempDir("agent-session-pending-loaded-skills");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const loadedSkill = createLoadedSkillFixture({
      name: "react-effects",
      body: "Avoid unnecessary useEffect calls.",
    });
    await writePendingPostCompactionState({
      sessionDir: path.join(sessionDir.path, WORKSPACE_ID),
      diffs: [
        {
          path: "/tmp/post-compaction.ts",
          diff: "@@ -1 +1 @@\n-old\n+new\n",
          truncated: false,
        },
      ],
      loadedSkills: [loadedSkill],
    });
    await fs.writeFile(
      path.join(sessionDir.path, WORKSPACE_ID, "todos.json"),
      JSON.stringify([{ content: "Verify loaded skills", status: "in_progress" }])
    );

    const session = createSessionForHistory(
      historyService,
      path.join(sessionDir.path, WORKSPACE_ID)
    );

    try {
      const attachments = await getImmediatePostCompactionAttachments(session);
      expect(getAttachmentTypes(attachments)).toEqual([
        "todo_list",
        "loaded_skills_snapshot",
        "edited_files_reference",
      ]);
      expect(getTodoAttachment(attachments)?.todos[0]?.content).toBe("Verify loaded skills");
      expect(getLoadedSkillNames(attachments)).toEqual(["react-effects"]);
      expect(getLoadedSkillAttachment(attachments)?.skills[0]?.body).toContain(
        "Avoid unnecessary useEffect calls."
      );
      expect(getEditedFilePaths(attachments)).toEqual(["/tmp/post-compaction.ts"]);
    } finally {
      await session.dispose();
    }
  });

  test("reinjects cached loaded skills on later turns even after pending state is acknowledged", async () => {
    using sessionDir = new DisposableTempDir("agent-session-periodic-loaded-skills");

    const history: MuxMessage[] = [
      createMuxMessage("boundary-1", "assistant", "epoch 1 summary", {
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 1,
      }),
      createSuccessfulFileEditMessage(
        "recent-edit",
        "/tmp/recent-periodic.ts",
        "@@ -1 +1 @@\n-before\n+after\n"
      ),
    ];

    const workspaceId = "workspace-post-compaction-test";
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;
    for (const msg of history) {
      await historyService.appendToHistory(workspaceId, msg);
    }

    const session = createSessionForHistory(
      historyService,
      path.join(sessionDir.path, WORKSPACE_ID)
    );
    const loadedSkill = createLoadedSkillFixture({
      name: "react-effects",
      body: "Persist this guardrail across follow-up turns.",
    });

    try {
      const attachments = await generatePeriodicPostCompactionAttachments(session, [loadedSkill]);
      expect(getLoadedSkillNames(attachments)).toEqual(["react-effects"]);
      expect(getLoadedSkillAttachment(attachments)?.skills[0]?.body).toContain(
        "Persist this guardrail across follow-up turns."
      );
      expect(getEditedFilePaths(attachments)).toEqual(["/tmp/recent-periodic.ts"]);
    } finally {
      await session.dispose();
    }
  });

  test("suppresses only loaded skills when the skills exclusion is enabled", async () => {
    using sessionDir = new DisposableTempDir("agent-session-skills-excluded");
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    await writePendingPostCompactionState({
      sessionDir: path.join(sessionDir.path, WORKSPACE_ID),
      diffs: [
        {
          path: "/tmp/excluded-skills.ts",
          diff: "@@ -1 +1 @@\n-old\n+new\n",
          truncated: false,
        },
      ],
      loadedSkills: [
        createLoadedSkillFixture({
          name: "react-effects",
          body: "This skill should be excluded.",
        }),
      ],
    });
    await fs.writeFile(
      path.join(sessionDir.path, WORKSPACE_ID, "todos.json"),
      JSON.stringify([{ content: "Keep todo attached", status: "pending" }])
    );
    await fs.writeFile(
      path.join(sessionDir.path, WORKSPACE_ID, "exclusions.json"),
      JSON.stringify({ excludedItems: ["skills"] })
    );

    const session = createSessionForHistory(
      historyService,
      path.join(sessionDir.path, WORKSPACE_ID)
    );

    try {
      const attachments = await getImmediatePostCompactionAttachments(session);
      expect(getAttachmentTypes(attachments)).toEqual(["todo_list", "edited_files_reference"]);
      expect(getTodoAttachment(attachments)?.todos[0]?.content).toBe("Keep todo attached");
      expect(getLoadedSkillNames(attachments)).toEqual([]);
      expect(getEditedFilePaths(attachments)).toEqual(["/tmp/excluded-skills.ts"]);
    } finally {
      await session.dispose();
    }
  });
});
