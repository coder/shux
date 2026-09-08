import "./formTestPlatform";
import { afterEach, expect, test } from "bun:test";
import { createRef, useState } from "react";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { createORPCClient } from "@orpc/client";
import { View } from "react-native";
import type { TextInput } from "react-native";
import type { MuxMessage, MuxToolPart } from "../../../../src/common/types/message";
import type { MobileClient } from "../api";
import type { FrontendWorkspaceMetadata } from "../../../../src/common/types/workspace";
import { Button, Field, Sheet } from "../components/Controls";
import { Message } from "../components/Message";
import { ContextUsage } from "../components/ContextUsage";
import { Markdown } from "../components/Markdown";
import { CreateWorkspace } from "./CreateWorkspace";
import { ChangesScreen } from "./ChangesScreen";
import { ModelSettings } from "./ModelSettings";
import { ConversationScreen } from "./ConversationScreen";
import type { WorkspaceChatMessage } from "../transcript";
import { applyChatEvent, createTranscriptState } from "../transcript";
import { Navigator } from "./Navigator";
import { SettingsScreen } from "./SettingsScreen";
import type { ChatSettings, SettingsData } from "../settings";

afterEach(cleanup);

const workspace: FrontendWorkspaceMetadata = {
  id: "workspace",
  name: "feature",
  projectName: "project",
  projectPath: "/project",
  namedWorkspacePath: "/project/feature",
  runtimeConfig: { type: "local" },
};

test("changes include secondary repositories in one request and do not hide failed checkouts", async () => {
  const calls: string[] = [];
  const client = createORPCClient<MobileClient>({
    call: async (path) => {
      const method = path.join(".");
      calls.push(method);
      if (method === "workspace.getProjectDiffs")
        return [
          {
            projectName: "Primary",
            projectPath: "/primary",
            success: true,
            data: { diff: "", truncated: false },
          },
          {
            projectName: "Secondary",
            projectPath: "/secondary",
            success: true,
            data: {
              diff: "diff --git a/secondary.ts b/secondary.ts\n--- a/secondary.ts\n+++ b/secondary.ts\n@@ -1 +1 @@\n-old\n+new\n",
              truncated: false,
            },
          },
          {
            projectName: "Offline",
            projectPath: "/offline",
            success: false,
            error: "Checkout unavailable",
          },
        ];
      // The old unqualified request sees a clean primary repository and misses the rest.
      if (method === "workspace.executeBash")
        return {
          success: true,
          data: { success: true, output: "", exitCode: 0, wall_duration_ms: 0 },
        };
      throw new Error(`Unexpected procedure: ${method}`);
    },
  });
  const view = render(
    <ChangesScreen
      client={client}
      workspaceId="multi"
      signal={new AbortController().signal}
      onReconnect={async () => {}}
      onBack={() => {}}
    />
  );
  await waitFor(() => expect(view.getByText("secondary.ts")).toBeDefined());
  expect(calls).toEqual(["workspace.getProjectDiffs"]);
  expect(view.getByText("Checkout unavailable")).toBeDefined();
  expect(view.queryByText("No uncommitted changes")).toBeNull();
});

test("changes keep distinct deleted paths while additions use the new-side path", async () => {
  const diffs = [
    "diff --git a/removed.ts b/removed.ts\n--- a/removed.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-deleted\n",
    "diff --git a/old file.ts b/old file.ts\n--- a/old file.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-also deleted\n",
    "diff --git a/new.ts b/new.ts\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+added\n",
  ];
  const client = createORPCClient<MobileClient>({
    call: async () => [
      {
        projectName: "Project",
        projectPath: "/project",
        success: true,
        data: { diff: diffs.join(""), truncated: false },
      },
    ],
  });
  const view = render(
    <ChangesScreen
      client={client}
      workspaceId="workspace"
      signal={new AbortController().signal}
      onReconnect={async () => {}}
      onBack={() => {}}
    />
  );
  await waitFor(() => expect(view.getByText("removed.ts")).toBeDefined());
  expect(view.getByText("old file.ts")).toBeDefined();
  expect(view.getByText("new.ts")).toBeDefined();
  expect(view.queryByText("/dev/null")).toBeNull();
  expect(view.getByText("-deleted")).toBeDefined();
  expect(view.getByText("+added")).toBeDefined();
});

