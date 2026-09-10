import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks, PIXEL_DISABLED } from "@/browser/stories/meta.js";
import { setupSimpleChatStory } from "@/browser/stories/helpers/chatSetup";
import { collapseLeftSidebar, setWorkspaceInput } from "@/browser/stories/helpers/uiState";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getModelKey, getReasoningModeKey } from "@/common/constants/storage";
import { createAssistantMessage, createUserMessage } from "@/browser/stories/mocks/messages";
import { createFileReadTool } from "@/browser/stories/mocks/tools";
import { STABLE_TIMESTAMP } from "@/browser/stories/mocks/workspaces";
import {
  blurActiveElement,
  waitForChatInputAutofocusDone,
} from "@/browser/stories/storyPlayHelpers.js";
import { within, userEvent, waitFor } from "@storybook/test";
import { MOBILE_TOUCH_TARGET_PX } from "@/constants/layout";

// Tailwind's `max-w-4xl` in px, the cap the centered transcript and composer columns share.
const CENTERED_COLUMN_MAX_WIDTH_PX = 896;

const meta = { ...appMeta, title: "App/Chat/Input" };
export default meta;

/** Voice input button shows user education when OpenAI API key is not set */
export const VoiceInputNoApiKey: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [],
          // No OpenAI key configured - voice button should be disabled with tooltip
          providersConfig: {
            anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true },
            // openai deliberately missing
          },
        })
      }
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Shows the voice input button in disabled state when OpenAI API key is not configured. Hover over the mic icon in the chat input to see the user education tooltip.",
      },
    },
  },
};

