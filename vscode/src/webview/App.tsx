import React, { useEffect, useMemo, useRef, useState } from "react";

import { Pencil } from "lucide-react";

import type { WorkspaceChatMessage } from "xum/common/orpc/types";
import type { DisplayedMessage } from "xum/common/types/message";
import { createClient } from "xum/common/orpc/client";

import { ProviderOptionsProvider } from "xum/browser/contexts/ProviderOptionsContext";
import { SettingsProvider } from "xum/browser/contexts/SettingsContext";
import { APIProvider } from "xum/browser/contexts/API";
import { ThemeProvider } from "xum/browser/contexts/ThemeContext";
import { ChatHostContextProvider } from "xum/browser/contexts/ChatHostContext";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "xum/browser/components/Tooltip/Tooltip";
import { Button } from "xum/browser/components/Button/Button";
import { matchesKeybind, KEYBINDS } from "xum/browser/utils/ui/keybinds";
import { readPersistedState } from "xum/browser/hooks/usePersistedState";
import { VIM_ENABLED_KEY } from "xum/common/constants/storage";
import { useAutoScroll } from "xum/browser/hooks/useAutoScroll";
import { applyWorkspaceChatEventToAggregator } from "xum/browser/utils/messages/applyWorkspaceChatEventToAggregator";
import { StreamingMessageAggregator } from "xum/browser/utils/messages/StreamingMessageAggregator";

import type { ExtensionToWebviewMessage, UiConnectionStatus, UiWorkspace } from "./protocol";
import { WorkspacePicker } from "./WorkspacePicker";
import { ChatComposer } from "./ChatComposer";
import { VSCODE_CHAT_UI_SUPPORT } from "./chatUiCapabilities";
import { VscodeStreamingBarrier } from "./StreamingBarrier";
import { DisplayedMessageRenderer } from "./DisplayedMessageRenderer";
import { CHAT_BUFFER_LIMITS } from "./config";
import { createVscodeOrpcLink } from "./createVscodeOrpcLink";
import type { VscodeBridge } from "./vscodeBridge";

interface Notice {
  id: string;
  level: "info" | "error";
  message: string;
}

const VSCODE_CHAT_HOST_CONTEXT_VALUE = {
  uiSupport: VSCODE_CHAT_UI_SUPPORT,
  actions: {},
} as const;

const MAX_BUFFERED_HISTORICAL_MESSAGES = CHAT_BUFFER_LIMITS.MAX_HISTORICAL_MESSAGES;
const MAX_BUFFERED_STREAM_EVENTS = CHAT_BUFFER_LIMITS.MAX_STREAM_EVENTS;

interface ChatReplayState {
  workspaceId: string;
  caughtUp: boolean;
  historicalMessages: Extract<WorkspaceChatMessage, { type: "message" }>[];
  pendingStreamEvents: WorkspaceChatMessage[];
  didWarnBufferOverflow: boolean;
}

function createChatReplayState(workspaceId: string): ChatReplayState {
  return {
    workspaceId,
    caughtUp: false,
    historicalMessages: [],
    pendingStreamEvents: [],
    didWarnBufferOverflow: false,
  };
}

function shouldBufferUntilCaughtUp(event: WorkspaceChatMessage): boolean {
  switch (event.type) {
    case "stream-start":
    case "stream-delta":
    case "stream-end":
    case "stream-abort":
    case "tool-call-start":
    case "tool-call-delta":
    case "tool-call-end":
    case "reasoning-delta":
    case "reasoning-end":
    case "usage-delta":
    case "session-usage-delta":
    case "init-start":
    case "init-output":
    case "init-end":
      return true;
    default:
      return false;
  }
}
function pickWorkspaceCreatedAt(workspace: UiWorkspace | undefined): string {
  // StreamingMessageAggregator expects a timestamp string (backend contract: always present).
  // Default to epoch to preserve stable ordering if we ever get legacy workspace metadata.
  return workspace?.createdAt ?? new Date(0).toISOString();
}

