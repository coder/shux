import "../../../../tests/ui/dom";

import { replicateAsyncIterator } from "@orpc/shared";
import type { APIClient } from "@/browser/contexts/API";
import type { RecursivePartial } from "@/browser/testUtils";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";

let cleanupDom: (() => void) | null = null;
let currentClientMock: RecursivePartial<APIClient> = {};
void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: currentClientMock as APIClient,
    status: "connected" as const,
    error: null,
  }),
  APIProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { ProjectAddForm } from "../ProjectCreateModal/ProjectCreateModal";

describe("ProjectAddForm", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    currentClientMock = {};
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
    currentClientMock = {};
  });

  test("creates a new git project and uses the backend response", async () => {
    const createProject = mock(() =>
      Promise.resolve({
        success: true as const,
        data: {
          normalizedPath: "/projects/backend-normalized",
          projectConfig: { workspaces: [] },
        },
      })
    );
    currentClientMock = {
      projects: {
        getDefaultProjectDir: () => Promise.resolve("/projects"),
        list: () => Promise.resolve([]),
        create: createProject,
      },
    };
    const onSuccess = mock(() => undefined);

    const { getByText, getByPlaceholderText } = render(
      <ProjectAddForm isOpen onSuccess={onSuccess} />
    );

    fireEvent.click(getByText("New project"));
    const projectInput = getByPlaceholderText("my-new-project");
    const user = userEvent.setup({ document: projectInput.ownerDocument });
    await user.type(projectInput, "prototype");
    fireEvent.click(getByText("Create Project"));

    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith({ projectPath: "prototype", initGit: true })
    );
    await waitFor(() =>
      expect(onSuccess).toHaveBeenCalledWith("/projects/backend-normalized", { workspaces: [] })
    );
  });

  test("aborts in-flight clone when unmounted", async () => {
    let receivedSignal: AbortSignal | null = null;

    currentClientMock = {
      projects: {
        getDefaultProjectDir: () => Promise.resolve("/tmp"),
        clone: (_input, options) => {
          receivedSignal = options?.signal ?? null;

          async function* iterator() {
            yield { type: "progress" as const, line: "progress: starting\n" };

            await new Promise<void>((resolve) => {
              if (!receivedSignal) {
                resolve();
                return;
              }

              if (receivedSignal.aborted) {
                resolve();
                return;
              }

              receivedSignal.addEventListener("abort", () => resolve(), { once: true });
            });
          }

          return Promise.resolve(replicateAsyncIterator(iterator(), 1)[0]);
        },
      },
    };

    const onIsCreatingChange = mock(() => undefined);

    const { getByText, getByPlaceholderText, unmount } = render(
      <ProjectAddForm isOpen onSuccess={() => undefined} onIsCreatingChange={onIsCreatingChange} />
    );

    fireEvent.click(getByText("Clone repo"));

    const repoInput = getByPlaceholderText("owner/repo or https://github.com/...");

    const user = userEvent.setup({ document: repoInput.ownerDocument });
    await user.type(repoInput, "owner/repo");

    await waitFor(() => expect((repoInput as HTMLInputElement).value).toBe("owner/repo"));

    fireEvent.click(getByText("Clone Project"));

    await waitFor(() => expect(receivedSignal).not.toBeNull());
    await waitFor(() => expect(onIsCreatingChange).toHaveBeenCalledWith(true));

    unmount();

    await waitFor(() => expect(receivedSignal?.aborted).toBe(true));
    await waitFor(() => expect(onIsCreatingChange).toHaveBeenCalledWith(false));
  });
});