test("context meter exposes measured progress without inventing an unknown percentage", () => {
  const data = { segments: [], totalTokens: 200_000, maxTokens: 1_000_000, totalPercentage: 20 };
  const view = render(<ContextUsage data={data} />);
  expect(view.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("20");
  view.rerender(<ContextUsage data={{ ...data, totalPercentage: 120 }} />);
  expect(view.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
  view.rerender(<ContextUsage data={{ ...data, maxTokens: undefined }} />);
  expect(view.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
  expect(view.getByRole("progressbar").getAttribute("aria-valuetext")).toBeTruthy();
});

test("navigator keeps roots by default but opens matching agents through search", () => {
  const selected: string[] = [];
  const child: FrontendWorkspaceMetadata = {
    ...workspace,
    id: "child",
    title: "Architecture Scout",
    parentWorkspaceId: workspace.id,
    taskStatus: "reported",
  };
  const props = {
    projects: [],
    workspaces: [workspace, child],
    loading: false,
    error: null,
    onRetry: () => {},
    onSelect: (value: FrontendWorkspaceMetadata) => selected.push(value.id),
    onCreate: () => {},
    onSettings: () => {},
  };
  const view = render(<Navigator {...props} />);
  expect(view.getByRole("button", { name: "project, 1 workspaces" })).toBeDefined();
  expect(view.queryByRole("button", { name: child.title })).toBeNull();
  const search = view.getByRole("textbox", { name: "Search workspaces" });
  fireEvent.change(search, { target: { value: "Scout" } });
  fireEvent.click(view.getByRole("button", { name: child.title }));
  expect(selected).toEqual([child.id]);
  expect(view.getByText("Subagent of feature")).toBeDefined();
  expect(view.queryByRole("button", { name: workspace.name })).toBeNull();
  fireEvent.change(search, { target: { value: "  " } });
  expect(view.queryByRole("button", { name: child.title })).toBeNull();

  // A live metadata update must not promote a running child into a peer row.
  view.rerender(
    <Navigator {...props} workspaces={[workspace, { ...child, taskStatus: "running" }]} />
  );
  expect(view.queryByRole("button", { name: child.title })).toBeNull();
  // Preserve desktop's orphan recovery when the parent is no longer in the list.
  view.rerender(<Navigator {...props} workspaces={[child]} />);
  expect(view.getByRole("button", { name: child.title })).toBeDefined();
  // User-created roots can have agent-like names; hierarchy, not naming, controls visibility.
  view.rerender(
    <Navigator {...props} workspaces={[{ ...workspace, name: "agent_explore_user" }]} />
  );
  expect(view.getByRole("button", { name: "agent_explore_user" })).toBeDefined();
});

test("empty assistant history is explained without mislabeling a live or completed response", () => {
  const props = { canAnswer: false, onAnswer: async () => {} };
  const message = { id: "empty", role: "assistant" as const, parts: [] };
  const view = render(<Message {...props} message={message} streaming />);
  expect(view.queryByText("No response received")).toBeNull();
  view.rerender(<Message {...props} message={message} />);
  expect(view.getByText("No response received")).toBeDefined();
  view.rerender(<Message {...props} message={{ ...message, metadata: { partial: true } }} />);
  expect(view.getByText("Interrupted")).toBeDefined();
  expect(view.queryByText("No response received")).toBeNull();
  view.rerender(
    <Message {...props} message={{ ...message, parts: [{ type: "text", text: "A response" }] }} />
  );
  expect(view.queryByText("No response received")).toBeNull();
  expect(view.queryByText("Interrupted")).toBeNull();
});

test("raw completion and replay chunks render as adjacent runs without crossing tools", () => {
  const parts: MuxMessage["parts"] = [
    { type: "reasoning", text: "Just a sim" },
    { type: "reasoning", text: "ple greeting, not t" },
    { type: "reasoning", text: "ools needed." },
    { type: "text", text: "Hey" },
    { type: "text", text: "! What can I help with?" },
  ];
  const original = structuredClone(parts);
  const message: MuxMessage = { id: "reply", role: "assistant", parts };
  const props = { canAnswer: false, onAnswer: async () => {} };
  const view = render(<Message {...props} message={message} />);
  expect(view.getAllByRole("button", { name: "Reasoning" })).toHaveLength(1);
  fireEvent.click(view.getByRole("button", { name: "Reasoning" }));
  expect(view.getByText("Just a simple greeting, not tools needed.")).toBeDefined();
  expect(view.getByText("Hey! What can I help with?")).toBeDefined();
  expect(parts).toEqual(original);

  view.rerender(<Message {...props} message={{ ...message, metadata: { partial: true } }} />);
  expect(view.getAllByRole("button", { name: "Reasoning" })).toHaveLength(1);
  expect(view.getByText("Interrupted")).toBeDefined();
  view.rerender(
    <Message
      {...props}
      message={{
        ...message,
        parts: [
          ...parts,
          {
            type: "dynamic-tool",
            toolCallId: "t",
            toolName: "bash",
            state: "output-available",
            input: {},
            output: { success: true },
          },
          { type: "text", text: "After " },
          { type: "text", text: "the tool." },
          { type: "reasoning", text: "A separate thought." },
        ],
      }}
    />
  );
  expect(view.getAllByRole("button", { name: "Reasoning" })).toHaveLength(2);
  expect(view.getByText("Hey! What can I help with?")).toBeDefined();
  expect(view.getByText("After the tool.")).toBeDefined();
});

test("a field ref focuses the next native input", () => {
  const next = createRef<TextInput>();
  const view = render(
    <>
      <Field label="First" returnKeyType="next" onSubmitEditing={() => next.current?.focus()} />
      <Field ref={next} label="Second" />
    </>
  );
  fireEvent.keyDown(view.getByLabelText("First"), { key: "Enter", keyCode: 13 });
  expect(document.activeElement).toBe(view.getByLabelText("Second"));
});

test("sheet contents and footer do not dismiss it; the backdrop does, unless dismissal is blocked", () => {
  let dismissals = 0;
  let submissions = 0;
  const children = <Field label="Title" />;
  const footer = (
    <Button
      onPress={() => {
        submissions++;
      }}
    >
      Submit
    </Button>
  );
  const view = render(
    <Sheet
      title="Example"
      onClose={() => {
        dismissals++;
      }}
      footer={footer}
    >
      {children}
    </Sheet>
  );
  fireEvent.click(view.getByLabelText("Title"));
  fireEvent.click(view.getByRole("button", { name: "Submit" }));
  expect(submissions).toBe(1);
  expect(dismissals).toBe(0);
  fireEvent.click(view.getByRole("button", { name: "Dismiss Example" }));
  expect(dismissals).toBe(1);
  view.rerender(
    <Sheet
      title="Example"
      dismissDisabled
      onClose={() => {
        dismissals++;
      }}
      footer={footer}
    >
      {children}
    </Sheet>
  );
  fireEvent.click(view.getByRole("button", { name: "Dismiss Example" }));
  fireEvent.click(view.getByRole("button", { name: "Close" }));
  expect(dismissals).toBe(1);
});

test("workspace creation cannot be dismissed or submitted twice while the server is creating it", async () => {
  let resolve!: (value: { success: true; metadata: FrontendWorkspaceMetadata }) => void;
  const created = new Promise<{ success: true; metadata: FrontendWorkspaceMetadata }>((done) => {
    resolve = done;
  });
  let calls = 0;
  let dismissals = 0;
  let selected: FrontendWorkspaceMetadata | undefined;
  const client = createORPCClient<MobileClient>({
    call: async (path) => {
      if (path.join(".") !== "workspace.createScratch") throw new Error("Unexpected procedure");
      calls++;
      return created;
    },
  });
  const view = render(
    <CreateWorkspace
      client={client}
      signal={new AbortController().signal}
      connected
      projects={[]}
      onReconnect={async () => {}}
      onClose={() => {
        dismissals++;
      }}
      onCreated={(value) => {
        selected = value;
      }}
    />
  );
  fireEvent.click(view.getByRole("button", { name: "Create scratch chat" }));
  fireEvent.click(view.getByRole("button", { name: "Create scratch chat" }));
  fireEvent.click(view.getByRole("button", { name: "Close" }));
  fireEvent.click(view.getByRole("button", { name: "Dismiss New workspace" }));
  expect(calls).toBe(1);
  expect(dismissals).toBe(0);
  await act(async () => {
    resolve({ success: true, metadata: workspace });
    await created;
  });
  expect(selected).toBe(workspace);
});

test.each([false, true])(
  "workspace final-field Done creates once with validation and IME protection (project=%s)",
  async (project) => {
    const calls: Array<{ method: string; input: unknown }> = [];
    let resolve!: (value: { success: true; metadata: FrontendWorkspaceMetadata }) => void;
    const created = new Promise<{ success: true; metadata: FrontendWorkspaceMetadata }>((done) => {
      resolve = done;
    });
    const selected: FrontendWorkspaceMetadata[] = [];
    const client = createORPCClient<MobileClient>({
      call: async (path, input) => {
        const method = path.join(".");
        if (method === "projects.listBranches")
          return { branches: ["main"], recommendedTrunk: "main" };
        if (method !== (project ? "workspace.create" : "workspace.createScratch"))
          throw new Error(`Unexpected procedure ${method}`);
        calls.push({ method, input });
        return created;
      },
    });
    const signal = new AbortController().signal;
    const renderForm = (connected: boolean) => (
      <CreateWorkspace
        client={client}
        signal={signal}
        connected={connected}
        projects={[["/project", { workspaces: [], displayName: "Example", trusted: true }]]}
        onReconnect={async () => {}}
        onClose={() => {}}
        onCreated={(value) => {
          selected.push(value);
        }}
      />
    );
    const view = render(renderForm(false));
    const title = view.getByLabelText("Title (optional)");
    fireEvent.change(title, { target: { value: "New task" } });
    let finalInput = title;
    if (project) {
      fireEvent.click(view.getByRole("button", { name: "Choose project" }));
      fireEvent.click(view.getByRole("button", { name: "Example" }));
      await waitFor(() => expect(view.getByDisplayValue("main")).toBeDefined());
      title.focus();
      fireEvent.keyDown(title, { key: "Enter", keyCode: 13 });
      expect(document.activeElement).toBe(view.getByLabelText("Branch name (optional)"));
      fireEvent.keyDown(view.getByLabelText("Branch name (optional)"), {
        key: "Enter",
        keyCode: 13,
      });
      finalInput = view.getByLabelText("Base branch");
      expect(document.activeElement).toBe(finalInput);
    }
    fireEvent.keyDown(finalInput, { key: "Enter", keyCode: 13 });
    expect(calls).toHaveLength(0);
    view.rerender(renderForm(true));
    if (project) {
      fireEvent.change(finalInput, { target: { value: "   " } });
      fireEvent.keyDown(finalInput, { key: "Enter", keyCode: 13 });
      expect(calls).toHaveLength(0);
      fireEvent.change(finalInput, { target: { value: "main" } });
    }
    fireEvent.keyDown(finalInput, { key: "Enter", keyCode: 13, isComposing: true });
    fireEvent.keyDown(finalInput, { key: "Enter", keyCode: 229 });
    expect(calls).toHaveLength(0);
    fireEvent.keyDown(finalInput, { key: "Enter", keyCode: 13 });
    expect(calls).toHaveLength(1);
    fireEvent.keyDown(finalInput, { key: "Enter", keyCode: 13 });
    fireEvent.click(
      view.getByRole("button", { name: project ? "Create worktree" : "Create scratch chat" })
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toMatchObject(
      project
        ? { projectPath: "/project", title: "New task", trunkBranch: "main" }
        : { title: "New task" }
    );
    await act(async () => {
      resolve({ success: true, metadata: workspace });
      await created;
    });
    expect(selected).toEqual([workspace]);
  }
);

test.each(["restore", "reselect"])(
  "removed project blocks creation without losing drafts, then %s recovers",
  async (recovery) => {
    const calls: unknown[] = [];
    const client = createORPCClient<MobileClient>({
      call: async (path, input) => {
        if (path.join(".") === "projects.listBranches")
          return { branches: ["main"], recommendedTrunk: "main" };
        if (path.join(".") !== "workspace.create")
          throw new Error("Must not silently create a scratch chat");
        calls.push(input);
        return { success: true, metadata: workspace };
      },
    });
    const signal = new AbortController().signal;
    const catalog: Parameters<typeof CreateWorkspace>[0]["projects"] = [
      ["/project", { workspaces: [], displayName: "Example", trusted: true }],
      ["/available", { workspaces: [], displayName: "Available", trusted: true }],
    ];
    const renderForm = (projects: typeof catalog) => (
      <CreateWorkspace
        client={client}
        signal={signal}
        connected
        projects={projects}
        onReconnect={async () => {}}
        onClose={() => {}}
        onCreated={() => {}}
      />
    );
    const view = render(renderForm(catalog));
    fireEvent.click(view.getByRole("button", { name: "Choose project" }));
    fireEvent.click(view.getByRole("button", { name: "Example" }));
    await waitFor(() => expect(view.getByDisplayValue("main")).toBeDefined());
    fireEvent.change(view.getByLabelText("Title (optional)"), {
      target: { value: "Keep this title" },
    });
    fireEvent.change(view.getByLabelText("Branch name (optional)"), {
      target: { value: "keep-this-branch" },
    });
    fireEvent.change(view.getByLabelText("Base branch"), { target: { value: "release" } });
    view.rerender(renderForm(catalog.slice(1)));
    const create = view.getByRole("button", { name: "Create worktree" });
    expect(create.getAttribute("aria-disabled")).toBe("true");
    expect(view.queryByRole("button", { name: "Create scratch chat" })).toBeNull();
    expect(view.getByRole("alert")).toBeDefined();
    expect(view.getByDisplayValue("Keep this title")).toBeDefined();
    expect(view.getByDisplayValue("keep-this-branch")).toBeDefined();
    expect(view.getByDisplayValue("release")).toBeDefined();
    fireEvent.click(create);
    fireEvent.keyDown(view.getByLabelText("Base branch"), { key: "Enter", keyCode: 13 });
    expect(calls).toHaveLength(0);
    if (recovery === "restore") {
      view.rerender(renderForm(catalog));
      expect(view.getByDisplayValue("keep-this-branch")).toBeDefined();
      expect(view.getByDisplayValue("release")).toBeDefined();
    } else {
      fireEvent.click(view.getByRole("button", { name: "Choose project" }));
      fireEvent.click(view.getByRole("button", { name: "Available" }));
      await waitFor(() => expect(view.getByDisplayValue("main")).toBeDefined());
    }
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.getByDisplayValue("Keep this title")).toBeDefined();
    expect(
      view.getByRole("button", { name: "Create worktree" }).getAttribute("aria-disabled")
    ).not.toBe("true");
    await act(async () => {
      fireEvent.keyDown(view.getByLabelText("Base branch"), { key: "Enter", keyCode: 13 });
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      projectPath: recovery === "restore" ? "/project" : "/available",
      title: "Keep this title",
      trunkBranch: recovery === "restore" ? "release" : "main",
    });
  }
);

test.each(["root", "subproject"])(
  "creation follows live owner trust and preserves drafts (%s)",
  async (kind) => {
    const calls: unknown[] = [];
    let branchReads = 0;
    const client = createORPCClient<MobileClient>({
      call: async (path, input) => {
        if (path.join(".") === "projects.listBranches") {
          branchReads++;
          return { branches: ["main"], recommendedTrunk: "main" };
        }
        if (path.join(".") !== "workspace.create") throw new Error("Unexpected creation path");
        calls.push(input);
        return { success: true, metadata: workspace };
      },
    });
    const signal = new AbortController().signal;
    const catalog = (
      trusted: boolean | undefined,
      childTrusted: boolean,
      ownerPresent = true
    ): Parameters<typeof CreateWorkspace>[0]["projects"] => {
      const entries: Parameters<typeof CreateWorkspace>[0]["projects"] = [
        ["/owner", { workspaces: [], displayName: "Owner", trusted }],
        [
          "/owner/child",
          {
            workspaces: [],
            displayName: "Child",
            parentProjectPath: "/owner",
            trusted: childTrusted,
          },
        ],
      ];
      return ownerPresent ? entries : entries.slice(1);
    };
    const renderForm = (
      trusted: boolean | undefined,
      childTrusted: boolean,
      ownerPresent = true
    ) => (
      <CreateWorkspace
        client={client}
        signal={signal}
        connected
        projects={catalog(trusted, childTrusted, ownerPresent)}
        onReconnect={async () => {}}
        onClose={() => {}}
        onCreated={() => {}}
      />
    );
    const view = render(renderForm(undefined, true));
    fireEvent.click(view.getByRole("button", { name: "Choose project" }));
    fireEvent.click(view.getByRole("button", { name: kind === "root" ? "Owner" : "Child" }));
    await waitFor(() => expect(view.getByDisplayValue("main")).toBeDefined());
    fireEvent.change(view.getByLabelText("Title (optional)"), {
      target: { value: "Preserve trust draft" },
    });
    fireEvent.change(view.getByLabelText("Branch name (optional)"), {
      target: { value: "my-branch" },
    });
    fireEvent.change(view.getByLabelText("Base branch"), { target: { value: "release" } });
    const attempt = () => {
      fireEvent.click(view.getByRole("button", { name: "Create worktree" }));
      fireEvent.keyDown(view.getByLabelText("Base branch"), { key: "Enter", keyCode: 13 });
    };
    expect(
      view.getByRole("button", { name: "Create worktree" }).getAttribute("aria-disabled")
    ).toBe("true");
    expect(view.getByRole("alert")).toBeDefined();
    attempt();
    expect(calls).toHaveLength(0);
    view.rerender(renderForm(true, false));
    expect(view.queryByRole("alert")).toBeNull();
    expect(
      view.getByRole("button", { name: "Create worktree" }).getAttribute("aria-disabled")
    ).not.toBe("true");
    view.rerender(renderForm(false, true));
    attempt();
    expect(calls).toHaveLength(0);
    if (kind === "subproject") {
      view.rerender(renderForm(true, true, false));
      attempt();
      expect(calls).toHaveLength(0);
    }
    view.rerender(renderForm(true, false));
    expect(view.getByDisplayValue("Preserve trust draft")).toBeDefined();
    expect(view.getByDisplayValue("my-branch")).toBeDefined();
    expect(view.getByDisplayValue("release")).toBeDefined();
    expect(branchReads).toBe(1);
    await act(async () => {
      fireEvent.keyDown(view.getByLabelText("Base branch"), { key: "Enter", keyCode: 13 });
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      projectPath: kind === "root" ? "/owner" : "/owner/child",
      title: "Preserve trust draft",
      branchName: "my-branch",
      trunkBranch: "release",
    });
  }
);

test.each(["empty", "error"])(
  "branch discovery %s cannot be bypassed by typing a base and does not block scratch",
  async (outcome) => {
    type BranchResult = Awaited<ReturnType<MobileClient["projects"]["listBranches"]>>;
    let resolve!: (value: BranchResult) => void;
    let reject!: (reason: Error) => void;
    const result = new Promise<BranchResult>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const calls: string[] = [];
    const client = createORPCClient<MobileClient>({
      call: async (path) => {
        const method = path.join(".");
        if (method === "projects.listBranches") return result;
        calls.push(method);
        return { success: true, metadata: workspace };
      },
    });
    const view = render(
      <CreateWorkspace
        client={client}
        signal={new AbortController().signal}
        connected
        projects={[["/project", { workspaces: [], displayName: "Project", trusted: true }]]}
        onReconnect={async () => {}}
        onClose={() => {}}
        onCreated={() => {}}
      />
    );
    fireEvent.click(view.getByRole("button", { name: "Choose project" }));
    fireEvent.click(view.getByRole("button", { name: "Project" }));
    expect(view.queryByRole("alert")).toBeNull();
    expect(
      view.getByRole("button", { name: "Create worktree" }).getAttribute("aria-disabled")
    ).toBe("true");
    await act(async () => {
      if (outcome === "empty") resolve({ branches: [], recommendedTrunk: null });
      else reject(new Error("Repository read failed"));
    });
    fireEvent.change(view.getByLabelText("Base branch"), { target: { value: "arbitrary-base" } });
    expect(
      view.getByRole("button", { name: "Create worktree" }).getAttribute("aria-disabled")
    ).toBe("true");
    const alert = view.getByRole("alert");
    if (outcome === "error") expect(alert.textContent).toContain("Repository read failed");
    fireEvent.click(view.getByRole("button", { name: "Create worktree" }));
    fireEvent.keyDown(view.getByLabelText("Base branch"), { key: "Enter", keyCode: 13 });
    expect(calls).toHaveLength(0);
    fireEvent.click(view.getByRole("button", { name: "Choose project" }));
    fireEvent.click(view.getByRole("button", { name: "Scratch chat" }));
    expect(view.queryByRole("alert")).toBeNull();
    await act(async () => {
      fireEvent.keyDown(view.getByLabelText("Title (optional)"), { key: "Enter", keyCode: 13 });
    });
    expect(calls).toEqual(["workspace.createScratch"]);
  }
);

test("late branch results cannot change a newly selected project's eligibility", async () => {
  type BranchResult = Awaited<ReturnType<MobileClient["projects"]["listBranches"]>>;
  let resolveOld!: (value: BranchResult) => void;
  const oldResult = new Promise<BranchResult>((done) => {
    resolveOld = done;
  });
  const reads: Array<AbortSignal | undefined> = [];
  const calls: unknown[] = [];
  const client = createORPCClient<MobileClient>({
    call: async (path, input, options) => {
      if (path.join(".") === "projects.listBranches") {
        reads.push(options.signal);
        return (input as { projectPath: string }).projectPath === "/old"
          ? oldResult
          : { branches: ["main"], recommendedTrunk: "main" };
      }
      calls.push(input);
      return { success: true, metadata: workspace };
    },
  });
  const view = render(
    <CreateWorkspace
      client={client}
      signal={new AbortController().signal}
      connected
      projects={[
        ["/old", { workspaces: [], displayName: "Old", trusted: true }],
        ["/new", { workspaces: [], displayName: "New", trusted: true }],
      ]}
      onReconnect={async () => {}}
      onClose={() => {}}
      onCreated={() => {}}
    />
  );
  fireEvent.click(view.getByRole("button", { name: "Choose project" }));
  fireEvent.click(view.getByRole("button", { name: "Old" }));
  fireEvent.click(view.getByRole("button", { name: "Choose project" }));
  fireEvent.click(view.getByRole("button", { name: "New" }));
  await waitFor(() => expect(view.getByDisplayValue("main")).toBeDefined());
  expect(reads[0]?.aborted).toBe(true);
  await act(async () => {
    resolveOld({ branches: [], recommendedTrunk: null });
  });
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.getByDisplayValue("main")).toBeDefined();
  fireEvent.change(view.getByLabelText("Branch name (optional)"), {
    target: { value: "keep-this-draft" },
  });
  fireEvent.click(view.getByRole("button", { name: "Choose project" }));
  fireEvent.click(view.getByRole("button", { name: "New" }));
  expect(view.queryByRole("button", { name: "New" })).toBeNull();
  expect(view.getByDisplayValue("keep-this-draft")).toBeDefined();
  expect(view.getByDisplayValue("main")).toBeDefined();
  await act(async () => {
    fireEvent.keyDown(view.getByLabelText("Base branch"), { key: "Enter", keyCode: 13 });
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ projectPath: "/new", trunkBranch: "main" });
});

const pickerValue: ChatSettings = {
  agentId: "exec",
  model: "local:one",
  thinkingLevel: "high",
  providerOptions: {
    anthropic: {
      disableBetaFeatures: true,
      cacheTtl: "1h",
      use1MContextModels: ["anthropic:claude-sonnet-4-20250514"],
    },
    google: { cache: false },
  },
};
const pickerData: SettingsData = {
  policy: { source: "none", status: { state: "disabled" }, policy: null },
  config: { agentAiDefaults: {}, defaultModel: "local:one", hiddenModels: ["other:hidden"] },
  providers: {
    local: {
      isConfigured: true,
      isEnabled: true,
      apiKeySet: true,
      models: ["one", "two", "three", "four", "five"],
    },
    other: {
      isConfigured: true,
      isEnabled: true,
      apiKeySet: true,
      displayName: "Team models",
      models: ["visible", "hidden"],
    },
  },
  agents: [
    { id: "exec", name: "Exec", scope: "built-in", uiSelectable: true, subagentRunnable: true },
    {
      id: "plan",
      name: "Plan",
      description: "Plan before making changes",
      scope: "built-in",
      uiSelectable: true,
      subagentRunnable: true,
      aiDefaults: { model: "local:other" },
    },
  ],
};
function PickerHarness(props: {
  page?: "model" | "agent";
  onChange: (value: ChatSettings) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(pickerValue);
  return (
    <ModelSettings
      initialPage={props.page ?? "model"}
      value={value}
      data={pickerData}
      workspace={workspace}
      onChange={(next) => {
        setValue(next);
        props.onChange(next);
      }}
      onClose={props.onClose}
    />
  );
}

test.each([
  { selected: false, disableBetaFeatures: true },
  { selected: true, disableBetaFeatures: true },
  { selected: true, disableBetaFeatures: false },
])(
  "conversation sends resolved effort and synced options matching its context meter: %j",
  async (scenario) => {
    const model = "anthropic:claude-sonnet-4-20250514";
    const providerOptions = {
      anthropic: {
        disableBetaFeatures: scenario.disableBetaFeatures,
        cacheTtl: "1h" as const,
        use1MContextModels: [model],
      },
      google: { cache: false },
    };
    const requests: Array<Parameters<MobileClient["workspace"]["sendMessage"]>[0]> = [];
    let eventsController!: ReadableStreamDefaultController<WorkspaceChatMessage>;
    const events = new ReadableStream<WorkspaceChatMessage>({
      start(controller) {
        eventsController = controller;
      },
    });
    const client = createORPCClient<MobileClient>({
      call: async (path, input, request) => {
        switch (path.join(".")) {
          case "policy.get":
            return pickerData.policy;
          case "config.onConfigChanged":
          case "providers.onConfigChanged":
          case "policy.onChanged":
            return new ReadableStream<void>({
              start(controller) {
                request.signal?.addEventListener("abort", () => controller.close(), { once: true });
              },
            }).values();
          case "config.getConfig":
            return {
              agentAiDefaults: {},
              defaultModel: model,
              userPreferences: { ai: { providerOptions } },
            };
          case "providers.getConfig":
            return {
              anthropic: {
                isConfigured: true,
                isEnabled: true,
                apiKeySet: true,
                models: [{ id: "claude-sonnet-4-20250514", contextWindowTokens: 200_000 }],
              },
            };
          case "agents.list":
            return pickerData.agents;
          case "workspace.onChat":
            request.signal?.addEventListener("abort", () => eventsController.close(), {
              once: true,
            });
            return events.values();
          case "workspace.sendMessage":
            requests.push(input as Parameters<MobileClient["workspace"]["sendMessage"]>[0]);
            return { success: true };
          default:
            throw new Error(`Unexpected settings call: ${path.join(".")}`);
        }
      },
    });
    const lifetime = new AbortController();
    const view = render(
      <ConversationScreen
        client={client}
        workspace={workspace}
        serverLabel="Test"
        signal={lifetime.signal}
        connected
        onReconnect={async () => {}}
        onBack={() => {}}
        selection={scenario.selected ? { model, agentId: "plan" } : null}
        onSelectionChange={() => {}}
        draft={{ text: "Keep preferences", fileParts: [], reviews: [] }}
        onDraftChange={() => {}}
        onChanges={() => {}}
        onSettings={() => {}}
      />
    );
    await act(async () => {
      eventsController.enqueue({
        type: "message",
        id: "usage",
        role: "assistant",
        parts: [],
        metadata: {
          model,
          historySequence: 1,
          contextUsage: {
            inputTokens: 100_000,
            outputTokens: 0,
            totalTokens: 100_000,
            cachedInputTokens: 0,
            reasoningTokens: 0,
          },
        },
      });
      eventsController.enqueue({ type: "caught-up", hasOlderHistory: false });
    });
    const send = view.getByRole("button", { name: "Send message" });
    await waitFor(() => expect(send.getAttribute("aria-disabled")).not.toBe("true"));
    expect(view.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      scenario.disableBetaFeatures ? "50" : "10"
    );
    fireEvent.click(send);
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].options).toMatchObject({
      model,
      agentId: scenario.selected ? "plan" : "exec",
      thinkingLevel: "off",
      allowAgentSetGoal: true,
      providerOptions,
    });
    expect(view.getByText(requests[0].options.thinkingLevel!.toUpperCase())).toBeDefined();
    view.unmount();
  }
);

test("model picks apply directly while keeping mode and effort", () => {
  const changes: ChatSettings[] = [];
  let closed = 0;
  const view = render(
    <PickerHarness
      onChange={(value) => changes.push(value)}
      onClose={() => {
        closed++;
      }}
    />
  );
  expect(view.getByRole("radio", { name: "local:one" }).getAttribute("aria-checked")).toBe("true");
  expect(view.getByRole("radio", { name: "local:five" })).toBeDefined();
  expect(view.getByRole("radio", { name: "other:visible" })).toBeDefined();
  expect(view.queryByRole("radio", { name: "other:hidden" })).toBeNull();
  fireEvent.click(view.getByRole("radio", { name: "local:two" }));
  expect(changes).toEqual([{ ...pickerValue, model: "local:two" }]);
  expect(closed).toBe(1);
});

test("changing effort returns to the model picker and closing retains the immediate choice", () => {
  const changes: ChatSettings[] = [];
  let closed = 0;
  const view = render(
    <PickerHarness
      onChange={(value) => changes.push(value)}
      onClose={() => {
        closed++;
      }}
    />
  );
  fireEvent.click(view.getByRole("button", { name: "Effort High" }));
  fireEvent.click(view.getByRole("radio", { name: "Low" }));
  expect(changes).toEqual([{ ...pickerValue, thinkingLevel: "low" }]);
  expect(closed).toBe(0);
  expect(view.getByRole("button", { name: "Effort Low" })).toBeDefined();
  fireEvent.click(view.getByRole("button", { name: "Close" }));
  expect(closed).toBe(1);
});

test.each([
  { source: "pro", target: "standard", bucket: true, expected: "standard" },
  { source: "pro", target: undefined, bucket: true, expected: "standard" },
  { source: "standard", target: "pro", bucket: true, expected: "pro" },
  { source: "pro", target: undefined, bucket: false, expected: "pro" },
] as const)("mode selection uses the target reasoning mode: %j", (scenario) => {
  const changes: ChatSettings[] = [];
  const selected: ChatSettings = {
    ...pickerValue,
    model: "coder:openai/gpt-6-astra",
    reasoningMode: scenario.source,
  };
  const view = render(
    <ModelSettings
      initialPage="agent"
      value={selected}
      data={{
        ...pickerData,
        config: {
          ...pickerData.config,
          agentAiDefaults: scenario.bucket
            ? { plan: { reasoningMode: scenario.target === "pro" ? "standard" : "pro" } }
            : {},
        },
      }}
      workspace={{
        ...workspace,
        aiSettingsByAgent: scenario.bucket
          ? {
              plan: {
                model: "local:other",
                thinkingLevel: "low",
                ...(scenario.target ? { reasoningMode: scenario.target } : {}),
              },
            }
          : {},
      }}
      onChange={(next) => changes.push(next)}
      onClose={() => {}}
    />
  );
  fireEvent.click(view.getByRole("radio", { name: /Plan/ }));
  expect(changes).toEqual([{ ...selected, agentId: "plan", reasoningMode: scenario.expected }]);
});

test("mode selection preserves an explicit model and effort rather than resetting to agent defaults", () => {
  const changes: ChatSettings[] = [];
  let closed = 0;
  const view = render(
    <PickerHarness
      page="agent"
      onChange={(value) => changes.push(value)}
      onClose={() => {
        closed++;
      }}
    />
  );
  fireEvent.click(view.getByRole("radio", { name: /Plan/ }));
  expect(changes).toEqual([{ ...pickerValue, agentId: "plan" }]);
  expect(closed).toBe(1);
});

test("searching the main picker spans providers without changing selection", () => {
  const changes: ChatSettings[] = [];
  const view = render(
    <PickerHarness onChange={(value) => changes.push(value)} onClose={() => {}} />
  );
  fireEvent.change(view.getByLabelText("Search models"), { target: { value: "FIVE" } });
  expect(view.getByRole("radio", { name: "local:five" })).toBeDefined();
  expect(view.queryByRole("radio", { name: "local:one" })).toBeNull();
  fireEvent.change(view.getByLabelText("Search models"), { target: { value: "TEAM" } });
  expect(view.getByRole("radio", { name: "other:visible" })).toBeDefined();
  expect(view.queryByRole("radio", { name: "other:hidden" })).toBeNull();
  expect(changes).toHaveLength(0);
  fireEvent.click(view.getByRole("radio", { name: "other:visible" }));
  expect(changes).toEqual([{ ...pickerValue, model: "other:visible" }]);
});

test("custom model drafts require valid input and explicit confirmation", () => {
  const changes: ChatSettings[] = [];
  let closed = 0;
  const view = render(
    <PickerHarness
      onChange={(value) => changes.push(value)}
      onClose={() => {
        closed++;
      }}
    />
  );
  fireEvent.click(view.getByRole("button", { name: "Custom model" }));
  fireEvent.change(view.getByLabelText("Model ID"), { target: { value: "missing-provider" } });
  fireEvent.click(view.getByRole("button", { name: "Use custom model" }));
  expect(changes).toHaveLength(0);
  fireEvent.click(view.getByRole("button", { name: "Back" }));
  expect(changes).toHaveLength(0);
  fireEvent.click(view.getByRole("button", { name: "Custom model" }));
  fireEvent.change(view.getByLabelText("Model ID"), { target: { value: " local:custom " } });
  expect(changes).toHaveLength(0);
  fireEvent.click(view.getByRole("button", { name: "Use custom model" }));
  expect(changes).toEqual([{ ...pickerValue, model: "local:custom" }]);
  expect(closed).toBe(1);
});

test("disconnect requires confirmation and can be cancelled without clearing credentials", () => {
  let disconnects = 0;
  const view = render(
    <SettingsScreen
      endpoint="https://server.example"
      onBack={() => {}}
      onDisconnect={() => {
        disconnects++;
      }}
      busy={false}
      error={null}
    />
  );
  fireEvent.click(view.getByRole("button", { name: "Disconnect" }));
  expect(disconnects).toBe(0);
  fireEvent.click(view.getByRole("button", { name: "Keep connection" }));
  expect(disconnects).toBe(0);
  fireEvent.click(view.getByRole("button", { name: "Disconnect" }));
  fireEvent.click(view.getByRole("button", { name: "Disconnect & forget credentials" }));
  expect(disconnects).toBe(1);
});

test("Markdown separates headings and hanging list items while preserving literal hostile text", () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const view = render(
    <Markdown
      text={`## Steps\nIntro **before** the list.\n1. Keep ${hostile}\n   and this continuation\n2. Preserve \`a_b\`\n\n- A bullet\n- Another bullet\n\nAfter the list.`}
    />
  );
  expect(view.getByRole("heading").textContent).toBe("Steps");
  expect(view.getAllByRole("list")).toHaveLength(2);
  const items = view.getAllByRole("listitem");
  expect(items).toHaveLength(4);
  expect(items[0].textContent).toContain(`1.Keep ${hostile}\nand this continuation`);
  expect(items[1].textContent).toBe("2.Preserve a_b");
  expect(view.container.querySelector("img")).toBeNull();
  expect(view.getByText("After the list.")).toBeDefined();
});

