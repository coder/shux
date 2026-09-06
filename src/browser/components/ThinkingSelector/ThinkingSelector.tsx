import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Zap } from "lucide-react";

import { useAPI } from "@/browser/contexts/API";
import { useMinThinkingLevels } from "@/browser/hooks/useMinThinkingLevels";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { useReasoningMode } from "@/browser/hooks/useReasoningMode";
import { useRouting } from "@/browser/hooks/useRouting";
import { useThinkingLevel } from "@/browser/hooks/useThinkingLevel";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import {
  applyFastModeServiceTierChange,
  getFastModeProvider,
} from "@/browser/utils/fastModeServiceTier";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { cn } from "@/common/lib/utils";
import assert from "@/common/utils/assert";
import {
  getThinkingDisplayLabel,
  THINKING_LEVELS,
  type OpenAIReasoningMode,
  type ThinkingLevel,
} from "@/common/types/thinking";
import { openaiProModeAvailable } from "@/common/utils/ai/proMode";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { enforceThinkingPolicy, getAvailableThinkingLevels } from "@/common/utils/thinking/policy";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import { COMPOSER_PRO_HIDE_CLASS } from "@/constants/layout";
import { COMPOSER_PICKER_PANEL_CLASS, composerPickerOptionClass } from "../composerPickerStyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "../Tooltip/Tooltip";

const THINKING_OPTION_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

// Friendly option label, provider-aware for xhigh/max so menu rows match the
// trigger's branding (e.g. Opus 4.6 calls its top effort "Max", not "Extra High").
function getThinkingMenuLabel(level: ThinkingLevel, capabilityModel?: string): string {
  if (capabilityModel && (level === "xhigh" || level === "max")) {
    return getThinkingDisplayLabel(level, capabilityModel) === "XHIGH" ? "Extra High" : "Max";
  }
  return THINKING_OPTION_LABELS[level];
}

export interface ThinkingInheritOption {
  /** Row/trigger label shown while inherit is selected. */
  label: string;
  selected: boolean;
  onSelect: () => void;
}

interface ThinkingSelectorControlProps {
  modelString: string | undefined;
  codexOauthAccountId?: string;
  /** Delegated preferences may inherit a model that is only known at launch. */
  modelCapabilitiesDeferred?: boolean;
  /** Independent of effort/model inheritance; false denotes an explicit mode override. */
  reasoningModeInherited?: boolean;
  /** Nested tools enforce model capabilities without the chat-specific effort floor. */
  applyMinimumThinkingLevel?: boolean;
  thinkingLevel: ThinkingLevel;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  reasoningMode: OpenAIReasoningMode;
  onReasoningModeChange: (mode: OpenAIReasoningMode) => void;
  /** Some embedded clients cannot resolve route-aware provider options safely. */
  allowProMode?: boolean;
  /** Some embedded clients do not expose provider configuration mutations. */
  allowFastMode?: boolean;
  /** "composer": compact chat-input trigger, menu opens upward (default).
   *  "box": form-field trigger for settings pages, menu opens downward. */
  variant?: "composer" | "box";
  /** Optional "Inherit" row above the levels (settings defaults). */
  inheritOption?: ThinkingInheritOption;
}

/**
 * Controlled reasoning picker shared by the chat composer and settings pages.
 * Owns thinking-level policy resolution plus route-aware Pro/Fast mode
 * availability so every surface exposes the same feature set; callers only
 * supply the current values and persistence callbacks.
 */
