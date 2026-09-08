import * as fs from "fs/promises";
import * as nodeFs from "node:fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, spyOn, test } from "bun:test";
import type { DesktopViewerEvent } from "@/common/types/desktop";
import type { Workspace } from "@/common/types/project";
import { DESKTOP_ATTACHMENT_GRACE_MS, DESKTOP_DEFAULTS } from "@/common/constants/desktop";
import { PortableDesktopSession } from "./PortableDesktopSession";
import { DesktopTokenManager } from "./DesktopTokenManager";
import { getDesktopBootstrap } from "./desktopOperations";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { Config } from "@/node/config";
import { ExperimentsService } from "@/node/services/experimentsService";
import { WorkspaceService } from "@/node/services/workspaceService";
import { DesktopSessionManager } from "./DesktopSessionManager";

interface PortableDesktopStartupOutput {
  runtimeDir: string;
  display: number;
  vncPort: number;
  geometry: string;
  depth: number;
  dpi: number;
  desktopSizeMode: string;
  sessionDir: string;
  cleanupSessionDirOnStop: boolean;
  xvncPid: number;
  openboxPid: number;
  detached: boolean;
  stateFile?: string;
  startedAt: string;
  sessionId?: string;
}

interface PortableDesktopShimConfig {
  startupInfo?: PortableDesktopStartupOutput;
  actionRecordPath?: string;
}

interface DesktopManagerHarness {
  tempDir: string;
  config: Config;
  originalPath: string | undefined;
}

const TEST_STARTED_AT = "2026-03-14T14:33:30Z";

function createStartupInfo(options: {
  display: number;
  vncPort: number;
  geometry: string;
  sessionDir?: string;
  stateFile?: string;
  sessionId?: string;
}): PortableDesktopStartupOutput {
  return {
    runtimeDir: "/home/coder/.cache/portabledesktop/runtime-a4db4a81d62e",
    display: options.display,
    vncPort: options.vncPort,
    geometry: options.geometry,
    depth: 24,
    dpi: 96,
    desktopSizeMode: "fixed",
    sessionDir: options.sessionDir ?? `/tmp/portabledesktop-${options.display}`,
    cleanupSessionDirOnStop: true,
    xvncPid: 4010171,
    openboxPid: 4010180,
    detached: true,
    stateFile: options.stateFile,
    startedAt: TEST_STARTED_AT,
    sessionId: options.sessionId,
  };
}

let desktopManagerTestLock: Promise<void> = Promise.resolve();

async function withDesktopManagerHarness(
  run: (harness: DesktopManagerHarness) => Promise<void>
): Promise<void> {
  const previousLock = desktopManagerTestLock;
  let releaseLock: (() => void) | undefined;
  desktopManagerTestLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  await previousLock;

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-desktop-session-manager-test-"));
  const config = new Config(tempDir);
  const originalPath = process.env.PATH;
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  try {
    await config.editConfig((current) => {
      current.projects.set("/tmp/project-1", {
        workspaces: [
          "platform",
          "missing-binary",
          "local",
          "reuse",
          "archiving",
          "dead",
          "close-one",
          "close-two",
          "action",
        ]
          .map(
            (suffix): Workspace => ({
              id: `workspace-${suffix}`,
              name: `workspace-${suffix}`,
              path: `/tmp/project-1/workspace-${suffix}`,
              runtimeConfig: { type: "local" },
            })
          )
          .concat([
            {
              id: "workspace-ssh",
              name: "workspace-ssh",
              path: "/tmp/project-1/ssh",
              runtimeConfig: { type: "ssh", host: "example.com", srcBaseDir: "~/mux" },
            },
            {
              id: "workspace-worktree",
              name: "workspace-worktree",
              path: "/tmp/project-1/worktree",
              runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/worktrees" },
            },
          ] as Workspace[]),
      });
      return current;
    });
    await run({ tempDir, config, originalPath });
  } finally {
    process.env.PATH = originalPath;
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    await fs.rm(tempDir, { recursive: true, force: true });
    releaseLock?.();
  }
}

// Keep the manager shim aligned with the real PortableDesktop lifecycle so
// DesktopSessionManager exercises detached startup, state-file liveness, and
// state-file-based follow-up commands instead of the older long-lived process model.
function buildControllerScript(configPath: string): string {
  return `
const fs = require("fs");
const path = require("path");
const config = JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}, "utf8"));
const command = process.argv[2];
const args = process.argv.slice(3);

function readFlag(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function getPositionals() {
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith("--")) {
      index += 1;
      continue;
    }
    positionals.push(value);
  }
  return positionals;
}

function appendActionRecord(entry) {
  if (!config.actionRecordPath) {
    return;
  }

  const existing = fs.existsSync(config.actionRecordPath)
    ? JSON.parse(fs.readFileSync(config.actionRecordPath, "utf8"))
    : [];
  existing.push(entry);
  fs.writeFileSync(config.actionRecordPath, JSON.stringify(existing));
}

switch (command) {
  case "up": {
    const stateFile = readFlag("--state-file") ?? config.startupInfo?.stateFile;
    const startupInfo = {
      ...config.startupInfo,
      stateFile,
    };
    if (stateFile) {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(startupInfo));
    }
    process.stdout.write(JSON.stringify(startupInfo) + "\\n");
    break;
  }
  case "down": {
    const stateFile = readFlag("--state-file");
    if (stateFile) {
      fs.rmSync(stateFile, { force: true });
    }
    break;
  }
  case "mouse": {
    const positionals = getPositionals();
    appendActionRecord({
      command,
      subcommand: positionals[0],
      args: positionals.slice(1),
      stateFile: readFlag("--state-file"),
    });
    break;
  }
  case "keyboard": {
    const positionals = getPositionals();
    appendActionRecord({
      command,
      subcommand: positionals[0],
      args: positionals.slice(1),
      stateFile: readFlag("--state-file"),
    });
    break;
  }
  case "screenshot": {
    const positionals = getPositionals();
    const outputPath = positionals[0] ?? readFlag("--file");
    if (!outputPath) {
      process.stderr.write("Missing screenshot output path");
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from("manager-screenshot", "utf8"));
    break;
  }
  default: {
    process.stderr.write("Unknown command: " + command);
    process.exit(1);
  }
}
`;
}

function buildLauncherScript(controllerPath: string): string {
  const runtimePath = JSON.stringify(process.execPath);
  const escapedControllerPath = JSON.stringify(controllerPath);

  if (process.platform === "win32") {
    return `@echo off\r\n"${process.execPath}" ${escapedControllerPath} %*\r\n`;
  }

  return `#!/bin/sh\nexec ${runtimePath} ${escapedControllerPath} "$@"\n`;
}

async function installPortableDesktopShim(options: {
  rootDir: string;
  config: PortableDesktopShimConfig;
}): Promise<void> {
  const cacheDir = path.join(options.rootDir, "cache", "portabledesktop");
  await fs.mkdir(cacheDir, { recursive: true });

  const controllerPath = path.join(cacheDir, "portable-desktop-manager-shim.js");
  const configPath = path.join(cacheDir, "portable-desktop-manager-shim.config.json");
  await fs.writeFile(configPath, JSON.stringify(options.config));
  await fs.writeFile(controllerPath, buildControllerScript(configPath));

  const binaryName = process.platform === "win32" ? "portabledesktop.exe" : "portabledesktop";
  const binaryPath = path.join(cacheDir, binaryName);
  await fs.writeFile(binaryPath, buildLauncherScript(controllerPath));
  if (process.platform !== "win32") {
    await fs.chmod(binaryPath, 0o755);
  }
}

function createWorkspaceMetadata(
  runtimeConfig: FrontendWorkspaceMetadata["runtimeConfig"]
): FrontendWorkspaceMetadata {
  const metadata: FrontendWorkspaceMetadata = {
    id: "workspace-1",
    name: "workspace-1",
    projectName: "project-1",
    projectPath: "/tmp/project-1",
    runtimeConfig,
    namedWorkspacePath: "/tmp/project-1/workspace-1",
  };
  return metadata;
}

function createExperimentsService(enabled: boolean): ExperimentsService {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- prototype-backed stub only needs isExperimentEnabled in these tests.
  return Object.setPrototypeOf(
    {
      isExperimentEnabled: () => enabled,
    },
    ExperimentsService.prototype
  );
}

function createWorkspaceService(
  getInfo: (workspaceId: string) => Promise<FrontendWorkspaceMetadata | null>
): WorkspaceService {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- prototype-backed stub only needs getInfo in these tests.
  return Object.setPrototypeOf(
    {
      getInfo,
      isRemoving: () => false,
    },
    WorkspaceService.prototype
  );
}

function assertSessionMap(value: unknown): asserts value is Map<string, unknown> {
  expect(value).toBeInstanceOf(Map);
}

interface PortableDesktopRecordedCommand {
  command: string;
  subcommand: string;
  args: string[];
  stateFile: string;
}

