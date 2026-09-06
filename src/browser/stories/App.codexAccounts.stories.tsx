import { expect, fn, userEvent, waitFor, within } from "@storybook/test";
import { StrictMode } from "react";
import { appMeta, AppWithMocks, type AppStory } from "./meta";
import {
  collapseLeftSidebar,
  expandRightSidebar,
  expandLeftSidebar,
  expandProjects,
  selectWorkspace,
} from "./helpers/uiState";
import { createMockORPCClient } from "./mocks/orpc";
import { createWorkspace, groupWorkspacesByProject } from "./mocks/workspaces";
import type { APIClient } from "@/browser/contexts/API";
import type { ProvidersConfigMap, WorkspaceChatMessage } from "@/common/orpc/types";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getModelKey, RIGHT_SIDEBAR_TAB_KEY } from "@/common/constants/storage";
import { Err, Ok } from "@/common/types/result";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";

export default { ...appMeta, title: "App/CodexAccounts" };

const startLogin = fn<(input: Parameters<APIClient["codexOauth"]["startDeviceFlow"]>[0]) => void>();

const browserLogin =
  fn<(input: Parameters<APIClient["codexOauth"]["startDesktopFlow"]>[0]) => void>();
const generateTitle = fn<(input: Parameters<APIClient["nameGeneration"]["generate"]>[0]) => void>();

function setupAccounts(
  revokedWork = false,
  workLabel = "Work",
  onChat?: (workspaceId: string, emit: (event: WorkspaceChatMessage) => void) => void,
  workspaceId = "codex-accounts"
) {
  expandLeftSidebar();
  startLogin.mockClear();
  browserLogin.mockClear();
  const workspace = createWorkspace({
    id: workspaceId,
    name: "main",
    projectName: "my-app",
    projectPath: "/projects/my-app",
  });
  selectWorkspace(workspace);
  const projects = groupWorkspacesByProject([workspace]);
  const project = projects.get(workspace.projectPath);
  if (project && revokedWork) project.codexOauthAccountId = "work";
  const providers: ProvidersConfigMap = {
    openai: {
      apiKeySet: true,
      isEnabled: true,
      isConfigured: true,
      codexOauthSet: true,
      codexOauthDefaultAccountId: revokedWork ? "work" : undefined,
      codexOauthAccounts: [
        { id: "default", label: "Personal" },
        { id: "work", label: workLabel, reconnectRequired: revokedWork || undefined },
      ],
    },
  };
  let slot = 0;
  let reconnectAccountId: string | undefined;
  const client = createMockORPCClient({
    projects,
    workspaces: [workspace],
    providersConfig: providers,
    providersList: ["openai"],
    onChat,
  });
  const start: APIClient["codexOauth"]["startDeviceFlow"] = (input) => {
    startLogin(input);
    reconnectAccountId = input?.accountId;
    if (input?.label) {
      providers.openai.codexOauthAccounts?.push({ id: "slot-" + ++slot, label: input.label });
    }
    return Promise.resolve(
      Ok({
        flowId: "login",
        userCode: "CODE-1234",
        verifyUrl: "https://auth.openai.com/codex/device",
        intervalSeconds: 5,
      })
    );
  };
  const finishLogin = () => {
    const account = providers.openai.codexOauthAccounts?.find(
      (item) => item.id === reconnectAccountId
    );
    if (account) delete account.reconnectRequired;
    return Promise.resolve(Ok(undefined));
  };
  client.codexOauth = {
    startDeviceFlow: start,
    startDesktopFlow: async (input) => {
      browserLogin(input);
      await start(input);
      return Ok({ flowId: "login", authorizeUrl: "https://auth.openai.com/authorize" });
    },
    waitForDeviceFlow: finishLogin,
    waitForDesktopFlow: finishLogin,
    cancelDeviceFlow: () => Promise.resolve(),
    cancelDesktopFlow: () => Promise.resolve(),
    disconnect: (input) => {
      providers.openai.codexOauthAccounts = providers.openai.codexOauthAccounts?.filter(
        (account) => account.id !== (input?.accountId ?? "default")
      );
      providers.openai.codexOauthSet = !!providers.openai.codexOauthAccounts?.length;
      return Promise.resolve(Ok(undefined));
    },
    renameAccount: (input) => {
      const account = providers.openai.codexOauthAccounts?.find(
        (item) => item.id === input.accountId
      );
      if (!account) return Promise.resolve(Err("Account is missing"));
      account.label = input.label;
      return Promise.resolve(Ok(undefined));
    },
    setDefaultAccount: (input) => {
      providers.openai.codexOauthDefaultAccountId = input.accountId;
      return Promise.resolve(Ok(undefined));
    },
  };
  client.providers.getConfig = () => Promise.resolve(structuredClone(providers));
  client.providers.setProviderConfig = (input) => {
    if (
      input.keyPath[0] === "codexOauthDefaultAuth" &&
      (input.value === "apiKey" || input.value === "oauth")
    ) {
      providers.openai.codexOauthDefaultAuth = input.value;
    }
    return Promise.resolve(Ok(undefined));
  };
  client.projects.setCodexOauthAccount = (input) => {
    const project = projects.get(input.projectPath);
    if (!project) return Promise.resolve(Err("Project is missing"));
    project.codexOauthAccountId = input.accountId ?? undefined;
    return Promise.resolve(Ok(undefined));
  };
  return client;
}

