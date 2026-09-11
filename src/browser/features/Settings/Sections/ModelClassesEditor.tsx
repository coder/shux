import { X } from "lucide-react";

import { Button } from "@/browser/components/Button/Button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { useModelClasses } from "@/browser/hooks/useModelClasses";
import { useModelsFromSettings } from "@/browser/hooks/useModelsFromSettings";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { useRouting } from "@/browser/hooks/useRouting";
import {
  getThinkingOptionLabel,
  parseThinkingInput,
  type ThinkingLevel,
} from "@/common/types/thinking";
import { isModelServableWithProvidersConfig } from "@/common/utils/ai/modelAvailability";
import {
  buildModelClassValue,
  CANONICAL_MODEL_CLASSES,
  parseModelClassValue,
  splitModelClassValue,
} from "@/common/utils/ai/skillModelClasses";
import { getThinkingPolicyForModel, resolveThinkingInput } from "@/common/utils/thinking/policy";

const MODEL_SELECT_TRIGGER_CLASS =
  "border-border-medium bg-background-secondary hover:bg-hover h-7 w-64 cursor-pointer rounded-md border px-2 text-xs transition-colors";
const THINKING_SELECT_TRIGGER_CLASS =
  "border-border-medium bg-background-secondary hover:bg-hover h-7 w-28 cursor-pointer rounded-md border px-2 text-xs transition-colors";

/** Sentinel Select value for "no thinking suffix" (Radix rejects empty item values). */
const THINKING_DEFAULT_OPTION = "default";

/**
 * Model class editor (Settings → Models).
 *
 * Model classes are the indirection behind per-skill model routing: skills
 * bind to a class name (frontmatter `metadata: model-class`, or the
 * `skillModelClasses` table in config.json) and the class maps to a concrete
 * model here. When models change, updating the class re-routes every bound
 * skill at once.
 *
 * The editor surfaces exactly the canonical classes (large/medium/small) so
 * skill bindings stay portable across machines; hand-edited custom classes in
 * config.json keep working and are preserved on save, but are not editable
 * here.
 */
