import { InitMessage } from "@/browser/features/Messages/InitMessage";
import { UserMessage } from "@/browser/features/Messages/UserMessage";
import {
  createPendingCreationInitMessage,
  createPendingUserDisplayedMessage,
  type PendingInitialUserMessage,
} from "@/browser/utils/messages/pendingInitialUserMessage";

interface CreationCenterContentProps {
  isSending: boolean;
  /** The first message being sent (null for sends that create no user turn, e.g. /goal) */
  pendingUserMessage: PendingInitialUserMessage | null;
  /** The confirmed workspace name (null while generation is in progress) */
  workspaceName?: string | null;
  kind?: "scratch";
  projectPath: string;
}

/**
 * Transcript-first creation progress: the message being sent followed by the same creation
 * card the new workspace will show, so the view already looks like the transcript it becomes.
 */
export function CreationCenterContent(props: CreationCenterContentProps) {
  if (!props.isSending) {
    return null;
  }
  const timestamp = props.pendingUserMessage?.timestamp ?? Date.now();
  return (
    <div className="w-full" data-testid="creation-pending-transcript">
      {props.pendingUserMessage && (
        <UserMessage message={createPendingUserDisplayedMessage(props.pendingUserMessage)} />
      )}
      <InitMessage
        message={createPendingCreationInitMessage({
          workspaceName: props.workspaceName ?? null,
          kind: props.kind,
          hookPath: props.projectPath,
          timestamp,
        })}
      />
    </div>
  );
}
