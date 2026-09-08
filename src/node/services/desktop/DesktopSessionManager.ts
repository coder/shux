import { randomUUID } from "node:crypto";
import { asyncIterableFromSubscription } from "@/common/utils/asyncEventIterator";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DesktopWindowManager } from "@/desktop/desktopWindowManager";
import { DESKTOP_DEFAULTS, DESKTOP_VIEWER_RELEASE_TIMEOUT_MS } from "@/common/constants/desktop";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type {
  DesktopActionResult,
  DesktopActionType,
  DesktopCapability,
  DesktopPrereqStatus,
  DesktopScreenshotResult,
  DesktopViewerEvent,
} from "@/common/types/desktop";
import type { Config } from "@/node/config";
import type { ExperimentsService } from "@/node/services/experimentsService";
import { log } from "@/node/services/log";
import assert from "node:assert/strict";
import type { WorkspaceService } from "@/node/services/workspaceService";
import { DesktopInputCoordinator, UnsupportedDesktopRuntimeError } from "./DesktopInputCoordinator";
import {
  PortableDesktopBinaryNotFoundError,
  PortableDesktopSession,
} from "./PortableDesktopSession";

interface DesktopViewerRegistration {
  viewerId: string;
  workspaceId: string;
  ownerWorkspaceId: string;
  push: (event: DesktopViewerEvent) => void;
  release?: Promise<void>;
  acknowledge?: () => void;
}

export class DesktopSessionManager {
  private readonly viewers = new Map<string, DesktopViewerRegistration>();
  private readonly sessions = new Map<string, PortableDesktopSession>();
  private readonly startupPromises = new Map<string, Promise<PortableDesktopSession>>();
  private readonly inputCoordinator: DesktopInputCoordinator;
  private readonly closeListeners = new Set<(workspaceId: string | null) => void>();
  private windowManager:
    | Pick<
        DesktopWindowManager,
        "openWindow" | "closeWindow" | "getWindow" | "closeWorkspace" | "closeAll"
      >
    | undefined;
  private readonly pendingWindowOpens = new Set<{
    workspaceId: string;
    instanceId: string;
    ownerWorkspaceId: string;
  }>();
  private readonly windowOwners = new Map<string, string>();
  private readonly closingWorkspaces = new Map<string, Promise<void>>();
  private disposed = false;
  private closeAllPromise: Promise<void> | undefined;

  watchViewer(workspaceId: string, signal?: AbortSignal): AsyncGenerator<DesktopViewerEvent> {
    return asyncIterableFromSubscription<DesktopViewerEvent>({
      signal,
      subscribe: (push) => {
        // Admission and registration share one synchronous block: cleanup either sees this
        // viewer in its snapshot or rejects its registration before sending ready.
        const target = this.resolveActiveTarget(workspaceId);
        const viewer: DesktopViewerRegistration = {
          viewerId: randomUUID(),
          workspaceId,
          ownerWorkspaceId: target.ownerWorkspaceId,
          push,
        };
        this.viewers.set(viewer.viewerId, viewer);
        push({ type: "ready", viewerId: viewer.viewerId });
        // Deregister even if the generator is paused at a yield when the transport aborts.
        // Losing the subscription is not proof that held remote input was released:
        // a pending teardown still waits for its deadline rather than resolving here.
        const unsubscribe = () => {
          this.viewers.delete(viewer.viewerId);
        };
        signal?.addEventListener("abort", unsubscribe, { once: true });
        return () => {
          signal?.removeEventListener("abort", unsubscribe);
          unsubscribe();
        };
      },
    });
  }

  acknowledgeViewerRelease(viewerId: string): void {
    this.viewers.get(viewerId)?.acknowledge?.();
  }

  private releaseViewer(viewer: DesktopViewerRegistration): Promise<void> {
    viewer.release ??= new Promise<void>((resolve) => {
      const complete = () => {
        clearTimeout(timeout);
        this.viewers.delete(viewer.viewerId);
        viewer.acknowledge = undefined;
        resolve();
      };
      const timeout = setTimeout(complete, DESKTOP_VIEWER_RELEASE_TIMEOUT_MS);
      timeout.unref?.();
      viewer.acknowledge = complete;
      viewer.push({ type: "release", viewerId: viewer.viewerId });
    });
    return viewer.release;
  }

  setDesktopWindowManager(manager: NonNullable<DesktopSessionManager["windowManager"]>): void {
    this.windowManager = manager;
  }

