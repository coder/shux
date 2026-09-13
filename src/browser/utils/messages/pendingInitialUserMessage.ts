import type { FilePart } from "@/common/orpc/types";
import type { DisplayedMessage } from "@/common/types/message";

/**
 * Shared row id for the not-yet-persisted first user message. It is a fixed sentinel so the
 * pending row keeps one React key across the creation view and the created workspace transcript.
 */
export const PENDING_INITIAL_USER_MESSAGE_ID = "pending-initial-user-message";

export interface PendingInitialUserMessage {
  content: string;
  fileParts?: FilePart[];
  /** Captured once when the send starts so every surface shows the same time. */
  timestamp: number;
}

export function createPendingUserDisplayedMessage(
  input: PendingInitialUserMessage
): Extract<DisplayedMessage, { type: "user" }> {
  return {
    type: "user",
    id: PENDING_INITIAL_USER_MESSAGE_ID,
    historyId: PENDING_INITIAL_USER_MESSAGE_ID,
    historySequence: -1,
    isPendingSend: true,
    content: input.content,
    fileParts: input.fileParts,
    timestamp: input.timestamp,
  };
}

export interface PendingCreationInit {
  /** null while the name is still being generated */
  workspaceName: string | null;
  /** Typed names never list a "Generating name" step. */
  nameGenerated: boolean;
  kind: "scratch" | undefined;
  hookPath: string;
  timestamp: number;
}

/**
 * Creation progress shown before the backend init stream exists. Scratch chats skip name
 * generation, so their only step is the creation itself.
 */
export function createPendingCreationInitMessage(
  input: PendingCreationInit
): Extract<DisplayedMessage, { type: "workspace-init" }> {
  const step = (line: string) => ({ line, isError: false, step: true });
  const steps =
    input.kind === "scratch"
      ? [step("Creating workspace")]
      : [
          ...(input.nameGenerated ? [step("Generating name")] : []),
          ...(input.workspaceName ? [step(`Creating workspace ${input.workspaceName}`)] : []),
        ];
  const lines = steps.length > 0 ? steps : [step("Creating workspace")];
  return {
    type: "workspace-init",
    id: "workspace-init",
    historySequence: -1,
    status: "running",
    hookPath: input.hookPath,
    lines,
    progress: null,
    exitCode: null,
    timestamp: input.timestamp,
    durationMs: null,
  };
}
