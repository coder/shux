import type { ChatUiFeatureId, ChatUiSupport } from "xum/common/constants/chatUiFeatures";

export const VSCODE_CHAT_UI_SUPPORT = {
  messageEditing: "planned",
  imageAttachments: "unsupported",
  slashCommandSuggestions: "planned",
  commandPalette: "unsupported",
  voiceInput: "unsupported",
  reviewAnnotations: "unsupported",
  bashForegroundControls: "unsupported",
  jsonRawView: "supported",
} as const satisfies Record<ChatUiFeatureId, ChatUiSupport>;