  async openWindow(workspaceId: string, instanceId: string): Promise<{ instanceId: string }> {
    assert(workspaceId.length > 0 && instanceId.length > 0, "Desktop window IDs must be non-empty");
    const manager = this.windowManager;
    if (!manager) throw new Error("Desktop windows are only available in Electron");
    const target = this.resolveActiveTarget(workspaceId);

    // Reserve before capability lookup yields. Teardown cancels these reservations, and archive
    // admission must see them as activity even before an Electron window exists.
    const request = { workspaceId, instanceId, ownerWorkspaceId: target.ownerWorkspaceId };
    this.pendingWindowOpens.add(request);
    try {
      const capability = await this.getCapability(workspaceId);
      if (!capability.available) {
        throw new Error(`Desktop is unavailable: ${capability.reason}`);
      }
      if (!this.pendingWindowOpens.has(request))
        throw new Error("Desktop window opening was canceled");
      if (this.resolveActiveTarget(workspaceId).ownerWorkspaceId !== target.ownerWorkspaceId) {
        throw new Error(`Desktop target changed while opening a window for ${workspaceId}`);
      }
      // The viewer belongs to the requester, but closing its shared owner revokes it too.
      this.windowOwners.set(workspaceId, target.ownerWorkspaceId);
      return await manager.openWindow(workspaceId, instanceId);
    } finally {
      this.pendingWindowOpens.delete(request);
      if (manager.getWindow(workspaceId) === null) this.windowOwners.delete(workspaceId);
    }
  }

  getWindow(workspaceId: string): { instanceId: string } | null {
    const window = this.windowManager?.getWindow(workspaceId) ?? null;
    if (window === null) this.windowOwners.delete(workspaceId);
    return window;
  }

  closeWindow(workspaceId: string, instanceId: string): Promise<void> {
    for (const request of this.pendingWindowOpens) {
      if (request.workspaceId === workspaceId && request.instanceId === instanceId) {
        this.pendingWindowOpens.delete(request);
      }
    }
    return this.windowManager?.closeWindow(workspaceId, instanceId) ?? Promise.resolve();
  }

  getSessionCount(): number {
    const live = new Set(this.startupPromises.keys());
    for (const [workspaceId, session] of this.sessions)
      if (session.isAlive()) live.add(workspaceId);
    return live.size;
  }

  private workspaceArchiveGuard: ((workspaceId: string) => boolean) | undefined;

  /**
   * Archive admission pairing (mirrors TerminalService.setWorkspaceArchiveGuard): the guard
   * reports workspaces an agent-driven archive is currently gating, and ensureStarted checks it
   * in the same synchronous block that reserves the startup promise — an archive gate armed
   * first refuses the startup; a reservation registered first is observed by that gate via
   * has().
   */
  setWorkspaceArchiveGuard(guard: (workspaceId: string) => boolean): void {
    this.workspaceArchiveGuard = guard;
  }

  constructor(
    private readonly deps: {
      config: Config;
      experimentsService: ExperimentsService;
      workspaceService: WorkspaceService;
      inputCoordinator?: DesktopInputCoordinator;
    }
  ) {
    this.inputCoordinator = deps.inputCoordinator ?? new DesktopInputCoordinator(deps.config);
  }

  resolveTarget(workspaceId: string) {
    const target = this.inputCoordinator.resolveTarget(workspaceId);
    for (const id of new Set([workspaceId, target.ownerWorkspaceId])) {
      if (this.workspaceArchiveGuard?.(id) === true) {
        throw new Error(
          `Workspace is being archived or removed: ${id}. Wait for cleanup to finish.`
        );
      }
    }
    return target;
  }

  // Keep config-based target discovery separate from admission to new sessions/viewers.
  private resolveActiveTarget(workspaceId: string) {
    const target = this.resolveTarget(workspaceId);
    if (
      this.disposed ||
      this.closingWorkspaces.has(workspaceId) ||
      this.closingWorkspaces.has(target.ownerWorkspaceId)
    ) {
      throw new Error("Desktop sessions are shutting down");
    }
    return target;
  }

