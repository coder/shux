import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronDown, Route, SquareCode } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { useAgent } from "@/browser/contexts/AgentContext";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import { normalizeAgentId as normalizeStoredAgentId } from "@/common/utils/agentIds";
import { cn } from "@/common/lib/utils";
import {
  COMPOSER_PICKER_PANEL_CLASS,
  composerPickerOptionClass,
} from "@/browser/components/composerPickerStyles";
import { DocsLink } from "@/browser/components/DocsLink/DocsLink";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { Button } from "@/browser/components/Button/Button";
import {
  formatKeybind,
  formatNumberedKeybind,
  KEYBINDS,
  matchNumberedKeybind,
  isDesktopViewportFocused,
} from "@/browser/utils/ui/keybinds";
import { sortAgentsStable } from "@/browser/utils/agents";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { COMPOSER_CONTROL_HEIGHT_CLASS, COMPOSER_ICON_ONLY_HIDE_CLASS } from "@/constants/layout";

interface AgentModePickerProps {
  className?: string;

  /**
   * Overrides when the trigger drops to icon-only, because the width the label needs depends on
   * which sibling controls share its row.
   */
  iconOnlyHideClassName?: string;

  /** Called when the picker closes (best-effort). Useful for restoring focus. */
  onComplete?: () => void;
}

interface AgentOption {
  id: string;
  name: string;
  uiColor?: string;
  description?: string;
  /** Source scope: built-in, project, or global */
  scope: "built-in" | "project" | "global";
  /** Base agent ID for inheritance */
  base?: string;
  /** Tool add/remove patterns */
  tools?: { add?: string[]; remove?: string[] };
  /** AI defaults (model, thinking level) */
  aiDefaults?: { model?: string; thinkingLevel?: string };
  /** Whether this agent can be spawned as a subagent */
  subagentRunnable: boolean;
}

/** Maps well-known agent IDs to lucide icons for the dropdown */
const AGENT_ICONS: Record<string, LucideIcon> = {
  plan: Route,
  exec: SquareCode,
};
const DEFAULT_AGENT_ICON: LucideIcon = Bot;

function getAgentIcon(agentId: string): LucideIcon {
  return AGENT_ICONS[agentId] ?? DEFAULT_AGENT_ICON;
}

