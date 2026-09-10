import React, { useState, useEffect, useRef, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/common/lib/utils";
import type { SlashSuggestion } from "@/browser/utils/slashCommands/types";
import { FileIcon } from "@/browser/components/FileIcon/FileIcon";

export const COMMAND_SUGGESTION_KEYS = ["Tab", "Enter", "ArrowUp", "ArrowDown", "Escape"];

function HighlightedText({
  text,
  query,
  className,
}: {
  text: string;
  query?: string;
  className?: string;
}) {
  if (!query) {
    return <span className={className}>{text}</span>;
  }

  const parts: React.ReactNode[] = [];
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let lastIndex = 0;
  let matchIndex = lowerText.indexOf(lowerQuery);

  while (matchIndex !== -1) {
    if (matchIndex > lastIndex) {
      parts.push(
        <span key={`text-${lastIndex}`} className="opacity-60">
          {text.slice(lastIndex, matchIndex)}
        </span>
      );
    }
    parts.push(
      <span key={`match-${matchIndex}`} className="text-light">
        {text.slice(matchIndex, matchIndex + query.length)}
      </span>
    );
    lastIndex = matchIndex + query.length;
    matchIndex = lowerText.indexOf(lowerQuery, lastIndex);
  }

  if (lastIndex < text.length) {
    parts.push(
      <span key={`text-${lastIndex}`} className="opacity-60">
        {text.slice(lastIndex)}
      </span>
    );
  }

  return <span className={className}>{parts}</span>;
}

interface CommandSuggestionsProps {
  suggestions: SlashSuggestion[];
  onSelectSuggestion: (suggestion: SlashSuggestion) => void;
  onDismiss: () => void;
  isVisible: boolean;
  ariaLabel?: string;
  listId?: string;
  anchorRef?: React.RefObject<HTMLElement | null>;
  highlightQuery?: string;
  isFileSuggestion?: boolean;
  selectedIndex?: number;
  onSelectedIndexChange?: (index: number) => void;
}

export const CommandSuggestions: React.FC<CommandSuggestionsProps> = ({
  suggestions,
  onSelectSuggestion,
  onDismiss,
  isVisible,
  ariaLabel = "Command suggestions",
  listId,
  anchorRef,
  highlightQuery,
  isFileSuggestion = false,
  selectedIndex: selectedIndexProp,
  onSelectedIndexChange,
}) => {
  const [uncontrolledSelectedIndex, setUncontrolledSelectedIndex] = useState(0);
  const selectedIndex = selectedIndexProp ?? uncontrolledSelectedIndex;
  const isSelectionControlled = selectedIndexProp !== undefined && onSelectedIndexChange != null;
  const setSelectedIndex = (next: React.SetStateAction<number>) => {
    const resolved = typeof next === "function" ? next(selectedIndex) : next;
    if (!isSelectionControlled) setUncontrolledSelectedIndex(resolved);
    onSelectedIndexChange?.(resolved);
  };
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(
    null
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);
  const previousSuggestionsRef = useRef<SlashSuggestion[]>(suggestions);
  const wasVisibleRef = useRef(isVisible);

  useLayoutEffect(() => {
    if (isSelectionControlled) return;
    const wasVisible = wasVisibleRef.current;
    wasVisibleRef.current = isVisible;
    const previousSuggestions = previousSuggestionsRef.current;
    previousSuggestionsRef.current = suggestions;
    if (!isVisible || suggestions.length === 0 || !wasVisible) {
      setUncontrolledSelectedIndex(0);
      return;
    }
    setUncontrolledSelectedIndex((previousIndex) => {
      const previousSelected = previousSuggestions[previousIndex];
      const nextIndex = previousSelected
        ? suggestions.findIndex((suggestion) => suggestion.id === previousSelected.id)
        : -1;
      return nextIndex >= 0 ? nextIndex : Math.min(previousIndex, suggestions.length - 1);
    });
  }, [isSelectionControlled, isVisible, suggestions]);

  useLayoutEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  useLayoutEffect(() => {
    if (!anchorRef?.current || !isVisible) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;

      const rect = anchor.getBoundingClientRect();
      const menuHeight = menuRef.current?.offsetHeight ?? 200;

      setPosition({
        top: rect.top - menuHeight - 8, // 8px gap above anchor
        left: rect.left,
        width: rect.width,
      });
    };

    updatePosition();

    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchorRef, isVisible, suggestions]);

  useEffect(() => {
    if (isSelectionControlled || !isVisible || suggestions.length === 0) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setUncontrolledSelectedIndex(
          (index) => (index + delta + suggestions.length) % suggestions.length
        );
      } else if ((event.key === "Tab" || event.key === "Enter") && !event.shiftKey) {
        event.preventDefault();
        const suggestion = suggestions[selectedIndex];
        if (suggestion) onSelectSuggestion(suggestion);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isSelectionControlled, isVisible, onDismiss, onSelectSuggestion, selectedIndex, suggestions]);

  useEffect(() => {
    if (!isVisible) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-command-suggestions]")) {
        onDismiss();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isVisible, onDismiss]);

  if (!isVisible || suggestions.length === 0) {
    return null;
  }

  const activeSuggestion = suggestions[selectedIndex] ?? suggestions[0];
  const resolvedListId = listId ?? `command-suggestions-list`;

  const content = (
    <div
      ref={menuRef}
      id={resolvedListId}
      role="listbox"
      aria-label={ariaLabel}
      aria-activedescendant={
        activeSuggestion ? `${resolvedListId}-option-${activeSuggestion.id}` : undefined
      }
      data-command-suggestions
      className={cn(
        "bg-separator border-border-light z-[1010] flex max-h-[200px] flex-col overflow-y-auto rounded border shadow-[0_-4px_12px_rgba(0,0,0,0.4)]",
        !anchorRef && "absolute right-0 bottom-full left-0 mb-2"
      )}
      style={
        anchorRef && position
          ? {
              position: "fixed",
              top: position.top,
              left: position.left,
              width: position.width,
            }
          : undefined
      }
    >
      {suggestions.map((suggestion, index) => (
        <div
          key={suggestion.id}
          ref={index === selectedIndex ? selectedRef : undefined}
          onMouseEnter={() => setSelectedIndex(index)}
          onClick={() => onSelectSuggestion(suggestion)}
          id={`${resolvedListId}-option-${suggestion.id}`}
          role="option"
          aria-selected={index === selectedIndex}
          className={cn(
            "cursor-pointer flex items-center gap-2 px-2.5 py-1.5 hover:bg-hover",
            index === selectedIndex ? "bg-hover" : "bg-transparent"
          )}
        >
          {isFileSuggestion && (
            <FileIcon filePath={suggestion.display} className="shrink-0 text-sm" />
          )}
          <div
            className={cn(
              "font-monospace text-foreground text-xs",
              isFileSuggestion ? "min-w-0 flex-1 truncate" : "shrink-0 whitespace-nowrap"
            )}
          >
            <HighlightedText text={suggestion.display} query={highlightQuery} />
          </div>
          <div
            className={cn(
              "text-secondary min-w-0 truncate text-[11px]",
              isFileSuggestion ? "max-w-[70%]" : "flex-1 text-right"
            )}
            title={suggestion.description}
          >
            {suggestion.description}
          </div>
        </div>
      ))}
      <div className="border-border-light bg-dark text-placeholder [&_span]:text-medium shrink-0 border-t px-2.5 py-1 text-center text-[10px] [&_span]:font-medium">
        <span>Enter</span> or <span>Tab</span> to complete • <span>↑↓</span> to navigate •{" "}
        <span>Esc</span> to dismiss
      </div>
    </div>
  );

  // Use portal when anchorRef is provided (to escape overflow:hidden containers)
  if (anchorRef) {
    return createPortal(content, document.body);
  }

  return content;
};