  getPrereqStatus(): DesktopPrereqStatus {
    assert(
      this.deps.config.rootDir.length > 0,
      "DesktopSessionManager requires a non-empty rootDir"
    );

    if (!["linux", "darwin", "win32"].includes(process.platform)) {
      return { available: false, reason: "unsupported_platform" };
    }

    try {
      if (!PortableDesktopSession.checkAvailability(this.deps.config.rootDir)) {
        return { available: false, reason: "binary_not_found" };
      }

      return { available: true };
    } catch (error) {
      log.error("PortableDesktop prerequisite check failed during availability check", {
        error,
      });
      if (error instanceof PortableDesktopBinaryNotFoundError) {
        return { available: false, reason: "binary_not_found" };
      }
      return { available: false, reason: "startup_failed" };
    }
  }

  getCapability(workspaceId: string): Promise<DesktopCapability> {
    return Promise.resolve().then(() => {
      if (!this.deps.experimentsService.isExperimentEnabled(EXPERIMENT_IDS.PORTABLE_DESKTOP)) {
        return { available: false, reason: "disabled" };
      }

      let target;
      try {
        target = this.resolveTarget(workspaceId);
      } catch (error) {
        log.debug("PortableDesktop target unavailable", { workspaceId, error });
        return {
          available: false,
          reason:
            error instanceof UnsupportedDesktopRuntimeError
              ? "unsupported_runtime"
              : "startup_failed",
        };
      }

      const prereqStatus = this.getPrereqStatus();
      if (!prereqStatus.available) {
        return prereqStatus;
      }

      // Capability checks are used for agent listing and tool gating, so they must not
      // start a long-lived desktop session just to report whether PortableDesktop exists.
      return {
        available: true,
        width: DESKTOP_DEFAULTS.WIDTH,
        height: DESKTOP_DEFAULTS.HEIGHT,
        sessionId: `desktop:${target.ownerWorkspaceId}`,
        ...(target.ownerWorkspaceId !== workspaceId ? { sharedDesktop: target } : {}),
      };
    });
  }

  async ensureStarted(workspaceId: string): Promise<PortableDesktopSession> {
    const target = this.resolveActiveTarget(workspaceId);
    // Reserve the owner startup synchronously with both archive guards; has() stays owner-keyed.
    const session = await this.ensureOwnerStarted(target.ownerWorkspaceId);
    // A requester may disappear/archive while joining somebody else's startup. Reject that
    // request without closing the owner's desktop, which other requesters can still use.
    if (this.resolveActiveTarget(workspaceId).ownerWorkspaceId !== target.ownerWorkspaceId) {
      throw new Error(`Desktop target changed while starting for workspace ${workspaceId}`);
    }
    return session;
  }

  private async ensureOwnerStarted(workspaceId: string): Promise<PortableDesktopSession> {
    this.resolveActiveTarget(workspaceId);
    const existingSession = this.sessions.get(workspaceId);
    if (existingSession?.isAlive()) {
      return existingSession;
    }

    const existingStartup = this.startupPromises.get(workspaceId);
    if (existingStartup) {
      return existingStartup;
    }

    if (existingSession) {
      this.sessions.delete(workspaceId);
    }

    const session = new PortableDesktopSession({
      workspaceId,
      rootDir: this.deps.config.rootDir,
      width: DESKTOP_DEFAULTS.WIDTH,
      height: DESKTOP_DEFAULTS.HEIGHT,
    });

    let startupPromise: Promise<PortableDesktopSession> | null = null;
    const isCurrentStartupPromise = (): boolean =>
      startupPromise !== null && this.startupPromises.get(workspaceId) === startupPromise;

    startupPromise = (async (): Promise<PortableDesktopSession> => {
      try {
        await session.start();
        if (!isCurrentStartupPromise()) {
          await session.close();
          throw new Error(`PortableDesktop startup for workspace ${workspaceId} was superseded`);
        }
        // A user archive can persist while startup awaits; never publish a hidden session.
        try {
          const target = this.resolveTarget(workspaceId);
          if (target.ownerWorkspaceId !== workspaceId) {
            throw new Error(`Desktop owner changed while starting: ${workspaceId}`);
          }
        } catch (error) {
          await session.close();
          throw error;
        }
        this.sessions.set(workspaceId, session);
        return session;
      } catch (error) {
        this.sessions.delete(workspaceId);
        if (isCurrentStartupPromise()) {
          this.startupPromises.delete(workspaceId);
        }
        throw error;
      } finally {
        if (isCurrentStartupPromise()) {
          this.startupPromises.delete(workspaceId);
        }
      }
    })();

    this.startupPromises.set(workspaceId, startupPromise);
    return startupPromise;
  }

