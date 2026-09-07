import { useEffect, useRef } from "react";

/**
 * Error toasts addressed to a workspace's chat input (a child exhausting the parent's goal budget,
 * a Stop the backend could not record). Retained until that input has shown and dismissed them: the
 * error can land after the user switched workspaces (a Stop settles asynchronously), when no input
 * for that workspace is mounted, and the input renders a single toast at a time.
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

export function peekChatError(workspaceId: string): string | undefined {
  return pendingByWorkspace.get(workspaceId)?.[0];
}

export function dismissChatError(workspaceId: string, message: string): void {
  const pending = pendingByWorkspace.get(workspaceId);
  const index = pending?.indexOf(message) ?? -1;
  if (pending == null || index < 0) return;
  pending.splice(index, 1);
  if (pending.length === 0) pendingByWorkspace.delete(workspaceId);
}

/**
 * Shows the workspace's retained and later chat errors through `pushToast`, one per toast:
 * `visibleToastMessage` is the input's current toast and the next error is pushed once it is gone.
 * An error leaves the queue only after its toast was rendered and dismissed, so a push that never
 * rendered (React batched another toast over it, or StrictMode replayed the effect) or that another
 * toast replaced is pushed again.
 */
export function useChatErrorToasts(
  workspaceId: string | null,
  visibleToastMessage: string | null,
  pushToast: (toast: { type: "error"; message: string }) => void
): void {
  const pushedRef = useRef<{ message: string; displayed: boolean } | null>(null);
  useEffect(() => {
    if (workspaceId == null) return;
    const pushed = pushedRef.current;
    if (visibleToastMessage != null) {
      // Dismissal is inferred from the slot clearing, so only a toast still showing this error
      // counts; one that replaced it (a later success toast) means the error must show again.
      if (pushed != null) pushed.displayed = pushed.message === visibleToastMessage;
      return;
    }
    if (pushed?.displayed) dismissChatError(workspaceId, pushed.message);
    pushedRef.current = null;
    const showNext = () => {
      if (pushedRef.current != null) return;
      const message = peekChatError(workspaceId);
      if (message == null) return;
      pushedRef.current = { message, displayed: false };
      pushToast({ type: "error", message });
    };
    const listeners = listenersByWorkspace.get(workspaceId) ?? new Set<() => void>();
    listenersByWorkspace.set(workspaceId, listeners);
    listeners.add(showNext);
    showNext();
    return () => {
      listeners.delete(showNext);
      if (listeners.size === 0) {
        listenersByWorkspace.delete(workspaceId);
      }
    };
  }, [workspaceId, visibleToastMessage, pushToast]);
}
