import type { APIClient } from "@/browser/contexts/API";
import { publishChatError } from "@/browser/utils/chatErrorToasts";
import { getErrorMessage } from "@/common/utils/errors";

/**
 * User Stop: interrupts the stream and dismisses owed background monitor output instead of letting
 * it wake the agent. A Stop the backend could not record on disk may resume on restart, so its
 * failure is shown in the workspace's chat input rather than dropped with the Result.
 *
 * `disableAutoRetry` lands the retry opt-out before the Stop: the Stop is acknowledged only once
 * the session's auto-retry state is on disk, so an opt-out still in flight would escape that check
 * and a trailing row could replay on restart.
 */
export async function stopStream(
  api: APIClient,
  workspaceId: string,
  options?: { abandonPartial?: boolean; disableAutoRetry?: boolean }
): Promise<void> {
  const { disableAutoRetry, ...interruptOptions } = options ?? {};
  if (disableAutoRetry) {
    try {
      const optOut = await api.workspace.setAutoRetryEnabled?.({ workspaceId, enabled: false });
      if (optOut != null && !optOut.success) publishChatError(workspaceId, optOut.error);
    } catch (error) {
      publishChatError(workspaceId, getErrorMessage(error));
    }
  }
  const result = await api.workspace.interruptStream({
    workspaceId,
    options: { ...interruptOptions, retireBashMonitorAttention: true },
  });
  if (!result.success) {
    publishChatError(workspaceId, result.error);
  }
}