  async screenshot(workspaceId: string): Promise<DesktopScreenshotResult> {
    const target = this.resolveTarget(workspaceId);
    const session = await this.ensureStarted(workspaceId);
    if (this.resolveTarget(workspaceId).ownerWorkspaceId !== target.ownerWorkspaceId) {
      throw new Error(`Desktop target changed before screenshot for workspace ${workspaceId}`);
    }
    return session.screenshot();
  }

  async action(
    workspaceId: string,
    actionType: DesktopActionType,
    params: Record<string, unknown>
  ): Promise<DesktopActionResult> {
    const target = this.resolveTarget(workspaceId);
    const session = await this.ensureStarted(workspaceId);
    return this.inputCoordinator.withInput(workspaceId, () => {
      if (this.resolveTarget(workspaceId).ownerWorkspaceId !== target.ownerWorkspaceId) {
        throw new Error(`Desktop target changed before input for workspace ${workspaceId}`);
      }
      return session.action(actionType, params);
    });
  }

  /** Whether a live desktop session exists for this workspace. */
  has(workspaceId: string): boolean {
    // A session whose process exited or crashed is NOT live — stale map entries linger until
    // the next ensureStarted()/close() touches them.
    return (
      (this.sessions.get(workspaceId)?.isAlive() ?? false) || this.hasAttachedViewers(workspaceId)
    );
  }

  /**
   * Whether someone is attached to this workspace's desktop: a startup still resolving, a
   * registered browser viewer, or an open/pending popout window (including borrowers of a
   * shared desktop this workspace owns). Agent-driven archive gates consult this instead of
   * has(): the bare desktop process is disposable infrastructure that lingers after the agent
   * that started it finished (nothing idles it out), and archive closes it exactly like the
   * user-driven path does — so an idle process alone must not stall an archive. A pending
   * startup still counts: a user-initiated start that has not resolved yet exists only in
   * startupPromises, and the gate must observe it instead of letting close() cancel it
   * mid-startup.
   */
  hasAttachedViewers(workspaceId: string): boolean {
    return (
      this.startupPromises.has(workspaceId) ||
      Array.from(this.viewers.values()).some(
        (viewer) => viewer.workspaceId === workspaceId || viewer.ownerWorkspaceId === workspaceId
      ) ||
      this.getWindow(workspaceId) !== null ||
      Array.from(this.pendingWindowOpens).some(
        (request) => request.workspaceId === workspaceId || request.ownerWorkspaceId === workspaceId
      ) ||
      Array.from(this.windowOwners).some(
        ([requesterId, ownerId]) => ownerId === workspaceId && this.getWindow(requesterId) !== null
      )
    );
  }

  watchWorkspaceConfig(onChange: () => void, onError: (error: unknown) => void): () => void {
    // Watch the directory: Config replaces config.json atomically, so watching the file's
    // inode would silently miss subsequent writes from another backend.
    let closed = false;
    let queued = false;
    const watcher = fs.watch(
      this.deps.config.rootDir,
      { persistent: false },
      (_event, filename) => {
        if (closed) return;
        if (filename === path.basename(this.deps.config.rootDir)) {
          fail(new Error("Desktop config directory was moved or removed"));
        } else if ((filename == null || filename === "config.json") && !queued) {
          queued = true;
          queueMicrotask(() => {
            queued = false;
            if (!closed) onChange();
          });
        }
      }
    );
    const stop = () => {
      if (closed) return;
      closed = true;
      try {
        watcher.close();
      } catch (error) {
        log.debug("Desktop config watcher cleanup failed", { error });
      }
    };
    const fail = (error: unknown) => {
      if (closed) return;
      stop();
      onError(error);
    };
    watcher.on("error", fail);
    watcher.on("close", () => fail(new Error("Desktop config watcher closed unexpectedly")));
    return stop;
  }

