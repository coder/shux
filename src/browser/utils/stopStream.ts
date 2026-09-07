import type { APIClient } from "@/browser/contexts/API";
import { publishChatError } from "@/browser/utils/chatErrorToasts";
import { getErrorMessage } from "@/common/utils/errors";

/**
 * User Stop: interrupts the stream and dismisses owed background monitor output instead of letting
 * it wake the agent. A Stop the backend could not record on disk may resume on restart, so its
 * failure is shown in the workspace's chat input rather than dropped with the Result.
 *
 * `disableAutoRetry` rides inside the Stop rather than as a separate call: the backend persists
 * the opt-out after retiring monitor attention and before acknowledging, so it can neither escape
 * the Stop's durability check nor release the retry idle gate to a pending wake.
 */
export async function stopStream(
  api: APIClient,
  workspaceId: string,
  options?: { abandonPartial?: boolean; disableAutoRetry?: boolean }
): Promise<void> {
  try {
    const result = await api.workspace.interruptStream({
      workspaceId,
      options: { ...options, retireBashMonitorAttention: true },
    });
    if (!result.success) publishChatError(workspaceId, result.error);
  } catch (error) {
    // A transport failure (backend gone mid-click) is as invisible as an Err without this.
    publishChatError(workspaceId, getErrorMessage(error));
  }
}
