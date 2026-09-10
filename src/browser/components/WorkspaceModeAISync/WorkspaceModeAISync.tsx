import { useEffect, useRef } from "react";
import { useAgent } from "@/browser/contexts/AgentContext";
import {
  readPersistedState,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import {
  getModelKey,
  getReasoningModeKey,
  getThinkingLevelKey,
  getWorkspaceAISettingsByAgentKey,
  AGENT_AI_DEFAULTS_KEY,
} from "@/common/constants/storage";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import { setWorkspaceModelWithOrigin } from "@/browser/utils/modelChange";
import {
  resolveWorkspaceAiSettingsForAgent,
  type WorkspaceAISettingsCache,
} from "@/browser/utils/workspaceModeAi";
import type { OpenAIReasoningMode, ThinkingLevel } from "@/common/types/thinking";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import { normalizeAgentId } from "@/common/utils/agentIds";

export function WorkspaceModeAISync(props: { workspaceId: string }): null {
  const workspaceId = props.workspaceId;
  const { agentId, agents } = useAgent();

  const [agentAiDefaults] = usePersistedState<AgentAiDefaults>(
    AGENT_AI_DEFAULTS_KEY,
    {},
    { listener: true }
  );

  // User request: this effect runs on mount and during background sync (defaults/config).
  // Only treat *real* agentId changes as explicit (origin "agent"); everything else is "sync"
  // so we don't show context-switch warnings on workspace entry.
  const prevAgentIdRef = useRef<string | null>(null);
  const prevWorkspaceIdRef = useRef<string | null>(null);

  useEffect(() => {
    const fallbackModel = getDefaultModel();
    const modelKey = getModelKey(workspaceId);
    const thinkingKey = getThinkingLevelKey(workspaceId);

    const normalizedAgentId = normalizeAgentId(agentId, "exec");

    const isExplicitAgentSwitch =
      prevAgentIdRef.current !== null &&
      prevWorkspaceIdRef.current === workspaceId &&
      prevAgentIdRef.current !== normalizedAgentId;

    // Update refs for the next run (even if no model changes).
    prevAgentIdRef.current = normalizedAgentId;
    prevWorkspaceIdRef.current = workspaceId;

    // Read at call time rather than subscribing: this cache only feeds explicit agent
    // switches, yet every model/thinking/pro-mode change rewrites it, so a subscription
    // would re-run this effect and re-apply the mode default over the user's own pick.
    const workspaceByAgent = readPersistedState<WorkspaceAISettingsCache>(
      getWorkspaceAISettingsByAgentKey(workspaceId),
      {}
    );

    const existingModel = readPersistedState<string>(modelKey, fallbackModel);
    const existingThinking = readPersistedState<ThinkingLevel>(thinkingKey, "off");
    const reasoningKey = getReasoningModeKey(workspaceId);
    const existingReasoning = readPersistedState<OpenAIReasoningMode>(reasoningKey, "standard");

    const { resolvedModel, resolvedThinking, resolvedReasoningMode } =
      resolveWorkspaceAiSettingsForAgent({
        agentId: normalizedAgentId,
        agentAiDefaults,
        // Keep deterministic handoff behavior: background sync should trust the
        // currently active workspace model, but explicit mode switches should
        // restore the selected agent's per-workspace override (if any).
        workspaceByAgent,
        useWorkspaceByAgentFallback: isExplicitAgentSwitch,
        fallbackModel,
        existingModel,
        existingThinking,
        existingReasoningMode: existingReasoning,
        agentBaseById: new Map(agents.map((agent) => [agent.id, agent.base])),
      });

    if (existingModel !== resolvedModel) {
      setWorkspaceModelWithOrigin(
        workspaceId,
        resolvedModel,
        isExplicitAgentSwitch ? "agent" : "sync"
      );
    }

    if (existingThinking !== resolvedThinking) {
      updatePersistedState(thinkingKey, resolvedThinking);
    }

    if (existingReasoning !== resolvedReasoningMode) {
      updatePersistedState(reasoningKey, resolvedReasoningMode);
    }
  }, [agentAiDefaults, agentId, agents, workspaceId]);

  return null;
}
