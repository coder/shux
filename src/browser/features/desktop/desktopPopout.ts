import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { resolveBrowserAssetUrl } from "@/browser/utils/frontendBasePath";
import {
  DESKTOP_POPOUT_READY_TIMEOUT_MS,
  DESKTOP_POPOUT_CLOSE_EVENT,
  DESKTOP_POPOUT_CLOSE_POLL_MS,
} from "@/common/constants/desktop";
import type { APIClient } from "@/browser/contexts/API";
import { getErrorMessage } from "@/common/utils/errors";

export type DesktopWindowAPI = Pick<
  APIClient["desktop"],
  "openWindow" | "closeWindow" | "getWindow"
>;

// "ping" lets a reloaded parent (whose detached state is only a persisted hint) ask a live child
// to re-announce itself with "opened", so the hint can be confirmed without a new handoff.
type PopoutMessageType = "ready" | "grant" | "opened" | "bring-back" | "closed" | "failed" | "ping";
export interface DesktopPopoutCloseRequest {
  instanceId: string;
  handled: boolean;
  // Native close interception waits for renderer cleanup before allowing the window to close.
  completion?: Promise<void>;
}

export interface DesktopPopoutMessage {
  type: PopoutMessageType;
  instanceId: string;
}
export function isDesktopPopoutMessage(value: unknown): value is DesktopPopoutMessage {
  if (typeof value !== "object" || value === null) return false;
  return (
    "instanceId" in value &&
    typeof value.instanceId === "string" &&
    "type" in value &&
    typeof value.type === "string" &&
    ["ready", "grant", "opened", "bring-back", "closed", "failed", "ping"].includes(value.type)
  );
}
export function desktopPopoutChannel(workspaceId: string): BroadcastChannel {
  return new BroadcastChannel(`xum-desktop:${workspaceId}`);
}

interface PopoutSnapshot {
  state: "checking" | "inline" | "opening" | "detached";
  error: string | null;
}

// Lives outside the tab's mount lifetime so switching workspaces cannot reconnect an
// inline viewer behind its popout. A persisted hint is recovery UI, never a control lease.
export class DesktopPopout {
  private snapshot: PopoutSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly storageKey: string;
  private instanceId: string | null;
  private popup: Window | null = null;
  private grantPending = false;
  private returning = false;
  private channel: BroadcastChannel | null = null;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private closeTimer: number | undefined;
  private suspendInline: (() => void) | undefined;
  private resumeInline: (() => void) | undefined;
  private registerInline: (() => void) | undefined;
  private inlineSuspended = false;
  private childConfirmed = false;

  constructor(
    private readonly workspaceId: string,
    private readonly electron: boolean
  ) {
    this.storageKey = `desktop-popout:${workspaceId}`;
    const hint = readPersistedState<unknown>(this.storageKey, null);
    this.instanceId = typeof hint === "string" && hint.length > 0 ? hint : null;
    this.snapshot = {
      state: electron ? "checking" : this.instanceId ? "detached" : "inline",
      error: null,
    };
  }

  getSnapshot = (): PopoutSnapshot => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(state: PopoutSnapshot["state"], error: string | null = null) {
    this.snapshot = { state, error };
    for (const listener of this.listeners) listener();
  }
  private listen() {
    if (this.channel) return;
    this.channel = desktopPopoutChannel(this.workspaceId);
    this.channel.onmessage = (event: MessageEvent<unknown>) => {
      if (!isDesktopPopoutMessage(event.data) || event.data.instanceId !== this.instanceId) return;
      switch (event.data.type) {
        case "ready":
          if (!this.grantPending) return;
          this.grantPending = false;
          if (this.snapshot.state === "opening") {
            // Flush human input and close the inline socket before the child can start VNC.
            this.suspend();
            updatePersistedState(this.storageKey, this.instanceId);
            this.update("detached");
          }
          this.confirmChild();
          this.send("grant");
          break;
        case "grant":
        case "bring-back":
        case "ping":
          break;
        case "opened":
          if (this.snapshot.state !== "detached") return;
          this.grantPending = false;
          clearTimeout(this.deadline);
          this.confirmChild();
          break;
        case "closed":
          this.restore();
          break;
        case "failed":
          this.send("bring-back");
          this.restore("The detached desktop failed to start. Reconnect here or try again.");
          break;
      }
    };
  }
  private send(type: PopoutMessageType) {
    if (this.instanceId) this.channel?.postMessage({ type, instanceId: this.instanceId });
  }
  private restore(error: string | null = null) {
    clearTimeout(this.deadline);
    window.clearTimeout(this.closeTimer);
    this.instanceId = null;
    this.grantPending = false;
    this.returning = false;
    this.popup = null;
    this.channel?.close();
    this.channel = null;
    updatePersistedState(this.storageKey, null);
    this.childConfirmed = false;
    this.update("inline", error);
    // The inline viewer stays mounted while detached; reconnect it only if we suspended it
    // (a blocked popup never suspended, so its connection must not be restarted).
    if (this.inlineSuspended) {
      this.inlineSuspended = false;
      this.resumeInline?.();
    }
  }

