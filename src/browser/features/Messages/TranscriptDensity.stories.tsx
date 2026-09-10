import { userEvent, waitFor } from "@storybook/test";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks, PIXEL_DUAL_THEME } from "@/browser/stories/meta.js";
import { setupSimpleChatStory } from "@/browser/stories/helpers/chatSetup";
import { collapseLeftSidebar } from "@/browser/stories/helpers/uiState";
import { createAssistantMessage, createUserMessage } from "@/browser/stories/mocks/messages";
import {
  createAgentSkillReadTool,
  createBashTool,
  createFileEditTool,
  createFileReadTool,
  createGenericTool,
  createPendingTool,
  createProposePlanTool,
  createWebSearchTool,
} from "@/browser/stories/mocks/tools";
import { STABLE_TIMESTAMP } from "@/browser/stories/mocks/workspaces";
import { TRANSCRIPT_DENSITY_KEY, type TranscriptDensity } from "@/common/constants/storage";

const meta = { ...appMeta, title: "App/Chat/Transcript Density" };
export default meta;

function setDensity(density: TranscriptDensity): void {
  updatePersistedState<TranscriptDensity>(TRANSCRIPT_DENSITY_KEY, density);
}

function setupTranscriptDensityStory(density: TranscriptDensity) {
  collapseLeftSidebar();
  setDensity(density);
  return setupSimpleChatStory({
    messages: [
      createUserMessage("density-user-1", "Audit the auth module and make the smallest safe fix", {
        historySequence: 1,
        timestamp: STABLE_TIMESTAMP - 60_000,
      }),
      createAssistantMessage("density-assistant-1", "I'll gather context first.", {
        historySequence: 2,
        timestamp: STABLE_TIMESTAMP - 55_000,
        partial: true,
        reasoning:
          "Need to inspect auth code, search related validation guidance, and then make a minimal patch.",
        toolCalls: [
          createFileReadTool("density-read-1", "src/auth.ts", "export function verify() {}"),
          createWebSearchTool("density-search-1", "JWT validation best practices", 3),
          createAgentSkillReadTool("density-skill-1", "react-effects", { scope: "global" }),
          createGenericTool(
            "density-question-1",
            "ask_user_question",
            { question: "Any additional validation needed?" },
            { answer: "Please validate with typecheck too" }
          ),
        ],
      }),
      createUserMessage("density-user-2", "Please validate with typecheck too", {
        historySequence: 3,
        timestamp: STABLE_TIMESTAMP - 40_000,
      }),
      createAssistantMessage(
        "density-assistant-2",
        "I found the relevant code and will patch it.",
        {
          historySequence: 4,
          timestamp: STABLE_TIMESTAMP - 35_000,
          toolCalls: [
            createFileEditTool(
              "density-edit-1",
              "src/auth.ts",
              [
                "--- src/auth.ts",
                "+++ src/auth.ts",
                "@@ -1,3 +1,4 @@",
                "+import { timingSafeEqual } from 'crypto';",
                " export function verify() {}",
              ].join("\n")
            ),
            createBashTool(
              "density-test-1",
              "make test",
              "42 tests passed",
              0,
              30,
              500,
              "Running tests"
            ),
            createBashTool(
              "density-fail-1",
              "make typecheck",
              "Type error in src/auth.ts",
              1,
              30,
              500,
              "Failing validation"
            ),
            {
              type: "text",
              text: "Implemented the auth audit fix and validated it.",
              timestamp: STABLE_TIMESTAMP - 15_000,
            },
          ],
        }
      ),
    ],
  });
}

