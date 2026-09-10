import { Check, Eye, Info, Pencil, Star, Trash2, X } from "lucide-react";
import { createEditKeyHandler } from "@/browser/utils/ui/keybinds";
import { SearchableModelSelect } from "@/browser/features/Settings/Components/SearchableModelSelect";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import { Button } from "@/browser/components/Button/Button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { ProviderIcon, ProviderWithIcon } from "@/browser/components/ProviderIcon/ProviderIcon";
import { formatModelDisplayName } from "@/common/utils/ai/modelDisplay";
import { cn } from "@/common/lib/utils";
import type { AvailableRoute } from "@/common/routing";
import { getModelStatsResolved, type ModelStats } from "@/common/utils/tokens/modelStats";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { getThinkingOptionLabel, type ThinkingLevel } from "@/common/types/thinking";
import {
  getAvailableThinkingLevels,
  getThinkingPolicyForModel,
  hasExplicitThinkingPolicy,
  resolveMinimumThinkingLevel,
} from "@/common/utils/thinking/policy";

/** Format tokens as human-readable string (e.g. 200000 -> "200k") */
function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const k = tokens / 1_000;
    return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`;
  }
  return tokens.toString();
}

/** Format cost per million tokens (e.g. 0.000001 -> "$1.00") */
function formatCostPerMillion(costPerToken: number): string {
  const perMillion = costPerToken * 1_000_000;
  if (perMillion < 0.01) return "~$0.00";
  return `$${perMillion.toFixed(2)}`;
}

function ModelTooltipContent(props: {
  fullId: string;
  aliases?: string[];
  stats: ModelStats | null;
}) {
  return (
    <div className="max-w-xs space-y-2 text-xs">
      <div className="text-foreground font-mono">{props.fullId}</div>

      {props.aliases && props.aliases.length > 0 && (
        <div className="text-muted">
          <span className="text-muted-light">Aliases: </span>
          {props.aliases.join(", ")}
        </div>
      )}

      {props.stats && (
        <>
          <div className="border-separator-light border-t pt-2">
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              <div className="text-muted-light">Context Window</div>
              <div className="text-foreground">
                {formatTokenCount(props.stats.max_input_tokens)}
              </div>

              {props.stats.max_output_tokens && (
                <>
                  <div className="text-muted-light">Max Output</div>
                  <div className="text-foreground">
                    {formatTokenCount(props.stats.max_output_tokens)}
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="border-separator-light border-t pt-2">
            <div className="text-muted-light mb-1">Pricing (per 1M tokens)</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              <div className="text-muted-light">Input</div>
              <div className="text-foreground">
                {formatCostPerMillion(props.stats.input_cost_per_token)}
              </div>

              <div className="text-muted-light">Output</div>
              <div className="text-foreground">
                {formatCostPerMillion(props.stats.output_cost_per_token)}
              </div>

              {props.stats.cache_read_input_token_cost !== undefined && (
                <>
                  <div className="text-muted-light">Cache Read</div>
                  <div className="text-foreground">
                    {formatCostPerMillion(props.stats.cache_read_input_token_cost)}
                  </div>
                </>
              )}

              {props.stats.cache_creation_input_token_cost !== undefined && (
                <>
                  <div className="text-muted-light">Cache Write</div>
                  <div className="text-foreground">
                    {formatCostPerMillion(props.stats.cache_creation_input_token_cost)}
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {!props.stats && <div className="text-muted-light italic">No pricing data available</div>}
    </div>
  );
}

/**
 * Inline toggle that slides between the model's base context window and 1M.
 * Renders as a compact pill: clicking toggles the state, with the active
 * end highlighted in accent.
 */
function ContextWindowSlider(props: {
  baseTokens: number;
  enabled: boolean;
  onToggle: () => void;
}) {
  const baseLabel = formatTokenCount(props.baseTokens);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            props.onToggle();
          }}
          className="border-border-medium bg-background-tertiary flex items-center gap-px rounded-full border px-0.5 py-px"
          aria-label={props.enabled ? "Disable 1M context (beta)" : "Enable 1M context (beta)"}
        >
          <span
            className={cn(
              "rounded-full px-1.5 py-0.5 text-[10px] leading-none font-medium transition-colors",
              !props.enabled ? "bg-background-secondary text-foreground" : "text-muted"
            )}
          >
            {baseLabel}
          </span>
          <span
            className={cn(
              "rounded-full px-1.5 py-0.5 font-mono text-[10px] leading-none font-bold transition-colors",
              props.enabled ? "bg-accent/20 text-accent" : "text-muted"
            )}
          >
            1M
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {props.enabled ? "1M context enabled (beta)" : "Enable 1M context (beta)"}
      </TooltipContent>
    </Tooltip>
  );
}

export interface ModelRowProps {
  provider: string;
  modelId: string;
  fullId: string;
  aliases?: string[];
  isCustom: boolean;
  isDefault: boolean;
  isEditing: boolean;
  editModelValue?: string;
  editContextValue?: string;
  editMappedToModel?: string;
  editAutofocus?: "model" | "context";
  customContextWindowTokens?: number | null;
  mappedToModel?: string | null;
  allModels?: string[];
  editError?: string | null;
  saving?: boolean;
  hasActiveEdit?: boolean;
  /** Route chosen by resolver for this model */
  resolvedRoute?: {
    route: string;
    isAuto: boolean;
    displayName: string;
  };
  /** What route Auto would pick (priority-walk only, ignoring overrides) */
  autoResolvedRoute?: {
    route: string;
    displayName: string;
  };
  /** Configured routes that can serve this model */
  availableRoutes?: AvailableRoute[];
  /** Whether 1M context is enabled for this model */
  is1MContextEnabled?: boolean;
  /** Whether this model is hidden from the selector */
  isHiddenFromSelector?: boolean;
  onSetDefault: () => void;
  onStartEdit?: () => void;
  onStartContextEdit?: () => void;
  onSaveEdit?: () => void;
  onCancelEdit?: () => void;
  onEditModelChange?: (value: string) => void;
  onEditContextChange?: (value: string) => void;
  onEditMappedToModelChange?: (value: string) => void;
  onRemove?: () => void;
  /** Set/clear explicit route override (null = auto) */
  onSetRouteOverride?: (route: string | null) => void;
  /** Explicit per-model minimum thinking override (null/undefined = built-in default floor) */
  minThinkingLevel?: ThinkingLevel | null;
  /** Set/clear the per-model minimum thinking override (null = use default) */
  onSetMinThinkingLevel?: (level: ThinkingLevel | null) => void;
  /** Toggle 1M context for this model (only shown when defined, i.e. model supports it) */
  onToggle1MContext?: () => void;
  /** Toggle visibility in model selector */
  onToggleVisibility?: () => void;
  /**
   * Providers config for metadata-aware identity resolution. Coder gateway
   * rows (coder:<instance>/<model>) derive pricing/context/thinking data from
   * the instance's TYPE, which arbitrary instance names cannot convey.
   */
  providersConfig?: ProvidersConfigMap | null;
}

export function ModelRow(props: ModelRowProps) {
  const providersConfig = props.providersConfig ?? null;
  const stats = getModelStatsResolved(props.mappedToModel ?? props.fullId, providersConfig);

  const contextBaseTokens = props.customContextWindowTokens ?? stats?.max_input_tokens ?? null;
  const mappedProvider = props.mappedToModel ? props.mappedToModel.split(":")[0] || null : null;
  // Use slice after the first colon to preserve any additional colons in the model ID
  // (e.g. "ollama:gpt-oss:20b" → "gpt-oss:20b", not "gpt-oss").
  const mappedModelId = props.mappedToModel
    ? props.mappedToModel.slice(props.mappedToModel.indexOf(":") + 1) || props.mappedToModel
    : null;
  const mappedModelDisplayName = mappedModelId ? formatModelDisplayName(mappedModelId) : null;

  const configuredRoutes = (props.availableRoutes ?? []).filter((route) => route.isConfigured);
  // The Auto label must show the priority-walk result (ignoring overrides), not the
  // currently-active route — otherwise it mirrors whatever explicit override is selected.
  const autoRouteDisplayName =
    props.autoResolvedRoute?.displayName ?? configuredRoutes[0]?.displayName ?? "Direct";
  const routeDisplayName =
    props.resolvedRoute?.displayName ?? configuredRoutes[0]?.displayName ?? "Direct";
  const routeSelectValue =
    props.resolvedRoute && !props.resolvedRoute.isAuto ? props.resolvedRoute.route : "auto";

  // Per-model minimum thinking: only models Xum explicitly recognizes as reasoning models
  // (with more than one level to choose from) expose a floor control. Unrecognized /
  // non-reasoning models and single-level models (e.g. gpt-5-pro) keep the legacy behavior
  // with no selector. The dropdown lists the model's full capability so users can pick any
  // floor, including off/low.
  const thinkingCapability = getThinkingPolicyForModel(props.fullId, providersConfig);
  const supportsMinThinking =
    hasExplicitThinkingPolicy(props.fullId, providersConfig) && thinkingCapability.length > 1;
  // The selected value is the effective floor shown as a plain level (no "Default" wording).
  // It's always one of the capability options since available levels are a capability subset.
  const minThinkingFloorLevel = getAvailableThinkingLevels(
    props.fullId,
    resolveMinimumThinkingLevel(props.fullId, props.minThinkingLevel, providersConfig),
    providersConfig
  )[0];

  // Editing mode - render as a full-width row
  if (props.isEditing) {
    return (
      <tr className="border-border-medium border-b">
        <td colSpan={5} className="px-2 py-1.5 md:px-3">
          <div>
            <div className="flex items-center gap-2">
              <ProviderWithIcon
                provider={props.provider}
                displayName
                className="text-muted w-16 shrink-0 overflow-hidden text-xs md:w-20"
              />
              <input
                type="text"
                value={props.editModelValue ?? props.modelId}
                onChange={(e) => props.onEditModelChange?.(e.target.value)}
                onKeyDown={createEditKeyHandler({
                  onSave: () => props.onSaveEdit?.(),
                  onCancel: () => props.onCancelEdit?.(),
                })}
                className="bg-modal-bg border-border-medium focus:border-accent min-w-0 flex-1 rounded border px-2 py-0.5 font-mono text-xs focus:outline-none"
                autoFocus={props.editAutofocus !== "context"}
              />
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={props.editContextValue ?? ""}
                onChange={(e) => props.onEditContextChange?.(e.target.value)}
                onKeyDown={createEditKeyHandler({
                  onSave: () => props.onSaveEdit?.(),
                  onCancel: () => props.onCancelEdit?.(),
                })}
                className="bg-modal-bg border-border-medium focus:border-accent w-28 shrink-0 rounded border px-2 py-0.5 text-right font-mono text-xs focus:outline-none"
                placeholder="context"
                autoFocus={props.editAutofocus === "context"}
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={props.onSaveEdit}
                disabled={props.saving}
                className="text-accent hover:text-accent-dark h-6 w-6"
                title="Save changes (Enter)"
              >
                <Check className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={props.onCancelEdit}
                disabled={props.saving}
                className="text-muted hover:text-foreground h-6 w-6"
                title="Cancel (Escape)"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
            {props.isCustom && props.allModels && (
              <div className="mt-1.5 flex items-center gap-2">
                <span className="text-muted w-16 shrink-0 text-xs md:w-20">Treat as</span>
                <SearchableModelSelect
                  value={props.editMappedToModel ?? ""}
                  onChange={(value) => props.onEditMappedToModelChange?.(value)}
                  models={props.allModels}
                  placeholder="Select model..."
                  emptyOption={{ value: "", label: "None (use own metadata)" }}
                  compact
                />
              </div>
            )}
          </div>
          {props.editError && <div className="text-error mt-1 text-xs">{props.editError}</div>}
        </td>
      </tr>
    );
  }

  return (
    <tr
      className={cn(
        "border-border-medium hover:bg-background-secondary/50 group border-b transition-colors",
        props.isHiddenFromSelector && "opacity-50"
      )}
    >
      {/* Model ID + Provider + Aliases */}
      <td className="min-w-0 py-1.5 pr-2 pl-2 md:pl-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0" title={props.provider}>
            <ProviderIcon provider={props.provider} className="text-muted h-3.5 w-3.5" />
          </span>
          <span className="text-foreground min-w-0 truncate font-mono text-xs">
            {props.modelId}
          </span>
          {mappedModelDisplayName && (
            <span className="text-muted ml-1 flex shrink-0 items-center gap-1 text-[10px]">
              →
              {mappedProvider && (
                <ProviderIcon provider={mappedProvider} className="text-muted h-3 w-3" />
              )}
              {mappedModelDisplayName}
            </span>
          )}
          {props.aliases && props.aliases.length > 0 && (
            <span className="text-muted-light shrink-0 text-xs">({props.aliases[0]})</span>
          )}
        </div>
      </td>

      {/* Context Window — inline slider for models that support 1M context */}
      <td className="w-16 py-1.5 pr-2 md:w-20">
        {props.onToggle1MContext && contextBaseTokens ? (
          <ContextWindowSlider
            baseTokens={contextBaseTokens}
            enabled={props.is1MContextEnabled ?? false}
            onToggle={props.onToggle1MContext}
          />
        ) : !stats && props.onStartContextEdit ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              props.onStartContextEdit?.();
            }}
            disabled={Boolean(props.saving) || Boolean(props.hasActiveEdit)}
            className="text-muted hover:text-foreground ml-auto block text-right text-xs disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="Edit context window"
          >
            {contextBaseTokens ? formatTokenCount(contextBaseTokens) : "—"}
          </button>
        ) : contextBaseTokens ? (
          <span className="text-muted block text-right text-xs">
            {formatTokenCount(contextBaseTokens)}
          </span>
        ) : props.onStartContextEdit ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              props.onStartContextEdit?.();
            }}
            disabled={Boolean(props.saving) || Boolean(props.hasActiveEdit)}
            className="text-muted hover:text-foreground ml-auto block text-right text-xs disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="Edit context window"
          >
            —
          </button>
        ) : (
          <span className="text-muted block text-right text-xs">—</span>
        )}
      </td>

      {/* Route */}
      <td className="w-32 py-1.5 pr-2 md:w-40">
        {configuredRoutes.length > 1 && props.onSetRouteOverride ? (
          <Select
            value={routeSelectValue}
            onValueChange={(value) => props.onSetRouteOverride?.(value === "auto" ? null : value)}
          >
            <SelectTrigger className="h-7 min-w-0 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto ({autoRouteDisplayName})</SelectItem>
              {configuredRoutes.map((route) => (
                <SelectItem key={route.route} value={route.route}>
                  {route.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-muted block text-xs">{routeDisplayName}</span>
        )}
      </td>

      {/* Min Thinking */}
      <td className="w-28 py-1.5 pr-2 md:w-32">
        {supportsMinThinking && props.onSetMinThinkingLevel ? (
          <Select
            value={minThinkingFloorLevel}
            onValueChange={(value) => props.onSetMinThinkingLevel?.(value as ThinkingLevel)}
          >
            <SelectTrigger className="h-7 min-w-0 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {thinkingCapability.map((level) => (
                <SelectItem key={level} value={level}>
                  {getThinkingOptionLabel(level, props.fullId)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-muted block text-xs">—</span>
        )}
      </td>

      {/* Actions */}
      <td className="w-28 py-1.5 pr-2 md:w-32 md:pr-3">
        <div className="flex items-center justify-end gap-0.5">
          {/* Info tooltip */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="text-muted hover:text-foreground p-0.5 transition-colors"
                aria-label="Model details"
              >
                <Info className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" align="end" className="p-3">
              <ModelTooltipContent fullId={props.fullId} aliases={props.aliases} stats={stats} />
            </TooltipContent>
          </Tooltip>
          {/* Visibility toggle button */}
          {props.onToggleVisibility && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                props.onToggleVisibility?.();
              }}
              className={cn(
                "relative p-0.5 transition-colors",
                props.isHiddenFromSelector ? "text-muted-light" : "text-muted hover:text-foreground"
              )}
              aria-label={
                props.isHiddenFromSelector ? "Show in model selector" : "Hide from model selector"
              }
            >
              <Eye
                className={cn(
                  "h-3.5 w-3.5",
                  props.isHiddenFromSelector ? "opacity-30" : "opacity-70"
                )}
              />
              {props.isHiddenFromSelector && (
                <span className="bg-muted-light absolute inset-0 m-auto h-px w-4 rotate-45" />
              )}
            </button>
          )}
          {/* Favorite/default button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!props.isDefault) props.onSetDefault();
                  }}
                  className={cn(
                    "p-0.5 transition-colors",
                    props.isDefault
                      ? "cursor-default text-yellow-400"
                      : "text-muted hover:text-yellow-400"
                  )}
                  disabled={props.isDefault}
                  aria-label={props.isDefault ? "Current default model" : "Set as default model"}
                >
                  <Star className={cn("h-3.5 w-3.5", props.isDefault && "fill-current")} />
                </button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              {props.isDefault
                ? "Default model for new workspaces"
                : "Set as default for new workspaces"}
            </TooltipContent>
          </Tooltip>
          {/* Edit/delete buttons only for custom models */}
          {props.isCustom && (
            <>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onStartEdit?.();
                }}
                disabled={Boolean(props.saving) || Boolean(props.hasActiveEdit)}
                className="text-muted hover:text-foreground p-0.5 transition-colors"
                aria-label="Edit model"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onRemove?.();
                }}
                disabled={Boolean(props.saving) || Boolean(props.hasActiveEdit)}
                className="text-muted hover:text-error p-0.5 transition-colors"
                aria-label="Remove model"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}
