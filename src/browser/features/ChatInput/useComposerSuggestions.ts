import { useEffect, useId, useRef, useState } from "react";
import type { RefObject } from "react";
import { useAPI } from "@/browser/contexts/API";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { getPendingDraftSkillDiscoveryKey } from "@/common/constants/storage";
import { subscribeAgentPluginsMutated } from "@/browser/utils/agentPluginMutations";
import { findAtMentionAtCursor } from "@/common/utils/atMentions";
import { findInlineSkillReferenceAtCursor } from "@/browser/utils/agentSkills/inlineSkillReferences";
import {
  getInlineSkillInsertionTrailingText,
  getInlineSkillSuggestions,
} from "@/browser/utils/agentSkills/inlineSkillSuggestions";
import {
  findSymbolCommandAtCursor,
  getSymbolSuggestions,
} from "@/browser/features/ChatInput/symbolShortcuts";
import { getCommandGhostHint } from "@/browser/utils/slashCommands/registry";
import { getSlashCommandSuggestions } from "@/browser/utils/slashCommands/suggestions";
import { resolveSlashCommandExperimentValue } from "@/browser/utils/slashCommands/experimentVisibility";
import type { SlashSuggestion } from "@/browser/utils/slashCommands/types";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { MCPPromptDescriptor } from "@/common/orpc/schemas/mcp";
import type { PluginSlashCommandDescriptor } from "@/common/orpc/schemas/agentPlugins";

type ComposerSuggestionToken =
  | { kind: "file"; startIndex: number; endIndex: number; query: string }
  | { kind: "inline"; startIndex: number; endIndex: number; query: string }
  | { kind: "symbol"; startIndex: number; endIndex: number; query: string }
  | { kind: "slash"; startIndex: 0; endIndex: number; query: string };

interface SuggestionExperiments {
  workspaceHeartbeats: boolean;
  dynamicWorkflows: boolean;
  memory: boolean;
  memoryConsolidation: boolean;
  rlm: boolean;
  programmaticToolCalling: boolean;
}

interface SynchronousSuggestionContext {
  agentSkills: AgentSkillDescriptor[];
  mcpPrompts: MCPPromptDescriptor[];
  pluginCommands: PluginSlashCommandDescriptor[];
  variant: "creation" | "workspace";
  experiments: SuggestionExperiments;
}

export function detectActiveComposerToken(
  input: string,
  cursor: number
): ComposerSuggestionToken | null {
  const boundedCursor = Math.min(Math.max(cursor, 0), input.length);
  const file = findAtMentionAtCursor(input, boundedCursor);
  if (file) {
    return {
      kind: "file",
      startIndex: file.startIndex,
      endIndex: file.endIndex,
      query: file.query,
    };
  }

  const inline = findInlineSkillReferenceAtCursor(input, boundedCursor);
  if (inline) {
    return {
      kind: "inline",
      startIndex: inline.startIndex,
      endIndex: inline.endIndex,
      query: inline.partial,
    };
  }

  const symbol = findSymbolCommandAtCursor(input, boundedCursor);
  if (symbol) {
    return {
      kind: "symbol",
      startIndex: symbol.startIndex,
      endIndex: symbol.endIndex,
      query: symbol.partial,
    };
  }

  if (input.trimStart().startsWith("/")) {
    return { kind: "slash", startIndex: 0, endIndex: input.length, query: input };
  }
  return null;
}

export function getSynchronousComposerSuggestions(
  token: ComposerSuggestionToken | null,
  context: SynchronousSuggestionContext
): SlashSuggestion[] {
  if (!token || token.kind === "file") return [];
  if (token.kind === "inline") {
    return getInlineSkillSuggestions({
      partial: token.query,
      descriptors: context.agentSkills,
      mcpPrompts: context.mcpPrompts,
    });
  }
  if (token.kind === "symbol") return getSymbolSuggestions(token.query);
  return getSlashCommandSuggestions(token.query, {
    agentSkills: context.agentSkills,
    mcpPrompts: context.mcpPrompts,
    pluginCommands: context.pluginCommands,
    variant: context.variant,
    isExperimentEnabled: (experimentId) =>
      resolveSlashCommandExperimentValue(experimentId, context.experiments),
  });
}

export function applyComposerSuggestion(
  input: string,
  token: ComposerSuggestionToken,
  suggestion: SlashSuggestion
) {
  if (token.kind === "slash") {
    return { input: suggestion.replacement, cursor: suggestion.replacement.length };
  }

  const after = input.slice(token.endIndex);
  const trailing =
    token.kind === "file"
      ? " "
      : token.kind === "inline"
        ? getInlineSkillInsertionTrailingText(after)
        : "";
  const next = input.slice(0, token.startIndex) + suggestion.replacement + trailing + after;
  return {
    input: next,
    cursor: token.startIndex + suggestion.replacement.length + trailing.length,
  };
}