test("Markdown keeps partial code fences and code whitespace literal throughout streaming", () => {
  const code = "- not a list\n  <script>literal()</script>  \n";
  const view = render(<Markdown text={`\`\`\`tsx\n${code}`} />);
  const codeElement = view.getByText(
    (_, element) => element?.children.length === 0 && element.textContent === code
  );
  expect(codeElement.textContent).toBe(code);
  expect(view.queryByRole("list")).toBeNull();
  expect(view.container.querySelector("script")).toBeNull();
  view.rerender(<Markdown text={`\`\`\`tsx\n${code}\`\`\`\n\nNext paragraph`} />);
  expect(
    view.getByText((_, element) => element?.children.length === 0 && element.textContent === code)
  ).toBeDefined();
  expect(view.getByText("Next paragraph")).toBeDefined();
  view.rerender(<Markdown text={"Unfinished ` and ** delimiters stay literal.\n``"} />);
  expect(view.container.textContent).toContain("Unfinished ` and ** delimiters stay literal.\n``");
});

function toolMessage(part: MuxToolPart, metadata?: MuxMessage["metadata"]): MuxMessage {
  return { id: "tool-message", role: "assistant", parts: [part], metadata };
}

test("a tool in a narrow transcript opens a sheet with literal output and closes without changing the message", () => {
  const output = "<img src=x>\nactual command output";
  const part: MuxToolPart = {
    type: "dynamic-tool",
    toolCallId: "bash-call",
    toolName: "bash",
    input: { script: "git status --short" },
    state: "output-available",
    output,
  };
  const view = render(
    <View style={{ width: 375 }}>
      <Message message={toolMessage(part)} canAnswer={false} onAnswer={async () => {}} />
    </View>
  );
  expect(view.getByRole("group", { name: "Assistant message" })).toBeDefined();
  expect(
    view.queryByText(
      (_, element) => element?.children.length === 0 && element.textContent === output
    )
  ).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Bash: Done. git status --short" }));
  expect(
    view.getByText((_, element) => element?.children.length === 0 && element.textContent === output)
  ).toBeDefined();
  expect(document.querySelector("img")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Close" }));
  expect(
    view.queryByText(
      (_, element) => element?.children.length === 0 && element.textContent === output
    )
  ).toBeNull();
  expect(view.getByRole("button", { name: "Bash: Done. git status --short" })).toBeDefined();
});

test.each([
  ["bash", "Wrench"],
  ["ask_user_question", "MessageCircleQuestion"],
  ["file_edit_replace_string", "Pencil"],
  ["file_read", "BookOpen"],
  ["server:GOOGLE_SEARCH_WEB", "Globe"],
  ["mcp__custom__search", "Sparkles"],
  ["unknown_tool", "Sparkles"],
  ["constructor", "Sparkles"],
  ["__proto__", "Sparkles"],
])("tool header %s renders its semantic glyph without changing inspection", (toolName, icon) => {
  const part: MuxToolPart = {
    type: "dynamic-tool",
    toolCallId: "icon-call",
    toolName,
    input: {},
    state: "output-available",
    output: "Inspect this result",
  };
  const view = render(
    <Message message={toolMessage(part)} canAnswer={false} onAnswer={async () => {}} />
  );
  const header = view.getByRole("button");
  expect(header.querySelector(`svg[data-icon="${icon}"]`)).not.toBeNull();
  fireEvent.click(header);
  expect(view.getByText("Inspect this result")).toBeDefined();
  fireEvent.click(view.getByRole("button", { name: "Close" }));
  expect(view.getByRole("button").querySelector(`svg[data-icon="${icon}"]`)).not.toBeNull();
});

test("nested tool events render in parent order and update an open child inspector through replay", () => {
  let transcript = applyChatEvent(createTranscriptState(), {
    type: "stream-start",
    workspaceId: "workspace",
    messageId: "nested",
    historySequence: 1,
    startTime: 0,
    model: "local:one",
  });
  transcript = applyChatEvent(transcript, {
    type: "tool-call-start",
    workspaceId: "workspace",
    messageId: "nested",
    toolCallId: "parent",
    toolName: "code_execution",
    args: { code: "await xum.file_read({path:'notes.txt'})" },
    tokens: 1,
    timestamp: 1,
    executionStartedAt: 1,
  });
  const renderMessage = () => (
    <View style={{ width: 375 }}>
      <Message
        message={transcript.messages[0]}
        streaming={transcript.streaming}
        canAnswer
        onAnswer={async () => {
          throw new Error("Nested calls cannot answer");
        }}
      />
    </View>
  );
  const view = render(renderMessage());
  for (const [toolCallId, toolName, args] of [
    ["read", "file_read", { path: "notes.txt" }],
    ["shell", "bash", { script: "printf ok" }],
  ] as const)
    transcript = applyChatEvent(transcript, {
      type: "tool-call-start",
      workspaceId: "workspace",
      messageId: "nested",
      parentToolCallId: "parent",
      toolCallId,
      toolName,
      args,
      tokens: 0,
      timestamp: 2,
    });
  view.rerender(renderMessage());
  expect(view.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
    "Code execution: Running",
    "File read: Running. notes.txt",
    "Bash: Running. printf ok",
  ]);
  const children = within(view.getByRole("group", { name: "Nested tool calls" }));
  expect(children.getAllByRole("button")).toHaveLength(2);
  expect(
    children
      .getByRole("button", { name: "File read: Running. notes.txt" })
      .querySelector('svg[data-icon="BookOpen"]')
  ).not.toBeNull();
  fireEvent.click(children.getByRole("button", { name: "File read: Running. notes.txt" }));
  const hostile = '<img src=x onerror="alert(1)">' + " long-path/".repeat(50);
  transcript = applyChatEvent(transcript, {
    type: "tool-call-end",
    workspaceId: "workspace",
    messageId: "nested",
    parentToolCallId: "parent",
    toolCallId: "read",
    toolName: "file_read",
    result: hostile,
    timestamp: 3,
  });
  view.rerender(renderMessage());
  expect(view.getByText(hostile)).toBeDefined();
  expect(document.querySelector("img")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Close" }));
  transcript = applyChatEvent(transcript, {
    type: "tool-call-end",
    workspaceId: "workspace",
    messageId: "nested",
    parentToolCallId: "parent",
    toolCallId: "shell",
    toolName: "bash",
    result: { error: "Command failed" },
    timestamp: 4,
  });
  transcript = applyChatEvent(transcript, {
    type: "tool-call-end",
    workspaceId: "workspace",
    messageId: "nested",
    toolCallId: "parent",
    toolName: "code_execution",
    result: { success: true, result: "Wrapper result" },
    timestamp: 5,
  });
  view.unmount();
  const replay = render(
    <View style={{ width: 200 }}>
      <Message
        message={JSON.parse(JSON.stringify(transcript.messages[0])) as MuxMessage}
        canAnswer={false}
        onAnswer={async () => {}}
      />
    </View>
  );
  expect(replay.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
    "Code execution: Done",
    "File read: Done. notes.txt",
    "Bash: Failed. printf ok",
  ]);
  fireEvent.click(replay.getByRole("button", { name: "Bash: Failed. printf ok" }));
  expect(replay.getByText(/Command failed/)).toBeDefined();
  fireEvent.click(replay.getByRole("button", { name: "Close" }));
  fireEvent.click(replay.getByRole("button", { name: "Code execution: Done" }));
  expect(replay.getByText(/Wrapper result/)).toBeDefined();
});

