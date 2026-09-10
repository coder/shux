import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Command } from "cmdk";
import { useCommandRegistry } from "@/browser/contexts/CommandRegistryContext";
import { useAPI } from "@/browser/contexts/API";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { CommandAction } from "@/browser/contexts/CommandRegistryContext";
import {
  formatKeybind,
  KEYBINDS,
  isEditableElement,
  isDesktopViewportFocused,
  matchesKeybind,
} from "@/browser/utils/ui/keybinds";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { resolveSlashCommandExperimentValue } from "@/browser/utils/slashCommands/experimentVisibility";
import { getSlashCommandSuggestions } from "@/browser/utils/slashCommands/suggestions";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { getDisableWorkspaceAgentsKey, GLOBAL_SCOPE_ID } from "@/common/constants/storage";
import { filterCommandsByPrefix } from "@/browser/utils/commandPaletteFiltering";
import { rankByPaletteQuery } from "@/browser/utils/commandPaletteRanking";

interface CommandPaletteProps {
  getSlashContext?: () => { workspaceId?: string };
}

type PromptDef = NonNullable<NonNullable<CommandAction["prompt"]>>;
type PromptField = PromptDef["fields"][number];

function getCommandInputPlaceholder(field: PromptField | null): string {
  if (!field) {
    return "Switch workspaces or type > for all commands, / for slash commands…";
  }

  if (field.type === "text") {
    return field.placeholder ?? "Type value…";
  }

  return field.placeholder ?? "Search options…";
}

interface PromptPaletteItem {
  id: string;
  title: string;
  section: string;
  keywords?: string[];
  subtitle?: string;
  shortcutHint?: string;
  run: () => void;
}

type PaletteItem = CommandAction | PromptPaletteItem;

