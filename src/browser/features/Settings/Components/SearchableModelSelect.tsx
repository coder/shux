import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/browser/components/Popover/Popover";
import { ProviderIcon } from "@/browser/components/ProviderIcon/ProviderIcon";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { cn } from "@/common/lib/utils";
import { getModelName, getModelProvider } from "@/common/utils/ai/models";

// The full model catalog is ~2k entries; rendering every row makes the popover
// janky, so cap the list and prompt the user to narrow the search instead.
const MAX_RENDERED_MODELS = 200;

/** Searchable model dropdown with keyboard navigation */
export function SearchableModelSelect(props: {
  value: string;
  onChange: (value: string) => void;
  models: string[];
  placeholder?: string;
  emptyOption?: { value: string; label: string };
  compact?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const displayValue =
    props.emptyOption && !props.value
      ? props.emptyOption.label
      : (getModelName(props.value) ?? props.placeholder ?? "Select model");
  const selectedProvider = props.value ? getModelProvider(props.value) : "";

  // Filter models based on search
  const searchLower = search.toLowerCase();
  const filteredModels = props.models.filter(
    (model) =>
      model.toLowerCase().includes(searchLower) ||
      (getModelName(model)?.toLowerCase().includes(searchLower) ?? false)
  );
  const hiddenModelCount = Math.max(0, filteredModels.length - MAX_RENDERED_MODELS);
  const visibleModels =
    hiddenModelCount > 0 ? filteredModels.slice(0, MAX_RENDERED_MODELS) : filteredModels;

  // Build list of all selectable items (empty option + filtered models)
  const items: Array<{ value: string; label: string; provider?: string; isMuted?: boolean }> = [];
  if (props.emptyOption) {
    items.push({
      value: props.emptyOption.value,
      label: props.emptyOption.label,
      isMuted: true,
    });
  }
  for (const model of visibleModels) {
    items.push({
      value: model,
      label: getModelName(model) ?? model,
      provider: getModelProvider(model),
    });
  }

  // Reset highlight when search changes
  useEffect(() => {
    setHighlightedIndex(0);
  }, [search]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setSearch("");
    setHighlightedIndex(0);

    // Focus input after popover renders.
    const timer = setTimeout(() => inputRef.current?.focus(), 10);
    return () => clearTimeout(timer);
  }, [isOpen]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!listRef.current) {
      return;
    }

    const highlighted = listRef.current.querySelector("[data-highlighted=true]");
    if (highlighted) {
      highlighted.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex]);

  const handleSelect = (value: string) => {
    props.onChange(value);
    setIsOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightedIndex((i) => Math.min(i + 1, items.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightedIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (items[highlightedIndex]) {
          handleSelect(items[highlightedIndex].value);
        }
        break;
      case "Escape":
        e.preventDefault();
        // Prevent Escape from triggering global handlers (like stream interrupt).
        stopKeyboardPropagation(e);
        setIsOpen(false);
        break;
    }
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen} modal>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "bg-background-secondary border-border-medium focus:border-accent flex w-full items-center justify-between rounded border px-2 text-xs",
            props.compact ? "py-0.5" : "h-8"
          )}
        >
          <span
            className={cn(
              "flex items-center gap-1.5 truncate",
              !props.value && props.emptyOption && "text-muted"
            )}
          >
            {selectedProvider && (
              <ProviderIcon provider={selectedProvider} className="text-muted shrink-0" />
            )}
            {displayValue}
          </span>
          <ChevronDown className="text-muted h-3 w-3 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[350px] w-[320px] p-0">
        {/* Search input */}
        <div className="border-border border-b px-2 py-1.5">
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search models..."
            className="text-foreground placeholder:text-muted w-full bg-transparent text-xs outline-none"
          />
        </div>

        {/* Scrollable list */}
        <div ref={listRef} className="max-h-[280px] overflow-y-auto p-1">
          {items.length === 0 ? (
            <div className="text-muted py-2 text-center text-[10px]">No matching models</div>
          ) : (
            items.map((item, index) => (
              <button
                key={item.value || "__empty__"}
                data-highlighted={index === highlightedIndex}
                onClick={() => handleSelect(item.value)}
                onMouseEnter={() => setHighlightedIndex(index)}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-xs",
                  index === highlightedIndex ? "bg-hover" : "hover:bg-hover"
                )}
              >
                <Check
                  className={cn(
                    "h-3 w-3 shrink-0",
                    props.value === item.value || (!props.value && !item.value)
                      ? "opacity-100"
                      : "opacity-0"
                  )}
                />
                {item.provider && (
                  <ProviderIcon provider={item.provider} className="text-muted shrink-0" />
                )}
                <span className={cn("truncate", item.isMuted && "text-muted")}>{item.label}</span>
              </button>
            ))
          )}
          {hiddenModelCount > 0 && (
            <div className="text-muted px-2 py-1 text-center text-[10px]">
              +{hiddenModelCount} more, keep typing to filter
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
