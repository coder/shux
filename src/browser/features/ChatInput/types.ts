import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { TelemetryRuntimeType } from "@/common/telemetry/payload";
import type { Review } from "@/common/types/review";
import type { EditingMessageState, PendingUserMessage } from "@/browser/utils/chatEditing";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { QueuedMessage } from "@/common/types/message";

export type GoalInterventionPolicy = NonNullable<SendMessageOptions["goalInterventionPolicy"]>;
export type QueueDispatchMode = NonNullable<SendMessageOptions["queueDispatchMode"]>;

export interface ChatInputAPI {
  focus: () => void;
  send: () => Promise<void>;
  restoreText: (text: string) => void;
  restoreDraft: (pending: PendingUserMessage) => void;
  appendText: (text: string) => void;
  prependText: (text: string) => void;
}

export interface WorkspaceCreatedOptions {
  /** When false, register metadata without navigating to the new workspace. */
  autoNavigate?: boolean;
  /** Pending model for the optimistic startup barrier when navigation actually occurs. */
  pendingStreamModel?: string | null;
  /** Set false when creation does not immediately enqueue an initial user send. */
  markPendingInitialSend?: boolean;
}

// Workspace variant: full functionality for existing workspaces
export interface ChatInputWorkspaceVariant {
  variant: "workspace";
  kind?: "scratch";
  workspaceId: string;
  /** Runtime type for the workspace (for telemetry) - no sensitive details like SSH host */
  runtimeType?: TelemetryRuntimeType;
  /** Fires once a regular workspace send has passed validation, before IPC/streaming begins. */
  onMessageSendStarted?: (dispatchMode: QueueDispatchMode) => void;
  onMessageSent?: (dispatchMode: QueueDispatchMode) => void;
  onResetContext: () => Promise<"reset" | "noop">;
  onTruncateHistory: (percentage?: number) => Promise<void>;
  onModelChange?: (model: string) => void;
  isTranscriptCaughtUp?: boolean;
  isCompacting?: boolean;
  isStreamStarting?: boolean;
  editingMessage?: EditingMessageState;
  onCancelEdit?: () => void;
  onEditLastUserMessage?: () => void;
  canInterrupt?: boolean;
  disabled?: boolean;
  /** Queued follow-up currently waiting during an active workspace stream. */
  queuedMessage?: QueuedMessage | null;
  onQueuedDispatchModeChange?: (mode: QueueDispatchMode) => Promise<void>;
  onQueuedActionError?: (error: unknown) => void;
  onSendQueuedImmediately?: () => Promise<void>;
  /** Optional explanation displayed when input is disabled */
  disabledReason?: string;
  onReady?: (api: ChatInputAPI) => void;
  /** Reviews currently attached to chat (from useReviews hook) */
  attachedReviews?: Review[];
  /** Detach a review from chat input (sets status to pending) */
  onDetachReview?: (reviewId: string) => void;
  /** Detach all attached reviews from chat input */
  onDetachAllReviews?: () => void;
  /** Mark a single review as checked (completed) */
  onCheckReview?: (reviewId: string) => void;
  /** Mark multiple reviews as checked after sending */
  onCheckReviews?: (reviewIds: string[]) => void;
  /** Permanently delete a review */
  onDeleteReview?: (reviewId: string) => void;
  /** Update a review's comment/note */
  onUpdateReviewNote?: (reviewId: string, newNote: string) => void;
}

// Creation variant: simplified for first message / workspace creation
export interface ChatInputCreationVariant {
  variant: "creation";
  kind?: "scratch";
  projectPath: string;
  projectName: string;
  /** Sub-project path for parent-owned draft creation. */
  pendingSubProjectPath?: string | null;
  /** Draft ID for UI-only workspace creation drafts (from URL) */
  pendingDraftId?: string | null;
  onWorkspaceCreated: (
    metadata: FrontendWorkspaceMetadata,
    options?: WorkspaceCreatedOptions
  ) => void;
  onModelChange?: (model: string) => void;
  disabled?: boolean;
  onReady?: (api: ChatInputAPI) => void;
}

export type ChatInputProps = ChatInputWorkspaceVariant | ChatInputCreationVariant;