export const ComposerTooltip: AppStory = {
  tags: ["tooltip-visual"],
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-composer-tooltip",
          messages: [],
        })
      }
    />
  ),
  parameters: {
    ...appMeta.parameters,
    pixel: {
      // Keep the shared tooltip honest in the dense composer and near the phone viewport edge.
      matrix: { themes: ["dark", "light"], viewports: ["phone", "laptop"] },
    },
    docs: {
      description: {
        story:
          "Hovers the chat input attachment control so the shared tooltip surface is captured in its most space-constrained production context.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await waitForChatInputAutofocusDone(storyRoot);
    blurActiveElement();

    const attachButton = within(storyRoot).getByLabelText("Attach file");
    await userEvent.hover(attachButton);

    await waitFor(
      () => {
        const tooltip = document.querySelector<HTMLElement>(
          "[data-radix-popper-content-wrapper] [data-side]"
        );
        if (!tooltip?.textContent?.includes("Attach any file")) {
          throw new Error("Chat input attachment tooltip not visible");
        }
        if (
          tooltip.scrollWidth > tooltip.clientWidth ||
          tooltip.scrollHeight > tooltip.clientHeight
        ) {
          throw new Error(
            `Tooltip overflows (${tooltip.scrollWidth}×${tooltip.scrollHeight}px > ${tooltip.clientWidth}×${tooltip.clientHeight}px)`
          );
        }

        const bounds = tooltip.getBoundingClientRect();
        const viewportPadding = 8;
        if (
          bounds.left < viewportPadding ||
          bounds.right > window.innerWidth - viewportPadding ||
          bounds.top < viewportPadding ||
          bounds.bottom > window.innerHeight - viewportPadding
        ) {
          throw new Error("Tooltip is outside the viewport-safe area");
        }
      },
      { interval: 50, timeout: 5000 }
    );
  },
};

export const QueuedFollowUp: AppStory = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        return setupSimpleChatStory({
          workspaceId: "ws-queued-follow-up",
          messages: [
            createUserMessage("msg-1", "Please audit the settings flow for regressions.", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 120_000,
            }),
            createAssistantMessage(
              "msg-2",
              "I’m reviewing the relevant components and tests now.",
              { historySequence: 2, timestamp: STABLE_TIMESTAMP - 60_000 }
            ),
          ],
          onChat: (workspaceId, emit) => {
            // Replay the active turn after history catches up so the queued card is exercised in the
            // same docked state users see while an agent is working.
            setTimeout(() => {
              emit({
                type: "stream-start",
                workspaceId,
                messageId: "msg-3",
                model: "mock-model",
                historySequence: 3,
                startTime: STABLE_TIMESTAMP,
              });
              emit({
                type: "stream-delta",
                workspaceId,
                messageId: "msg-3",
                delta: "Checking the form state and keyboard paths…",
                tokens: 8,
                timestamp: STABLE_TIMESTAMP,
              });
              emit({
                type: "queued-message-changed",
                workspaceId,
                hasQueuedMessages: true,
                queuedMessages: [
                  "Also verify the narrow layout and make sure the action buttons stay easy to scan.",
                ],
                displayText:
                  "Also verify the narrow layout and make sure the action buttons stay easy to scan.",
                queueDispatchMode: "tool-end",
              });
            }, 75);
          },
        });
      }}
    />
  ),
  parameters: {
    ...appMeta.parameters,
    pixel: {
      matrix: { themes: ["dark", "light"], viewports: ["phone", "laptop"] },
    },
  },
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await waitForChatInputAutofocusDone(storyRoot);
    blurActiveElement();

    await waitFor(() => {
      const group = storyRoot.querySelector<HTMLElement>('[data-component="QueuedMessageGroup"]');
      const dock = group?.closest<HTMLElement>('[data-component="ChatDockSurface"]');
      const card = storyRoot.querySelector<HTMLElement>('[data-component="QueuedMessageCard"]');
      const actions = storyRoot.querySelector<HTMLElement>(
        '[data-component="QueuedMessageActions"]'
      );
      const status = storyRoot.querySelector<HTMLElement>('[data-component="QueuedMessageStatus"]');
      if (!dock || !group || !card || !actions || !status) {
        throw new Error("Queued follow-up user-message layout not rendered");
      }
      for (const element of [group, card, actions, status]) {
        if (element.scrollWidth > element.clientWidth) {
          throw new Error(
            `Queued follow-up element overflows horizontally (${element.scrollWidth}px > ${element.clientWidth}px)`
          );
        }
      }

      const dockBounds = dock.getBoundingClientRect();
      const groupBounds = group.getBoundingClientRect();
      const cardBounds = card.getBoundingClientRect();
      const actionsBounds = actions.getBoundingClientRect();
      const statusBounds = status.getBoundingClientRect();
      if (Math.abs(dockBounds.right - groupBounds.right) > 1) {
        throw new Error("Queued follow-up group is not right-aligned with the transcript column");
      }
      if (Math.abs(groupBounds.right - cardBounds.right) > 1) {
        throw new Error("Queued follow-up bubble is not right-aligned within its group");
      }
      if (Math.abs(groupBounds.right - actionsBounds.right) > 1) {
        throw new Error("Queued follow-up actions are not right-aligned within their metadata row");
      }
      if (statusBounds.right > groupBounds.right + 1) {
        throw new Error("Queued follow-up status overflows its right-aligned metadata row");
      }
    });

    const status = storyRoot.querySelector<HTMLButtonElement>(
      '[data-component="QueuedMessageStatus"]'
    );
    if (!status) throw new Error("Queued dispatch dropdown not rendered");
    await userEvent.click(status);
    await waitFor(() => {
      const menu = storyRoot.querySelector<HTMLElement>(
        '[data-component="QueuedMessageDispatchMenu"]'
      );
      if (!menu) throw new Error("Queued dispatch menu did not open");
      if (menu.querySelectorAll('[role="menuitem"]').length !== 3) {
        throw new Error("Queued dispatch menu must show exactly three actions");
      }
      if (menu.scrollWidth > menu.clientWidth) {
        throw new Error("Queued dispatch menu overflows horizontally");
      }
      for (const item of menu.querySelectorAll<HTMLElement>('[role="menuitem"]')) {
        if (item.scrollHeight > item.clientHeight) {
          throw new Error("Queued dispatch menu item wraps vertically");
        }
      }
    });
  },
};

export const FocusedComposer: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-focus-border",
          messages: [],
        })
      }
    />
  ),
  parameters: {
    ...appMeta.parameters,
    pixel: PIXEL_DISABLED,
  },
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    const canvas = within(storyRoot);

    await waitForChatInputAutofocusDone(storyRoot);

    const textarea = await canvas.findByLabelText("Message Claude");
    const surface = storyRoot.querySelector('[data-component="ChatInputSurface"]');
    if (!surface) throw new Error("Composer surface not rendered");

    blurActiveElement();
    const blurredBorder = getComputedStyle(surface).borderColor;

    textarea.focus();
    await waitFor(() => {
      if (getComputedStyle(surface).borderColor === blurredBorder) {
        throw new Error(`Focusing the composer left its border at ${blurredBorder}`);
      }
    });
  },
};

