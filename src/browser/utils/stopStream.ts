import type { APIClient } from "@/browser/contexts/API";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";

/**
 * User Stop: interrupts the stream and dismisses owed background monitor output instead of letting
 * it wake the agent. A Stop the backend could not record on disk may resume on restart, so its
 * failure is shown in the workspace's chat input rather than dropped with the Result.
 */
export async function stopStream(
  api: APIClient,
  workspaceId: string,
  options?: { abandonPartial?: boolean }
): Promise<void> {
  const result = await api.workspace.interruptStream({
    workspaceId,
    options: { ...options, retireBashMonitorAttention: true },
  });
  if (!result.success) {
    window.dispatchEvent(
      createCustomEvent(CUSTOM_EVENTS.CHAT_ERROR_TOAST, { workspaceId, message: result.error })
    );
  }
}