  /** A null workspace ID revokes all viewers, including pending bridge connections. */
  onWorkspaceClose(listener: (workspaceId: string | null) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(workspaceId: string): Promise<void> {
    const existingClose = this.closingWorkspaces.get(workspaceId);
    if (existingClose) return existingClose;
    for (const request of this.pendingWindowOpens) {
      if (request.workspaceId === workspaceId || request.ownerWorkspaceId === workspaceId) {
        this.pendingWindowOpens.delete(request);
      }
    }
    const browserViewers = Array.from(this.viewers.values()).filter(
      (viewer) => viewer.workspaceId === workspaceId || viewer.ownerWorkspaceId === workspaceId
    );
    const viewers = new Set([workspaceId]);
    for (const [requesterId, ownerId] of this.windowOwners) {
      if (requesterId === workspaceId || ownerId === workspaceId) {
        viewers.add(requesterId);
        this.windowOwners.delete(requesterId);
      }
    }
    // Latch before entering the async teardown, but leave established bridges alive long enough
    // for borrower viewers to release held keys/buttons on their owner's still-live desktop.
    const closing = Promise.resolve().then(async () => {
      try {
        await Promise.allSettled([
          ...Array.from(
            viewers,
            (requesterId) => this.windowManager?.closeWorkspace(requesterId) ?? Promise.resolve()
          ),
          ...browserViewers.map((viewer) => this.releaseViewer(viewer)),
        ]);
        for (const listener of this.closeListeners) listener(workspaceId);
      } finally {
        await this.closeSession(workspaceId);
      }
    });
    this.closingWorkspaces.set(workspaceId, closing);
    return closing;
  }

  private async closeSession(workspaceId: string): Promise<void> {
    const session = this.sessions.get(workspaceId);
    const startupPromise = this.startupPromises.get(workspaceId);

    try {
      this.sessions.delete(workspaceId);
      this.startupPromises.delete(workspaceId);

      const closeOperations: Array<Promise<unknown>> = [];
      if (session) {
        closeOperations.push(session.close());
      }
      if (startupPromise) {
        closeOperations.push(
          startupPromise.then((startedSession) => startedSession.close()).catch(() => undefined)
        );
      }
      await Promise.allSettled(closeOperations);
    } finally {
      this.sessions.delete(workspaceId);
      this.startupPromises.delete(workspaceId);
      this.closingWorkspaces.delete(workspaceId);
    }
  }

  closeAll(): Promise<void> {
    this.disposed = true;
    this.pendingWindowOpens.clear();
    this.windowOwners.clear();
    const browserViewers = Array.from(this.viewers.values());
    this.closeAllPromise ??= Promise.resolve().then(async () => {
      await Promise.allSettled([
        this.windowManager?.closeAll() ?? Promise.resolve(),
        ...browserViewers.map((viewer) => this.releaseViewer(viewer)),
        // A disconnected subscription may have left a release waiting on its deadline.
        ...this.closingWorkspaces.values(),
      ]);
      for (const listener of this.closeListeners) listener(null);
      const sessions = Array.from(this.sessions.values());
      const startupPromises = Array.from(this.startupPromises.values());

      this.sessions.clear();
      this.startupPromises.clear();

      await Promise.allSettled([
        ...sessions.map(async (session) => session.close()),
        ...startupPromises.map(async (startupPromise) => {
          await startupPromise.then((session) => session.close()).catch(() => undefined);
        }),
      ]);
    });
    return this.closeAllPromise;
  }

  /**
   * Returns VNC connection info for an already-started session.
   * Returns null if no live session exists for the workspace.
   * Used by DesktopBridgeServer to resolve token→VNC-port mappings.
   */
  getLiveSessionConnection(
    workspaceId: string,
    mode: "admission" | "established" = "admission"
  ): {
    ownerWorkspaceId: string;
    sessionId: string;
    vncPort: number;
  } | null {
    let ownerWorkspaceId: string;
    try {
      // An established viewer needs its release channel during local lifecycle admission.
      // Durable archive/removal/owner changes still revoke it through config-based resolution.
      ownerWorkspaceId =
        mode === "established"
          ? this.inputCoordinator.resolveTarget(workspaceId).ownerWorkspaceId
          : this.resolveActiveTarget(workspaceId).ownerWorkspaceId;
    } catch (error) {
      log.debug("Desktop bridge target unavailable", { workspaceId, error });
      return null;
    }
    const session = this.sessions.get(ownerWorkspaceId);
    if (!session?.isAlive()) {
      return null;
    }

    const sessionInfo = session.getSessionInfo();
    if (!sessionInfo.vncPort || sessionInfo.vncPort <= 0) {
      log.warn("PortableDesktop session exists but VNC port is invalid", {
        workspaceId,
        vncPort: sessionInfo.vncPort,
      });
      return null;
    }

    return {
      ownerWorkspaceId,
      sessionId: sessionInfo.sessionId ?? `desktop:${ownerWorkspaceId}`,
      vncPort: sessionInfo.vncPort,
    };
  }
}