test("nested replay preserves failure/redaction/interruption metadata and never offers child questions", () => {
  const question = prefilledQuestionPart({ "Which branch?": "main" });
  let answers = 0;
  const part: MuxToolPart = {
    type: "dynamic-tool",
    toolCallId: "wrapper",
    toolName: "code_execution",
    input: {},
    state: "input-available",
    nestedCalls: [
      {
        toolCallId: "redacted",
        toolName: "bash",
        state: "output-redacted",
        output: "must stay hidden",
      },
      { toolCallId: "failed", toolName: "file_read", state: "output-available", failed: true },
      {
        toolCallId: "pending",
        toolName: "web_fetch",
        input: { url: "https://example.test" },
        state: "input-available",
      },
      {
        toolCallId: "question",
        toolName: "ask_user_question",
        input: question.input,
        state: "input-available",
      },
    ],
  };
  const view = render(
    <Message
      message={toolMessage(part, { partial: true })}
      canAnswer
      onAnswer={async () => {
        answers++;
      }}
    />
  );
  expect(view.getByRole("button", { name: "Code execution: Interrupted" })).toBeDefined();
  expect(view.getByRole("button", { name: "File read: Failed" })).toBeDefined();
  expect(view.getByRole("button", { name: "Web fetch: Interrupted" })).toBeDefined();
  fireEvent.click(view.getByRole("button", { name: "Bash: Redacted" }));
  expect(view.queryByText("must stay hidden")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Close" }));
  fireEvent.click(view.getByRole("button", { name: "Ask user question: Interrupted" }));
  expect(view.getByText(/Which branch/)).toBeDefined();
  expect(view.queryByRole("button", { name: "Send answers" })).toBeNull();
  expect(view.queryByRole("radio")).toBeNull();
  expect(answers).toBe(0);
});

test("nested rows stay at the supported child depth instead of recursively consuming narrow width", () => {
  const child = {
    toolCallId: "child",
    toolName: "file_read",
    state: "output-available" as const,
    output: "Child result",
    nestedCalls: [{ toolCallId: "unsupported-depth", toolName: "bash", state: "input-available" }],
  };
  const part: MuxToolPart = {
    type: "dynamic-tool",
    toolCallId: "parent",
    toolName: "code_execution",
    input: {},
    state: "output-available",
    output: {},
    nestedCalls: [child],
  };
  const view = render(
    <View style={{ width: 200 }}>
      <Message message={toolMessage(part)} canAnswer={false} onAnswer={async () => {}} />
    </View>
  );
  expect(view.getAllByRole("group", { name: "Nested tool calls" })).toHaveLength(1);
  expect(view.getAllByRole("button")).toHaveLength(2);
  fireEvent.click(view.getByRole("button", { name: "File read: Done" }));
  expect(view.getByText("Child result")).toBeDefined();
  expect(view.queryByRole("button", { name: /Bash/ })).toBeNull();
});

test("legacy toolCalls replay renders inspectable children without overriding explicit nestedCalls", () => {
  const part: MuxToolPart = {
    type: "dynamic-tool",
    toolCallId: "legacy",
    toolName: "code_execution",
    input: { code: "legacy execution" },
    state: "output-available",
    output: {
      success: true,
      toolCalls: [
        {
          toolName: "file_read",
          args: { path: "legacy.txt" },
          result: "Retained result",
          duration_ms: 1,
        },
        { toolName: "bash", error: "Legacy command failed", duration_ms: 2 },
        { toolName: "web_fetch", ok: false, duration_ms: 3 },
        {
          toolName: "ask_user_question",
          args: prefilledQuestionPart({ "Which branch?": "main" }).input,
          duration_ms: 4,
        },
      ],
    },
  };
  const renderMessage = (value: MuxToolPart) => (
    <Message
      message={toolMessage(value)}
      canAnswer
      onAnswer={async () => {
        throw new Error("Legacy child actions must not run");
      }}
    />
  );
  const view = render(renderMessage(part));
  fireEvent.click(view.getByRole("button", { name: "File read: Done. legacy.txt" }));
  expect(view.getByText("Retained result")).toBeDefined();
  fireEvent.click(view.getByRole("button", { name: "Close" }));
  fireEvent.click(view.getByRole("button", { name: "Bash: Failed" }));
  expect(view.getByText(/Legacy command failed/)).toBeDefined();
  fireEvent.click(view.getByRole("button", { name: "Close" }));
  expect(view.getByRole("button", { name: "Web fetch: Failed" })).toBeDefined();
  expect(view.getByRole("button", { name: "Ask user question: Done" })).toBeDefined();
  expect(view.queryByRole("button", { name: "Send answers" })).toBeNull();
  view.rerender(renderMessage({ ...part, nestedCalls: [] }));
  expect(view.queryByRole("group", { name: "Nested tool calls" })).toBeNull();
  expect(view.getAllByRole("button")).toHaveLength(1);
  view.rerender(
    renderMessage({
      ...part,
      nestedCalls: [
        {
          toolCallId: "explicit",
          toolName: "file_read",
          input: { path: "current.txt" },
          output: "Current result",
          state: "output-available",
        },
      ],
    })
  );
  expect(view.queryByRole("button", { name: "File read: Done. legacy.txt" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "File read: Done. current.txt" }));
  expect(view.getByText("Current result")).toBeDefined();
});

test("tool headers distinguish execution, completion, failure, redaction, and interrupted replay", () => {
  const part: MuxToolPart = {
    type: "dynamic-tool",
    toolCallId: "read-call",
    toolName: "file_read",
    input: { path: "src/app.ts", script: { not: "a string" } },
    state: "input-available",
  };
  const renderMessage = (tool: MuxToolPart, streaming = false, partial = false) => (
    <Message
      message={toolMessage(tool, { partial })}
      streaming={streaming}
      canAnswer={false}
      onAnswer={async () => {}}
    />
  );
  const view = render(renderMessage(part, true));
  expect(view.getByRole("button", { name: "File read: Pending. src/app.ts" })).toBeDefined();
  view.rerender(renderMessage({ ...part, executionStartedAt: 0 }, true));
  expect(view.getByRole("button", { name: "File read: Running. src/app.ts" })).toBeDefined();
  view.rerender(renderMessage(part));
  expect(view.getByRole("button", { name: "File read: No result. src/app.ts" })).toBeDefined();
  view.rerender(renderMessage(part, false, true));
  expect(view.getByRole("button", { name: "File read: Interrupted. src/app.ts" })).toBeDefined();
  view.rerender(
    renderMessage({
      ...part,
      state: "output-available",
      output: { success: false, error: "denied" },
    })
  );
  expect(view.getByRole("button", { name: "File read: Failed. src/app.ts" })).toBeDefined();
  view.rerender(renderMessage({ ...part, state: "output-redacted" }));
  fireEvent.click(view.getByRole("button", { name: "File read: Redacted. src/app.ts" }));
  expect(view.queryByText("denied")).toBeNull();
});

test("tool inspection caps large values but does not claim an exact-limit result is truncated", () => {
  const part: MuxToolPart = {
    type: "dynamic-tool",
    toolCallId: "large",
    toolName: "bash",
    input: {},
    state: "output-available",
    output: "x".repeat(24000),
  };
  const view = render(
    <Message message={toolMessage(part)} canAnswer={false} onAnswer={async () => {}} />
  );
  fireEvent.click(view.getByRole("button", { name: "Bash: Done" }));
  expect(view.getByText("x".repeat(24000)).textContent).toHaveLength(24000);
  expect(view.queryByText(/Showing the first/)).toBeNull();
  view.rerender(
    <Message
      message={toolMessage({ ...part, output: "x".repeat(24000) + "hidden suffix" })}
      canAnswer={false}
      onAnswer={async () => {}}
    />
  );
  expect(view.queryByText(/hidden suffix/)).toBeNull();
  expect(view.getByText(/Showing the first/)).toBeDefined();
});

test("question answers remain inline and require complete input before submission", async () => {
  const answers: Array<Record<string, string>> = [];
  const part: MuxToolPart = {
    type: "dynamic-tool",
    toolCallId: "question",
    toolName: "ask_user_question",
    state: "input-available",
    executionStartedAt: 0,
    input: {
      questions: [
        {
          question: "Which branch?",
          header: "Branch",
          options: [
            { label: "main", description: "Stable branch" },
            { label: "next", description: "Upcoming release" },
          ],
          multiSelect: false,
        },
        {
          question: "What should change?",
          header: "Scope",
          options: [
            { label: "API", description: "Change the interface" },
            { label: "UI", description: "Change the presentation" },
          ],
          multiSelect: false,
        },
      ],
    },
  };
  const view = render(
    <Message
      message={toolMessage(part)}
      streaming
      canAnswer
      onAnswer={async (_id, value) => {
        answers.push(value);
      }}
    />
  );
  fireEvent.click(view.getByRole("button", { name: "Send answers" }));
  expect(answers).toHaveLength(0);
  const branch = within(view.getByRole("radiogroup", { name: "Which branch?" }));
  expect(branch.getByText("Upcoming release")).toBeDefined();
  fireEvent.click(branch.getByRole("radio", { name: "next" }));
  fireEvent.click(branch.getByRole("radio", { name: "main" }));
  expect(branch.getByRole("radio", { name: "next" }).getAttribute("aria-checked")).toBe("false");
  fireEvent.click(view.getByRole("button", { name: "Send answers" }));
  expect(answers).toHaveLength(0);
  fireEvent.click(
    within(view.getByRole("radiogroup", { name: "What should change?" })).getByRole("radio", {
      name: "Other",
    })
  );
  fireEvent.click(view.getByRole("button", { name: "Send answers" }));
  expect(answers).toHaveLength(0);
  fireEvent.change(view.getByLabelText("Other: What should change?"), {
    target: { value: "Keep the API stable" },
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Send answers" }));
  });
  expect(answers).toEqual([
    { "Which branch?": "main", "What should change?": "Keep the API stable" },
  ]);
});

test.each(["Which features?", "__proto__"])(
  "multi-select question %s preserves selection order and custom text across a failed send",
  async (question) => {
    const answers: Array<Record<string, string>> = [];
    const part: MuxToolPart = {
      type: "dynamic-tool",
      toolCallId: "features",
      toolName: "ask_user_question",
      state: "input-available",
      input: {
        questions: [
          {
            question,
            header: "Features",
            options: [
              { label: "Search", description: "Find workspaces" },
              { label: "Tabs", description: "Switch conversations" },
            ],
            multiSelect: true,
          },
        ],
      },
    };
    const onAnswer = async (_id: string, value: Record<string, string>) => {
      answers.push(value);
      if (answers.length === 1) throw new Error("Connection lost");
    };
    const view = render(
      <Message message={toolMessage(part)} canAnswer={false} onAnswer={onAnswer} />
    );
    const search = view.getByRole("checkbox", { name: "Search" });
    fireEvent.click(search);
    expect(search.getAttribute("aria-checked")).toBe("false");
    view.rerender(<Message message={toolMessage(part)} canAnswer onAnswer={onAnswer} />);
    fireEvent.click(view.getByRole("checkbox", { name: "Tabs" }));
    fireEvent.click(search);
    fireEvent.click(search);
    expect(search.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(view.getByRole("checkbox", { name: "Other" }));
    fireEvent.change(view.getByLabelText(`Other: ${question}`), { target: { value: "   " } });
    fireEvent.click(view.getByRole("button", { name: "Send answers" }));
    expect(answers).toHaveLength(0);
    fireEvent.change(view.getByLabelText(`Other: ${question}`), {
      target: { value: "  Offline, too  " },
    });
    fireEvent.click(search);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Send answers" }));
    });
    expect(answers).toEqual([{ [question]: "Tabs, Offline, too, Search" }]);
    expect(view.getByRole("alert").textContent).toContain("Connection lost");
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Send answers" }));
    });
    expect(answers[1]).toEqual(answers[0]);
    fireEvent.click(view.getByRole("checkbox", { name: "Tabs" }));
    expect(view.getByRole("checkbox", { name: "Tabs" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(view.getByRole("button", { name: "Answers sent" }));
    expect(answers).toHaveLength(2);
  }
);

function prefilledQuestionPart(
  answers: unknown,
  multiSelect = false,
  toolCallId = "prefilled",
  questionText = "Which branch?"
): MuxToolPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "ask_user_question",
    state: "input-available",
    input: {
      questions: [
        {
          question: questionText,
          header: "Branch",
          options: [
            { label: "main", description: "Stable branch" },
            { label: "next", description: "Upcoming release" },
          ],
          multiSelect,
        },
      ],
      answers,
    },
  };
}

