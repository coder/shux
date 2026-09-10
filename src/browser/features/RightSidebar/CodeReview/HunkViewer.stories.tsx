import type { Meta, StoryObj } from "@storybook/react-vite";
import { within, waitFor } from "@storybook/test";
import { useRef, useState, type ComponentType, type FC, type ReactNode } from "react";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import {
  WorkspaceContext,
  type WorkspaceContext as WorkspaceContextValue,
} from "@/browser/contexts/WorkspaceContext";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { PIXEL_DUAL_THEME } from "@/browser/stories/meta";
import type { DiffHunk } from "@/common/types/review";
import { extractAllHunks, parseDiff } from "@/common/utils/git/diffParser";

import { HunkViewer } from "./HunkViewer";

// Small TypeScript diff so the Sparkles + assisted comment row sits next to a
// realistic block of highlighted code in visual snapshots. Reuses the same
// parsing pipeline as production so the story renders the exact hunk shape the
// app uses, including `id` / `header` / new-line ranges.
const ASSISTED_DIFF = `diff --git a/src/utils/formatPrice.ts b/src/utils/formatPrice.ts
index 1111111..2222222 100644
--- a/src/utils/formatPrice.ts
+++ b/src/utils/formatPrice.ts
@@ -1,6 +1,8 @@
 export function formatPrice(amount: number, currency = "USD"): string {
+  const formatter = new Intl.NumberFormat("en-US", { style: "currency", currency });
+
   if (!Number.isFinite(amount)) {
-    return "$0.00";
+    return formatter.format(0);
   }
-  return amount.toFixed(2);
+  return formatter.format(amount);
 }
`;

const STORY_WORKSPACE_ID = "ws-hunk-viewer-assisted";
const STORY_FIRST_SEEN_AT = 1_700_000_000_000;

function parseStoryHunk(): DiffHunk {
  const hunks = extractAllHunks(parseDiff(ASSISTED_DIFF));
  const firstHunk = hunks[0];
  if (!firstHunk) {
    throw new Error("ASSISTED_DIFF fixture must produce at least one hunk.");
  }
  return firstHunk;
}

const STORY_HUNK = parseStoryHunk();

function createHunkViewerStoryClient(): APIClient {
  // HunkViewer's useReadMore hook calls into the API client, but only when the
  // user expands additional context. We mock executeBash with an empty success
  // so the lazy expansion path stays inert during snapshot capture.
  return createMockORPCClient({
    executeBash: () =>
      Promise.resolve({
        success: true,
        output: "",
        exitCode: 0,
        wall_duration_ms: 0,
      }),
  });
}

// HunkViewer → useReadMore → useWorkspaceMetadata. The hook only needs the
// metadata map to resolve a repo-root project path (gracefully returns undefined
// for missing entries), so the empty map + no-op actions stub is enough to let
// HunkViewer mount without spinning up the full WorkspaceProvider stack.
function createStubWorkspaceContextValue(): WorkspaceContextValue {
  return {
    workspaceMetadata: new Map(),
    loading: false,
    loaded: true,
    loadError: null,
    archivingWorkspaceIds: new Set<string>(),
    workspaceDraftPromotionsByProject: {},
    promoteWorkspaceDraft: () => undefined,
    createWorkspace: () =>
      Promise.resolve({
        projectPath: "/tmp/project",
        projectName: "project",
        namedWorkspacePath: "/tmp/project/main",
        workspaceId: "created-workspace",
      }),
    removeWorkspace: () => Promise.resolve({ success: true }),
    updateWorkspaceTitle: () => Promise.resolve({ success: true }),
    setWorkspacePinned: () => Promise.resolve({ success: true }),
    reorderPinnedWorkspaces: () => Promise.resolve({ success: true }),
    preflightArchiveWorkspace: () => Promise.resolve({ success: true }),
    archiveWorkspace: () => Promise.resolve({ success: true }),
    unarchiveWorkspace: () => Promise.resolve({ success: true }),
    refreshWorkspaceMetadata: () => Promise.resolve(),
    setWorkspaceMetadata: () => undefined,
    selectedWorkspace: null,
    setSelectedWorkspace: () => undefined,
    pendingNewWorkspaceProject: null,
    pendingNewWorkspaceSubProjectPath: null,
    pendingNewWorkspaceDraftId: null,
    beginWorkspaceCreation: () => undefined,
    workspaceDraftsByProject: {},
    createWorkspaceDraft: () => undefined,
    updateWorkspaceDraftSubProject: () => undefined,
    openWorkspaceDraft: () => undefined,
    deleteWorkspaceDraft: () => undefined,
    getWorkspaceInfo: () => Promise.resolve(null),
  };
}