function assertPortableDesktopRecordedCommands(
  value: unknown
): asserts value is PortableDesktopRecordedCommand[] {
  expect(Array.isArray(value)).toBe(true);
  if (!Array.isArray(value)) {
    throw new Error("PortableDesktop recorded commands must be an array");
  }

  for (const entry of value) {
    expect(entry).toBeObject();
    const record = entry as Record<string, unknown>;
    expect(typeof record.command).toBe("string");
    expect(typeof record.subcommand).toBe("string");
    expect(Array.isArray(record.args)).toBe(true);
    expect(typeof record.stateFile).toBe("string");
  }
}

async function registerSharedWorkspaces(config: Config): Promise<void> {
  await config.editConfig((current) => {
    const project = current.projects.get("/tmp/project-1");
    if (!project) throw new Error("Missing test project");
    project.workspaces.push(
      { id: "owner", name: "owner-name", path: "/tmp/project-1/owner" },
      {
        id: "child",
        name: "child",
        path: "/tmp/project-1/child",
        parentWorkspaceId: "owner",
        taskDesktopOwnerWorkspaceId: "owner",
        taskStatus: "running",
      },
      {
        id: "isolated",
        name: "isolated",
        path: "/tmp/project-1/isolated",
        parentWorkspaceId: "owner",
      }
    );
    return current;
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createWindowManager() {
  const windows = new Map<string, { instanceId: string }>();
  return {
    openWindow(workspaceId: string, instanceId: string) {
      const state = windows.get(workspaceId) ?? { instanceId };
      windows.set(workspaceId, state);
      return Promise.resolve(state);
    },
    getWindow: (workspaceId: string) => windows.get(workspaceId) ?? null,
    closeWindow(workspaceId: string, instanceId: string) {
      if (windows.get(workspaceId)?.instanceId === instanceId) windows.delete(workspaceId);
      return Promise.resolve();
    },
    closeWorkspace: (workspaceId: string) => {
      windows.delete(workspaceId);
      return Promise.resolve();
    },
    closeAll: () => {
      windows.clear();
      return Promise.resolve();
    },
  };
}

async function withWindowHarness(
  run: (harness: {
    manager: DesktopSessionManager;
    config: Config;
    windows: ReturnType<typeof createWindowManager>;
    workspaceService: WorkspaceService;
    experimentsService: ExperimentsService;
  }) => Promise<void>
) {
  await withDesktopManagerHarness(async ({ tempDir, config }) => {
    // Never let an installed host desktop mask an incomplete fixture or start a real desktop.
    process.env.PATH = "";
    await installPortableDesktopShim({
      rootDir: tempDir,
      config: {
        startupInfo: createStartupInfo({ display: 24, vncPort: 5914, geometry: "1024x768" }),
      },
    });
    await config.editConfig((current) => {
      const project = current.projects.get("/tmp/project-1");
      if (!project) throw new Error("Missing test project");
      project.workspaces.push(
        ...["workspace", "one", "two"].map((id) => ({
          id,
          name: id,
          path: `/tmp/project-1/${id}`,
          runtimeConfig: { type: "local" as const },
        }))
      );
      return current;
    });
    const workspaceService = createWorkspaceService(() =>
      Promise.resolve(createWorkspaceMetadata({ type: "local" }))
    );
    const experimentsService = createExperimentsService(true);
    const manager = new DesktopSessionManager({ config, experimentsService, workspaceService });
    // WorkspaceService now supplies one guard covering both archive and removal admission.
    manager.setWorkspaceArchiveGuard((workspaceId) => workspaceService.isRemoving(workspaceId));
    const windows = createWindowManager();
    manager.setDesktopWindowManager(windows);
    try {
      await run({ manager, config, windows, workspaceService, experimentsService });
    } finally {
      await manager.closeAll();
    }
  });
}

async function nextViewerEvent(
  watcher: AsyncGenerator<DesktopViewerEvent>,
  type: DesktopViewerEvent["type"]
) {
  const next = await watcher.next();
  if (next.done) throw new Error("Viewer watch ended before its event");
  expect(next.value.type).toBe(type);
  return next.value;
}

async function withBrowserViewerHarness(
  run: (harness: {
    manager: DesktopSessionManager;
    config: Config;
    watch: (workspaceId: string) => AsyncGenerator<DesktopViewerEvent>;
    abort: () => void;
  }) => Promise<void>
) {
  await withDesktopManagerHarness(async ({ config, tempDir }) => {
    process.env.PATH = "";
    await registerSharedWorkspaces(config);
    await installPortableDesktopShim({
      rootDir: tempDir,
      config: {
        startupInfo: createStartupInfo({ display: 25, vncPort: 5915, geometry: "1024x768" }),
      },
    });
    const manager = new DesktopSessionManager({
      config,
      experimentsService: createExperimentsService(true),
      workspaceService: createWorkspaceService(() => Promise.resolve(null)),
    });
    const controller = new AbortController();
    const watchers: Array<AsyncGenerator<DesktopViewerEvent>> = [];
    try {
      await run({
        manager,
        config,
        watch: (workspaceId) => {
          const watcher = manager.watchViewer(workspaceId, controller.signal);
          watchers.push(watcher);
          return watcher;
        },
        abort: () => controller.abort(),
      });
    } finally {
      controller.abort();
      await Promise.all(watchers.map((watcher) => watcher.return(undefined)));
      await manager.closeAll();
    }
  });
}

describe("DesktopSessionManager browser viewer releases", () => {
  test("registers before ready and requires the matching ACK before borrower bridge revocation", async () => {
    if (process.platform === "win32") return;
    await withBrowserViewerHarness(async ({ manager, watch }) => {
      const owner = await manager.ensureStarted("owner");
      const borrower = watch("child");
      const readyPromise = nextViewerEvent(borrower, "ready");
      expect(manager.has("child")).toBe(true);
      const ready = await readyPromise;
      expect(ready.viewerId.length).toBeGreaterThan(0);
      const revoked: Array<string | null> = [];
      const unsubscribe = manager.onWorkspaceClose((id) => revoked.push(id));
      // An early ACK cannot pre-authorize a future input release.
      manager.acknowledgeViewerRelease(ready.viewerId);
      const closing = manager.close("child");
      expect(manager.close("child")).toBe(closing);
      expect(await nextViewerEvent(borrower, "release")).toEqual({
        type: "release",
        viewerId: ready.viewerId,
      });
      manager.acknowledgeViewerRelease("unknown-viewer");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(revoked).toEqual([]);
      expect(owner.isAlive()).toBe(true);
      const rejected = watch("child");
      expect(await rejected.next().catch((error: unknown) => error)).toBeInstanceOf(Error);
      manager.acknowledgeViewerRelease(ready.viewerId);
      await closing;
      expect(revoked).toEqual(["child"]);
      expect(owner.isAlive()).toBe(true);
      expect(manager.has("child")).toBe(false);
      unsubscribe();
    });
  });

  test("hasAttachedViewers() ignores an idle desktop process but tracks viewers on the owner and borrower", async () => {
    if (process.platform === "win32") return;
    await withBrowserViewerHarness(async ({ manager, watch }) => {
      // An agent left the desktop process running with nobody attached: live for has(), but
      // not activity an agent-driven archive should stall on.
      await manager.ensureStarted("owner");
      expect(manager.has("owner")).toBe(true);
      expect(manager.hasAttachedViewers("owner")).toBe(false);

      // A live VNC bridge (the inline Electron pane registers no browser viewer) attaches too.
      manager.setBridgeConnectionProbe((workspaceId) => workspaceId === "owner");
      expect(manager.hasAttachedViewers("owner")).toBe(true);
      expect(manager.hasAttachedViewers("child")).toBe(false);
      manager.setBridgeConnectionProbe(() => false);
      expect(manager.hasAttachedViewers("owner")).toBe(false);

      // A borrower viewer attaches to the owner's desktop, so both sides report attachment.
      const borrower = watch("child");
      const ready = await nextViewerEvent(borrower, "ready");
      expect(manager.hasAttachedViewers("child")).toBe(true);
      expect(manager.hasAttachedViewers("owner")).toBe(true);
      expect(manager.hasAttachedViewers("isolated")).toBe(false);

      const closing = manager.close("child");
      await nextViewerEvent(borrower, "release");
      manager.acknowledgeViewerRelease(ready.viewerId);
      await closing;
      // An explicit close of the borrower is deterministic: it leaves no grace behind on the
      // owner, whose desktop process stays alive but unattached.
      expect(manager.has("owner")).toBe(true);
      expect(manager.hasAttachedViewers("owner")).toBe(false);
    });
  });

  test("a detached viewer or bridge keeps its workspaces attached only for the bounded grace", async () => {
    if (process.platform === "win32") return;
    await withDesktopManagerHarness(async ({ config }) => {
      await registerSharedWorkspaces(config);
      let now = 1_000_000;
      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() => Promise.resolve(null)),
        now: () => now,
      });
      const registerViewer = async (workspaceId: string) => {
        const controller = new AbortController();
        const watcher = manager.watchViewer(workspaceId, controller.signal);
        const first: IteratorResult<DesktopViewerEvent> = await watcher.next();
        expect(first.done).toBe(false);
        expect(first.value).toMatchObject({ type: "ready" });
        const viewerId = !first.done && first.value.type === "ready" ? first.value.viewerId : "";
        return { controller, watcher, viewerId };
      };
      try {
        // Never attached: no grace, so an idle process stays archivable.
        expect(manager.hasAttachedViewers("owner")).toBe(false);

        // A borrower viewer that unregisters (transport loss) protects requester and owner...
        const lost = await registerViewer("child");
        lost.controller.abort();
        await lost.watcher.return(undefined);
        expect(manager.has("child")).toBe(false);
        expect(manager.hasAttachedViewers("child")).toBe(true);
        expect(manager.hasAttachedViewers("owner")).toBe(true);
        expect(manager.hasAttachedViewers("isolated")).toBe(false);
        // ...until the grace expires.
        now += DESKTOP_ATTACHMENT_GRACE_MS - 1;
        expect(manager.hasAttachedViewers("owner")).toBe(true);
        now += 1;
        expect(manager.hasAttachedViewers("owner")).toBe(false);
        expect(manager.hasAttachedViewers("child")).toBe(false);

        // A closed VNC bridge reports through noteDetached the same way.
        manager.noteDetached("isolated", "isolated");
        expect(manager.hasAttachedViewers("isolated")).toBe(true);
        now += DESKTOP_ATTACHMENT_GRACE_MS;
        expect(manager.hasAttachedViewers("isolated")).toBe(false);

        // An explicit close is definitive for everything its requester ever attached: it clears
        // the graces that requester left on itself AND on its owner — whether stamped before
        // the close (an earlier drop) or during it (the bridge closes before the release ACK) —
        // while a grace another requester left on the same owner survives.
        manager.noteDetached("child", "owner");
        // Another (already removed, hence unresolvable) borrower's attachment to the owner.
        manager.noteDetached("former-borrower", "owner");
        const closed = await registerViewer("child");
        const closing = manager.close("child");
        const release: IteratorResult<DesktopViewerEvent> = await closed.watcher.next();
        expect(release.done).toBe(false);
        expect(release.value).toMatchObject({ type: "release" });
        manager.noteDetached("child", "owner");
        if (!release.done && release.value.type === "release") {
          manager.acknowledgeViewerRelease(release.value.viewerId);
        }
        await closing;
        await closed.watcher.return(undefined);
        expect(manager.hasAttachedViewers("child")).toBe(false);
        expect(manager.hasAttachedViewers("owner")).toBe(true);
        now += DESKTOP_ATTACHMENT_GRACE_MS;
        expect(manager.hasAttachedViewers("owner")).toBe(false);

        // Closing the OWNER retracts the graces of the borrowers it releases (their viewers and
        // bridges), not only its own; its desktop is gone, so nothing can reattach to it.
        const borrowerViewer = await registerViewer("child");
        const ownerClosing = manager.close("owner");
        const ownerRelease: IteratorResult<DesktopViewerEvent> =
          await borrowerViewer.watcher.next();
        expect(ownerRelease.value).toMatchObject({ type: "release" });
        // The borrower's bridge closes during the owner's teardown.
        manager.noteDetached("child", "owner");
        if (!ownerRelease.done && ownerRelease.value.type === "release") {
          manager.acknowledgeViewerRelease(ownerRelease.value.viewerId);
        }
        await ownerClosing;
        await borrowerViewer.watcher.return(undefined);
        expect(manager.hasAttachedViewers("child")).toBe(false);
        expect(manager.hasAttachedViewers("owner")).toBe(false);

        // A pane that gives its registration up definitively leaves no grace either...
        const definitive = await registerViewer("isolated");
        manager.detachViewer(definitive.viewerId);
        expect(manager.hasAttachedViewers("isolated")).toBe(false);
        definitive.controller.abort();
        await definitive.watcher.return(undefined);
        expect(manager.hasAttachedViewers("isolated")).toBe(false);
        // ...and retracts the grace a superseded registration stamped when the pane reports that
        // viewerId too (a ready registration that dropped while the bootstrap was pending is
        // replaced at once; the terminal outcome arrives through the replacement) — but never
        // the grace another pane of the same requester left while it re-registers.
        const otherPane = await registerViewer("isolated");
        otherPane.controller.abort();
        await otherPane.watcher.return(undefined);
        const superseded = await registerViewer("isolated");
        superseded.controller.abort();
        await superseded.watcher.return(undefined);
        const replacement = await registerViewer("isolated");
        manager.detachViewer(replacement.viewerId);
        manager.detachViewer(superseded.viewerId);
        expect(manager.hasAttachedViewers("isolated")).toBe(true);
        manager.detachViewer(otherPane.viewerId);
        expect(manager.hasAttachedViewers("isolated")).toBe(false);
        replacement.controller.abort();
        await replacement.watcher.return(undefined);

        // A bridge bootstrapped under a viewer registration is that pane's too: the pane's
        // definitive detach (a clean unmount) retracts the bridge's grace whether the bridge
        // closed before or — its socket close travelling separately — after the detach, while
        // an anonymous bridge (an Electron popout) keeps its grace.
        const unmounting = await registerViewer("isolated");
        manager.noteDetached("isolated", "isolated", unmounting.viewerId);
        expect(manager.hasAttachedViewers("isolated")).toBe(true);
        manager.detachViewer(unmounting.viewerId);
        expect(manager.hasAttachedViewers("isolated")).toBe(false);
        manager.noteDetached("isolated", "isolated", unmounting.viewerId);
        expect(manager.hasAttachedViewers("isolated")).toBe(false);
        unmounting.controller.abort();
        await unmounting.watcher.return(undefined);
        manager.noteDetached("isolated", "isolated");
        expect(manager.hasAttachedViewers("isolated")).toBe(true);
        now += DESKTOP_ATTACHMENT_GRACE_MS;
        expect(manager.hasAttachedViewers("isolated")).toBe(false);

        // A viewer that simply loses its subscription keeps the grace regardless of what its
        // bootstrap reported: only the client knows whether it will retry (a previously
        // connected pane keeps reconnecting through an unavailable bootstrap).
        const reconnecting = await registerViewer("isolated");
        reconnecting.controller.abort();
        await reconnecting.watcher.return(undefined);
        expect(manager.hasAttachedViewers("isolated")).toBe(true);
        now += DESKTOP_ATTACHMENT_GRACE_MS;
        expect(manager.hasAttachedViewers("isolated")).toBe(false);
      } finally {
        await manager.closeAll();
      }
    });
  });

  test("an Electron popout counts against its requester's current owner", async () => {
    if (process.platform === "win32") return;
    await withDesktopManagerHarness(async ({ config, tempDir }) => {
      process.env.PATH = "";
      await registerSharedWorkspaces(config);
      // openWindow checks capability, which needs a resolvable PortableDesktop binary.
      await installPortableDesktopShim({
        rootDir: tempDir,
        config: {
          startupInfo: createStartupInfo({ display: 26, vncPort: 5916, geometry: "1024x768" }),
        },
      });
      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() =>
          Promise.resolve(createWorkspaceMetadata({ type: "local" }))
        ),
      });
      manager.setDesktopWindowManager(createWindowManager());
      try {
        await manager.openWindow("child", "instance-1");
        expect(manager.hasAttachedViewers("owner")).toBe(true);
        await config.editConfig((current) => {
          const project = current.projects.get("/tmp/project-1");
          if (!project) throw new Error("Missing test project");
          const child = project.workspaces.find((workspace) => workspace.id === "child");
          if (!child) throw new Error("Missing child workspace");
          delete child.taskDesktopOwnerWorkspaceId;
          return current;
        });
        // The window's captured owner is stale: it no longer keeps the old owner attached...
        expect(manager.hasAttachedViewers("owner")).toBe(false);
        expect(manager.hasAttachedViewers("child")).toBe(true);
        // ...and closing the old owner leaves the unrelated popout alone.
        await manager.close("owner");
        expect(manager.getWindow("child")).not.toBeNull();
      } finally {
        await manager.closeAll();
      }
    });
  });

  test("a registered borrower counts against its current owner, not the owner it registered under", async () => {
    if (process.platform === "win32") return;
    await withDesktopManagerHarness(async ({ config }) => {
      await registerSharedWorkspaces(config);
      let now = 1_000_000;
      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() => Promise.resolve(null)),
        now: () => now,
      });
      const controller = new AbortController();
      try {
        const watcher = manager.watchViewer("child", controller.signal);
        const ready: IteratorResult<DesktopViewerEvent> = await watcher.next();
        expect(ready.value).toMatchObject({ type: "ready" });
        expect(manager.hasAttachedViewers("owner")).toBe(true);
        // The borrower's binding is removed (its task settled) while the pane stays mounted, so
        // its desktop target is now itself.
        await config.editConfig((current) => {
          const project = current.projects.get("/tmp/project-1");
          if (!project) throw new Error("Missing test project");
          const child = project.workspaces.find((workspace) => workspace.id === "child");
          if (!child) throw new Error("Missing child workspace");
          delete child.taskDesktopOwnerWorkspaceId;
          return current;
        });
        // The old owner is not held indefinitely by the stale registration...
        now += DESKTOP_ATTACHMENT_GRACE_MS;
        expect(manager.hasAttachedViewers("owner")).toBe(false);
        expect(manager.hasAttachedViewers("child")).toBe(true);
        // ...nor by the bridge the rebind revokes (its captured owner is stale too).
        manager.noteDetached("child", "owner");
        expect(manager.hasAttachedViewers("owner")).toBe(false);
        // Closing the old owner must not release the viewer that no longer targets it.
        const released: DesktopViewerEvent[] = [];
        const drain = (async () => {
          for await (const event of watcher) released.push(event);
        })();
        await manager.close("owner");
        expect(released).toEqual([]);
        expect(manager.hasAttachedViewers("child")).toBe(true);
        controller.abort();
        await drain;
      } finally {
        controller.abort();
        await manager.closeAll();
      }
    });
  });

  test("a borrower's detachment grace follows it to the owner it currently resolves to", async () => {
    if (process.platform === "win32") return;
    await withDesktopManagerHarness(async ({ config }) => {
      await registerSharedWorkspaces(config);
      const now = 1_000_000;
      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() => Promise.resolve(null)),
        now: () => now,
      });
      try {
        // The borrower lost both transports while bound to the owner.
        manager.noteDetached("child", "owner");
        expect(manager.hasAttachedViewers("owner")).toBe(true);
        expect(manager.hasAttachedViewers("child")).toBe(true);
        // Its binding is removed before it reconnects: the old owner is no longer protected by
        // that grace, while the borrower itself (which its reconnect now targets) still is.
        await config.editConfig((current) => {
          const project = current.projects.get("/tmp/project-1");
          if (!project) throw new Error("Missing test project");
          const child = project.workspaces.find((workspace) => workspace.id === "child");
          if (!child) throw new Error("Missing child workspace");
          delete child.taskDesktopOwnerWorkspaceId;
          return current;
        });
        expect(manager.hasAttachedViewers("owner")).toBe(false);
        expect(manager.hasAttachedViewers("child")).toBe(true);
      } finally {
        await manager.closeAll();
      }
    });
  });

  test("closing an owner excludes only that owner from a borrower's grace and spares graces on its new owner", async () => {
    if (process.platform === "win32") return;
    await withDesktopManagerHarness(async ({ config }) => {
      await registerSharedWorkspaces(config);
      // A grandparent the borrower can be rebound to (owners must be ancestors).
      await config.editConfig((current) => {
        const project = current.projects.get("/tmp/project-1");
        if (!project) throw new Error("Missing test project");
        project.workspaces.push({ id: "grand", name: "grand", path: "/tmp/project-1/grand" });
        const owner = project.workspaces.find((workspace) => workspace.id === "owner");
        if (!owner) throw new Error("Missing owner workspace");
        owner.parentWorkspaceId = "grand";
        return current;
      });
      const rebindChildToGrand = () =>
        config.editConfig((current) => {
          const project = current.projects.get("/tmp/project-1");
          if (!project) throw new Error("Missing test project");
          const child = project.workspaces.find((workspace) => workspace.id === "child");
          if (!child) throw new Error("Missing child workspace");
          child.taskDesktopOwnerWorkspaceId = "grand";
          return current;
        });
      const now = 1_000_000;
      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() => Promise.resolve(null)),
        now: () => now,
      });
      try {
        // A borrower with nothing but a grace: its owner closes explicitly, so the grace stops
        // covering that owner but still covers the borrower...
        manager.noteDetached("child", "owner");
        await manager.close("owner");
        expect(manager.hasAttachedViewers("owner")).toBe(false);
        expect(manager.hasAttachedViewers("child")).toBe(true);
        expect(manager.hasAttachedViewers("grand")).toBe(false);
        // ...and, once the borrower is rebound before it reconnects, the owner it now resolves
        // to: the exclusion names the closed owner rather than switching owner coverage off.
        await rebindChildToGrand();
        expect(manager.hasAttachedViewers("grand")).toBe(true);
        expect(manager.hasAttachedViewers("owner")).toBe(false);
      } finally {
        await manager.closeAll();
      }
    });
  });

  test("an owner's close does not retract the grace a rebound borrower stamps on its new owner meanwhile", async () => {
    if (process.platform === "win32") return;
    await withDesktopManagerHarness(async ({ config }) => {
      await registerSharedWorkspaces(config);
      await config.editConfig((current) => {
        const project = current.projects.get("/tmp/project-1");
        if (!project) throw new Error("Missing test project");
        project.workspaces.push({ id: "grand", name: "grand", path: "/tmp/project-1/grand" });
        const owner = project.workspaces.find((workspace) => workspace.id === "owner");
        if (!owner) throw new Error("Missing owner workspace");
        owner.parentWorkspaceId = "grand";
        return current;
      });
      const now = 1_000_000;
      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() => Promise.resolve(null)),
        now: () => now,
      });
      const controller = new AbortController();
      try {
        const watcher = manager.watchViewer("child", controller.signal);
        const ready: IteratorResult<DesktopViewerEvent> = await watcher.next();
        expect(ready.value).toMatchObject({ type: "ready" });
        // The owner's teardown is mid-flight (awaiting the borrower's release ACK) when the
        // borrower is rebound and a pane of its new target drops a bridge: that grace belongs to
        // the new owner, not to the closing one, so the finished close must not retract it.
        const closing = manager.close("owner");
        const release: IteratorResult<DesktopViewerEvent> = await watcher.next();
        expect(release.value).toMatchObject({ type: "release" });
        await config.editConfig((current) => {
          const project = current.projects.get("/tmp/project-1");
          if (!project) throw new Error("Missing test project");
          const child = project.workspaces.find((workspace) => workspace.id === "child");
          if (!child) throw new Error("Missing child workspace");
          child.taskDesktopOwnerWorkspaceId = "grand";
          return current;
        });
        manager.noteDetached("child", "grand");
        if (!release.done && release.value.type === "release") {
          manager.acknowledgeViewerRelease(release.value.viewerId);
        }
        await closing;
        controller.abort();
        await watcher.return(undefined);
        expect(manager.hasAttachedViewers("owner")).toBe(false);
        expect(manager.hasAttachedViewers("grand")).toBe(true);
        expect(manager.hasAttachedViewers("child")).toBe(true);
      } finally {
        controller.abort();
        await manager.closeAll();
      }
    });
  });

  test("owner cleanup releases each borrower viewer but leaves unrelated viewers registered", async () => {
    await withBrowserViewerHarness(async ({ manager, watch }) => {
      const owner = watch("owner");
      const child = watch("child");
      const sibling = watch("child");
      const isolated = watch("isolated");
      const registrations = await Promise.all(
        [owner, child, sibling, isolated].map((watcher) => nextViewerEvent(watcher, "ready"))
      );
      expect(new Set(registrations.map((event) => event.viewerId)).size).toBe(4);
      const revoked: Array<string | null> = [];
      const unsubscribe = manager.onWorkspaceClose((id) => revoked.push(id));
      const closing = manager.close("owner");
      const releases = await Promise.all(
        [owner, child, sibling].map((watcher) => nextViewerEvent(watcher, "release"))
      );
      for (const event of releases.slice(0, 2)) manager.acknowledgeViewerRelease(event.viewerId);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(revoked).toEqual([]);
      expect(manager.has("isolated")).toBe(true);
      manager.acknowledgeViewerRelease(releases[2].viewerId);
      await closing;
      expect(revoked).toEqual(["owner"]);
      expect(manager.has("isolated")).toBe(true);
      unsubscribe();
    });
  });

  test("stale ACKs cannot satisfy a replacement viewer's release", async () => {
    await withBrowserViewerHarness(async ({ manager, watch }) => {
      const first = watch("child");
      const previous = await nextViewerEvent(first, "ready");
      await first.return(undefined);
      const replacement = watch("child");
      const current = await nextViewerEvent(replacement, "ready");
      expect(current.viewerId).not.toBe(previous.viewerId);
      let completed = false;
      const closing = manager.close("child").then(() => {
        completed = true;
      });
      await nextViewerEvent(replacement, "release");
      manager.acknowledgeViewerRelease(previous.viewerId);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).toBe(false);
      manager.acknowledgeViewerRelease(current.viewerId);
      await closing;
      expect(completed).toBe(true);
    });
  });

  test.each(["abort", "unsubscribe", "no-ack"])(
    "%s does not impersonate a release ACK, and shutdown waits for the bounded fallback",
    async (mode) => {
      await withBrowserViewerHarness(async ({ manager, watch, abort }) => {
        const watcher = watch("child");
        const ready = await nextViewerEvent(watcher, "ready");
        const revoked: Array<string | null> = [];
        const unsubscribe = manager.onWorkspaceClose((id) => revoked.push(id));
        const closing = manager.close("child");
        await nextViewerEvent(watcher, "release");
        if (mode === "abort") {
          abort();
          expect(manager.has("child")).toBe(false);
          manager.acknowledgeViewerRelease(ready.viewerId);
          expect((await watcher.next()).done).toBe(true);
        }
        if (mode === "unsubscribe") await watcher.return(undefined);
        if (mode !== "no-ack") manager.acknowledgeViewerRelease(ready.viewerId);
        const shutdown = manager.closeAll();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(revoked).toEqual([]);
        await Promise.all([closing, shutdown]);
        expect(revoked).toEqual(["child", null]);
        manager.acknowledgeViewerRelease(ready.viewerId);
        unsubscribe();
      });
    }
  );

  test("closeAll requests browser and native cleanup concurrently and latches new registrations", async () => {
    await withBrowserViewerHarness(async ({ manager, watch }) => {
      const native = createWindowManager();
      const nativeStarted = deferred();
      const nativeReleased = deferred();
      native.closeAll = () => {
        nativeStarted.resolve();
        return nativeReleased.promise;
      };
      manager.setDesktopWindowManager(native);
      const watcher = watch("child");
      const ready = await nextViewerEvent(watcher, "ready");
      const closing = manager.closeAll();
      expect(manager.closeAll()).toBe(closing);
      const late = watch("isolated");
      expect(await late.next().catch((error: unknown) => error)).toBeInstanceOf(Error);
      try {
        await nativeStarted.promise;
        expect(await nextViewerEvent(watcher, "release")).toEqual({
          type: "release",
          viewerId: ready.viewerId,
        });
        manager.acknowledgeViewerRelease(ready.viewerId);
      } finally {
        nativeReleased.resolve();
        await closing;
      }
    });
  });

  test("an already-aborted subscription never registers or emits ready", async () => {
    await withBrowserViewerHarness(async ({ manager, watch, abort }) => {
      abort();
      expect((await watch("child").next()).done).toBe(true);
      expect(manager.has("child")).toBe(false);
    });
  });

  test("registration races resolve admission before ready, including delayed iterator consumption", async () => {
    await withBrowserViewerHarness(async ({ manager, watch }) => {
      const deferredWatch = watch("child");
      const closing = manager.close("child");
      expect(await deferredWatch.next().catch((error: unknown) => error)).toBeInstanceOf(Error);
      await closing;
      const admitted = watch("child");
      const ready = admitted.next();
      const closingAgain = manager.close("child");
      const first = await ready;
      expect(first.done).toBe(false);
      const release = await nextViewerEvent(admitted, "release");
      manager.acknowledgeViewerRelease(release.viewerId);
      await closingAgain;
      for (const id of ["owner", "child"]) {
        manager.setWorkspaceArchiveGuard((candidate) => candidate === id);
        expect(
          await watch("child")
            .next()
            .catch((error: unknown) => error)
        ).toBeInstanceOf(Error);
      }
    });
  });
});

