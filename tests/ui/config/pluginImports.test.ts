import "../dom";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { shouldRunIntegrationTests } from "../../testUtils";
import { preloadTestModules } from "../../ipc/setup";
import { createTempGitRepo, cleanupTempGitRepo } from "../../ipc/helpers";
import { createAppHarness, type AppHarness } from "../harness";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 } from "@/node/services/agentPlugins/manifest";
import { AGENT_PLUGIN_MCP_SCHEMA_ID_1_0_0 } from "@/node/services/agentPlugins/mcpConfig";
import { execFileAsync } from "@/node/utils/disposableExec";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

async function commit(remote: string) {
  using add = execFileAsync("git", ["-C", remote, "add", "-A"]);
  await add.result;
  using save = execFileAsync("git", ["-C", remote, "commit", "-qm", "Plugin fixture"]);
  await save.result;
}

async function openPreview(app: AppHarness, remote: string) {
  const canvas = within(app.view.container);
  fireEvent.click(await canvas.findByTestId("settings-button"));
  fireEvent.click((await canvas.findAllByRole("button", { name: "Plugins" }))[0]);
  fireEvent.click(await canvas.findByRole("button", { name: "Add plugin" }));
  const user = userEvent.setup({ document: app.view.container.ownerDocument });
  await user.type(canvas.getByLabelText("Git URL or owner/repo"), remote);
  await user.click(canvas.getByRole("button", { name: "Preview" }));
  await canvas.findByRole("checkbox", { name: "review" }, { timeout: 10000 });
  return { canvas, user };
}

async function inventory(app: AppHarness) {
  const result = await app.env.orpc.agentPlugins.getComponents({ name: "review-tools" });
  if (!result.success) throw new Error(result.error);
  return result.data;
}