const HunkViewerStoryShell: FC<{ client: APIClient; children: ReactNode }> = (props) => {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <APIProvider client={props.client}>
          <WorkspaceContext.Provider value={createStubWorkspaceContextValue()}>
            {props.children}
          </WorkspaceContext.Provider>
        </APIProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
};

interface HunkViewerStoryProps {
  assistedComment?: string;
  isAssisted?: boolean;
  isAssistedNew?: boolean;
}

function HunkViewerStory(props: HunkViewerStoryProps) {
  const client = useRef(createHunkViewerStoryClient()).current;
  const [isRead, setIsRead] = useState(false);

  return (
    <HunkViewerStoryShell client={client}>
      <div className="bg-background p-4">
        <HunkViewer
          hunk={STORY_HUNK}
          hunkId={STORY_HUNK.id}
          workspaceId={STORY_WORKSPACE_ID}
          isSelected={false}
          isRead={isRead}
          firstSeenAt={STORY_FIRST_SEEN_AT}
          onToggleRead={() => setIsRead((prev) => !prev)}
          diffBase="main"
          includeUncommitted={false}
          assistedComment={props.assistedComment}
          isAssisted={props.isAssisted}
          isAssistedNew={props.isAssistedNew}
        />
      </div>
    </HunkViewerStoryShell>
  );
}

const meta: Meta<typeof HunkViewer> = {
  title: "Features/RightSidebar/CodeReview/HunkViewer",
  component: HunkViewer,
  decorators: [
    (Story: ComponentType) => (
      <div style={{ width: 880 }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "padded",
    // Dual light/dark coverage so the assisted accent (blue) is verified in both
    // themes — the whole point of these stories is to lock in the accent color
    // across themes so it cannot drift back toward the warning/amber family.
    pixel: { matrix: PIXEL_DUAL_THEME },
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

/** Baseline (non-assisted) hunk so reviewers can compare against the assisted variants. */
export const Default: Story = {
  render: () => <HunkViewerStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      // Should NOT have any assisted UI — confirms the comparison baseline.
      if (canvas.queryByTestId("hunk-assisted-comment")) {
        throw new Error("Baseline hunk should not render the assisted-comment banner.");
      }
    });
  },
};

/**
 * Assisted hunk with an agent-provided comment. Exercises the primary
 * `--color-review-accent` surfaces: Sparkles icon, banner border/background,
 * and the foreground text color used inside the strip.
 */
export const WithAssistedComment: Story = {
  render: () => (
    <HunkViewerStory assistedComment="The formatter is recreated on every call — hoist it outside the function so currency changes still share the cached Intl.NumberFormat." />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      canvas.getByTestId("hunk-assisted-comment");
    });
  },
};

/**
 * Assisted hunk with the transient "NEW" pill. Locks in the additional
 * `--color-review-accent` surface used by the `isAssistedNew` badge so a
 * regression in either the banner or the pill is caught by Pixel.
 */
export const WithAssistedCommentNewBadge: Story = {
  render: () => (
    <HunkViewerStory
      assistedComment="Just pinned by the agent — surfaces the NEW pill alongside the comment."
      isAssistedNew
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      canvas.getByTestId("hunk-assisted-comment");
      canvas.getByTestId("hunk-assisted-new-badge");
    });
  },
};

/**
 * Assisted hunk *without* a comment. Exercises the italic "Flagged by agent for
 * review" placeholder plus the header's left-edge accent stripe
 * (`border-l-review-accent`), which is the only assisted surface that doesn't
 * also appear in the with-comment story.
 */
export const AssistedWithoutComment: Story = {
  render: () => <HunkViewerStory isAssisted />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      canvas.getByTestId("hunk-assisted-comment");
      canvas.getByText(/Flagged by agent for review/i);
    });
  },
};
