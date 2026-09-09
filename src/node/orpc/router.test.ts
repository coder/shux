/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await, local/no-sync-fs-methods */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createRouterClient, ORPCError } from "@orpc/server";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";

import type { ORPCContext } from "./context";
import { inFlightProcedureCount } from "./inFlightProcedures";
import { router } from "./router";

describe("router agent skill routes", () => {
  test("subproject workspaces inherit parent skills with nearest precedence", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-router-skills-test-"));
    try {
      const checkoutRoot = path.join(tempDir, "checkout");
      const packagesRoot = path.join(checkoutRoot, "packages");
      const subProjectPath = path.join(packagesRoot, "app");
      const writeSkill = (root: string, name: string, description: string, body: string): void => {
        const skillDir = path.join(root, name);
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
          path.join(skillDir, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`
        );
      };

      fs.mkdirSync(subProjectPath, { recursive: true });
      writeSkill(
        path.join(checkoutRoot, ".mux", "skills"),
        "parent-only",
        "from checkout",
        "parent body"
      );
      writeSkill(
        path.join(checkoutRoot, ".mux", "skills"),
        "shared",
        "from checkout",
        "checkout body"
      );
      writeSkill(
        path.join(packagesRoot, ".agents", "skills"),
        "shared",
        "from packages",
        "packages body"
      );

      const outsideRoot = path.join(tempDir, "outside-skills");
      writeSkill(outsideRoot, "escaped", "outside checkout", "outside body");
      fs.symlinkSync(
        path.join(outsideRoot, "escaped"),
        path.join(checkoutRoot, ".mux", "skills", "escaped"),
        "dir"
      );

      const context = {
        config: new Config(tempDir),
        initStateManager: { waitForInit: mock(async () => undefined) },
        aiService: {
          resolveXumToolScopeForWorkspace: mock(() => ({
            type: "project",
            xumHome: tempDir,
            projectRoot: subProjectPath,
            projectStorageAuthority: "host-local",
            checkoutRoot,
          })),
          getWorkspaceMetadata: mock(async () => ({
            success: true,
            data: {
              id: "workspace-1",
              name: "workspace-1",
              projectPath: checkoutRoot,
              namedWorkspacePath: checkoutRoot,
              subProjectPath,
              runtimeConfig: { type: "local", srcBaseDir: tempDir },
            },
          })),
        },
        experimentsService: {
          isExperimentEnabled: mock(() => false),
        },
      } as unknown as ORPCContext;
      const client = createRouterClient(router(), { context });

      const skills = await client.agentSkills.list({ workspaceId: "workspace-1" });
      expect(skills.find((skill) => skill.name === "parent-only")).toMatchObject({
        description: "from checkout",
        scope: "project",
      });
      expect(skills.find((skill) => skill.name === "shared")).toMatchObject({
        description: "from packages",
        scope: "project",
      });

      expect(skills.find((skill) => skill.name === "escaped")).toBeUndefined();
      await expect(
        client.agentSkills.get({ workspaceId: "workspace-1", skillName: "escaped" })
      ).rejects.toThrow("Agent skill not found");

      await expect(
        client.agentSkills.get({ workspaceId: "workspace-1", skillName: "parent-only" })
      ).resolves.toMatchObject({ body: "parent body\n" });
      await expect(
        client.agentSkills.get({ workspaceId: "workspace-1", skillName: "shared" })
      ).resolves.toMatchObject({ body: "packages body\n" });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("devcontainer workspaces read inherited skills from host-local storage", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-router-devcontainer-skills-"));
    try {
      const checkoutRoot = path.join(tempDir, "checkout");
      const subProjectPath = path.join(checkoutRoot, "packages", "app");
      const skillDir = path.join(checkoutRoot, ".mux", "skills", "parent-only");
      fs.mkdirSync(subProjectPath, { recursive: true });
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        "---\nname: parent-only\ndescription: Parent skill\n---\nHost parent body\n"
      );

      const context = {
        config: new Config(tempDir),
        initStateManager: { waitForInit: mock(async () => undefined) },
        aiService: {
          resolveXumToolScopeForWorkspace: mock(() => ({
            type: "project",
            xumHome: tempDir,
            projectRoot: subProjectPath,
            projectStorageAuthority: "host-local",
            checkoutRoot,
          })),
          getWorkspaceMetadata: mock(async () => ({
            success: true,
            data: {
              id: "workspace-1",
              name: "workspace-1",
              projectPath: checkoutRoot,
              namedWorkspacePath: checkoutRoot,
              subProjectPath,
              runtimeConfig: {
                type: "devcontainer",
                configPath: ".devcontainer/devcontainer.json",
              },
            },
          })),
        },
        experimentsService: {
          isExperimentEnabled: mock(() => false),
        },
      } as unknown as ORPCContext;
      const client = createRouterClient(router(), { context });

      await expect(client.agentSkills.list({ workspaceId: "workspace-1" })).resolves.toContainEqual(
        expect.objectContaining({
          name: "parent-only",
          description: "Parent skill",
          scope: "project",
        })
      );
      await expect(
        client.agentSkills.get({ workspaceId: "workspace-1", skillName: "parent-only" })
      ).resolves.toMatchObject({ body: "Host parent body\n" });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("project-path discovery inherits skills from a registered parent", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-router-project-skills-test-"));
    try {
      const parentProjectPath = path.join(tempDir, "checkout");
      const subProjectPath = path.join(parentProjectPath, "packages", "app");
      const skillDir = path.join(parentProjectPath, ".mux", "skills", "parent-only");
      fs.mkdirSync(subProjectPath, { recursive: true });
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        "---\nname: parent-only\ndescription: Parent skill\n---\nParent body\n"
      );

      const config = new Config(tempDir);
      await config.editConfig((current) => {
        current.projects.set(parentProjectPath, { workspaces: [] });
        current.projects.set(subProjectPath, {
          workspaces: [],
          parentProjectPath,
        });
        return current;
      });
      const context = {
        config,
        experimentsService: {
          isExperimentEnabled: mock(() => false),
        },
      } as unknown as ORPCContext;
      const client = createRouterClient(router(), { context });

      await expect(
        client.agentSkills.list({ projectPath: subProjectPath })
      ).resolves.toContainEqual(
        expect.objectContaining({
          name: "parent-only",
          description: "Parent skill",
          scope: "project",
        })
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("router config transcript mutation", () => {
  let tempDir: string;
  let config: Config;
  let setConfigEnabledMock: ReturnType<typeof mock<(enabled: boolean) => Promise<void>>>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-router-test-"));
    config = new Config(tempDir);
    setConfigEnabledMock = mock((_enabled: boolean) => Promise.resolve());
  });

  afterEach(() => {
    // The write-failure test locks the dir; restore perms so cleanup succeeds.
    try {
      fs.chmodSync(tempDir, 0o700);
    } catch {
      // Already removed or never locked.
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createContext(): ORPCContext {
    // These config-route tests touch Config, TaskService, and (via getConfig /
    // updateTelemetryEnabled) TelemetryService; stub the rest of the container.
    return {
      config,
      taskService: {
        maybeStartQueuedTasks: () => Promise.resolve(undefined),
      },
      telemetryService: {
        isDisabledByEnv: () => false,
        setConfigEnabled: setConfigEnabledMock,
      },
    } as unknown as ORPCContext;
  }

  test("persists the full-width chat transcript config flag", async () => {
    const client = createRouterClient(router(), { context: createContext() });

    expect((await client.config.getConfig()).chatTranscriptFullWidth).toBe(false);
    await client.config.updateChatTranscriptFullWidth({ enabled: true });
    expect((await client.config.getConfig()).chatTranscriptFullWidth).toBe(true);
    expect(config.loadConfigOrDefault().chatTranscriptFullWidth).toBe(true);

    await client.config.updateChatTranscriptFullWidth({ enabled: false });
    expect((await client.config.getConfig()).chatTranscriptFullWidth).toBe(false);
    expect(config.loadConfigOrDefault().chatTranscriptFullWidth).toBeUndefined();
  });

  test("refuses procedure calls once the server has begun shutting down", async () => {
    let shuttingDown = false;
    const context = {
      config,
      serverService: { isShuttingDown: () => shuttingDown },
    } as unknown as ORPCContext;
    const client = createRouterClient(router(), { context });
    expect(await client.general.ping("alive")).toBe("Pong: alive");

    shuttingDown = true;
    let error: unknown;
    try {
      await client.general.ping("late");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe("SERVICE_UNAVAILABLE");
  });

  test("an aborted config mutation stays in flight until its write settles", async () => {
    let started!: () => void;
    const writeStarted = new Promise<void>((resolve) => (started = resolve));
    let finish!: () => void;
    const write = new Promise<void>((resolve) => (finish = resolve));
    const context = {
      config: {
        markSplashScreenViewed: () => {
          started();
          return write;
        },
      },
    } as unknown as ORPCContext;
    const client = createRouterClient(router(), { context });
    const controller = new AbortController();
    const call = client.splashScreens
      .markSplashScreenViewed({ splashId: "late" }, { signal: controller.signal })
      .catch((error: unknown) => error);
    await writeStarted;
    expect(inFlightProcedureCount()).toBe(1);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inFlightProcedureCount()).toBe(1);
    finish();
    await call;
    expect(inFlightProcedureCount()).toBe(0);
  });

  // chmod-based error injection is meaningless where permission bits don't
  // bind: root bypasses them (common in containerized CI) and Windows ACLs
  // ignore POSIX modes entirely.
  const permissionBitsEnforced =
    process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;

  test("updateTelemetryEnabled persists explicitly in both directions and applies the toggle", async () => {
    const client = createRouterClient(router(), { context: createContext() });

    await client.config.updateTelemetryEnabled({ enabled: false });

    expect(config.loadConfigOrDefault().telemetryEnabled).toBe(false);
    expect(setConfigEnabledMock).toHaveBeenLastCalledWith(false);
    // The downgrade-surviving sidecar marker tracks the opt-out.
    expect(fs.existsSync(path.join(tempDir, "telemetry_opt_out"))).toBe(true);

    await client.config.updateTelemetryEnabled({ enabled: true });

    // Re-enabling stores an EXPLICIT true (not a sparse delete): a crash
    // before the marker removal must leave a field the startup
    // reconciliation can repair from, or the app restarts opted out despite
    // a successful re-enable.
    expect(config.loadConfigOrDefault().telemetryEnabled).toBe(true);
    expect(setConfigEnabledMock).toHaveBeenLastCalledWith(true);
    expect(fs.existsSync(path.join(tempDir, "telemetry_opt_out"))).toBe(false);
  });

  test("updateTelemetryEnabled applies the runtime toggle even when the client aborts mid-persist", async () => {
    // Persistence and the live application are one uninterruptible section:
    // a client abort while the field/marker write is pending must not leave
    // the records changed and the running client untouched.
    let started!: () => void;
    const persistStarted = new Promise<void>((resolve) => (started = resolve));
    let finish!: () => void;
    const persist = new Promise<void>((resolve) => (finish = resolve));
    const persistSpy = spyOn(config, "setTelemetryEnabledPersisted").mockImplementation(() => {
      started();
      return persist;
    });
    try {
      const client = createRouterClient(router(), { context: createContext() });
      const controller = new AbortController();
      const call = client.config
        .updateTelemetryEnabled({ enabled: false }, { signal: controller.signal })
        .catch((error: unknown) => error);
      await persistStarted;
      controller.abort();
      finish();
      await call;
    } finally {
      persistSpy.mockRestore();
    }
    expect(setConfigEnabledMock).toHaveBeenCalledWith(false);
  });

  test("updateTelemetryEnabled rolls the config field back when verification cannot read it", async () => {
    const client = createRouterClient(router(), { context: createContext() });

    // The atomic write can LAND before a transient read failure hits the
    // strict verification. Reporting failure while leaving the field persisted
    // (with no marker) would strand an opt-out that the next downgrade save
    // silently drops — the route must restore the prior state instead.
    const original = config.loadConfigOrDefault.bind(config);
    let threwOnce = false;
    const loadSpy = spyOn(config, "loadConfigOrDefault").mockImplementation(((options?: {
      throwOnError?: boolean;
    }) => {
      if (options?.throwOnError && !threwOnce) {
        threwOnce = true;
        throw new Error("transient read failure");
      }
      return original(options);
    }) as typeof config.loadConfigOrDefault);
    try {
      await expect(client.config.updateTelemetryEnabled({ enabled: false })).rejects.toThrow(
        /verify the telemetry preference/
      );
    } finally {
      loadSpy.mockRestore();
    }

    expect(config.loadConfigOrDefault().telemetryEnabled).toBeUndefined();
    expect(fs.existsSync(path.join(tempDir, "telemetry_opt_out"))).toBe(false);
    expect(setConfigEnabledMock).not.toHaveBeenCalled();
  });

  test("updateTelemetryEnabled rolls the config field back when the marker sync fails", async () => {
    const client = createRouterClient(router(), { context: createContext() });

    // Both persisted records must agree before the RPC reports success: a
    // verified config write with a lost marker would silently break the
    // downgrade guarantee, so the route must restore the prior field state
    // and reject.
    const markerSpy = spyOn(config, "setTelemetryOptOutMarker").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    try {
      await expect(client.config.updateTelemetryEnabled({ enabled: false })).rejects.toThrow(
        /opt-out marker/
      );
    } finally {
      markerSpy.mockRestore();
    }

    expect(config.loadConfigOrDefault().telemetryEnabled).toBeUndefined();
    expect(fs.existsSync(path.join(tempDir, "telemetry_opt_out"))).toBe(false);
    expect(setConfigEnabledMock).not.toHaveBeenCalled();
  });

  test.skipIf(!permissionBitsEnforced)(
    "updateTelemetryEnabled fails loudly when the config write does not land",
    async () => {
      const client = createRouterClient(router(), { context: createContext() });

      // saveConfig writes atomically (temp file + rename in the config dir), so a
      // read-only dir makes the write fail. saveConfig swallows that error; the
      // route must detect it anyway rather than report success for a privacy
      // setting that will silently revert on next launch. The registration
      // lock lives in locks/ — pre-create it writable so the transaction gets
      // past lock acquisition to the write this test is about.
      fs.mkdirSync(path.join(tempDir, "locks"), { recursive: true });
      fs.chmodSync(tempDir, 0o500);
      try {
        await expect(client.config.updateTelemetryEnabled({ enabled: false })).rejects.toThrow(
          /persist the telemetry preference/
        );
      } finally {
        fs.chmodSync(tempDir, 0o700);
      }

      expect(config.loadConfigOrDefault().telemetryEnabled).toBeUndefined();
      expect(setConfigEnabledMock).not.toHaveBeenCalled();
    }
  );

  test.skipIf(!permissionBitsEnforced)(
    "updateTelemetryEnabled fails when persistence cannot be verified",
    async () => {
      const client = createRouterClient(router(), { context: createContext() });

      // Materialize config.json, then make it unreadable AND the dir unwritable:
      // the disable write is swallowed and the verification read fails. A read
      // failure must fail the RPC — it must not masquerade as a confirmed
      // opt-out (the fail-closed enablement read would report disabled here).
      // The exact rejection depends on which guard fires first (Config's
      // corrupt-config backup protection can reject the write before the
      // route's verification read); either way the RPC must reject.
      await client.config.updateChatTranscriptFullWidth({ enabled: true });
      const configFile = path.join(tempDir, "config.json");
      fs.chmodSync(configFile, 0o000);
      // Keep the registration lock acquirable (see the read-only-dir test above).
      fs.mkdirSync(path.join(tempDir, "locks"), { recursive: true });
      fs.chmodSync(tempDir, 0o500);
      try {
        await expect(client.config.updateTelemetryEnabled({ enabled: false })).rejects.toThrow();
      } finally {
        fs.chmodSync(tempDir, 0o700);
        fs.chmodSync(configFile, 0o600);
      }

      expect(config.loadConfigOrDefault().telemetryEnabled).toBeUndefined();
      expect(setConfigEnabledMock).not.toHaveBeenCalled();
    }
  );
});
