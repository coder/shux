import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";

// Keep every built-in agent ID in the fallback list, including hidden/non-selectable
// agents, so local overrides do not get mislabeled as unknown when discovery is
// unavailable.
export const FALLBACK_AGENTS: AgentDefinitionDescriptor[] = [
  {
    id: "plan",
    scope: "built-in",
    name: "Plan",
    description: "Create a plan before coding",
    uiSelectable: true,
    subagentRunnable: true,
    base: "plan",
  },
  {
    id: "exec",
    scope: "built-in",
    name: "Exec",
    description: "Implement changes in the repository",
    uiSelectable: true,
    subagentRunnable: true,
  },
  {
    id: "compact",
    scope: "built-in",
    name: "Compact",
    description: "History compaction (internal)",
    uiSelectable: false,
    subagentRunnable: false,
  },
  {
    id: "desktop",
    scope: "built-in",
    name: "Desktop",
    description: "Visual desktop automation agent for GUI-heavy, screenshot-intensive workflows",
    uiSelectable: false,
    subagentRunnable: true,
    base: "exec",
    aiDefaults: {
      thinkingLevel: "medium",
    },
    tools: {
      add: [
        "desktop_screenshot",
        "desktop_move_mouse",
        "desktop_click",
        "desktop_double_click",
        "desktop_drag",
        "desktop_scroll",
        "desktop_type",
        "desktop_key_press",
      ],
      remove: [
        "task",
        "task_await",
        "task_list",
        "task_send_message",
        "task_retitle",
        "task_stop",
        "task_remove",
        "task_workspace_lifecycle",
        "task_apply_git_patch",
        "propose_plan",
        "ask_user_question",
        "mux_agents_.*",
        "agent_skill_write",
      ],
    },
  },
  {
    id: "explore",
    scope: "built-in",
    name: "Explore",
    description: "Read-only repository exploration",
    uiSelectable: false,
    subagentRunnable: true,
    base: "exec",
  },
  {
    id: "name_workspace",
    scope: "built-in",
    name: "Name Workspace",
    description: "Generate workspace name and title from user message",
    uiSelectable: false,
    subagentRunnable: false,
    tools: {
      require: ["propose_name"],
    },
  },
  {
    id: "intuition",
    scope: "built-in",
    name: "Intuition",
    description: "Read-only memory recognition (internal)",
    uiSelectable: false,
    subagentRunnable: false,
    tools: { require: ["memory_read", "intuition_report"] },
  },
  {
    id: "dream",
    scope: "built-in",
    name: "Dream",
    description: "Background memory consolidation (internal)",
    uiSelectable: false,
    subagentRunnable: false,
    tools: {
      require: ["memory"],
    },
  },
];

function compareAgentsByName(a: AgentDefinitionDescriptor, b: AgentDefinitionDescriptor): number {
  return a.name.localeCompare(b.name);
}

// Experiment-gated agents are dead weight in Settings while their experiment
// is off (they never run), so hide their cards; their overrides stay "known"
// via knownAgentIds below.
function shouldShowAgentInTasksSettings(
  agent: AgentDefinitionDescriptor,
  params: {
    portableDesktopEnabled: boolean;
    memoryConsolidationEnabled: boolean;
    memoryIntuitionEnabled: boolean;
  }
): boolean {
  if (agent.id === "desktop") return params.portableDesktopEnabled;
  if (agent.id === "dream") return params.memoryConsolidationEnabled;
  if (agent.id === "intuition") return params.memoryIntuitionEnabled;
  return true;
}

export function deriveTasksSectionAgentGroups(params: {
  listedAgents: AgentDefinitionDescriptor[];
  agentAiDefaults: AgentAiDefaults;
  portableDesktopEnabled: boolean;
  /** True only when both Agent Memory and Memory Consolidation experiments are on (mirrors the runtime gate in memoryConsolidationService). */
  memoryConsolidationEnabled: boolean;
  /** True only when both Agent Memory and Memory Intuition are on. */
  memoryIntuitionEnabled: boolean;
}): {
  uiAgents: AgentDefinitionDescriptor[];
  subagents: AgentDefinitionDescriptor[];
  internalAgents: AgentDefinitionDescriptor[];
  unknownAgentIds: string[];
} {
  const visible = params.listedAgents.filter((agent) =>
    shouldShowAgentInTasksSettings(agent, params)
  );
  const knownAgentIds = new Set(params.listedAgents.map((agent) => agent.id));

  // `visible.filter(...)` already returns a fresh array, so the subsequent
  // `.sort()` mutates that copy rather than `visible` — no defensive spread needed.
  return {
    uiAgents: visible.filter((agent) => agent.uiSelectable).sort(compareAgentsByName),
    subagents: visible
      .filter((agent) => agent.subagentRunnable && !agent.uiSelectable)
      .sort(compareAgentsByName),
    internalAgents: visible
      .filter((agent) => !agent.uiSelectable && !agent.subagentRunnable)
      .sort(compareAgentsByName),
    // Keep hidden agents such as Desktop known here so disabling their Settings visibility
    // does not relabel saved overrides as unknown.
    unknownAgentIds: Object.keys(params.agentAiDefaults)
      .filter((id) => !knownAgentIds.has(id))
      .sort((a, b) => a.localeCompare(b)),
  };
}