  private suspend() {
    this.suspendInline?.();
    this.inlineSuspended = true;
  }

  /**
   * A live child was confirmed (its own message, or Electron manager truth). Only then may a
   * suspended inline pane register as an attached viewer; a bare persisted browser hint is
   * recovery UI and must not become a backend attachment for a popout that may be gone.
   */
  private confirmChild() {
    this.childConfirmed = true;
    if (this.inlineSuspended) this.registerInline?.();
  }

  /**
   * `suspended` marks an inline viewer that mounted while the desktop was already detached.
   * `register` attaches that suspended viewer without connecting; it is invoked only once a live
   * child is confirmed (Electron manager truth, or a bring-back in flight), never from a bare
   * persisted browser hint, so a stale hint cannot turn into a backend attachment.
   */
  attach(
    suspend: () => void,
    resume?: () => void,
    suspended = false,
    register?: () => void
  ): () => void {
    this.suspendInline = suspend;
    this.resumeInline = resume;
    this.registerInline = register;
    if (suspended) {
      this.inlineSuspended = true;
      if (this.childConfirmed) register?.();
    }
    return () => {
      if (this.suspendInline === suspend) {
        this.suspendInline = undefined;
        this.resumeInline = undefined;
        this.registerInline = undefined;
      }
    };
  }

  async reconcile(api: DesktopWindowAPI) {
    const snapshot = this.snapshot;
    try {
      if (this.instanceId) this.listen();
      if (this.electron) {
        const current = await api.getWindow({ workspaceId: this.workspaceId });
        if (snapshot !== this.snapshot || snapshot.state === "opening") return;
        if (current) {
          if (this.returning) return;
          this.suspend();
          this.instanceId = current.instanceId;
          this.listen();
          // A reloaded parent may have missed ready. Manager truth, unlike a browser
          // hint, permits completing the handoff now or when a late ready arrives.
          this.grantPending = true;
          this.update("detached");
          this.confirmChild();
          this.send("grant");
        } else this.restore();
      } else if (this.popup?.closed) this.restore();
      // A reloaded browser parent holds only a hint: ask the child to confirm itself.
      else if (this.instanceId && !this.childConfirmed) this.send("ping");
    } catch (error) {
      if (snapshot !== this.snapshot) return;
      // A failed manager query is not proof that an existing window is gone.
      this.update(this.electron ? "detached" : this.snapshot.state, getErrorMessage(error));
    }
  }

  async open(api: DesktopWindowAPI) {
    if (this.snapshot.state !== "inline") {
      if (this.electron && this.instanceId) {
        await api.openWindow({ workspaceId: this.workspaceId, instanceId: this.instanceId });
      } else this.popup?.focus();
      return;
    }
    const instanceId = crypto.randomUUID();
    try {
      this.instanceId = instanceId;
      this.grantPending = true;
      this.listen();
      this.update("opening");
      // A failure deadline, not handoff coordination: only a ready message grants VNC.
      this.deadline = setTimeout(() => {
        if (this.instanceId !== instanceId) return;
        this.recover(api).catch((error: unknown) => {
          this.update("detached", getErrorMessage(error));
        });
      }, DESKTOP_POPOUT_READY_TIMEOUT_MS);
      // Subscribe and open synchronously in the click gesture (before any await).
      if (this.electron) {
        const opened = await api.openWindow({ workspaceId: this.workspaceId, instanceId });
        if (this.instanceId !== instanceId) return;
        if (opened.instanceId !== instanceId) {
          this.suspend();
          clearTimeout(this.deadline);
          this.instanceId = opened.instanceId;
          this.update("detached");
          this.confirmChild();
          this.send("grant");
          return;
        }
      } else {
        const params = new URLSearchParams({ workspaceId: this.workspaceId, instanceId });
        this.popup = window.open(
          resolveBrowserAssetUrl(`desktop.html?${params}`),
          `xum-desktop-${this.workspaceId}`,
          "popup,width=1100,height=800"
        );
        if (!this.popup)
          throw new Error("The desktop popup was blocked. Allow popups and try again.");
      }
    } catch (error) {
      if (this.instanceId === instanceId) this.restore(getErrorMessage(error));
    }
  }

