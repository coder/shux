import { useEffect, useRef, useState } from "react";
import type { MobileClient } from "./api";
import {
  applyChatEvent,
  createTranscriptState,
  resumeTranscriptState,
  type WorkspaceChatMessage,
} from "./transcript";
import { watch, watchServerChanges } from "./streams";
import {
  MOBILE_STREAM_DISPLAY_BATCH_MS,
  MOBILE_STREAM_MAX_PENDING_DELTAS,
} from "../../../src/constants/streaming";
import type { SettingsData } from "./settings";
import type { RestoredInput } from "./draft";
import { linkedAbortController } from "./useConnection";

export function useConversation(
  client: MobileClient,
  workspaceId: string,
  signal: AbortSignal,
  onRestore?: (event: RestoredInput) => void
) {
  const restore = useRef(onRestore);
  useEffect(() => {
    restore.current = onRestore;
  }, [onRestore]);
  const [transcript, setTranscript] = useState(createTranscriptState);
  const [settings, setSettings] = useState<Omit<SettingsData, "policy"> | null>(null);
  const [policy, setPolicy] = useState<SettingsData["policy"]>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [owner, setOwner] = useState(() => ({ client, workspaceId, signal }));
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const displayBatch = useRef<{ take: () => WorkspaceChatMessage[] } | null>(null);
  const historyRequest = useRef<AbortController | null>(null);
  type HistoryCursor = NonNullable<
    Parameters<MobileClient["workspace"]["history"]["loadMore"]>[0]["cursor"]
  >;
  const historyCursor = useRef<HistoryCursor | null>(null);
  useEffect(() => {
    const controller = linkedAbortController(signal);
    setTranscript(createTranscriptState());
    setSettings(null);
    setPolicy(null);
    setError(null);
    setSettingsError(null);
    setOwner({ client, workspaceId, signal });
    setLoadingOlder(false);
    setHistoryError(null);
    historyCursor.current = null;
    if (signal.aborted) return;
    let pendingDeltas: WorkspaceChatMessage[] = [];
    let displayTimer: ReturnType<typeof setTimeout> | null = null;
    const take = () => {
      if (displayTimer !== null) clearTimeout(displayTimer);
      displayTimer = null;
      const events = pendingDeltas;
      pendingDeltas = [];
      return events;
    };
    const batch = { take };
    displayBatch.current = batch;
    const flush = (event?: WorkspaceChatMessage) => {
      const events = take();
      if (event) events.push(event);
      if (!controller.signal.aborted && events.length > 0)
        setTranscript((current) => events.reduce(applyChatEvent, current));
    };
    controller.signal.addEventListener(
      "abort",
      () => {
        take();
        if (displayBatch.current === batch) displayBatch.current = null;
      },
      { once: true }
    );

    let policyRequest: AbortController | null = null;
    function refreshPolicy() {
      // A notification or a fresh subscription invalidates the old snapshot immediately;
      // only the newest read may publish. Failures stay closed until the next change.
      policyRequest?.abort();
      const request = linkedAbortController(controller.signal);
      policyRequest = request;
      setPolicy(null);
      client.policy
        .get(undefined, { signal: request.signal })
        .then(
          (next) => {
            if (!request.signal.aborted) setPolicy(next);
          },
          () => undefined
        )
        .finally(() => request.abort());
    }
    let settingsRequest: AbortController | null = null;
    function refreshSettings() {
      settingsRequest?.abort();
      const request = linkedAbortController(controller.signal);
      settingsRequest = request;
      // A notification invalidates the old privacy options immediately. Consume
      // further notifications while reading, so an older snapshot cannot win.
      setSettings(null);
      setSettingsError(null);
      Promise.all([
        client.config.getConfig(undefined, { signal: request.signal }),
        client.agents.list({ workspaceId }, { signal: request.signal }),
        client.providers.getConfig(undefined, { signal: request.signal }),
      ])
        .then(
          ([config, agents, providers]) => {
            if (!request.signal.aborted) setSettings({ config, providers, agents });
          },
          () => {
            if (!request.signal.aborted)
              setSettingsError("Settings unavailable. Retry to reconnect.");
          }
        )
        .finally(() => request.abort());
    }
    function settingsUnavailable() {
      settingsRequest?.abort();
      setSettings(null);
      setSettingsError("Settings unavailable. Retry to reconnect.");
    }
    // The change stream is registered before any snapshot is read, and a reopened one
    // re-reads everything because changes may have happened while it was down.
    watchServerChanges(client, {
      signal: controller.signal,
      onOpen: () => {
        refreshPolicy();
        refreshSettings();
      },
      onEvent: (event) => {
        if (event.type === "policy") refreshPolicy();
        else if (event.type === "config" || event.type === "providers") refreshSettings();
      },
      onLost: () => {
        policyRequest?.abort();
        setPolicy(null);
        settingsUnavailable();
      },
    }).catch(() => {
      if (controller.signal.aborted) return;
      setPolicy(null);
      settingsUnavailable();
    });
    type Anchor = NonNullable<
      NonNullable<Extract<WorkspaceChatMessage, { type: "caught-up" }>["cursor"]>["history"]
    >;
    // The server's reconnect anchor from the last caught-up. With one, a dropped stream
    // resumes since that row: the visible transcript stays put while the replayed suffix
    // is buffered, then the two are reconciled atomically at caught-up. Without one,
    // the replay is full and streams straight into a fresh transcript.
    let anchor: Anchor | null = null;
    let resume: { anchor: Anchor; buffered: WorkspaceChatMessage[] } | null = null;
    watch<WorkspaceChatMessage>({
      signal: controller.signal,
      open: (attempt) => {
        flush();
        resume = anchor ? { anchor, buffered: [] } : null;
        if (!resume) {
          historyCursor.current = null;
          setTranscript(createTranscriptState());
        }
        return client.workspace.onChat(
          {
            workspaceId,
            mode: resume ? { type: "since", cursor: { history: resume.anchor } } : { type: "full" },
          },
          { signal: attempt.signal }
        );
      },
      onEvent: (event) => {
        // This is a one-shot queue handoff, not replayable transcript state. Consume
        // it here so React rerenders cannot restore it twice or restart the stream.
        if (event.type === "restore-to-input") {
          flush();
          if (event.workspaceId === workspaceId) restore.current?.(event);
          return;
        }
        if (event.type === "delete") {
          // A page read before a truncate must not resurrect deleted history.
          historyRequest.current?.abort();
          historyRequest.current = null;
          historyCursor.current = null;
          setLoadingOlder(false);
        }
        if (event.type === "caught-up") {
          anchor = event.cursor?.history ?? null;
          if (resume) {
            const { anchor: requested, buffered } = resume;
            resume = null;
            // The server may downgrade a since replay to a full one; then the buffered
            // events describe the whole transcript rather than a suffix.
            const downgraded = event.replay !== "since";
            if (downgraded) historyCursor.current = null;
            setTranscript((current) =>
              [...buffered, event].reduce(
                applyChatEvent,
                downgraded
                  ? createTranscriptState()
                  : resumeTranscriptState(current, requested.historySequence)
              )
            );
            return;
          }
          flush(event);
          return;
        }
        if (resume) {
          resume.buffered.push(event);
          return;
        }
        // This timer throttles display work only. Retain original ordered events;
        // every control/tool boundary flushes immediately, not at the next frame.
        if (event.type === "stream-delta" || event.type === "reasoning-delta") {
          pendingDeltas.push(event);
          if (pendingDeltas.length >= MOBILE_STREAM_MAX_PENDING_DELTAS) flush();
          else if (displayTimer === null)
            displayTimer = setTimeout(() => flush(), MOBILE_STREAM_DISPLAY_BATCH_MS);
          return;
        }
        flush(event);
      },
      onLost: () => {
        // Sending needs a synced transcript; hold it read-only until the stream is back.
        flush();
        resume = null;
        setTranscript((current) => ({ ...current, caughtUp: false }));
      },
    }).catch(() => {
      // Only a rejected credential ends the watch; transient failures retry silently.
      flush();
      if (!controller.signal.aborted)
        setError("The server rejected this session. Retry to reconnect or sign in again.");
    });
    return () => {
      controller.abort();
      historyRequest.current?.abort();
      historyRequest.current = null;
    };
  }, [client, workspaceId, signal]);
  const owned =
    owner.client === client &&
    owner.workspaceId === workspaceId &&
    owner.signal === signal &&
    !signal.aborted;
  async function loadOlder() {
    if (
      !owned ||
      signal.aborted ||
      !transcript.caughtUp ||
      !transcript.hasOlderHistory ||
      historyRequest.current
    )
      return;
    const controller = linkedAbortController(signal);
    historyRequest.current = controller;
    setLoadingOlder(true);
    setHistoryError(null);
    const oldest = transcript.messages.find((message) => message.metadata?.historySequence != null);
    try {
      const page = await client.workspace.history.loadMore(
        {
          workspaceId,
          cursor:
            historyCursor.current ??
            (oldest
              ? {
                  beforeHistorySequence: oldest.metadata!.historySequence!,
                  beforeMessageId: oldest.id,
                }
              : undefined),
        },
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      historyCursor.current = page.nextCursor;
      const queuedDeltas = displayBatch.current?.take() ?? [];
      setTranscript((current) => {
        // Pages are historical snapshots; never replay old stream lifecycle events
        // over the current live turn or replace a newer copy of an existing row.
        let next = queuedDeltas.reduce(applyChatEvent, current);
        for (const event of page.messages) {
          if (
            event.type === "message" &&
            !next.messages.some((message) => message.id === event.id)
          ) {
            next = applyChatEvent(next, event);
          }
        }
        return { ...next, hasOlderHistory: page.hasOlder };
      });
    } catch {
      if (!controller.signal.aborted) setHistoryError("Could not load older messages. Try again.");
    } finally {
      if (historyRequest.current === controller) {
        historyRequest.current = null;
        setLoadingOlder(false);
      }
      controller.abort();
    }
  }
  // A replacement client must never inherit the old socket’s caught-up flag, even
  // for the render before the subscription effect runs. Draft state lives above this hook.
  return {
    transcript: owned ? transcript : createTranscriptState(),
    settings: owned && settings ? { ...settings, policy } : null,
    error: owned ? error : null,
    settingsError: owned ? settingsError : null,
    loadingOlder,
    historyError,
    loadOlder,
  };
}
