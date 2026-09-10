/**
 * Voice input button - floats inside the chat input textarea.
 * Minimal footprint: just an icon that changes color based on state.
 */

import React from "react";
import { Mic, Loader2 } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { cn } from "@/common/lib/utils";
import type { VoiceInputState } from "@/browser/hooks/useVoiceInput";

interface VoiceInputButtonProps {
  state: VoiceInputState;
  isAvailable: boolean;
  shouldShowUI: boolean;
  requiresSecureContext: boolean;
  onToggle: () => void;
  disabled?: boolean;
  /** CSS color value for recording state (e.g., "var(--color-exec-mode)") */
  agentColor: string;
}

/** Color classes for non-recording voice input states */
const STATE_COLORS: Record<Exclude<VoiceInputState, "recording">, string> = {
  idle: "text-muted/50 hover:text-muted",
  requesting: "text-amber-500 animate-pulse",
  transcribing: "text-amber-500",
};

export const VoiceInputButton: React.FC<VoiceInputButtonProps> = (props) => {
  if (!props.shouldShowUI) return null;

  // Allow stop/cancel controls while actively recording or transcribing,
  // even if voice input became unavailable mid-session (e.g. from another window).
  const isActiveSession = props.state === "recording" || props.state === "transcribing";
  const needsHttps = props.requiresSecureContext;
  const notConfigured = !needsHttps && !props.isAvailable;
  const isDisabled = !isActiveSession && (needsHttps || notConfigured);

  const label = isDisabled
    ? needsHttps
      ? "Voice input (requires HTTPS)"
      : "Voice input (not configured)"
    : props.state === "recording"
      ? "Stop recording"
      : props.state === "transcribing"
        ? "Transcribing..."
        : "Voice input";

  const isRecording = props.state === "recording";
  const isTranscribing = props.state === "transcribing";
  const colorClass = isDisabled
    ? "text-muted/50"
    : isRecording
      ? "animate-pulse"
      : STATE_COLORS[props.state as keyof typeof STATE_COLORS];

  const Icon = isTranscribing ? Loader2 : Mic;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={props.onToggle}
          disabled={(props.disabled ?? false) || isTranscribing || isDisabled}
          aria-label={label}
          aria-pressed={isRecording}
          className={cn(
            "inline-flex items-center justify-center rounded p-0.5 transition-colors duration-150",
            "focus-visible:ring-accent focus-visible:ring-1",
            "disabled:cursor-not-allowed disabled:opacity-40",
            colorClass
          )}
          style={isRecording && !isDisabled ? { color: props.agentColor } : undefined}
        >
          <Icon className={cn("h-4 w-4", isTranscribing && "animate-spin")} strokeWidth={1.5} />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {needsHttps ? (
          <>
            Voice input requires a secure connection.
            <br />
            Use HTTPS or access via localhost.
          </>
        ) : notConfigured ? (
          <>
            Voice input requires a Xum Gateway login or an OpenAI API key.
            <br />
            Configure in Settings → Providers.
          </>
        ) : (
          <>
            <strong>Voice input</strong> —{" "}
            <span className="mobile-hide-shortcut-hints">press space on empty input</span>
            <br />
            <span className="mobile-hide-shortcut-hints">
              or {formatKeybind(KEYBINDS.TOGGLE_VOICE_INPUT)} anytime
            </span>
            <br />
            <br />
            <span className="mobile-hide-shortcut-hints">
              While recording: space sends, esc cancels
            </span>
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
};