interface PaletteGroup {
  name: string;
  items: PaletteItem[];
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({ getSlashContext }) => {
  const { api } = useAPI();

  const workspaceHeartbeatsExperimentEnabled = useExperimentValue(
    EXPERIMENT_IDS.WORKSPACE_HEARTBEATS
  );
  const memoryExperimentEnabled = useExperimentValue(EXPERIMENT_IDS.MEMORY);
  const memoryConsolidationExperimentEnabled = useExperimentValue(
    EXPERIMENT_IDS.MEMORY_CONSOLIDATION
  );
  const rlmExperimentEnabled = useExperimentValue(EXPERIMENT_IDS.RLM);
  const ptcExperimentEnabled = useExperimentValue(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING);
  const slashContext = getSlashContext?.();
  const slashWorkspaceId = slashContext?.workspaceId;

  const [disableWorkspaceAgents] = usePersistedState<boolean>(
    getDisableWorkspaceAgentsKey(slashWorkspaceId ?? GLOBAL_SCOPE_ID),
    false,
    { listener: true }
  );

  const [agentSkills, setAgentSkills] = useState<AgentSkillDescriptor[]>([]);
  const agentSkillsCacheRef = useRef<Map<string, AgentSkillDescriptor[]>>(new Map());
  const commandPanelRef = useRef<HTMLDivElement | null>(null);
  const paletteOpenOriginRef = useRef<HTMLElement | null>(null);
  const { isOpen, initialQuery, close, getActions, addRecent, recent } = useCommandRegistry();
  const [query, setQuery] = useState("");
  const [activePrompt, setActivePrompt] = useState<null | {
    title?: string;
    fields: PromptDef["fields"];
    onSubmit: PromptDef["onSubmit"];
    idx: number;
    values: Record<string, string>;
  }>(null);
  const [promptError, setPromptError] = useState<string | null>(null);

  const resetPaletteState = useCallback(() => {
    setActivePrompt(null);
    setPromptError(null);
    setQuery("");
  }, []);

  const restorePaletteOpenFocus = useCallback(() => {
    paletteOpenOriginRef.current?.focus();
    paletteOpenOriginRef.current = null;
  }, []);

  const dismissPalette = useCallback(() => {
    resetPaletteState();
    close();
    restorePaletteOpenFocus();
  }, [close, resetPaletteState, restorePaletteOpenFocus]);

  // Close palette with Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isDesktopViewportFocused(e.target)) return;
      if (matchesKeybind(e, KEYBINDS.CANCEL) && isOpen) {
        // Intercept Escape in capture phase so it doesn't reach global bubble handlers
        // (e.g., stream interrupt).
        e.preventDefault();
        e.stopPropagation();
        dismissPalette();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [isOpen, dismissPalette]);

  // useLayoutEffect fires after DOM commit but before browser paint —
  // ensures ">" appears in the input on the very first visible frame
  // when opening via F1, with no flash.
  useLayoutEffect(() => {
    if (isOpen) {
      setQuery(initialQuery);
    } else {
      resetPaletteState();
      paletteOpenOriginRef.current = null;
    }
  }, [isOpen, initialQuery, resetPaletteState]);

  useEffect(() => {
    const clearAgentSkillsCache = () => {
      agentSkillsCacheRef.current.clear();
    };

    window.addEventListener("focus", clearAgentSkillsCache);
    window.addEventListener(CUSTOM_EVENTS.SKILLS_REFRESH_REQUESTED, clearAgentSkillsCache);

    return () => {
      window.removeEventListener("focus", clearAgentSkillsCache);
      window.removeEventListener(CUSTOM_EVENTS.SKILLS_REFRESH_REQUESTED, clearAgentSkillsCache);
    };
  }, []);

  useEffect(() => {
    if (!isOpen || !api || !slashWorkspaceId) {
      setAgentSkills([]);
      return;
    }

    const cacheKey = `${slashWorkspaceId}:${disableWorkspaceAgents ? "project" : "worktree"}`;

    const cached = agentSkillsCacheRef.current.get(cacheKey);
    if (cached) {
      setAgentSkills(cached);
      return;
    }

    let cancelled = false;
    api.agentSkills
      .list({
        workspaceId: slashWorkspaceId,
        disableWorkspaceAgents: disableWorkspaceAgents || undefined,
      })
      .then((skills) => {
        if (cancelled) return;
        agentSkillsCacheRef.current.set(cacheKey, skills);
        setAgentSkills(skills);
      })
      .catch(() => {
        if (cancelled) return;
        setAgentSkills([]);
      });

    return () => {
      cancelled = true;
    };
  }, [api, isOpen, slashWorkspaceId, disableWorkspaceAgents]);

  const rawActions = getActions();

  const recentIndex = useMemo(() => {
    const idx = new Map<string, number>();
    recent.forEach((id, i) => idx.set(id, i));
    return idx;
  }, [recent]);

  const startPrompt = useCallback((action: CommandAction) => {
    if (!action.prompt) return;
    setPromptError(null);
    setQuery("");
    setActivePrompt({
      title: action.prompt.title ?? action.title,
      fields: action.prompt.fields,
      onSubmit: action.prompt.onSubmit,
      idx: 0,
      values: {},
    });
  }, []);

  // Listen for EXECUTE_COMMAND events
  useEffect(() => {
    const handleExecuteCommand = (e: Event) => {
      const customEvent = e as CustomEvent<{ commandId: string }>;
      const { commandId } = customEvent.detail;

      const action = getActions().find((a) => a.id === commandId);
      if (!action) {
        console.warn(`Command not found: ${commandId}`);
        return;
      }

      // Run the action directly
      void action.run();
      addRecent(action.id);
    };

    window.addEventListener(CUSTOM_EVENTS.EXECUTE_COMMAND, handleExecuteCommand);
    return () => window.removeEventListener(CUSTOM_EVENTS.EXECUTE_COMMAND, handleExecuteCommand);
  }, [getActions, startPrompt, addRecent]);

  const handlePromptValue = useCallback(
    (value: string) => {
      let nextInitial: string | null = null;
      setPromptError(null);
      setActivePrompt((current) => {
        if (!current) return current;
        const field = current.fields[current.idx];
        if (!field) return current;
        const nextValues = { ...current.values, [field.name]: value };
        const nextIdx = current.idx + 1;
        if (nextIdx < current.fields.length) {
          const nextField = current.fields[nextIdx];
          if (nextField.type === "text") {
            nextInitial = nextField.getInitialValue?.(nextValues) ?? nextField.initialValue ?? "";
          } else {
            nextInitial = "";
          }
          return {
            ...current,
            idx: nextIdx,
            values: nextValues,
          };
        }
        const submit = current.onSubmit;
        setTimeout(() => void submit(nextValues), 0);
        close();
        setQuery("");
        return null;
      });
      if (nextInitial !== null) {
        const valueToSet = nextInitial;
        setTimeout(() => setQuery(valueToSet), 0);
      }
    },
    [close]
  );

  const handlePromptTextSubmit = useCallback(() => {
    if (!activePrompt) return;
    const field = activePrompt.fields[activePrompt.idx];
    if (field?.type !== "text") return;
    const trimmed = query.trim();
    const err = field.validate?.(trimmed) ?? null;
    if (err) {
      setPromptError(err);
      return;
    }
    handlePromptValue(trimmed);
  }, [activePrompt, query, handlePromptValue]);

  const handleQueryChange = useCallback(
    (value: string) => {
      setQuery(value);
      if (activePrompt) {
        setPromptError(null);
      }
    },
    [activePrompt]
  );

  const generalResults = useMemo(() => {
    const q = query.trim();

    if (q.startsWith("/")) {
      const ctx = getSlashContext?.() ?? {};
      const suggestions = getSlashCommandSuggestions(q, {
        agentSkills,
        variant: ctx.workspaceId ? "workspace" : "creation",
        isExperimentEnabled: (experimentId) =>
          resolveSlashCommandExperimentValue(experimentId, {
            workspaceHeartbeats: workspaceHeartbeatsExperimentEnabled,
            memory: memoryExperimentEnabled,
            memoryConsolidation: memoryConsolidationExperimentEnabled,
            rlm: rlmExperimentEnabled,
            programmaticToolCalling: ptcExperimentEnabled,
          }),
      });
      const section = "Slash Commands";
      const groups: PaletteGroup[] = [
        {
          name: section,
          items: suggestions.map((s) => ({
            id: `slash:${s.id}`,
            title: s.display,
            subtitle: s.description,
            section,
            shortcutHint: `${formatKeybind(KEYBINDS.SEND_MESSAGE)} to insert`,
            run: () => {
              const text = s.replacement;
              window.dispatchEvent(
                createCustomEvent(CUSTOM_EVENTS.UPDATE_CHAT_INPUT, {
                  text,
                  mode: "append",
                })
              );
            },
          })),
        },
      ];
      return {
        groups,
        emptyText: suggestions.length ? undefined : "No command suggestions",
      } satisfies { groups: PaletteGroup[]; emptyText: string | undefined };
    }

    // Filter actions based on prefix (extracted to utility for testing)
    const actionsToShow = filterCommandsByPrefix(q, rawActions);

    // Derive search text: strip ">" prefix for command mode, use raw query for workspace mode.
    const searchText = q.startsWith(">") ? q.slice(1).trim() : q;

    const filtered = rankByPaletteQuery({
      items: actionsToShow,
      query: searchText,
      toSearchDoc: (action) => ({
        primaryText: action.title,
        secondaryText: [...(action.keywords ?? []), ...(action.subtitle ? [action.subtitle] : [])],
      }),
      tieBreak: (a, b) => {
        const ai = recentIndex.get(a.id) ?? 9999;
        const bi = recentIndex.get(b.id) ?? 9999;
        return ai - bi || a.title.localeCompare(b.title);
      },
    });

    const bySection = new Map<string, CommandAction[]>();
    for (const action of filtered) {
      const sec = action.section || "Other";
      const list = bySection.get(sec) ?? [];
      list.push(action);
      bySection.set(sec, list);
    }

    const groups: PaletteGroup[] = Array.from(bySection.entries()).map(([name, items]) => ({
      name,
      items,
    }));

    return {
      groups,
      emptyText: filtered.length ? undefined : "No results",
    } satisfies { groups: PaletteGroup[]; emptyText: string | undefined };
  }, [
    query,
    rawActions,
    recentIndex,
    getSlashContext,
    agentSkills,
    workspaceHeartbeatsExperimentEnabled,
    memoryExperimentEnabled,
    memoryConsolidationExperimentEnabled,
    rlmExperimentEnabled,
    ptcExperimentEnabled,
  ]);

  useEffect(() => {
    if (!activePrompt) return;
    const field = activePrompt.fields[activePrompt.idx];
    if (!field) return;
    if (field.type === "text") {
      const initial = field.getInitialValue?.(activePrompt.values) ?? field.initialValue ?? "";
      setQuery(initial);
    } else {
      setQuery("");
    }
  }, [activePrompt]);

  const [selectOptions, setSelectOptions] = useState<
    Array<{ id: string; label: string; keywords?: string[] }>
  >([]);
  const [isLoadingOptions, setIsLoadingOptions] = useState(false);

  const currentField: PromptField | null = activePrompt
    ? (activePrompt.fields[activePrompt.idx] ?? null)
    : null;

  const trapPromptFocus = useCallback(
    (event: React.KeyboardEvent) => {
      if (!currentField || event.key !== "Tab") {
        return;
      }

      const panel = commandPanelRef.current;
      if (!panel) {
        return;
      }

      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      if (focusable.length === 0) {
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;
      if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        stopKeyboardPropagation(event);
        last.focus();
        return;
      }

      if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        stopKeyboardPropagation(event);
        first.focus();
      }
    },
    [currentField]
  );

