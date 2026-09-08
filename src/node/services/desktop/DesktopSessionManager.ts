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
}

interface DetachmentGrace {
  requesterWorkspaceId: string;
  expiresAt: number;
  /** Owner captured at stamp time: the fallback when the requester can no longer be resolved. */
  capturedOwnerWorkspaceId: string;
  /**
   * An owner this grace covered that closed explicitly meanwhile: its desktop is gone for good,
   * so the grace no longer covers it — but still covers the requester, and the owner it resolves
   * to should it be rebound before it reconnects.
   */
  excludedOwnerWorkspaceId?: string;
}

/** Grace source key of the VNC bridge a viewer bootstrapped (or an anonymous bridge). */
function bridgeSourceKey(viewerIdOrSequence: string): string {
  return `bridge:${viewerIdOrSequence}`;
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
   * Detached source → its grace. Viewer detachments are keyed by their viewerId so a pane's
   * definitive detach can retract exactly the graces its own (possibly superseded) registrations
   * stamped — never another pane's; bridge detachments get an opaque key. Graces record the
   * requester rather than the workspaces they keep attached so an explicit close can retract a
   * released requester's graces without touching graces other requesters left on the same owner,
   * and so the owner a grace covers is re-resolved at query time: a grace stamped while the
   * borrower targeted owner A must follow the borrower to owner B when the binding changes before
   * it reconnects (see noteDetached / hasRecentDetachment).
   */
  private readonly recentDetachments = new Map<string, DetachmentGrace>();
  private bridgeDetachmentSequence = 0;
  /**
   * Viewers a pane gave up definitively (see detachViewer) → until when a bridge detachment
   * attributed to that viewer stamps no grace: the pane's oRPC call and its VNC socket close
   * travel independently, so the bridge's detachment may reach us after the retraction.
   */
  private readonly definitivelyDetachedViewers = new Map<string, number>();
  /**
   * Closes in flight, keyed by the closing workspace → grace sources the teardown owns: those
   * its released requesters had stamped before it started, plus detachments that target the
   * closing workspace while it runs (borrowers' viewers and bridges when an owner closes). One
   * entry per close, so overlapping teardowns never share state, and a grace a rebound borrower
   * stamps on its NEW owner meanwhile is not attributed to the old owner's teardown.
   */
  private readonly teardownSources = new Map<string, Set<string>>();
  private disposed = false;
  private closeAllPromise: Promise<void> | undefined;

  /**
   * `viewerId` lets the pane name its registration up front (so it can detach it definitively
   * before ready arrives); it must not collide with a live registration — a colliding id would
   * let one pane displace another's registration and, on detach, retract its graces.
   */
  watchViewer(
    workspaceId: string,
    signal?: AbortSignal,
    viewerId: string = randomUUID()
  ): AsyncGenerator<DesktopViewerEvent> {
    return asyncIterableFromSubscription<DesktopViewerEvent>({
      signal,
      subscribe: (push) => {
        // Admission and registration share one synchronous block: cleanup either sees this
        // viewer in its snapshot or rejects its registration before sending ready.
        const target = this.resolveActiveTarget(workspaceId);
        if (this.viewers.has(viewerId)) {
          throw new Error(`Desktop viewer ${viewerId} is already registered`);
        }
        const viewer: DesktopViewerRegistration = {
          viewerId,
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

  /**
   * The pane behind this registration settled in a terminal state (no desktop, or its first
   * connection failed with no retry pending) and is giving the registration up for good. Drop
   * it without the attachment grace: that grace is for transports that may come back. This is
   * the only detachment that skips the grace — the client alone knows whether it will retry
   * (a previously connected pane keeps retrying through an unavailable bootstrap), so the
   * backend never infers "will not reconnect" from a bootstrap outcome.
   */
  detachViewer(viewerId: string): void {
    this.viewers.delete(viewerId);
    // The registration may already be gone and have stamped a grace instead: a ready
    // registration that dropped while its bootstrap was pending is replaced immediately, and the
    // pane reports the terminal outcome for the superseded viewerId too. Only that registration's
    // own graces — its own and its bridge's (bootstrapped under this viewerId) — are retracted;
    // a grace another pane of the same requester left while it re-registers must keep that pane
    // attached.
    this.recentDetachments.delete(viewerId);
    this.recentDetachments.delete(bridgeSourceKey(viewerId));
    const now = this.now();
    for (const [id, until] of this.definitivelyDetachedViewers) {
      if (until <= now) this.definitivelyDetachedViewers.delete(id);
    }
    this.definitivelyDetachedViewers.set(viewerId, now + DESKTOP_ATTACHMENT_GRACE_MS);
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
  noteDetached(
    requesterWorkspaceId: string,
    capturedOwnerWorkspaceId: string,
    viewerId?: string
  ): void {
    if (viewerId !== undefined) {
      const detachedUntil = this.definitivelyDetachedViewers.get(viewerId);
      if (detachedUntil !== undefined) {
        if (detachedUntil > this.now()) return;
        this.definitivelyDetachedViewers.delete(viewerId);
      }
    }
    this.bridgeDetachmentSequence += 1;
    this.stampDetachment(
      bridgeSourceKey(viewerId ?? `#${this.bridgeDetachmentSequence}`),
      requesterWorkspaceId,
      capturedOwnerWorkspaceId
    );
  }

  private stampDetachment(
    sourceKey: string,
    requesterWorkspaceId: string,
    capturedOwnerWorkspaceId: string
  ): void {
    assert(requesterWorkspaceId.length > 0, "noteDetached requires the detached requester");
    assert(capturedOwnerWorkspaceId.length > 0, "noteDetached requires the attachment's owner");
    this.recentDetachments.set(sourceKey, {
      requesterWorkspaceId,
      expiresAt: this.now() + DESKTOP_ATTACHMENT_GRACE_MS,
      capturedOwnerWorkspaceId,
    });
    // Attribute to a teardown in flight only what targets the closing workspace NOW: a bridge
    // revoked because the borrower was rebound will reconnect to the new owner, so the old
    // owner's teardown does not own that grace.
    const ownerWorkspaceId = this.currentOwnerOf(requesterWorkspaceId, capturedOwnerWorkspaceId);
    this.teardownSources.get(requesterWorkspaceId)?.add(sourceKey);
    this.teardownSources.get(ownerWorkspaceId)?.add(sourceKey);
  }

  private noteViewerDetached(viewer: DesktopViewerRegistration): void {
    this.stampDetachment(viewer.viewerId, viewer.workspaceId, viewer.ownerWorkspaceId);
  }

  /**
   * A finished explicit close of `closedWorkspaceId` is definitive: the graces its teardown
   * owns (see teardownSources) are gone, and its desktop is gone, so a grace some other
   * requester stamped earlier no longer covers it (that requester's own workspace stays
   * covered, as does an owner it is rebound to). Graces on other owners stay untouched.
   */
  private retractDetachments(closedWorkspaceId: string, sources: Set<string>): void {
    for (const [sourceKey, grace] of this.recentDetachments) {
      if (sources.has(sourceKey)) {
        this.recentDetachments.delete(sourceKey);
      } else if (
        this.currentOwnerOf(grace.requesterWorkspaceId, grace.capturedOwnerWorkspaceId) ===
        closedWorkspaceId
      ) {
        grace.excludedOwnerWorkspaceId = closedWorkspaceId;
      }
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Whether an unexpired grace covers `workspaceId`: the detached requester itself, or the owner
   * that requester CURRENTLY resolves to. Resolving at query time (like viewerTargets) keeps a
   * borrower rebound mid-reconnect from protecting its old owner while leaving the new one open
   * to an agent-driven archive; the captured owner is only the fallback for a requester that can
   * no longer be resolved.
   */
  private hasRecentDetachment(workspaceId: string): boolean {
    const now = this.now();
    let covered = false;
    for (const [sourceKey, grace] of this.recentDetachments) {
      if (grace.expiresAt <= now) {
        this.recentDetachments.delete(sourceKey);
        continue;
      }
      if (grace.requesterWorkspaceId === workspaceId) covered = true;
      else if (
        grace.excludedOwnerWorkspaceId !== workspaceId &&
        this.currentOwnerOf(grace.requesterWorkspaceId, grace.capturedOwnerWorkspaceId) ===
          workspaceId
      ) {
        covered = true;
      }
    }
    return covered;
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
    // The teardown owns the graces this workspace's own earlier attachments had stamped, plus
    // whatever detaches from it while it runs (its viewers and popouts and — when it is a shared
    // owner — its borrowers' viewers and bridges; see stampDetachment). A released borrower's
    // EARLIER graces are not its to retract: a sibling pane of that borrower between
    // registrations never received this release and still relies on its own grace; the owner leg
    // of such graces is withdrawn by retractDetachments instead.
    const teardownSources = new Set<string>();
    for (const [sourceKey, grace] of this.recentDetachments) {
      if (grace.requesterWorkspaceId === workspaceId) teardownSources.add(sourceKey);
    }
    this.teardownSources.set(workspaceId, teardownSources);
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
        this.teardownSources.delete(workspaceId);
        // The teardown's detachments (and any its requesters left earlier) are definitive.
        this.retractDetachments(workspaceId, teardownSources);
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
