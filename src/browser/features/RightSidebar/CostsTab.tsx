import React from "react";
import { useWorkspaceUsage } from "@/browser/stores/WorkspaceStore";
import {
  sumUsageHistory,
  formatCostWithDollar,
  getTotalCost,
  type ChatUsageDisplay,
} from "@/common/utils/tokens/usageAggregator";
import { formatModelStringForDisplay } from "@/common/utils/ai/models";
import { normalizeUsageModelKey } from "@/common/utils/providers/modelEntries";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { ToggleGroup, type ToggleOption } from "@/browser/components/ToggleGroup/ToggleGroup";
import { TOKEN_COMPONENT_COLORS, formatTokens } from "@/common/utils/tokens/tokenMeterUtils";

import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";

type ViewMode = "last-request" | "session";

const VIEW_MODE_OPTIONS: Array<ToggleOption<ViewMode>> = [
  { value: "session", label: "Session" },
  { value: "last-request", label: "Last Request" },
];

interface CostsTabProps {
  workspaceId: string;
}

const CostsTabComponent: React.FC<CostsTabProps> = ({ workspaceId }) => {
  const usage = useWorkspaceUsage(workspaceId);
  const { config: providersConfig } = useProvidersConfig();
  const [viewMode, setViewMode] = usePersistedState<ViewMode>("costsTab:viewMode", "session");

  // Session usage for cost calculation
  // Uses sessionTotal (pre-computed) + liveCostUsage (cumulative during streaming)
  const sessionUsage = React.useMemo(() => {
    const parts: ChatUsageDisplay[] = [];
    if (usage.sessionTotal) parts.push(usage.sessionTotal);
    if (usage.liveCostUsage) parts.push(usage.liveCostUsage);
    return parts.length > 0 ? sumUsageHistory(parts) : undefined;
  }, [usage.sessionTotal, usage.liveCostUsage]);

  // Per-model session costs. Live streaming usage is not yet folded into the
  // persisted byModel record, so merge it into the active model's bucket to
  // keep rows consistent with the session total above.
  const sessionModelRows = (() => {
    const merged = new Map<string, ChatUsageDisplay>(Object.entries(usage.sessionByModel ?? {}));
    const liveModel = usage.liveCostUsage?.model;
    if (usage.liveCostUsage && liveModel) {
      // Same ledger key as the backend and WorkspaceStore deltas: live Coder
      // usage keys on the stream's request-pinned metadata identity
      // (liveMetadataModel) — re-resolving the raw coder:<instance>/<model>
      // against a mid-stream-refreshed providers config could re-key or
      // split the row from the backend's bucket. Non-Coder models keep the
      // canonical normalizeUsageModelKey.
      const key =
        liveModel.startsWith("coder:") && usage.liveMetadataModel
          ? usage.liveMetadataModel
          : normalizeUsageModelKey(liveModel, providersConfig);
      const existing = merged.get(key);
      merged.set(
        key,
        existing ? sumUsageHistory([existing, usage.liveCostUsage])! : usage.liveCostUsage
      );
    }
    return Array.from(merged.entries())
      .map(([model, entry]) => ({
        model,
        tokens:
          entry.input.tokens +
          entry.cached.tokens +
          entry.cacheCreate.tokens +
          entry.output.tokens +
          entry.reasoning.tokens,
        cost: getTotalCost(entry),
      }))
      .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.tokens - a.tokens);
  })();

  // Last Request (for Cost section): from persisted data
  const lastRequestUsage = usage.lastRequest?.usage;

  const hasCostData = sessionUsage !== undefined || lastRequestUsage !== undefined;

  if (!hasCostData) {
    return (
      <div className="text-light font-primary text-[13px] leading-relaxed">
        <div className="text-secondary px-5 py-10 text-center">
          <p>No messages yet.</p>
          <p>Send a message to see cost statistics.</p>
        </div>
      </div>
    );
  }

  // Cost and Details table use viewMode
  const displayUsage = viewMode === "last-request" ? lastRequestUsage : sessionUsage;

  const getCostPercentage = (cost: number | undefined, total: number | undefined) =>
    total !== undefined && total > 0 && cost !== undefined ? (cost / total) * 100 : 0;

  // Costs are already computed from shared model metadata when usage is recorded.
  // Repricing again here drifts from tiered per-request accounting, especially for
  // native 1M models and session aggregates that span multiple requests.
  const inputCost = displayUsage?.input.cost_usd;
  const outputCost = displayUsage?.output.cost_usd;
  const reasoningCost = displayUsage?.reasoning.cost_usd;

  // Calculate total cost (undefined if any cost is unknown)
  const totalCost: number | undefined = displayUsage
    ? inputCost !== undefined &&
      displayUsage.cached.cost_usd !== undefined &&
      displayUsage.cacheCreate.cost_usd !== undefined &&
      outputCost !== undefined &&
      reasoningCost !== undefined
      ? inputCost +
        displayUsage.cached.cost_usd +
        displayUsage.cacheCreate.cost_usd +
        outputCost +
        reasoningCost
      : undefined
    : undefined;

  // Calculate cost percentages from the shared metadata-driven costs.
  const inputCostPercentage = getCostPercentage(inputCost, totalCost);
  const cachedCostPercentage = getCostPercentage(displayUsage?.cached.cost_usd, totalCost);
  const cacheCreateCostPercentage = getCostPercentage(
    displayUsage?.cacheCreate.cost_usd,
    totalCost
  );
  const outputCostPercentage = getCostPercentage(outputCost, totalCost);
  const reasoningCostPercentage = getCostPercentage(reasoningCost, totalCost);

  const components = displayUsage
    ? [
        {
          name: "Cache Read",
          tokens: displayUsage.cached.tokens,
          cost: displayUsage.cached.cost_usd,
          color: TOKEN_COMPONENT_COLORS.cached,
          show: displayUsage.cached.tokens > 0,
        },
        {
          name: "Cache Create",
          tokens: displayUsage.cacheCreate.tokens,
          cost: displayUsage.cacheCreate.cost_usd,
          color: TOKEN_COMPONENT_COLORS.cacheCreate,
          show: displayUsage.cacheCreate.tokens > 0,
        },
        {
          name: "Input",
          tokens: displayUsage.input.tokens,
          cost: inputCost,
          color: TOKEN_COMPONENT_COLORS.input,
          show: true,
        },
        {
          name: "Output",
          tokens: displayUsage.output.tokens,
          cost: outputCost,
          color: TOKEN_COMPONENT_COLORS.output,
          show: true,
        },
        {
          name: "Thinking",
          tokens: displayUsage.reasoning.tokens,
          cost: reasoningCost,
          color: TOKEN_COMPONENT_COLORS.thinking,
          show: displayUsage.reasoning.tokens > 0,
        },
      ].filter((c) => c.show)
    : [];

  return (
    <div className="text-light font-primary text-[13px] leading-relaxed">
      <div data-testid="cost-section" className="mb-6">
        <div className="flex flex-col gap-3">
          {totalCost !== undefined && totalCost >= 0 && (
            <div data-testid="cost-bar" className="relative mb-2 flex flex-col gap-1">
              <div data-testid="cost-header" className="mb-2 flex items-baseline justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-foreground inline-flex items-baseline gap-1 font-medium">
                    Cost
                  </span>
                  <ToggleGroup
                    options={VIEW_MODE_OPTIONS}
                    value={viewMode}
                    onChange={setViewMode}
                  />
                </div>
                <span className="text-muted flex items-center gap-1 text-xs tabular-nums">
                  {formatCostWithDollar(totalCost)}
                  {displayUsage?.hasUnknownCosts && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-warning cursor-help">?</span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="max-w-[200px]">
                        Cost may be incomplete — some models in this session have unknown pricing
                      </TooltipContent>
                    </Tooltip>
                  )}
                </span>
              </div>
              <div className="relative w-full">
                <div className="bg-border-light flex h-1.5 w-full overflow-hidden rounded-[3px]">
                  {cachedCostPercentage > 0 && (
                    <div
                      className="h-full transition-[width] duration-300"
                      style={{
                        width: `${cachedCostPercentage}%`,
                        background: TOKEN_COMPONENT_COLORS.cached,
                      }}
                    />
                  )}
                  {cacheCreateCostPercentage > 0 && (
                    <div
                      className="h-full transition-[width] duration-300"
                      style={{
                        width: `${cacheCreateCostPercentage}%`,
                        background: TOKEN_COMPONENT_COLORS.cacheCreate,
                      }}
                    />
                  )}
                  <div
                    className="h-full transition-[width] duration-300"
                    style={{
                      width: `${inputCostPercentage}%`,
                      background: TOKEN_COMPONENT_COLORS.input,
                    }}
                  />
                  <div
                    className="h-full transition-[width] duration-300"
                    style={{
                      width: `${outputCostPercentage}%`,
                      background: TOKEN_COMPONENT_COLORS.output,
                    }}
                  />
                  {reasoningCostPercentage > 0 && (
                    <div
                      className="h-full transition-[width] duration-300"
                      style={{
                        width: `${reasoningCostPercentage}%`,
                        background: TOKEN_COMPONENT_COLORS.thinking,
                      }}
                    />
                  )}
                </div>
              </div>
            </div>
          )}
          <table data-testid="cost-details" className="mt-1 w-full border-collapse text-[11px]">
            <thead>
              <tr className="border-border-light border-b">
                <th className="text-muted py-1 pr-2 text-left font-medium [&:last-child]:pr-0 [&:last-child]:text-right">
                  Component
                </th>
                <th className="text-muted py-1 pr-2 text-left font-medium [&:last-child]:pr-0 [&:last-child]:text-right">
                  Tokens
                </th>
                <th className="text-muted py-1 pr-2 text-left font-medium [&:last-child]:pr-0 [&:last-child]:text-right">
                  Cost
                </th>
              </tr>
            </thead>
            <tbody>
              {components.map((component) => {
                const costDisplay = formatCostWithDollar(component.cost);
                const isNegligible =
                  component.cost !== undefined && component.cost > 0 && component.cost < 0.01;

                return (
                  <tr key={component.name}>
                    <td className="text-foreground py-1 pr-2 [&:last-child]:pr-0 [&:last-child]:text-right">
                      <div className="flex items-center gap-1.5">
                        <div
                          className="h-2 w-2 shrink-0 rounded-sm"
                          style={{ background: component.color }}
                        />
                        {component.name}
                      </div>
                    </td>
                    <td className="text-foreground py-1 pr-2 tabular-nums [&:last-child]:pr-0 [&:last-child]:text-right">
                      {formatTokens(component.tokens)}
                    </td>
                    <td className="text-foreground py-1 pr-2 tabular-nums [&:last-child]:pr-0 [&:last-child]:text-right">
                      {isNegligible ? (
                        <span className="text-dim italic">{costDisplay}</span>
                      ) : (
                        costDisplay
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {viewMode === "session" && sessionModelRows.length > 0 && (
            <table data-testid="cost-by-model" className="mt-4 w-full border-collapse text-[11px]">
              <thead>
                <tr className="border-border-light border-b">
                  <th className="text-muted py-1 pr-2 text-left font-medium [&:last-child]:pr-0 [&:last-child]:text-right">
                    Model
                  </th>
                  <th className="text-muted py-1 pr-2 text-left font-medium [&:last-child]:pr-0 [&:last-child]:text-right">
                    Tokens
                  </th>
                  <th className="text-muted py-1 pr-2 text-left font-medium [&:last-child]:pr-0 [&:last-child]:text-right">
                    Cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {sessionModelRows.map((row) => (
                  <tr key={row.model}>
                    <td className="text-foreground max-w-0 truncate py-1 pr-2 [&:last-child]:pr-0 [&:last-child]:text-right">
                      {formatModelStringForDisplay(row.model)}
                    </td>
                    <td className="text-foreground py-1 pr-2 tabular-nums [&:last-child]:pr-0 [&:last-child]:text-right">
                      {formatTokens(row.tokens)}
                    </td>
                    <td className="text-foreground py-1 pr-2 tabular-nums [&:last-child]:pr-0 [&:last-child]:text-right">
                      {formatCostWithDollar(row.cost)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};

export const CostsTab = React.memo(CostsTabComponent);
