import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ProjectsConfig, ProjectConfig, Workspace } from "@/common/types/project";
import { Ok, Err } from "@/common/types/result";
import { createMuxMessage } from "@/common/types/message";
import {
  AGENT_STATUS_PROVIDER_FAILURE_IDLE_COOLDOWN_MS,
  AGENT_STATUS_PROVIDER_FAILURE_RETRY_ATTEMPTS,
} from "@/constants/agentStatus";
import type { Config } from "@/node/config";
import type { AIService } from "./aiService";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { WindowService } from "./windowService";
import type { WorkspaceService } from "./workspaceService";
import type { TokenizerService } from "./tokenizerService";
import { AgentStatusService } from "./agentStatusService";
import * as workspaceStatusGenerator from "./workspaceStatusGenerator";
import { createTestHistoryService } from "./testHistoryService";

interface AgentStatusServiceInternals {
  runTick(): Promise<void>;
  runForWorkspace(
    workspaceId: string,
    observedRecency?: number | null,
    streaming?: boolean
  ): Promise<void>;
}

interface ActivitySnapshotForTest {
  streaming: boolean;
  recency?: number;
}

describe("AgentStatusService", () => {
  const workspaceId = "ws-test";
  const projectPath = "/test/project";

  let historyHandle: Awaited<ReturnType<typeof createTestHistoryService>>;
  let projectsConfig: ProjectsConfig;
  let mockConfig: Config;
  let mockExtensionMetadata: ExtensionMetadataService;
  let mockWorkspaceService: WorkspaceService;
  let mockTokenizer: TokenizerService;
  let mockAiService: AIService;
  let windowService: WindowService;
  let isFocused = true;
  let setSidebarStatusMock: ReturnType<
    typeof mock<
      (
        workspaceId: string,
        status: unknown,
        options?: { skipIfRecencyAdvancedSince?: number | null; inputHash?: string | null }
      ) => Promise<{ recency: number } | null>
    >
  >;
  let getAllSnapshotsMock: ReturnType<
    typeof mock<() => Promise<Map<string, ActivitySnapshotForTest>>>
  >;
  let getSidebarStatusInputHashMock: ReturnType<
    typeof mock<(workspaceId: string) => Promise<string | null>>
  >;
  /** workspaceId → inputHash persisted with the current sidebar status. */
  let sidebarSlot: Map<string, string | null>;
  let getSnapshotMock: ReturnType<
    typeof mock<(workspaceId: string) => Promise<{ recency: number } | null>>
  >;
  let emitWorkspaceActivityMock: ReturnType<
    typeof mock<(workspaceId: string, snapshot: unknown) => void>
  >;
  let getCandidatesMock: ReturnType<typeof mock<(workspaceId: string) => Promise<string[]>>>;
  let generateSpy: ReturnType<
    typeof spyOn<typeof workspaceStatusGenerator, "generateWorkspaceStatus">
  >;

  function makeWorkspaceEntry(overrides: Partial<Workspace> = {}): Workspace {
    return {
      id: workspaceId,
      name: workspaceId,
      path: "/test/path",
      ...overrides,
    } as unknown as Workspace;
  }

  function makeProjectsConfig(workspaces: Workspace[]): ProjectsConfig {
    return {
      projects: new Map<string, ProjectConfig>([
        [projectPath, { workspaces } as unknown as ProjectConfig],
      ]),
    };
  }

  // Bypass the scheduler timers so each test step is deterministic.
  function createService(options?: { clock?: () => number }): AgentStatusService {
    return new AgentStatusService(
      mockConfig,
      historyHandle.historyService,
      mockTokenizer,
      mockExtensionMetadata,
      mockWorkspaceService,
      windowService,
      mockAiService,
      {
        clock: options?.clock,
        tickIntervalMs: 60 * 60 * 1000,
      }
    );
  }

  function getInternals(service: AgentStatusService): AgentStatusServiceInternals {
    return service as unknown as AgentStatusServiceInternals;
  }

  beforeEach(async () => {
    historyHandle = await createTestHistoryService();
    projectsConfig = makeProjectsConfig([makeWorkspaceEntry()]);

    mockConfig = {
      loadConfigOrDefault: mock(() => projectsConfig),
      sessionsDir: historyHandle.config.sessionsDir,
    } as unknown as Config;

    emitWorkspaceActivityMock = mock(() => undefined);
    getCandidatesMock = mock((_id: string) => Promise.resolve(["anthropic:claude-haiku-4-5"]));
    mockWorkspaceService = {
      getWorkspaceTitleModelCandidates: getCandidatesMock,
      emitWorkspaceActivity: emitWorkspaceActivityMock,
    } as unknown as WorkspaceService;

    // Stateful fake for the shared status slot: mirrors the real service,
    // where the reader returns a hash only while a live status backs it. The
    // dedup recheck depends on this coupling, so a plain null-returning mock
    // would wrongly invalidate every persisted settle.
    sidebarSlot = new Map();
    setSidebarStatusMock = mock(
      (workspaceId: string, status: unknown, options?: { inputHash?: string | null }) => {
        if (status) {
          sidebarSlot.set(workspaceId, options?.inputHash ?? null);
        } else {
          sidebarSlot.delete(workspaceId);
        }
        return Promise.resolve({ recency: 0 });
      }
    );
    // Default: no snapshots → no workspaces are streaming → idle intervals.
    // Tests that exercise the active intervals override this per-test.
    getAllSnapshotsMock = mock(() => Promise.resolve(new Map<string, ActivitySnapshotForTest>()));
    getSnapshotMock = mock((_workspaceId: string) => Promise.resolve(null));
    getSidebarStatusInputHashMock = mock((workspaceId: string) =>
      Promise.resolve(sidebarSlot.get(workspaceId) ?? null)
    );
    mockExtensionMetadata = {
      setSidebarStatus: setSidebarStatusMock,
      getAllSnapshots: getAllSnapshotsMock,
      getSnapshot: getSnapshotMock,
      getSidebarStatusInputHash: getSidebarStatusInputHashMock,
    } as unknown as ExtensionMetadataService;

    mockTokenizer = {
      // Cheap deterministic tokenizer (~1 token per 4 chars).
      countTokensBatch: mock((_model: string, texts: string[]) =>
        Promise.resolve(texts.map((t) => Math.ceil(t.length / 4)))
      ),
    } as unknown as TokenizerService;

    mockAiService = {} as unknown as AIService;

    isFocused = true;
    windowService = { isFocused: () => isFocused } as unknown as WindowService;

    generateSpy = spyOn(workspaceStatusGenerator, "generateWorkspaceStatus").mockResolvedValue(
      Ok({
        status: { emoji: "🛠️", message: "Editing source" },
        modelUsed: "anthropic:claude-haiku-4-5",
      })
    );
  });

  afterEach(async () => {
    generateSpy.mockRestore();
    await historyHandle.cleanup();
  });

  test("generates and persists a fresh AI status when chat history exists", async () => {
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "Please run the test suite")
    );
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("a1", "assistant", "Running tests now")
    );

    const service = createService();
    await getInternals(service).runForWorkspace(workspaceId);

    expect(generateSpy).toHaveBeenCalledTimes(1);
    const generationCall = generateSpy.mock.calls[0];
    expect(generationCall[0]).toContain("User: Please run the test suite");
    expect(generationCall[0]).toContain("Assistant: Running tests now");
    expect(generationCall[1]).toEqual(["anthropic:claude-haiku-4-5"]);

    expect(setSidebarStatusMock).toHaveBeenCalledTimes(1);
    const [persistedWorkspaceId, persistedStatus] = setSidebarStatusMock.mock.calls[0];
    expect(persistedWorkspaceId).toBe(workspaceId);
    expect(persistedStatus).toEqual({ emoji: "🛠️", message: "Editing source" });
  });

  test("skips regeneration when the trailing transcript is unchanged (dedup)", async () => {
    // "Frozen chat" behavior: identical hash → no further LLM calls.
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "Idle workspace")
    );

    const service = createService();
    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(setSidebarStatusMock).toHaveBeenCalledTimes(1);

    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(setSidebarStatusMock).toHaveBeenCalledTimes(1);
  });

  test("includes the in-flight partial assistant message so the hash refreshes mid-stream", async () => {
    // The assistant's mid-stream output lives in partial.json before being
    // committed to chat.jsonl. If buildTrailingTranscript ignored partials,
    // the hash would stay constant during long streams and dedup would
    // suppress the very updates the feature exists to surface.
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "kick off a long task")
    );

    const service = createService();
    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(1);

    const partial = createMuxMessage("a-partial", "assistant", "Reading config files");
    await historyHandle.historyService.writePartial(workspaceId, partial);

    // Dedup would have suppressed this second call if the partial was missing
    // from the trailing window. The partial assistant message must also be
    // tagged "(in progress)" so the prompt knows the prose isn't finalized —
    // this is the marker that prevents stale past-tense statuses during
    // long streams (e.g. emitting "Deployed service" while still deploying).
    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(generateSpy.mock.calls[1][0]).toContain("Assistant (in progress): Reading config files");
  });

  test("transcript tags in-flight tool calls 'running' and completed ones 'done'", async () => {
    // Lifecycle markers are the highest-signal datum the status model has
    // for distinguishing "Deploying service" (call still running) from
    // "Deployed service" (call returned). Regressing the phase suffix would
    // bring back the historical past-tense-while-deploying bug.
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "deploy the service")
    );
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("a1", "assistant", "Kicking off deploy", undefined, [
        {
          type: "dynamic-tool",
          toolCallId: "call-running",
          toolName: "bash",
          state: "input-available",
          input: { command: "deploy.sh" },
        },
        {
          type: "dynamic-tool",
          toolCallId: "call-done",
          toolName: "read_file",
          state: "output-available",
          input: { path: "README.md" },
          output: "ok",
        },
      ])
    );

    const service = createService();
    await getInternals(service).runForWorkspace(workspaceId);

    expect(generateSpy).toHaveBeenCalledTimes(1);
    const transcript = generateSpy.mock.calls[0][0];
    expect(transcript).toContain("[tool bash running]");
    expect(transcript).toContain("[tool read_file done]");
  });

  test("forwards the live streaming bit to the prompt builder", async () => {
    // ExtensionMetadataService observes provider streaming state and
    // AgentStatusService must forward it to generateWorkspaceStatus so the
    // prompt can lock in present-progressive tense when the assistant is
    // mid-response. Without this plumbing the model would have to infer
    // liveness from prose alone — the exact failure mode this fix exists
    // for.
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "deploy the service")
    );
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("a1", "assistant", "Deploying now")
    );

    const service = createService();
    await getInternals(service).runForWorkspace(workspaceId, null, true);

    expect(generateSpy).toHaveBeenCalledTimes(1);
    // Generator signature: (transcript, candidates, aiService, options).
    // Asserting the options object reaches the generator catches a
    // regression where the streaming bit gets silently dropped at the
    // dispatch boundary.
    // toMatchObject: the options also carry a recordUsage cost-telemetry
    // callback; this test only cares that the streaming bit is forwarded.
    expect(generateSpy.mock.calls[0][3]).toMatchObject({ streaming: true });
  });

  test("dedup hash includes the streaming bit so liveness flips force a re-generation", async () => {
    // Regression guard: `streaming` now changes the prompt's tense
    // guidance, so it must participate in the dedup hash. Without this,
    // an interrupted stream (which leaves partial.json unchanged) could
    // stay settled on the streaming=true status forever, exactly the
    // stale "Deploying service" sidebar bug this PR exists to fix.
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "deploy the service")
    );
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("a1", "assistant", "Deploying now")
    );

    const service = createService();
    await getInternals(service).runForWorkspace(workspaceId, null, true);
    expect(generateSpy).toHaveBeenCalledTimes(1);

    // Same transcript bytes, streaming flipped to false. If `streaming`
    // were missing from the hash, dedup would suppress this call and the
    // sidebar would never re-evaluate tense after the stream ended.
    await getInternals(service).runForWorkspace(workspaceId, null, false);
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(generateSpy.mock.calls[1][3]).toMatchObject({ streaming: false });
  });

  test("re-generates after the trailing transcript changes", async () => {
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "Initial request")
    );
    const service = createService();
    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(1);

    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u2", "user", "Second request")
    );
    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(setSidebarStatusMock).toHaveBeenCalledTimes(2);
  });

  test("skips regeneration when there is no chat history yet", async () => {
    // Empty workspaces have nothing to summarize. Don't pay for a
    // hallucinated status, and don't blank an existing todoStatus on disk.
    const service = createService();
    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).not.toHaveBeenCalled();
    expect(setSidebarStatusMock).not.toHaveBeenCalled();
  });

  test("empty workspaces consume observed recency so they do not starve populated workspaces", async () => {
    const emptyWorkspaceId = "ws-empty";
    projectsConfig = makeProjectsConfig([
      makeWorkspaceEntry({ id: emptyWorkspaceId, name: emptyWorkspaceId } as Partial<Workspace>),
      makeWorkspaceEntry(),
    ]);
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "Populated workspace")
    );
    getAllSnapshotsMock.mockImplementation(() =>
      Promise.resolve(
        new Map<string, ActivitySnapshotForTest>([
          [emptyWorkspaceId, { streaming: false, recency: 100 }],
        ])
      )
    );

    let now = 1_000_000;
    const service = createService({ clock: () => now });
    const internals = getInternals(service);

    await internals.runTick();
    expect(generateSpy).not.toHaveBeenCalled();

    now += 10_000;
    await internals.runTick();

    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(generateSpy.mock.calls[0][0]).toContain("User: Populated workspace");
  });

  test("idle workspaces regenerate at the idle focused/unfocused intervals", async () => {
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "Hello")
    );
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("a1", "assistant", "Hi")
    );

    let now = 1_000_000;
    const service = createService({ clock: () => now });
    const internals = getInternals(service);

    // First focused tick generates. We mutate history between ticks so the
    // dedup hash differs — otherwise this test would pass for the wrong
    // reason.
    isFocused = true;
    await internals.runTick();
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u2", "user", "follow-up A")
    );
    expect(generateSpy).toHaveBeenCalledTimes(1);

    // Inside the focused interval: skipped.
    now += 5_000;
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(1);

    // Past the focused interval: regenerates.
    now += 30_000;
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(2);

    // Unfocused: 60s elapsed is past focused but short of the unfocused
    // interval (2 minutes), so the scheduler must wait.
    isFocused = false;
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u3", "user", "follow-up B")
    );
    now += 60_000;
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(2);

    // Past the unfocused interval: regenerates.
    now += 120_000;
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(3);
  });

  test("a user message recency bump bypasses the idle cadence so stale pre-pivot status refreshes", async () => {
    // User rationale: a chat message is often a real pivot to the task at
    // hand. If we wait for the normal idle cadence, the sidebar can keep
    // showing the old pre-pivot status after the user has clearly changed
    // direction.
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "Initial request")
    );

    let recency = 100;
    getAllSnapshotsMock.mockImplementation(() =>
      Promise.resolve(
        new Map<string, ActivitySnapshotForTest>([[workspaceId, { streaming: false, recency }]])
      )
    );

    let now = 1_000_000;
    const service = createService({ clock: () => now });
    const internals = getInternals(service);

    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(1);

    now += 5_000;
    recency = 200;
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u2", "user", "Pivot to new task")
    );
    await internals.runTick();

    // Still inside the 30s idle-focused interval, but the user-recency bump
    // resets the clock so we regenerate against the pivot immediately.
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(generateSpy.mock.calls[1][0]).toContain("User: Pivot to new task");

    now += 5_000;
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("a1", "assistant", "Acknowledged")
    );
    await internals.runTick();

    // Non-user transcript changes still obey cadence when recency is stable.
    expect(generateSpy).toHaveBeenCalledTimes(2);
  });

  test("does not consume a user recency bump until the pivot message reaches history", async () => {
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "Initial request")
    );

    let recency = 100;
    getAllSnapshotsMock.mockImplementation(() =>
      Promise.resolve(
        new Map<string, ActivitySnapshotForTest>([[workspaceId, { streaming: false, recency }]])
      )
    );

    let now = 1_000_000;
    const service = createService({ clock: () => now });
    const internals = getInternals(service);

    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(1);

    // sendMessage updates workspace recency before the user message is
    // durably appended to history. A scheduler tick in that gap sees the
    // recency bump but the old transcript hash; it must leave the bump
    // unconsumed so the next tick can still bypass cadence once history
    // catches up.
    now += 5_000;
    recency = now;
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(1);

    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u2", "user", "Pivot after recency")
    );
    now += 10_000;
    await internals.runTick();

    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(generateSpy.mock.calls[1][0]).toContain("User: Pivot after recency");
  });

  test("recency catch-up wait still fires when only streaming flipped between ticks", async () => {
    // The history-catch-up guard keys on the transcript-only hash so a
    // streaming-bit flip (idle→streaming, common when a fresh user
    // message kicks off provider streaming) does NOT look like a
    // transcript change and bypass the wait. If we folded `streaming`
    // into the same hash the guard uses, the service would generate
    // against the still-old transcript and consume the recency bump.
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "Initial request")
    );

    let recency = 100;
    let streaming = false;
    getAllSnapshotsMock.mockImplementation(() =>
      Promise.resolve(
        new Map<string, ActivitySnapshotForTest>([[workspaceId, { streaming, recency }]])
      )
    );

    let now = 1_000_000;
    const service = createService({ clock: () => now });
    const internals = getInternals(service);

    // First tick: settle on the initial transcript with streaming=false.
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(1);

    // Recency advances (sendMessage fired) AND streaming flips on, but the
    // pivot user message has not been appended to history yet. The guard
    // must still defer — exactly the regression Codex caught: if the
    // recency-catch-up comparison used a streaming-inclusive hash, the
    // flipped bit would make the hashes diverge and the wait would be
    // skipped.
    now += 5_000;
    recency = now;
    streaming = true;
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(1);
  });

  test("defers a first recent recency bump so startup cannot settle on stale pre-pivot history", async () => {
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "Old request before restart")
    );

    let now = 1_000_000;
    const recency = now - 1_000;
    getAllSnapshotsMock.mockImplementation(() =>
      Promise.resolve(
        new Map<string, ActivitySnapshotForTest>([[workspaceId, { streaming: false, recency }]])
      )
    );

    const service = createService({ clock: () => now });
    const internals = getInternals(service);

    // After a restart the in-memory hash baseline is empty. If this tick is
    // racing with sendMessage's recency update, generating now would settle
    // on old history and consume the pivot signal before the user message is
    // appended. Defer one tick instead.
    await internals.runTick();
    expect(generateSpy).not.toHaveBeenCalled();

    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u2", "user", "Pivot after restart")
    );
    now += 10_000;
    await internals.runTick();

    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(generateSpy.mock.calls[0][0]).toContain("User: Pivot after restart");
  });

  test("dedup skips consume stale recency priority after the history catchup window", async () => {
    const staleWorkspaceId = "ws-stale-recency";
    projectsConfig = makeProjectsConfig([
      makeWorkspaceEntry({ id: staleWorkspaceId, name: staleWorkspaceId } as Partial<Workspace>),
      makeWorkspaceEntry(),
    ]);
    await historyHandle.historyService.appendToHistory(
      staleWorkspaceId,
      createMuxMessage("u-stale", "user", "Already summarized")
    );
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u-good", "user", "Waiting behind stale recency")
    );

    let now = 1_000_000;
    let recency = 100;
    getAllSnapshotsMock.mockImplementation(() =>
      Promise.resolve(
        new Map<string, ActivitySnapshotForTest>([
          [staleWorkspaceId, { streaming: false, recency }],
        ])
      )
    );
    const service = createService({ clock: () => now });
    const internals = getInternals(service);

    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(generateSpy.mock.calls[0][0]).toContain("User: Already summarized");

    now += 5_000;
    recency = now;
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(1);

    now += 10_000;
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(1);

    now += 10_000;
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(generateSpy.mock.calls[1][0]).toContain("User: Waiting behind stale recency");
  });

  test("streaming workspaces regenerate at the active intervals (10s focused, 30s unfocused)", async () => {
    // The user-visible reason this test exists: when an agent is actively
    // working, the sidebar status should refresh fast enough that the user
    // can follow along (every 10s when watching, every 30s otherwise),
    // versus the slower 30s/120s cadence for chats that aren't moving.
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "kick off a long task")
    );
    // Mark the workspace as currently streaming so dispatch picks the
    // active intervals.
    getAllSnapshotsMock.mockImplementation(() =>
      Promise.resolve(new Map<string, { streaming: boolean }>([[workspaceId, { streaming: true }]]))
    );

    let now = 1_000_000;
    const service = createService({ clock: () => now });
    const internals = getInternals(service);

    isFocused = true;
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(1);

    // 5s elapsed: inside the active-focused 10s interval → skip.
    now += 5_000;
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("a1", "assistant", "step one")
    );
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(1);

    // 10s elapsed: at the active-focused interval → regenerates.
    now += 5_000;
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("a2", "assistant", "step two")
    );
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(2);

    // Unfocused: 10s past last run is inside the 30s active-unfocused
    // interval → skip. Only at 30s does it regenerate.
    isFocused = false;
    now += 10_000;
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("a3", "assistant", "step three")
    );
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(2);

    now += 20_000;
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(3);
  });

  test("round-robins across multiple workspaces so none starve under MAX_CONCURRENT=1", async () => {
    // With MAX_CONCURRENT=1 and a fixed iteration order, the first workspace
    // would always become re-eligible before later ones got a turn. The
    // scheduler must prioritize least-recently-run workspaces.
    const projectPathLocal = "/test/round-robin-project";
    const ids = ["ws-a", "ws-b", "ws-c"];
    const workspaces = ids.map(
      (id) => ({ id, name: id, path: `/test/path/${id}` }) as unknown as Workspace
    );
    projectsConfig = {
      projects: new Map<string, ProjectConfig>([
        [projectPathLocal, { workspaces } as unknown as ProjectConfig],
      ]),
    };
    for (const id of ids) {
      await historyHandle.historyService.appendToHistory(
        id,
        createMuxMessage(`u1-${id}`, "user", `prompt for ${id}`)
      );
    }

    let now = 1_000_000;
    const service = createService({ clock: () => now });
    const internals = getInternals(service);

    // Tick 1 covers one workspace; ticks 2 and 3 each cover a distinct
    // never-run workspace before any repeat (least-recently-run wins).
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(1);
    now += 31_000;
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(2);
    now += 31_000;
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(3);
    const persistedIds = setSidebarStatusMock.mock.calls.map((call) => call[0]);
    expect(new Set(persistedIds)).toEqual(new Set(ids));
  });

  test("does not invoke the generator if stopped during transcript build or candidates fetch", async () => {
    // Earlier awaits (history read, candidates fetch) are also yield points.
    // If stop() fires during one of them, kicking off the multi-second
    // provider call afterwards would leak LLM work past the service's
    // declared lifecycle.
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "long-running task")
    );

    let releaseCandidates!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCandidates = resolve;
    });
    getCandidatesMock.mockImplementationOnce(async () => {
      await gate;
      return ["anthropic:claude-haiku-4-5"];
    });

    const service = createService();
    const inFlight = getInternals(service).runForWorkspace(workspaceId);
    service.stop();
    releaseCandidates();
    await inFlight;

    expect(generateSpy).not.toHaveBeenCalled();
    expect(setSidebarStatusMock).not.toHaveBeenCalled();
    expect(emitWorkspaceActivityMock).not.toHaveBeenCalled();
  });

  test("does not persist or emit if the service is stopped while a generation is in flight", async () => {
    // Real provider calls can take seconds to minutes. If stop() fires
    // mid-generation (app shutdown), persisting afterwards would leak writes
    // past the declared lifecycle.
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "long-running task")
    );

    // Two-stage gate: signal when the generator actually starts (so the
    // test can fire stop() after the pre-generator guard has passed) and
    // a release the test holds until it's ready for the generator to
    // resolve.
    let signalStarted!: () => void;
    const startedSignal = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let releaseGenerate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGenerate = resolve;
    });
    generateSpy.mockImplementationOnce(async () => {
      signalStarted();
      await gate;
      return Ok({
        status: { emoji: "🛠️", message: "Doing work" },
        modelUsed: "anthropic:claude-haiku-4-5",
      });
    });

    const service = createService();
    const inFlight = getInternals(service).runForWorkspace(workspaceId);
    await startedSignal;
    service.stop();
    releaseGenerate();
    await inFlight;

    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(setSidebarStatusMock).not.toHaveBeenCalled();
    expect(emitWorkspaceActivityMock).not.toHaveBeenCalled();
  });

  test("drops a generated status if workspace recency advances while provider call is in flight", async () => {
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "Old task")
    );

    let recency = 100;
    getAllSnapshotsMock.mockImplementation(() =>
      Promise.resolve(
        new Map<string, ActivitySnapshotForTest>([[workspaceId, { streaming: false, recency }]])
      )
    );
    setSidebarStatusMock.mockImplementation((_workspaceId, _status, options) =>
      Promise.resolve(
        options?.skipIfRecencyAdvancedSince != null && recency > options.skipIfRecencyAdvancedSince
          ? null
          : { recency }
      )
    );

    let signalStarted!: () => void;
    const startedSignal = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let releaseGenerate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGenerate = resolve;
    });
    generateSpy.mockImplementationOnce(async () => {
      signalStarted();
      await gate;
      return Ok({
        status: { emoji: "🛠️", message: "Summarizing old task" },
        modelUsed: "anthropic:claude-haiku-4-5",
      });
    });

    const service = createService();
    const inFlight = getInternals(service).runForWorkspace(workspaceId, recency);
    await startedSignal;

    // A user message can advance recency while the provider is still working
    // on the old transcript. The old result must not be written after that
    // pivot, or the sidebar can resurrect stale pre-pivot status.
    recency = 200;
    releaseGenerate();
    await inFlight;

    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(setSidebarStatusMock).toHaveBeenCalledTimes(1);
    const persistOptions = setSidebarStatusMock.mock.calls[0][2];
    expect(persistOptions?.skipIfRecencyAdvancedSince).toBe(100);
    expect(typeof persistOptions?.inputHash).toBe("string");
    expect(emitWorkspaceActivityMock).not.toHaveBeenCalled();
  });

  test("a failed persistence write does not update the dedup hash, so the next tick retries", async () => {
    // Only update lastInputHash AFTER a successful persist. Otherwise a
    // transient I/O failure would leave us dedup'ing against a hash that
    // never made it to disk, silently dropping subsequent retries.
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "kick off a task")
    );

    setSidebarStatusMock.mockImplementationOnce(() => Promise.reject(new Error("disk full")));

    const service = createService();
    await getInternals(service).runForWorkspace(workspaceId);

    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(setSidebarStatusMock).toHaveBeenCalledTimes(1);
    // Activity must not emit on persist failure.
    expect(emitWorkspaceActivityMock).not.toHaveBeenCalled();

    // Same transcript, second pass: retries because the previous failure
    // left lastInputHash unchanged.
    setSidebarStatusMock.mockImplementation((_w, _s) => Promise.resolve({ recency: 0 }));
    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(setSidebarStatusMock).toHaveBeenCalledTimes(2);
    expect(emitWorkspaceActivityMock).toHaveBeenCalledTimes(1);
  });

  test("setSidebarStatus must not bump workspace recency (would re-sort idle workspaces)", async () => {
    // AgentStatusService is a background scheduler with no causal
    // connection to user activity, so its writes must not bump recency —
    // that would promote idle workspaces in the sidebar and mark them
    // unread every tick. Test ExtensionMetadataService directly to pin the
    // contract for any future caller of setSidebarStatus.
    const dir = mkdtempSync(join(tmpdir(), "mux-recency-"));
    try {
      const svc = new ExtensionMetadataService(join(dir, "metadata.json"));
      await svc.updateRecency("ws", 100);
      await svc.setSidebarStatus("ws", { emoji: "🛠️", message: "Doing work" });
      const after = await svc.getSnapshot("ws");
      expect(after?.recency).toBe(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("setSidebarStatus can atomically skip when recency advanced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mux-recency-skip-"));
    try {
      const svc = new ExtensionMetadataService(join(dir, "metadata.json"));
      await svc.updateRecency("ws", 200);
      const skipped = await svc.setSidebarStatus(
        "ws",
        { emoji: "🛠️", message: "Old status" },
        { skipIfRecencyAdvancedSince: 100, inputHash: "hash-of-stale-input" }
      );
      const after = await svc.getSnapshot("ws");

      expect(skipped).toBeNull();
      expect(after?.todoStatus).toBeUndefined();
      expect(after?.recency).toBe(200);
      // The hash must only record actually-persisted statuses: a skipped
      // write must not seed a post-restart dedup hit for a status that
      // never reached the sidebar.
      expect(await svc.getSidebarStatusInputHash("ws")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Restart-rehydration tests use a real ExtensionMetadataService on disk so
  // the dedup hash persisted by one service instance is visible to a
  // "restarted" one (fresh AgentStatusService + fresh metadata service over
  // the same file), mirroring a server restart.
  async function withRestartableMetadata(
    fn: (ctx: {
      metadataPath: string;
      newInstance: () => AgentStatusServiceInternals;
    }) => Promise<void>
  ): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "mux-agent-status-restart-"));
    try {
      const metadataPath = join(dir, "metadata.json");
      await fn({
        metadataPath,
        newInstance: () => {
          mockExtensionMetadata = new ExtensionMetadataService(metadataPath);
          return getInternals(createService());
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("restart: skips regeneration when the persisted hash matches the unchanged transcript", async () => {
    // A server restart wipes the in-memory dedup state. Without the persisted
    // seed, every restart regenerated the status for every non-empty
    // workspace — even chats idle for months (cost scales as restarts ×
    // workspaces × users, and churns status wording).
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "Idle workspace")
    );

    await withRestartableMetadata(async ({ newInstance }) => {
      await newInstance().runForWorkspace(workspaceId);
      expect(generateSpy).toHaveBeenCalledTimes(1);

      // Same history after a restart: the persisted hash must satisfy dedup.
      await newInstance().runForWorkspace(workspaceId);
      expect(generateSpy).toHaveBeenCalledTimes(1);
    });
  });

  test("restart: regenerates when history changed while down, then settles on the new hash", async () => {
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "Initial request")
    );

    await withRestartableMetadata(async ({ newInstance }) => {
      await newInstance().runForWorkspace(workspaceId);
      expect(generateSpy).toHaveBeenCalledTimes(1);

      await historyHandle.historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u2", "user", "Pivot while the server was down")
      );

      // Stale persisted hash misses dedup → regenerate. observedRecency
      // matches the on-disk recency (0, seeded by setSidebarStatus) so the
      // atomic recency-advance check doesn't drop the persist.
      await newInstance().runForWorkspace(workspaceId, 0);
      expect(generateSpy).toHaveBeenCalledTimes(2);

      // The regenerated status persisted its own hash: the next restart skips.
      await newInstance().runForWorkspace(workspaceId);
      expect(generateSpy).toHaveBeenCalledTimes(2);
    });
  });

  test("restart: legacy metadata with a status but no hash regenerates once, then settles", async () => {
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "Chat from an older build")
    );

    await withRestartableMetadata(async ({ metadataPath, newInstance }) => {
      // Metadata written by a build that predates sidebarStatusInputHash:
      // status present, hash absent. Must self-heal without migration.
      writeFileSync(
        metadataPath,
        JSON.stringify({
          version: 1,
          workspaces: {
            [workspaceId]: {
              recency: 100,
              streaming: false,
              lastModel: null,
              lastThinkingLevel: null,
              agentStatus: null,
              todoStatus: { emoji: "🛠️", message: "Pre-upgrade status" },
            },
          },
        })
      );

      // No persisted hash → falls through to the regenerate path once.
      await newInstance().runForWorkspace(workspaceId, 100);
      expect(generateSpy).toHaveBeenCalledTimes(1);

      // The regenerated status recorded its hash → the next restart skips.
      await newInstance().runForWorkspace(workspaceId);
      expect(generateSpy).toHaveBeenCalledTimes(1);
    });
  });

  test("restart: does not dedup against a hash orphaned by a todo-path clear", async () => {
    // Codex review: setTodoStatus(null) clears the shared todoStatus slot
    // without touching the persisted hash. The orphaned hash must not
    // suppress regeneration after a restart, or the sidebar stays blank
    // until the transcript changes.
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "Idle workspace")
    );

    await withRestartableMetadata(async ({ newInstance }) => {
      await newInstance().runForWorkspace(workspaceId);
      expect(generateSpy).toHaveBeenCalledTimes(1);

      // Todo path clears the slot (e.g. stream stopped with an empty todo list).
      await mockExtensionMetadata.setTodoStatus(workspaceId, null, false);

      await newInstance().runForWorkspace(workspaceId, 0);
      expect(generateSpy).toHaveBeenCalledTimes(2);
    });
  });

  test("regenerates when another writer clears the status slot behind a settled hash", async () => {
    // Codex review rounds 2-3: setTodoStatus(null) can clear the shared
    // todoStatus slot at any time after we settled by persisting — including
    // between the scheduler's snapshot read and the dedup check. The dedup
    // branch must confirm the persisted hash still exists at the skip
    // decision, or the sidebar stays blank on an unchanged transcript.
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "Idle workspace")
    );

    const service = createService();
    const internals = getInternals(service);
    await internals.runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(setSidebarStatusMock).toHaveBeenCalledTimes(1);

    // Status still present: normal dedup skip.
    await internals.runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(1);

    // Slot cleared by the todo path: the settled hash must drop and the
    // same transcript must regenerate on the very next consideration.
    sidebarSlot.delete(workspaceId);
    await internals.runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(setSidebarStatusMock).toHaveBeenCalledTimes(2);
  });

  test("an empty status slot does not retrigger placeholder-settled transcripts", async () => {
    // Placeholder settles never persisted a status, so "slot has no status"
    // is their steady state, not an invalidation signal. Rechecking them
    // would re-call the model on the same placeholder-producing transcript
    // every tick and burn provider budget.
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "kick off a task")
    );

    generateSpy.mockResolvedValueOnce(
      Ok({
        status: { emoji: "💤", message: "Awaiting next task" },
        modelUsed: "anthropic:claude-haiku-4-5",
      })
    );

    const service = createService();
    const internals = getInternals(service);
    await internals.runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(setSidebarStatusMock).not.toHaveBeenCalled();

    await internals.runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(1);
  });

  test("restart: persisted hash folds the streaming bit so an idle restart regenerates", async () => {
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "kick off a long task")
    );

    await withRestartableMetadata(async ({ newInstance }) => {
      // Status generated mid-stream: hash covers transcript + streaming=true.
      await newInstance().runForWorkspace(workspaceId, null, true);
      expect(generateSpy).toHaveBeenCalledTimes(1);

      // Restart with the workspace now idle (ExtensionMetadataService clears
      // stale streaming flags at startup): same transcript bytes, but the
      // tense guidance changed, so the persisted hash must not dedup.
      await newInstance().runForWorkspace(workspaceId, 0, false);
      expect(generateSpy).toHaveBeenCalledTimes(2);
    });
  });

  test("rejects generic placeholder messages and advances dedup so we don't loop", async () => {
    // Codex review: even with the prompt steering away from "Awaiting next
    // task" et al., small models can still emit them. We must reject them
    // post-generation so they never reach the sidebar — and we must NOT
    // re-call the model on the same transcript, because we'd just get the
    // same placeholder back and burn provider budget.
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "kick off a task")
    );

    generateSpy.mockResolvedValueOnce(
      Ok({
        status: { emoji: "💤", message: "Awaiting next task" },
        modelUsed: "anthropic:claude-haiku-4-5",
      })
    );

    const service = createService();
    await getInternals(service).runForWorkspace(workspaceId);

    // Generator was called, but persist was skipped: the placeholder must
    // not reach the sidebar.
    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(setSidebarStatusMock).not.toHaveBeenCalled();
    expect(emitWorkspaceActivityMock).not.toHaveBeenCalled();

    // Same transcript again: dedup must skip — we already learned this
    // input produces a placeholder, no point retrying until it changes.
    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(setSidebarStatusMock).not.toHaveBeenCalled();

    // After a genuine transcript change, we try again with a fresh result.
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u2", "user", "follow-up message")
    );
    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(setSidebarStatusMock).toHaveBeenCalledTimes(1);
    expect(emitWorkspaceActivityMock).toHaveBeenCalledTimes(1);
  });

  test("provider failures retry the same transcript on cooldown until recovery", async () => {
    // User rationale: sidebar status updates felt flaky when a small model
    // occasionally ignored propose_status. A single provider-side miss should
    // retry on the same transcript instead of freezing until the next chat turn,
    // and even repeated transient provider misses must eventually recover.
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "kick off a task")
    );

    generateSpy.mockReset();
    generateSpy.mockResolvedValue(
      Ok({
        status: { emoji: "🛠️", message: "Editing source" },
        modelUsed: "anthropic:claude-haiku-4-5",
      })
    );
    for (let i = 0; i < AGENT_STATUS_PROVIDER_FAILURE_RETRY_ATTEMPTS + 1; i += 1) {
      generateSpy.mockResolvedValueOnce(
        Err({
          error: { type: "unknown", raw: "model did not call propose_status" },
          reachedProvider: true,
        })
      );
    }

    let now = 1_000_000;
    const service = createService({ clock: () => now });
    const internals = getInternals(service);

    // First failures call the provider because the immediate same-input retry
    // budget is not exhausted yet.
    for (let i = 0; i < AGENT_STATUS_PROVIDER_FAILURE_RETRY_ATTEMPTS; i += 1) {
      await internals.runForWorkspace(workspaceId);
    }
    expect(generateSpy).toHaveBeenCalledTimes(AGENT_STATUS_PROVIDER_FAILURE_RETRY_ATTEMPTS);
    expect(setSidebarStatusMock).not.toHaveBeenCalled();
    expect(emitWorkspaceActivityMock).not.toHaveBeenCalled();

    // One more provider-side failure starts a cooldown. Same-input attempts
    // before the cooldown expires are skipped to avoid hammering the provider.
    await internals.runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(AGENT_STATUS_PROVIDER_FAILURE_RETRY_ATTEMPTS + 1);
    await internals.runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(AGENT_STATUS_PROVIDER_FAILURE_RETRY_ATTEMPTS + 1);
    now += AGENT_STATUS_PROVIDER_FAILURE_IDLE_COOLDOWN_MS - 1;
    await internals.runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(AGENT_STATUS_PROVIDER_FAILURE_RETRY_ATTEMPTS + 1);

    // Once the cooldown expires, the same unchanged transcript is retried and
    // can recover without requiring the user to send another message.
    now += 1;
    await internals.runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(AGENT_STATUS_PROVIDER_FAILURE_RETRY_ATTEMPTS + 2);
    expect(setSidebarStatusMock).toHaveBeenCalledTimes(1);
    expect(emitWorkspaceActivityMock).toHaveBeenCalledTimes(1);
  });

  test("pre-provider failure (auth/config) keeps retrying so a later credential fix recovers", async () => {
    // Codex review: if the first attempt happens before the user has
    // connected OAuth / configured an API key (or while a provider is
    // disabled), generateWorkspaceStatus returns an Err whose
    // reachedProvider flag is false — every candidate failed at
    // createModel, never crossed the wire to a provider. Caching that
    // failure with the transcript hash would silently freeze the workspace
    // out of AI status until the chat advances on its own. Pre-provider
    // failures must therefore stay retriable: the next tick must call
    // generateWorkspaceStatus again so a later credential/provider fix
    // recovers without requiring a new user message.
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "kick off a task")
    );

    generateSpy.mockResolvedValueOnce(
      Err({
        error: {
          type: "authentication",
          authKind: "api_key_missing",
          provider: "anthropic",
        },
        reachedProvider: false,
      })
    );

    const service = createService();
    await getInternals(service).runForWorkspace(workspaceId);

    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(setSidebarStatusMock).not.toHaveBeenCalled();

    // Same transcript, no fix yet: must retry. The scheduler still picks
    // this workspace up because the dedup hash didn't advance.
    generateSpy.mockResolvedValueOnce(
      Err({
        error: {
          type: "authentication",
          authKind: "api_key_missing",
          provider: "anthropic",
        },
        reachedProvider: false,
      })
    );
    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(setSidebarStatusMock).not.toHaveBeenCalled();

    // User fixes credentials → next attempt succeeds against the same
    // transcript (no chat change required).
    await getInternals(service).runForWorkspace(workspaceId);
    expect(generateSpy).toHaveBeenCalledTimes(3);
    expect(setSidebarStatusMock).toHaveBeenCalledTimes(1);
    expect(emitWorkspaceActivityMock).toHaveBeenCalledTimes(1);
  });

  test("pre-provider failures consume recency priority without advancing transcript dedup", async () => {
    const misconfiguredWorkspaceId = "ws-misconfigured";
    projectsConfig = makeProjectsConfig([
      makeWorkspaceEntry({
        id: misconfiguredWorkspaceId,
        name: misconfiguredWorkspaceId,
      } as Partial<Workspace>),
      makeWorkspaceEntry(),
    ]);
    await historyHandle.historyService.appendToHistory(
      misconfiguredWorkspaceId,
      createMuxMessage("u-bad", "user", "Misconfigured workspace")
    );
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u-good", "user", "Healthy workspace")
    );
    getAllSnapshotsMock.mockImplementation(() =>
      Promise.resolve(
        new Map<string, ActivitySnapshotForTest>([
          [misconfiguredWorkspaceId, { streaming: false, recency: 100 }],
        ])
      )
    );
    generateSpy.mockResolvedValueOnce(
      Err({
        error: {
          type: "authentication",
          authKind: "api_key_missing",
          provider: "anthropic",
        },
        reachedProvider: false,
      })
    );

    let now = 1_000_000;
    const service = createService({ clock: () => now });
    const internals = getInternals(service);

    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(generateSpy.mock.calls[0][0]).toContain("User: Misconfigured workspace");

    now += 10_000;
    await internals.runTick();

    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(generateSpy.mock.calls[1][0]).toContain("User: Healthy workspace");
  });

  test("pre-provider retry state does not consume a recency bump before history catches up", async () => {
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "Old misconfigured request")
    );
    let recency = 100;
    getAllSnapshotsMock.mockImplementation(() =>
      Promise.resolve(
        new Map<string, ActivitySnapshotForTest>([[workspaceId, { streaming: false, recency }]])
      )
    );
    generateSpy.mockResolvedValueOnce(
      Err({
        error: {
          type: "authentication",
          authKind: "api_key_missing",
          provider: "anthropic",
        },
        reachedProvider: false,
      })
    );

    let now = 1_000_000;
    const service = createService({ clock: () => now });
    const internals = getInternals(service);

    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(1);

    now += 5_000;
    recency = now;
    await internals.runTick();
    expect(generateSpy).toHaveBeenCalledTimes(1);

    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u2", "user", "Pivot after config failure")
    );
    now += 10_000;
    await internals.runTick();

    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(generateSpy.mock.calls[1][0]).toContain("User: Pivot after config failure");
  });

  test("archived workspaces are not regenerated", async () => {
    projectsConfig = makeProjectsConfig([
      makeWorkspaceEntry({ archivedAt: new Date().toISOString() } as Partial<Workspace>),
    ]);
    await historyHandle.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("u1", "user", "Archived chat")
    );

    const service = createService();
    await getInternals(service).runTick();

    expect(generateSpy).not.toHaveBeenCalled();
    expect(setSidebarStatusMock).not.toHaveBeenCalled();
  });
});
