import React, { useRef } from "react";
import {
  AUTO_COMPACTION_THRESHOLD_MIN,
  AUTO_COMPACTION_THRESHOLD_MAX,
  FORCE_COMPACTION_BUFFER_PERCENT,
} from "@/common/constants/ui";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";

// ----- Types -----

export interface AutoCompactionConfig {
  threshold: number;
  rolloverEnabled?: boolean;
  setThreshold: (threshold: number) => void;
  /**
   * Warning if the compaction model context window is smaller than the
   * auto-compact threshold, which could make compaction fail.
   */
  contextWarning?: {
    compactionModelMaxTokens: number;
    thresholdTokens: number;
  };
}

// ----- Constants -----

/** Threshold at which we consider auto-compaction disabled (dragged all the way to end) */
const DISABLE_THRESHOLD = 100;

/** Size of the triangle markers in pixels */
const TRIANGLE_SIZE = 4;

// ----- Subcomponents -----

/** CSS triangle pointing up or down */
const Triangle: React.FC<{ direction: "up" | "down"; color: string }> = ({ direction, color }) => {
  const styles: React.CSSProperties = {
    width: 0,
    height: 0,
    borderLeft: `${TRIANGLE_SIZE}px solid transparent`,
    borderRight: `${TRIANGLE_SIZE}px solid transparent`,
    ...(direction === "down"
      ? { borderTop: `${TRIANGLE_SIZE}px solid ${color}` }
      : { borderBottom: `${TRIANGLE_SIZE}px solid ${color}` }),
  };
  return <div style={styles} />;
};

// ----- Utilities -----

/** Clamp and snap percentage to valid threshold values */
const snapPercent = (raw: number): number => {
  const clamped = Math.max(AUTO_COMPACTION_THRESHOLD_MIN, Math.min(100, raw));
  return Math.round(clamped / 5) * 5;
};

/** Apply threshold, handling the disable case */
const applyThreshold = (pct: number, setThreshold: (v: number) => void): void => {
  setThreshold(pct >= DISABLE_THRESHOLD ? 100 : Math.min(pct, AUTO_COMPACTION_THRESHOLD_MAX));
};

/** Share the effective automatic policy label between the meter and its settings. */
export function getAutoCompactionLabel(config: AutoCompactionConfig): string {
  if (config.rolloverEnabled) {
    // Match the evaluator's force threshold; "by" allows the hard ceiling to win earlier.
    return config.threshold < DISABLE_THRESHOLD
      ? `Rolls over by ${config.threshold + FORCE_COMPACTION_BUFFER_PERCENT}%`
      : "Automatic rollover disabled";
  }
  return config.threshold < DISABLE_THRESHOLD
    ? `Auto-compact at ${config.threshold}%`
    : "Auto-compact disabled";
}

// ----- Main component -----

/**
 * A draggable threshold indicator for horizontal progress bars.
 * Renders as a vertical line with up/down triangle handles.
 * Drag left/right to adjust threshold. Drag to 100% (right) to disable.
 *
 * USAGE: Place as a sibling AFTER the progress bar, both inside a relative container.
 *
 * NOTE: This component uses inline styles instead of Tailwind classes intentionally.
 * When using Tailwind classes (e.g., `className="absolute cursor-ew-resize"`), the
 * component would intermittently fail to render or receive pointer events, despite
 * the React component mounting correctly. The root cause appears to be related to
 * how Tailwind's JIT compiler or class application interacts with dynamically
 * rendered components in this context. Inline styles work reliably.
 */
export const ThresholdSlider: React.FC<{ config: AutoCompactionConfig }> = ({ config }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const pointerId = e.pointerId;
    const calcPercent = (clientX: number) =>
      snapPercent(((clientX - rect.left) / rect.width) * 100);

    const apply = (pct: number) => applyThreshold(pct, config.setThreshold);

    apply(calcPercent(e.clientX));

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      ev.preventDefault();
      apply(calcPercent(ev.clientX));
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  };

  const isEnabled = config.threshold < DISABLE_THRESHOLD;
  const color = isEnabled ? "var(--color-plan-mode)" : "var(--color-muted)";
  const tooltipText = `${getAutoCompactionLabel(config)} · ${isEnabled ? "Drag to adjust" : "Drag left to enable"} (per-model)`;

  // Container styles - covers the full bar area for drag handling
  // Uses pointer-events: none by default, only the indicator handle has pointer-events: auto
  // This allows the token meter tooltip to work when hovering elsewhere on the bar
  const containerStyle: React.CSSProperties = {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 50,
    pointerEvents: "none",
  };

  // Drag handle around the indicator - this captures pointer events (mouse + touch)
  const DRAG_ZONE_SIZE = 16; // pixels on each side of the indicator
  const handleStyle: React.CSSProperties = {
    position: "absolute",
    cursor: "ew-resize",
    pointerEvents: "auto",
    // Prevent page scrolling while dragging the slider on touch devices.
    touchAction: "none",
    left: `calc(${config.threshold}% - ${DRAG_ZONE_SIZE}px)`,
    width: DRAG_ZONE_SIZE * 2,
    top: 0,
    bottom: 0,
  };

  // Indicator positioning
  const indicatorStyle: React.CSSProperties = {
    position: "absolute",
    pointerEvents: "none",
    display: "flex",
    alignItems: "center",
    flexDirection: "column",
    left: `${config.threshold}%`,
    top: "50%",
    transform: "translate(-50%, -50%)",
  };

  return (
    <div ref={containerRef} style={containerStyle}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div style={handleStyle} onPointerDown={handlePointerDown} />
        </TooltipTrigger>
        <TooltipContent side="top" showArrow={false}>
          {tooltipText}
        </TooltipContent>
      </Tooltip>

      {/* Visual indicator - pointer events disabled */}
      <div style={indicatorStyle}>
        <Triangle direction="down" color={color} />
        <div style={{ width: 1, height: 6, background: color }} />
        <Triangle direction="up" color={color} />
      </div>
    </div>
  );
};

/** Horizontal threshold slider (alias for backwards compatibility) */
export const HorizontalThresholdSlider = ThresholdSlider;