export const ThinkingSelectorOpen: AppStory = {
  tags: ["thinking-selector"],
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        updatePersistedState(getModelKey("ws-thinking-selector"), "openai:gpt-5.6-sol");
        updatePersistedState(getReasoningModeKey("ws-thinking-selector"), "pro");
        return setupSimpleChatStory({
          workspaceId: "ws-thinking-selector",
          providersConfig: {
            openai: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              serviceTier: "priority",
            },
          },
          messages: [],
        });
      }}
    />
  ),
  parameters: {
    ...appMeta.parameters,
    pixel: {
      matrix: { themes: ["dark", "light"], viewports: ["phone", "laptop"] },
    },
    docs: {
      description: {
        story:
          "Opens the chat-input thinking selector with Pro and fast mode active, including the phone-width layout.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await waitForChatInputAutofocusDone(storyRoot);
    blurActiveElement();

    await userEvent.click(within(storyRoot).getByRole("button", { name: /Thinking:/i }));
    await waitFor(() => {
      const menu = storyRoot.querySelector<HTMLElement>('[data-component="ThinkingSelectorMenu"]');
      if (!menu) throw new Error("Thinking selector menu did not open");
      if (!within(menu).getByRole("button", { name: /Pro mode/i })) {
        throw new Error("Pro mode row missing");
      }
      if (!within(menu).getByRole("button", { name: /Fast mode/i })) {
        throw new Error("Fast mode row missing");
      }
    });
  },
};

/**
 * The composer control row collapses on container width, not viewport width, so a fixed-width
 * wrapper reproduces every stage: the play resizes the wrapper and asserts each one. Guarding on the
 * measured row width keeps the assertions honest if the surrounding layout ever changes, and each
 * stage also asserts the row does not overflow, since a threshold set too low trades a hidden label
 * for clipped controls.
 */
export const NarrowControlRowCollapse: AppStory = {
  render: () => (
    <div data-testid="composer-width-wrapper" style={{ width: "min(900px, 100%)", height: 700 }}>
      <AppWithMocks
        setup={() => {
          collapseLeftSidebar();
          // Active Pro and fast modes exercise both compact selector status indicators while the
          // narrow-width assertions prove the row still sheds optional detail before overflowing.
          updatePersistedState(getModelKey("ws-composer-breakpoints"), "openai:gpt-5.6-sol");
          updatePersistedState(getReasoningModeKey("ws-composer-breakpoints"), "pro");
          return setupSimpleChatStory({
            workspaceId: "ws-composer-breakpoints",
            providersConfig: {
              openai: {
                apiKeySet: true,
                isEnabled: true,
                isConfigured: true,
                serviceTier: "priority",
              },
            },
            messages: [
              createUserMessage("msg-1", "Summarize the composer layout rules", {
                historySequence: 1,
              }),
              createAssistantMessage("msg-2", "The control row collapses in two stages.", {
                historySequence: 2,
                contextUsage: { inputTokens: 120_000, outputTokens: 8_000 },
              }),
            ],
          });
        }}
      />
    </div>
  ),
  parameters: {
    ...appMeta.parameters,
    pixel: PIXEL_DISABLED,
  },
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await waitForChatInputAutofocusDone(storyRoot);
    blurActiveElement();

    const wrapper = within(storyRoot).getByTestId("composer-width-wrapper");
    const agentTrigger = within(storyRoot).getByLabelText("Select agent");
    const contextTrigger = storyRoot.querySelector<HTMLElement>('[aria-label^="Context usage"]');
    if (!contextTrigger) throw new Error("Context usage control not rendered");

    const rowWidth = () => {
      const row = storyRoot.querySelector<HTMLElement>('[data-component="ComposerControlRow"]');
      if (!row) throw new Error("Composer control row not rendered");
      return row.getBoundingClientRect().width;
    };
    const meterVisible = () =>
      (storyRoot.querySelector("[data-context-usage-meter]")?.getBoundingClientRect().width ?? 0) >
      0;
    const proStatus = storyRoot.querySelector<HTMLElement>("[data-thinking-pro-status]");
    if (!proStatus) throw new Error("Active PRO status not rendered");
    const proVisible = () => proStatus.getBoundingClientRect().width > 0;
    const fastIndicator = storyRoot.querySelector<HTMLElement>("[data-fast-mode-indicator]");
    if (!fastIndicator) throw new Error("Active fast-mode indicator not rendered");
    const fastVisible = () => fastIndicator.getBoundingClientRect().width > 0;

    async function resizeRowInto(wrapperWidth: number, min: number, max: number) {
      wrapper.style.width = `${wrapperWidth}px`;
      await waitFor(() => {
        const width = rowWidth();
        if (width <= min || width >= max) {
          throw new Error(
            `Wrapper ${wrapperWidth}px put the control row at ${Math.round(width)}px, outside the ${min}-${max}px band this assertion needs`
          );
        }
      });
    }

    const assertNoOverflow = (stage: string) => {
      assertComposerPillGeometry(storyRoot);
      const row = storyRoot.querySelector<HTMLElement>('[data-component="ComposerControlRow"]');
      if (!row) throw new Error("Composer control row not rendered");
      if (row.scrollWidth > row.clientWidth) {
        throw new Error(
          `Row overflows by ${row.scrollWidth - row.clientWidth}px at the ${stage} stage`
        );
      }
    };

    const fullModelLabel = storyRoot.querySelector<HTMLElement>('[data-model-label="full"]');
    const compactModelLabel = storyRoot.querySelector<HTMLElement>('[data-model-label="compact"]');
    if (!fullModelLabel || !compactModelLabel) {
      throw new Error("Responsive model labels not rendered");
    }
    const assertCompactModelLabel = () => {
      if (fullModelLabel.getBoundingClientRect().width > 0) {
        throw new Error("Full GPT family label should hide on a constrained composer row");
      }
      if (compactModelLabel.getBoundingClientRect().width === 0) {
        throw new Error("Compact model tier should be visible on a constrained composer row");
      }
      if (compactModelLabel.innerText.trim() !== "Sol") {
        throw new Error(
          `Expected constrained GPT tier label "Sol", got "${compactModelLabel.innerText}"`
        );
      }
    };

    await resizeRowInto(400, 300, 341);
    await waitFor(() => {
      if (agentTrigger.innerText.trim() !== "") {
        throw new Error(`Agent pill should be icon-only, showing "${agentTrigger.innerText}"`);
      }
      if (!/^\d+%$/.test(contextTrigger.innerText.trim())) {
        throw new Error(
          `Context pill should be percentage-only, showing "${contextTrigger.innerText}"`
        );
      }
      if (meterVisible()) throw new Error("Context meter should be hidden on an icon-only row");
      if (proVisible()) throw new Error("PRO status should be hidden on the tightest row");
      if (!fastVisible()) throw new Error("Fast-mode lightning should stay visible on narrow rows");
      assertCompactModelLabel();
      assertNoOverflow("tightest");
    });

    await resizeRowInto(425, 344, 359);
    await waitFor(() => {
      if (agentTrigger.innerText.trim() !== "") {
        throw new Error(
          `Agent pill should still be icon-only at or below 360px, showing "${agentTrigger.innerText}"`
        );
      }
      if (!proVisible()) throw new Error("PRO status should return once the row clears 340px");
      assertCompactModelLabel();
      assertNoOverflow("pro-returns");
    });

    // Phone-width workspace rows land here. The agent label does not fit alongside the context pill
    // yet, so it must stay hidden rather than clip, and the model name must keep its own room.
    await resizeRowInto(474, 365, 445);
    await waitFor(() => {
      if (agentTrigger.innerText.trim() !== "") {
        throw new Error(
          `Agent pill should stay icon-only while the context pill shares the row, showing "${agentTrigger.innerText}"`
        );
      }
      assertNoOverflow("phone-width");
      assertCompactModelLabel();

      const modelName = storyRoot.querySelector<HTMLElement>(
        '[data-component="ModelSelectorGroup"] button span'
      );
      if (!modelName) throw new Error("Model name not rendered");
      if (modelName.scrollWidth > modelName.clientWidth) {
        throw new Error(
          `Model name is clipped to "${modelName.innerText}" at a phone-width row that has room for it`
        );
      }
    });

    await resizeRowInto(544, 455, 495);
    await waitFor(() => {
      if (agentTrigger.innerText.trim() === "") {
        throw new Error("Agent pill should show its label once the row clears 450px");
      }
      if (!/^\d+%$/.test(contextTrigger.innerText.trim())) {
        throw new Error(
          `Context pill should stay percentage-only at or below 500px, showing "${contextTrigger.innerText}"`
        );
      }
      if (meterVisible()) throw new Error("Context meter should stay hidden at or below 500px");
      if (!proVisible()) throw new Error("PRO status should stay visible above 340px");
      assertCompactModelLabel();
      assertNoOverflow("agent-label-returns");
    });

    await resizeRowInto(640, 505, 1200);
    await waitFor(() => {
      if (!/^\d+%$/.test(contextTrigger.innerText.trim())) {
        throw new Error(
          `Context control should keep its concise percentage label, showing "${contextTrigger.innerText}"`
        );
      }
      if (!meterVisible()) throw new Error("Context meter should be visible above 500px");
      assertNoOverflow("full-detail");
      if (fullModelLabel.getBoundingClientRect().width === 0) {
        throw new Error("Full model label should return once the composer row clears 500px");
      }
      if (compactModelLabel.getBoundingClientRect().width > 0) {
        throw new Error("Compact model label should hide once the full label has room");
      }

      // Checked here rather than on a narrow row because a narrow row is under flex-shrink pressure,
      // which trims a fixed width down to roughly its content width and hides the difference. With
      // slack available, a fixed width sits at its full cap while a content-sized one does not.
      const modelTrigger = storyRoot.querySelector<HTMLElement>(
        '[data-component="ModelSelectorGroup"] button'
      );
      if (!modelTrigger) throw new Error("Model trigger not rendered");
      const triggerWidth = modelTrigger.getBoundingClientRect().width;
      const capPx = 8 * parseFloat(getComputedStyle(document.documentElement).fontSize);
      if (triggerWidth >= capPx - 8) {
        throw new Error(
          `Model trigger reserves ${Math.round(triggerWidth)}px of its ${Math.round(capPx)}px cap for a short name instead of sizing to content`
        );
      }
    });
  },
};

