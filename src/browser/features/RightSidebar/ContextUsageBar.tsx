import React from "react";
import { AlertTriangle } from "lucide-react";
import { TokenMeter } from "./TokenMeter";
import {
  HorizontalThresholdSlider,
  getAutoCompactionLabel,
  type AutoCompactionConfig,
} from "./ThresholdSlider";
import { formatTokens, type TokenMeterData } from "@/common/utils/tokens/tokenMeterUtils";
import { Toggle1MContext } from "@/browser/components/Toggle1MContext/Toggle1MContext";

interface ContextUsageBarProps {
  data: TokenMeterData;
  /** Auto-compaction settings for threshold slider */
  autoCompaction?: AutoCompactionConfig;
  /** Current model ID — used to show 1M context toggle for supported models */
  model?: string;
  showTitle?: boolean;
  testId?: string;
}

const ContextUsageBarComponent: React.FC<ContextUsageBarProps> = ({
  data,
  autoCompaction,
  model,
  showTitle = true,
  testId,
}) => {
  const totalDisplay = formatTokens(data.totalTokens);
  const maxDisplay = data.maxTokens ? ` / ${formatTokens(data.maxTokens)}` : "";
  const percentageDisplay = data.maxTokens ? ` (${data.totalPercentage.toFixed(1)}%)` : "";

  const showWarning = !data.maxTokens;
  const showThresholdSlider = Boolean(autoCompaction && data.maxTokens);
  const contextWarning = autoCompaction?.contextWarning;

  if (data.totalTokens === 0) return null;

  return (
    <div data-testid={testId} className="relative flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        {showTitle && (
          <span className="text-foreground inline-flex items-baseline gap-1 font-medium">
            Context Usage
          </span>
        )}
        <span className="text-muted text-xs tabular-nums">
          {totalDisplay}
          {maxDisplay}
          {percentageDisplay}
        </span>
      </div>

      <div className="relative w-full overflow-hidden py-2">
        <TokenMeter segments={data.segments} orientation="horizontal" />
        {showThresholdSlider && autoCompaction && (
          <HorizontalThresholdSlider config={autoCompaction} />
        )}
      </div>

      {autoCompaction?.rolloverEnabled && data.maxTokens && (
        <div className="text-muted counter-nums text-[11px]">
          {getAutoCompactionLabel(autoCompaction)}
        </div>
      )}
      {model && <Toggle1MContext model={model} />}

      {showWarning && (
        <div className="text-subtle mt-2 text-[11px] italic">
          Unknown model limits - showing relative usage only
        </div>
      )}
      {contextWarning && (
        <div className="text-warning mt-2 flex items-start gap-1 text-[11px]">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            Compaction model context ({formatTokens(contextWarning.compactionModelMaxTokens)}) is
            smaller than auto-compact threshold ({formatTokens(contextWarning.thresholdTokens)})
          </span>
        </div>
      )}
    </div>
  );
};

export const ContextUsageBar = React.memo(ContextUsageBarComponent);