test("queued live questions cannot answer until their own execution starts, while partial recovery remains available", async () => {
  const answers: Array<unknown> = [];
  const client = createORPCClient<MobileClient>({
    call: async (path, input) => {
      if (path.join(".") !== "workspace.answerAskUserQuestion")
        throw new Error("Unexpected procedure");
      answers.push(input);
      return { success: true };
    },
  });
  const onAnswer = async (toolCallId: string, value: Record<string, string>) => {
    await client.workspace.answerAskUserQuestion({
      workspaceId: "workspace",
      toolCallId,
      answers: value,
    });
  };
  let transcript = applyChatEvent(createTranscriptState(), {
    type: "stream-start",
    workspaceId: "workspace",
    messageId: "parallel",
    historySequence: 1,
    startTime: 0,
    model: "local:one",
  });
  for (const id of ["first", "second"]) {
    const part = prefilledQuestionPart({ [id]: "main" }, false, id, id);
    transcript = applyChatEvent(transcript, {
      type: "tool-call-start",
      workspaceId: "workspace",
      messageId: "parallel",
      toolCallId: id,
      toolName: "ask_user_question",
      args: part.input,
      tokens: 1,
      timestamp: 0,
    });
  }
  const renderMessage = (canAnswer = true) => (
    <Message
      message={transcript.messages[0]}
      streaming={transcript.streaming}
      canAnswer={canAnswer}
      onAnswer={onAnswer}
    />
  );
  const view = render(renderMessage());
  const second = within(view.getByRole("radiogroup", { name: "second" }));
  fireEvent.click(second.getByRole("radio", { name: "next" }));
  expect(second.getByRole("radio", { name: "main" }).getAttribute("aria-checked")).toBe("true");
  for (const button of view.getAllByRole("button", { name: "Send answers" }))
    fireEvent.click(button);
  expect(answers).toHaveLength(0);
  transcript = applyChatEvent(transcript, {
    type: "tool-call-execution-start",
    workspaceId: "workspace",
    messageId: "parallel",
    toolCallId: "first",
    timestamp: 0,
  });
  view.rerender(renderMessage());
  expect(second.getByRole("radio", { name: "main" }).getAttribute("aria-disabled")).toBe("true");
  await act(async () => {
    fireEvent.click(view.getAllByRole("button", { name: "Send answers" })[0]);
  });
  expect(answers).toEqual([
    { workspaceId: "workspace", toolCallId: "first", answers: { first: "main" } },
  ]);
  transcript = applyChatEvent(transcript, {
    type: "tool-call-execution-start",
    workspaceId: "workspace",
    messageId: "parallel",
    toolCallId: "second",
    timestamp: 1,
  });
  view.rerender(renderMessage(false));
  fireEvent.click(view.getByRole("button", { name: "Send answers" }));
  expect(answers).toHaveLength(1);
  view.rerender(renderMessage());
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Send answers" }));
  });
  expect(answers[1]).toEqual({
    workspaceId: "workspace",
    toolCallId: "second",
    answers: { second: "main" },
  });
  view.rerender(
    <Message
      message={toolMessage(prefilledQuestionPart({ "Which branch?": "main" }, false, "recovered"), {
        partial: true,
      })}
      canAnswer
      onAnswer={onAnswer}
    />
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Send answers" }));
  });
  expect(answers[2]).toEqual({
    workspaceId: "workspace",
    toolCallId: "recovered",
    answers: { "Which branch?": "main" },
  });
});

