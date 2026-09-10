import { useEffect, useRef, useState } from "react";
import { useActiveGoalCount } from "@/browser/stores/WorkspaceStore";

const ACTIVE_GOAL_WARNING_THRESHOLD = 3;
const AUTO_DISMISS_MS = 5_000;
// max() keeps the toast below the iOS standalone status-bar band (black-translucent
// positions fixed elements against the full screen, including the top safe area).
const wrapperClassName =
  "pointer-events-none fixed top-[max(1rem,env(safe-area-inset-top,0px))] right-4 z-[10000] max-w-[min(420px,calc(100vw-2rem))] [&>*]:pointer-events-auto";

interface ActiveGoalsWarningToastProps {
  activeGoalCount: number;
}

export function ActiveGoalsWarningToast(props: ActiveGoalsWarningToastProps) {
  const [toastCount, setToastCount] = useState<number | null>(null);
  const wasAboveThresholdRef = useRef(false);

  useEffect(() => {
    const isAboveThreshold = props.activeGoalCount > ACTIVE_GOAL_WARNING_THRESHOLD;
    if (!isAboveThreshold) {
      wasAboveThresholdRef.current = false;
      setToastCount(null);
      return;
    }

    // Warn on the rising edge only so several stream-end updates during the same elevated
    // active-goal period do not spam the user.
    if (wasAboveThresholdRef.current) {
      return;
    }

    wasAboveThresholdRef.current = true;
    setToastCount(props.activeGoalCount);
  }, [props.activeGoalCount]);

  useEffect(() => {
    if (toastCount == null || typeof window === "undefined") {
      return;
    }

    const timeoutId = window.setTimeout(() => setToastCount(null), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timeoutId);
  }, [toastCount]);

  if (toastCount == null) {
    return null;
  }

  return (
    <div className={wrapperClassName}>
      <div
        role="status"
        aria-live="polite"
        className="bg-background-secondary border-warning text-warning flex animate-[toastSlideIn_0.2s_ease-out] items-start gap-2 rounded border px-3 py-2 text-xs shadow-[0_4px_12px_rgba(0,0,0,0.3)]"
      >
        <span className="bg-warning mt-1 inline-block h-2 w-2 shrink-0 rounded-full" />
        <span>
          You have {toastCount} active goals running concurrently. Goal continuations will fire
          serially across workspaces.
        </span>
      </div>
    </div>
  );
}

export function WorkspaceActiveGoalsWarningToast() {
  const activeGoalCount = useActiveGoalCount();

  return <ActiveGoalsWarningToast activeGoalCount={activeGoalCount} />;
}
