import React from "react";
import { useProviderOptions } from "@/browser/hooks/useProviderOptions";
import { cn } from "@/common/lib/utils";
import { supports1MContext } from "@/common/utils/ai/models";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";

interface Toggle1MContextProps {
  /** Model ID to check/toggle 1M context for */
  model: string;
  /** Optional label shown next to the toggle (defaults to "1M context") */
  label?: string;
}

/**
 * Compact toggle for model-level 1M context mode (beta UI).
 * Only renders when the model supports 1M context.
 * State is synced across all instances via ProviderOptionsContext.
 */
export const Toggle1MContext: React.FC<Toggle1MContextProps> = (props) => {
  const { has1MContext, toggle1MContext } = useProviderOptions();
  const { config: providersConfig } = useProvidersConfig();

  // 1M context is a runtime model capability, gated on the runtime model —
  // not inherited through "Treat as" model mapping. Coder gateway instances
  // resolve through their instance type (the gateway is a transparent proxy).
  if (!supports1MContext(props.model, providersConfig)) return null;

  const label = props.label ?? "1M context";
  const enabled = has1MContext(props.model);

  return (
    <button
      type="button"
      onClick={() => toggle1MContext(props.model)}
      className={cn(
        "flex cursor-pointer items-center gap-1.5 text-[11px] transition-colors",
        enabled ? "text-accent" : "text-muted hover:text-foreground"
      )}
      aria-label={enabled ? `Disable ${label}` : `Enable ${label}`}
    >
      <span
        className={cn(
          "flex h-4 w-6 items-center justify-center rounded-sm font-mono text-[9px] font-bold",
          enabled ? "bg-accent/15 text-accent" : "bg-background-tertiary text-muted"
        )}
      >
        1M
      </span>
      <span>
        {label}
        <span className="text-muted ml-1 text-[10px]">(beta)</span>
      </span>
    </button>
  );
};