export function formatAgentIdLabel(agentId: string): string {
  if (!agentId) {
    return "Agent";
  }

  // Best-effort humanization for IDs (e.g. "code-review" -> "Code Review").
  const parts = agentId.split(/[-_]+/g).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return agentId;
  }

  return parts
    .map((part) => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function normalizeAgentId(value: unknown): string {
  return normalizeStoredAgentId(value, "");
}

function resolveAgentOptions(agents: AgentDefinitionDescriptor[]): AgentOption[] {
  return sortAgentsStable(agents.filter((entry) => entry.uiSelectable));
}

export const AgentModePicker: React.FC<AgentModePickerProps> = (props) => {
  const {
    agentId,
    setAgentId,
    agents,
    loaded,
    currentAgent,
    isAgentSelectionLocked = false,
  } = useAgent();

  const onComplete = props.onComplete;
  const iconOnlyHideClassName = props.iconOnlyHideClassName ?? COMPOSER_ICON_ONLY_HIDE_CLASS;

  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const dropdownItemRefs = useRef<Array<HTMLDivElement | null>>([]);

  const normalizedAgentId = normalizeAgentId(agentId);

  const options = useMemo(() => resolveAgentOptions(agents), [agents]);

  const activeDescriptor =
    currentAgent?.id === normalizedAgentId
      ? currentAgent
      : agents.find((entry) => entry.id === normalizedAgentId);
  const isAgentLocked = isAgentSelectionLocked;

  // Derived "effectively open" — hides picker immediately when lock activates,
  // preventing stale event handlers from a hidden-but-open picker.
  const isPickerVisible = isPickerOpen && !isAgentLocked;

  const activeOption = !normalizedAgentId
    ? null
    : !activeDescriptor
      ? ({
          // Unknown agent (not in discovery) — show a fallback option
          id: normalizedAgentId,
          name: formatAgentIdLabel(normalizedAgentId),
          uiColor: undefined,
          scope: "project" as const,
          subagentRunnable: false,
        } satisfies AgentOption)
      : ({
          id: activeDescriptor.id,
          name: activeDescriptor.name,
          uiColor: activeDescriptor.uiColor,
          description: activeDescriptor.description,
          scope: activeDescriptor.scope,
          base: activeDescriptor.base,
          tools: activeDescriptor.tools,
          aiDefaults: activeDescriptor.aiDefaults,
          subagentRunnable: activeDescriptor.subagentRunnable,
        } satisfies AgentOption);

  const openPicker = useCallback(
    (opts?: { highlightAgentId?: string }) => {
      if (isAgentLocked) {
        return;
      }

      setIsPickerOpen(true);

      // Pre-select the current agent (or specified) in the list.
      const targetId = opts?.highlightAgentId ?? normalizedAgentId;
      const currentIndex = options.findIndex((opt) => opt.id === targetId);
      setHighlightedIndex(currentIndex >= 0 ? currentIndex : 0);

      // Focus the dropdown container for keyboard navigation.
      requestAnimationFrame(() => {
        dropdownRef.current?.focus();
      });
    },
    [isAgentLocked, normalizedAgentId, options]
  );

  const closePicker = useCallback(() => {
    setIsPickerOpen(false);
    setHighlightedIndex(-1);
    onComplete?.();
  }, [onComplete]);

  // Hotkey integration (open via AgentContext).
  useEffect(() => {
    const handleOpen = () => {
      openPicker({ highlightAgentId: normalizedAgentId });
    };

    window.addEventListener(CUSTOM_EVENTS.OPEN_AGENT_PICKER, handleOpen as EventListener);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.OPEN_AGENT_PICKER, handleOpen as EventListener);
  }, [normalizedAgentId, openPicker]);

  useEffect(() => {
    const handleClose = () => {
      if (!isPickerOpen) {
        return;
      }
      closePicker();
    };

    window.addEventListener(CUSTOM_EVENTS.CLOSE_AGENT_PICKER, handleClose as EventListener);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.CLOSE_AGENT_PICKER, handleClose as EventListener);
  }, [closePicker, isPickerOpen]);

  // Close picker when clicking outside.
  useEffect(() => {
    if (!isPickerVisible) {
      return;
    }

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current?.contains(e.target as Node)) {
        return;
      }
      closePicker();
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [closePicker, isPickerVisible]);

  // Scroll highlighted item into view.
  useEffect(() => {
    if (highlightedIndex < 0) {
      return;
    }

    const el = dropdownItemRefs.current[highlightedIndex];
    el?.scrollIntoView?.({ block: "nearest" });
  }, [highlightedIndex]);

  const handleSelectAgent = useCallback(
    (nextAgentId: string) => {
      if (isAgentLocked) {
        return;
      }

      const normalized = normalizeAgentId(nextAgentId);
      if (!normalized) {
        return;
      }

      setAgentId(normalized);
      closePicker();
    },
    [closePicker, isAgentLocked, setAgentId]
  );

  // Global Cmd/Ctrl+1-9 shortcuts when dropdown is open.
  useEffect(() => {
    if (!isPickerVisible) return;

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (isDesktopViewportFocused(e.target)) return;
      const index = matchNumberedKeybind(e);
      if (index < 0) return;

      e.preventDefault();
      e.stopPropagation();

      if (index < options.length) {
        const picked = options[index];
        if (picked) {
          handleSelectAgent(picked.id);
        }
      }
    };

    // Use capture phase to intercept before other handlers
    window.addEventListener("keydown", handleGlobalKeyDown, true);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown, true);
  }, [isPickerVisible, options, handleSelectAgent]);

  const handleDropdownKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      // Block capture-phase listeners (e.g. ImmersiveReviewView) from
      // consuming Escape before the picker closes
      stopKeyboardPropagation(e);
      closePicker();
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (options.length === 0) return;

      const selectedIndex = highlightedIndex >= 0 ? highlightedIndex : 0;
      const picked = options[selectedIndex];
      if (picked) {
        handleSelectAgent(picked.id);
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((prev) => Math.min(prev + 1, options.length - 1));
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (highlightedIndex <= 0) {
        closePicker();
        return;
      }
      setHighlightedIndex((prev) => Math.max(prev - 1, 0));
      return;
    }
  };

  // Resolve display properties for the trigger pill
  const activeDisplayName = activeOption?.name ?? formatAgentIdLabel(normalizedAgentId);
  const activeStyle: React.CSSProperties | undefined = activeOption?.uiColor
    ? { color: activeOption.uiColor }
    : undefined;
  const activeClassName = activeOption?.uiColor ? "" : "text-exec-mode";
  const TriggerIcon = getAgentIcon(normalizedAgentId);

  return (
    <div ref={containerRef} className={cn("relative flex items-center gap-1.5", props.className)}>
      {/* Dropdown trigger */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            aria-label="Select agent"
            aria-expanded={isPickerVisible}
            disabled={isAgentLocked}
            size="xs"
            variant="ghost"
            onClick={() => {
              if (isPickerOpen) {
                closePicker();
              } else {
                openPicker();
              }
            }}
            style={activeStyle}
            className={cn(
              "text-foreground border-border-light hover:bg-hover flex items-center gap-1.5 rounded-md border px-1.5 text-[11px] font-medium transition-[background-color] duration-150 [&_svg]:size-2.5!",
              COMPOSER_CONTROL_HEIGHT_CLASS,
              activeClassName
            )}
          >
            {/* Keep the mode glyph at the label's visual cap height so Exec reads as one aligned unit. */}
            <TriggerIcon className="shrink-0" />
            {/* shrink-0 leaves iconOnlyHideClassName as the only thing that hides this label. Without
              it a tight row shrinks the label to a letter and an ellipsis instead. */}
            <span
              className={cn(
                "max-w-[clamp(4.5rem,30vw,130px)] shrink-0 truncate",
                iconOnlyHideClassName
              )}
            >
              {activeDisplayName}
            </span>
            {!isAgentLocked && (
              <ChevronDown
                className={cn(
                  "text-muted h-3 w-3 shrink-0 transition-transform duration-150",
                  iconOnlyHideClassName,
                  isPickerOpen && "rotate-180"
                )}
              />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent align="start" className="max-w-80 whitespace-normal">
          {/* Name the active agent here because narrow composers render the trigger icon-only. */}
          <strong>{activeDisplayName}</strong>
          <br />
          Selects an agent definition (system prompt + tool policy).
          <br />
          <br />
          Open picker: {formatKeybind(KEYBINDS.TOGGLE_AGENT)}
          <br />
          Cycle agents: {formatKeybind(KEYBINDS.CYCLE_AGENT)}
          <br />
          Quick select: {formatNumberedKeybind(0).replace("1", "1-9")} (when open)
          <br />
          <br />
          <DocsLink path="/agents">Learn more about agents</DocsLink>
        </TooltipContent>
      </Tooltip>

      {isPickerVisible && (
        <div
          ref={dropdownRef}
          tabIndex={-1}
          onKeyDown={handleDropdownKeyDown}
          // Left alignment prevents the menu from opening beyond the viewport.
          className={cn(
            "absolute bottom-full left-0 z-[1020] mb-1 min-w-52",
            COMPOSER_PICKER_PANEL_CLASS
          )}
        >
          <div className="max-h-64 overflow-y-auto py-1">
            {!loaded && options.length === 0 ? (
              <div className="text-muted-light px-2.5 py-2 text-[11px]">Loading agents…</div>
            ) : options.length === 0 ? (
              <div className="text-muted-light px-2.5 py-2 text-[11px]">No agents available</div>
            ) : (
              options.map((opt, index) => {
                const isHighlighted = index === highlightedIndex;
                const isSelected = opt.id === normalizedAgentId;
                const Icon = getAgentIcon(opt.id);
                // Keybind label matches the item's position in the dropdown.
                const keybindLabel = formatNumberedKeybind(index);

                return (
                  <div
                    key={opt.id}
                    ref={(el) => (dropdownItemRefs.current[index] = el)}
                    role="button"
                    tabIndex={-1}
                    data-agent-id={opt.id}
                    data-testid="agent-option"
                    className={composerPickerOptionClass({ isHighlighted, isSelected }, "py-1.5")}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onClick={() => handleSelectAgent(opt.id)}
                  >
                    <Icon
                      className="h-4 w-4 shrink-0"
                      style={opt.uiColor ? { color: opt.uiColor } : undefined}
                    />
                    <span
                      data-testid="agent-name"
                      className={cn("min-w-0 flex-1 truncate", isSelected && "text-accent")}
                    >
                      {opt.name}
                    </span>
                    {keybindLabel && (
                      <span className="text-muted-light mobile-hide-shortcut-hints ml-auto text-[10px] tabular-nums">
                        {keybindLabel}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};
