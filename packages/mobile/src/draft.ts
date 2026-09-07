import type { UserMessageContent } from "../../../src/common/types/message";
import type { WorkspaceChatMessage } from "../../../src/common/orpc/types";

export type ChatDraft = Required<UserMessageContent>;
export type RestoredInput = Extract<WorkspaceChatMessage, { type: "restore-to-input" }>;
export const EMPTY_DRAFT: ChatDraft = { text: "", fileParts: [], reviews: [] };