test.each([
  { multi: false, answer: "main", choices: ["main"], other: null },
  { multi: false, answer: "feature, urgent", choices: ["Other"], other: "feature, urgent" },
  { multi: true, answer: "next, main", choices: ["next", "main"], other: null },
  {
    multi: true,
    answer: "next, main, custom one, custom two",
    choices: ["next", "main", "Other"],
    other: "custom one, custom two",
  },
])(
  "prefilled question displays and submits without edits: %j",
  async ({ multi, answer, choices, other }) => {
    const submitted: Array<Record<string, string>> = [];
    const part = prefilledQuestionPart(
      { "Which branch?": `  ${answer}  `, unrelated: "Ignore this" },
      multi
    );
    const view = render(
      <Message
        message={toolMessage(part)}
        canAnswer
        onAnswer={async (_id, value) => {
          submitted.push(value);
        }}
      />
    );
    for (const label of ["main", "next", "Other"]) {
      expect(
        view.getByRole(multi ? "checkbox" : "radio", { name: label }).getAttribute("aria-checked")
      ).toBe(String(choices.some((choice) => choice === label)));
    }
    if (other !== null)
      expect(view.getByDisplayValue(other)).toBe(view.getByLabelText("Other: Which branch?"));
    else expect(view.queryByLabelText("Other: Which branch?")).toBeNull();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Send answers" }));
    });
    expect(submitted).toEqual([{ "Which branch?": answer }]);
  }
);