  useEffect(() => {
    // Select prompts can return options synchronously or as a promise. This effect normalizes
    // both flows, keeps the loading state in sync, and bails out early if the prompt switches
    // while a request is in flight.
    let cancelled = false;

    const resetState = () => {
      if (cancelled) return;
      setSelectOptions([]);
      setIsLoadingOptions(false);
    };

    const hydrateSelectOptions = async () => {
      if (currentField?.type !== "select") {
        resetState();
        return;
      }

      setIsLoadingOptions(true);
      try {
        const rawOptions = await Promise.resolve(
          currentField.getOptions(activePrompt?.values ?? {})
        );

        if (!Array.isArray(rawOptions)) {
          throw new Error("Prompt select options must resolve to an array");
        }

        if (!cancelled) {
          setSelectOptions(rawOptions);
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to resolve prompt select options", error);
          setSelectOptions([]);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingOptions(false);
        }
      }
    };

    void hydrateSelectOptions();

    return () => {
      cancelled = true;
    };
  }, [currentField, activePrompt]);

  let groups: PaletteGroup[] = generalResults.groups;
  let emptyText: string | undefined = generalResults.emptyText;

  if (currentField) {
    const promptTitle = activePrompt?.title ?? currentField.label ?? "Provide details";
    if (currentField.type === "select") {
      const searchQuery = query.trim();
      const rankedOptions = rankByPaletteQuery({
        items: selectOptions.map((opt, idx) => ({ ...opt, _originalIdx: idx })),
        query: searchQuery,
        toSearchDoc: (opt) => ({
          primaryText: opt.label,
          secondaryText: opt.keywords,
        }),
        tieBreak: (a, b) => a._originalIdx - b._originalIdx,
      });
      groups = [
        {
          name: promptTitle,
          items: rankedOptions.map((opt) => ({
            id: `prompt-select:${currentField.name}:${opt.id}`,
            title: opt.label,
            section: promptTitle,
            keywords: opt.keywords,
            run: () => handlePromptValue(opt.id),
          })),
        },
      ];
      if (isLoadingOptions) {
        emptyText = "Loading options...";
      } else if (rankedOptions.length > 0) {
        emptyText = undefined;
      } else if (selectOptions.length > 0) {
        emptyText = "No results";
      } else {
        emptyText = "No options";
      }
    } else {
      const typed = query.trim();
      const fallbackHint = currentField.placeholder ?? "Type value and press Enter";
      const hint =
        promptError ?? (typed.length > 0 ? `Press Enter to use “${typed}”` : fallbackHint);
      groups = [
        {
          name: promptTitle,
          items: [
            {
              id: `prompt-text:${currentField.name}`,
              title: hint,
              section: promptTitle,
              run: handlePromptTextSubmit,
            },
          ],
        },
      ];
      emptyText = undefined;
    }
  }