async function openAccounts(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByTestId("settings-button", {}, { timeout: 10000 }));
  await userEvent.click(await canvas.findByRole("button", { name: "Providers" }));
  const openai = await canvas.findByText("OpenAI", { exact: true });
  await userEvent.click(openai);
  const section = await canvas.findByRole("region", { name: "ChatGPT (Codex) accounts" });
  return section;
}

async function exerciseAccounts(canvasElement: HTMLElement) {
  const section = await openAccounts(canvasElement);
  const controls = within(section);
  const global = controls.getByRole("combobox", { name: "Global default account" });
  const project = controls.getByRole("combobox", { name: "/projects/my-app" });
  await expect(global).toHaveValue("default");
  await expect(project).toHaveValue("");
  await userEvent.selectOptions(global, "work");
  await waitFor(() => expect(global).toHaveValue("work"));
  await waitFor(() => expect(project).toBeEnabled());
  await userEvent.selectOptions(project, "work");
  await waitFor(() => expect(project).toHaveValue("work"));

  const work = within(controls.getByRole("listitem", { name: "Work" }));
  await userEvent.click(work.getByRole("button", { name: "Rename" }));
  const name = controls.getByRole("textbox", { name: "Account name" });
  await userEvent.clear(name);
  await userEvent.type(name, "Team{Enter}");
  await controls.findByRole("listitem", { name: "Team" });
  await expect(global).toHaveDisplayValue("Team");
  await expect(project).toHaveDisplayValue("Team");

  await userEvent.type(controls.getByRole("textbox", { name: "New account name" }), "Lab");
  await userEvent.click(controls.getByRole("button", { name: "Connect (Device)" }));
  await controls.findByRole("listitem", { name: "Lab" });
  await expect(startLogin).toHaveBeenLastCalledWith({ label: "Lab" });
  await userEvent.click(
    within(controls.getByRole("listitem", { name: "Team" })).getByRole("button", {
      name: "Reconnect",
    })
  );
  await waitFor(() => expect(global).toBeEnabled());
  await expect(startLogin).toHaveBeenLastCalledWith({ accountId: "work" });
  if (controls.queryByRole("button", { name: "Connect (Browser)" })) {
    await expect(browserLogin).toHaveBeenLastCalledWith({ accountId: "work" });
  }
  await expect(controls.getAllByRole("listitem")).toHaveLength(3);

  const auth = controls.getByRole("combobox", { name: "Default auth (when both are set)" });
  await userEvent.selectOptions(auth, "apiKey");
  await waitFor(() => expect(auth).toHaveValue("apiKey"));
  await userEvent.click(
    within(controls.getByRole("listitem", { name: "Team" })).getByRole("button", {
      name: "Disconnect",
    })
  );
  await waitFor(() => expect(controls.queryByRole("listitem", { name: "Team" })).toBeNull());
  await expect(global).toHaveValue("work");
  await expect(project).toHaveValue("work");
  await expect(global).toHaveDisplayValue(/Missing account/);
  await expect(project).toHaveDisplayValue(/Missing account/);
  await expect(controls.getAllByRole("listitem")).toHaveLength(2);
  await userEvent.selectOptions(global, "default");
  await waitFor(() => expect(global).toHaveValue("default"));
  await expect(project).toHaveValue("work");
  await userEvent.selectOptions(project, "");
  await waitFor(() => expect(project).toHaveValue(""));
  await expect(project).toHaveDisplayValue(/Personal/);
  await userEvent.selectOptions(project, "slot-1");
  await waitFor(() => expect(project).toHaveValue("slot-1"));
  section.scrollIntoView({ block: "start" });

  // The test-runner ignores viewport globals. Pixel and the phone runner enforce these bounds.
  if (window.innerWidth < 768) {
    await expect(section.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    await expect(section.scrollWidth).toBeLessThanOrEqual(section.clientWidth);
  }
}

export const Desktop: AppStory = {
  globals: { viewport: { value: "desktop", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["desktop"] } } },
  render: () => <AppWithMocks setup={setupAccounts} />,
  play: async ({ canvasElement }) => exerciseAccounts(canvasElement),
};

export const Phone: AppStory = {
  ...Desktop,
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } } },
  play: async ({ canvasElement }) => exerciseAccounts(canvasElement),
};

