import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import { log } from "@/node/services/log";
import { Config } from "./config";
import { projectRegistrationLockFilePath } from "./config/projectRegistrationLock";
import { acquireProcessFileLock } from "./utils/concurrency/fileLock";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import type { WorkspaceMetadata } from "@/common/types/workspace";

describe("Config", () => {
  let tempDir: string;
  let config: Config;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-test-"));
    config = new Config(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // Load-time migrations persist through the serialized editConfig queue (an async
  // identity transform) instead of a synchronous write-back, so tests asserting the
  // migrated on-disk form must flush the queue first. Awaiting an identity edit is
  // sufficient: it re-runs the idempotent load migrations and writes the result.
  async function flushConfigEdits(): Promise<void> {
    await config.editConfig((cfg) => cfg);
  }

  describe("Daybreak visibility migration", () => {
    const blue = "openai:daybreak-blue-latest";
    const red = "openai:daybreak-red-latest";
    const unrelated = "openrouter:openai/gpt-5";

    it.each([null, "invalid", {}])(
      "keeps legacy fallback for malformed hides: %j",
      async (hiddenModels) => {
        fs.writeFileSync(
          path.join(tempDir, "config.json"),
          JSON.stringify({ projects: [], hiddenModels })
        );
        await flushConfigEdits();
        const reloaded = new Config(tempDir).getClientConfig();
        expect(reloaded.hiddenModels).toEqual([blue, red]);
        expect(reloaded.hiddenModelsInitialized).toBe(false);
      }
    );

    it.each([undefined, null, "invalid", {}])(
      "reopens preference recovery for malformed hides after migration: %j",
      async (hiddenModels) => {
        fs.writeFileSync(
          path.join(tempDir, "config.json"),
          JSON.stringify({
            projects: [],
            hiddenModels,
            migrations: { daybreakModelsHidden: true, hiddenModelsInitialized: true },
          })
        );
        await flushConfigEdits();
        const reloaded = new Config(tempDir).getClientConfig();
        expect(reloaded.hiddenModels).toBeUndefined();
        expect(reloaded.hiddenModelsInitialized).toBe(false);

        await config.updateModelPreferences({ hiddenModels: [] });
        const recovered = new Config(tempDir).getClientConfig();
        expect(recovered.hiddenModels).toEqual([]);
        expect(recovered.hiddenModelsInitialized).toBe(true);
      }
    );

    it.each([
      { name: "fresh install", persisted: false, hiddenModels: undefined },
      { name: "legacy local-only preferences", persisted: true, hiddenModels: undefined },
      { name: "explicit empty backend preferences", persisted: true, hiddenModels: [] },
      { name: "existing backend preferences", persisted: true, hiddenModels: [unrelated, blue] },
    ])("seeds once for $name and preserves later choices", async ({ persisted, hiddenModels }) => {
      if (persisted) {
        fs.writeFileSync(
          path.join(tempDir, "config.json"),
          JSON.stringify({
            projects: [],
            defaultModel: KNOWN_MODELS.GPT.id,
            hiddenModels,
          })
        );
      }
      const seeded = config.getClientConfig();
      expect(seeded.hiddenModels).toEqual([...new Set([...(hiddenModels ?? []), blue, red])]);
      expect(seeded.hiddenModelsInitialized).toBe(hiddenModels !== undefined);
      expect(seeded.defaultModel).toBe(persisted ? KNOWN_MODELS.GPT.id : undefined);
      await flushConfigEdits();

      for (const visible of [[blue], [red], [blue, red], []]) {
        const hidden = [unrelated, ...[blue, red].filter((id) => !visible.includes(id))];
        await config.updateModelPreferences({ hiddenModels: hidden });
        const reloaded = new Config(tempDir).getClientConfig();
        expect(reloaded.hiddenModels).toEqual(hidden);
        expect(reloaded.hiddenModelsInitialized).toBe(true);
        expect(reloaded.defaultModel).toBe(seeded.defaultModel);
      }
      await config.updateModelPreferences({ hiddenModels: [] });
      expect(new Config(tempDir).getClientConfig().hiddenModels).toEqual([]);
    });
  });

  describe("loadConfigOrDefault corrupt config recovery", () => {
    function configFilePath(): string {
      return path.join(tempDir, "config.json");
    }

    function corruptBackups(): string[] {
      return fs
        .readdirSync(tempDir)
        .filter((name) => name.startsWith("config.json.corrupt-"))
        .map((name) => path.join(tempDir, name));
    }

    it("preserves malformed JSON and falls back to defaults", () => {
      const configFile = configFilePath();
      const corruptData = '{ "projects": ';
      fs.writeFileSync(configFile, corruptData);
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);

      const loaded = config.loadConfigOrDefault();

      expect(loaded.projects.size).toBe(0);
      expect(fs.readFileSync(configFile, "utf-8")).toBe(corruptData);
      const backups = corruptBackups();
      expect(backups).toHaveLength(1);
      expect(fs.readFileSync(backups[0])).toEqual(Buffer.from(corruptData));
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain(configFile);
      errorSpy.mockRestore();
    });

    it("heals invalid fields in an object without creating a backup", () => {
      fs.writeFileSync(
        configFilePath(),
        JSON.stringify({
          projects: [],
          apiServerPort: "abc",
          defaultModel: "openai:gpt-4o",
          taskSettings: { preserveSubagentsUntilArchive: true },
          migrations: {
            defaultModelFallbacksSeeded: true,
            defaultModelFallbacksSeededFable51: true,
            persistentSubagentsDefaulted: true,
          },
        })
      );

      const loaded = config.loadConfigOrDefault();

      expect(loaded.apiServerPort).toBeUndefined();
      expect(loaded.defaultModel).toBe("openai:gpt-4o");
      expect(corruptBackups()).toHaveLength(0);
    });

    it("treats a missing config as a silent fresh install", () => {
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);

      const loaded = config.loadConfigOrDefault();

      expect(loaded.projects.size).toBe(0);
      expect(corruptBackups()).toHaveLength(0);
      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it("keeps the corrupt bytes after a settings edit rewrites config.json", async () => {
      const configFile = configFilePath();
      const corruptData = '{ "projects": ';
      fs.writeFileSync(configFile, corruptData);
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);

      config.loadConfigOrDefault();
      const [backupPath] = corruptBackups();
      await config.setUpdateChannel("nightly");

      const rewritten = JSON.parse(fs.readFileSync(configFile, "utf-8")) as {
        updateChannel?: unknown;
      };
      expect(rewritten.updateChannel).toBe("nightly");
      expect(fs.readFileSync(backupPath)).toEqual(Buffer.from(corruptData));
      errorSpy.mockRestore();
    });

    it("backs up malformed JSON before rethrowing for cleanup guards", () => {
      const corruptData = '{ "projects": ';
      fs.writeFileSync(configFilePath(), corruptData);
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);

      expect(() => config.loadConfigOrDefault({ throwOnError: true })).toThrow();

      const backups = corruptBackups();
      expect(backups).toHaveLength(1);
      expect(fs.readFileSync(backups[0])).toEqual(Buffer.from(corruptData));
      errorSpy.mockRestore();
    });

    it("does not overwrite the corrupt config through edits until a backup is confirmed", async () => {
      const configFile = configFilePath();
      const corruptData = '{ "projects": ';
      fs.writeFileSync(configFile, corruptData);
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);
      const origWrite = fs.writeFileSync.bind(fs);
      const writeSpy = spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
        if (typeof file === "string" && file.includes(".corrupt-")) {
          throw new Error("disk full");
        }
        origWrite(file, data, options);
      });

      // Callers must see the blocked write as a failure, not a silent success.
      const blockedError = await config.setUpdateChannel("nightly").then(
        () => null,
        (e: unknown) => e
      );
      expect(String(blockedError)).toContain("no confirmed backup yet");

      expect(fs.readFileSync(configFile, "utf-8")).toBe(corruptData);
      expect(corruptBackups()).toHaveLength(0);

      writeSpy.mockRestore();

      await config.setUpdateChannel("nightly");

      const backups = corruptBackups();
      expect(backups).toHaveLength(1);
      expect(fs.readFileSync(backups[0])).toEqual(Buffer.from(corruptData));
      const rewritten = JSON.parse(fs.readFileSync(configFile, "utf-8")) as {
        updateChannel?: unknown;
      };
      expect(rewritten.updateChannel).toBe("nightly");
      errorSpy.mockRestore();
    });

    it("creates sidecars with owner-only permissions", () => {
      if (process.platform === "win32") {
        return;
      }
      const configFile = configFilePath();
      // Pin a permissive umask: under a 0077 umask this assertion would pass vacuously.
      const prevUmask = process.umask(0o022);
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);
      try {
        fs.writeFileSync(configFile, '{ "projects": ');
        config.loadConfigOrDefault();

        const [backup] = corruptBackups();
        // Sidecars can hold credentials; peer file proves the narrowing is not ambient.
        expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
        expect(fs.statSync(configFile).mode & 0o777).toBe(0o644);
      } finally {
        process.umask(prevUmask);
        errorSpy.mockRestore();
      }
    });

    it("aborts an edit write when the corrupt file changed after the edit loaded it", async () => {
      const configFile = configFilePath();
      const corruptA = '{ "projects": ';
      const corruptB = '{ "taskSettings": ';
      fs.writeFileSync(configFile, corruptA);
      const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);

      // Simulate a concurrent writer replacing the file between this edit's load and write.
      const raceError = await config
        .editConfig((cfg) => {
          fs.writeFileSync(configFile, corruptB);
          return cfg;
        })
        .then(
          () => null,
          (e: unknown) => e
        );
      expect(String(raceError)).toContain("changed after this edit loaded it");

      // The write was skipped: B is still on disk instead of a defaults rewrite.
      expect(fs.readFileSync(configFile, "utf-8")).toBe(corruptB);

      // The next edit's own load backs up B, so it may proceed.
      await config.setUpdateChannel("nightly");
      const contents = corruptBackups().map((p) => fs.readFileSync(p, "utf-8"));
      expect(contents).toContain(corruptA);
      expect(contents).toContain(corruptB);
      const rewritten = JSON.parse(fs.readFileSync(configFile, "utf-8")) as {
        updateChannel?: unknown;
      };
      expect(rewritten.updateChannel).toBe("nightly");
      errorSpy.mockRestore();
    });
  });

  describe("loadConfigOrDefault settingsBackup sanitizing", () => {
    it("degrades a malformed settingsBackup instead of returning it", () => {
      // Reaching the IPC output validator would fail the whole settings read, so one bad field
      // would report a load failure for every unrelated setting on the screen.
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          settingsBackup: { repoUrl: "https://oauth2:hunter2@example.com/repo.git", branch: "" },
          defaultModel: "openai:gpt-4o",
        })
      );

      const loaded = config.loadConfigOrDefault();

      expect(loaded.settingsBackup).toBeUndefined();
      expect(loaded.defaultModel).toBe("openai:gpt-4o");
    });

    it("keeps a valid settingsBackup", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          settingsBackup: {
            repoUrl: "https://github.com/me/dotfiles.git",
            branch: "main",
            path: "mux",
          },
        })
      );

      expect(config.loadConfigOrDefault().settingsBackup).toMatchObject({
        repoUrl: "https://github.com/me/dotfiles.git",
        branch: "main",
        path: "mux",
      });
    });
  });

  describe("persistent sub-agent retention migration", () => {
    it.each([
      ["missing", undefined],
      ["legacy false", false],
    ] as const)("persists true when the previous setting is %s", async (_label, legacyValue) => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [],
          taskSettings:
            legacyValue === undefined ? {} : { preserveSubagentsUntilArchive: legacyValue },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.taskSettings?.preserveSubagentsUntilArchive).toBe(true);

      await flushConfigEdits();

      const persisted = JSON.parse(fs.readFileSync(configFile, "utf-8")) as {
        taskSettings?: { preserveSubagentsUntilArchive?: boolean };
        migrations?: { persistentSubagentsDefaulted?: boolean };
      };
      expect(persisted.taskSettings?.preserveSubagentsUntilArchive).toBe(true);
      expect(persisted.migrations?.persistentSubagentsDefaulted).toBe(true);
    });

    it("canonicalizes an explicit legacy false value after the migration", async () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [],
          taskSettings: { preserveSubagentsUntilArchive: false },
          migrations: { persistentSubagentsDefaulted: true },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.taskSettings?.preserveSubagentsUntilArchive).toBe(true);

      await flushConfigEdits();

      const persisted = JSON.parse(fs.readFileSync(configFile, "utf-8")) as {
        taskSettings?: { preserveSubagentsUntilArchive?: boolean };
      };
      expect(persisted.taskSettings?.preserveSubagentsUntilArchive).toBe(true);
    });
  });

  describe("loadConfigOrDefault with trailing slash migration", () => {
    it("should strip trailing slashes from project paths on load", () => {
      // Create config file with trailing slashes in project paths
      const configFile = path.join(tempDir, "config.json");
      const corruptedConfig = {
        projects: [
          ["/home/user/project/", { workspaces: [] }],
          ["/home/user/another//", { workspaces: [] }],
          ["/home/user/clean", { workspaces: [] }],
        ],
      };
      fs.writeFileSync(configFile, JSON.stringify(corruptedConfig));

      // Load config - should migrate paths
      const loaded = config.loadConfigOrDefault();

      // Verify paths are normalized (no trailing slashes)
      const projectPaths = Array.from(loaded.projects.keys());
      expect(projectPaths).toContain("/home/user/project");
      expect(projectPaths).toContain("/home/user/another");
      expect(projectPaths).toContain("/home/user/clean");
      expect(projectPaths).not.toContain("/home/user/project/");
      expect(projectPaths).not.toContain("/home/user/another//");
    });
  });

  describe("loadConfigOrDefault customInstructions sanitizing", () => {
    it("discards malformed non-string customInstructions and keeps valid ones", () => {
      // A malformed value must not survive load: it would fail the
      // projects.list z.string() output schema and brick the project list.
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [
            ["/home/user/number", { workspaces: [], customInstructions: 42 }],
            ["/home/user/object", { workspaces: [], customInstructions: { nested: true } }],
            ["/home/user/blank", { workspaces: [], customInstructions: "   " }],
            ["/home/user/valid", { workspaces: [], customInstructions: "Keep this guidance." }],
          ],
        })
      );

      const loaded = config.loadConfigOrDefault();

      expect(loaded.projects.get("/home/user/number")?.customInstructions).toBeUndefined();
      expect(loaded.projects.get("/home/user/object")?.customInstructions).toBeUndefined();
      expect(loaded.projects.get("/home/user/blank")?.customInstructions).toBeUndefined();
      expect(loaded.projects.get("/home/user/valid")?.customInstructions).toBe(
        "Keep this guidance."
      );
    });

    it("discards malformed non-string codeWorkspaceSyncPath and keeps valid ones", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [
            ["/home/user/number", { workspaces: [], codeWorkspaceSyncPath: 42 }],
            ["/home/user/blank", { workspaces: [], codeWorkspaceSyncPath: "   " }],
            ["/home/user/valid", { workspaces: [], codeWorkspaceSyncPath: "a.code-workspace" }],
          ],
        })
      );

      const loaded = config.loadConfigOrDefault();

      expect(loaded.projects.get("/home/user/number")?.codeWorkspaceSyncPath).toBeUndefined();
      expect(loaded.projects.get("/home/user/blank")?.codeWorkspaceSyncPath).toBeUndefined();
      expect(loaded.projects.get("/home/user/valid")?.codeWorkspaceSyncPath).toBe(
        "a.code-workspace"
      );
    });
  });

  describe("legacy workflow schedule cleanup", () => {
    it("drops named workflow schedule config while loading", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [
            [
              "/repo",
              {
                workflowSchedules: [
                  {
                    id: "legacy-project-schedule",
                    enabled: true,
                    workflowName: "old-workflow",
                    intervalMs: 300_000,
                    target: { type: "new-workspace", trunkBranch: "main" },
                  },
                ],
                workspaces: [
                  {
                    path: "/repo/workspace",
                    id: "workspace-1",
                    name: "workspace",
                    workflowSchedule: {
                      enabled: true,
                      workflowName: "old-workflow",
                      intervalMs: 300_000,
                    },
                  },
                ],
              },
            ],
          ],
        })
      );

      const loaded = config.loadConfigOrDefault();
      const project = loaded.projects.get("/repo") as Record<string, unknown> | undefined;
      const workspaces = project?.workspaces;
      const workspace = Array.isArray(workspaces)
        ? (workspaces[0] as Record<string, unknown> | undefined)
        : undefined;

      expect(project?.workflowSchedules).toBeUndefined();
      expect(workspace?.workflowSchedule).toBeUndefined();
    });
  });

  describe("legacy PTC exclusive taskExperiments alias", () => {
    it("aliases programmaticToolCallingExclusive onto programmaticToolCalling at load time", () => {
      // Tasks stamped by pre-merge builds may carry only the exclusive flag;
      // loadConfigOrDefault does not parse workspaces through
      // WorkspaceConfigSchema, so the runtime loader must apply the alias
      // itself or resumed tasks silently lose PTC (and rlm becomes inert).
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [
            [
              "/repo",
              {
                workspaces: [
                  {
                    path: "/repo/task-ws",
                    id: "task-ws-1",
                    name: "task-ws",
                    taskExperiments: { rlm: true, programmaticToolCallingExclusive: true },
                  },
                ],
              },
            ],
          ],
        })
      );

      const loaded = config.loadConfigOrDefault();
      const workspaces = (loaded.projects.get("/repo") as Record<string, unknown> | undefined)
        ?.workspaces;
      const workspace = Array.isArray(workspaces)
        ? (workspaces[0] as { taskExperiments?: Record<string, unknown> } | undefined)
        : undefined;

      expect(workspace?.taskExperiments?.programmaticToolCalling).toBe(true);
      expect(workspace?.taskExperiments?.rlm).toBe(true);
      // The legacy key is retained for downgrade compatibility.
      expect(workspace?.taskExperiments?.programmaticToolCallingExclusive).toBe(true);
    });
  });

  describe("editConfig", () => {
    it("serializes concurrent edits so no update is lost", async () => {
      // Regression: editConfig used to be a non-serialized read-modify-write
      // (load → mutate → async save). Two concurrent edits could both load the
      // same snapshot, and the later write clobbered the earlier one. TaskService
      // launches tasks in parallel and flips each task's status via editConfig,
      // so a lost update left tasks stuck in "starting" (flaky
      // "resumes accepted queued starts instead of replaying prompts").
      await config.editConfig((cfg) => {
        cfg.projects.set("/repo", {
          workspaces: [
            { path: "/repo/a", id: "aaaaaaaaaa", name: "a", taskStatus: "starting" },
            { path: "/repo/b", id: "bbbbbbbbbb", name: "b", taskStatus: "starting" },
          ],
        });
        return cfg;
      });

      const setStatus = (id: string) =>
        config.editConfig((cfg) => {
          const ws = cfg.projects.get("/repo")?.workspaces.find((w) => w.id === id);
          if (ws) ws.taskStatus = "running";
          return cfg;
        });

      // Fire both edits without awaiting in between, mirroring parallel task launches.
      await Promise.all([setStatus("aaaaaaaaaa"), setStatus("bbbbbbbbbb")]);

      const workspaces = new Config(tempDir)
        .loadConfigOrDefault()
        .projects.get("/repo")?.workspaces;
      expect(workspaces?.map((w) => w.taskStatus)).toEqual(["running", "running"]);
    });

    it("keeps call order for edits that waited for the registration lock", async () => {
      // Another process holds the registration file lock; edits issued meanwhile step out of
      // the queue to wait for it. Each polls the lock, which is not fair, so left to
      // themselves a later edit could take it first and an earlier edit then overwrite it:
      // rapid true→false preference updates would persist true.
      const otherProcess = await acquireProcessFileLock({
        lockPath: projectRegistrationLockFilePath(tempDir),
        timeoutMs: 5_000,
        label: "test holder",
      });
      // Real writes, recorded: each edit spreads a new object, so the recorded arguments
      // keep the value each write carried.
      const saveConfig = spyOn(
        config as unknown as { saveConfig: (cfg: { advisorMaxUsesPerTurn?: number }) => unknown },
        "saveConfig"
      );
      const setUses = (value: number) =>
        config.editConfig((cfg) => ({ ...cfg, advisorMaxUsesPerTurn: value }));
      // Three edits while the first is still in its slot, three more once it has stepped out
      // and is waiting; the order must hold across both.
      const edits = [setUses(1), setUses(2), setUses(3)];
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(saveConfig).not.toHaveBeenCalled();
      edits.push(setUses(4), setUses(5), setUses(6));
      await otherProcess[Symbol.asyncDispose]();
      await Promise.all(edits);

      expect(saveConfig.mock.calls.map(([cfg]) => cfg.advisorMaxUsesPerTurn)).toEqual([
        1, 2, 3, 4, 5, 6,
      ]);
      expect(new Config(tempDir).loadConfigOrDefault().advisorMaxUsesPerTurn).toBe(6);
    });

    it("invokes the edit callback exactly once, with or without waiting for the lock", async () => {
      // Callbacks are not pure: TaskService.editWorkspaceEntry runs a caller-supplied updater
      // inside one, and others record results into captured state. A discarded first run
      // would let those side effects escape twice.
      let calls = 0;
      const count = (cfg: Parameters<Parameters<Config["editConfig"]>[0]>[0]) => {
        calls += 1;
        return cfg;
      };
      await config.editConfig(count);
      expect(calls).toBe(1);

      const otherProcess = await acquireProcessFileLock({
        lockPath: projectRegistrationLockFilePath(tempDir),
        timeoutMs: 5_000,
        label: "test holder",
      });
      const waiting = config.editConfig(count);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(calls).toBe(1);
      await otherProcess[Symbol.asyncDispose]();
      await waiting;
      expect(calls).toBe(2);
    });
  });

  describe("configFileWriteGeneration", () => {
    it("differs between two saves of the same content", async () => {
      const configFile = path.join(tempDir, "config.json");
      const withoutStamp = () => {
        const { writeId, ...rest } = JSON.parse(fs.readFileSync(configFile, "utf-8")) as {
          writeId: unknown;
        };
        expect(typeof writeId).toBe("string");
        return rest;
      };
      // The first save also persists load-time migrations; the two compared are steady-state.
      await flushConfigEdits();
      await config.editConfig((cfg) => cfg);
      const first = await config.configFileWriteGeneration();
      const firstContent = withoutStamp();
      await config.editConfig((cfg) => cfg);
      // Nothing but the stamp changed, and the stamp is what tells the two writes apart — a
      // reader comparing generations around a window sees the second save even where mtime
      // granularity and inode reuse would make the file look untouched.
      expect(withoutStamp()).toEqual(firstContent);
      expect(await config.configFileWriteGeneration()).not.toBe(first);
      expect(
        await new Config(
          fs.mkdtempSync(path.join(os.tmpdir(), "mux-test-"))
        ).configFileWriteGeneration()
      ).toBe("absent");
    });
  });

  describe("display-only legacy AI settings", () => {
    it.each([false, true])(
      "does not persist synthesized buckets (legacy metadata: %s)",
      async (legacyMetadata) => {
        const projectPath = path.join(tempDir, "repo");
        const legacySettings = { model: "openai:gpt-5.2", thinkingLevel: "high" as const };
        await config.editConfig((cfg) => {
          cfg.projects.set(projectPath, {
            workspaces: [
              {
                path: projectPath,
                ...(legacyMetadata ? {} : { id: "legacy-ai", name: "legacy-ai" }),
                agentId: "plan",
                aiSettings: legacySettings,
              },
            ],
          });
          return cfg;
        });
        if (legacyMetadata) {
          const sessionDir = path.join(config.sessionsDir, "repo");
          fs.mkdirSync(sessionDir, { recursive: true });
          fs.writeFileSync(
            path.join(sessionDir, "metadata.json"),
            JSON.stringify({ id: "legacy-ai", name: "legacy-ai" })
          );
        }
        const metadata = await config.getAllWorkspaceMetadata();
        expect(metadata[0]?.aiSettingsByAgent).toEqual({
          exec: legacySettings,
          plan: legacySettings,
        });
        expect(
          config.loadConfigOrDefault().projects.get(projectPath)?.workspaces[0].aiSettingsByAgent
        ).toBeUndefined();
        expect((await config.getAllWorkspaceMetadata())[0]?.aiSettingsByAgent).toEqual(
          metadata[0]?.aiSettingsByAgent
        );
        expect(
          config.loadConfigOrDefault().projects.get(projectPath)?.workspaces[0].aiSettingsByAgent
        ).toBeUndefined();
      }
    );

    it("still migrates genuine per-agent settings from legacy metadata", async () => {
      const projectPath = path.join(tempDir, "repo");
      const exec = { model: "openai:gpt-5.2", thinkingLevel: "high" as const };
      await config.editConfig((cfg) => {
        cfg.projects.set(projectPath, { workspaces: [{ path: projectPath }] });
        return cfg;
      });
      const sessionDir = path.join(config.sessionsDir, "repo");
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, "metadata.json"),
        JSON.stringify({ id: "legacy-ai", name: "legacy-ai", aiSettingsByAgent: { exec } })
      );
      await config.getAllWorkspaceMetadata();
      expect(
        config.loadConfigOrDefault().projects.get(projectPath)?.workspaces[0].aiSettingsByAgent
      ).toEqual({ exec });
    });
  });

  describe("workspace tags", () => {
    it("persists programmatic tags through save/load and metadata mapping", async () => {
      await config.editConfig((cfg) => {
        cfg.projects.set("/repo", {
          workspaces: [
            {
              path: "/repo/tagged",
              id: "tagged-ws-1",
              name: "tagged",
              tags: { workItemKey: "issue-1-investigate" },
            },
          ],
        });
        return cfg;
      });

      // Fresh instance: prove tags survive the disk round-trip (config
      // serialization + workspace schema + metadata mapping), not just memory.
      const metadata = await new Config(tempDir).getAllWorkspaceMetadata();
      const tagged = metadata.find((m) => m.id === "tagged-ws-1");
      expect(tagged?.tags).toEqual({ workItemKey: "issue-1-investigate" });
    });
  });

  describe("strict structural validation (throwOnError)", () => {
    // Destructive callers (extension-metadata pruning, orphan session-dir
    // cleanup) must never receive a lenient-normalized empty/partial workspace
    // view for a parseable but structurally invalid config: they would treat
    // the omitted live workspaces as removed and delete their data.
    const invalidShapes: Array<[string, unknown]> = [
      ["non-array projects", { projects: {} }],
      ["non-pair projects entry", { projects: ["not-a-pair"] }],
      ["non-object project config", { projects: [["/repo", null]] }],
      ["non-array workspaces", { projects: [["/repo", { workspaces: "bogus" }]] }],
      // ProjectConfigSchema always persists `workspaces`; a present project
      // entry without the key is mangled state that raw evidence flags as
      // incomplete — strict mode must not vouch "authoritatively empty" for
      // it (the prune would delete every snapshot of that project).
      ["missing workspaces key", { projects: [["/repo", {}]] }],
      // The lenient path-filter silently drops the WHOLE project for empty
      // or non-string keys, and an id-less legacy workspace inside it is
      // raw-invisible too (its stable id lives only in session
      // metadata.json) — strict mode must fail closed rather than hand the
      // prune an id set missing that workspace.
      ["null project key", { projects: [[null, { workspaces: [] }]] }],
      ["empty-string project key", { projects: [["", { workspaces: [] }]] }],
      // A truthy non-string workspace id would ride getAllWorkspaceMetadata's
      // modern-entry branch as the authoritative id, omitting the workspace's
      // REAL string identity from the prune's known set; non-object entries
      // have no establishable identity at all.
      ["non-object workspace entry", { projects: [["/repo", { workspaces: ["bogus"] }]] }],
      [
        "numeric workspace id",
        { projects: [["/repo", { workspaces: [{ id: 42, path: "/repo/ws" }] }]] },
      ],
      [
        "empty-string workspace id",
        { projects: [["/repo", { workspaces: [{ id: "", path: "/repo/ws" }] }]] },
      ],
    ];

    for (const [label, shape] of invalidShapes) {
      it(`rejects ${label} in strict mode while lenient mode still loads`, async () => {
        fs.writeFileSync(path.join(tempDir, "config.json"), JSON.stringify(shape));
        const strictConfig = new Config(tempDir);
        expect(() => strictConfig.loadConfigOrDefault({ throwOnError: true })).toThrow();
        // try/catch instead of rejects.toThrow: the node-side type-aware lint
        // flags awaiting bun's expect() chain as await-thenable.
        let strictMetadataRejected = false;
        try {
          await new Config(tempDir).getAllWorkspaceMetadata({ throwOnError: true });
        } catch {
          strictMetadataRejected = true;
        }
        expect(strictMetadataRejected).toBe(true);
        // Ordinary loads keep the historical self-healing behavior: they
        // never throw for these shapes (normalized stubs may survive).
        expect(() => new Config(tempDir).loadConfigOrDefault()).not.toThrow();
      });
    }

    it("accepts an absent projects key in strict mode (healthy empty config)", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({ defaultProjectDir: "/tmp" })
      );
      const loaded = new Config(tempDir).loadConfigOrDefault({ throwOnError: true });
      expect(loaded.projects.size).toBe(0);
    });

    it("keeps the canonical legacy identity when a secondary alias file is unreadable in lenient loads", async () => {
      // An id-less legacy entry with a HEALTHY canonical (generated-legacy)
      // metadata file and an unreadable basename-backed second candidate:
      // lenient loads must keep the canonical identity instead of
      // discarding it for skeletal path-id fallback metadata (which would
      // surface the workspace under the WRONG id with its session history
      // apparently missing). Strict enumeration still fails closed — the
      // unreadable alias may hide a registered identity.
      const projectPath = "/repo";
      const workspacePath = "/repo/legacy-ws";
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [[projectPath, { workspaces: [{ path: workspacePath }] }]],
          // Migration flags pre-seeded so the first load never schedules the
          // async settings-migration persist mid-test.
          taskSettings: { preserveSubagentsUntilArchive: true },
          migrations: { persistentSubagentsDefaulted: true, defaultModelFallbacksSeeded: true },
        })
      );
      const config = new Config(tempDir);
      const canonicalId = (
        config as unknown as {
          generateLegacyId(projectPath: string, workspacePath: string): string;
        }
      ).generateLegacyId(projectPath, workspacePath);
      const canonicalDir = path.join(config.sessionsDir, canonicalId);
      fs.mkdirSync(canonicalDir, { recursive: true });
      fs.writeFileSync(
        path.join(canonicalDir, "metadata.json"),
        JSON.stringify({ id: "stable-canonical-id", name: "legacy-ws" })
      );
      // Basename-backed second candidate is unreadable: a directory at the
      // metadata.json path fails reads with EISDIR (non-ENOENT).
      fs.mkdirSync(path.join(config.sessionsDir, "legacy-ws", "metadata.json"), {
        recursive: true,
      });

      let strictRejected = false;
      try {
        await config.getAllWorkspaceMetadata({ throwOnError: true });
      } catch {
        strictRejected = true;
      }
      expect(strictRejected).toBe(true);

      const lenient = await config.getAllWorkspaceMetadata();
      const lenientIds = lenient.map((metadata) => metadata.id);
      expect(lenientIds).toContain("stable-canonical-id");
      expect(lenientIds).not.toContain(canonicalId);
    });
  });

  describe("readPersistedWorkspaceIdSuperset", () => {
    it("ignores nested workspaces arrays inside workspace entries", () => {
      // Workspace entries (and unknown newer-build extension objects) can
      // carry nested `workspaces`-keyed fields whose ids reference OTHER —
      // including removed — workspaces. Treating them as registered would
      // lift removed ids' tombstones and recreate stale metadata
      // indefinitely; only `projects[*][1].workspaces` direct entries are
      // registration evidence.
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [
            [
              "/repo",
              {
                workspaces: [
                  {
                    id: "real-ws",
                    path: "/repo/ws",
                    workspaces: [{ id: "phantom-ws", path: "/x" }],
                  },
                ],
              },
            ],
          ],
        })
      );
      const evidence = new Config(tempDir).readPersistedWorkspaceIdEvidence();
      expect([...evidence.ids]).toEqual(["real-ws"]);
      expect(evidence.hasWorkspaceEntriesWithoutIds).toBe(false);
    });

    it("collects ids from entries that lenient normalization discards", () => {
      // `[null, ...]` fails the project-path filter and vanishes from the
      // normalized view; the raw superset must still surface its workspace id
      // so destructive callers never treat that live workspace as removed.
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [
            [null, { workspaces: [{ id: "live-discarded", path: "/tmp/x" }] }],
            ["/repo", { workspaces: [{ id: "live-normal", path: "/repo/ws", name: "ws" }] }],
          ],
        })
      );
      const superset = new Config(tempDir).readPersistedWorkspaceIdSuperset();
      expect(superset.has("live-discarded")).toBe(true);
      expect(superset.has("live-normal")).toBe(true);
    });

    it("resolves empty for a missing file and throws on unparseable content", () => {
      expect(new Config(tempDir).readPersistedWorkspaceIdSuperset().size).toBe(0);
      fs.writeFileSync(path.join(tempDir, "config.json"), "{not json");
      expect(() => new Config(tempDir).readPersistedWorkspaceIdSuperset()).toThrow();
      fs.writeFileSync(path.join(tempDir, "config.json"), JSON.stringify(["array-root"]));
      expect(() => new Config(tempDir).readPersistedWorkspaceIdSuperset()).toThrow();
    });

    it("collects only workspace-entry ids, not nested id-bearing objects", () => {
      // Workspace entries carry nested id-bearing objects (e.g.
      // taskPendingGuidance items) whose ids can reference OTHER — including
      // removed — workspaces. Treating those as registered would corrupt
      // registration evidence (aborted deletions, lifted tombstones) and
      // unbound the activity scope.
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [
            [
              "/repo",
              {
                workspaces: [
                  {
                    id: "ws-live",
                    path: "/repo/ws",
                    taskPendingGuidance: [{ id: "removed-workspace-id", message: "hi" }],
                    parentWorkspaceId: "some-parent",
                  },
                ],
              },
            ],
          ],
        })
      );
      expect(new Config(tempDir).readPersistedWorkspaceIdEvidence()).toEqual({
        ids: new Set(["ws-live"]),
        hasWorkspaceEntriesWithoutIds: false,
      });
    });

    it("reports whether any workspace entry lacks an inline id", () => {
      // Completeness signal for registration evidence: with inline ids
      // everywhere, the raw view is complete and callers may skip the
      // per-workspace authoritative enumeration; a single id-less (legacy)
      // entry means a raw-invisible stable id may exist.
      const configPath = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          projects: [["/repo", { workspaces: [{ id: "modern", path: "/repo/ws" }] }]],
        })
      );
      expect(new Config(tempDir).readPersistedWorkspaceIdEvidence()).toEqual({
        ids: new Set(["modern"]),
        hasWorkspaceEntriesWithoutIds: false,
      });
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          projects: [
            ["/repo", { workspaces: [{ id: "modern", path: "/repo/ws" }, { path: "/repo/old" }] }],
          ],
        })
      );
      const evidence = new Config(tempDir).readPersistedWorkspaceIdEvidence();
      expect(evidence.hasWorkspaceEntriesWithoutIds).toBe(true);
      expect(evidence.ids.has("modern")).toBe(true);
      // A PRESENT but malformed (non-array) container is uninterpretable:
      // the original entries may have been mangled, so the id set must not
      // be treated as complete evidence for destructive decisions.
      for (const malformed of [null, "mangled", 7]) {
        fs.writeFileSync(
          configPath,
          JSON.stringify({ projects: [["/repo", { workspaces: malformed }]] })
        );
        expect(new Config(tempDir).readPersistedWorkspaceIdEvidence()).toEqual({
          ids: new Set(),
          hasWorkspaceEntriesWithoutIds: true,
        });
      }
      // Missing file: healthy empty evidence (fresh install).
      fs.rmSync(configPath);
      expect(new Config(tempDir).readPersistedWorkspaceIdEvidence()).toEqual({
        ids: new Set(),
        hasWorkspaceEntriesWithoutIds: false,
      });
      // Malformed OUTER structure is incomplete evidence too: a mangled
      // projects container / pair / project config may be the remnant of
      // real registrations. Only an absent projects key is healthy empty.
      for (const projects of [
        null,
        {},
        "mangled",
        [null],
        ["not-a-pair"],
        [["/repo", null]],
        [["/repo", ["array-config"]]],
        [["/repo", {}]], // project config with no workspaces key at all
      ]) {
        fs.writeFileSync(configPath, JSON.stringify({ projects }));
        expect(
          new Config(tempDir).readPersistedWorkspaceIdEvidence().hasWorkspaceEntriesWithoutIds
        ).toBe(true);
      }
      fs.writeFileSync(configPath, JSON.stringify({ defaultProjectDir: "/tmp" }));
      expect(new Config(tempDir).readPersistedWorkspaceIdEvidence()).toEqual({
        ids: new Set(),
        hasWorkspaceEntriesWithoutIds: false,
      });
    });
  });

  describe("legacy task variant compatibility", () => {
    it("loads variant children as ordinary sub-agents without destroying downgrade metadata", async () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [
            [
              "/repo",
              {
                workspaces: [
                  {
                    path: "/repo/legacy-variant",
                    id: "legacy-variant",
                    name: "legacy-variant",
                    parentWorkspaceId: "parent",
                    bestOf: {
                      groupId: "legacy-variant-group",
                      index: 0,
                      total: 2,
                      kind: "variants",
                      label: "frontend",
                    },
                  },
                  {
                    path: "/repo/best-of",
                    id: "best-of",
                    name: "best-of",
                    parentWorkspaceId: "parent",
                    bestOf: { groupId: "best-of-group", index: 0, total: 2 },
                  },
                ],
              },
            ],
          ],
        })
      );

      const workspaces = config.loadConfigOrDefault().projects.get("/repo")?.workspaces;
      expect(
        workspaces?.find((workspace) => workspace.id === "legacy-variant")?.bestOf
      ).toBeUndefined();
      expect(workspaces?.find((workspace) => workspace.id === "best-of")?.bestOf).toEqual({
        groupId: "best-of-group",
        index: 0,
        total: 2,
      });

      await flushConfigEdits();
      const persisted = JSON.parse(fs.readFileSync(configFile, "utf-8")) as {
        projects?: Array<
          [
            string,
            {
              workspaces?: Array<{
                id?: string;
                bestOf?: {
                  groupId?: string;
                  index?: number;
                  total?: number;
                  kind?: string;
                  label?: string;
                };
              }>;
            },
          ]
        >;
      };
      const persistedWorkspaces = persisted.projects?.[0]?.[1].workspaces;
      expect(
        persistedWorkspaces?.find((workspace) => workspace.id === "legacy-variant")?.bestOf
      ).toEqual({
        groupId: "legacy-variant-group",
        index: 0,
        total: 2,
        kind: "variants",
        label: "frontend",
      });
      expect(
        persistedWorkspaces?.find((workspace) => workspace.id === "best-of")?.bestOf?.groupId
      ).toBe("best-of-group");
    });

    it("drops variant grouping read from legacy metadata.json", async () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [["/repo", { workspaces: [{ path: "/repo/legacy" }] }]],
        })
      );
      const sessionDir = path.join(tempDir, "sessions", "repo-legacy");
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, "metadata.json"),
        JSON.stringify({
          id: "legacy-child",
          name: "legacy",
          projectName: "repo",
          projectPath: "/repo",
          parentWorkspaceId: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          bestOf: {
            groupId: "legacy-variant-group",
            index: 0,
            total: 2,
            kind: "variants",
            label: "frontend",
          },
        })
      );

      const metadata = await config.getAllWorkspaceMetadata();
      expect(metadata).toHaveLength(1);
      expect(metadata[0]?.parentWorkspaceId).toBe("parent");
      expect(metadata[0]?.bestOf).toBeUndefined();

      await flushConfigEdits();
      const persisted = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")) as {
        projects?: Array<
          [
            string,
            { workspaces?: Array<{ id?: string; bestOf?: { kind?: string; label?: string } }> },
          ]
        >;
      };
      const persistedWorkspace = persisted.projects?.[0]?.[1].workspaces?.find(
        (workspace) => workspace.id === "legacy-child"
      );
      expect(persistedWorkspace?.bestOf).toMatchObject({
        kind: "variants",
        label: "frontend",
      });
    });
  });

  describe("legacy workspace migration identity", () => {
    // Regression (PR #3694 Codex P2): the queued ??= migration preserves values already
    // persisted in config. Returned metadata must use those same values — returning a
    // generated legacyId for a partially-migrated entry (id present, name missing) hands
    // the UI an ID that findWorkspace cannot resolve until the next reload.
    it("returns the persisted id for a partially-migrated entry and persists the same value", async () => {
      await config.editConfig((cfg) => {
        cfg.projects.set("/repo", {
          workspaces: [
            // id present, name missing -> legacy fallback path (no metadata.json on disk).
            { path: "/repo/partial", id: "persisted-id-1" },
          ],
        });
        return cfg;
      });

      const metadata = await new Config(tempDir).getAllWorkspaceMetadata();
      expect(metadata).toHaveLength(1);
      expect(metadata[0]?.id).toBe("persisted-id-1");

      // The migration must persist exactly what was returned.
      const persisted = new Config(tempDir).loadConfigOrDefault().projects.get("/repo")
        ?.workspaces[0];
      expect(persisted?.id).toBe("persisted-id-1");
      expect(persisted?.name).toBe(metadata[0]?.name);
    });

    // Regression (PR #3694 Codex P2): paths are reusable after deletion. A queued
    // migration replay recorded for a legacy entry must not apply the old workspace's
    // settings to a replacement workspace created at the same path while the replay
    // waited in the editConfig queue.
    it("does not retarget queued migrations onto a replacement workspace at the same path", async () => {
      const sharedPath = "/repo/reused";
      const staleHeartbeat = { enabled: true, intervalMs: 45 * 60 * 1000 };
      await config.editConfig((cfg) => {
        cfg.projects.set("/repo", {
          // Legacy entry (no id/name) with settings the migration would carry over.
          workspaces: [
            { path: sharedPath, aiSettings: { model: "old:model", thinkingLevel: "medium" } },
          ],
        });
        return cfg;
      });

      // Enqueue remove+recreate FIFO-ahead of getAllWorkspaceMetadata's queued replay:
      // its snapshot read (sync) sees the legacy entry, but by the time its editConfig
      // transform runs, the path belongs to a NEW workspace with a different id.
      const loader = new Config(tempDir);
      const removal = loader.editConfig((cfg) => {
        cfg.projects.set("/repo", { workspaces: [] });
        return cfg;
      });
      const recreate = loader.editConfig((cfg) => {
        cfg.projects.get("/repo")?.workspaces.push({
          id: "replacement-id",
          name: "replacement",
          path: sharedPath,
          heartbeat: staleHeartbeat,
        });
        return cfg;
      });
      await loader.getAllWorkspaceMetadata();
      await Promise.all([removal, recreate]);

      const persisted = new Config(tempDir).loadConfigOrDefault().projects.get("/repo")?.workspaces;
      expect(persisted).toHaveLength(1);
      const replacement = persisted?.[0];
      // The replacement keeps its own identity and never inherits the legacy entry's
      // migrated defaults: pre-fix the path-only replay match filled the replacement's
      // missing createdAt/runtimeConfig from the removed legacy workspace's migration.
      expect(replacement?.id).toBe("replacement-id");
      expect(replacement?.name).toBe("replacement");
      expect(replacement?.createdAt).toBeUndefined();
      expect(replacement?.runtimeConfig).toBeUndefined();
      expect(replacement?.heartbeat).toEqual(staleHeartbeat);
    });

    it("returns the persisted name for an entry missing only an id", async () => {
      await config.editConfig((cfg) => {
        cfg.projects.set("/repo", {
          workspaces: [{ path: "/repo/named", name: "persisted-name" }],
        });
        return cfg;
      });

      const metadata = await new Config(tempDir).getAllWorkspaceMetadata();
      expect(metadata).toHaveLength(1);
      expect(metadata[0]?.name).toBe("persisted-name");

      const persisted = new Config(tempDir).loadConfigOrDefault().projects.get("/repo")
        ?.workspaces[0];
      expect(persisted?.name).toBe("persisted-name");
      expect(persisted?.id).toBe(metadata[0]?.id);
    });
  });

  describe("userPreferences", () => {
    it("loads and saves user preferences", async () => {
      await config.editConfig((cfg) => ({
        ...cfg,
        userPreferences: {
          appearance: { theme: "dark" },
          navigation: { projectOrder: ["/repo"] },
        },
      }));

      const restartedConfig = new Config(tempDir);
      expect(restartedConfig.loadConfigOrDefault().userPreferences).toEqual({
        appearance: { theme: "dark" },
        navigation: { projectOrder: ["/repo"] },
      });

      const raw = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")) as {
        migrations?: { userPreferencesInitialized?: unknown };
        userPreferences?: unknown;
      };
      expect(raw.migrations?.userPreferencesInitialized).toBe(true);
      expect(raw.userPreferences).toEqual({
        appearance: { theme: "dark" },
        navigation: { projectOrder: ["/repo"] },
      });
    });

    it("preserves user preferences during unrelated saves", async () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          userPreferences: {
            appearance: { theme: "flexoki-dark" },
          },
        })
      );

      await config.editConfig((cfg) => ({
        ...cfg,
        llmDebugLogs: true,
      }));

      const raw = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")) as {
        userPreferences?: unknown;
        llmDebugLogs?: unknown;
      };
      expect(raw.userPreferences).toEqual({ appearance: { theme: "flexoki-dark" } });
      expect(raw.llmDebugLogs).toBe(true);
    });

    it("treats existing user preferences as initialized for cross-origin sync", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          userPreferences: {
            appearance: { theme: "flexoki-dark" },
          },
        })
      );

      expect(config.loadConfigOrDefault().migrations?.userPreferencesInitialized).toBe(true);
    });

    it("normalizes invalid user preference values on load", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          userPreferences: {
            appearance: { theme: "legacy-light", transcriptDensity: "wide" },
            notifications: { notifyOnResponseByWorkspace: { "ws-1": true, "ws-2": "yes" } },
          },
        })
      );

      expect(config.loadConfigOrDefault().userPreferences).toEqual({
        appearance: { theme: "light" },
        notifications: { notifyOnResponseByWorkspace: { "ws-1": true } },
      });
    });
  });

  describe("API config mutations", () => {
    it("normalizes saves while preserving omitted settings", async () => {
      await config.editConfig((current) => ({
        ...current,
        userPreferences: { appearance: { theme: "flexoki-light" } },
        taskSettings: {
          ...DEFAULT_TASK_SETTINGS,
          preserveSubagentsUntilArchive: true,
          proposePlanImplementReplacesChatHistory: true,
        },
      }));

      await config.saveUserConfig({
        taskSettings: { maxParallelAgentTasks: 4, maxTaskNestingDepth: 5 },
        agentAiDefaults: {
          foo: {
            modelString: "anthropic:claude-3-5-sonnet",
            thinkingLevel: "high",
            enabled: true,
            subagent: {
              modelString: "openai:gpt-5.6-sol",
              thinkingLevel: "xhigh",
              reasoningMode: "pro",
            },
          },
        },
      });

      const saved = config.loadConfigOrDefault();
      expect(saved.userPreferences).toEqual({ appearance: { theme: "flexoki-light" } });
      expect(saved.taskSettings).toMatchObject({
        maxParallelAgentTasks: 4,
        maxTaskNestingDepth: 5,
        preserveSubagentsUntilArchive: true,
        proposePlanImplementReplacesChatHistory: true,
      });
      expect(saved.agentAiDefaults?.foo?.subagent?.reasoningMode).toBe("pro");

      await config.saveUserConfig({ userPreferences: null });
      const cleared = config.loadConfigOrDefault();
      expect(cleared.userPreferences).toBeUndefined();
      expect(cleared.migrations?.userPreferencesInitialized).toBe(true);
    });

    it("preserves advisor validation errors", async () => {
      for (const [value, message] of [
        [1.5, "Advisor max uses per turn must be an integer"],
        [0, "Advisor max uses per turn must be positive"],
      ] as const) {
        let thrown: unknown;
        try {
          await config.saveUserConfig({ advisorMaxUsesPerTurn: value });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toBe(message);
      }
    });

    it("normalizes model and runtime mutations", async () => {
      await config.updateModelPreferences({
        defaultModel: " openai:gpt-5.6-sol ",
        hiddenModels: ["anthropic:claude-sonnet-4-5", "anthropic:claude-sonnet-4-5", ""],
      });
      await config.updateRuntimeEnablement({
        runtimeEnablement: { local: true, worktree: false },
        defaultRuntime: "worktree",
      });

      const saved = config.loadConfigOrDefault();
      expect(saved.defaultModel).toBe("openai:gpt-5.6-sol");
      expect(saved.hiddenModels).toEqual(["anthropic:claude-sonnet-4-5"]);
      expect(saved.runtimeEnablement).toEqual({ worktree: false });
      expect(saved.defaultRuntime).toBe("worktree");
    });

    it("rejects invalid route overrides before saving", async () => {
      let thrown: unknown;
      try {
        await config.updateRoutePreferences({
          routePriority: ["openai"],
          routeOverrides: { "openai:gpt-5.6-sol": "missing" },
          validateRouteOverrides: () => ({ success: false, error: "invalid route" }),
        });
      } catch (error) {
        thrown = error;
      }
      expect((thrown as Error).message).toBe("invalid route");
      expect(config.loadConfigOrDefault().routePriority).toBeUndefined();
    });
  });

  describe("projectKind normalization", () => {
    it("normalizes unknown projectKind to user semantics on load", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [["/repo", { workspaces: [], projectKind: "experimental" }]],
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.projects.get("/repo")?.projectKind).toBeUndefined();
    });

    it("preserves valid projectKind 'system' on load", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [["/repo", { workspaces: [], projectKind: "system" }]],
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.projects.get("/repo")?.projectKind).toBe("system");
    });
  });

  describe("legacy Chat with Mux cleanup", () => {
    const shippedProjectPath = "/home/user/.mux/system/Mux";
    const xumProjectPath = "/home/user/.xum/system/Xum";

    function shippedMuxChatWorkspace(projectPath: string) {
      return {
        path: projectPath,
        id: "mux-chat",
        name: "chat-with-mux",
        title: "Chat with Mux",
        agentId: "mux",
      };
    }

    function xumGenerationChatWorkspace(projectPath: string) {
      return {
        path: projectPath,
        id: "mux-chat",
        name: "chat-with-xum",
        title: "Chat with Xum",
        agentId: "xum",
      };
    }

    it("removes the shipped system Mux project and persists the cleanup", async () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [
            [
              shippedProjectPath,
              {
                workspaces: [shippedMuxChatWorkspace(shippedProjectPath)],
                projectKind: "system",
              },
            ],
            ["/repo", { workspaces: [] }],
          ],
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.projects.has(shippedProjectPath)).toBe(false);
      expect(loaded.projects.has("/repo")).toBe(true);

      await flushConfigEdits();
      const persisted = fs.readFileSync(configFile, "utf-8");
      expect(persisted).not.toContain("mux-chat");
    });

    it("removes later xum-branded leftovers as well", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [
            [
              xumProjectPath,
              {
                workspaces: [xumGenerationChatWorkspace(xumProjectPath)],
                projectKind: "system",
              },
            ],
          ],
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.projects.has(xumProjectPath)).toBe(false);
    });

    it("removes stale entries left under other mux roots", () => {
      const staleProjectPath = "/home/user/.mux-dev/system/Mux";
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [
            [
              shippedProjectPath,
              { workspaces: [shippedMuxChatWorkspace(shippedProjectPath)], projectKind: "system" },
            ],
            [
              staleProjectPath,
              { workspaces: [shippedMuxChatWorkspace(staleProjectPath)], projectKind: "system" },
            ],
          ],
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.projects.size).toBe(0);
    });

    it("keeps unrelated workspaces whose id collides with mux-chat", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [
            [
              "/home/user/mux",
              {
                workspaces: [{ path: "/home/user/mux-chat", id: "mux-chat", name: "chat" }],
              },
            ],
          ],
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.projects.get("/home/user/mux")?.workspaces).toHaveLength(1);
    });

    it("removes entries already merged into an ancestor project via subProjectPath", () => {
      // An earlier load's subproject merge relocated mux-chat into the
      // registered ~/.mux parent and left the system/Mux child empty.
      const parentProjectPath = "/home/user/.mux";
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [
            [
              parentProjectPath,
              {
                workspaces: [
                  {
                    ...shippedMuxChatWorkspace(shippedProjectPath),
                    subProjectPath: shippedProjectPath,
                  },
                  { path: "/home/user/.mux/other", id: "other-ws", name: "other" },
                ],
              },
            ],
            [shippedProjectPath, { workspaces: [], projectKind: "system" }],
          ],
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.projects.get(parentProjectPath)?.workspaces.map((w) => w.id)).toEqual([
        "other-ws",
      ]);
      expect(loaded.projects.has(shippedProjectPath)).toBe(false);
    });

    it("survives a corrupted non-string subProjectPath on a mux-chat record", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [
            [
              "/home/user/repo",
              {
                workspaces: [
                  { path: "/home/user/repo/ws", id: "mux-chat", name: "chat", subProjectPath: 42 },
                ],
              },
            ],
          ],
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.projects.get("/home/user/repo")?.workspaces).toHaveLength(1);
    });

    it("keeps other workspaces in a system Mux project and retains the project", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [
            [
              shippedProjectPath,
              {
                workspaces: [
                  shippedMuxChatWorkspace(shippedProjectPath),
                  { path: "/home/user/other", id: "other-ws", name: "other" },
                ],
                projectKind: "system",
              },
            ],
          ],
        })
      );

      const loaded = config.loadConfigOrDefault();
      const workspaces = loaded.projects.get(shippedProjectPath)?.workspaces;
      expect(workspaces?.map((w) => w.id)).toEqual(["other-ws"]);
    });

    it("keeps a Mux-named project that is not the hidden system leftover", () => {
      const userMuxProjectPath = "/home/user/code/Mux";
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [
            [
              userMuxProjectPath,
              {
                workspaces: [
                  {
                    path: userMuxProjectPath,
                    id: "mux-chat",
                    name: "chat-with-mux",
                    title: "Chat with Mux",
                    agentId: "mux",
                  },
                ],
              },
            ],
          ],
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.projects.get(userMuxProjectPath)?.workspaces).toHaveLength(1);
    });
  });

  describe("modelFallbacks normalization", () => {
    it("self-heals malformed modelFallbacks on load instead of breaking sends", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [],
          // Keep this test focused on normalization, not default seeding.
          migrations: {
            defaultModelFallbacksSeeded: true,
            defaultModelFallbacksSeededFable51: true,
          },
          modelFallbacks: {
            // Gateway-prefixed key + non-string chain entries + unknown trigger.
            "openrouter:anthropic/claude-opus-4-6": {
              models: [42, null, "openai:gpt-5.5", { nested: true }],
              triggers: ["future_trigger", 7],
            },
            // models is not an array: entry dropped entirely.
            "openai:gpt-5.5": { models: "openai:gpt-5.5-codex" },
            // Chain empties after dropping the self-fallback: entry dropped.
            "google:gemini-3-pro": { models: ["google:gemini-3-pro"] },
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.modelFallbacks).toEqual({
        "anthropic:claude-opus-4-6": {
          models: ["openai:gpt-5.5"],
          // Unknown triggers are dropped rather than coerced into refusal
          // triggers. The surviving empty list intentionally disables the
          // chain (it no longer fires on model_refusal).
          triggers: [],
        },
      });
    });
  });

  describe("default model fallbacks seeding", () => {
    const FABLE = KNOWN_MODELS.FABLE.id;
    const LEGACY_FABLE = "anthropic:claude-fable-5";
    const OPUS = KNOWN_MODELS.OPUS.id;
    const configFilePath = () => path.join(tempDir, "config.json");

    it("seeds the default chain once on first load and persists the migration flag", async () => {
      fs.writeFileSync(configFilePath(), JSON.stringify({ projects: [] }));

      const loaded = config.loadConfigOrDefault();
      // The original seed pass also carries the legacy Fable 5 chain so a
      // downgraded build (whose FABLE is Fable 5) still finds its default.
      expect(loaded.modelFallbacks).toEqual({
        [LEGACY_FABLE]: { models: [OPUS] },
        [FABLE]: { models: [OPUS] },
      });
      expect(loaded.migrations?.defaultModelFallbacksSeeded).toBe(true);

      // Seed is written back so the flag survives restarts even without saves.
      await flushConfigEdits();
      const raw = JSON.parse(fs.readFileSync(configFilePath(), "utf-8")) as {
        modelFallbacks?: unknown;
        migrations?: { defaultModelFallbacksSeeded?: unknown };
      };
      expect(raw.modelFallbacks).toEqual({
        [LEGACY_FABLE]: { models: [OPUS] },
        [FABLE]: { models: [OPUS] },
      });
      expect(raw.migrations?.defaultModelFallbacksSeeded).toBe(true);
    });

    it("does not re-seed after the user deletes the default chain", () => {
      fs.writeFileSync(
        configFilePath(),
        JSON.stringify({
          projects: [],
          migrations: {
            defaultModelFallbacksSeeded: true,
            defaultModelFallbacksSeededFable51: true,
          },
        })
      );

      expect(config.loadConfigOrDefault().modelFallbacks).toBeUndefined();
    });

    it("seeds the Fable 5.1 chain once for configs seeded before the 5.1 promotion", async () => {
      // Pre-5.1 configs carry a chain only for the old source key
      // (anthropic:claude-fable-5); the promoted FABLE key must get its own
      // one-time seed without touching the legacy chain (the legacy default
      // is only added while the original seed pass itself runs).
      fs.writeFileSync(
        configFilePath(),
        JSON.stringify({
          projects: [],
          migrations: { defaultModelFallbacksSeeded: true },
          modelFallbacks: {
            "anthropic:claude-fable-5": { models: ["anthropic:claude-opus-4-8"] },
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.modelFallbacks).toEqual({
        "anthropic:claude-fable-5": { models: ["anthropic:claude-opus-4-8"] },
        [FABLE]: { models: [OPUS] },
      });
      expect(loaded.migrations?.defaultModelFallbacksSeededFable51).toBe(true);

      await flushConfigEdits();
      const raw = JSON.parse(fs.readFileSync(configFilePath(), "utf-8")) as {
        modelFallbacks?: unknown;
        migrations?: { defaultModelFallbacksSeededFable51?: unknown };
      };
      expect(raw.modelFallbacks).toEqual({
        "anthropic:claude-fable-5": { models: ["anthropic:claude-opus-4-8"] },
        [FABLE]: { models: [OPUS] },
      });
      expect(raw.migrations?.defaultModelFallbacksSeededFable51).toBe(true);
    });

    it("does not overwrite an existing Fable 5.1 chain during the 5.1 re-seed", () => {
      fs.writeFileSync(
        configFilePath(),
        JSON.stringify({
          projects: [],
          migrations: { defaultModelFallbacksSeeded: true },
          modelFallbacks: {
            [FABLE]: { models: ["openai:gpt-5.5"] },
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.modelFallbacks).toEqual({
        [FABLE]: { models: ["openai:gpt-5.5"] },
      });
      expect(loaded.migrations?.defaultModelFallbacksSeededFable51).toBe(true);
    });

    it("merges the seeded default with pre-existing chains for other source models", async () => {
      fs.writeFileSync(
        configFilePath(),
        JSON.stringify({
          projects: [],
          modelFallbacks: {
            "anthropic:claude-opus-4-6": { models: ["openai:gpt-5.5"] },
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.modelFallbacks).toEqual({
        "anthropic:claude-opus-4-6": { models: ["openai:gpt-5.5"] },
        [LEGACY_FABLE]: { models: [OPUS] },
        [FABLE]: { models: [OPUS] },
      });

      // The user's chain must survive the seed write-back on disk unchanged.
      await flushConfigEdits();
      const raw = JSON.parse(fs.readFileSync(configFilePath(), "utf-8")) as {
        modelFallbacks?: unknown;
        migrations?: { defaultModelFallbacksSeeded?: unknown };
      };
      expect(raw.modelFallbacks).toEqual({
        "anthropic:claude-opus-4-6": { models: ["openai:gpt-5.5"] },
        [LEGACY_FABLE]: { models: [OPUS] },
        [FABLE]: { models: [OPUS] },
      });
      expect(raw.migrations?.defaultModelFallbacksSeeded).toBe(true);
    });

    it("does not double-seed when the user chain uses a gateway-prefixed Fable key", () => {
      fs.writeFileSync(
        configFilePath(),
        JSON.stringify({
          projects: [],
          modelFallbacks: {
            "openrouter:anthropic/claude-fable-5-1": { models: ["openai:gpt-5.5"] },
          },
        })
      );

      // The gateway-prefixed key canonicalizes to the same source model, so
      // the seed must treat it as configured and leave the user's chain alone.
      expect(config.loadConfigOrDefault().modelFallbacks).toEqual({
        [FABLE]: { models: ["openai:gpt-5.5"] },
        [LEGACY_FABLE]: { models: [OPUS] },
      });
    });

    it("respects a hand-edited tombstone whose chain sanitizes away", () => {
      fs.writeFileSync(
        configFilePath(),
        JSON.stringify({
          projects: [],
          modelFallbacks: {
            [FABLE]: { enabled: false, models: [] },
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      // The entry sanitizes to nothing at runtime (no fallback fires), but it
      // is still user intent: the seed must not replace it with an enabled
      // default chain, and the raw on-disk form must survive. Only the
      // untouched legacy key gets seeded.
      expect(loaded.modelFallbacks).toEqual({
        [LEGACY_FABLE]: { models: [OPUS] },
      });
      expect(loaded.migrations?.defaultModelFallbacksSeeded).toBe(true);

      // Raw file read before the async write-back flushes: the tombstone's
      // on-disk form must survive untouched.
      const raw = JSON.parse(fs.readFileSync(configFilePath(), "utf-8")) as {
        modelFallbacks?: unknown;
      };
      expect(raw.modelFallbacks).toEqual({ [FABLE]: { enabled: false, models: [] } });
    });

    it("preserves unknown migration flags from newer app versions across saves", async () => {
      fs.writeFileSync(
        configFilePath(),
        JSON.stringify({
          projects: [],
          migrations: { defaultModelFallbacksSeeded: true, futureFlag: true },
        })
      );

      await config.editConfig((cfg) => cfg);

      // A downgrade to this version + save must not strip flags it does not
      // know, or the corresponding one-time migrations re-run on re-upgrade.
      const raw = JSON.parse(fs.readFileSync(configFilePath(), "utf-8")) as {
        migrations?: Record<string, unknown>;
      };
      expect(raw.migrations?.futureFlag).toBe(true);
      expect(raw.migrations?.defaultModelFallbacksSeeded).toBe(true);
    });

    it("preserves a pre-existing user chain for the seeded source model", () => {
      fs.writeFileSync(
        configFilePath(),
        JSON.stringify({
          projects: [],
          modelFallbacks: {
            [FABLE]: { enabled: false, models: ["openai:gpt-5.5"] },
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.modelFallbacks).toEqual({
        [FABLE]: { enabled: false, models: ["openai:gpt-5.5"] },
        [LEGACY_FABLE]: { models: [OPUS] },
      });
      expect(loaded.migrations?.defaultModelFallbacksSeeded).toBe(true);
    });

    it("applies the defaults to fresh installs and locks the flag on first save", async () => {
      expect(config.loadConfigOrDefault().modelFallbacks).toEqual({
        [LEGACY_FABLE]: { models: [OPUS] },
        [FABLE]: { models: [OPUS] },
      });

      await config.editConfig((cfg) => cfg);

      const raw = JSON.parse(fs.readFileSync(configFilePath(), "utf-8")) as {
        modelFallbacks?: unknown;
        migrations?: { defaultModelFallbacksSeeded?: unknown };
      };
      expect(raw.modelFallbacks).toEqual({
        [LEGACY_FABLE]: { models: [OPUS] },
        [FABLE]: { models: [OPUS] },
      });
      expect(raw.migrations?.defaultModelFallbacksSeeded).toBe(true);
    });
  });

  describe("agent AI defaults canonical shape", () => {
    it("round-trips explicit Exec overrides even when they equal global defaults", async () => {
      const profile = {
        modelString: "openai:gpt-5.6-sol",
        thinkingLevel: "high" as const,
        reasoningMode: "standard" as const,
      };
      await config.updateAgentAiDefaults({ exec: { ...profile, subagent: profile } });
      expect(new Config(tempDir).loadConfigOrDefault().agentAiDefaults?.exec?.subagent).toEqual(
        profile
      );
      await config.editConfig((cfg) => cfg);
      expect(new Config(tempDir).loadConfigOrDefault().agentAiDefaults?.exec?.subagent).toEqual(
        profile
      );
    });

    it("preserves explicit gateway-scoped model strings in nested AI defaults", async () => {
      await config.editConfig((cfg) => {
        cfg.agentAiDefaults = {
          exec: { modelString: " openrouter:openai/gpt-5 ", thinkingLevel: "high" },
          worker: {
            modelString: " mux-gateway:anthropic/claude-haiku-4-5 ",
            thinkingLevel: "low",
          },
        };
        return cfg;
      });

      const raw = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")) as {
        agentAiDefaults?: Record<string, { modelString?: string; thinkingLevel?: string }>;
        subagentAiDefaults?: Record<string, { modelString?: string; thinkingLevel?: string }>;
      };

      expect(raw.agentAiDefaults).toEqual({
        exec: { modelString: "openrouter:openai/gpt-5", thinkingLevel: "high" },
        worker: {
          modelString: "mux-gateway:anthropic/claude-haiku-4-5",
          thinkingLevel: "low",
        },
      });
      // Downgrade projection mirrors the effective delegated profile for
      // non-built-in agents so old builds keep resolving delegated runs.
      expect(raw.subagentAiDefaults).toEqual({
        worker: {
          modelString: "mux-gateway:anthropic/claude-haiku-4-5",
          thinkingLevel: "low",
        },
      });

      const loaded = config.loadConfigOrDefault();
      expect(loaded.agentAiDefaults?.exec?.modelString).toBe("openrouter:openai/gpt-5");
      expect(loaded.agentAiDefaults?.worker?.modelString).toBe(
        "mux-gateway:anthropic/claude-haiku-4-5"
      );
      // The mirrored projection folds back into nothing: equal delegated
      // fields are pruned rather than frozen as overrides.
      expect(loaded.agentAiDefaults?.worker?.subagent).toBeUndefined();
    });

    it("folds mirrored legacy subagent entries away on load", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          agentAiDefaults: {
            exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
          },
          subagentAiDefaults: {
            exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
            worker: { modelString: "openai:gpt-5.2" },
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.agentAiDefaults?.exec?.subagent).toBeUndefined();
      // Legacy-only delegated data stays a delegated override; it is not
      // promoted to the interactive profile.
      expect(loaded.agentAiDefaults?.worker?.modelString).toBeUndefined();
      expect(loaded.agentAiDefaults?.worker?.subagent).toEqual({
        modelString: "openai:gpt-5.2",
      });
    });

    it("preserves session usage cache when loading a legacy dual-map config", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          agentAiDefaults: {
            exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
          },
          subagentAiDefaults: {
            exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
            worker: { modelString: "openai:gpt-5.2" },
          },
        })
      );

      const usagePath = path.join(
        path.join(config.sessionsDir, "workspace-1"),
        "session-usage.json"
      );
      fs.mkdirSync(path.dirname(usagePath), { recursive: true });
      fs.writeFileSync(usagePath, JSON.stringify({ totalCost: 1.23 }));

      const loaded = config.loadConfigOrDefault();
      expect(loaded.agentAiDefaults?.exec?.subagent).toBeUndefined();
      expect(fs.existsSync(usagePath)).toBe(true);
    });

    it("preserves differing legacy exec subagent defaults under the nested profile", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          agentAiDefaults: {
            exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
          },
          subagentAiDefaults: {
            exec: { modelString: "anthropic:claude-haiku-4-5", thinkingLevel: "off" },
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.agentAiDefaults?.exec?.subagent).toEqual({
        modelString: "anthropic:claude-haiku-4-5",
        thinkingLevel: "off",
      });
    });

    it("keeps only differing fields from a partially mirrored legacy exec entry", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          agentAiDefaults: {
            exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
          },
          subagentAiDefaults: {
            exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "off" },
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.agentAiDefaults?.exec?.subagent).toEqual({
        thinkingLevel: "off",
      });
    });

    it("keeps a differing legacy exec subagent reasoning mode", () => {
      // UI Exec pro + sub-agent standard share a model: the fold may drop the
      // mirrored model but must keep the explicit standard override (deleting
      // it would silently flip the sub-agent to pro after restart).
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          agentAiDefaults: {
            exec: { modelString: "openai:gpt-5.3-codex", reasoningMode: "pro" },
          },
          subagentAiDefaults: {
            exec: { modelString: "openai:gpt-5.3-codex", reasoningMode: "standard" },
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.agentAiDefaults?.exec?.subagent).toEqual({
        reasoningMode: "standard",
      });
    });

    it("prunes a mirrored legacy exec subagent reasoning mode", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          agentAiDefaults: {
            exec: { modelString: "openai:gpt-5.3-codex", reasoningMode: "pro" },
          },
          subagentAiDefaults: {
            exec: { modelString: "openai:gpt-5.3-codex", reasoningMode: "pro" },
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.agentAiDefaults?.exec?.subagent).toBeUndefined();
    });

    it("prefers nested subagent fields over the legacy projection on load", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          agentAiDefaults: {
            exec: {
              modelString: "openai:gpt-5.3-codex",
              subagent: { thinkingLevel: "high" },
            },
          },
          subagentAiDefaults: {
            exec: { modelString: "anthropic:claude-haiku-4-5", thinkingLevel: "off" },
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.agentAiDefaults?.exec?.subagent).toEqual({
        // Canonical nested value wins; the legacy map only fills fields the
        // nested profile leaves unset.
        thinkingLevel: "high",
        modelString: "anthropic:claude-haiku-4-5",
      });
    });

    it("does not synthesize UI exec defaults from legacy subagent-only exec defaults", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          subagentAiDefaults: {
            exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.agentAiDefaults?.exec?.modelString).toBeUndefined();
      expect(loaded.agentAiDefaults?.exec?.subagent).toEqual({
        modelString: "openai:gpt-5.3-codex",
        thinkingLevel: "xhigh",
      });
    });

    it("writes a downgrade-compatible legacy projection on save", async () => {
      await config.editConfig((cfg) => {
        cfg.agentAiDefaults = {
          exec: {
            modelString: "openai:gpt-5.2",
            thinkingLevel: "medium",
            subagent: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
          },
          plan: { modelString: "anthropic:claude-opus-4-6" },
          worker: {
            modelString: "anthropic:claude-haiku-4-5",
            subagent: { thinkingLevel: "off" },
          },
        };
        return cfg;
      });

      const raw = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")) as {
        subagentAiDefaults?: Record<string, unknown>;
        migrations?: { execSubagentDefaultsSplit?: boolean };
      };
      expect(raw.subagentAiDefaults).toEqual({
        // Exec projects only sparse overrides (old builds treat the exec key
        // as canonical delegated storage).
        exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
        // Other agents project the effective delegated profile; plan/compact
        // stay excluded for parity with old builds.
        worker: { modelString: "anthropic:claude-haiku-4-5", thinkingLevel: "off" },
      });
      expect(raw.migrations?.execSubagentDefaultsSplit).toBe(true);
    });

    it("round-trips distinct interactive and delegated exec profiles through downgrade save", async () => {
      await config.editConfig((cfg) => {
        cfg.agentAiDefaults = {
          exec: {
            modelString: "openai:gpt-5.2",
            thinkingLevel: "medium",
            reasoningMode: "pro",
            subagent: {
              modelString: "openai:gpt-5.3-codex",
              thinkingLevel: "xhigh",
              reasoningMode: "standard",
            },
          },
        };
        return cfg;
      });

      // Simulate a downgrade save: old builds strip the nested subagent
      // profile from agentAiDefaults but keep the legacy root map.
      const raw = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")) as {
        agentAiDefaults?: Record<string, Record<string, unknown>>;
        subagentAiDefaults?: Record<string, unknown>;
      };
      const execEntry = raw.agentAiDefaults?.exec ?? {};
      delete execEntry.subagent;
      fs.writeFileSync(path.join(tempDir, "config.json"), JSON.stringify(raw));

      const reloaded = new Config(tempDir).loadConfigOrDefault();
      expect(reloaded.agentAiDefaults?.exec).toEqual({
        modelString: "openai:gpt-5.2",
        thinkingLevel: "medium",
        reasoningMode: "pro",
        enabled: undefined,
        advisorEnabled: undefined,
        subagent: {
          modelString: "openai:gpt-5.3-codex",
          thinkingLevel: "xhigh",
          reasoningMode: "standard",
        },
      });
    });

    it("clearing the delegated exec profile removes the legacy exec projection on save", async () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({
          projects: [],
          agentAiDefaults: {
            exec: {
              modelString: "openai:gpt-5.2",
              thinkingLevel: "medium",
              subagent: { modelString: "openai:gpt-5.3-codex" },
            },
          },
        })
      );

      await config.editConfig((cfg) => {
        const exec = cfg.agentAiDefaults?.exec;
        if (exec) {
          delete exec.subagent;
        }
        return cfg;
      });

      const raw = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")) as {
        subagentAiDefaults?: Record<string, unknown>;
      };
      expect(raw.subagentAiDefaults).toBeUndefined();
    });
  });
  describe("route priority and overrides persistence", () => {
    it("round-trips routePriority through disk", async () => {
      const expectedPriority = ["openai:gpt-4o", "anthropic:claude-3-5-sonnet"];

      await config.editConfig((cfg) => {
        cfg.routePriority = expectedPriority;
        return cfg;
      });

      const restartedConfig = new Config(tempDir);
      const loaded = restartedConfig.loadConfigOrDefault();
      expect(loaded.routePriority).toEqual(expectedPriority);
    });

    it("round-trips routeOverrides through disk", async () => {
      const expectedOverrides = {
        "openai:gpt-4o": "direct",
        "anthropic:claude-3-5-sonnet": "auto",
      };

      await config.editConfig((cfg) => {
        cfg.routeOverrides = expectedOverrides;
        return cfg;
      });

      const restartedConfig = new Config(tempDir);
      const loaded = restartedConfig.loadConfigOrDefault();
      expect(loaded.routeOverrides).toEqual(expectedOverrides);
    });

    it("normalizes gateway-scoped override keys on save", async () => {
      await config.editConfig((cfg) => {
        cfg.routeOverrides = {
          "openrouter:anthropic/claude-opus-4-6": "direct",
        };
        return cfg;
      });

      const raw = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")) as {
        routeOverrides?: Record<string, string>;
      };

      expect(raw.routeOverrides).toEqual({
        "anthropic:claude-opus-4-6": "direct",
      });
    });

    it("normalizes gateway-scoped override keys on load", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [],
          routeOverrides: {
            "openrouter:anthropic/claude-opus-4-6": "direct",
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.routeOverrides).toEqual({
        "anthropic:claude-opus-4-6": "direct",
      });
    });

    it("handles key collisions after normalization", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [],
          routeOverrides: {
            "openrouter:anthropic/claude-opus-4-6": "direct",
            "mux-gateway:anthropic/claude-opus-4-6": "openrouter",
          },
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.routeOverrides).toEqual({
        "anthropic:claude-opus-4-6": "openrouter",
      });
    });

    it("keeps routePriority and routeOverrides across unrelated editConfig saves", async () => {
      const expectedPriority = ["openai:gpt-4o"];
      const expectedOverrides = {
        "openai:gpt-4o": "direct",
      };

      await config.editConfig((cfg) => {
        cfg.routePriority = expectedPriority;
        cfg.routeOverrides = expectedOverrides;
        return cfg;
      });

      await config.editConfig((cfg) => {
        cfg.apiServerPort = 4000;
        return cfg;
      });

      const restartedConfig = new Config(tempDir);
      const loaded = restartedConfig.loadConfigOrDefault();

      expect(loaded.routePriority).toEqual(expectedPriority);
      expect(loaded.routeOverrides).toEqual(expectedOverrides);
      expect(loaded.apiServerPort).toBe(4000);
    });
  });

  describe("legacy gateway migration preserves downgrade compatibility", () => {
    const writeRawConfig = (value: Record<string, unknown>) => {
      fs.writeFileSync(path.join(tempDir, "config.json"), JSON.stringify(value));
    };

    const writeProvidersConfig = (value: Record<string, unknown>) => {
      fs.writeFileSync(path.join(tempDir, "providers.jsonc"), JSON.stringify(value, null, 2));
    };

    const readRawConfig = () =>
      JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")) as {
        muxGatewayEnabled?: boolean;
        muxGatewayModels?: string[];
        routePriority?: string[];
        routeOverrides?: Record<string, string>;
      };

    for (const { name, rawConfig, expectedOverrides } of [
      {
        name: "translates a single legacy allowlisted model into a mux-gateway routeOverride",
        rawConfig: {
          muxGatewayEnabled: true,
          muxGatewayModels: ["anthropic/claude-sonnet-4-6"],
        },
        expectedOverrides: { "anthropic:claude-sonnet-4-6": "mux-gateway" },
      },
      {
        name: "translates multiple legacy models and merges them with existing routeOverrides",
        rawConfig: {
          muxGatewayEnabled: true,
          muxGatewayModels: ["anthropic:claude-sonnet-4-6", "openrouter:anthropic/claude-opus-4-6"],
          routeOverrides: { "openai:gpt-4o": "direct" },
        },
        expectedOverrides: {
          "openai:gpt-4o": "direct",
          "anthropic:claude-sonnet-4-6": "mux-gateway",
          "anthropic:claude-opus-4-6": "mux-gateway",
        },
      },
      {
        name: "keeps existing routeOverrides when a legacy model normalizes to the same canonical key",
        rawConfig: {
          muxGatewayEnabled: true,
          muxGatewayModels: ["openrouter:anthropic/claude-opus-4-6"],
          routeOverrides: { "anthropic:claude-opus-4-6": "openrouter" },
        },
        expectedOverrides: { "anthropic:claude-opus-4-6": "openrouter" },
      },
      {
        name: "synthesizes direct-only priority when the legacy allowlist is empty",
        rawConfig: { muxGatewayEnabled: true, muxGatewayModels: [] },
        expectedOverrides: undefined,
      },
      {
        name: "synthesizes direct-only priority when the legacy gateway flag is disabled",
        rawConfig: {
          muxGatewayEnabled: false,
          muxGatewayModels: ["anthropic/claude-sonnet-4-6"],
        },
        expectedOverrides: undefined,
      },
    ] as const) {
      it(name, () => {
        writeRawConfig(rawConfig);

        const loaded = config.loadConfigOrDefault();

        expect(loaded.routePriority).toEqual(["direct"]);
        if (expectedOverrides === undefined) {
          expect(loaded.routeOverrides).toBeUndefined();
        } else {
          expect(loaded.routeOverrides).toEqual(expectedOverrides);
        }
      });
    }

    it("preserves legacy fields on disk alongside synthesized modern routing state", async () => {
      writeRawConfig({
        muxGatewayEnabled: true,
        muxGatewayModels: ["anthropic/claude-sonnet-4-6"],
      });
      writeProvidersConfig({
        "mux-gateway": { couponCode: "test-coupon" },
      });

      const loaded = config.loadConfigOrDefault();
      expect(loaded.routePriority).toEqual(["mux-gateway", "direct"]);
      expect(loaded.routeOverrides).toEqual({
        "anthropic:claude-sonnet-4-6": "mux-gateway",
      });

      await flushConfigEdits();
      expect(readRawConfig()).toMatchObject({
        muxGatewayEnabled: true,
        muxGatewayModels: ["anthropic/claude-sonnet-4-6"],
        routePriority: ["mux-gateway", "direct"],
        routeOverrides: {
          "anthropic:claude-sonnet-4-6": "mux-gateway",
        },
      });
    });

    it("seeds routePriority from other configured gateways for legacy configs", () => {
      writeRawConfig({
        muxGatewayEnabled: true,
        muxGatewayModels: ["anthropic/claude-sonnet-4-6"],
      });
      writeProvidersConfig({
        openrouter: { apiKey: "test-openrouter-key" },
      });

      const loaded = config.loadConfigOrDefault();

      expect(loaded.routePriority).toEqual(["openrouter", "direct"]);
      expect(loaded.routeOverrides).toEqual({
        "anthropic:claude-sonnet-4-6": "mux-gateway",
      });
    });

    it("excludes mux-gateway from seeded priority when legacy muxGatewayEnabled is false", () => {
      writeRawConfig({
        muxGatewayEnabled: false,
        muxGatewayModels: ["anthropic/claude-sonnet-4-6"],
      });
      writeProvidersConfig({
        "mux-gateway": { couponCode: "test-coupon" },
        openrouter: { apiKey: "test-openrouter-key" },
      });

      const loaded = config.loadConfigOrDefault();

      expect(loaded.routePriority).toEqual(["openrouter", "direct"]);
      expect(loaded.routeOverrides).toBeUndefined();
    });

    it("clears stale muxGatewayEnabled disables when routePriority already includes mux-gateway", async () => {
      writeRawConfig({
        muxGatewayEnabled: false,
        routePriority: ["mux-gateway", "direct"],
      });

      const loaded = config.loadConfigOrDefault();

      expect(loaded.routePriority).toEqual(["mux-gateway", "direct"]);
      expect(loaded.muxGatewayEnabled).toBeUndefined();
      await flushConfigEdits();
      expect(readRawConfig().muxGatewayEnabled).toBeUndefined();
      expect(new Config(tempDir).loadConfigOrDefault().muxGatewayEnabled).toBeUndefined();
    });

    it("does not rewrite configs that already include routePriority", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          muxGatewayEnabled: true,
          muxGatewayModels: ["anthropic/claude-sonnet-4-6"],
          routePriority: ["openrouter", "direct"],
          routeOverrides: {
            "openai:gpt-4o": "direct",
          },
          // Without these flags the one-time default-fallbacks seeds would
          // write the file, which is not the rewrite this test guards against.
          migrations: {
            defaultModelFallbacksSeeded: true,
            defaultModelFallbacksSeededFable51: true,
          },
        })
      );

      const preservedTime = new Date("2000-01-01T00:00:00.000Z");
      fs.utimesSync(configFile, preservedTime, preservedTime);
      const beforeMtimeMs = fs.statSync(configFile).mtimeMs;

      const loaded = config.loadConfigOrDefault();
      expect(loaded.routePriority).toEqual(["openrouter", "direct"]);
      expect(loaded.routeOverrides).toEqual({
        "openai:gpt-4o": "direct",
      });

      const afterMtimeMs = fs.statSync(configFile).mtimeMs;
      expect(afterMtimeMs).toBe(beforeMtimeMs);
    });
  });

  describe("routePriority seeding from providers", () => {
    const gatewayEnvKeys = [
      "OPENROUTER_API_KEY",
      "GITHUB_COPILOT_TOKEN",
      "AWS_REGION",
      "AWS_DEFAULT_REGION",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_PROFILE",
    ] as const;
    let originalGatewayEnv: Partial<Record<(typeof gatewayEnvKeys)[number], string | undefined>>;

    const writeProvidersConfig = (providersConfig: Record<string, unknown>) => {
      fs.writeFileSync(
        path.join(tempDir, "providers.jsonc"),
        JSON.stringify(providersConfig, null, 2)
      );
    };

    beforeEach(() => {
      originalGatewayEnv = Object.fromEntries(
        gatewayEnvKeys.map((key) => [key, process.env[key]])
      ) as Partial<Record<(typeof gatewayEnvKeys)[number], string | undefined>>;

      for (const key of gatewayEnvKeys) {
        delete process.env[key];
      }
    });

    afterEach(() => {
      for (const key of gatewayEnvKeys) {
        const value = originalGatewayEnv[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });

    it("seeds routePriority on fresh installs when a gateway is configured", () => {
      writeProvidersConfig({
        // mux-gateway is configured by couponCode/voucher rather than apiKey.
        "mux-gateway": { couponCode: "test-coupon" },
      });

      const loaded = config.loadConfigOrDefault();
      const muxGatewayIndex = loaded.routePriority?.indexOf("mux-gateway") ?? -1;
      const directIndex = loaded.routePriority?.indexOf("direct") ?? -1;

      expect(muxGatewayIndex).toBeGreaterThanOrEqual(0);
      expect(directIndex).toBeGreaterThan(muxGatewayIndex);
    });

    it("does not seed routePriority when a configured gateway is disabled", () => {
      writeProvidersConfig({
        "mux-gateway": { couponCode: "test-coupon", enabled: false },
      });

      const loaded = config.loadConfigOrDefault();

      expect(loaded.routePriority).toBeUndefined();
    });

    it("leaves routePriority undefined on fresh installs without configured gateways", () => {
      const loaded = config.loadConfigOrDefault();

      expect(loaded.routePriority).toBeUndefined();
    });

    it("does not seed routePriority for bedrock when env only exposes a region", () => {
      process.env.AWS_REGION = "us-east-1";

      const loaded = config.loadConfigOrDefault();

      expect(loaded.routePriority).toBeUndefined();
    });

    it("preserves existing routePriority when a gateway is configured", () => {
      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({ routePriority: ["direct"] })
      );
      writeProvidersConfig({
        // mux-gateway is configured by couponCode/voucher rather than apiKey.
        "mux-gateway": { couponCode: "test-coupon" },
      });

      const loaded = config.loadConfigOrDefault();

      expect(loaded.routePriority).toEqual(["direct"]);
    });
  });

  describe("findWorkspace", () => {
    it("preserves the config key while exposing a real attribution path for multi-project workspaces", async () => {
      const primaryProjectPath = "/fake/project-a";
      const secondaryProjectPath = "/fake/project-b";
      const workspacePath = path.join(config.srcDir, "project-a+project-b", "feature-branch");

      await config.editConfig((cfg) => {
        cfg.projects.set(MULTI_PROJECT_CONFIG_KEY, {
          workspaces: [
            {
              path: workspacePath,
              id: "workspace-1",
              name: "feature-branch",
              projects: [
                { projectName: "project-a", projectPath: primaryProjectPath },
                { projectName: "project-b", projectPath: secondaryProjectPath },
              ],
            },
          ],
        });
        return cfg;
      });

      expect(config.findWorkspace("workspace-1")).toEqual({
        workspacePath,
        projectPath: MULTI_PROJECT_CONFIG_KEY,
        attributionProjectPath: primaryProjectPath,
        projects: [
          { projectName: "project-a", projectPath: primaryProjectPath },
          { projectName: "project-b", projectPath: secondaryProjectPath },
        ],
        workspaceName: "feature-branch",
        parentWorkspaceId: undefined,
        pendingAutoTitle: undefined,
      });
    });
  });

  describe("getAllWorkspaceMetadata with migration", () => {
    it("should migrate legacy workspace without metadata file", async () => {
      const projectPath = "/fake/project";
      const workspacePath = path.join(config.srcDir, "project", "feature-branch");

      // Create workspace directory
      fs.mkdirSync(workspacePath, { recursive: true });

      // Add workspace to config without metadata file
      await config.editConfig((cfg) => {
        cfg.projects.set(projectPath, {
          workspaces: [{ path: workspacePath }],
        });
        return cfg;
      });

      // Get all metadata (should trigger migration)
      const allMetadata = await config.getAllWorkspaceMetadata();

      expect(allMetadata).toHaveLength(1);
      const metadata = allMetadata[0];
      expect(metadata.id).toBe("project-feature-branch"); // Legacy ID format
      expect(metadata.name).toBe("feature-branch");
      expect(metadata.projectName).toBe("project");
      expect(metadata.projectPath).toBe(projectPath);

      // Verify metadata was migrated to config
      const configData = config.loadConfigOrDefault();
      const projectConfig = configData.projects.get(projectPath);
      expect(projectConfig).toBeDefined();
      expect(projectConfig!.workspaces).toHaveLength(1);
      const workspace = projectConfig!.workspaces[0];
      expect(workspace.id).toBe("project-feature-branch");
      expect(workspace.name).toBe("feature-branch");
    });

    it.each(["owner", undefined])(
      "preserves desktop ownership through metadata read/write (%s)",
      async (owner) => {
        const projectPath = path.join(tempDir, "project");
        await config.editConfig((cfg) => {
          cfg.projects.set(projectPath, {
            workspaces: [
              {
                id: "child",
                name: "child",
                path: projectPath,
                createdAt: "2025-01-01T00:00:00.000Z",
                runtimeConfig: { type: "local" },
                parentWorkspaceId: "owner",
                agentId: "desktop",
                taskDesktopOwnerWorkspaceId: owner,
              },
            ],
          });
          return cfg;
        });
        const reloaded = new Config(tempDir);
        const [metadata] = await reloaded.getAllWorkspaceMetadata();
        expect(metadata.taskDesktopOwnerWorkspaceId).toBe(owner);
        await reloaded.addWorkspace(projectPath, { ...metadata, title: "Renamed operator" });
        const [saved] = await new Config(tempDir).getAllWorkspaceMetadata();
        expect(saved.title).toBe("Renamed operator");
        expect(saved.taskDesktopOwnerWorkspaceId).toBe(owner);
      }
    );

    it("defaults sparse persisted heartbeat intervals in workspace metadata", async () => {
      const projectPath = "/fake/project";
      const workspacePath = path.join(config.srcDir, "project", "heartbeat-sparse");
      const sparseHeartbeat = { enabled: true } as const;

      await config.editConfig((cfg) => {
        cfg.heartbeatDefaultIntervalMs = 45 * 60 * 1000;
        cfg.projects.set(projectPath, {
          workspaces: [
            {
              path: workspacePath,
              id: "workspace-heartbeat-sparse",
              name: "heartbeat-sparse",
              createdAt: "2025-01-01T00:00:00.000Z",
              runtimeConfig: { type: "local" },
              // Simulates older/corrupt persisted config; workspace metadata must stay schema-valid.
              heartbeat: sparseHeartbeat as NonNullable<WorkspaceMetadata["heartbeat"]>,
            },
          ],
        });
        return cfg;
      });

      const [metadata] = await config.getAllWorkspaceMetadata();

      expect(metadata.heartbeat).toEqual({
        enabled: true,
        intervalMs: 45 * 60 * 1000,
      });
    });

    it("preserves valid heartbeat schedule fields and drops invalid ones in workspace metadata", async () => {
      const projectPath = "/fake/project";
      const workspacePath = path.join(config.srcDir, "project", "heartbeat-schedule");
      // trigger is valid and must survive normalization; whenBusy simulates a corrupt
      // persisted value and must be dropped (self-healing) rather than passed through.
      const persistedHeartbeat = {
        enabled: true,
        intervalMs: 30 * 60 * 1000,
        trigger: "interval",
        whenBusy: "not-a-mode",
      };

      await config.editConfig((cfg) => {
        cfg.projects.set(projectPath, {
          workspaces: [
            {
              path: workspacePath,
              id: "workspace-heartbeat-schedule",
              name: "heartbeat-schedule",
              createdAt: "2025-01-01T00:00:00.000Z",
              runtimeConfig: { type: "local" },
              heartbeat: persistedHeartbeat as NonNullable<WorkspaceMetadata["heartbeat"]>,
            },
          ],
        });
        return cfg;
      });

      const [metadata] = await config.getAllWorkspaceMetadata();

      expect(metadata.heartbeat).toEqual({
        enabled: true,
        intervalMs: 30 * 60 * 1000,
        trigger: "interval",
      });
    });

    it("should use existing metadata file if present (legacy format)", async () => {
      const projectPath = "/fake/project";
      const workspaceName = "my-feature";
      const workspacePath = path.join(config.srcDir, "project", workspaceName);

      // Create workspace directory
      fs.mkdirSync(workspacePath, { recursive: true });

      // Test backward compatibility: Create metadata file using legacy ID format.
      // This simulates workspaces created before stable IDs were introduced.
      const legacyId = config.generateLegacyId(projectPath, workspacePath);
      const sessionDir = path.join(config.sessionsDir, legacyId);
      fs.mkdirSync(sessionDir, { recursive: true });
      const metadataPath = path.join(sessionDir, "metadata.json");
      const existingMetadata = {
        id: legacyId,
        name: workspaceName,
        projectName: "project",
        projectPath: projectPath,
        createdAt: "2025-01-01T00:00:00.000Z",
      };
      fs.writeFileSync(metadataPath, JSON.stringify(existingMetadata));

      // Add workspace to config (without id/name, simulating legacy format)
      await config.editConfig((cfg) => {
        cfg.projects.set(projectPath, {
          workspaces: [{ path: workspacePath }],
        });
        return cfg;
      });

      // Get all metadata (should use existing metadata and migrate to config)
      const allMetadata = await config.getAllWorkspaceMetadata();

      expect(allMetadata).toHaveLength(1);
      const metadata = allMetadata[0];
      expect(metadata.id).toBe(legacyId);
      expect(metadata.name).toBe(workspaceName);
      expect(metadata.createdAt).toBe("2025-01-01T00:00:00.000Z");

      // Verify metadata was migrated to config
      const configData = config.loadConfigOrDefault();
      const projectConfig = configData.projects.get(projectPath);
      expect(projectConfig).toBeDefined();
      expect(projectConfig!.workspaces).toHaveLength(1);
      const workspace = projectConfig!.workspaces[0];
      expect(workspace.id).toBe(legacyId);
      expect(workspace.name).toBe(workspaceName);
      expect(workspace.createdAt).toBe("2025-01-01T00:00:00.000Z");
    });

    it("enumerates basename-backed legacy stable ids like findWorkspace", async () => {
      // Oldest layout: an id-less config entry whose stable id lives in
      // sessions/<workspace-basename>/metadata.json. findWorkspace resolves
      // it (basename candidate first), so the enumeration must report the
      // same identity — destructive callers (the extension-metadata prune)
      // classify ids as stale against the enumeration, and a mismatch would
      // delete the live workspace's activity data.
      const projectPath = "/fake/project";
      const workspaceName = "old-feature";
      const workspacePath = path.join(config.srcDir, "project", workspaceName);
      fs.mkdirSync(workspacePath, { recursive: true });

      const sessionDir = path.join(config.sessionsDir, workspaceName);
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, "metadata.json"),
        JSON.stringify({
          id: "stable-basename-id",
          name: workspaceName,
          projectName: "project",
          projectPath,
          createdAt: "2025-01-01T00:00:00.000Z",
        })
      );

      await config.editConfig((cfg) => {
        cfg.projects.set(projectPath, {
          workspaces: [{ path: workspacePath }],
        });
        return cfg;
      });

      const allMetadata = await config.getAllWorkspaceMetadata({ throwOnError: true });
      expect(allMetadata.map((metadata) => metadata.id)).toContain("stable-basename-id");
    });

    it("surfaces the second resolvable compatibility file's id as a legacy alias", async () => {
      // Both supported layouts exist with DIFFERENT ids (e.g. a stale
      // basename-side file next to the live generated-legacy metadata).
      // findWorkspace resolves either id, so destructive known-id sets must
      // retain both — the GENERATED-LEGACY record stays canonical (its id
      // feeds the read-time config migration; a stale basename-side primary
      // would rewrite the persisted stable id on upgrade and orphan session
      // history) while the basename id is reported through the
      // legacyAliasIds out-parameter.
      const projectPath = "/fake/project";
      const workspaceName = "aliased-feature";
      const workspacePath = path.join(config.srcDir, "project", workspaceName);
      fs.mkdirSync(workspacePath, { recursive: true });

      const basenameSessionDir = path.join(config.sessionsDir, workspaceName);
      fs.mkdirSync(basenameSessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(basenameSessionDir, "metadata.json"),
        JSON.stringify({ id: "stale-basename-id", name: workspaceName })
      );
      const legacyId = config.generateLegacyId(projectPath, workspacePath);
      const legacySessionDir = path.join(config.sessionsDir, legacyId);
      fs.mkdirSync(legacySessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(legacySessionDir, "metadata.json"),
        JSON.stringify({ id: "live-generated-id", name: workspaceName })
      );

      await config.editConfig((cfg) => {
        cfg.projects.set(projectPath, {
          workspaces: [{ path: workspacePath }],
        });
        return cfg;
      });

      const legacyAliasIds = new Set<string>();
      const allMetadata = await config.getAllWorkspaceMetadata({
        throwOnError: true,
        legacyAliasIds,
      });
      expect(allMetadata.map((metadata) => metadata.id)).toContain("live-generated-id");
      expect(legacyAliasIds.has("stale-basename-id")).toBe(true);
      // The read-time migration must persist the CANONICAL id — a stale
      // basename-side id here would change the workspace's stable identity
      // on upgrade and make its session history appear missing.
      const persisted = config
        .loadConfigOrDefault()
        .projects.get(projectPath)
        ?.workspaces.find((workspace) => workspace.path === workspacePath);
      expect(persisted?.id).toBe("live-generated-id");
    });
  });

  describe("transcriptOnly derivation", () => {
    it("leaves transcriptOnly unset for worktree workspaces with an existing checkout", async () => {
      const projectPath = "/fake/project";
      const workspacePath = path.join(config.srcDir, "project", "existing-worktree");
      fs.mkdirSync(workspacePath, { recursive: true });

      await config.editConfig((cfg) => {
        cfg.projects.set(projectPath, {
          workspaces: [
            {
              path: workspacePath,
              id: "workspace-existing",
              name: "existing-worktree",
              createdAt: "2025-01-01T00:00:00.000Z",
              runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
            },
          ],
        });
        return cfg;
      });

      const [metadata] = await config.getAllWorkspaceMetadata();

      expect(metadata.transcriptOnly).toBeUndefined();
    });

    it("returns transcriptOnly for missing worktree checkouts even after unarchiving", async () => {
      const projectPath = "/fake/project";
      const workspacePath = path.join(config.srcDir, "project", "missing-worktree");

      await config.editConfig((cfg) => {
        cfg.projects.set(projectPath, {
          workspaces: [
            {
              path: workspacePath,
              id: "workspace-missing-worktree",
              name: "missing-worktree",
              createdAt: "2025-01-01T00:00:00.000Z",
              archivedAt: "2025-01-02T00:00:00.000Z",
              unarchivedAt: "2025-01-03T00:00:00.000Z",
              runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
            },
          ],
        });
        return cfg;
      });

      const [metadata] = await config.getAllWorkspaceMetadata();

      expect(metadata.transcriptOnly).toBe(true);
    });

    it("leaves transcriptOnly unset for queued worktree tasks whose checkout is still missing", async () => {
      const projectPath = "/fake/project";
      const workspacePath = path.join(config.srcDir, "project", "queued-missing-worktree");

      await config.editConfig((cfg) => {
        cfg.projects.set(projectPath, {
          workspaces: [
            {
              path: workspacePath,
              id: "workspace-queued-missing-worktree",
              name: "queued-missing-worktree",
              createdAt: "2025-01-01T00:00:00.000Z",
              runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
              taskStatus: "queued",
            },
          ],
        });
        return cfg;
      });

      const [metadata] = await config.getAllWorkspaceMetadata();

      expect(metadata.transcriptOnly).toBeUndefined();
    });

    it("never returns transcriptOnly for non-worktree runtimes", async () => {
      const projectPath = "/fake/project";
      const workspacePath = path.join(tempDir, "missing-local-workspace");

      await config.editConfig((cfg) => {
        cfg.projects.set(projectPath, {
          workspaces: [
            {
              path: workspacePath,
              id: "workspace-missing-local",
              name: "missing-local-workspace",
              createdAt: "2025-01-01T00:00:00.000Z",
              runtimeConfig: { type: "local" },
            },
          ],
        });
        return cfg;
      });

      const [metadata] = await config.getAllWorkspaceMetadata();

      expect(metadata.transcriptOnly).toBeUndefined();
    });
  });
});
