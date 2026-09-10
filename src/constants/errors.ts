/**
 * Default bound for clampErrorMessage. Generous for real provider errors,
 * tiny compared to the pathological cases it defends against (AI SDK errors
 * that embed entire serialized request payloads in their message).
 */
export const ERROR_MESSAGE_CLAMP_MAX_CHARS = 8_000;