async function runAccountCommand(canvasElement: HTMLElement, title: string, choice?: string) {
  const canvas = within(canvasElement);
  await userEvent.keyboard("{F4}");
  const search = await canvas.findByPlaceholderText(/Switch workspaces or type/);
  await userEvent.clear(search);
  await userEvent.keyboard(">Codex: " + title);
  await canvas.findByRole("option", { name: new RegExp("Codex: " + title) });
  await userEvent.keyboard("{Enter}");
  if (choice) {
    const options = await canvas.findByPlaceholderText("Search options…");
    await userEvent.clear(options);
    await userEvent.keyboard(choice);
    await within(canvas.getByRole("listbox")).findByRole("option", { name: choice });
    await userEvent.keyboard("{Enter}");
  }
  await waitFor(() => expect(canvas.queryByPlaceholderText("Search options…")).toBeNull());
}

async function exerciseKeyboardAccounts(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await canvas.findByTestId("settings-button", {}, { timeout: 10000 });
  // Reconnect must survive StrictMode when the command first mounts Settings.
  await runAccountCommand(canvasElement, "Reconnect account", "Work");
  const section = await canvas.findByRole("region", { name: "ChatGPT (Codex) accounts" });
  const controls = within(section);
  const newName = controls.getByRole("textbox", { name: "New account name" });
  await waitFor(() => expect(startLogin).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(newName).toBeEnabled());
  await runAccountCommand(canvasElement, "Add account");
  await waitFor(() => expect(newName).toHaveFocus());
  await userEvent.keyboard("Lab{Enter}");
  await controls.findByRole("listitem", { name: "Lab" });
  await runAccountCommand(canvasElement, "Add account");
  await waitFor(() => expect(newName).toHaveFocus());
  await userEvent.keyboard("Second{Enter}");
  await controls.findByRole("listitem", { name: "Second" });

  await runAccountCommand(canvasElement, "Rename account", "Work");
  const name = await controls.findByRole("textbox", { name: "Account name" });
  await waitFor(() => expect(name).toHaveFocus());
  await userEvent.clear(name);
  await userEvent.keyboard("Team");
  await runAccountCommand(canvasElement, "Rename account", "Work");
  await waitFor(() => expect(name).toHaveFocus());
  await expect(name).toHaveValue("Team");
  await userEvent.keyboard("{Enter}");
  await controls.findByRole("listitem", { name: "Team" });

  for (let attempt = 0; attempt < 2; attempt++) {
    await runAccountCommand(canvasElement, "Reconnect account", "Team");
    await waitFor(() => expect(startLogin).toHaveBeenCalledTimes(4 + attempt));
    await expect(startLogin).toHaveBeenLastCalledWith({ accountId: "work" });
    await waitFor(() => expect(newName).toBeEnabled());
  }
  await expect(controls.getAllByRole("listitem")).toHaveLength(4);

  const global = controls.getByRole("combobox", { name: "Global default account" });
  const project = controls.getByRole("combobox", { name: "/projects/my-app" });
  for (const accountId of ["work", "default"]) {
    await runAccountCommand(canvasElement, "Change default account");
    await waitFor(() => expect(global).toHaveFocus());
    // userEvent does not implement native select keyboard actions.
    await userEvent.selectOptions(global, accountId);
    await waitFor(() => expect(global).toHaveValue(accountId));
    await runAccountCommand(canvasElement, "Change project account", "my-app");
    await waitFor(() => expect(project).toHaveFocus());
    await userEvent.selectOptions(project, accountId);
    await waitFor(() => expect(project).toHaveValue(accountId));
  }
  for (const account of ["Team", "Lab"]) {
    await runAccountCommand(canvasElement, "Disconnect account", account);
    await waitFor(() => expect(controls.queryByRole("listitem", { name: account })).toBeNull());
  }
  await expect(controls.getAllByRole("listitem")).toHaveLength(2);
  section.scrollIntoView({ block: "start" });
  if (window.innerWidth < 768) {
    await expect(section.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    await expect(section.scrollWidth).toBeLessThanOrEqual(section.clientWidth);
  }
}

export const KeyboardCommands: AppStory = {
  ...Desktop,
  render: () => (
    <StrictMode>
      <AppWithMocks setup={setupAccounts} />
    </StrictMode>
  ),
  play: async ({ canvasElement }) => exerciseKeyboardAccounts(canvasElement),
};

export const KeyboardCommandsPhone: AppStory = {
  ...Phone,
  render: KeyboardCommands.render,
  play: KeyboardCommands.play,
};

async function exerciseDuplicateAccountLabels(canvasElement: HTMLElement) {
  const section = await openAccounts(canvasElement);
  const controls = within(section);
  const global = controls.getByRole("combobox", { name: "Global default account" });
  const project = controls.getByRole("combobox", { name: "/projects/my-app" });
  const first = within(global).getByRole("option", { name: /Personal.*default/ });
  const second = within(global).getByRole("option", { name: /Personal.*work/ });
  const firstLabel = first.textContent?.trim();
  const secondLabel = second.textContent?.trim();
  if (!firstLabel || !secondLabel) throw new Error("Expected distinct account labels");
  await expect(firstLabel).not.toBe(secondLabel);
  await expect(controls.getByRole("listitem", { name: firstLabel })).toBeVisible();
  await expect(controls.getByRole("listitem", { name: secondLabel })).toBeVisible();
  await expect(
    within(project).getByRole("option", { name: /Inherit global default/ })
  ).toHaveTextContent(firstLabel);

  // The visible choice must select its stable ID, not the first matching stored name.
  await userEvent.selectOptions(global, second);
  await waitFor(() => expect(global).toHaveValue("work"));
  await waitFor(() => expect(project).toBeEnabled());
  await userEvent.selectOptions(project, within(project).getByRole("option", { name: firstLabel }));
  await waitFor(() => expect(project).toHaveValue("default"));
  await runAccountCommand(canvasElement, "Reconnect account", secondLabel);
  await waitFor(() => expect(startLogin).toHaveBeenLastCalledWith({ accountId: "work" }));
  await waitFor(() => expect(global).toBeEnabled());

  await runAccountCommand(canvasElement, "Rename account", firstLabel);
  const name = await controls.findByRole("textbox", { name: "Account name" });
  await expect(name).toHaveValue("Personal");
  await userEvent.clear(name);
  await userEvent.type(name, "Home{Enter}");
  await controls.findByRole("listitem", { name: "Home" });
  await expect(global).toHaveDisplayValue("Personal");
  await expect(project).toHaveDisplayValue("Home");
  await expect(global).toHaveValue("work");
  await expect(project).toHaveValue("default");

  await runAccountCommand(canvasElement, "Rename account", "Home");
  const rename = await controls.findByRole("textbox", { name: "Account name" });
  await userEvent.clear(rename);
  await userEvent.type(rename, "Personal{Enter}");
  await controls.findByRole("listitem", { name: firstLabel });
  await expect(global).toHaveDisplayValue(secondLabel);
  await expect(project).toHaveDisplayValue(firstLabel);
  section.scrollIntoView({ block: "start" });
  if (window.innerWidth < 768) {
    await expect(section.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    await expect(section.scrollWidth).toBeLessThanOrEqual(section.clientWidth);
  }
}

export const DuplicateAccountLabels: AppStory = {
  ...Desktop,
  render: () => <AppWithMocks setup={() => setupAccounts(false, "Personal")} />,
  play: async ({ canvasElement }) => exerciseDuplicateAccountLabels(canvasElement),
};

export const DuplicateAccountLabelsPhone: AppStory = {
  ...Phone,
  render: DuplicateAccountLabels.render,
  play: DuplicateAccountLabels.play,
};

async function exerciseRevokedSelections(canvasElement: HTMLElement) {
  const section = await openAccounts(canvasElement);
  const controls = within(section);
  const global = controls.getByRole("combobox", { name: "Global default account" });
  const project = controls.getByRole("combobox", { name: "/projects/my-app" });
  const work = within(controls.getByRole("listitem", { name: "Work" }));
  await expect(work.getByRole("button", { name: "Reconnect" })).toBeEnabled();

  for (const select of [global, project]) {
    // Stored selections stay visible, but revoked credentials cannot become new selections.
    await expect(select).toHaveValue("work");
    await expect(select).toHaveDisplayValue(/Work.*Reconnect required/);
    const options = within(select);
    await expect(options.getByRole("option", { name: "Personal" })).toBeEnabled();
    await expect(options.getByRole("option", { name: /^Work/ })).toBeDisabled();
    await userEvent.selectOptions(select, "default");
    await waitFor(() => expect(select).toHaveValue("default"));
    await waitFor(() => expect(select).toBeEnabled());
    await userEvent.selectOptions(select, "work");
    await expect(select).toHaveValue("default");
  }
  await expect(work.getByText("Reconnect required")).toBeVisible();
  await expect(controls.getAllByRole("listitem")).toHaveLength(2);

  await userEvent.click(work.getByRole("button", { name: "Reconnect" }));
  await waitFor(() => expect(work.queryByText("Reconnect required")).toBeNull());
  await expect(startLogin).toHaveBeenLastCalledWith({ accountId: "work" });
  for (const select of [global, project]) {
    await waitFor(() => expect(select).toBeEnabled());
    await expect(within(select).getByRole("option", { name: "Work" })).toBeEnabled();
    await userEvent.selectOptions(select, "work");
    await waitFor(() => expect(select).toHaveValue("work"));
  }
  section.scrollIntoView({ block: "start" });
  if (window.innerWidth < 768) {
    await expect(section.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    await expect(section.scrollWidth).toBeLessThanOrEqual(section.clientWidth);
  }
}

export const RevokedAccountSelections: AppStory = {
  ...Desktop,
  render: () => <AppWithMocks setup={() => setupAccounts(true)} />,
  play: async ({ canvasElement }) => exerciseRevokedSelections(canvasElement),
};

export const RevokedAccountSelectionsPhone: AppStory = {
  ...Phone,
  render: RevokedAccountSelections.render,
  play: RevokedAccountSelections.play,
};

function setupReconnectRequired(apiKeySet = false) {
  const client = setupAccounts();
  const providers: ProvidersConfigMap = {
    openai: {
      apiKeySet,
      isConfigured: apiKeySet,
      isEnabled: true,
      codexOauthSet: false,
      codexOauthDefaultAccountId: "work",
      codexOauthAccounts: [{ id: "work", label: "Work", reconnectRequired: true }],
    },
  };
  client.providers.getConfig = () => Promise.resolve(structuredClone(providers));
  const finishReconnect = () => {
    providers.openai.codexOauthAccounts = [{ id: "work", label: "Work" }];
    providers.openai.codexOauthSet = true;
    providers.openai.isConfigured = true;
    return Promise.resolve(Ok(undefined));
  };
  client.codexOauth.waitForDesktopFlow = finishReconnect;
  client.codexOauth.waitForDeviceFlow = finishReconnect;
  return client;
}

async function checkReconnectRequired(canvasElement: HTMLElement) {
  const section = await openAccounts(canvasElement);
  const controls = within(section);
  const work = within(controls.getByRole("listitem", { name: "Work" }));
  await expect(work.getByText("Reconnect required")).toBeVisible();
  await expect(controls.queryByText("Connected", { exact: true })).toBeNull();
  await expect(controls.getByRole("combobox", { name: "Global default account" })).toHaveValue(
    "work"
  );
  await expect(work.getByRole("button", { name: "Reconnect" })).toBeEnabled();
  section.scrollIntoView({ block: "start" });
  if (window.innerWidth < 768) {
    await expect(section.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    await expect(section.scrollWidth).toBeLessThanOrEqual(section.clientWidth);
  }
  return controls;
}

export const ReconnectRequired: AppStory = {
  globals: { viewport: { value: "desktop", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["desktop"] } } },
  render: () => <AppWithMocks setup={setupReconnectRequired} />,
  play: async ({ canvasElement }) => {
    await checkReconnectRequired(canvasElement);
  },
};

export const ReconnectRequiredPhone: AppStory = {
  ...ReconnectRequired,
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } } },
};

