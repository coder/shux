import React from "react";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import {
  DEFAULT_TERMINAL_BADGE_CONFIG,
  TERMINAL_BADGE_CONFIG_KEY,
  normalizeTerminalBadgeConfig,
  type TerminalBadgeConfig,
  type TerminalBadgePosition,
} from "@/common/constants/storage";
import { formatTerminalBadge } from "@/browser/utils/terminalBadgeTemplate";

const POSITION_CLASSES: Record<TerminalBadgePosition, string> = {
  "top-left": "top-2 left-2",
  "top-right": "top-2 right-2",
  "bottom-left": "bottom-2 left-2",
  "bottom-right": "bottom-2 right-2",
};

interface TerminalBadgeOverlayProps {
  workspaceName: string;
  projectName: string;
  tabName: string;
  /** 0-based tab position; undefined when unknown (pop-out windows). */
  tabIndex?: number;
}

/**
 * Scroll-fixed workspace/tab watermark rendered above the terminal canvas
 * (iTerm2-style badge, issue #3607). Prompt markers scroll away with output
 * and sidebar tab labels aren't visible from inside the viewport, so this
 * overlay is the persistent identity cue. pointer-events/user-select are
 * disabled so clicks, drags, and text selection behave as if it were absent.
 */
export const TerminalBadgeOverlay: React.FC<TerminalBadgeOverlayProps> = (props) => {
  const [rawConfig] = usePersistedState<TerminalBadgeConfig>(
    TERMINAL_BADGE_CONFIG_KEY,
    DEFAULT_TERMINAL_BADGE_CONFIG,
    { listener: true }
  );
  const config = normalizeTerminalBadgeConfig(rawConfig);

  if (!config.enabled) {
    return null;
  }

  const text = formatTerminalBadge(config.template, {
    workspace: props.workspaceName,
    project: props.projectName,
    tab: props.tabName,
    index: props.tabIndex != null ? String(props.tabIndex + 1) : "",
  });
  if (!text) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute z-10 max-w-[75%] truncate font-medium select-none ${POSITION_CLASSES[config.position]}`}
      style={{
        color: "var(--color-terminal-fg)",
        opacity: config.opacity,
        fontSize: config.fontSize,
      }}
    >
      {text}
    </div>
  );
};
