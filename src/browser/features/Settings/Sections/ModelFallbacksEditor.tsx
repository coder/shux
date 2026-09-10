import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";

import { Button } from "@/browser/components/Button/Button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { useModelFallbacks } from "@/browser/hooks/useModelFallbacks";
import { useModelsFromSettings } from "@/browser/hooks/useModelsFromSettings";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import {
  MODEL_FALLBACK_CHAIN_LIMIT,
  normalizeFallbackModelKey,
} from "@/common/utils/ai/modelFallbacks";

const SELECT_TRIGGER_CLASS =
  "border-border-medium bg-background-secondary hover:bg-hover h-7 w-64 cursor-pointer rounded-md border px-2 text-xs transition-colors";

/**
 * Per-model refusal-fallback chain editor (Settings → Models).
 *
 * When a model refuses to respond (model_refusal), the turn transparently
 * retries or continues on the next model in its chain instead of failing
 * terminally. Chains are refusal-only by design: quota/auth/network errors
 * never trigger fallback.
 */
export function ModelFallbacksEditor() {
  const { modelFallbacks, setFallbackChain } = useModelFallbacks();
  const { models } = useModelsFromSettings();
  const { config: providersConfig } = useProvidersConfig();
  // Draft source model for a chain being created (entries with empty chains
  // are never persisted, so the first fallback pick materializes the entry).
  const [draftSource, setDraftSource] = useState<string | null>(null);

  const entries = Object.entries(modelFallbacks).sort(([a], [b]) => a.localeCompare(b));
  const configuredSources = new Set(entries.map(([source]) => source));
  // Settings can list aliases that canonicalize to the same model (e.g. a
  // gateway-prefixed copy of a built-in). Dedupe via the metadata-aware
  // fallback key so SelectItem values stay unique while cross-typed Coder
  // instances keep a chain distinct from the direct provider's.
  const modelCandidates = Array.from(
    new Set(models.map((model) => normalizeFallbackModelKey(model, providersConfig)))
  );
  const sourceCandidates = modelCandidates.filter((model) => !configuredSources.has(model));

  const chainFor = (source: string): string[] => modelFallbacks[source]?.models ?? [];

  const moveModel = (source: string, index: number, delta: -1 | 1) => {
    const chain = [...chainFor(source)];
    const target = index + delta;
    if (target < 0 || target >= chain.length) {
      return;
    }
    [chain[index], chain[target]] = [chain[target], chain[index]];
    setFallbackChain(source, chain);
  };

  const renderChainRow = (source: string, chain: string[]) => {
    const addCandidates = modelCandidates.filter(
      (model) => model !== source && !chain.includes(model)
    );

    return (
      <div key={source} className="border-border-medium space-y-2 rounded-md border px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <span className="text-muted text-xs">If </span>
            <span className="text-foreground font-mono text-xs">{source}</span>
            <span className="text-muted text-xs"> refuses, try in order:</span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Remove fallback chain for ${source}`}
            onClick={() => {
              setFallbackChain(source, []);
              setDraftSource(null);
            }}
            className="text-muted hover:text-error h-6 shrink-0 px-1.5 text-xs"
          >
            <X className="h-3.5 w-3.5" />
            Remove chain
          </Button>
        </div>
        <ol className="space-y-1">
          {chain.map((model, index) => (
            <li key={model} className="flex items-center gap-1.5">
              <span className="text-muted w-4 text-right font-mono text-xs">{index + 1}.</span>
              <span className="text-foreground min-w-0 flex-1 truncate font-mono text-xs">
                {model}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Move ${model} earlier in ${source} fallback chain`}
                disabled={index === 0}
                onClick={() => moveModel(source, index, -1)}
                className="h-6 w-6 shrink-0 p-0"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Move ${model} later in ${source} fallback chain`}
                disabled={index === chain.length - 1}
                onClick={() => moveModel(source, index, 1)}
                className="h-6 w-6 shrink-0 p-0"
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove ${model} from ${source} fallback chain`}
                onClick={() =>
                  setFallbackChain(
                    source,
                    chain.filter((_, i) => i !== index)
                  )
                }
                className="text-muted hover:text-error h-6 w-6 shrink-0 p-0"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ol>
        {chain.length < MODEL_FALLBACK_CHAIN_LIMIT && addCandidates.length > 0 && (
          <Select
            value=""
            onValueChange={(model) => {
              setFallbackChain(source, [...chain, model]);
              // The first pick materializes a drafted chain; clear the draft so
              // the persisted entry doesn't render twice.
              setDraftSource(null);
            }}
          >
            <SelectTrigger
              aria-label={`Add fallback model for ${source}`}
              className={SELECT_TRIGGER_CLASS}
            >
              <SelectValue placeholder="Add fallback model…" />
            </SelectTrigger>
            <SelectContent>
              {addCandidates.map((model) => (
                <SelectItem key={model} value={model}>
                  {model}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <div className="text-muted text-xs font-medium tracking-wide uppercase">Model Fallbacks</div>
      <p className="text-muted text-xs">
        When a model refuses to respond, retry the turn — or continue from partial output — on the
        next model in its fallback chain. Applies only to refusals — never to quota, auth, or
        network errors. Up to {MODEL_FALLBACK_CHAIN_LIMIT} fallback models per chain.
      </p>

      {entries.map(([source, entry]) => renderChainRow(source, entry.models))}

      {draftSource !== null &&
      !configuredSources.has(normalizeFallbackModelKey(draftSource, providersConfig)) ? (
        renderChainRow(
          normalizeFallbackModelKey(draftSource, providersConfig),
          chainFor(normalizeFallbackModelKey(draftSource, providersConfig))
        )
      ) : (
        <div className="flex items-center gap-2">
          <Select value="" onValueChange={(model) => setDraftSource(model)}>
            <SelectTrigger
              aria-label="Add fallback chain for model"
              className={SELECT_TRIGGER_CLASS}
            >
              <SelectValue placeholder="Add fallback chain for model…" />
            </SelectTrigger>
            <SelectContent>
              {sourceCandidates.map((model) => (
                <SelectItem key={model} value={model}>
                  {model}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Plus className="text-muted h-3.5 w-3.5" aria-hidden />
        </div>
      )}
    </div>
  );
}