export const ReconnectRestoresAccount: AppStory = {
  render: () => <AppWithMocks setup={() => setupReconnectRequired(true)} />,
  play: async ({ canvasElement }) => {
    const controls = await checkReconnectRequired(canvasElement);
    const preference = controls.getByRole("combobox", { name: "Default auth (when both are set)" });
    await expect(preference).toBeEnabled();
    await expect(within(preference).getByRole("option", { name: /ChatGPT OAuth/ })).toBeDisabled();
    await userEvent.click(
      within(controls.getByRole("listitem", { name: "Work" })).getByRole("button", {
        name: "Reconnect",
      })
    );
    await controls.findByText("Connected", { exact: true });
    await expect(preference).toBeEnabled();
    await expect(within(preference).getByRole("option", { name: /ChatGPT OAuth/ })).toBeEnabled();
    await expect(controls.queryByText("Reconnect required")).toBeNull();
    await expect(controls.getAllByRole("listitem")).toHaveLength(1);
    await expect(controls.getByRole("combobox", { name: "Global default account" })).toHaveValue(
      "work"
    );
    await expect(startLogin).toHaveBeenLastCalledWith({ accountId: "work" });
  },
};

async function exerciseDisconnectedDefaultRecovery(canvasElement: HTMLElement) {
  const section = await openAccounts(canvasElement);
  const controls = within(section);
  const global = controls.getByRole("combobox", { name: "Global default account" });
  const preference = controls.getByRole("combobox", { name: "Default auth (when both are set)" });
  await userEvent.selectOptions(global, "work");
  await waitFor(() => expect(global).toHaveValue("work"));
  for (const name of ["Personal", "Work"]) {
    const account = controls.getByRole("listitem", { name });
    const disconnect = within(account).getByRole("button", { name: "Disconnect" });
    await waitFor(() => expect(disconnect).toBeEnabled());
    await userEvent.click(disconnect);
    await waitFor(() => expect(controls.queryByRole("listitem", { name })).toBeNull());
  }
  // Disconnect does not select another identity. Recovery requires an explicit auth choice.
  await expect(global).toHaveValue("work");
  await expect(global).toBeDisabled();
  await expect(preference).toHaveValue("oauth");
  await waitFor(() => expect(preference).toBeEnabled());
  await userEvent.selectOptions(preference, "apiKey");
  await waitFor(() => expect(preference).toHaveValue("apiKey"));
  await waitFor(() => expect(preference).toBeEnabled());
  await expect(within(preference).getByRole("option", { name: /ChatGPT OAuth/ })).toBeDisabled();
  await userEvent.selectOptions(preference, "oauth");
  await expect(preference).toHaveValue("apiKey");
  await expect(global).toHaveValue("work");
  section.scrollIntoView({ block: "start" });
  if (window.innerWidth < 768) {
    await expect(section.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    await expect(section.scrollWidth).toBeLessThanOrEqual(section.clientWidth);
  }
}

export const DisconnectedDefaultRecovery: AppStory = {
  ...Desktop,
  play: async ({ canvasElement }) => exerciseDisconnectedDefaultRecovery(canvasElement),
};

export const DisconnectedDefaultRecoveryPhone: AppStory = {
  ...Phone,
  play: DisconnectedDefaultRecovery.play,
};

let contextStream:
  | {
      finish: () => void;
      next: () => void;
      reportUsage: () => void;
      fallback: (model: string, effectiveContextLimit: number | null) => void;
    }
  | undefined;

function setupLiveContextLimit(workspaceId = "codex-live-limit") {
  contextStream = undefined;
  const model = "openai:gpt-5.5";
  const usage = { inputTokens: 100_000, outputTokens: 0, totalTokens: 100_000 };
  const client = setupAccounts(
    false,
    "Work",
    (workspaceId, emit) => {
      let turn = 0;
      const start = (effectiveContextLimit: number) => {
        turn += 1;
        const messageId = "context-turn-" + turn;
        emit({
          type: "stream-start",
          workspaceId,
          messageId,
          model,
          historySequence: turn,
          startTime: 1000 + turn,
          effectiveContextLimit,
        });
      };
      const refusedModels: string[] = [];
      let currentModel = model;
      contextStream = {
        fallback: (nextModel, effectiveContextLimit) => {
          refusedModels.push(currentModel);
          currentModel = nextModel;
          emit({
            type: "stream-model-update",
            workspaceId,
            messageId: "context-turn-" + turn,
            model: nextModel,
            metadataModel: nextModel,
            effectiveContextLimit,
            routedThroughGateway: false,
            modelFallback: { requestedModel: model, refusedModels: [...refusedModels] },
          });
        },
        reportUsage: () =>
          emit({
            type: "usage-delta",
            workspaceId,
            messageId: "context-turn-" + turn,
            usage,
            cumulativeUsage: usage,
          }),
        finish: () =>
          emit({
            type: "stream-end",
            workspaceId,
            messageId: "context-turn-" + turn,
            metadata: { model, usage, contextUsage: usage },
            parts: [{ type: "text", text: "The first turn is complete." }],
          }),
        next: () => start(500_000),
      };
      queueMicrotask(() => {
        emit({ type: "caught-up", hasOlderHistory: false });
        start(272_000);
      });
    },
    workspaceId
  );
  const getConfig = client.providers.getConfig;
  client.providers.getConfig = async () => {
    const providers = await getConfig();
    return {
      ...providers,
      openai: { ...providers.openai, models: [{ id: "gpt-5.5", contextWindowTokens: 500_000 }] },
    };
  };
  updatePersistedState(getModelKey(workspaceId), model);
  updatePersistedState(RIGHT_SIDEBAR_TAB_KEY, "costs");
  expandRightSidebar();
  return client;
}

async function checkContextMeters(
  canvasElement: HTMLElement,
  limit: string,
  percentage: string,
  tokens = "100.0k"
) {
  const canvas = within(canvasElement);
  await waitFor(
    async () => {
      await expect(
        canvas.getByRole("button", {
          name: new RegExp("Context usage: " + tokens + " / " + limit),
        })
      ).toHaveAccessibleName(expect.stringContaining(percentage));
      await expect(canvas.getByTestId("context-usage")).toHaveTextContent(limit);
      await expect(canvas.getByTestId("context-usage")).toHaveTextContent(percentage);
    },
    { timeout: 10000 }
  );
}

async function exerciseLiveContextLimit(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await checkContextMeters(canvasElement, "272.0k", "0.0%", "0");
  // Settings changes must not alter the accepted limit before the first usage event.
  const controls = within(await openAccounts(canvasElement));
  const global = controls.getByRole("combobox", { name: "Global default account" });
  const project = controls.getByRole("combobox", { name: "/projects/my-app" });
  await userEvent.selectOptions(global, "work");
  await waitFor(() => expect(global).toHaveValue("work"));
  await waitFor(() => expect(project).toBeEnabled());
  await userEvent.selectOptions(project, "work");
  await waitFor(() => expect(project).toHaveValue("work"));
  const preference = controls.getByRole("combobox", { name: "Default auth (when both are set)" });
  await waitFor(() => expect(preference).toBeEnabled());
  await userEvent.selectOptions(preference, "apiKey");
  await waitFor(() => expect(preference).toHaveValue("apiKey"));
  await userEvent.click(
    canvas.getAllByRole("button", { name: /Close settings|Back to previous page/ })[0]
  );
  await checkContextMeters(canvasElement, "272.0k", "0.0%", "0");
  if (!contextStream) throw new Error("The live context stream is missing");
  contextStream.reportUsage();
  await checkContextMeters(canvasElement, "272.0k", "36.8%");
  contextStream.finish();
  await checkContextMeters(canvasElement, "500.0k", "20.0%");
  contextStream.next();
  await checkContextMeters(canvasElement, "500.0k", "20.0%");
  if (window.innerWidth < 768) {
    const meter = canvas.getByTestId("context-usage");
    await expect(meter.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
  }
}

export const LiveContextLimit: AppStory = {
  render: () => <AppWithMocks setup={setupLiveContextLimit} />,
  play: async ({ canvasElement }) => exerciseLiveContextLimit(canvasElement),
};

export const LiveContextLimitPhone: AppStory = {
  ...LiveContextLimit,
  render: () => <AppWithMocks setup={() => setupLiveContextLimit("codex-live-limit-phone")} />,
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } } },
};

