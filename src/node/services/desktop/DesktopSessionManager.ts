import { randomUUID } from "node:crypto";
import { asyncIterableFromSubscription } from "@/common/utils/asyncEventIterator";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DesktopWindowManager } from "@/desktop/desktopWindowManager";
import {
  DESKTOP_ATTACHMENT_GRACE_MS,
  DESKTOP_DEFAULTS,
  DESKTOP_VIEWER_RELEASE_TIMEOUT_MS,
} from "@/common/constants/desktop";
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
  /**
   * The requester's last bootstrap reported no desktop (disabled, unsupported, startup failed).
   * Its pane will not reconnect to anything, so its detachment leaves no attachment grace.
   */
  desktopUnavailable?: boolean;
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
  /**
   * workspaceId → (requester whose attachment detached → grace expiry). Keyed by requester so an
   * explicit close of a workspace can retract exactly the graces its own attachments produced —
   * on itself and on the owner it borrowed — whenever they were stamped, without touching graces
   * other requesters left on the same owner (see noteDetached / retractDetachments).
   */
  private readonly recentDetachments = new Map<string, Map<string, number>>();
  /**
   * Closes in flight, keyed by the closing workspace → requesters whose attachments to it
   * detached during the teardown (borrowers' viewers and bridges when an owner closes). One
   * entry per close, so overlapping teardowns never share state.
   */
  private readonly teardownRequesters = new Map<string, Set<string>>();
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
          if (this.viewers.delete(viewer.viewerId)) this.noteViewerDetached(viewer);
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
        if (this.viewers.delete(viewer.viewerId)) this.noteViewerDetached(viewer);
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
      /** Clock for the recent-attachment grace; tests inject a controllable one. */
      now?: () => number;
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
      (this.sessions.get(workspaceId)?.isAlive() ?? false) || this.hasLiveAttachment(workspaceId)
    );
  }

  private bridgeConnectionProbe: ((workspaceId: string) => boolean) | undefined;

  /**
   * DesktopBridgeServer reports its live VNC bridge WebSockets through this probe (it depends
   * on this manager, not the other way round). The inline Electron pane connects to the bridge
   * without registering a browser viewer, so without this probe hasAttachedViewers() would
   * report nobody attached while a user watches or controls the desktop in Electron.
   */
  setBridgeConnectionProbe(probe: (workspaceId: string) => boolean): void {
    this.bridgeConnectionProbe = probe;
  }

  /**
   * The workspaces a viewer attaches: the requester and the desktop owner it currently resolves
   * to. The owner is re-resolved rather than read from the registration so a shared-desktop
   * borrower whose owner changed does not keep the OLD owner attached indefinitely; the captured
   * owner is only the fallback when the requester can no longer be resolved.
   */
  private viewerTargets(viewer: DesktopViewerRegistration): string[] {
    const ownerWorkspaceId = this.currentOwnerOf(viewer.workspaceId, viewer.ownerWorkspaceId);
    return ownerWorkspaceId === viewer.workspaceId
      ? [viewer.workspaceId]
      : [viewer.workspaceId, ownerWorkspaceId];
  }

  /**
   * The desktop owner a requester currently resolves to (viewers and Electron popout windows
   * alike capture the owner at open time, which goes stale when the binding changes); the
   * captured owner is the fallback when the requester can no longer be resolved.
   */
  private currentOwnerOf(requesterId: string, capturedOwnerId: string): string {
    try {
      return this.inputCoordinator.resolveTarget(requesterId).ownerWorkspaceId;
    } catch {
      return capturedOwnerId;
    }
  }

  /**
   * A known viewer or VNC bridge just detached from these workspaces: keep them counted as
   * attached for DESKTOP_ATTACHMENT_GRACE_MS. The client's two transports (oRPC viewer
   * registration, VNC bridge WebSocket) drop and return independently during reconnects,
   * re-registration, and inline↔popout handoffs, and no deterministic signal spans that gap;
   * a bounded grace after a KNOWN attachment is the only way an agent-driven archive can tell
   * "reconnecting" from "closed". An idle desktop that never had an attachment gets no grace.
   */
  noteDetached(requesterWorkspaceId: string, capturedOwnerWorkspaceId: string): void {
    assert(requesterWorkspaceId.length > 0, "noteDetached requires the detached requester");
    assert(capturedOwnerWorkspaceId.length > 0, "noteDetached requires the attachment's owner");
    // Classify against the requester's CURRENT owner: a bridge revoked because the borrower was
    // rebound will reconnect to the new owner, so the old one gets no grace from it.
    const ownerWorkspaceId = this.currentOwnerOf(requesterWorkspaceId, capturedOwnerWorkspaceId);
    const targets =
      ownerWorkspaceId === requesterWorkspaceId
        ? [requesterWorkspaceId]
        : [requesterWorkspaceId, ownerWorkspaceId];
    const expiresAt = this.now() + DESKTOP_ATTACHMENT_GRACE_MS;
    for (const workspaceId of targets) {
      let byRequester = this.recentDetachments.get(workspaceId);
      if (!byRequester) {
        byRequester = new Map();
        this.recentDetachments.set(workspaceId, byRequester);
      }
      byRequester.set(requesterWorkspaceId, expiresAt);
      this.teardownRequesters.get(workspaceId)?.add(requesterWorkspaceId);
    }
  }

  private noteViewerDetached(viewer: DesktopViewerRegistration): void {
    if (viewer.desktopUnavailable === true) return;
    this.noteDetached(viewer.workspaceId, viewer.ownerWorkspaceId);
  }

  /**
   * A finished explicit close of `workspaceId` is definitive: nothing of its own is attached
   * any more, and every attachment it held as a requester on some owner is gone too. Retract
   * those graces (whenever they were stamped); graces other requesters left stay untouched.
   */
  private retractDetachments(requesterWorkspaceId: string): void {
    this.recentDetachments.delete(requesterWorkspaceId);
    for (const [target, byRequester] of this.recentDetachments) {
      byRequester.delete(requesterWorkspaceId);
      if (byRequester.size === 0) this.recentDetachments.delete(target);
    }
  }

  /**
   * getDesktopBootstrap reports whether the requester's desktop exists. Viewers of a workspace
   * whose desktop is unavailable will never reconnect to anything, so their eventual detachment
   * must not hold the workspace "attached"; a later successful bootstrap re-arms the grace.
   */
  noteBootstrapOutcome(workspaceId: string, available: boolean): void {
    for (const viewer of this.viewers.values()) {
      if (viewer.workspaceId === workspaceId) viewer.desktopUnavailable = !available;
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private hasRecentDetachment(workspaceId: string): boolean {
    const byRequester = this.recentDetachments.get(workspaceId);
    if (!byRequester) return false;
    const now = this.now();
    for (const [requester, expiresAt] of byRequester) {
      if (expiresAt <= now) byRequester.delete(requester);
    }
    if (byRequester.size === 0) {
      this.recentDetachments.delete(workspaceId);
      return false;
    }
    return true;
  }

  /**
   * Whether someone is attached to this workspace's desktop: a startup still resolving, a
   * registered browser viewer, a live VNC bridge connection (inline Electron pane, inline
   * browser pane, popouts), an open/pending popout window (including borrowers of a shared
   * desktop this workspace owns), or a viewer/bridge that detached within
   * DESKTOP_ATTACHMENT_GRACE_MS (see noteDetached). Agent-driven archive gates consult this
   * instead of has(): the bare desktop process is disposable infrastructure that lingers after
   * the agent that started it finished (nothing idles it out), and archive closes it exactly
   * like the user-driven path does — so an idle process alone must not stall an archive. A
   * pending startup still counts: a user-initiated start that has not resolved yet exists only
   * in startupPromises, and the gate must observe it instead of letting close() cancel it
   * mid-startup.
   */
  hasAttachedViewers(workspaceId: string): boolean {
    return this.hasLiveAttachment(workspaceId) || this.hasRecentDetachment(workspaceId);
  }

  /** Attachments that exist right now (no grace); also what has() counts as live. */
  private hasLiveAttachment(workspaceId: string): boolean {
    return (
      this.startupPromises.has(workspaceId) ||
      this.bridgeConnectionProbe?.(workspaceId) === true ||
      Array.from(this.viewers.values()).some((viewer) =>
        this.viewerTargets(viewer).includes(workspaceId)
      ) ||
      this.getWindow(workspaceId) !== null ||
      Array.from(this.pendingWindowOpens).some(
        (request) => request.workspaceId === workspaceId || request.ownerWorkspaceId === workspaceId
      ) ||
      Array.from(this.windowOwners).some(
        ([requesterId, ownerId]) =>
          this.currentOwnerOf(requesterId, ownerId) === workspaceId &&
          this.getWindow(requesterId) !== null
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
    // Same current-target classification as hasAttachedViewers(): a borrower whose binding
    // moved away from this workspace must not be released (and its unrelated desktop yanked)
    // when this workspace closes.
    const browserViewers = Array.from(this.viewers.values()).filter((viewer) =>
      this.viewerTargets(viewer).includes(workspaceId)
    );
    const viewers = new Set([workspaceId]);
    for (const [requesterId, ownerId] of this.windowOwners) {
      if (
        requesterId === workspaceId ||
        this.currentOwnerOf(requesterId, ownerId) === workspaceId
      ) {
        viewers.add(requesterId);
        this.windowOwners.delete(requesterId);
      }
    }
    // The attachments this teardown releases (its viewers, and the bridges revoked through the
    // close listeners) stamp a recent-detachment grace as they go. That grace exists for
    // transports that may come back; an explicit close is deterministic, so retract exactly the
    // graces produced by this teardown's own sources afterwards — a borrower closing must not
    // leave its owner "attached", while a grace an unrelated viewer stamped meanwhile survives.
    // Every requester whose attachment to this workspace is released by the teardown (itself,
    // its popouts, and — when it is a shared owner — its borrowers' viewers and bridges) is
    // collected so the finished close can retract their graces definitively.
    const releasedRequesters = new Set([
      workspaceId,
      ...viewers,
      ...browserViewers.map((viewer) => viewer.workspaceId),
    ]);
    this.teardownRequesters.set(workspaceId, releasedRequesters);
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
        this.teardownRequesters.delete(workspaceId);
        // The teardown's detachments (and any these requesters left earlier) are definitive.
        for (const requester of releasedRequesters) this.retractDetachments(requester);
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