function getRequiredStoryElement(canvasElement: HTMLElement, testId: string): HTMLElement {
  const element = canvasElement.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Expected ${testId} to be rendered`);
  }
  return element;
}

export const NormalNoisyTranscript: AppStory = {
  render: () => <AppWithMocks setup={() => setupTranscriptDensityStory("normal")} />,
};

export const HyperCollapsedBundles: AppStory = {
  parameters: { pixel: { matrix: PIXEL_DUAL_THEME } },
  render: () => <AppWithMocks setup={() => setupTranscriptDensityStory("hyper")} />,
};

export const HyperTailProposePlanExpanded: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        setDensity("hyper");
        return setupSimpleChatStory({
          messages: [
            createUserMessage("tail-plan-user-1", "Plan the transcript density fix", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 20_000,
            }),
            createAssistantMessage("tail-plan-assistant-1", "I'll draft the implementation plan.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 15_000,
              toolCalls: [
                createProposePlanTool(
                  "tail-plan-tool-1",
                  [
                    "# Tail Plan",
                    "",
                    "## Acceptance",
                    "",
                    "- The tail propose_plan is visible in hyper density without expanding bundles.",
                  ].join("\n")
                ),
                {
                  type: "text",
                  text: "Plan ready for review.",
                  timestamp: STABLE_TIMESTAMP - 5_000,
                },
              ],
            }),
          ],
        });
      }}
    />
  ),
};

export const HyperExpandedBundle: AppStory = {
  // Pixel executes this play function for the visual snapshot, while the
  // app-level UI test covers expansion behavior without Storybook's manager-page timing.
  tags: ["!test"],
  render: () => <AppWithMocks setup={() => setupTranscriptDensityStory("hyper")} />,
  play: async ({ canvasElement }) => {
    const workBundle = await waitFor(() => getRequiredStoryElement(canvasElement, "work-bundle"), {
      timeout: 15_000,
    });

    await userEvent.click(workBundle);

    await waitFor(
      () => {
        if (workBundle.getAttribute("aria-expanded") !== "true") {
          throw new Error("Expected HyperExpandedBundle work bundle to be expanded");
        }
      },
      { timeout: 15_000 }
    );
    await waitFor(() => getRequiredStoryElement(canvasElement, "operational-bundle"), {
      timeout: 15_000,
    });
  },
};

// Gallery merge: three non-interactive hyper-density edge cases (critical events
// stay visible, an all-miss search bundle, and an active/pending tool tail) are
// folded into one composite transcript so a single snapshot covers all three
// states. Each scenario keeps a distinct, labeled user turn so reviewers can still
// see every permutation. The active/pending scenario is last so the pending tail
// stays realistic. Replaces the former HyperVisibleCriticalEvents,
// HyperAllMissSearchBundle, and HyperActiveExpandedBundle stories.
export const HyperEdgeCaseGallery: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        setDensity("hyper");
        const activeStartedAt = Date.now() - 39_000;
        return setupSimpleChatStory({
          messages: [
            // Scenario 1: critical events remain visible in hyper density.
            createUserMessage("gallery-critical-user", "Make the change and validate it", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 60_000,
            }),
            createAssistantMessage(
              "gallery-critical-assistant",
              "I'll inspect, edit, and validate.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 55_000,
                toolCalls: [
                  createFileReadTool(
                    "gallery-critical-read",
                    "src/config.ts",
                    "export const enabled = false;"
                  ),
                  createFileEditTool(
                    "gallery-critical-edit",
                    "src/config.ts",
                    "--- src/config.ts\n+++ src/config.ts\n@@ -1 +1 @@\n-export const enabled = false;\n+export const enabled = true;"
                  ),
                  createBashTool(
                    "gallery-critical-validation",
                    "make typecheck",
                    "Type error in src/config.ts",
                    1
                  ),
                  createGenericTool(
                    "gallery-critical-question",
                    "ask_user_question",
                    { question: "Proceed?" },
                    { answer: "Yes" }
                  ),
                  createGenericTool(
                    "gallery-critical-notify",
                    "notify",
                    { title: "Validation failed" },
                    { success: true }
                  ),
                ],
              }
            ),
            // Scenario 2: an all-miss search bundle (zero results).
            createUserMessage("gallery-miss-user", "Look for a deprecated helper", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 40_000,
            }),
            createAssistantMessage("gallery-miss-assistant", "I'll search for that helper.", {
              historySequence: 4,
              timestamp: STABLE_TIMESTAMP - 35_000,
              toolCalls: [createWebSearchTool("gallery-miss-search", "deprecatedMuxHelper", 0)],
            }),
            // Scenario 3 (tail): active/pending tools so the elapsed-time UI renders.
            createUserMessage("gallery-active-user", "Inspect the repository", {
              historySequence: 5,
              timestamp: activeStartedAt - 5_000,
            }),
            createAssistantMessage("gallery-active-assistant", "I'll read the key files now.", {
              historySequence: 6,
              timestamp: activeStartedAt,
              toolCalls: [
                createPendingTool("gallery-active-read", "file_read", { path: "src/App.tsx" }),
                createPendingTool("gallery-active-search", "web_search", {
                  query: "Xum transcript density",
                }),
              ],
            }),
          ],
        });
      }}
    />
  ),
};