async function exerciseFallbackContextLimit(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await checkContextMeters(canvasElement, "272.0k", "0.0%", "0");
  if (!contextStream) throw new Error("The fallback context stream is missing");
  contextStream.reportUsage();
  await checkContextMeters(canvasElement, "272.0k", "36.8%", "100.0k");
  // No usage follows these updates. Both meters must immediately use each accepted fallback limit.
  contextStream.fallback("anthropic:claude-sonnet-4-5", 200_000);
  await checkContextMeters(canvasElement, "200.0k", "0.0%", "0");
  contextStream.fallback("openai:gpt-5.5", null);
  await waitFor(async () => {
    await expect(
      canvas.getByRole("button", { name: "Context usage: 0 (unknown limit)" })
    ).toBeVisible();
    await expect(within(canvas.getByTestId("context-usage")).queryByRole("slider")).toBeNull();
    await expect(canvas.getByTestId("context-usage")).not.toHaveTextContent("272.0k");
    await expect(canvas.getByTestId("context-usage")).not.toHaveTextContent("200.0k");
  });
  if (window.innerWidth < 768) {
    await expect(
      canvas.getByTestId("context-usage").getBoundingClientRect().right
    ).toBeLessThanOrEqual(window.innerWidth);
  }
}

export const FallbackContextLimit: AppStory = {
  render: () => <AppWithMocks setup={() => setupLiveContextLimit("codex-fallback-limit")} />,
  play: async ({ canvasElement }) => exerciseFallbackContextLimit(canvasElement),
};