describe("DesktopSessionManager windows", () => {
  test("server mode has no window and cannot create one", async () => {
    await withDesktopManagerHarness(async ({ config }) => {
      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() => Promise.resolve(null)),
      });
      expect(manager.getWindow("workspace")).toBeNull();
      await manager.closeWindow("workspace", "instance");
      expect(
        await manager.openWindow("workspace", "instance").catch((error: unknown) => error)
      ).toBeInstanceOf(Error);
    });
  });

  test.each(["missing", "remote", "disabled", "archiving", "removing"] as const)(
    "rejects a %s workspace before opening a window",
    async (reason) => {
      await withWindowHarness(
        async ({ manager, config, windows, workspaceService, experimentsService }) => {
          if (reason === "missing" || reason === "remote") {
            await config.editConfig((current) => {
              const project = current.projects.get("/tmp/project-1");
              const workspace = project?.workspaces.find((entry) => entry.id === "workspace");
              if (!project || !workspace) throw new Error("Missing test workspace");
              if (reason === "missing") {
                project.workspaces = project.workspaces.filter((entry) => entry !== workspace);
              } else {
                workspace.runtimeConfig = { type: "ssh", host: "host", srcBaseDir: "/tmp" };
              }
              return current;
            });
          }
          if (reason === "disabled")
            spyOn(experimentsService, "isExperimentEnabled").mockReturnValue(false);
          if (reason === "archiving") manager.setWorkspaceArchiveGuard(() => true);
          if (reason === "removing") spyOn(workspaceService, "isRemoving").mockReturnValue(true);
          expect(
            await manager.openWindow("workspace", "instance").catch((error: unknown) => error)
          ).toBeInstanceOf(Error);
          expect(windows.getWindow("workspace")).toBeNull();
          expect(manager.has("workspace")).toBe(false);
        }
      );
    }
  );

  test("persisted archive blocks stale requests but unarchiving allows a fresh viewer", async () => {
    await withWindowHarness(async ({ manager, config }) => {
      const workspace = {
        id: "workspace",
        path: "/tmp/project/workspace",
        archivedAt: "2026-01-01T00:00:00.000Z",
      };
      await config.editConfig((current) => {
        current.projects.set("/tmp/project-1", { workspaces: [workspace] });
        return current;
      });
      await manager.close("workspace");
      expect(
        await manager.openWindow("workspace", "stale").catch((error: unknown) => error)
      ).toBeInstanceOf(Error);
      await config.editConfig((current) => {
        current.projects.set("/tmp/project-1", {
          workspaces: [{ ...workspace, unarchivedAt: "2026-01-02T00:00:00.000Z" }],
        });
        return current;
      });
      expect(await manager.openWindow("workspace", "fresh")).toEqual({ instanceId: "fresh" });
    });
  });

  test("returns the actual instance and guards stale closes", async () => {
    await withWindowHarness(async ({ manager }) => {
      expect(await manager.openWindow("workspace", "first")).toEqual({ instanceId: "first" });
      expect(await manager.openWindow("workspace", "second")).toEqual({ instanceId: "first" });
      expect(manager.has("workspace")).toBe(true);
      await manager.closeWindow("workspace", "second");
      expect(manager.getWindow("workspace")).toEqual({ instanceId: "first" });
      await manager.closeWindow("workspace", "first");
      expect(manager.getWindow("workspace")).toBeNull();
      expect(manager.has("workspace")).toBe(false);
    });
  });

  test.each(["workspace", "all", "instance", "archive", "remove"] as const)(
    "%s teardown during capability lookup cannot resurrect a window",
    async (teardown) => {
      await withWindowHarness(async ({ manager, windows, workspaceService }) => {
        const capability = await manager.getCapability("workspace");
        const lookup = deferred();
        spyOn(manager, "getCapability").mockImplementationOnce(async () => {
          await lookup.promise;
          return capability;
        });
        const pending = manager
          .openWindow("workspace", "instance")
          .catch((error: unknown) => error);
        expect(manager.has("workspace")).toBe(true);
        if (teardown === "workspace") await manager.close("workspace");
        if (teardown === "all") await manager.closeAll();
        if (teardown === "instance") await manager.closeWindow("workspace", "instance");
        if (teardown === "archive") manager.setWorkspaceArchiveGuard(() => true);
        if (teardown === "remove") spyOn(workspaceService, "isRemoving").mockReturnValue(true);
        lookup.resolve();
        expect(await pending).toBeInstanceOf(Error);
        expect(windows.getWindow("workspace")).toBeNull();
        expect(manager.has("workspace")).toBe(false);
      });
    }
  );

  test("a stale close does not cancel another instance's pending open", async () => {
    await withWindowHarness(async ({ manager }) => {
      const capability = await manager.getCapability("workspace");
      const lookup = deferred();
      spyOn(manager, "getCapability").mockImplementationOnce(async () => {
        await lookup.promise;
        return capability;
      });
      const pending = manager.openWindow("workspace", "new");
      await manager.closeWindow("workspace", "old");
      lookup.resolve();
      expect(await pending).toEqual({ instanceId: "new" });
    });
  });

  test.each(["owner", "child"])(
    "closing %s cancels a borrower's pending viewer without blocking isolated viewers",
    async (closedId) => {
      await withWindowHarness(async ({ manager, config }) => {
        await registerSharedWorkspaces(config);
        const capability = await manager.getCapability("child");
        const lookup = deferred();
        spyOn(manager, "getCapability").mockImplementationOnce(async () => {
          await lookup.promise;
          return capability;
        });
        const opening = manager.openWindow("child", "borrowed").catch((error: unknown) => error);
        expect(manager.has("child")).toBe(true);
        expect(manager.has("owner")).toBe(true);
        await manager.close(closedId);
        lookup.resolve();
        expect(await opening).toBeInstanceOf(Error);
        expect(manager.getWindow("child")).toBeNull();
        expect(manager.has("owner")).toBe(false);
        await manager.openWindow("child", "fresh");
        expect(manager.has("owner")).toBe(true);
        await manager.openWindow("isolated", "isolated-viewer");
        await manager.close("owner");
        expect(manager.getWindow("child")).toBeNull();
        expect(manager.getWindow("isolated")).toEqual({ instanceId: "isolated-viewer" });
      });
    }
  );

  test.each(["owner", "child"])(
    "a guard on %s refuses a borrower popout before and after capability lookup",
    async (guardedId) => {
      await withWindowHarness(async ({ manager, config }) => {
        await registerSharedWorkspaces(config);
        manager.setWorkspaceArchiveGuard((id) => id === guardedId);
        expect(
          await manager.openWindow("child", "blocked").catch((error: unknown) => error)
        ).toBeInstanceOf(Error);
        manager.setWorkspaceArchiveGuard(() => false);
        const opening = manager.openWindow("child", "racing").catch((error: unknown) => error);
        manager.setWorkspaceArchiveGuard((id) => id === guardedId);
        expect(await opening).toBeInstanceOf(Error);
        expect(manager.getWindow("child")).toBeNull();
      });
    }
  );

  test("a changed owner during capability lookup cannot retarget a pending viewer", async () => {
    await withWindowHarness(async ({ manager, config }) => {
      await registerSharedWorkspaces(config);
      const capability = await manager.getCapability("child");
      const lookup = deferred();
      spyOn(manager, "getCapability").mockImplementationOnce(async () => {
        await lookup.promise;
        return capability;
      });
      const opening = manager.openWindow("child", "stale").catch((error: unknown) => error);
      await config.editConfig((current) => {
        const child = current.projects
          .get("/tmp/project-1")
          ?.workspaces.find((entry) => entry.id === "child");
        if (!child) throw new Error("Missing child");
        delete child.taskDesktopOwnerWorkspaceId;
        return current;
      });
      lookup.resolve();
      expect(await opening).toBeInstanceOf(Error);
      expect(manager.getWindow("child")).toBeNull();
    });
  });

  test("closing an idle workspace does not leave a tombstone that blocks reopening", async () => {
    await withWindowHarness(async ({ manager }) => {
      expect(manager.has("workspace")).toBe(false);
      const firstClose = manager.close("workspace");
      expect(manager.close("workspace")).toBe(firstClose);
      await firstClose;
      expect(await manager.openWindow("workspace", "first")).toEqual({ instanceId: "first" });
      await manager.closeWindow("workspace", "first");

      const secondClose = manager.close("workspace");
      expect(secondClose).not.toBe(firstClose);
      await secondClose;
      expect(await manager.openWindow("workspace", "second")).toEqual({ instanceId: "second" });
    });
  });

  test("closeAll latches admission and waits for viewer cleanup before bridge revocation", async () => {
    await withWindowHarness(async ({ manager, windows }) => {
      await manager.openWindow("workspace", "viewer");
      const started = deferred();
      const released = deferred();
      const originalClose = windows.closeAll.bind(windows);
      const close = spyOn(windows, "closeAll").mockImplementation(async () => {
        started.resolve();
        await released.promise;
        await originalClose();
      });
      const revoked: Array<string | null> = [];
      const unsubscribe = manager.onWorkspaceClose((id) => revoked.push(id));
      const closing = manager.closeAll();
      try {
        expect(manager.closeAll()).toBe(closing);
        await started.promise;
        expect(revoked).toEqual([]);
        expect(manager.getWindow("workspace")).toEqual({ instanceId: "viewer" });
        expect(
          await manager.openWindow("one", "late").catch((error: unknown) => error)
        ).toBeInstanceOf(Error);
      } finally {
        released.resolve();
        await closing;
        unsubscribe();
        close.mockRestore();
      }
      expect(revoked).toEqual([null]);
      expect(manager.getWindow("workspace")).toBeNull();
    });
  });

  test("workspace cleanup closes its viewer and shutdown prevents subsequent opens", async () => {
    await withWindowHarness(async ({ manager }) => {
      await manager.openWindow("one", "one");
      await manager.openWindow("two", "two");
      const closing = manager.close("one");
      expect(manager.close("one")).toBe(closing);
      expect(manager.getWindow("one")).toEqual({ instanceId: "one" });
      expect(manager.getWindow("two")).toEqual({ instanceId: "two" });
      expect(
        await manager.openWindow("one", "racing").catch((error: unknown) => error)
      ).toBeInstanceOf(Error);
      await closing;
      await manager.closeAll();
      expect(manager.getWindow("two")).toBeNull();
      expect(
        await manager.openWindow("one", "late").catch((error: unknown) => error)
      ).toBeInstanceOf(Error);
    });
  });
});