function tokenKey(token: ComposerSuggestionToken | null): string | null {
  return token ? [token.kind, token.startIndex, token.endIndex, token.query].join(":") : null;
}

function fileType(path: string): string {
  if (path.endsWith("/")) return "Directory";
  const lastDot = path.lastIndexOf(".");
  const lastSlash = path.lastIndexOf("/");
  return lastDot > lastSlash && lastDot < path.length - 1
    ? path.slice(lastDot + 1).toUpperCase()
    : "File";
}

interface UseComposerSuggestionsOptions {
  input: string;
  setInput: (input: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  variant: "creation" | "workspace";
  workspaceId: string | null;
  projectPath: string | null;
  disableWorkspaceAgents: boolean;
}

export function useComposerSuggestions(options: UseComposerSuggestionsOptions) {
  const { disableWorkspaceAgents, input, inputRef, projectPath, setInput, variant, workspaceId } =
    options;
  const { api } = useAPI();
  const agentPluginsEnabled = useExperimentValue(EXPERIMENT_IDS.AGENT_PLUGINS);
  const workspaceHeartbeatsEnabled = useExperimentValue(EXPERIMENT_IDS.WORKSPACE_HEARTBEATS);
  const dynamicWorkflowsEnabled = useExperimentValue(EXPERIMENT_IDS.DYNAMIC_WORKFLOWS);
  const memoryEnabled = useExperimentValue(EXPERIMENT_IDS.MEMORY);
  const memoryConsolidationEnabled = useExperimentValue(EXPERIMENT_IDS.MEMORY_CONSOLIDATION);
  const rlmEnabled = useExperimentValue(EXPERIMENT_IDS.RLM);
  const ptcEnabled = useExperimentValue(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING);
  const experiments: SuggestionExperiments = {
    workspaceHeartbeats: workspaceHeartbeatsEnabled,
    dynamicWorkflows: dynamicWorkflowsEnabled,
    memory: memoryEnabled,
    memoryConsolidation: memoryConsolidationEnabled,
    rlm: rlmEnabled,
    programmaticToolCalling: ptcEnabled,
  };
  // A draft transferred from a failed creation send may have resolved its
  // slash skill against the project path; honor that choice on the retry.
  // listener keeps the descriptor reload in sync when the transfer lands
  // after mount and when a successful send clears the key.
  const [transferredDraftProjectDiscovery] = usePersistedState<boolean>(
    variant === "workspace" && workspaceId
      ? getPendingDraftSkillDiscoveryKey(workspaceId)
      : "__unused__",
    false,
    { listener: true }
  );
  // A measured caret is only valid for the input it was measured against;
  // external input changes (draft restore, persisted-state writes) fall back
  // to end-of-text, matching the pre-extraction selectionStart ?? length read.
  const [caretState, setCaretState] = useState<{ input: string; cursor: number } | null>(null);
  const cursor = caretState?.input === input ? caretState.cursor : input.length;
  const [selection, setSelection] = useState({
    channelKey: "",
    index: 0,
    selectedId: null as string | null,
    dismissedTokenKey: "",
  });
  const [fileCompletion, setFileCompletion] = useState<{
    tokenKey: string;
    suggestions: SlashSuggestion[];
  }>({ tokenKey: "", suggestions: [] });
  const [agentSkills, setAgentSkills] = useState<AgentSkillDescriptor[]>([]);
  const [mcpPrompts, setMcpPrompts] = useState<MCPPromptDescriptor[]>([]);
  const [pluginCommands, setPluginCommands] = useState<PluginSlashCommandDescriptor[]>([]);
  const [pluginMutationTick, setPluginMutationTick] = useState(0);
  const fileRequestId = useRef(0);
  const skillRequestId = useRef(0);
  const mcpRequestId = useRef(0);
  const mcpRequest = useRef<Promise<void> | null>(null);
  const mcpLoadedAt = useRef(0);
  const mcpWorkspace = useRef<string | null>(null);
  const mcpAbort = useRef<AbortController | null>(null);
  const listId = useId();

  const activeToken = detectActiveComposerToken(input, cursor);
  const activeTokenKey = tokenKey(activeToken) ?? "";
  const activeChannelKey = activeToken ? `${activeToken.kind}:${activeToken.startIndex}` : "";
  const synchronousSuggestions = getSynchronousComposerSuggestions(activeToken, {
    agentSkills,
    mcpPrompts,
    pluginCommands,
    variant,
    experiments,
  });
  const suggestions =
    activeToken?.kind === "file" && fileCompletion.tokenKey === activeTokenKey
      ? fileCompletion.suggestions
      : synchronousSuggestions;
  const isVisible = selection.dismissedTokenKey !== activeTokenKey && suggestions.length > 0;
  const preservedIndex = selection.selectedId
    ? suggestions.findIndex((suggestion) => suggestion.id === selection.selectedId)
    : -1;
  const selectedIndex =
    selection.channelKey === activeChannelKey
      ? preservedIndex >= 0
        ? preservedIndex
        : Math.min(selection.index, Math.max(0, suggestions.length - 1))
      : 0;

  useEffect(
    () => subscribeAgentPluginsMutated(() => setPluginMutationTick((tick) => tick + 1)),
    []
  );

  useEffect(() => {
    let mounted = true;
    const requestId = ++skillRequestId.current;
    const discovery =
      variant === "workspace" && workspaceId
        ? {
            workspaceId,
            disableWorkspaceAgents: disableWorkspaceAgents || transferredDraftProjectDiscovery,
          }
        : variant === "creation" && projectPath
          ? { projectPath }
          : null;
    if (!api || !discovery) {
      setAgentSkills([]);
      return;
    }
    api.agentSkills
      .list(discovery)
      .then((skills) => {
        if (mounted && skillRequestId.current === requestId) setAgentSkills(skills);
      })
      .catch((error: unknown) => {
        console.error("Failed to load agent skills:", error);
        if (mounted && skillRequestId.current === requestId) setAgentSkills([]);
      });
    return () => {
      mounted = false;
    };
  }, [
    api,
    variant,
    workspaceId,
    projectPath,
    disableWorkspaceAgents,
    transferredDraftProjectDiscovery,
    agentPluginsEnabled,
    pluginMutationTick,
  ]);

  useEffect(() => {
    let mounted = true;
    if (!api || variant !== "workspace" || !workspaceId || !agentPluginsEnabled) {
      setPluginCommands([]);
      return;
    }
    api.workspace.plugins.slashCommands
      .list({ workspaceId })
      .then((commands) => {
        if (mounted) setPluginCommands(commands);
      })
      .catch(() => {
        if (mounted) setPluginCommands([]);
      });
    return () => {
      mounted = false;
    };
  }, [api, variant, workspaceId, agentPluginsEnabled, pluginMutationTick]);

  useEffect(() => {
    if (!api || variant !== "workspace" || !workspaceId) {
      mcpWorkspace.current = null;
      mcpLoadedAt.current = 0;
      mcpRequestId.current++;
      mcpRequest.current = null;
      mcpAbort.current?.abort();
      mcpAbort.current = null;
      setMcpPrompts([]);
      return;
    }
    if (mcpWorkspace.current !== workspaceId) {
      mcpWorkspace.current = workspaceId;
      mcpLoadedAt.current = 0;
      mcpRequestId.current++;
      mcpRequest.current = null;
      mcpAbort.current?.abort();
      mcpAbort.current = null;
      setMcpPrompts([]);
    }
    if (activeToken?.kind !== "slash" && activeToken?.kind !== "inline") return;
    if (Date.now() - mcpLoadedAt.current < 30_000 || mcpRequest.current) return;

    const requestId = ++mcpRequestId.current;
    const controller = new AbortController();
    mcpAbort.current = controller;
    const request = api.workspace.mcp.prompts
      .list({ workspaceId }, { signal: controller.signal })
      .then((prompts) => {
        if (mcpWorkspace.current === workspaceId && mcpRequestId.current === requestId) {
          setMcpPrompts(prompts);
          mcpLoadedAt.current = Date.now();
        }
      })
      .catch(() => {
        if (mcpWorkspace.current === workspaceId && mcpRequestId.current === requestId) {
          mcpLoadedAt.current = Date.now();
        }
      })
      .finally(() => {
        if (mcpRequest.current === request) mcpRequest.current = null;
        if (mcpAbort.current === controller) mcpAbort.current = null;
      });
    mcpRequest.current = request;
  }, [api, activeToken?.kind, activeTokenKey, variant, workspaceId]);

  useEffect(() => {
    const scope = variant === "workspace" ? workspaceId : projectPath;
    if (!api || activeToken?.kind !== "file" || !scope) {
      // Invalidate in-flight requests and drop the cached completion when the
      // file token or its scope goes away, so a stale response (e.g. from a
      // previous workspace) cannot resurface for a later identical token.
      fileRequestId.current++;
      setFileCompletion((prev) =>
        prev.tokenKey === "" && prev.suggestions.length === 0
          ? prev
          : { tokenKey: "", suggestions: [] }
      );
      return;
    }
    const requestId = ++fileRequestId.current;
    const requestedTokenKey = activeTokenKey;
    const request =
      variant === "workspace"
        ? api.workspace.getFileCompletions({
            workspaceId: scope,
            query: activeToken.query,
            limit: 20,
          })
        : api.projects.getFileCompletions({
            projectPath: scope,
            query: activeToken.query,
            limit: 20,
          });
    request
      .then((result) => {
        if (fileRequestId.current !== requestId) return;
        setFileCompletion({
          tokenKey: requestedTokenKey,
          suggestions: result.paths
            .filter((path) => !/\s/.test(path))
            .map((path) => ({
              id: `file:${path}`,
              display: path,
              description: fileType(path),
              replacement: `@${path}`,
            })),
        });
      })
      .catch(() => {
        if (fileRequestId.current === requestId) {
          setFileCompletion({ tokenKey: requestedTokenKey, suggestions: [] });
        }
      });
  }, [
    api,
    activeToken?.kind,
    activeToken?.query,
    activeTokenKey,
    projectPath,
    variant,
    workspaceId,
  ]);

  // Dismissal drops the stored selection so a menu reopened for the same
  // channel starts back at the first result instead of the pre-Escape row.
  const dismiss = () => {
    setSelection({
      channelKey: "",
      index: 0,
      selectedId: null,
      dismissedTokenKey: activeTokenKey,
    });
  };

  const setSelectedIndex = (index: number) =>
    setSelection({
      channelKey: activeChannelKey,
      index,
      selectedId: suggestions[index]?.id ?? null,
      dismissedTokenKey: "",
    });

  const select = (suggestion: SlashSuggestion) => {
    if (!activeToken) return;
    const applied = applyComposerSuggestion(input, activeToken, suggestion);
    setInput(applied.input);
    setCaretState({ input: applied.input, cursor: applied.cursor });
    setSelection({
      channelKey: activeChannelKey,
      index: 0,
      selectedId: null,
      dismissedTokenKey: tokenKey(detectActiveComposerToken(applied.input, applied.cursor)) ?? "",
    });
    requestAnimationFrame(() => {
      const element = inputRef.current;
      if (!element || element.disabled) return;
      element.focus();
      element.selectionStart = applied.cursor;
      element.selectionEnd = applied.cursor;
    });
  };

  // Latest-ref listener: the document handler reads fresh state per event so
  // attaching only depends on visibility, without useCallback dependency lists
  // (manual memoization is banned; React Compiler owns stabilization).
  const keydownHandlerRef = useRef<((event: KeyboardEvent) => void) | null>(null);
  useEffect(() => {
    keydownHandlerRef.current = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setSelectedIndex((selectedIndex + delta + suggestions.length) % suggestions.length);
      } else if ((event.key === "Tab" || event.key === "Enter") && !event.shiftKey) {
        event.preventDefault();
        const suggestion = suggestions[selectedIndex];
        if (suggestion) select(suggestion);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }
    };
  });
  useEffect(() => {
    if (!isVisible) return;
    const listener = (event: KeyboardEvent) => keydownHandlerRef.current?.(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [isVisible]);

  useEffect(() => () => mcpAbort.current?.abort(), []);

  const handleCursorActivity = () => {
    const element = inputRef.current;
    if (element) setCaretState({ input, cursor: element.selectionStart ?? input.length });
  };

  const handleInputCaretChange = (caret: number | undefined, nextInput: string) => {
    setCaretState({ input: nextInput, cursor: caret ?? nextInput.length });
  };

  const ghostHint = getCommandGhostHint(input, isVisible && activeToken?.kind === "slash", {
    variant,
    isExperimentEnabled: (experimentId) =>
      resolveSlashCommandExperimentValue(experimentId, experiments),
  });

  return {
    suggestions,
    selectedIndex,
    setSelectedIndex,
    select,
    dismiss,
    isVisible,
    listId,
    ariaLabel:
      activeToken?.kind === "file"
        ? "File path suggestions"
        : activeToken?.kind === "inline"
          ? "Skill suggestions"
          : activeToken?.kind === "symbol"
            ? "Symbol shortcuts"
            : "Slash command suggestions",
    highlightQuery:
      activeToken?.kind === "file" ||
      activeToken?.kind === "inline" ||
      activeToken?.kind === "symbol"
        ? activeToken.query
        : undefined,
    isFileSuggestion: activeToken?.kind === "file",
    ghostHint,
    handleCursorActivity,
    handleInputCaretChange,
    agentSkillDescriptors: agentSkills,
    mcpPromptDescriptors: mcpPrompts,
  };
}