function assertComposerPillGeometry(
  storyRoot: HTMLElement,
  touch = window.matchMedia("(max-width: 768px) and (pointer: coarse)").matches
) {
  const row = storyRoot.querySelector<HTMLElement>('[data-component="ComposerControlRow"]');
  const group = storyRoot.querySelector<HTMLElement>('[data-component="ModelSelectorGroup"]');
  if (!row || !group) throw new Error("Composer controls not rendered");
  const groupBounds = group.getBoundingClientRect();
  const rowBounds = row.getBoundingClientRect();
  const pills = [
    within(row).getByLabelText("Select agent"),
    within(row).getByRole("button", { name: /^Context usage/ }),
    group,
  ];
  for (const pill of pills) {
    const bounds = pill.getBoundingClientRect();
    if (bounds.width === 0) continue;
    for (const edge of ["height", "top", "bottom"] as const) {
      if (Math.abs(bounds[edge] - groupBounds[edge]) > 0.5) {
        throw new Error(
          `Composer pill ${edge} is ${bounds[edge]}px; model/thinking pill is ${groupBounds[edge]}px`
        );
      }
    }
    if (bounds.left < rowBounds.left - 0.5 || bounds.right > rowBounds.right + 0.5) {
      throw new Error("Composer pill extends outside its row");
    }
  }
  for (const button of row.querySelectorAll("button")) {
    const bounds = button.getBoundingClientRect();
    if (bounds.width === 0) continue;
    if (
      touch &&
      (bounds.height < MOBILE_TOUCH_TARGET_PX || bounds.width < MOBILE_TOUCH_TARGET_PX)
    ) {
      throw new Error("Composer button lost its minimum touch target");
    }
    if (
      group.contains(button) &&
      (bounds.top < groupBounds.top - 0.5 || bounds.bottom > groupBounds.bottom + 0.5)
    ) {
      throw new Error("Model/thinking button extends outside its pill");
    }
  }
}