describe("DesktopSessionManager", () => {
  test("shares startup, screenshots, actions and bootstrap while legacy children stay isolated", async () => {
    await withDesktopManagerHarness(async ({ tempDir, config }) => {
      if (process.platform === "win32") return;
      await registerSharedWorkspaces(config);
      const actionRecordPath = path.join(tempDir, "shared-actions.json");
      await installPortableDesktopShim({
        rootDir: tempDir,
        config: {
          startupInfo: createStartupInfo({ display: 20, vncPort: 5910, geometry: "1024x768" }),
          actionRecordPath,
        },
      });
      process.env.PATH = "";
      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() => Promise.resolve(null)),
      });
      const windows = createWindowManager();
      manager.setDesktopWindowManager(windows);
      const closeNotifications: Array<string | null> = [];
      const unsubscribeClose = manager.onWorkspaceClose((id) => closeNotifications.push(id));
      const tokens = new DesktopTokenManager();
      const start = spyOn(PortableDesktopSession.prototype, "start");
      const serverService = {
        getServerInfo: () => ({
          baseUrl: "http://127.0.0.1:1234",
          token: "test",
          bindHost: "127.0.0.1",
          port: 1234,
          networkBaseUrls: [],
        }),
      };
      try {
        const [parentSession, childSession] = await Promise.all([
          manager.ensureStarted("owner"),
          manager.ensureStarted("child"),
        ]);
        expect(childSession).toBe(parentSession);
        expect(start).toHaveBeenCalledTimes(1);
        expect(manager.has("child")).toBe(false);
        await manager.openWindow("owner", "owner-viewer");
        await manager.openWindow("child", "child-viewer");
        await manager.closeWindow("child", "child-viewer");
        expect(parentSession.isAlive()).toBe(true);
        expect(closeNotifications).toEqual([]);
        await manager.openWindow("child", "child-reopened");
        expect(await manager.screenshot("child")).toEqual(await manager.screenshot("owner"));
        expect(await manager.action("child", "key_press", { key: "Return" })).toEqual({
          success: true,
        });
        expect(manager.action("owner", "key_press", { key: "Return" })).rejects.toThrow(
          "controlled by"
        );
        const recorded: unknown = JSON.parse(await fs.readFile(actionRecordPath, "utf8"));
        assertPortableDesktopRecordedCommands(recorded);
        expect(recorded.length).toBe(1);
        expect(recorded[0]?.stateFile).toContain("owner");
        const releaseInput = deferred();
        const cleanupStarted = deferred();
        const originalClose = windows.closeWorkspace.bind(windows);
        const closeViewer = spyOn(windows, "closeWorkspace").mockImplementationOnce(async (id) => {
          cleanupStarted.resolve();
          await releaseInput.promise;
          await originalClose(id);
        });
        const closingChild = manager.close("child");
        try {
          expect(manager.close("child")).toBe(closingChild);
          await cleanupStarted.promise;
          expect(parentSession.isAlive()).toBe(true);
          expect(closeNotifications).toEqual([]);
          expect(manager.getWindow("child")).toEqual({ instanceId: "child-reopened" });
          expect(
            await manager.openWindow("child", "racing").catch((error: unknown) => error)
          ).toBeInstanceOf(Error);
          expect(
            await manager.ensureStarted("child").catch((error: unknown) => error)
          ).toBeInstanceOf(Error);
        } finally {
          releaseInput.resolve();
          await closingChild;
          closeViewer.mockRestore();
        }
        expect(parentSession.isAlive()).toBe(true);
        expect(manager.getWindow("child")).toBeNull();
        expect(manager.getWindow("owner")).toEqual({ instanceId: "owner-viewer" });
        expect(closeNotifications).toEqual(["child"]);
        await manager.openWindow("child", "child-after-cleanup");

        const isolated = await manager.ensureStarted("isolated");
        expect(isolated).not.toBe(parentSession);
        expect(start).toHaveBeenCalledTimes(2);
        await manager.openWindow("isolated", "isolated-viewer");
        const bootstrap = await getDesktopBootstrap(
          { desktopSessionManager: manager, desktopTokenManager: tokens, serverService },
          "child"
        );
        expect(bootstrap.capability.available).toBe(true);
        if (!bootstrap.capability.available || !bootstrap.token)
          throw new Error("Expected bootstrap");
        expect(bootstrap.capability.sharedDesktop).toEqual({
          ownerWorkspaceId: "owner",
          ownerName: "owner-name",
        });
        const ownerSessionId = parentSession.getSessionInfo().sessionId;
        if (!ownerSessionId) throw new Error("Expected owner session ID");
        expect(tokens.validate(bootstrap.token)).toEqual({
          workspaceId: "child",
          sessionId: ownerSessionId,
          viewerId: null,
        });
        expect(tokens.validate(bootstrap.token)).toBeNull();
        expect(manager.getLiveSessionConnection("child")).toEqual(
          manager.getLiveSessionConnection("owner")
        );
        expect(manager.getLiveSessionConnection("child")?.ownerWorkspaceId).toBe("owner");

        await config.editConfig((current) => {
          const child = current.projects
            .get("/tmp/project-1")
            ?.workspaces.find((entry) => entry.id === "child");
          if (!child) throw new Error("Missing child");
          child.archivedAt = "2026-09-01T00:00:00Z";
          return current;
        });
        expect(manager.getLiveSessionConnection("child")).toBeNull();
        expect(manager.getLiveSessionConnection("owner")).not.toBeNull();
        expect(await manager.getCapability("child")).toEqual({
          available: false,
          reason: "startup_failed",
        });
        await manager.close("owner");
        expect(manager.getWindow("owner")).toBeNull();
        expect(manager.getWindow("child")).toBeNull();
        expect(manager.getWindow("isolated")).toEqual({ instanceId: "isolated-viewer" });
        expect(isolated.isAlive()).toBe(true);
        expect(closeNotifications).toEqual(["child", "owner"]);
        await manager.closeAll();
        expect(manager.getWindow("isolated")).toBeNull();
        expect(closeNotifications).toEqual(["child", "owner", null]);
      } finally {
        unsubscribeClose();
        start.mockRestore();
        tokens.dispose();
        await manager.closeAll();
      }
    });
  });

  for (const archivedId of ["owner", "child"]) {
    test(`rechecks ${archivedId} after a shared startup without leaking or closing another owner's session`, async () => {
      await withDesktopManagerHarness(async ({ tempDir, config }) => {
        if (process.platform === "win32") return;
        await registerSharedWorkspaces(config);
        await installPortableDesktopShim({
          rootDir: tempDir,
          config: {
            startupInfo: createStartupInfo({ display: 21, vncPort: 5911, geometry: "1024x768" }),
          },
        });
        process.env.PATH = "";
        const manager = new DesktopSessionManager({
          config,
          experimentsService: createExperimentsService(true),
          workspaceService: createWorkspaceService(() => Promise.resolve(null)),
        });
        const started = deferred();
        const release = deferred();
        // eslint-disable-next-line @typescript-eslint/unbound-method -- call below supplies the session under test.
        const originalStart = PortableDesktopSession.prototype.start;
        const start = spyOn(PortableDesktopSession.prototype, "start").mockImplementation(
          async function (this: PortableDesktopSession) {
            await originalStart.call(this);
            started.resolve();
            await release.promise;
          }
        );
        const startup = manager.ensureStarted("child").catch((error: unknown) => error);
        try {
          await started.promise;
          expect(manager.has("owner")).toBe(true);
          expect(manager.has("child")).toBe(false);
          await config.editConfig((current) => {
            const entry = current.projects
              .get("/tmp/project-1")
              ?.workspaces.find((entry) => entry.id === archivedId);
            if (!entry) throw new Error("Missing workspace");
            entry.archivedAt = "2026-09-01T00:00:00Z";
            return current;
          });
          release.resolve();
          expect(String(await startup)).toContain("archived");
          expect(manager.has("owner")).toBe(archivedId !== "owner");
          expect(manager.getLiveSessionConnection("child")).toBeNull();
          if (archivedId === "owner") {
            expect(
              await fs.readdir(
                path.join(tempDir, "cache", DESKTOP_DEFAULTS.CACHE_DIR_NAME, "sessions")
              )
            ).toEqual([]);
          }
        } finally {
          release.resolve();
          await startup;
          start.mockRestore();
          await manager.closeAll();
        }
      });
    });
  }

  test("established viewers retain a release channel during admission but not durable invalidation", async () => {
    if (process.platform === "win32") return;
    await withWindowHarness(async ({ manager, config }) => {
      await registerSharedWorkspaces(config);
      await manager.ensureStarted("owner");
      const live = manager.getLiveSessionConnection("child");
      expect(live).not.toBeNull();
      manager.setWorkspaceArchiveGuard((id) => id === "child");
      expect(manager.getLiveSessionConnection("child")).toBeNull();
      expect(manager.getLiveSessionConnection("child", "established")).toEqual(live);

      await config.editConfig((current) => {
        const child = current.projects
          .get("/tmp/project-1")
          ?.workspaces.find((entry) => entry.id === "child");
        if (!child) throw new Error("Missing child");
        child.archivedAt = "2026-09-04T12:00:00Z";
        return current;
      });
      expect(manager.getLiveSessionConnection("child", "established")).toBeNull();
      expect(manager.getLiveSessionConnection("owner")).toEqual(live);
    });
  });

  test("rejects requester and owner archive guards before shared startup", async () => {
    await withDesktopManagerHarness(async ({ config }) => {
      await registerSharedWorkspaces(config);
      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() => Promise.resolve(null)),
      });
      for (const id of ["owner", "child"]) {
        manager.setWorkspaceArchiveGuard((candidate) => candidate === id);
        expect(manager.ensureStarted("child")).rejects.toThrow("being archived");
        expect(manager.has("owner")).toBe(false);
      }
    });
  });

  for (const event of ["error", "close"] as const) {
    test(`config watcher ${event} fails closed once and explicit disposal does not`, async () => {
      await withDesktopManagerHarness(({ config, tempDir }) => {
        const manager = new DesktopSessionManager({
          config,
          experimentsService: createExperimentsService(true),
          workspaceService: createWorkspaceService(() => Promise.resolve(null)),
        });
        const watcher = nodeFs.watch(tempDir, { persistent: false });
        const watch = spyOn(nodeFs, "watch").mockReturnValue(watcher);
        const failures: unknown[] = [];
        const stop = manager.watchWorkspaceConfig(
          () => undefined,
          (error) => failures.push(error)
        );
        try {
          watcher.emit(event, new Error("watch lost"));
          expect(failures).toHaveLength(1);
          stop();
          expect(failures).toHaveLength(1);
        } finally {
          stop();
          watch.mockRestore();
        }

        const cleanWatch = nodeFs.watch(tempDir, { persistent: false });
        const cleanSpy = spyOn(nodeFs, "watch").mockReturnValue(cleanWatch);
        try {
          const dispose = manager.watchWorkspaceConfig(
            () => undefined,
            (error) => failures.push(error)
          );
          dispose();
          cleanWatch.emit("close");
          expect(failures).toHaveLength(1);
        } finally {
          cleanWatch.close();
          cleanSpy.mockRestore();
        }
        return Promise.resolve();
      });
    });
  }

  test("reports machine-level prereqs without consulting workspace metadata when the binary is missing", async () => {
    await withDesktopManagerHarness(async ({ config }) => {
      process.env.PATH = "";

      let workspaceInfoCalls = 0;
      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(false),
        workspaceService: createWorkspaceService((_workspaceId) => {
          workspaceInfoCalls += 1;
          return Promise.resolve(createWorkspaceMetadata({ type: "local" }));
        }),
      });

      expect(manager.getPrereqStatus()).toEqual({
        available: false,
        reason: "binary_not_found",
      });
      expect(workspaceInfoCalls).toBe(0);
      await manager.closeAll();
    });
  });

  test("reports machine-level prereqs as available when the binary exists", async () => {
    await withDesktopManagerHarness(async ({ tempDir, config }) => {
      if (process.platform === "win32") {
        return;
      }

      await installPortableDesktopShim({
        rootDir: tempDir,
        config: {
          startupInfo: createStartupInfo({
            display: 9,
            vncPort: 5899,
            geometry: "1024x768",
            sessionId: "manager-prereq",
          }),
        },
      });
      process.env.PATH = "";

      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(false),
        workspaceService: createWorkspaceService(() =>
          Promise.resolve(createWorkspaceMetadata({ type: "local" }))
        ),
      });

      expect(manager.getPrereqStatus()).toEqual({ available: true });
      await manager.closeAll();
    });
  });

  test("returns disabled capability when the experiment is off", async () => {
    await withDesktopManagerHarness(async ({ config }) => {
      let workspaceInfoCalls = 0;
      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(false),
        workspaceService: createWorkspaceService((_workspaceId) => {
          workspaceInfoCalls += 1;
          return Promise.resolve(createWorkspaceMetadata({ type: "local" }));
        }),
      });

      expect(await manager.getCapability("workspace-disabled")).toEqual({
        available: false,
        reason: "disabled",
      });
      expect(workspaceInfoCalls).toBe(0);
      await manager.closeAll();
    });
  });

  test("returns unsupported_platform capability when the platform is not supported", async () => {
    await withDesktopManagerHarness(async ({ config }) => {
      Object.defineProperty(process, "platform", {
        value: "freebsd",
        configurable: true,
        writable: false,
        enumerable: true,
      });

      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() =>
          Promise.resolve(createWorkspaceMetadata({ type: "local" }))
        ),
      });

      expect(await manager.getCapability("workspace-platform")).toEqual({
        available: false,
        reason: "unsupported_platform",
      });
      await manager.closeAll();
    });
  });

  test("returns unsupported_runtime capability for SSH workspaces", async () => {
    await withDesktopManagerHarness(async ({ config }) => {
      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() =>
          Promise.resolve(
            createWorkspaceMetadata({ type: "ssh", host: "example.com", srcBaseDir: "~/mux" })
          )
        ),
      });

      expect(await manager.getCapability("workspace-ssh")).toEqual({
        available: false,
        reason: "unsupported_runtime",
      });
      await manager.closeAll();
    });
  });

  test("returns binary_not_found capability when the PortableDesktop binary is unavailable", async () => {
    await withDesktopManagerHarness(async ({ config }) => {
      process.env.PATH = "";

      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() =>
          Promise.resolve(createWorkspaceMetadata({ type: "local" }))
        ),
      });

      expect(await manager.getCapability("workspace-missing-binary")).toEqual({
        available: false,
        reason: "binary_not_found",
      });
      await manager.closeAll();
    });
  });

  test("returns available capability for supported local and worktree runtimes without starting a session", async () => {
    await withDesktopManagerHarness(async ({ tempDir, config }) => {
      if (process.platform === "win32") {
        return;
      }

      const startupStateFile = path.join(tempDir, "manager-capability-state.json");
      await installPortableDesktopShim({
        rootDir: tempDir,
        config: {
          startupInfo: createStartupInfo({
            display: 10,
            vncPort: 5900,
            geometry: "1024x768",
            stateFile: startupStateFile,
            sessionId: "manager-capability",
          }),
        },
      });
      process.env.PATH = "";

      const workspaceInfos = new Map<string, FrontendWorkspaceMetadata>([
        ["workspace-local", createWorkspaceMetadata({ type: "local" })],
        [
          "workspace-worktree",
          createWorkspaceMetadata({ type: "worktree", srcBaseDir: "/tmp/worktrees" }),
        ],
      ]);

      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService((workspaceId) =>
          Promise.resolve(workspaceInfos.get(workspaceId) ?? null)
        ),
      });

      expect(await manager.getCapability("workspace-local")).toEqual({
        available: true,
        width: 1024,
        height: 768,
        sessionId: "desktop:workspace-local",
      });
      expect(await manager.getCapability("workspace-worktree")).toEqual({
        available: true,
        width: 1024,
        height: 768,
        sessionId: "desktop:workspace-worktree",
      });

      const sessionsAfterCapabilityChecks: unknown = Reflect.get(manager, "sessions");
      assertSessionMap(sessionsAfterCapabilityChecks);
      expect(sessionsAfterCapabilityChecks.size).toBe(0);

      let stateFileCreated = true;
      try {
        await fs.access(startupStateFile);
      } catch {
        stateFileCreated = false;
      }
      expect(stateFileCreated).toBe(false);
      await manager.closeAll();
    });
  });

  test("reuses a live session across ensureStarted calls", async () => {
    await withDesktopManagerHarness(async ({ tempDir, config }) => {
      if (process.platform === "win32") {
        return;
      }

      await installPortableDesktopShim({
        rootDir: tempDir,
        config: {
          startupInfo: createStartupInfo({
            display: 11,
            vncPort: 5901,
            geometry: "1024x768",
            sessionId: "manager-reuse",
          }),
        },
      });
      process.env.PATH = "";

      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() =>
          Promise.resolve(createWorkspaceMetadata({ type: "local" }))
        ),
      });

      const firstSession = await manager.ensureStarted("workspace-reuse");
      const secondSession = await manager.ensureStarted("workspace-reuse");

      expect(secondSession).toBe(firstSession);
      manager.setDesktopWindowManager(createWindowManager());
      await manager.openWindow("workspace-reuse", "viewer");
      await manager.closeWindow("workspace-reuse", "viewer");
      expect(manager.getWindow("workspace-reuse")).toBeNull();
      // Viewer handoff must not restart or terminate the underlying desktop session.
      expect(firstSession.isAlive()).toBe(true);
      expect(await manager.ensureStarted("workspace-reuse")).toBe(firstSession);
      await manager.closeAll();
    });
  });

  test("ensureStarted refuses while the workspace is being archived", async () => {
    await withDesktopManagerHarness(async ({ config }) => {
      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() =>
          Promise.resolve(createWorkspaceMetadata({ type: "local" }))
        ),
      });
      // Archive admission pairing: the gate arms this guard before its activity snapshot, so a
      // startup entering afterwards must refuse instead of publishing a hidden desktop session.
      manager.setWorkspaceArchiveGuard(() => true);

      try {
        await manager.ensureStarted("workspace-archiving");
        expect.unreachable("ensureStarted must refuse while the workspace is being archived");
      } catch (error) {
        expect(String(error)).toContain("being archived");
      }
      expect(manager.has("workspace-archiving")).toBe(false);
    });
  });

  test("has() ignores sessions whose process already exited", async () => {
    await withDesktopManagerHarness(async ({ tempDir, config }) => {
      if (process.platform === "win32") {
        return;
      }

      await installPortableDesktopShim({
        rootDir: tempDir,
        config: {
          startupInfo: createStartupInfo({
            display: 14,
            vncPort: 5904,
            geometry: "1024x768",
            sessionId: "manager-dead",
          }),
        },
      });
      process.env.PATH = "";

      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() =>
          Promise.resolve(createWorkspaceMetadata({ type: "local" }))
        ),
      });

      const session = await manager.ensureStarted("workspace-dead");
      expect(manager.has("workspace-dead")).toBe(true);

      // Simulate a crash/exit that bypassed manager cleanup: the session dies but its map entry
      // lingers until the next ensureStarted()/close() touches it. Archive activity gates must
      // not treat that stale entry as live work.
      await session.close();
      const sessions: unknown = Reflect.get(manager, "sessions");
      assertSessionMap(sessions);
      expect(sessions.has("workspace-dead")).toBe(true);
      expect(manager.has("workspace-dead")).toBe(false);

      await manager.closeAll();
    });
  });

  test("closes individual sessions and clears all tracked sessions", async () => {
    await withDesktopManagerHarness(async ({ tempDir, config }) => {
      if (process.platform === "win32") {
        return;
      }

      await installPortableDesktopShim({
        rootDir: tempDir,
        config: {
          startupInfo: createStartupInfo({
            display: 12,
            vncPort: 5902,
            geometry: "1024x768",
            sessionId: "manager-close",
          }),
        },
      });
      process.env.PATH = "";

      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() =>
          Promise.resolve(createWorkspaceMetadata({ type: "local" }))
        ),
      });

      const firstSession = await manager.ensureStarted("workspace-close-one");
      await manager.ensureStarted("workspace-close-two");

      const sessionsBeforeClose: unknown = Reflect.get(manager, "sessions");
      assertSessionMap(sessionsBeforeClose);
      expect(sessionsBeforeClose.size).toBe(2);

      await manager.close("workspace-close-one");
      expect(firstSession.isAlive()).toBe(false);

      const sessionsAfterClose: unknown = Reflect.get(manager, "sessions");
      assertSessionMap(sessionsAfterClose);
      expect(sessionsAfterClose.size).toBe(1);

      await manager.closeAll();
      const sessionsAfterCloseAll: unknown = Reflect.get(manager, "sessions");
      assertSessionMap(sessionsAfterCloseAll);
      expect(sessionsAfterCloseAll.size).toBe(0);
    });
  });

  test("passes pixel coordinates through unchanged before dispatching actions", async () => {
    await withDesktopManagerHarness(async ({ tempDir, config }) => {
      if (process.platform === "win32") {
        return;
      }

      const actionRecordPath = path.join(tempDir, "manager-action-record.json");
      await installPortableDesktopShim({
        rootDir: tempDir,
        config: {
          startupInfo: createStartupInfo({
            display: 13,
            vncPort: 5903,
            geometry: "1024x768",
            sessionId: "manager-action",
          }),
          actionRecordPath,
        },
      });
      process.env.PATH = "";

      const manager = new DesktopSessionManager({
        config,
        experimentsService: createExperimentsService(true),
        workspaceService: createWorkspaceService(() =>
          Promise.resolve(createWorkspaceMetadata({ type: "local" }))
        ),
      });

      expect(
        await manager.action("workspace-action", "drag", {
          startX: 1,
          startY: 1,
          endX: 10,
          endY: 20,
        })
      ).toEqual({ success: true });

      const actionRecords: unknown = JSON.parse(await fs.readFile(actionRecordPath, "utf8"));
      assertPortableDesktopRecordedCommands(actionRecords);
      expect(actionRecords.map(({ stateFile: _stateFile, ...record }) => record)).toEqual([
        {
          command: "mouse",
          subcommand: "move",
          args: ["1", "1"],
        },
        {
          command: "mouse",
          subcommand: "down",
          args: [],
        },
        {
          command: "mouse",
          subcommand: "move",
          args: ["10", "20"],
        },
        {
          command: "mouse",
          subcommand: "up",
          args: [],
        },
      ]);
      const [firstActionRecord, ...remainingActionRecords] = actionRecords;
      expect(firstActionRecord.stateFile).toContain("workspace-action");
      await fs.access(firstActionRecord.stateFile);
      for (const actionRecord of remainingActionRecords) {
        expect(actionRecord.stateFile).toBe(firstActionRecord.stateFile);
      }

      await manager.closeAll();
      let stateFileRemoved = false;
      try {
        await fs.access(firstActionRecord.stateFile);
      } catch {
        stateFileRemoved = true;
      }
      expect(stateFileRemoved).toBe(true);
    });
  });
});
