import { useEffect } from "react";

/**
 * Error toasts addressed to a workspace's chat input (a child exhausting the parent's goal budget,
 * a Stop the backend could not record). Retained until that input drains them: the error can land
 * after the user switched workspaces (a Stop settles asynchronously), when no input for that
 * workspace is mounted to receive a one-shot event.
 */
const pendingByWorkspace = new Map<string, string[]>();
const listenersByWorkspace = new Map<string, Set<() => void>>();

export function publishChatError(workspaceId: string, message: string): void {
  const pending = pendingByWorkspace.get(workspaceId) ?? [];
  pending.push(message);
  pendingByWorkspace.set(workspaceId, pending);
  for (const listener of listenersByWorkspace.get(workspaceId) ?? []) {
    listener();
  }
}

export function takeChatErrors(workspaceId: string): string[] {
  const pending = pendingByWorkspace.get(workspaceId) ?? [];
  pendingByWorkspace.delete(workspaceId);
  return pending;
}

/** Shows the workspace's retained and later chat errors through `pushToast`. */
export function useChatErrorToasts(
  workspaceId: string | null,
  pushToast: (toast: { type: "error"; message: string }) => void
): void {
  useEffect(() => {
    if (workspaceId == null) return;
    const drain = () => {
      for (const message of takeChatErrors(workspaceId)) {
        pushToast({ type: "error", message });
      }
    };
    const listeners = listenersByWorkspace.get(workspaceId) ?? new Set<() => void>();
    listenersByWorkspace.set(workspaceId, listeners);
    listeners.add(drain);
    drain();
    return () => {
      listeners.delete(drain);
      if (listeners.size === 0) {
        listenersByWorkspace.delete(workspaceId);
      }
    };
  }, [workspaceId, pushToast]);
}