test("prefilled drafts preserve user edits across deltas but reset for a different tool call", async () => {
  const submitted: Array<{ id: string; value: Record<string, string> }> = [];
  const onAnswer = async (id: string, value: Record<string, string>) => {
    submitted.push({ id, value });
  };
  const view = render(
    <Message
      message={toolMessage(prefilledQuestionPart({ "Which branch?": "main" }))}
      canAnswer
      onAnswer={onAnswer}
    />
  );
  fireEvent.click(view.getByRole("radio", { name: "Other" }));
  fireEvent.change(view.getByLabelText("Other: Which branch?"), {
    target: { value: "My edited branch" },
  });
  view.rerender(
    <Message
      message={toolMessage({
        ...prefilledQuestionPart({ "Which branch?": "next" }),
        executionStartedAt: 0,
      })}
      streaming
      canAnswer
      onAnswer={onAnswer}
    />
  );
  expect(view.getByDisplayValue("My edited branch")).toBe(
    view.getByLabelText("Other: Which branch?")
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Send answers" }));
  });
  expect(submitted).toEqual([{ id: "prefilled", value: { "Which branch?": "My edited branch" } }]);
  view.rerender(
    <Message
      message={toolMessage(
        prefilledQuestionPart({ "Which branch?": "next" }, false, "another-call")
      )}
      canAnswer
      onAnswer={onAnswer}
    />
  );
  expect(view.queryByLabelText("Other: Which branch?")).toBeNull();
  expect(view.getByRole("radio", { name: "next" }).getAttribute("aria-checked")).toBe("true");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Send answers" }));
  });
  expect(submitted[1]).toEqual({ id: "another-call", value: { "Which branch?": "next" } });
});

