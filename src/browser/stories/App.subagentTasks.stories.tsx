import type { ComponentType } from "react";

import { getSubAgentTasksExpandedKey } from "@/common/constants/storage";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { collapseLeftSidebar, collapseRightSidebar } from "./helpers/uiState";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { createWorkspace, STABLE_TIMESTAMP } from "./mocks/workspaces";

const PARENT_WORKSPACE_ID = "ws-persistent-subagents";
const PROJECT_NAME = "xum";
const PROJECT_PATH = "/home/user/projects/mux";

function setupPersistentSubagentsStory() {
  collapseLeftSidebar();
  collapseRightSidebar();
  updatePersistedState(getSubAgentTasksExpandedKey(PARENT_WORKSPACE_ID), true);

  return setupSimpleChatStory({
    workspaceId: PARENT_WORKSPACE_ID,
    workspaceName: "persistent-subagents",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    messages: [
      createUserMessage("subagents-user", "Delegate the implementation and verification work.", {
        historySequence: 1,
        timestamp: STABLE_TIMESTAMP - 120_000,
      }),
      createAssistantMessage(
        "subagents-assistant",
        "I split the work across persistent sub-agents. Their workspaces remain available until I archive them.",
        { historySequence: 2, timestamp: STABLE_TIMESTAMP - 110_000 }
      ),
    ],
    additionalWorkspaces: [
      createWorkspace({
        id: "subagent-active",
        name: "agent_exec_implementation",
        title: "Implement persistent lifecycle",
        projectName: PROJECT_NAME,
        projectPath: PROJECT_PATH,
        parentWorkspaceId: PARENT_WORKSPACE_ID,
        taskStatus: "running",
      }),
      createWorkspace({
        id: "subagent-completed",
        name: "agent_explore_verification",
        title: "Verify cleanup ownership",
        projectName: PROJECT_NAME,
        projectPath: PROJECT_PATH,
        parentWorkspaceId: PARENT_WORKSPACE_ID,
        taskStatus: "reported",
      }),
      createWorkspace({
        id: "subagent-nested",
        name: "agent_explore_sidebar",
        title: "Check narrow layout",
        projectName: PROJECT_NAME,
        projectPath: PROJECT_PATH,
        parentWorkspaceId: "subagent-active",
        taskStatus: "reported",
      }),
    ],
  });
}

function PhoneDecorator(Story: ComponentType) {
  return (
    <div style={{ width: 390, height: 844, overflow: "hidden" }}>
      <Story />
    </div>
  );
}

export default {
  ...appMeta,
  title: "App/PersistentSubagents",
};

export const Expanded: AppStory = {
  render: () => <AppWithMocks setup={setupPersistentSubagentsStory} />,
  parameters: {
    ...appMeta.parameters,
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["laptop"] } },
  },
};

export const Phone: AppStory = {
  tags: ["!test"],
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  render: () => <AppWithMocks setup={setupPersistentSubagentsStory} />,
  decorators: [PhoneDecorator],
  parameters: {
    ...appMeta.parameters,
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } },
  },
};