  // Capture during render before Command.Input autoFocus moves focus into the palette.
  if (isOpen && !paletteOpenOriginRef.current) {
    paletteOpenOriginRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  if (!isOpen) return null;

  const groupsWithItems = groups.filter((group) => group.items.length > 0);
  const hasAnyItems = groupsWithItems.length > 0;

  return (
    <div
      // Dim painted on a pseudo-element so iOS/iPadOS 26 WebKit's status-bar edge
      // sampler ignores this fixed overlay (same pattern as Dialog/LeftSidebar).
      className="fixed inset-0 z-[2000] flex items-start justify-center pt-[10vh] before:absolute before:inset-0 before:bg-black/40"
      onMouseDown={dismissPalette}
    >
      <Command
        label={currentField?.label ?? "Command palette"}
        ref={commandPanelRef}
        // relative keeps the panel painted above (and hit-tested before) the wrapper's
        // absolutely positioned ::before backdrop, so clicks land on the palette instead
        // of the wrapper's dismiss handler.
        className="font-primary relative w-[min(720px,92vw)] overflow-hidden rounded-lg border border-[var(--color-command-border)] bg-[var(--color-command-surface)] text-[var(--color-command-foreground)] shadow-[0_10px_40px_rgba(0,0,0,0.4)]"
        onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
        onKeyDown={trapPromptFocus}
        shouldFilter={false}
      >
        <Command.Input
          className="w-full border-b border-[var(--color-command-input-border)] bg-[var(--color-command-input)] px-3.5 py-3 text-sm text-[var(--color-command-foreground)] outline-none placeholder:text-[var(--color-command-subdued)]"
          value={query}
          onValueChange={handleQueryChange}
          placeholder={getCommandInputPlaceholder(currentField)}
          aria-label={currentField?.label ?? "Command palette"}
          autoFocus
          onKeyDown={(e: React.KeyboardEvent) => {
            if (!currentField && isEditableElement(e.target)) return;

            if (currentField) {
              if (e.key === "Enter" && currentField.type === "text") {
                e.preventDefault();
                stopKeyboardPropagation(e);
                handlePromptTextSubmit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                stopKeyboardPropagation(e);
                dismissPalette();
              }
              return;
            }
          }}
        />
        <Command.List className="max-h-[420px] overflow-auto">
          {groupsWithItems.map((group) => (
            <Command.Group
              key={group.name}
              heading={
                <div className="px-2.5 py-1 text-[11px] tracking-[0.08em] text-[var(--color-command-subdued)] uppercase">
                  {group.name}
                </div>
              }
              className="px-1.5 py-2"
            >
              {group.items.map((item) => {
                // Always include subtitle in keywords so searches can match secondary
                // info (e.g. workspace "streaming" status).
                const itemKeywords = (() => {
                  const keywords = [
                    ...(item.keywords ?? []),
                    ...(item.subtitle ? [item.subtitle] : []),
                  ]
                    .map((k) => k.trim())
                    .filter((k) => k.length > 0);

                  if (keywords.length === 0) {
                    return undefined;
                  }

                  return Array.from(new Set(keywords));
                })();
                return (
                  <Command.Item
                    key={item.id}
                    value={item.title}
                    keywords={itemKeywords}
                    aria-label={item.title}
                    className="hover:bg-hover aria-selected:bg-hover mx-1 my-0.5 grid cursor-pointer grid-cols-[1fr_auto] items-center gap-2 rounded-md px-3 py-2 text-[13px] aria-selected:text-[var(--color-command-foreground)]"
                    onSelect={() => {
                      if ("prompt" in item && item.prompt) {
                        addRecent(item.id);
                        startPrompt(item);
                        return;
                      }

                      if (currentField) {
                        void item.run();
                        return;
                      }

                      addRecent(item.id);
                      close();
                      setTimeout(() => {
                        void item.run();
                      }, 0);
                    }}
                  >
                    <div>
                      {item.title}
                      {"subtitle" in item && item.subtitle && (
                        <>
                          <br />
                          <span className="text-xs text-[var(--color-command-subdued)]">
                            {item.subtitle}
                          </span>
                        </>
                      )}
                    </div>
                    {"shortcutHint" in item && item.shortcutHint && (
                      <span className="mobile-hide-shortcut-hints font-monospace text-[11px] text-[var(--color-command-subdued)]">
                        {item.shortcutHint}
                      </span>
                    )}
                  </Command.Item>
                );
              })}
            </Command.Group>
          ))}
          {!hasAnyItems && (
            <div className="p-4 text-[13px] text-[var(--color-command-subdued)]">
              {emptyText ?? "No results"}
            </div>
          )}
        </Command.List>
      </Command>
    </div>
  );
};