test.each([undefined, null, {}, { "Which branch?": "   " }])(
  "missing or blank prefilled answers remain unanswered: %j",
  (answers) => {
    const view = render(
      <Message
        message={toolMessage(prefilledQuestionPart(answers))}
        canAnswer
        onAnswer={async () => {}}
      />
    );
    expect(view.getByRole("button", { name: "Send answers" }).getAttribute("aria-disabled")).toBe(
      "true"
    );
    expect(view.getByRole("radio", { name: "Other" }).getAttribute("aria-checked")).toBe("false");
    expect(view.queryByLabelText("Other: Which branch?")).toBeNull();
  }
);

test.each(["constructor", "__proto__"])(
  "prefilled answer keys ignore inherited %s values and submit own properties safely",
  async (question) => {
    const inheritedAnswers: unknown = Object.create(Object.fromEntries([[question, "main"]]));
    const submitted: Array<Record<string, string>> = [];
    const view = render(
      <Message
        message={toolMessage(
          prefilledQuestionPart(inheritedAnswers, false, "key-safety", question)
        )}
        canAnswer
        onAnswer={async (_id, value) => {
          submitted.push(value);
        }}
      />
    );
    expect(view.getByRole("radio", { name: "main" }).getAttribute("aria-checked")).toBe("false");
    expect(view.getByRole("button", { name: "Send answers" }).getAttribute("aria-disabled")).toBe(
      "true"
    );
    fireEvent.click(view.getByRole("radio", { name: "next" }));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Send answers" }));
    });
    expect(submitted).toHaveLength(1);
    expect(Object.hasOwn(submitted[0], question)).toBe(true);
    expect(submitted[0][question]).toBe("next");
    expect(Object.getPrototypeOf(submitted[0])).toBe(Object.prototype);
  }
);

test("invalid prefilled answer types are rejected by the canonical schema without crashing the message", () => {
  const view = render(
    <Message
      message={toolMessage(prefilledQuestionPart({ "Which branch?": 42 }))}
      canAnswer
      onAnswer={async () => {}}
    />
  );
  expect(view.queryByRole("button", { name: "Send answers" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Ask user question: No result" }));
  expect(view.getByText(/42/)).toBeDefined();
});

test("malformed question payloads stay inspectable without presenting an incomplete answer form", () => {
  const part: MuxToolPart = {
    type: "dynamic-tool",
    toolCallId: "malformed",
    toolName: "ask_user_question",
    state: "input-available",
    input: { questions: [{ question: "Missing choices?" }] },
  };
  const view = render(<Message message={toolMessage(part)} canAnswer onAnswer={async () => {}} />);
  expect(view.queryByRole("button", { name: "Send answers" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Ask user question: No result" }));
  expect(view.getByText(/Missing choices/)).toBeDefined();
});

test("reasoning stays an inline disclosure and historical errors are not replaced by an empty-response hint", () => {
  const message: MuxMessage = {
    id: "reasoning",
    role: "assistant",
    parts: [{ type: "reasoning", text: "Consider <unsafe> as literal text." }],
  };
  const props = { canAnswer: false, onAnswer: async () => {} };
  const view = render(<Message {...props} message={message} />);
  expect(view.queryByText("Consider <unsafe> as literal text.")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Reasoning" }));
  expect(view.getByText("Consider <unsafe> as literal text.")).toBeDefined();
  expect(view.queryByRole("button", { name: "Close" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Reasoning" }));
  expect(view.queryByText("Consider <unsafe> as literal text.")).toBeNull();
  view.rerender(
    <Message
      {...props}
      message={{ ...message, parts: [], metadata: { error: "Provider rejected the request" } }}
    />
  );
  expect(view.getByRole("alert").textContent).toContain("Provider rejected the request");
  expect(view.queryByText("No response received")).toBeNull();
});
