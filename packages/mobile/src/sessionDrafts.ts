import type { SetStateAction } from "react";
import { EMPTY_DRAFT } from "./draft";
import type { ChatDraft } from "./draft";

function createDraft() {
  let value = EMPTY_DRAFT;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(update: SetStateAction<ChatDraft>) {
      const next = typeof update === "function" ? update(value) : update;
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
  };
}

// Session-owned, workspace-keyed drafts survive route unmounts without broadcasting
// every keystroke to the workspace navigator or other mounted conversations.
export function createSessionDrafts() {
  const drafts = new Map<string, ReturnType<typeof createDraft>>();
  return {
    get(id: string) {
      let draft = drafts.get(id);
      if (!draft) {
        draft = createDraft();
        drafts.set(id, draft);
      }
      return draft;
    },
    clear() {
      for (const draft of drafts.values()) draft.set(EMPTY_DRAFT);
      drafts.clear();
    },
  };
}