// Full AppLoader + real IPC/services/git. Only one-shot failures are injected;
// every successful mutation goes through the actual registry and discovery path.
describeIntegration("Selective plugin imports", () => {
  let remote: string;
  let app: AppHarness;
  beforeAll(preloadTestModules);
  beforeEach(async () => {
    remote = await createTempGitRepo();
    await fs.writeFile(
      path.join(remote, "plugin.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
        name: "review-tools",
        version: "1.0.0",
      })
    );
    for (const name of ["review", "research"]) {
      await fs.mkdir(path.join(remote, "skills", name), { recursive: true });
      await fs.writeFile(
        path.join(remote, "skills", name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name} a change\n---\nInstructions\n`
      );
    }
    await fs.writeFile(
      path.join(remote, "mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA_ID_1_0_0,
        mcpServers: {
          reference: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/reference.js"] },
        },
      })
    );
    await commit(remote);
    app = await createAppHarness({
      aiMode: "none",
      branchPrefix: "plugin-imports",
      beforeRenderEnvironment: async (env) => {
        await env.orpc.experiments.setOverride({
          experimentId: EXPERIMENT_IDS.AGENT_PLUGINS,
          enabled: true,
        });
      },
    });
  }, 120000);
  afterEach(async () => {
    jest.restoreAllMocks();
    await app?.dispose();
    await cleanupTempGitRepo(remote);
  });

  test("empty install retains choices after failure; add is additive, cancellable, keyboard accessible and retryable", async () => {
    const { canvas, user } = await openPreview(app, remote);
    for (const checkbox of canvas.getAllByRole("checkbox"))
      expect(checkbox.getAttribute("aria-checked")).toBe("true");
    const firstSkill = canvas.getByRole("checkbox", { name: "research" });
    firstSkill.focus();
    await user.keyboard(" ");
    expect(firstSkill.getAttribute("aria-checked")).toBe("false");
    await user.tab();
    expect(app.view.container.ownerDocument.activeElement?.getAttribute("aria-label")).toBe(
      "review"
    );
    for (const name of ["Skills", "MCP servers"]) {
      await user.click(
        within(canvas.getByRole("group", { name })).getByRole("button", { name: "Clear" })
      );
    }
    const install = canvas.getByRole("button", { name: "Install" });
    expect(install.hasAttribute("disabled")).toBe(false);
    const installSpy = jest
      .spyOn(app.env.services.agentPluginInstallService, "install")
      .mockRejectedValueOnce(new Error("Install unavailable"));
    install.focus();
    await user.keyboard("{Enter}");
    await canvas.findByText("Install unavailable");
    for (const checkbox of canvas.getAllByRole("checkbox"))
      expect(checkbox.getAttribute("aria-checked")).toBe("false");
    await user.click(install);
    await canvas.findByText(/0 of 2 skills imported/, {}, { timeout: 10000 });
    expect(installSpy).toHaveBeenCalledTimes(2);
    expect((await inventory(app)).importedComponents).toEqual({ skills: [], mcpServers: [] });

    await user.click(canvas.getByRole("button", { name: "Add components to review-tools" }));
    await canvas.findByRole("checkbox", { name: "research" });
    expect(canvas.getByRole("button", { name: "Import selected" }).hasAttribute("disabled")).toBe(
      true
    );
    await user.click(canvas.getByRole("checkbox", { name: "review" }));
    await user.click(canvas.getByRole("button", { name: "Cancel" }));
    expect((await inventory(app)).importedComponents?.skills).toEqual([]);
    await user.click(canvas.getByRole("button", { name: "Add components to review-tools" }));
    expect(
      (await canvas.findByRole("checkbox", { name: "review" })).getAttribute("aria-checked")
    ).toBe("false");
    await user.click(canvas.getByRole("checkbox", { name: "review" }));
    jest
      .spyOn(app.env.services.agentPluginInstallService, "addComponents")
      .mockRejectedValueOnce(new Error("Registry busy"));
    await user.click(canvas.getByRole("button", { name: "Import selected" }));
    await canvas.findByText("Registry busy");
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Import selected" }).hasAttribute("disabled")).toBe(
        false
      )
    );
    expect(canvas.getByRole("checkbox", { name: "review" }).getAttribute("aria-checked")).toBe(
      "true"
    );
    await user.click(canvas.getByRole("button", { name: "Import selected" }));
    await canvas.findByText(/1 of 2 skills imported/);
    expect(canvas.getByRole("checkbox", { name: "review" }).hasAttribute("disabled")).toBe(true);
    expect((await inventory(app)).importedComponents).toEqual({
      skills: ["review"],
      mcpServers: [],
    });
    for (const name of ["Skills", "MCP servers"]) {
      await user.click(
        within(canvas.getByRole("group", { name })).getByRole("button", { name: "Select all" })
      );
    }
    await user.click(canvas.getByRole("button", { name: "Import selected" }));
    await canvas.findByText(/2 of 2 skills imported/);
    await canvas.findByText(/already imported/);
    expect(canvas.getByRole("button", { name: "Import selected" }).hasAttribute("disabled")).toBe(
      true
    );
    expect((await inventory(app)).importedComponents).toEqual({
      skills: ["research", "review"],
      mcpServers: ["reference"],
    });
  }, 120000);

  test.each(["button", "keyboard", "palette"] as const)(
    "reopening installation via %s clears prior success through the next failed attempt",
    async (entryPoint) => {
      const { canvas, user } = await openPreview(app, remote);
      await user.click(canvas.getByRole("button", { name: "Install" }));
      await canvas.findByText("Plugin installed.", {}, { timeout: 10000 });

      if (entryPoint === "palette") {
        await user.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
        const palette = within(app.view.container.ownerDocument.body);
        await user.type(await palette.findByLabelText("Command palette"), "> Install Agent Plugin");
        await user.click(await palette.findByRole("option", { name: "Install Agent Plugin…" }));
      } else {
        const add = canvas.getByRole("button", { name: "Add plugin" });
        if (entryPoint === "keyboard") {
          add.focus();
          await user.keyboard("{Enter}");
        } else {
          await user.click(add);
        }
      }
      const sourceInput = await canvas.findByLabelText("Git URL or owner/repo");
      expect(canvas.queryByText("Plugin installed.")).toBeNull();

      await fs.writeFile(
        path.join(remote, "plugin.json"),
        JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "other-tools" })
      );
      await commit(remote);
      await user.type(sourceInput, remote);
      await user.click(canvas.getByRole("button", { name: "Preview" }));
      await canvas.findByRole("checkbox", { name: "review" }, { timeout: 10000 });
      expect(canvas.queryByText("Plugin installed.")).toBeNull();
      jest
        .spyOn(app.env.services.agentPluginInstallService, "install")
        .mockRejectedValueOnce(new Error("Second install unavailable"));
      await user.click(canvas.getByRole("button", { name: "Install" }));
      await canvas.findByRole("alert");
      expect(canvas.queryByText("Plugin installed.")).toBeNull();
      expect(canvas.getByRole("button", { name: "Install" }).hasAttribute("disabled")).toBe(false);
    },
    120000
  );

  test("same-SHA local file edits refresh inventory and require explicit reselection", async () => {
    const { canvas, user } = await openPreview(app, remote);
    await user.click(canvas.getByRole("checkbox", { name: "research" }));
    await user.click(canvas.getByRole("checkbox", { name: "reference" }));
    await user.click(canvas.getByRole("button", { name: "Install" }));
    await canvas.findByText(/1 of 2 skills imported/, {}, { timeout: 10000 });
    await user.click(canvas.getByRole("button", { name: "Add components to review-tools" }));
    await user.click(await canvas.findByRole("checkbox", { name: "research" }));
    const before = await inventory(app);
    const skillFile = path.join(
      app.env.config.rootDir,
      "plugins",
      "review-tools",
      "skills",
      "research",
      "SKILL.md"
    );
    await fs.appendFile(skillFile, "Changed local skill instructions\n");
    await user.click(canvas.getByRole("button", { name: "Import selected" }));
    await waitFor(() => {
      expect(canvas.getByRole("checkbox", { name: "research" }).getAttribute("aria-checked")).toBe(
        "false"
      );
      expect(canvas.getByRole("button", { name: "Import selected" }).hasAttribute("disabled")).toBe(
        true
      );
    });
    expect(await canvas.findByRole("alert")).toBeDefined();
    const refreshed = await inventory(app);
    expect(refreshed.lockedSha).toBe(before.lockedSha);
    expect(refreshed.contentHash).not.toBe(before.contentHash);
    expect(refreshed.importedComponents?.skills).toEqual(["review"]);
    await user.click(canvas.getByRole("checkbox", { name: "research" }));
    await user.click(canvas.getByRole("button", { name: "Import selected" }));
    await canvas.findByText(/2 of 2 skills imported/);
    expect((await inventory(app)).importedComponents?.skills).toEqual(["research", "review"]);
  }, 120000);

  test("accepted new previews reset choices; inventory retries and stale versions require reselection after an update", async () => {
    const { canvas, user } = await openPreview(app, remote);
    await user.click(canvas.getByRole("checkbox", { name: "review" }));
    await user.click(canvas.getByRole("button", { name: "Back" }));
    await user.click(canvas.getByRole("button", { name: "Preview" }));
    expect(
      (await canvas.findByRole("checkbox", { name: "review" })).getAttribute("aria-checked")
    ).toBe("true");
    await user.click(canvas.getByRole("checkbox", { name: "research" }));
    await user.click(canvas.getByRole("checkbox", { name: "reference" }));
    await user.click(canvas.getByRole("button", { name: "Install" }));
    await canvas.findByText(/1 of 2 skills imported/, {}, { timeout: 10000 });
    jest
      .spyOn(app.env.services.agentPluginInstallService, "getComponents")
      .mockRejectedValueOnce(new Error("Inventory unavailable"));
    await user.click(canvas.getByRole("button", { name: "Add components to review-tools" }));
    await canvas.findByText("Inventory unavailable");
    await user.click(canvas.getByRole("button", { name: "Retry inventory" }));
    await user.click(await canvas.findByRole("checkbox", { name: "research" }));
    const before = await inventory(app);
    // Update through the real UI while its older component review remains open.
    await fs.writeFile(path.join(remote, "README.txt"), "Capability-neutral update\n");
    await commit(remote);
    await user.click(canvas.getByRole("button", { name: "Check for updates" }));
    await user.click(await canvas.findByRole("button", { name: "Update" }, { timeout: 10000 }));
    await waitFor(async () => expect((await inventory(app)).lockedSha).not.toBe(before.lockedSha), {
      timeout: 10000,
    });
    await user.click(canvas.getByRole("button", { name: "Import selected" }));
    await canvas.findByRole("alert");
    await waitFor(() =>
      expect(canvas.getByRole("checkbox", { name: "research" }).getAttribute("aria-checked")).toBe(
        "false"
      )
    );
    expect(canvas.getByRole("button", { name: "Import selected" }).hasAttribute("disabled")).toBe(
      true
    );
    expect((await inventory(app)).importedComponents).toEqual({
      skills: ["review"],
      mcpServers: [],
    });
    await user.click(canvas.getByRole("checkbox", { name: "research" }));
    await user.click(canvas.getByRole("button", { name: "Import selected" }));
    await canvas.findByText(/2 of 2 skills imported/);
    expect((await inventory(app)).importedComponents?.skills).toEqual(["research", "review"]);
  }, 120000);
});