export const FallbackContextLimitPhone: AppStory = {
  ...FallbackContextLimit,
  render: () => <AppWithMocks setup={() => setupLiveContextLimit("codex-fallback-limit-phone")} />,
  play: async ({ canvasElement }) => exerciseFallbackContextLimit(canvasElement),
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } } },
};

function setupLoginFailure() {
  const client = setupAccounts();
  let firstAttempt = true;
  let finishWait: () => void = () => undefined;
  client.codexOauth.startDeviceFlow = () => {
    if (firstAttempt) {
      firstAttempt = false;
      return Promise.resolve(Err("OpenAI login is unavailable. Try again."));
    }
    return Promise.resolve(
      Ok({
        flowId: "pending-login",
        userCode: "CODE-1234",
        verifyUrl: "https://auth.openai.com/codex/device",
        intervalSeconds: 5,
      })
    );
  };
  client.codexOauth.waitForDeviceFlow = () =>
    new Promise((resolve) => {
      finishWait = () => resolve(Err("Login cancelled"));
    });
  client.codexOauth.cancelDeviceFlow = () => {
    finishWait();
    return Promise.resolve();
  };
  client.codexOauth.setDefaultAccount = () => Promise.resolve(Err("Account update failed"));
  return client;
}

export const LoginFailureAndCancel: AppStory = {
  render: () => <AppWithMocks setup={setupLoginFailure} />,
  play: async ({ canvasElement }) => {
    const section = await openAccounts(canvasElement);
    const controls = within(section);
    const global = controls.getByRole("combobox", { name: "Global default account" });
    await userEvent.selectOptions(global, "work");
    await controls.findByRole("alert");
    await expect(global).toHaveValue("default");
    const name = controls.getByRole("textbox", { name: "New account name" });
    await userEvent.type(name, "Lab");
    await userEvent.click(controls.getByRole("button", { name: "Connect (Device)" }));
    await waitFor(() =>
      expect(controls.getByRole("alert")).toHaveTextContent(/login is unavailable/)
    );
    await expect(controls.getAllByRole("listitem")).toHaveLength(2);
    await userEvent.click(controls.getByRole("button", { name: "Connect (Device)" }));
    await controls.findByText("CODE-1234");
    await expect(name).toBeDisabled();
    await userEvent.click(controls.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(name).toBeEnabled());
    await expect(controls.queryByText("CODE-1234")).toBeNull();
    await expect(controls.queryByRole("alert")).toBeNull();
    await expect(controls.getAllByRole("listitem")).toHaveLength(2);
    section.scrollIntoView({ block: "start" });
  },
};