  bringBack() {
    if (!this.instanceId) return;
    this.returning = true;
    this.grantPending = false;
    // Attach the inline pane before a confirmed child disconnects so the desktop stays marked
    // as in use through the handoff. An unconfirmed hint gets no lease: a dead child never
    // answers, so nothing would ever release it.
    if (this.childConfirmed) this.registerInline?.();
    this.send("bring-back");
  }

  private waitForRelease(instanceId: string): Promise<boolean> {
    return new Promise((resolve) => {
      const finish = (released: boolean) => {
        clearTimeout(timer);
        unsubscribe();
        resolve(released);
      };
      const unsubscribe = this.subscribe(() => {
        if (this.instanceId !== instanceId) finish(true);
      });
      const timer = setTimeout(() => finish(false), DESKTOP_POPOUT_READY_TIMEOUT_MS);
      this.bringBack();
    });
  }

  private watchClosed(popup: Window, instanceId: string | null, deadline: number) {
    window.clearTimeout(this.closeTimer);
    if (this.instanceId !== instanceId) return;
    if (popup.closed) {
      this.restore();
    } else if (Date.now() >= deadline) {
      this.update("detached", "The desktop window did not close. Close it and reconnect here.");
    } else {
      // A closed-window signal, not a timed grant: never reconnect merely on timeout.
      this.closeTimer = window.setTimeout(
        () => this.watchClosed(popup, instanceId, deadline),
        DESKTOP_POPOUT_CLOSE_POLL_MS
      );
    }
  }

  async recover(api: DesktopWindowAPI) {
    clearTimeout(this.deadline);
    const instanceId = this.instanceId;
    this.returning = true;
    this.grantPending = false;
    if (this.electron) {
      // Manager truth also recovers a missed ready/closed message or renderer crash.
      const current = await api.getWindow({ workspaceId: this.workspaceId });
      if (this.instanceId !== instanceId) return;
      if (current) {
        this.instanceId = current.instanceId;
        this.listen();
        // A responsive renderer must release held inputs before native destruction.
        // Force-close only when its cleanup acknowledgment misses the bounded wait.
        if (await this.waitForRelease(current.instanceId)) return;
        if (this.instanceId !== current.instanceId) return;
        await api.closeWindow({ workspaceId: this.workspaceId, instanceId: current.instanceId });
        if (this.instanceId === current.instanceId) this.restore();
        return;
      }
    } else {
      this.bringBack();
      // A browser reload loses the Window handle, not the named popup. Reacquire it
      // in this user gesture so a stale hint can be recovered without granting a
      // second viewer while a live child is still releasing its inputs.
      this.popup ??= window.open("", `xum-desktop-${this.workspaceId}`, "popup");
      if (!this.popup) throw new Error("Allow popups to reconnect the desktop here.");
      const request: DesktopPopoutCloseRequest = { instanceId: instanceId ?? "", handled: false };
      try {
        // Broadcast delivery can lose a race with window.close(). A responsive same-origin
        // child must synchronously release input before we allow its renderer to disappear.
        this.popup.dispatchEvent(new CustomEvent(DESKTOP_POPOUT_CLOSE_EVENT, { detail: request }));
      } catch {
        // A navigated/crashed window cannot run our cleanup; close its transport instead.
      }
      if (!request.handled) this.popup.close();
      this.watchClosed(this.popup, instanceId, Date.now() + DESKTOP_POPOUT_READY_TIMEOUT_MS);
      return;
    }
    if (this.instanceId === instanceId) this.restore();
  }
}

const popouts = new Map<string, DesktopPopout>();
export function getDesktopPopout(workspaceId: string): DesktopPopout {
  let popout = popouts.get(workspaceId);
  if (!popout) {
    popout = new DesktopPopout(workspaceId, typeof window.api !== "undefined");
    popouts.set(workspaceId, popout);
  }
  return popout;
}
