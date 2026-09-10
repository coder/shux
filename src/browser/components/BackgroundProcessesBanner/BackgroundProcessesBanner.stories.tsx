import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import { setupSimpleChatStory } from "@/browser/stories/helpers/chatSetup";
import { createAssistantMessage, createUserMessage } from "@/browser/stories/mocks/messages";
import { createTerminalTool } from "@/browser/stories/mocks/tools";
import { STABLE_TIMESTAMP } from "@/browser/stories/mocks/workspaces";

const meta = {
  ...appMeta,
  title: "App/Chat/Components/BackgroundProcesses",
};

export default meta;

/** Chat with running background processes banner */
export const BackgroundProcesses: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Start the dev server and run tests in background", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 60000,
            }),
            createAssistantMessage(
              "msg-2",
              "I've started the dev server and test runner in the background. You can continue working while they run.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 50000,
                toolCalls: [
                  createTerminalTool(
                    "call-1",
                    "npm run dev &",
                    "Starting dev server on port 3000..."
                  ),
                  createTerminalTool("call-2", "npm test -- --watch &", "Running test suite..."),
                ],
              }
            ),
          ],
          backgroundProcesses: [
            {
              id: "bash_1",
              pid: 12345,
              // Multi-line script: exercises the dialog's capped command block
              // together with tall output at small window heights.
              script:
                "export NODE_ENV=development\nexport PORT=3000\nnpm run dev -- --host 0.0.0.0 --port $PORT",
              displayName: "Dev Server",
              startTime: Date.now() - 45000, // 45 seconds ago
              monitor: {
                filter: "FAILED|ERROR",
                filter_exclude: false,
                cooldown_ms: 1000,
                max_events: 3,
                totalMatches: 2,
                droppedLines: 0,
                lastLines: ["ERROR database unavailable", "FAILED health check"],
                stopped: false,
              },
              status: "running",
            },
            {
              id: "bash_2",
              pid: 12346,
              script: "npm test -- --watch",
              displayName: "Test Runner",
              startTime: Date.now() - 30000, // 30 seconds ago
              status: "running",
            },
            {
              id: "bash_3",
              pid: 12347,
              script: "tail -f /var/log/app.log",
              startTime: Date.now() - 120000, // 2 minutes ago
              status: "running",
            },
          ],
        })
      }
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Shows the background processes banner when there are running background bash processes. Click the banner to expand and see process details or terminate them.",
      },
    },
  },
};

/**
 * A one-shot watcher matched its monitor filter and exited, but the synthetic wake turn
 * has not been delivered yet. The banner must keep the process visible with a pending
 * indicator instead of vanishing (which previously looked like a lost wake).
 */
export const MonitorWakePendingAfterExit: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Watch the PR checks and wake me when they finish", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 60000,
            }),
            createAssistantMessage(
              "msg-2",
              "I've started a background watcher that prints WAKE: when the checks finish.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 50000,
                toolCalls: [
                  createTerminalTool("call-1", "./watch_pr_checks.sh", "Watching PR checks..."),
                ],
              }
            ),
          ],
          backgroundProcesses: [
            {
              id: "bash_watcher",
              pid: 22345,
              script: "./watch_pr_checks.sh",
              displayName: "PR Checks Watcher",
              startTime: Date.now() - 90000,
              monitor: {
                filter: "WAKE:",
                filter_exclude: false,
                cooldown_ms: 1000,
                totalMatches: 1,
                droppedLines: 0,
                lastLines: ["WAKE: all checks green"],
                stopped: true,
                pendingWakeKind: "match",
              },
              status: "exited",
              exitCode: 0,
            },
          ],
        })
      }
    />
  ),
  // The waking indicator sits on its own non-truncating line specifically so narrow
  // rows cannot ellipsize it away; snapshot the phone width (alongside desktop) so the
  // guarded condition is actually exercised.
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: {
    pixel: {
      matrix: { viewports: ["phone", "desktop"] },
    },
    docs: {
      description: {
        story:
          "A one-shot watcher matched and exited while its monitor wake is still pending delivery. The banner stays visible with a 'waking agent' indicator, no live duration, and no terminate button.",
      },
    },
  },
};

export const MonitorLostWakePendingAfterRestart: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Watch the PR checks and wake me when they finish", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 60000,
            }),
          ],
          backgroundProcesses: [
            // Synthesized from a durable pending monitor-lost wake after restart: no live
            // process (pid 0), so no pid line, no output action, and "monitor lost" wording
            // instead of claiming a match.
            {
              id: "bash_watcher",
              pid: 0,
              script: "./watch_pr_checks.sh",
              displayName: "PR Checks Watcher",
              synthesized: true,
              startTime: Date.now() - 90000,
              monitor: {
                filter: "WAKE:",
                filter_exclude: false,
                cooldown_ms: 0,
                totalMatches: 0,
                droppedLines: 0,
                lastLines: [],
                stopped: true,
                pendingWakeKind: "monitor-lost",
              },
              status: "exited",
            },
          ],
        })
      }
    />
  ),
  // Same phone-width coverage as MonitorWakePendingAfterExit: the lost-monitor label
  // must stay visible on narrow rows too.
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: {
    pixel: {
      matrix: { viewports: ["phone", "desktop"] },
    },
    docs: {
      description: {
        story:
          "An app restart terminated an armed watcher; its durable monitor-lost wake is still pending delivery. The synthesized row shows 'monitor lost' wording with no pid, duration, output, or terminate affordances.",
      },
    },
  },
};
