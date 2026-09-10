import "./dom";
import React from "react";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { APIProvider } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { BackupSection } from "@/browser/features/Settings/Sections/BackupSection";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";

type MockOptions = Parameters<typeof createMockORPCClient>[0];
type MockClient = ReturnType<typeof createMockORPCClient>;

function backupSectionTree(client: MockClient) {
  return React.createElement(
    ThemeProvider,
    null,
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(APIProvider, {
        client,
        children: React.createElement(BackupSection),
      })
    )
  );
}

function renderBackupSection(
  overrides: Partial<NonNullable<MockOptions>> = {},
  setupClient?: (client: MockClient) => void
) {
  const client = createMockORPCClient({
    backupSettings: {
      repoUrl: "git@github.com:example/dotfiles.git",
      branch: "main",
      path: "mux/",
    },
    backupValidation: {
      reachable: true,
      empty: false,
      credential: "gh",
    },
    backupPreview: {
      pushChanges: [{ status: "M", path: "mux/preferences.json" }],
      restoreChanges: [{ status: "A", path: "skills/release/SKILL.md" }],
      localOnlyFiles: ["agents/local-only.md"],
      redactions: ["mcp.jsonc: github.headers.Authorization"],
      commandApprovals: [],
      projectImports: [],
      projectBundleSkipped: false,
      pushError: null,
    },
    backupRestore: {
      commit: "def5678",
      snapshotPath: "/tmp/mux-backup-snapshot",
      changedFiles: ["preferences.json"],
      localOnlyFiles: ["agents/local.md"],
      projectImportResults: [],
      projectBundleSkipped: false,
      unapprovedProjectImports: [],
    },
    ...overrides,
  });

  setupClient?.(client);

  const view = render(backupSectionTree(client));

  return { client, view };
}
async function confirmRestore(canvas: ReturnType<typeof within>): Promise<void> {
  fireEvent.click(canvas.getByRole("button", { name: /^Restore$/ }));
  const dialog = await within(document.body).findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: /Restore settings/i }));
}