export function App(props: { bridge: VscodeBridge }): JSX.Element {
  const bridge = props.bridge;

  const apiClient = useMemo(() => {
    const link = createVscodeOrpcLink(bridge);
    return createClient(link);
  }, [bridge]);

  const [connectionStatus, setConnectionStatus] = useState<UiConnectionStatus | null>(null);
  const [workspaces, setWorkspaces] = useState<UiWorkspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);

  const activeWorkspaceIdRef = useRef<string | null>(null);
  activeWorkspaceIdRef.current = selectedWorkspaceId;

  const chatReplayStateRef = useRef<ChatReplayState | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);

  const aggregatorRef = useRef<StreamingMessageAggregator | null>(null);
  const [displayedMessages, setDisplayedMessages] = useState<DisplayedMessage[]>([]);
  const workspacesRef = useRef<UiWorkspace[]>([]);

  const scheduledRenderRef = useRef<{ kind: "raf" | "timeout"; id: number } | null>(null);
  const isRenderScheduledRef = useRef(false);

  const cancelScheduledRender = () => {
    const handle = scheduledRenderRef.current;
    if (!handle) {
      return;
    }

    if (handle.kind === "raf") {
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(handle.id);
      }
    } else {
      clearTimeout(handle.id);
    }

    scheduledRenderRef.current = null;
    isRenderScheduledRef.current = false;
  };

  const flushDisplayedMessages = () => {
    cancelScheduledRender();

    const aggregator = aggregatorRef.current;
    if (!aggregator) {
      return;
    }

    setDisplayedMessages(aggregator.getDisplayedMessages());
  };

  const flushDisplayedMessagesRef = useRef(flushDisplayedMessages);
  flushDisplayedMessagesRef.current = flushDisplayedMessages;
  const scheduleDisplayedMessages = () => {
    if (isRenderScheduledRef.current) {
      return;
    }

    isRenderScheduledRef.current = true;

    const run = () => {
      isRenderScheduledRef.current = false;
      scheduledRenderRef.current = null;

      const aggregator = aggregatorRef.current;
      if (!aggregator) {
        return;
      }

      setDisplayedMessages(aggregator.getDisplayedMessages());
    };

    if (typeof requestAnimationFrame === "function") {
      const id = requestAnimationFrame(run);
      scheduledRenderRef.current = { kind: "raf", id };
      return;
    }

    const id = window.setTimeout(run, 0);
    scheduledRenderRef.current = { kind: "timeout", id };
  };

  const { contentRef, innerRef, handleScroll, markUserInteraction, jumpToBottom } = useAutoScroll();

  const jumpToBottomRef = useRef(jumpToBottom);
  jumpToBottomRef.current = jumpToBottom;

  // Keep a stable monotonic counter for notice IDs.
  const noticeSeqRef = useRef(0);

  const pushNotice = (notice: { level: Notice["level"]; message: string }) => {
    noticeSeqRef.current += 1;
    const id = `notice-${noticeSeqRef.current}`;
    setNotices((prev) => [...prev, { id, level: notice.level, message: notice.message }]);
  };

  const pushNoticeRef = useRef(pushNotice);
  pushNoticeRef.current = pushNotice;

  const canChat = Boolean(connectionStatus?.mode === "api" && selectedWorkspaceId);

  useEffect(() => {
    const unsubscribe = bridge.onMessage((raw) => {
      if (!raw || typeof raw !== "object" || !("type" in raw)) {
        return;
      }

      const type = (raw as { type?: unknown }).type;
      if (typeof type !== "string") {
        return;
      }

      const msg = raw as ExtensionToWebviewMessage;

      switch (msg.type) {
        case "connectionStatus":
          setConnectionStatus(msg.status);
          return;
        case "workspaces":
          workspacesRef.current = msg.workspaces;
          setWorkspaces(msg.workspaces);
          return;
        case "setSelectedWorkspace": {
          activeWorkspaceIdRef.current = msg.workspaceId;
          setSelectedWorkspaceId(msg.workspaceId);

          // The webview retains React state when hidden, so always clear the transcript when
          // switching workspaces (avoids showing stale messages for a new selection).
          cancelScheduledRender();
          aggregatorRef.current = null;
          chatReplayStateRef.current = msg.workspaceId
            ? createChatReplayState(msg.workspaceId)
            : null;
          setDisplayedMessages([]);
          setNotices([]);

          return;
        }
        case "chatReset": {
          const activeWorkspaceId = activeWorkspaceIdRef.current;
          if (activeWorkspaceId && activeWorkspaceId !== msg.workspaceId) {
            return;
          }

          activeWorkspaceIdRef.current = msg.workspaceId;
          cancelScheduledRender();
          const workspace = workspacesRef.current.find((w) => w.id === msg.workspaceId);
          const createdAt = pickWorkspaceCreatedAt(workspace);
          aggregatorRef.current = new StreamingMessageAggregator(
            createdAt,
            msg.workspaceId,
            workspace?.unarchivedAt
          );
          chatReplayStateRef.current = createChatReplayState(msg.workspaceId);
          setDisplayedMessages([]);
          setNotices([]);
          jumpToBottomRef.current();
          return;
        }
        case "chatEvent": {
          const activeWorkspaceId = activeWorkspaceIdRef.current;
          if (activeWorkspaceId && activeWorkspaceId !== msg.workspaceId) {
            return;
          }

          try {
            if (!aggregatorRef.current) {
              const workspace = workspacesRef.current.find((w) => w.id === msg.workspaceId);
              const createdAt = pickWorkspaceCreatedAt(workspace);
              aggregatorRef.current = new StreamingMessageAggregator(
                createdAt,
                msg.workspaceId,
                workspace?.unarchivedAt
              );
            }

            const aggregator = aggregatorRef.current;
            if (!aggregator) {
              return;
            }

            let replayState = chatReplayStateRef.current;
            if (!replayState || replayState.workspaceId !== msg.workspaceId) {
              replayState = createChatReplayState(msg.workspaceId);
              chatReplayStateRef.current = replayState;
            }

            const flushReplayBuffer = () => {
              const hasActiveStream = replayState.pendingStreamEvents.some(
                (bufferedEvent) => bufferedEvent.type === "stream-start"
              );

              if (replayState.historicalMessages.length > 0) {
                aggregator.loadHistoricalMessages(replayState.historicalMessages, hasActiveStream);
                replayState.historicalMessages.length = 0;
              }

              for (const bufferedEvent of replayState.pendingStreamEvents) {
                applyWorkspaceChatEventToAggregator(aggregator, bufferedEvent);
              }
              replayState.pendingStreamEvents.length = 0;

              replayState.caughtUp = true;
              flushDisplayedMessages();
            };

            const forceCatchUp = () => {
              if (
                replayState.caughtUp ||
                (replayState.historicalMessages.length <= MAX_BUFFERED_HISTORICAL_MESSAGES &&
                  replayState.pendingStreamEvents.length <= MAX_BUFFERED_STREAM_EVENTS)
              ) {
                return;
              }

              if (!replayState.didWarnBufferOverflow) {
                replayState.didWarnBufferOverflow = true;

                bridge.debugLog("chat replay buffer overflow; forcing caught-up", {
                  workspaceId: replayState.workspaceId,
                  historicalMessages: replayState.historicalMessages.length,
                  pendingStreamEvents: replayState.pendingStreamEvents.length,
                });

                pushNotice({
                  level: "error",
                  message:
                    "Xum chat did not finish loading (missing caught-up). Showing a partial transcript; try Refresh if messages look incomplete.",
                });
              }

              flushReplayBuffer();
            };
            const event = msg.event;

            if (event.type === "caught-up") {
              flushReplayBuffer();
              return;
            }

            if (!replayState.caughtUp) {
              if (event.type === "message") {
                replayState.historicalMessages.push(event);
                forceCatchUp();
                return;
              }

              if (shouldBufferUntilCaughtUp(event)) {
                replayState.pendingStreamEvents.push(event);
                forceCatchUp();
                return;
              }
            }

            const hint = applyWorkspaceChatEventToAggregator(aggregator, event);

            if (hint === "ignored") {
              return;
            }

            if (hint === "throttled") {
              scheduleDisplayedMessages();
              return;
            }

            flushDisplayedMessages();
          } catch (error) {
            const message = `Chat event handling error: ${error instanceof Error ? error.message : String(error)}`;
            bridge.debugLog("chatEvent processing failed", {
              error: String(error),
              event: msg.event,
            });
            pushNotice({ level: "error", message });
          }

          return;
        }
        case "uiNotice": {
          pushNotice({ level: msg.level, message: msg.message });
          return;
        }
        case "debugProbe":
          bridge.debugLog("debugProbe", msg);
          return;

        case "orpcResponse":
        case "orpcStreamData":
        case "orpcStreamEnd":
        case "orpcStreamError":
          // ORPC messages are handled by the ORPC link.
          return;

        default: {
          const _exhaustive: never = msg;
          bridge.debugLog("unhandled extension message", raw);
          return;
        }
      }
    });

    bridge.postMessage({ type: "ready" });

    return () => {
      cancelScheduledRender();
      unsubscribe();
    };
    // Only depend on the bridge instance; other state is read via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!canChat || !selectedWorkspaceId) {
        return;
      }

      const aggregator = aggregatorRef.current;
      if (!aggregator) {
        return;
      }

      const vimEnabled = readPersistedState(VIM_ENABLED_KEY, false);
      const interruptKeybind = vimEnabled
        ? KEYBINDS.INTERRUPT_STREAM_VIM
        : KEYBINDS.INTERRUPT_STREAM_NORMAL;

      if (!matchesKeybind(e, interruptKeybind)) {
        return;
      }

      // ask_user_question is a special waiting state: don't interrupt it with Esc/Ctrl+C.
      // Users can still respond by typing and sending a message.
      if (aggregator.hasAwaitingUserQuestion()) {
        return;
      }

      if (!aggregator.getActiveStreamMessageId()) {
        return;
      }

      e.preventDefault();

      aggregator.setInterrupting();
      flushDisplayedMessagesRef.current();

      apiClient.workspace.interruptStream({ workspaceId: selectedWorkspaceId }).catch((error) => {
        bridge.debugLog("interruptStream failed", { error: String(error) });

        pushNoticeRef.current({
          level: "error",
          message: `Failed to interrupt stream. (${error instanceof Error ? error.message : String(error)})`,
        });
      });
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [apiClient, bridge, canChat, selectedWorkspaceId]);

  const requestRefreshWorkspaces = () => {
    bridge.postMessage({ type: "refreshWorkspaces" });
  };

  const onOpenWorkspace = () => {
    if (!selectedWorkspaceId) {
      return;
    }

    bridge.postMessage({ type: "openWorkspace", workspaceId: selectedWorkspaceId });
  };

  return (
    <ChatHostContextProvider value={VSCODE_CHAT_HOST_CONTEXT_VALUE}>
      <APIProvider client={apiClient}>
        <SettingsProvider>
          <ProviderOptionsProvider>
            <ThemeProvider forcedTheme="dark">
              <TooltipProvider>
                <div className="flex h-screen flex-col">
                  <div className="border-b border-border bg-background-secondary p-3">
                    <div className="flex items-center gap-2">
                      <WorkspacePicker
                        workspaces={workspaces}
                        selectedWorkspaceId={selectedWorkspaceId}
                        onSelectWorkspace={(workspaceId) => {
                          bridge.postMessage({ type: "selectWorkspace", workspaceId });
                        }}
                        onRequestRefresh={requestRefreshWorkspaces}
                      />

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            className="inline-flex shrink-0 items-center rounded border border-border-light bg-background px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted"
                            aria-label="Preview feature"
                          >
                            Preview
                          </span>
                        </TooltipTrigger>
                        <TooltipContent align="center">
                          Preview feature — under active development; may contain bugs.
                        </TooltipContent>
                      </Tooltip>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={onOpenWorkspace}
                            disabled={!selectedWorkspaceId}
                            aria-label="Open workspace"
                            className="text-muted hover:text-foreground h-8 w-8 shrink-0"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent align="center">Open workspace</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>

                  <div
                    ref={contentRef}
                    className="flex-1 overflow-y-auto p-3"
                    onScroll={handleScroll}
                    onWheel={markUserInteraction}
                    onMouseDown={markUserInteraction}
                    onTouchStart={markUserInteraction}
                  >
                    <div ref={innerRef}>
                      {selectedWorkspaceId ? (
                        <>
                          {displayedMessages.map((msg) => (
                            <DisplayedMessageRenderer
                              key={msg.id}
                              message={msg}
                              workspaceId={selectedWorkspaceId}
                            />
                          ))}
                          <VscodeStreamingBarrier
                            workspaceId={selectedWorkspaceId}
                            aggregator={aggregatorRef.current}
                            className="mt-3"
                          />
                        </>
                      ) : null}

                      {notices.map((notice) => (
                        <div
                          key={notice.id}
                          className={
                            notice.level === "error"
                              ? "mt-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200"
                              : "mt-3 rounded-md border border-border-medium bg-background-secondary px-3 py-2 text-sm"
                          }
                        >
                          {notice.message}
                        </div>
                      ))}

                      {!selectedWorkspaceId && notices.length === 0 ? (
                        <div className="text-muted text-sm">
                          Select a Xum workspace to view messages.
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="border-t border-border bg-background-secondary p-3">
                    {selectedWorkspaceId ? (
                      <ChatComposer
                        key={selectedWorkspaceId}
                        workspaceId={selectedWorkspaceId}
                        disabled={!canChat}
                        disabledReason={
                          canChat ? undefined : "Chat requires Xum server connection."
                        }
                        aggregator={aggregatorRef.current}
                        onSendComplete={jumpToBottom}
                        onNotice={pushNotice}
                      />
                    ) : (
                      <div className="text-muted text-sm">Select a Xum workspace to chat.</div>
                    )}
                  </div>
                </div>
              </TooltipProvider>
            </ThemeProvider>
          </ProviderOptionsProvider>
        </SettingsProvider>
      </APIProvider>
    </ChatHostContextProvider>
  );
}
