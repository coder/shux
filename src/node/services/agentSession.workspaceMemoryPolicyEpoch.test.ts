import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fsPromises from "fs/promises";
import * as path from "path";
import type { Config } from "@/node/config";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import { getErrorMessage } from "@/common/utils/errors";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import { readWorkspaceMemoryDenyMarker } from "@/node/services/workspaceMemoryDenyMarker";
import { AgentSession } from "./agentSession";
import { createStreamLifecycleMocks } from "./agentSession.testHarness";
import type { AIService } from "./aiService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { InitStateManager } from "./initStateManager";
import { createTestHistoryService } from "./testHistoryService";

/**
 * Durable epoch boundary of the workspace-memory write policy
 * (AgentSession.resetWorkspaceMemoryWritable / carryWorkspaceMemoryWritable):
 * Config.saveConfig swallows write failures, so both must prove their effect
 * by reading back, and a deny the carry cannot prove reached the new epoch
 * falls back to the session-dir marker.
 */
interface SessionInternals {
  resetWorkspaceMemoryWritable(options?: { closingEpoch: number }): Promise<void>;
  carryWorkspaceMemoryWritable(closingEpoch: number, nextEpoch: number): Promise<void>;
}

const WORKSPACE_ID = "policy-epoch-ws";

describe("AgentSession workspace memory policy epoch boundary", () => {
  let cleanup: (() => Promise<void>) | undefined;
  const sessions: AgentSession[] = [];

  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.dispose();
    await cleanup?.();
    cleanup = undefined;
    mock.restore();
  });

  const createSession = async () => {
    const harness = await createTestHistoryService();
    cleanup = harness.cleanup;
    const config: Config = harness.config;
    await fsPromises.mkdir(path.join(config.sessionsDir, WORKSPACE_ID), { recursive: true });
    await config.editConfig((cfg) => {
      cfg.projects.set(SCRATCH_PROJECT_CONFIG_KEY, {
        workspaces: [
          {
            kind: "scratch",
            path: path.join(config.rootDir, "scratch", WORKSPACE_ID),
            id: WORKSPACE_ID,
            name: WORKSPACE_ID,
            runtimeConfig: { type: "local" },
          },
        ],
        projectKind: "system",
        trusted: true,
      });
      return cfg;
    });
    const session = new AgentSession({
      workspaceId: WORKSPACE_ID,
      config,
      historyService: harness.historyService,
      aiService: {
        on() {
          return this;
        },
        off() {
          return this;
        },
        ...createStreamLifecycleMocks(),
        isStreaming: () => false,
      } as unknown as AIService,
      initStateManager: {
        on() {
          return this;
        },
        off() {
          return this;
        },
      } as unknown as InitStateManager,
      backgroundProcessManager: {
        cleanup: mock(() => Promise.resolve()),
        setMessageQueued: mock(() => undefined),
      } as unknown as BackgroundProcessManager,
    });
    sessions.push(session);
    const records = () =>
      findWorkspaceEntry(config.loadConfigOrDefault(), WORKSPACE_ID)?.workspace
        .workspaceMemoryWritableByEpoch;
    const setRecords = (value: Record<string, boolean>) =>
      config.editConfig((cfg) => {
        findWorkspaceEntry(cfg, WORKSPACE_ID)!.workspace.workspaceMemoryWritableByEpoch = value;
        return cfg;
      });
    // A config write the Config layer swallowed: the edit runs on a loaded
    // copy and resolves, nothing lands on disk.
    const swallowNextWrite = () =>
      spyOn(config, "editConfig").mockImplementationOnce((edit) => {
        edit(config.loadConfigOrDefault());
        return Promise.resolve();
      });
    return {
      session,
      config,
      internals: session as unknown as SessionInternals,
      sessionDir: path.join(config.sessionsDir, WORKSPACE_ID),
      records,
      setRecords,
      swallowNextWrite,
    };
  };

  test("carry re-binds the closing epoch's value and proves it, falling back to the deny marker", async () => {
    const { internals, sessionDir, records, setRecords, swallowNextWrite, config } =
      await createSession();
    // Proven carry: the closing deny moves to the new epoch key.
    await setRecords({ "-1": false });
    await internals.carryWorkspaceMemoryWritable(-1, 7);
    expect(records()).toEqual({ "7": false });
    expect(await readWorkspaceMemoryDenyMarker(sessionDir, 7)).toBe(false);

    // Swallowed write: the deny never reached epoch 9 in config, so the
    // session-dir marker denies epoch 9 instead of nothing.
    await setRecords({ "-1": false });
    swallowNextWrite();
    await internals.carryWorkspaceMemoryWritable(-1, 9);
    expect(records()).toEqual({ "-1": false });
    expect(await readWorkspaceMemoryDenyMarker(sessionDir, 9)).toBe(true);
    expect(await readWorkspaceMemoryDenyMarker(sessionDir, 7)).toBe(false);

    // Unreadable config: the closing value is unknown, which also fails closed.
    const real = config.loadConfigOrDefault.bind(config);
    const unreadable = spyOn(config, "loadConfigOrDefault").mockImplementation((options) => {
      if (options?.throwOnError) throw new Error("EIO");
      return { ...real(), projects: new Map() };
    });
    try {
      await internals.carryWorkspaceMemoryWritable(-1, 11);
    } finally {
      unreadable.mockRestore();
    }
    expect(await readWorkspaceMemoryDenyMarker(sessionDir, 11)).toBe(true);

    // A GRANT that failed to persist leaves the new epoch without a record,
    // which readers treat as "grants normally": no marker.
    await setRecords({ "-1": true });
    swallowNextWrite();
    await internals.carryWorkspaceMemoryWritable(-1, 13);
    expect(await readWorkspaceMemoryDenyMarker(sessionDir, 13)).toBe(false);
  });

  test("reset clears the mirror only once the durable clear is proven", async () => {
    const { session, internals, records, setRecords, swallowNextWrite, config } =
      await createSession();
    // Destructive boundary: every record goes, then the mirror.
    session.recordWorkspaceMemoryWritable(false);
    await setRecords({ "-1": false, "5": true });
    await internals.resetWorkspaceMemoryWritable();
    expect(records()).toBeUndefined();
    expect(session.workspaceMemoryWritableMirror()).toBeUndefined();

    // Swallowed write: a surviving `-1: false` would pin the new segment to
    // the stored-false fast path — the reset must fail (retryable) and keep
    // the mirror rather than report success.
    session.recordWorkspaceMemoryWritable(false);
    await setRecords({ "-1": false });
    swallowNextWrite();
    expect(
      await internals.resetWorkspaceMemoryWritable().then(() => null, getErrorMessage)
    ).toMatch(/did not persist/);
    expect(records()).toEqual({ "-1": false });
    expect(session.workspaceMemoryWritableMirror()).toBe(false);

    // An ABSENT config.json is not the empty default: a registered workspace
    // always has one, so its absence is transient — the reset must fail
    // (retryable) rather than clear the mirror over records it never saw.
    session.recordWorkspaceMemoryWritable(false);
    await setRecords({ "-1": false });
    const configPath = path.join(config.rootDir, "config.json");
    const savedConfig = await fsPromises.readFile(configPath);
    await fsPromises.rm(configPath);
    try {
      expect(
        await internals.resetWorkspaceMemoryWritable().then(() => null, getErrorMessage)
      ).toMatch(/absent/);
    } finally {
      await fsPromises.writeFile(configPath, savedConfig);
    }
    expect(session.workspaceMemoryWritableMirror()).toBe(false);
    expect(records()).toEqual({ "-1": false });

    // Compaction boundary, fenced to the closing epoch: the same proof.
    await setRecords({ "3": false, "8": true });
    swallowNextWrite();
    expect(
      await internals
        .resetWorkspaceMemoryWritable({ closingEpoch: 3 })
        .then(() => null, getErrorMessage)
    ).toMatch(/did not persist/);
    await internals.resetWorkspaceMemoryWritable({ closingEpoch: 3 });
    expect(records()).toEqual({ "8": true });
  });
});
