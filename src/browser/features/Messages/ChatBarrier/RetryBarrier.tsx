import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useAPI } from "@/browser/contexts/API";
import { useWorkspaceState } from "@/browser/stores/WorkspaceStore";
import { getLastMainRetryCandidateMessage } from "@/common/utils/messages/retryEligibility";
import { KEYBINDS, formatKeybind } from "@/browser/utils/ui/keybinds";
import { VIM_ENABLED_KEY } from "@/common/constants/storage";
import { getSendOptionsFromStorage } from "@/browser/utils/messages/sendOptions";
import { applyCompactionOverrides } from "@/browser/utils/messages/compactionOptions";
import { stopStream } from "@/browser/utils/stopStream";
import { publishChatError } from "@/browser/utils/chatErrorToasts";
import { formatSendMessageError } from "@/common/utils/errors/formatSendError";
import { getErrorMessage } from "@/common/utils/errors";

interface RetryBarrierProps {
  workspaceId: string;
  visible?: boolean;
}

export const RetryBarrier: React.FC<RetryBarrierProps> = (props) => {
  const { api } = useAPI();
  const workspaceState = useWorkspaceState(props.workspaceId);
  const [countdown, setCountdown] = useState(0);
  const [manualRetryError, setManualRetryError] = useState<string | null>(null);
  const [isManualRetrying, setIsManualRetrying] = useState(false);

  const [vimEnabled] = usePersistedState<boolean>(VIM_ENABLED_KEY, false, { listener: true });
  const stopKeybind = formatKeybind(
    vimEnabled ? KEYBINDS.INTERRUPT_STREAM_VIM : KEYBINDS.INTERRUPT_STREAM_NORMAL
  );

  const autoRetryStatus = workspaceState.autoRetryStatus;
  const isAutoRetryScheduled = autoRetryStatus?.type === "auto-retry-scheduled";
  const isAutoRetryActive =
    autoRetryStatus?.type === "auto-retry-scheduled" ||
    autoRetryStatus?.type === "auto-retry-starting";

  const manualRetryRollbackWorkspaceIdRef = useRef<string | null>(null);
  const manualRetryRollbackPendingRef = useRef(false);
  const manualRetryRollbackArmedRef = useRef(false);
  const manualRetryRollbackBaselineMessageCountRef = useRef<number | null>(null);
  const apiRef = useRef(api);

  useEffect(() => {
    apiRef.current = api;
  }, [api]);

  const rollbackManualRetryAutoRetryIfNeeded = useCallback(
    async (options?: { suppressErrors?: boolean }): Promise<void> => {
      if (!manualRetryRollbackPendingRef.current) {
        return;
      }

      const rollbackWorkspaceId = manualRetryRollbackWorkspaceIdRef.current;
      manualRetryRollbackPendingRef.current = false;
      manualRetryRollbackArmedRef.current = false;
      manualRetryRollbackBaselineMessageCountRef.current = null;
      manualRetryRollbackWorkspaceIdRef.current = null;

      const activeApi = apiRef.current;
      if (!activeApi || !rollbackWorkspaceId) {
        return;
      }

      const rollbackResult = await activeApi.workspace.setAutoRetryEnabled?.({
        workspaceId: rollbackWorkspaceId,
        enabled: false,
        persist: false,
      });
      if (rollbackResult && !rollbackResult.success && !options?.suppressErrors) {
        setManualRetryError(rollbackResult.error);
      }
    },
    []
  );

  useEffect(() => {
    if (!manualRetryRollbackPendingRef.current) {
      return;
    }

    const rollbackWorkspaceId = manualRetryRollbackWorkspaceIdRef.current;
    if (!rollbackWorkspaceId || rollbackWorkspaceId === props.workspaceId) {
      return;
    }

    void rollbackManualRetryAutoRetryIfNeeded();
  }, [props.workspaceId, rollbackManualRetryAutoRetryIfNeeded]);

  useEffect(() => {
    return () => {
      if (!manualRetryRollbackPendingRef.current) {
        return;
      }

      void rollbackManualRetryAutoRetryIfNeeded({ suppressErrors: true });
    };
  }, [rollbackManualRetryAutoRetryIfNeeded]);

  useEffect(() => {
    if (!manualRetryRollbackPendingRef.current) {
      return;
    }

    const autoRetryActive =
      autoRetryStatus?.type === "auto-retry-scheduled" ||
      autoRetryStatus?.type === "auto-retry-starting";
    const streamInFlight = workspaceState.isStreamStarting || workspaceState.canInterrupt;

    // Mirror ask_user rollback semantics: keep temporary enablement while the resumed
    // stream/retry attempt is in flight, then restore preference after terminal outcome.
    if (autoRetryActive || streamInFlight) {
      manualRetryRollbackArmedRef.current = true;
      return;
    }

    const baselineMessageCount = manualRetryRollbackBaselineMessageCountRef.current;
    const hasObservedPostRetryMessage =
      baselineMessageCount !== null && workspaceState.messages.length > baselineMessageCount;
    if (!manualRetryRollbackArmedRef.current && !hasObservedPostRetryMessage) {
      return;
    }

    void rollbackManualRetryAutoRetryIfNeeded();
  }, [
    autoRetryStatus,
    workspaceState.isStreamStarting,
    workspaceState.canInterrupt,
    workspaceState.messages.length,
    rollbackManualRetryAutoRetryIfNeeded,
  ]);

  useEffect(() => {
    if (!isAutoRetryScheduled) {
      setCountdown(0);
      return;
    }

    const updateCountdown = () => {
      const retryAt = autoRetryStatus.scheduledAt + autoRetryStatus.delayMs;
      const timeUntilRetry = Math.max(0, retryAt - Date.now());
      setCountdown(Math.ceil(timeUntilRetry / 1000));
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 100);
    return () => clearInterval(interval);
  }, [autoRetryStatus, isAutoRetryScheduled]);

  useEffect(() => {
    if (props.visible === false) {
      setManualRetryError(null);
    }
  }, [props.visible]);

  useEffect(() => {
    if (isAutoRetryActive) {
      setManualRetryError(null);
    }
  }, [isAutoRetryActive]);
  const handleManualRetry = async () => {
    if (!api) {
      setManualRetryError("Not connected to server");
      return;
    }

    if (isManualRetrying) {
      return;
    }

    setIsManualRetrying(true);
    setManualRetryError(null);

    try {
      let options = getSendOptionsFromStorage(props.workspaceId);
      const lastUserMessage = [...workspaceState.messages]
        .reverse()
        .find(
          (message): message is Extract<typeof message, { type: "user" }> => message.type === "user"
        );

      if (lastUserMessage?.compactionRequest) {
        options = applyCompactionOverrides(options, lastUserMessage.compactionRequest.parsed);
      }

      const enableResult = await api.workspace.setAutoRetryEnabled?.({
        workspaceId: props.workspaceId,
        enabled: true,
        persist: false,
      });
      if (enableResult && !enableResult.success) {
        setManualRetryError(enableResult.error);
        return;
      }

      if (enableResult?.success && enableResult.data.previousEnabled === false) {
        // Manual retry temporarily enables auto-retry for this resumed attempt.
        // Restore only when stream/retry outcome is terminal.
        manualRetryRollbackWorkspaceIdRef.current = props.workspaceId;
        manualRetryRollbackPendingRef.current = true;
        manualRetryRollbackArmedRef.current = false;
        manualRetryRollbackBaselineMessageCountRef.current = workspaceState.messages.length;
      }

      const resumeResult = await api.workspace.resumeStream({
        workspaceId: props.workspaceId,
        options,
      });

      if (!resumeResult.success) {
        const formatted = formatSendMessageError(resumeResult.error);
        const details = formatted.resolutionHint
          ? `${formatted.message} ${formatted.resolutionHint}`
          : formatted.message;
        setManualRetryError(details);

        // Keep preference consistent when resume fails before retry/stream events.
        await rollbackManualRetryAutoRetryIfNeeded();
        return;
      }

      if (
        manualRetryRollbackPendingRef.current &&
        !manualRetryRollbackArmedRef.current &&
        resumeResult.data.started === false
      ) {
        await rollbackManualRetryAutoRetryIfNeeded();
      }
    } catch (error) {
      setManualRetryError(getErrorMessage(error));
      await rollbackManualRetryAutoRetryIfNeeded();
    } finally {
      setIsManualRetrying(false);
    }
  };

  const handleStopAutoRetry = async () => {
    setCountdown(0);
    setManualRetryError(null);
    if (!api) return;
    // The Stop is acknowledged only once the session's auto-retry state is on disk, so the opt-out
    // must reach the session first or its write escapes that check.
    try {
      const optOut = await api.workspace.setAutoRetryEnabled?.({
        workspaceId: props.workspaceId,
        enabled: false,
      });
      if (optOut != null && !optOut.success) publishChatError(props.workspaceId, optOut.error);
    } catch (error) {
      publishChatError(props.workspaceId, getErrorMessage(error));
    }
    await stopStream(api, props.workspaceId);
  };

  const lastMessage = getLastMainRetryCandidateMessage(workspaceState.messages);
  const lastStreamError = lastMessage?.type === "stream-error" ? lastMessage : null;
  const interruptionReason = lastStreamError?.errorType === "rate_limit" ? "Rate limited" : null;
  const isWaitingForInitialResponse =
    lastMessage?.type === "user" && workspaceState.isStreamStarting;

  let statusIcon: React.ReactNode = (
    <AlertTriangle aria-hidden="true" className="text-warning h-4 w-4 shrink-0" />
  );
  let statusText: React.ReactNode = (
    <>
      {interruptionReason ??
        // A trailing user message means the backend has not emitted stream-start yet.
        // Long init hooks (for example over SSH) can legitimately keep us here, so avoid
        // claiming the stream was interrupted until we have evidence that it actually was.
        (isWaitingForInitialResponse
          ? "Response startup is taking longer than expected"
          : "Stream interrupted")}
    </>
  );
  let actionButton: React.ReactNode = (
    <button
      className="bg-warning font-primary text-background cursor-pointer rounded border-none px-4 py-2 text-xs font-semibold whitespace-nowrap transition-all duration-200 hover:-translate-y-px hover:brightness-120 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={isManualRetrying}
      onClick={() => {
        void handleManualRetry();
      }}
    >
      Retry
    </button>
  );

  if (isAutoRetryActive) {
    statusIcon = (
      <RefreshCw aria-hidden="true" className="text-warning h-4 w-4 shrink-0 animate-spin" />
    );

    const reasonPrefix = interruptionReason ? <>{interruptionReason} — </> : null;
    const retryAttempt = autoRetryStatus.attempt;

    if (autoRetryStatus.type === "auto-retry-starting" || countdown === 0) {
      statusText = (
        <>
          {reasonPrefix}
          Retrying... (attempt {retryAttempt})
        </>
      );
    } else {
      statusText = (
        <>
          {reasonPrefix}
          Retrying in <span className="text-warning font-mono font-semibold">
            {countdown}s
          </span>{" "}
          (attempt {retryAttempt})
        </>
      );
    }

    actionButton = (
      <button
        className="border-warning font-primary text-warning hover:bg-warning-overlay cursor-pointer rounded border bg-transparent px-4 py-2 text-xs font-semibold whitespace-nowrap transition-all duration-200 hover:-translate-y-px active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => {
          void handleStopAutoRetry();
        }}
      >
        Stop <span className="mobile-hide-shortcut-hints">({stopKeybind})</span>
      </button>
    );
  }

  const details = manualRetryError ? (
    <div className="font-primary text-foreground/80 pl-8 text-[12px]">
      <span className="text-warning font-semibold">Retry failed:</span> {manualRetryError}
    </div>
  ) : autoRetryStatus?.type === "auto-retry-abandoned" ? (
    <div className="font-primary text-foreground/80 pl-8 text-[12px]">
      <span className="text-warning font-semibold">Auto-retry stopped:</span>{" "}
      {autoRetryStatus.reason}
    </div>
  ) : null;

  if (props.visible === false) {
    return null;
  }

  return (
    <div className="border-warning my-5 flex flex-col gap-3 rounded border-l-4 bg-gradient-to-br from-[rgba(255,165,0,0.1)] to-[rgba(255,140,0,0.1)] px-5 py-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-1 items-center gap-3">
          <span className="shrink-0">{statusIcon}</span>
          <div className="font-primary text-foreground text-[13px] font-medium">{statusText}</div>
        </div>
        {actionButton}
      </div>
      {details}
    </div>
  );
};