function setupScopedAccount(kind: "subproject" | "multi" | "creation") {
  const root = "/projects/account-root";
  const subproject = root + "/sub";
  const workspace = createWorkspace({
    id: "scoped-account",
    name: "main",
    projectName: "account-root",
    projectPath: root,
  });
  if (kind === "subproject") workspace.subProjectPath = subproject;
  if (kind === "multi") {
    workspace.projectPath = MULTI_PROJECT_CONFIG_KEY;
    workspace.projects = [
      { projectPath: subproject, projectName: "sub" },
      { projectPath: root, projectName: "account-root" },
    ];
  }
  selectWorkspace(workspace);
  if (kind === "creation") {
    expandLeftSidebar();
    expandProjects([root, subproject]);
  } else {
    collapseLeftSidebar();
  }
  const projects = groupWorkspacesByProject([workspace]);
  projects.set(root, {
    ...projects.get(root),
    codexOauthAccountId: "default",
    workspaces: projects.get(root)?.workspaces ?? [],
  });
  projects.set(subproject, {
    parentProjectPath: root,
    codexOauthAccountId: "deleted",
    workspaces: [],
  });
  return createMockORPCClient({
    projects,
    workspaces: [workspace],
    agentAiDefaults: {
      exec: { modelString: "openai:gpt-5.3-codex-spark" },
      plan: { modelString: "openai:gpt-5.3-codex-spark" },
    },
    providersList: ["openai"],
    providersConfig: {
      openai: {
        apiKeySet: true,
        isConfigured: true,
        isEnabled: true,
        codexOauthSet: true,
        codexOauthAccounts: [{ id: "default", label: "Personal" }],
      },
    },
  });
}