export function ModelClassesEditor() {
  const {
    modelClasses,
    loaded: classesLoaded,
    pendingWrites,
    writeError,
    setModelClass,
  } = useModelClasses();
  const { models } = useModelsFromSettings();
  const { config: providersConfig } = useProvidersConfig();
  const routing = useRouting();

  // Candidates keep their EXACT selection identity: a direct model and its
  // explicit gateway form (openai:x vs openrouter:openai/x, coder:anthropic/x)
  // dispatch differently and must both stay selectable — deduping by a
  // canonical/metadata key would collapse them and hide whichever the
  // Settings list happens to order second. Only exact duplicates dedupe
  // (SelectItem values must be unique).
  const modelCandidates = Array.from(new Set(models));

  const canonicalNames: readonly string[] = CANONICAL_MODEL_CLASSES;
  const customEntries = Object.entries(modelClasses)
    .filter(([name]) => !canonicalNames.includes(name))
    .sort(([a], [b]) => a.localeCompare(b));

  const renderClassRow = (className: string) => {
    const rawValue = modelClasses[className];
    const parsed = rawValue ? parseModelClassValue(rawValue) : null;
    const { thinkingSuffix } = rawValue ? splitModelClassValue(rawValue) : { thinkingSuffix: null };
    const selectedModel = parsed?.model ?? "";
    // Show numeric (model-relative) suffixes as the level they resolve to for
    // the selected model; re-saving through the select writes the named level.
    // providersConfig resolves mappedToModel aliases — the send-path resolver
    // passes it too, so the ladder shown here matches what routing will use.
    const selectedThinking: ThinkingLevel | null =
      parsed?.thinkingLevel != null && parsed.model
        ? resolveThinkingInput(parsed.thinkingLevel, parsed.model, providersConfig)
        : null;
    const thinkingOptions = selectedModel
      ? getThinkingPolicyForModel(selectedModel, providersConfig)
      : [];
    // On a model switch, carry the raw thinking suffix only when it stays
    // meaningful: numeric suffixes are model-relative by design, named levels
    // must exist in the new model's ladder, and an unparseable suffix (the
    // "invalid value" repair case) is dropped so picking a model actually
    // fixes the row instead of re-persisting a value sanitization-era builds
    // would have deleted.
    const carrySuffixTo = (nextModel: string): string | null => {
      if (parsed == null || thinkingSuffix == null) {
        return null;
      }
      const parsedSuffix = parseThinkingInput(thinkingSuffix);
      if (parsedSuffix == null) {
        return null;
      }
      if (typeof parsedSuffix === "number") {
        return thinkingSuffix;
      }
      return getThinkingPolicyForModel(nextModel, providersConfig).includes(parsedSuffix)
        ? thinkingSuffix
        : null;
    };
    // Ensure the selected model is offerable even if hidden from the picker
    // list (e.g. a hand-configured custom model).
    const rowModelCandidates =
      selectedModel && !modelCandidates.includes(selectedModel)
        ? [selectedModel, ...modelCandidates]
        : modelCandidates;
    // Proactive churn warning: the class points at a model no configured
    // route can serve (skill sends bound to it will fail with the same
    // verdict). Null providersConfig = still loading — say nothing yet. The
    // verdict also waits for routing.loaded: judging against the default
    // ["direct"] priority would flash a false warning on gateway-routed
    // setups every time Settings opens.
    const modelUnavailable =
      parsed != null &&
      providersConfig != null &&
      routing.loaded &&
      !isModelServableWithProvidersConfig({
        canonicalModel: parsed.model,
        routePriority: routing.routePriority,
        routeOverrides: routing.routeOverrides,
        providersConfig,
      });
    // State publishes on the write's ack, so a second edit made before the ack
    // would compose against the still-old rendered value and overwrite the
    // first edit. Disable the row's controls until its write settles.
    const rowWritePending = (pendingWrites[className] ?? 0) > 0;
    const rowDisabled = !classesLoaded || rowWritePending;

    return (
      <div
        key={className}
        role="group"
        aria-label={`Model class ${className}`}
        // flex-wrap: on narrow screens the availability warning wraps to its
        // own full-width line instead of truncating into an unreadable stub.
        className="flex flex-wrap items-center gap-2"
      >
        <span className="text-foreground w-16 shrink-0 font-mono text-xs">{className}</span>
        <Select
          value={selectedModel}
          onValueChange={(model) =>
            setModelClass(className, buildModelClassValue(model, carrySuffixTo(model)))
          }
          disabled={rowDisabled}
        >
          <SelectTrigger
            aria-label={`Model for class ${className}`}
            className={MODEL_SELECT_TRIGGER_CLASS}
          >
            <SelectValue placeholder="No model (class unset)…" />
          </SelectTrigger>
          <SelectContent>
            {rowModelCandidates.map((model) => (
              <SelectItem key={model} value={model}>
                {model}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={selectedThinking ?? THINKING_DEFAULT_OPTION}
          onValueChange={(level) =>
            setModelClass(
              className,
              buildModelClassValue(selectedModel, level === THINKING_DEFAULT_OPTION ? null : level)
            )
          }
          disabled={!selectedModel || rowDisabled}
        >
          <SelectTrigger
            aria-label={`Thinking level for class ${className}`}
            className={THINKING_SELECT_TRIGGER_CLASS}
          >
            <SelectValue placeholder="thinking" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={THINKING_DEFAULT_OPTION}>default</SelectItem>
            {thinkingOptions.map((level) => (
              <SelectItem key={level} value={level}>
                {getThinkingOptionLabel(level, selectedModel)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {rawValue !== undefined && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Clear model class ${className}`}
            onClick={() => setModelClass(className, null)}
            disabled={rowDisabled}
            className="text-muted hover:text-error h-6 w-6 shrink-0 p-0"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
        {rawValue !== undefined && parsed == null && (
          <TooltipIfPresent tooltip={rawValue}>
            <span className="text-error truncate text-xs">invalid value: {rawValue}</span>
          </TooltipIfPresent>
        )}
        {modelUnavailable && (
          <span className="text-warning min-w-0 text-xs">
            no configured route can serve this model — update this class
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <div className="text-muted text-xs font-medium tracking-wide uppercase">Model Classes</div>
      <p className="text-muted text-xs">
        Size classes for per-skill model routing. A skill bound to a class (frontmatter{" "}
        <span className="font-mono">metadata: model-class</span>, or the{" "}
        <span className="font-mono">skillModelClasses</span> table in config.json) runs on the
        class&apos;s model for that invocation only — your workspace model is untouched. When models
        change, update the class here and every bound skill follows.
      </p>

      <div className="space-y-1.5">{canonicalNames.map((name) => renderClassRow(name))}</div>

      {writeError != null && (
        // A failed write reverts the selection to the backend's value; without
        // this the change would appear to snap back for no reason.
        <p role="alert" className="text-error text-xs break-words">
          Could not save the model class: {writeError}
        </p>
      )}

      {customEntries.length > 0 && (
        // break-all: hand-edited values can be long unbroken model ids that
        // would otherwise overflow the panel's right edge at phone widths.
        <p className="text-muted text-xs break-all">
          Custom classes (edit in config.json):{" "}
          {customEntries.map(([name, value]) => `${name} → ${value}`).join(", ")}
        </p>
      )}
    </div>
  );
}