export const ComposerPillHeights: AppStory = {
  render: NarrowControlRowCollapse.render,
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: {
    ...appMeta.parameters,
    pixel: { matrix: { viewports: ["phone", "laptop"] } },
  },
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await waitForChatInputAutofocusDone(storyRoot);
    blurActiveElement();
    await waitFor(() => assertComposerPillGeometry(storyRoot));

    // Pixel and the test-runner do not emulate coarse pointers.
    const wrapper = within(storyRoot).getByTestId("composer-width-wrapper");
    const originalWidth = wrapper.style.width;
    const touchFloor = document.createElement("style");
    touchFloor.textContent = `[data-component="ComposerControlRow"] button { min-height: ${MOBILE_TOUCH_TARGET_PX}px; min-width: ${MOBILE_TOUCH_TARGET_PX}px; }`;
    document.head.append(touchFloor);
    wrapper.style.width = "390px";
    try {
      await waitFor(() => assertComposerPillGeometry(storyRoot, true));
    } finally {
      touchFloor.remove();
      wrapper.style.width = originalWidth;
    }
  },
};

/**
 * Editing message state - shows the edit cutoff barrier and amber-styled input.
 * Demonstrates the UI when a user clicks "Edit" on a previous message.
 */
export const EditingMessage: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-editing";

        // Ensure a deterministic starting state (Storybook can preserve localStorage
        // across story runs in the same session).
        setWorkspaceInput(workspaceId, "");

        return setupSimpleChatStory({
          workspaceId,
          messages: [
            createUserMessage("msg-1", "Add authentication to the user API endpoint", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage(
              "msg-2",
              "I'll help you add authentication. Let me check the current implementation and add JWT validation.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 290000,
                toolCalls: [
                  createFileReadTool(
                    "call-1",
                    "src/api/users.ts",
                    "export function getUser(req, res) {\n  const user = db.users.find(req.params.id);\n  res.json(user);\n}"
                  ),
                ],
              }
            ),
            createUserMessage("msg-3", "Actually, can you use a different approach?", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 280000,
            }),
            createAssistantMessage(
              "msg-4",
              "Of course! I can use a different authentication approach. What would you prefer?",
              {
                historySequence: 4,
                timestamp: STABLE_TIMESTAMP - 270000,
              }
            ),
          ],
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    const canvas = within(storyRoot);

    // Wait for user message actions to render (Edit buttons only appear on user messages)
    const editButtons = await canvas.findAllByLabelText("Edit", {}, { timeout: 10000 });
    if (editButtons.length === 0) throw new Error("No edit buttons found");

    // Click edit on the first user message
    await userEvent.click(editButtons[0]);

    // Wait for the editing state to be applied
    await waitFor(() => {
      canvas.getByLabelText("Edit your last message");
      const surface = storyRoot.querySelector('[data-component="ChatInputSurface"]');
      if (!surface?.classList.contains("border-editing-mode")) {
        throw new Error("Composer surface not in editing state");
      }
    });

    // Verify the edit cutoff barrier appears
    await canvas.findByText("Messages below will be removed when you submit");
  },
  parameters: {
    docs: {
      description: {
        story:
          "Shows the editing message state with the amber-styled input border and edit cutoff barrier indicating messages that will be removed.",
      },
    },
  },
};