export const ThinkingSelectorControl: React.FC<ThinkingSelectorControlProps> = (props) => {
  const { api } = useAPI();
  const { getMinimum } = useMinThinkingLevels();
  const { config: providersConfig, refresh, updateOptimistically } = useProvidersConfig();
  const routing = useRouting();
  const [isOpen, setIsOpen] = useState(false);
  const [fastModeSaving, setFastModeSaving] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const variant = props.variant ?? "composer";
  const inheritSelected = props.inheritOption?.selected === true;

  const modelCapabilitiesDeferred = props.modelCapabilitiesDeferred ?? false;
  const reasoningModeInherited = props.reasoningModeInherited === true;
  const { allowed, effectiveThinkingLevel, capabilityModel, proModeAvailable, fastModeProvider } =
    (() => {
      // The calling chat's model is unknown in Settings. Store preferences without
      // borrowing global Exec capabilities; the launch path enforces the real model's policy.
      if (modelCapabilitiesDeferred) {
        return {
          allowed: THINKING_LEVELS,
          effectiveThinkingLevel: props.thinkingLevel,
          capabilityModel: undefined,
          proModeAvailable: props.allowProMode !== false,
          fastModeProvider: null,
        };
      }

      assert(props.modelString, "A model is required unless capabilities are deferred");
      const minimum =
        props.applyMinimumThinkingLevel === false ? undefined : getMinimum(props.modelString);
      const resolvedRoute = routing.resolveRoute(normalizeToCanonical(props.modelString)).route;
      return {
        allowed: getAvailableThinkingLevels(props.modelString, minimum, providersConfig),
        effectiveThinkingLevel: enforceThinkingPolicy(
          props.modelString,
          props.thinkingLevel,
          minimum,
          providersConfig
        ),
        // Mapped aliases use the target model's ladder and provider-aware labels.
        capabilityModel: resolveModelForMetadata(props.modelString, providersConfig ?? null),
        proModeAvailable:
          props.allowProMode !== false &&
          openaiProModeAvailable(props.modelString, {
            providersConfig,
            resolvedRouteProvider: resolvedRoute,
            codexOauthAccountId: props.codexOauthAccountId,
          }),
        fastModeProvider:
          props.allowFastMode !== false && providersConfig != null
            ? getFastModeProvider(props.modelString, {
                providersConfig,
                resolvedRouteProvider: resolvedRoute,
                codexOauthAccountId: props.codexOauthAccountId,
              })
            : null,
      };
    })();
  const fastModeAvailable = fastModeProvider != null;
  const proModeActive =
    !reasoningModeInherited && proModeAvailable && props.reasoningMode === "pro";
  const fastModeActive =
    fastModeProvider != null && providersConfig?.[fastModeProvider]?.serviceTier === "priority";
  const hasMenu =
    allowed.length > 1 || proModeAvailable || fastModeAvailable || props.inheritOption != null;

  // The menu is rendered inline for happy-dom coverage, so a document listener is the
  // deterministic way to dismiss it when the user clicks elsewhere.
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const handleFastModeToggle = async () => {
    if (!api || fastModeSaving || providersConfig == null || fastModeProvider == null) return;

    setFastModeSaving(true);
    try {
      const providerConfig = providersConfig[fastModeProvider];
      const change = await applyFastModeServiceTierChange(
        api.providers,
        fastModeProvider,
        providerConfig?.serviceTier,
        providerConfig?.fastModePreviousServiceTier
      );
      if (change) {
        updateOptimistically(fastModeProvider, {
          serviceTier: change.serviceTier,
          fastModePreviousServiceTier: change.previousServiceTier,
        });
      } else {
        await refresh();
      }
    } catch {
      await refresh();
    } finally {
      setFastModeSaving(false);
    }
  };

  if (!hasMenu) {
    const fixedLevel = allowed[0] ?? "off";
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="text-foreground w-[5ch] shrink-0 text-center text-[11px] font-medium select-none"
            aria-label={`Thinking level fixed to ${fixedLevel}`}
          >
            {getThinkingDisplayLabel(fixedLevel, capabilityModel)}
          </span>
        </TooltipTrigger>
        <TooltipContent align="center">
          Model {props.modelString} locks thinking at{" "}
          {getThinkingDisplayLabel(fixedLevel, capabilityModel)} to match its capabilities.
        </TooltipContent>
      </Tooltip>
    );
  }

  const trigger =
    variant === "composer" ? (
      <button
        type="button"
        data-thinking-selector-trigger
        className="text-foreground hover:bg-hover focus-visible:bg-hover focus-visible:text-accent flex shrink-0 cursor-pointer items-center gap-0.5 rounded-sm bg-transparent py-0 pr-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={`Thinking: ${effectiveThinkingLevel}${proModeActive ? ", pro mode" : ""}${fastModeActive ? ", fast mode" : ""}`}
        onClick={() => setIsOpen((previous) => !previous)}
      >
        <span data-thinking-label className="min-w-[3ch] text-center">
          {modelCapabilitiesDeferred
            ? THINKING_OPTION_LABELS[effectiveThinkingLevel]
            : getThinkingDisplayLabel(effectiveThinkingLevel, capabilityModel)}
        </span>
        {proModeActive && (
          <span
            data-thinking-pro-status
            className={cn(
              "border-border-medium text-muted ml-0.5 rounded-[3px] border bg-transparent px-1 text-[9px] leading-[14px] font-semibold tracking-wide",
              COMPOSER_PRO_HIDE_CLASS
            )}
          >
            PRO
          </span>
        )}
        {fastModeActive && (
          <Zap
            data-fast-mode-indicator
            className="text-thinking-mode h-3 w-3 shrink-0"
            fill="currentColor"
            aria-label="Fast mode enabled"
          />
        )}
        <ChevronDown
          className={cn(
            "text-muted h-3 w-3 shrink-0 transition-transform duration-150",
            isOpen && "rotate-180"
          )}
          aria-hidden
        />
      </button>
    ) : (
      <button
        type="button"
        data-thinking-selector-trigger
        className="border-border-medium bg-modal-bg text-foreground focus:border-accent flex h-9 w-full cursor-pointer items-center justify-between gap-1 rounded border px-2 text-xs focus:outline-none"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label="Reasoning"
        onClick={() => setIsOpen((previous) => !previous)}
      >
        <span data-thinking-label className="min-w-0 flex-1 truncate text-left">
          {inheritSelected && props.inheritOption
            ? props.inheritOption.label
            : getThinkingMenuLabel(effectiveThinkingLevel, capabilityModel)}
        </span>
        {(proModeActive || props.reasoningModeInherited === false) && (
          <span
            data-thinking-pro-status
            className="border-border-medium text-muted rounded-[3px] border bg-transparent px-1 text-[9px] leading-[14px] font-semibold tracking-wide"
          >
            {props.reasoningMode === "pro" ? "PRO" : "STANDARD"}
          </span>
        )}
        {fastModeActive && (
          <Zap
            data-fast-mode-indicator
            className="text-thinking-mode h-3 w-3 shrink-0"
            fill="currentColor"
            aria-label="Fast mode enabled"
          />
        )}
        <ChevronDown
          className={cn(
            "text-muted h-3 w-3 shrink-0 transition-transform duration-150",
            isOpen && "rotate-180"
          )}
          aria-hidden
        />
      </button>
    );

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative",
        variant === "composer" ? "flex shrink-0 items-center" : "min-w-0 flex-1"
      )}
      data-component="ThinkingSelector"
      onKeyDown={(event) => {
        if (event.key === "Escape" && isOpen) {
          event.preventDefault();
          stopKeyboardPropagation(event);
          setIsOpen(false);
        }
      }}
    >
      {variant === "composer" ? (
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent align="center">
            Select thinking effort.
            <span className="mobile-hide-shortcut-hints">
              {" "}
              {formatKeybind(KEYBINDS.DECREASE_THINKING)} /{" "}
              {formatKeybind(KEYBINDS.INCREASE_THINKING)} to step.
            </span>
          </TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}

      {reasoningModeInherited && (
        <div className="text-muted mt-1 text-xs">Reasoning mode: Use calling chat’s Exec</div>
      )}

      {isOpen && (
        <div
          // Box menus open downward inside a scrollable settings pane; scroll the
          // menu into view on open so bottom rows aren't hidden below the fold.
          ref={variant === "box" ? (node) => node?.scrollIntoView({ block: "nearest" }) : undefined}
          className={cn(
            "absolute left-0 z-[1020] w-52",
            variant === "composer" ? "bottom-full mb-1" : "top-full mt-1 min-w-full",
            COMPOSER_PICKER_PANEL_CLASS
          )}
          data-component="ThinkingSelectorMenu"
        >
          <div className="text-muted border-border-light border-b px-2.5 py-1.5 text-[10px] font-semibold tracking-wide uppercase">
            Reasoning effort
          </div>
          <div className="py-1" role="listbox" aria-label="Reasoning effort">
            {props.inheritOption && (
              <button
                type="button"
                role="option"
                aria-label={props.inheritOption.label}
                aria-selected={inheritSelected}
                className={composerPickerOptionClass(
                  { isHighlighted: false, isSelected: inheritSelected },
                  "w-full py-1.5 text-left"
                )}
                onClick={props.inheritOption.onSelect}
              >
                <span className="text-foreground min-w-0 flex-1">{props.inheritOption.label}</span>
                {inheritSelected && <Check className="text-accent h-3 w-3 shrink-0" aria-hidden />}
              </button>
            )}
            {allowed.map((level) => {
              const selected = !inheritSelected && level === effectiveThinkingLevel;
              const label = getThinkingMenuLabel(level, capabilityModel);
              return (
                <button
                  key={level}
                  type="button"
                  role="option"
                  aria-label={label}
                  aria-selected={selected}
                  className={composerPickerOptionClass(
                    { isHighlighted: false, isSelected: selected },
                    "w-full py-1.5 text-left"
                  )}
                  onClick={() => props.onThinkingLevelChange(level)}
                >
                  <span className="text-foreground min-w-0 flex-1">{label}</span>
                  {selected && <Check className="text-accent h-3 w-3 shrink-0" aria-hidden />}
                </button>
              );
            })}
          </div>

          {(proModeAvailable || fastModeAvailable) && (
            <div className="border-border-light border-t py-1">
              {proModeAvailable && (
                <button
                  type="button"
                  data-component="ProModeToggle"
                  aria-pressed={reasoningModeInherited ? "mixed" : proModeActive}
                  className="hover:bg-hover flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left transition-colors"
                  onClick={() => props.onReasoningModeChange(proModeActive ? "standard" : "pro")}
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground block text-[11px] font-medium">Pro mode</span>
                    <span className="text-muted block text-[10px] font-normal">
                      {reasoningModeInherited
                        ? "Use calling chat’s Exec"
                        : "More reliable on difficult tasks"}
                    </span>
                  </span>
                  {proModeActive && <Check className="text-thinking-mode h-3 w-3" aria-hidden />}
                </button>
              )}

              {fastModeAvailable && (
                <button
                  type="button"
                  data-component="FastModeToggle"
                  aria-pressed={fastModeActive}
                  disabled={fastModeSaving}
                  className="hover:bg-hover disabled:text-muted flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left transition-colors disabled:cursor-default"
                  onClick={() => {
                    handleFastModeToggle().catch(() => undefined);
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground block text-[11px] font-medium">Fast mode</span>
                    <span className="text-muted block text-[10px] font-normal">
                      Faster responses at higher cost
                    </span>
                  </span>
                  {fastModeActive && <Check className="text-accent h-3 w-3 shrink-0" aria-hidden />}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

interface ThinkingSelectorProps {
  modelString: string;
  codexOauthAccountId?: string;
  /** Some embedded clients cannot resolve route-aware provider options safely. */
  allowProMode?: boolean;
  /** Some embedded clients do not expose provider configuration mutations. */
  allowFastMode?: boolean;
}

/** Chat-composer picker: the shared control wired to the workspace ThinkingContext. */
export const ThinkingSelector: React.FC<ThinkingSelectorProps> = (props) => {
  const [thinkingLevel, setThinkingLevel] = useThinkingLevel();
  const [reasoningMode, setReasoningMode] = useReasoningMode();

  return (
    <ThinkingSelectorControl
      modelString={props.modelString}
      codexOauthAccountId={props.codexOauthAccountId}
      thinkingLevel={thinkingLevel}
      onThinkingLevelChange={setThinkingLevel}
      reasoningMode={reasoningMode}
      onReasoningModeChange={setReasoningMode}
      allowProMode={props.allowProMode}
      allowFastMode={props.allowFastMode}
    />
  );
};