async function checkScopedAccountWarning(canvasElement: HTMLElement) {
  const warning = await within(canvasElement).findByTestId(
    "codex-oauth-warning-banner",
    {},
    { timeout: 10000 }
  );
  await waitFor(() => expect(warning).toBeVisible());
  if (window.innerWidth < 768) {
    await expect(warning.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
  }
}

export const SubprojectRouting: AppStory = {
  render: () => <AppWithMocks setup={() => setupScopedAccount("subproject")} />,
  play: async ({ canvasElement }) => checkScopedAccountWarning(canvasElement),
};

export const MultiProjectRouting: AppStory = {
  render: () => <AppWithMocks setup={() => setupScopedAccount("multi")} />,
  play: SubprojectRouting.play,
};

export const SubprojectRoutingPhone: AppStory = {
  ...SubprojectRouting,
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark"], viewports: ["phone"] } } },
};

export const CreationSubprojectRouting: AppStory = {
  render: () => <AppWithMocks setup={() => setupScopedAccount("creation")} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "New chat in sub-project" }, { timeout: 10000 })
    );
    await checkScopedAccountWarning(canvasElement);
  },
};

function setupProjectTitle() {
  const client = setupAccounts();
  generateTitle.mockClear();
  client.nameGeneration.generate = (input) => {
    generateTitle(input);
    return Promise.resolve(
      Ok({ name: "project-title", title: "Project title", modelUsed: "openai:gpt-5.5" })
    );
  };
  return client;
}

export const TitleUsesProject: AppStory = {
  render: () => <AppWithMocks setup={setupProjectTitle} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const newChat = await canvas.findByRole(
      "button",
      { name: "New chat in my-app" },
      { timeout: 10000 }
    );
    newChat.focus();
    await userEvent.keyboard("{Enter}");
    const message = await canvas.findByRole("textbox", { name: "Message Claude" });
    await userEvent.type(message, "Fix the project title");
    await waitFor(() =>
      expect(generateTitle).toHaveBeenLastCalledWith(
        expect.objectContaining({ projectPath: "/projects/my-app" })
      )
    );
    await waitFor(() =>
      expect(canvasElement.querySelector("#workspace-name")).toHaveValue("project-title")
    );
  },
};