const DOCK_ALIGNMENT_MESSAGES = [
  createUserMessage("msg-1", "Widen the transcript and check the composer edges", {
    historySequence: 1,
  }),
  createAssistantMessage("msg-2", "The composer should span the same column.", {
    historySequence: 2,
    // 64% of the default model's 1M window: past the auto-compaction warning point (threshold 70
    // minus a 10 point advance) without reaching force-compaction. The warning is one of the
    // surfaces wrapped in ChatDockSurface rather than in a decoration of its own.
    contextUsage: { inputTokens: 640_000, outputTokens: 4_000 },
  }),
];

// Renders a ChatInputDecoration, so the assertions cover a decoration and not only the composer.
const DOCK_ALIGNMENT_BACKGROUND_PROCESS = {
  id: "bash_1",
  pid: 4242,
  script: "npm run dev",
  displayName: "Dev Server",
  startTime: STABLE_TIMESTAMP,
  status: "running" as const,
};

function setupDockAlignmentStory(fullWidth: boolean) {
  collapseLeftSidebar();
  return setupSimpleChatStory({
    workspaceId: fullWidth ? "ws-dock-align-full" : "ws-dock-align-centered",
    messages: DOCK_ALIGNMENT_MESSAGES,
    backgroundProcesses: [DOCK_ALIGNMENT_BACKGROUND_PROCESS],
    chatTranscriptFullWidth: fullWidth,
  });
}