describe("BackupSection", () => {
  afterEach(() => {
    cleanup();
  });

  test("shows both preview directions, local-only files, and redactions", async () => {
    const { view } = renderBackupSection();
    const canvas = within(view.container);

    await canvas.findByText("Settings backup");
    fireEvent.click(canvas.getByRole("button", { name: "Preview changes" }));

    await canvas.findByText("Backup to repository");
    expect(canvas.getByText("mux/preferences.json")).toBeTruthy();
    expect(canvas.getByText("Restore to this device")).toBeTruthy();
    expect(canvas.getByText("skills/release/SKILL.md")).toBeTruthy();
    expect(canvas.getByText(/github\.headers\.Authorization/i)).toBeTruthy();
    expect(canvas.getByText("agents/local-only.md")).toBeTruthy();
    // Preview discards the export's secret scan, so an override offered here would let a
    // push publish secrets without ever showing the blocked-file list.
    expect(canvas.queryByRole("checkbox", { name: "Override secret scan" })).toBeNull();
  });

  test("refreshes backup settings changed by another window", async () => {
    const { client, view } = renderBackupSection();
    const canvas = within(view.container);
    const repoInput = await canvas.findByLabelText("Repository URL");

    expect((repoInput as HTMLInputElement).value).toBe("git@github.com:example/dotfiles.git");

    await act(async () => {
      await client.backup.saveSettings({
        repoUrl: "git@github.com:example/other.git",
        branch: "release",
        path: "shared/",
      });
    });

    await waitFor(() =>
      expect((repoInput as HTMLInputElement).value).toBe("git@github.com:example/other.git")
    );

    const preview = jest.spyOn(client.backup, "preview");
    fireEvent.click(canvas.getByRole("button", { name: "Preview changes" }));
    await waitFor(() =>
      expect(preview).toHaveBeenCalledWith({
        repoUrl: "git@github.com:example/other.git",
        branch: "release",
        path: "shared/",
        includeProjects: false,
      })
    );
    await canvas.findByText("Backup to repository");
  });

  test("loads settings when the config change subscription fails", async () => {
    const { view } = renderBackupSection({}, (client) => {
      jest
        .spyOn(client.config, "onConfigChanged")
        .mockImplementation(() => Promise.reject(new Error("ipc failure")));
    });
    const canvas = within(view.container);

    const repoInput = await canvas.findByLabelText("Repository URL");
    expect((repoInput as HTMLInputElement).value).toBe("git@github.com:example/dotfiles.git");

    await waitFor(() =>
      expect(canvas.getByRole("button", { name: /^Restore$/ }).hasAttribute("disabled")).toBe(true)
    );
  });

  test("loads settings while the config change subscription is pending", async () => {
    const { view } = renderBackupSection({}, (client) => {
      const pendingSubscription = new Promise<
        Awaited<ReturnType<typeof client.config.onConfigChanged>>
      >(() => undefined);
      jest.spyOn(client.config, "onConfigChanged").mockReturnValue(pendingSubscription);
    });
    const canvas = within(view.container);

    const repoInput = await canvas.findByLabelText("Repository URL");
    expect((repoInput as HTMLInputElement).value).toBe("git@github.com:example/dotfiles.git");

    expect(canvas.getByRole("button", { name: /^Restore$/ }).hasAttribute("disabled")).toBe(true);
  });

  test("enables actions once the armed subscription confirms freshness", async () => {
    const { view } = renderBackupSection();
    const canvas = within(view.container);

    await canvas.findByLabelText("Repository URL");
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: /^Restore$/ }).hasAttribute("disabled")).toBe(false)
    );
  });

  test("disables destructive actions once the config stream dies", async () => {
    let failStream!: (error: Error) => void;
    const { view } = renderBackupSection({}, (client) => {
      const real = client.config.onConfigChanged.bind(client.config);
      jest.spyOn(client.config, "onConfigChanged").mockImplementation(async (input, options) => {
        const iterator = await real(input, options);
        const failure = new Promise<never>((_, reject) => {
          failStream = reject;
        });
        return {
          next: () => Promise.race([failure, iterator.next()]),
          return: iterator.return?.bind(iterator),
        } as typeof iterator;
      });
    });
    const canvas = within(view.container);

    await canvas.findByLabelText("Repository URL");
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: /^Restore$/ }).hasAttribute("disabled")).toBe(false)
    );

    await act(async () => {
      failStream(new Error("stream torn down"));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(canvas.getByRole("button", { name: /^Restore$/ }).hasAttribute("disabled")).toBe(true)
    );
  });

  test("does not carry config stream liveness across API replacements", async () => {
    const { view } = renderBackupSection({}, (client) => {
      const subscription = client.config.onConfigChanged();
      jest.spyOn(client.config, "onConfigChanged").mockImplementation(async () => {
        const iterator = await subscription;
        jest
          .spyOn(iterator, "next")
          .mockImplementation(() => new Promise<IteratorResult<void>>(() => undefined));
        return iterator;
      });
    });
    const canvas = within(view.container);

    await canvas.findByLabelText("Repository URL");
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: /^Restore$/ }).hasAttribute("disabled")).toBe(false)
    );

    const replacement = createMockORPCClient({
      backupSettings: {
        repoUrl: "git@github.com:example/replacement.git",
        branch: "main",
        path: "mux/",
      },
    });
    const getSettings = jest.spyOn(replacement.backup, "getSettings");
    jest
      .spyOn(replacement.config, "onConfigChanged")
      .mockImplementation(() => Promise.reject(new Error("replacement stream failed")));

    view.rerender(backupSectionTree(replacement));

    await waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));
    expect(canvas.getByRole("button", { name: /^Restore$/ }).hasAttribute("disabled")).toBe(true);
  });

  test("re-reads config after a save instead of trusting the save response", async () => {
    const { view } = renderBackupSection({}, (client) => {
      const pendingSubscription = new Promise<
        Awaited<ReturnType<typeof client.config.onConfigChanged>>
      >(() => undefined);
      jest.spyOn(client.config, "onConfigChanged").mockReturnValue(pendingSubscription);
      jest.spyOn(client.backup, "getSettings").mockResolvedValue({
        repoUrl: "git@github.com:example/other-window.git",
        branch: "release",
        path: "shared/",
      });
    });
    const canvas = within(view.container);
    const repoInput = await canvas.findByLabelText("Repository URL");
    await waitFor(() =>
      expect((repoInput as HTMLInputElement).value).toBe("git@github.com:example/other-window.git")
    );

    fireEvent.change(repoInput, { target: { value: "git@github.com:example/mine.git" } });
    await act(async () => {
      fireEvent.click(canvas.getByRole("button", { name: "Save settings" }));
    });

    await waitFor(() =>
      expect((repoInput as HTMLInputElement).value).toBe("git@github.com:example/other-window.git")
    );

    expect(canvas.getByRole("button", { name: /^Restore$/ }).hasAttribute("disabled")).toBe(true);
  });

  test("keeps actions disabled when saving without a live subscription", async () => {
    const { view } = renderBackupSection({}, (client) => {
      jest
        .spyOn(client.config, "onConfigChanged")
        .mockImplementation(() => Promise.reject(new Error("ipc failure")));
    });
    const canvas = within(view.container);
    const repoInput = await canvas.findByLabelText("Repository URL");

    fireEvent.change(repoInput, { target: { value: "git@github.com:example/mine.git" } });
    await act(async () => {
      fireEvent.click(canvas.getByRole("button", { name: "Save settings" }));
    });

    await canvas.findByText("Backup settings saved.");
    expect(canvas.getByRole("button", { name: /^Restore$/ }).hasAttribute("disabled")).toBe(true);
  });

  test("refreshes after subscription setup to catch changes made during setup", async () => {
    type ConfigSubscription = Awaited<ReturnType<MockClient["config"]["onConfigChanged"]>>;
    let establishSubscription!: () => Promise<void>;
    const { client, view } = renderBackupSection({}, (client) => {
      const subscription = client.config.onConfigChanged();
      const pendingSubscription = new Promise<ConfigSubscription>((resolve) => {
        establishSubscription = async () => {
          resolve(await subscription);
        };
      });
      jest.spyOn(client.config, "onConfigChanged").mockReturnValue(pendingSubscription);
    });
    const canvas = within(view.container);
    const repoInput = await canvas.findByLabelText("Repository URL");

    await act(async () => {
      await client.backup.saveSettings({
        repoUrl: "git@github.com:example/during-setup.git",
        branch: "release",
        path: "shared/",
      });
      await establishSubscription();
    });

    await waitFor(() =>
      expect((repoInput as HTMLInputElement).value).toBe("git@github.com:example/during-setup.git")
    );
  });

  test("wires keyboard actions through save, validate, preview, backup, and restore", async () => {
    const { client, view } = renderBackupSection();
    const canvas = within(view.container);

    await canvas.findByText("Settings backup");
    const repoInput = canvas.getByLabelText("Repository URL");
    fireEvent.change(repoInput, { target: { value: "git@github.com:example/new.git" } });

    const saveSettings = jest.spyOn(client.backup, "saveSettings");
    const validate = jest.spyOn(client.backup, "validate");
    const preview = jest.spyOn(client.backup, "preview");
    const push = jest.spyOn(client.backup, "push");
    const restore = jest.spyOn(client.backup, "restore");

    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true, altKey: true });
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Save settings" }).hasAttribute("disabled")).toBe(
        true
      )
    );

    fireEvent.keyDown(window, { key: "v", code: "KeyV", ctrlKey: true, altKey: true });
    await waitFor(() => expect(validate).toHaveBeenCalledTimes(1));
    await canvas.findByText(/Credential used:/i);

    fireEvent.keyDown(window, { key: "e", code: "KeyE", ctrlKey: true, altKey: true });
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
    await canvas.findByText("Backup to repository");

    fireEvent.keyDown(window, { key: "b", code: "KeyB", ctrlKey: true, altKey: true });
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith({
        repoUrl: "git@github.com:example/new.git",
        branch: "main",
        path: "mux/",
        includeProjects: false,
        approvedSecretDigest: undefined,
      })
    );

    fireEvent.keyDown(window, { key: "r", code: "KeyR", ctrlKey: true, altKey: true });
    const dialog = await within(document.body).findByRole("dialog");
    expect(within(dialog).getByText(/safety snapshot/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /Restore settings/i }));
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
    await canvas.findByText(/Restored 1 file/i);
  });

  test("exposes the override after a secret-scan block without running a preview first", async () => {
    const { client, view } = renderBackupSection();
    const canvas = within(view.container);
    await canvas.findByText("Settings backup");

    expect(canvas.queryByRole("checkbox", { name: "Override secret scan" })).toBeNull();

    jest.spyOn(client.backup, "push").mockResolvedValueOnce({
      success: false,
      error: {
        code: "SECRET_DETECTED",
        message: "Potential secrets were found in the backup payload: AGENTS.md",
        files: ["AGENTS.md"],
      },
    });

    fireEvent.click(canvas.getByRole("button", { name: "Back up now" }));

    await canvas.findByText(/Potential secrets were found/i);
    const override = canvas.getByRole("checkbox", { name: "Override secret scan" });
    expect(override.getAttribute("data-state")).toBe("unchecked");

    fireEvent.keyDown(window, { key: "o", code: "KeyO", ctrlKey: true, altKey: true });
    await waitFor(() => expect(override.getAttribute("data-state")).toBe("checked"));
  });

  test("sends the approved digest and resets when the blocked payload changes", async () => {
    const { client, view } = renderBackupSection();
    const canvas = within(view.container);
    await canvas.findByText("Settings backup");

    const push = jest.spyOn(client.backup, "push").mockResolvedValueOnce({
      success: false,
      error: {
        code: "SECRET_DETECTED",
        message: "Potential secrets",
        files: ["skills/demo/config.yaml"],
        secretApproval: "digest-a",
      },
    });
    fireEvent.click(canvas.getByRole("button", { name: "Back up now" }));

    const override = await canvas.findByRole("checkbox", { name: "Override secret scan" });
    fireEvent.click(override);
    await waitFor(() => expect(override.getAttribute("data-state")).toBe("checked"));

    push.mockResolvedValueOnce({
      success: false,
      error: {
        code: "SECRET_DETECTED",
        message: "Potential secrets",
        files: ["skills/demo/config.yaml"],
        secretApproval: "digest-b",
      },
    });
    fireEvent.click(canvas.getByRole("button", { name: "Back up now" }));
    await waitFor(() =>
      expect(push).toHaveBeenLastCalledWith(
        expect.objectContaining({ approvedSecretDigest: "digest-a" })
      )
    );
    await waitFor(() => expect(override.getAttribute("data-state")).toBe("unchecked"));

    fireEvent.click(override);
    await waitFor(() => expect(override.getAttribute("data-state")).toBe("checked"));
    push.mockResolvedValueOnce({
      success: true,
      data: { commit: "abc1234", changed: true, credential: "ssh", redactions: [] },
    });
    fireEvent.click(canvas.getByRole("button", { name: "Back up now" }));
    await waitFor(() =>
      expect(push).toHaveBeenLastCalledWith(
        expect.objectContaining({ approvedSecretDigest: "digest-b" })
      )
    );
  });

  test("stops sending a secret override once a non-secret failure hides it", async () => {
    const { client, view } = renderBackupSection();
    const canvas = within(view.container);
    await canvas.findByText("Settings backup");

    const push = jest.spyOn(client.backup, "push").mockResolvedValueOnce({
      success: false,
      error: { code: "SECRET_DETECTED", message: "Potential secrets", files: ["AGENTS.md"] },
    });
    fireEvent.click(canvas.getByRole("button", { name: "Back up now" }));

    const override = await canvas.findByRole("checkbox", { name: "Override secret scan" });
    fireEvent.click(override);
    await waitFor(() => expect(override.getAttribute("data-state")).toBe("checked"));

    push.mockResolvedValueOnce({
      success: false,
      error: { code: "AUTH_FAILED", message: "Could not authenticate" },
    });
    fireEvent.click(canvas.getByRole("button", { name: "Back up now" }));
    await canvas.findByText(/Could not authenticate/i);

    // The control is gone, so no invisible override may survive to authorize a retry.
    expect(canvas.queryByRole("checkbox", { name: "Override secret scan" })).toBeNull();
    fireEvent.click(canvas.getByRole("button", { name: "Back up now" }));
    await waitFor(() =>
      expect(push).toHaveBeenLastCalledWith(
        expect.objectContaining({ approvedSecretDigest: undefined })
      )
    );
  });

  test("requires approving an incoming MCP command before restore sends its token", async () => {
    const approval = {
      path: "servers.notes.command",
      command: "npx -y @modelcontextprotocol/server-filesystem /data",
      token: "token-notes",
    };
    const { client, view } = renderBackupSection({
      backupPreview: {
        pushChanges: [],
        restoreChanges: [{ status: "M", path: "mcp.jsonc" }],
        localOnlyFiles: [],
        redactions: [],
        commandApprovals: [approval],
        projectImports: [],
        projectBundleSkipped: false,
        pushError: null,
      },
    });
    const canvas = within(view.container);
    await canvas.findByText("Settings backup");

    expect(canvas.queryByRole("checkbox", { name: "Approve MCP command changes" })).toBeNull();
    fireEvent.click(canvas.getByRole("button", { name: "Preview changes" }));

    const approve = await canvas.findByRole("checkbox", {
      name: "Approve MCP command changes",
    });
    expect(canvas.getByText(approval.command)).toBeTruthy();

    // The backup drifted since the preview: the blocked restore reports a different
    // command, and the section must display that list instead of the stale one.
    const drifted = {
      path: "servers.notes.command",
      command: "npx -y some-other-tool",
      token: "token-drifted",
    };
    const restore = jest.spyOn(client.backup, "restore").mockResolvedValueOnce({
      success: false,
      error: {
        code: "COMMAND_APPROVAL_REQUIRED",
        message: "This backup would replace executable MCP commands.",
        files: [`${drifted.path}: ${drifted.command}`],
        commandApprovals: [drifted],
      },
    });
    await confirmRestore(canvas);
    await waitFor(() =>
      expect(restore).toHaveBeenLastCalledWith(
        expect.objectContaining({ approvedCommandTokens: [] })
      )
    );
    await canvas.findByText(drifted.command);
    expect(canvas.queryByText(approval.command)).toBeNull();

    fireEvent.click(approve);
    await waitFor(() => expect(approve.getAttribute("data-state")).toBe("checked"));
    await confirmRestore(canvas);
    await waitFor(() =>
      expect(restore).toHaveBeenLastCalledWith(
        expect.objectContaining({ approvedCommandTokens: [drifted.token] })
      )
    );
  });

  test("clears command approvals when different settings are saved", async () => {
    const approval = {
      path: "servers.notes.command",
      command: "npx -y @modelcontextprotocol/server-filesystem /data",
      token: "token-notes",
    };
    const { client, view } = renderBackupSection({
      backupPreview: {
        pushChanges: [],
        restoreChanges: [{ status: "M", path: "mcp.jsonc" }],
        localOnlyFiles: [],
        redactions: [],
        commandApprovals: [approval],
        projectImports: [],
        projectBundleSkipped: false,
        pushError: null,
      },
    });
    const canvas = within(view.container);
    await canvas.findByText("Settings backup");

    fireEvent.click(canvas.getByRole("button", { name: "Preview changes" }));
    const approve = await canvas.findByRole("checkbox", {
      name: "Approve MCP command changes",
    });
    fireEvent.click(approve);
    await waitFor(() => expect(approve.getAttribute("data-state")).toBe("checked"));

    // The approvals describe the previewed repository; a save that changes the settings
    // must not carry them to the next repository's restore.
    fireEvent.change(canvas.getByLabelText("Repository URL"), {
      target: { value: "git@github.com:example/other.git" },
    });
    fireEvent.click(canvas.getByRole("button", { name: "Save settings" }));
    await canvas.findByText("Backup settings saved.");

    expect(canvas.queryByRole("checkbox", { name: "Approve MCP command changes" })).toBeNull();
    expect(canvas.queryByText(approval.command)).toBeNull();

    const restore = jest.spyOn(client.backup, "restore");
    await confirmRestore(canvas);
    await waitFor(() =>
      expect(restore).toHaveBeenLastCalledWith(
        expect.objectContaining({ approvedCommandTokens: [] })
      )
    );
  });

  test("reports a preferences-only restore as changing no files", async () => {
    const { client, view } = renderBackupSection();
    const canvas = within(view.container);
    await canvas.findByText("Settings backup");

    jest.spyOn(client.backup, "restore").mockResolvedValueOnce({
      success: true,
      data: {
        commit: "abc1234",
        snapshotPath: "/tmp/mux-backup-snapshot",
        changedFiles: [],
        localOnlyFiles: [],
        projectImportResults: [],
        projectBundleSkipped: false,
        unapprovedProjectImports: [],
      },
    });

    await confirmRestore(canvas);

    await canvas.findByText(/no files changed/i);
  });

  test("renders save failures beside the explicit save action", async () => {
    const { client, view } = renderBackupSection();
    const canvas = within(view.container);
    await canvas.findByText("Settings backup");

    jest.spyOn(client.backup, "saveSettings").mockResolvedValueOnce({
      success: false,
      error: {
        code: "IO_ERROR",
        message: "Could not persist backup settings",
      },
    });

    fireEvent.change(canvas.getByLabelText("Repository URL"), {
      target: { value: "git@github.com:example/other.git" },
    });
    fireEvent.click(canvas.getByRole("button", { name: "Save settings" }));

    await canvas.findByText("Could not persist backup settings");
  });

  test("sends only approved project imports with their target paths on restore", async () => {
    const candidate = {
      sourcePath: "/home/dev/src/rocket",
      name: "rocket",
      gitRemote: "git@github.com:dev/rocket.git",
      memoryFileCount: 2,
      token: "rocket-token",
    };
    const unapproved = {
      sourcePath: "/home/dev/src/probe",
      name: "probe",
      memoryFileCount: 0,
      token: "probe-token",
    };
    const { client, view } = renderBackupSection({
      backupPreview: {
        pushChanges: [],
        restoreChanges: [],
        localOnlyFiles: [],
        redactions: [],
        commandApprovals: [],
        projectImports: [candidate, unapproved],
        projectBundleSkipped: false,
        pushError: null,
      },
      backupRestore: {
        commit: "def5678",
        snapshotPath: "/tmp/mux-backup-snapshot",
        changedFiles: [],
        localOnlyFiles: [],
        projectImportResults: [
          {
            sourcePath: candidate.sourcePath,
            targetPath: "/home/other/rocket",
            name: candidate.name,
            status: "imported",
            writtenFiles: ["memory/project/rocket-abc/notes.md"],
            skippedFiles: [],
            registered: true,
          },
        ],
        projectBundleSkipped: false,
        unapprovedProjectImports: [],
      },
    });
    const canvas = within(view.container);
    await canvas.findByText("Settings backup");

    fireEvent.click(canvas.getByRole("button", { name: "Preview changes" }));
    await canvas.findByText("Projects to reimport");
    // The remote is rendered as inert text, never a link.
    expect(canvas.getByText(/git@github\.com:dev\/rocket\.git/)).toBeTruthy();
    expect(canvas.queryByRole("link")).toBeNull();

    const restore = jest.spyOn(client.backup, "restore");
    fireEvent.click(canvas.getByRole("checkbox", { name: "Import project rocket" }));
    const targetInputs = canvas.getAllByLabelText("Local project directory");
    fireEvent.change(targetInputs[0]!, { target: { value: "/home/other/rocket" } });
    await confirmRestore(canvas);

    await waitFor(() =>
      expect(restore).toHaveBeenCalledWith(
        expect.objectContaining({
          projectImports: [{ token: "rocket-token", targetPath: "/home/other/rocket" }],
        })
      )
    );
    await canvas.findByText("Project import results");
    expect(canvas.getByText(/Imported: rocket/)).toBeTruthy();
  });

  test("reports a conflicted import as partial and keeps its candidate on offer", async () => {
    const candidate = {
      sourcePath: "/home/dev/src/rocket",
      name: "rocket",
      memoryFileCount: 2,
      token: "rocket-token",
    };
    const { view } = renderBackupSection({
      backupPreview: {
        pushChanges: [],
        restoreChanges: [],
        localOnlyFiles: [],
        redactions: [],
        commandApprovals: [],
        projectImports: [candidate],
        projectBundleSkipped: false,
        pushError: null,
      },
      backupRestore: {
        commit: "def5678",
        snapshotPath: "/tmp/mux-backup-snapshot",
        changedFiles: [],
        localOnlyFiles: [],
        projectImportResults: [
          {
            sourcePath: candidate.sourcePath,
            targetPath: "/home/other/rocket",
            name: candidate.name,
            status: "imported",
            writtenFiles: ["memory/project/rocket-abc/notes.md"],
            skippedFiles: ["memory/project/rocket-abc/conflict.md"],
            // Imported into a project that already existed: nothing to unregister.
            registered: false,
          },
        ],
        projectBundleSkipped: false,
        // The backend re-offers a conflicted import; the UI must not call it done.
        unapprovedProjectImports: [candidate],
      },
    });
    const canvas = within(view.container);
    await canvas.findByText("Settings backup");

    fireEvent.click(canvas.getByRole("button", { name: "Preview changes" }));
    await canvas.findByText("Projects to reimport");
    fireEvent.click(canvas.getByRole("checkbox", { name: "Import project rocket" }));
    fireEvent.change(canvas.getAllByLabelText("Local project directory")[0]!, {
      target: { value: "/home/other/rocket" },
    });
    await confirmRestore(canvas);

    await canvas.findByText("Project import results");
    expect(canvas.getByText(/Partially imported: rocket/)).toBeTruthy();
    expect(canvas.queryByText(/^Imported: rocket/)).toBeNull();
    // The undo guidance names only what this run created: files, not a registration.
    expect(canvas.queryByText(/Newly registered project/)).toBeNull();
    expect(canvas.queryByText(/remove the projects marked as newly registered/)).toBeNull();
    // Still offered for a retry after the conflicts are resolved.
    expect(canvas.getByRole("checkbox", { name: "Import project rocket" })).toBeTruthy();
  });

  test("keeps an earlier attempt's added files and registration on a retry", async () => {
    const candidate = {
      sourcePath: "/home/dev/src/rocket",
      name: "rocket",
      memoryFileCount: 2,
      token: "rocket-token",
    };
    const attempt = (attemptResult: {
      writtenFiles: string[];
      skippedFiles: string[];
      registered: boolean;
    }) => ({
      commit: "def5678",
      snapshotPath: "/tmp/mux-backup-snapshot",
      changedFiles: [],
      localOnlyFiles: [],
      projectImportResults: [
        {
          sourcePath: candidate.sourcePath,
          targetPath: "/home/other/rocket",
          name: candidate.name,
          status: "imported" as const,
          ...attemptResult,
        },
      ],
      projectBundleSkipped: false,
      unapprovedProjectImports: attemptResult.skippedFiles.length > 0 ? [candidate] : [],
    });
    const { view } = renderBackupSection(
      {
        backupPreview: {
          pushChanges: [],
          restoreChanges: [],
          localOnlyFiles: [],
          redactions: [],
          commandApprovals: [],
          projectImports: [candidate],
          projectBundleSkipped: false,
          pushError: null,
        },
      },
      (client) => {
        // The first attempt registers the project and adds one file before a conflict; the
        // retry finds that file in place and reports only what it added itself.
        jest
          .spyOn(client.backup, "restore")
          .mockResolvedValueOnce({
            success: true,
            data: attempt({
              writtenFiles: ["memory/project/rocket-abc/notes.md"],
              skippedFiles: ["memory/project/rocket-abc/conflict.md"],
              registered: true,
            }),
          })
          .mockResolvedValueOnce({
            success: true,
            data: attempt({
              writtenFiles: ["memory/project/rocket-abc/conflict.md"],
              skippedFiles: [],
              registered: false,
            }),
          });
      }
    );
    const canvas = within(view.container);
    await canvas.findByText("Settings backup");

    fireEvent.click(canvas.getByRole("button", { name: "Preview changes" }));
    await canvas.findByText("Projects to reimport");
    fireEvent.click(canvas.getByRole("checkbox", { name: "Import project rocket" }));
    fireEvent.change(canvas.getAllByLabelText("Local project directory")[0]!, {
      target: { value: "/home/other/rocket" },
    });
    await confirmRestore(canvas);
    await canvas.findByText(/Partially imported: rocket/);
    // The undo list names the files, not a count.
    expect(
      canvas.getByText(/Added memory file: memory\/project\/rocket-abc\/notes\.md/)
    ).toBeTruthy();

    fireEvent.click(canvas.getByRole("checkbox", { name: "Import project rocket" }));
    fireEvent.change(canvas.getAllByLabelText("Local project directory")[0]!, {
      target: { value: "/home/other/rocket" },
    });
    await confirmRestore(canvas);
    await canvas.findByText(/^Imported: rocket/);
    // One card for the import, listing both attempts' files and the registration the first
    // attempt made — the retry alone would say nothing was registered.
    expect(canvas.queryByText(/Partially imported: rocket/)).toBeNull();
    expect(
      canvas.getByText(
        /Added memory files: memory\/project\/rocket-abc\/notes\.md, memory\/project\/rocket-abc\/conflict\.md/
      )
    ).toBeTruthy();
    expect(canvas.getByText(/Newly registered project/)).toBeTruthy();
    expect(canvas.getByText(/remove the projects marked as newly registered/)).toBeTruthy();

    // Saving different settings drops the preview and its approvals, not this: the files and
    // the registration are still there to undo.
    fireEvent.change(canvas.getByLabelText("Repository URL"), {
      target: { value: "git@github.com:example/other.git" },
    });
    fireEvent.click(canvas.getByRole("button", { name: "Save settings" }));
    await canvas.findByText("Backup settings saved.");
    expect(
      canvas.getByText(/Added memory files: memory\/project\/rocket-abc\/notes\.md/)
    ).toBeTruthy();
    expect(canvas.getByText(/Newly registered project/)).toBeTruthy();
  });

  test("re-presents fresh candidates when import approval goes stale", async () => {
    const staleCandidate = {
      sourcePath: "/home/dev/src/rocket",
      name: "rocket",
      memoryFileCount: 1,
      token: "stale-token",
    };
    const freshCandidate = { ...staleCandidate, token: "fresh-token" };
    const { client, view } = renderBackupSection({
      backupPreview: {
        pushChanges: [],
        restoreChanges: [],
        localOnlyFiles: [],
        redactions: [],
        commandApprovals: [],
        projectImports: [staleCandidate],
        projectBundleSkipped: false,
        pushError: null,
      },
    });
    const canvas = within(view.container);
    await canvas.findByText("Settings backup");

    fireEvent.click(canvas.getByRole("button", { name: "Preview changes" }));
    await canvas.findByText("Projects to reimport");
    fireEvent.click(canvas.getByRole("checkbox", { name: "Import project rocket" }));

    const restore = jest.spyOn(client.backup, "restore").mockResolvedValueOnce({
      success: false,
      error: {
        code: "PROJECT_IMPORT_APPROVAL_REQUIRED",
        message: "The approved project imports no longer match the backup.",
        projectImports: [freshCandidate],
      },
    });
    await confirmRestore(canvas);
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(1));

    // The fresh candidate replaced the stale one and starts unapproved, so an immediate
    // second restore sends no imports.
    await canvas.findByText("Projects to reimport");
    const checkbox = canvas.getByRole("checkbox", { name: "Import project rocket" });
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    await confirmRestore(canvas);
    await waitFor(() =>
      expect(restore).toHaveBeenLastCalledWith(expect.objectContaining({ projectImports: [] }))
    );
  });

  test("drops stale project import candidates after a push replaces the remote bundle", async () => {
    const { view } = renderBackupSection({
      backupPreview: {
        pushChanges: [],
        restoreChanges: [],
        localOnlyFiles: [],
        redactions: [],
        commandApprovals: [],
        projectImports: [
          {
            sourcePath: "/home/dev/src/rocket",
            name: "rocket",
            memoryFileCount: 1,
            token: "rocket-token",
          },
        ],
        projectBundleSkipped: false,
        pushError: null,
      },
    });
    const canvas = within(view.container);
    await canvas.findByText("Settings backup");

    fireEvent.click(canvas.getByRole("button", { name: "Preview changes" }));
    await canvas.findByText("Projects to reimport");

    // The push rewrote the remote bundle; the candidates' tokens describe the old one.
    fireEvent.click(canvas.getByRole("button", { name: "Back up now" }));
    await canvas.findByText(/Backed up settings at/);
    expect(canvas.queryByText("Projects to reimport")).toBeNull();
  });

  test("reports a skipped project bundle after a preview", async () => {
    const { view } = renderBackupSection({
      backupPreview: {
        pushChanges: [],
        restoreChanges: [],
        localOnlyFiles: [],
        redactions: [],
        commandApprovals: [],
        projectImports: [],
        projectBundleSkipped: true,
        pushError: null,
      },
    });
    const canvas = within(view.container);
    await canvas.findByText("Settings backup");

    fireEvent.click(canvas.getByRole("button", { name: "Preview changes" }));
    await canvas.findByText(/carries a project bundle, but project backup is disabled/);
  });
});