/**
 * Asserts every surface in the composer dock shares the transcript column's left and right edges.
 * The dock cancels the transcript scrollport's gutter to paint full-bleed, so each surface inside it
 * has to re-apply that gutter and follow the transcript's width mode.
 */
async function assertDockSurfacesMatchTranscript(
  storyRoot: HTMLElement,
  expectation: "capped" | "full-width"
) {
  const transcript = storyRoot.querySelector<HTMLElement>('[aria-label="Conversation transcript"]');
  if (!transcript) throw new Error("Transcript column not rendered");
  const scrollport = transcript.parentElement;
  if (!scrollport) throw new Error("Transcript scrollport not rendered");

  const surfaces: Array<[string, HTMLElement]> = [];
  const addSurface = (label: string, selector: string) => {
    const element = storyRoot.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`Docked ${label} not rendered`);
    surfaces.push([label, element]);
  };
  addSurface("composer", '[data-component="ChatInputSurface"]');
  addSurface("decoration", '[data-component="ChatInputDecorationStack"] button');
  const wrapped = storyRoot.querySelectorAll<HTMLElement>('[data-component="ChatDockSurface"]');
  if (wrapped.length === 0) throw new Error("No ChatDockSurface-wrapped entry rendered");
  wrapped.forEach((element, index) => surfaces.push([`wrapped surface ${index}`, element]));

  await waitFor(() => {
    const column = transcript.getBoundingClientRect();
    const available = scrollport.clientWidth;
    if (expectation === "full-width") {
      // Docked surfaces used to hardcode the same 4xl cap the centered column uses, so below that
      // width they line up regardless and the regression would pass unnoticed.
      if (column.width <= CENTERED_COLUMN_MAX_WIDTH_PX) {
        throw new Error(
          `Transcript is ${Math.round(column.width)}px wide, so this story is not in full-width mode`
        );
      }
    } else {
      if (available <= CENTERED_COLUMN_MAX_WIDTH_PX) {
        throw new Error(
          `Scrollport is only ${available}px wide, so the centered cap is not what limits the column`
        );
      }
      if (Math.round(column.width) !== CENTERED_COLUMN_MAX_WIDTH_PX) {
        throw new Error(
          `Centered transcript should stop at the cap, measured ${Math.round(column.width)}px`
        );
      }
    }

    for (const [label, element] of surfaces) {
      const bounds = element.getBoundingClientRect();
      const leftGap = Math.round(bounds.left - column.left);
      const rightGap = Math.round(column.right - bounds.right);
      if (leftGap !== 0 || rightGap !== 0) {
        throw new Error(
          `Docked ${label} is inset from the transcript column by ${leftGap}px left and ${rightGap}px right`
        );
      }
    }
  });
}

export const FullWidthTranscriptAlignment: AppStory = {
  render: () => <AppWithMocks setup={() => setupDockAlignmentStory(true)} />,
  parameters: {
    ...appMeta.parameters,
    pixel: PIXEL_DISABLED,
  },
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await waitForChatInputAutofocusDone(storyRoot);
    blurActiveElement();

    await assertDockSurfacesMatchTranscript(storyRoot, "full-width");
  },
};

export const CenteredTranscriptAlignment: AppStory = {
  render: () => <AppWithMocks setup={() => setupDockAlignmentStory(false)} />,
  parameters: {
    ...appMeta.parameters,
    pixel: PIXEL_DISABLED,
  },
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await waitForChatInputAutofocusDone(storyRoot);
    blurActiveElement();

    await assertDockSurfacesMatchTranscript(storyRoot, "capped");
  },
};
