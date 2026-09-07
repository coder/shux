import { useEffect, useRef, useState } from "react";
import type { MobileClient } from "./api";
import { applyChatEvent, createTranscriptState } from "./transcript";
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
    async function subscribePolicy() {
      // Subscribe before the initial read so changes during that read are not lost.
      const events = await client.policy.onChanged(undefined, { signal: controller.signal });
      async function refresh() {
        if (controller.signal.aborted) return;
        setPolicy(null);
        try {
          const next = await client.policy.get(undefined, { signal: controller.signal });
          if (!controller.signal.aborted) setPolicy(next);
        } catch {
          // Fail closed, but keep the subscription alive so a later change can heal it.
        }
      }
      await refresh();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Notifications have no payload.
      for await (const _ of events) {
        if (controller.signal.aborted) return;
        await refresh();
      }
      if (!controller.signal.aborted) setPolicy(null);
    }
    subscribePolicy().catch(() => {
      if (!controller.signal.aborted) setPolicy(null);
    });
    const settingsController = linkedAbortController(controller.signal);
    let settingsRequest: AbortController | null = null;
    async function subscribeSettings() {
      // Both subscriptions must be registered before reading privacy/routing settings.
      const [configEvents, providerEvents, agents] = await Promise.all([
        client.config.onConfigChanged(undefined, { signal: settingsController.signal }),
        client.providers.onConfigChanged(undefined, { signal: settingsController.signal }),
        client.agents.list({ workspaceId }, { signal: settingsController.signal }),
      ]);
      if (settingsController.signal.aborted) return;
      function refresh() {
        settingsRequest?.abort();
        const request = linkedAbortController(settingsController.signal);
        settingsRequest = request;
        // A notification invalidates the old privacy options immediately. Consume
        // further notifications while reading, so an older snapshot cannot win.
        setSettings(null);
        setSettingsError(null);
        Promise.all([
          client.config.getConfig(undefined, { signal: request.signal }),
          client.providers.getConfig(undefined, { signal: request.signal }),
        ])
          .then(
            ([config, providers]) => {
              if (!request.signal.aborted) setSettings({ config, providers, agents });
            },
            () => {
              if (!request.signal.aborted)
                setSettingsError("Settings unavailable. Retry to reconnect.");
            }
          )
          .finally(() => request.abort());
      }
      const watching = Promise.all(
        [configEvents, providerEvents].map(async (events) => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Notifications have no payload.
          for await (const _ of events) {
            if (settingsController.signal.aborted) return;
            refresh();
          }
          if (!settingsController.signal.aborted) throw new Error("Settings disconnected");
        })
      );
      refresh();
      await watching;
    }
    subscribeSettings().catch(() => {
      if (controller.signal.aborted) return;
      settingsController.abort();
      setSettings(null);
      setSettingsError("Settings unavailable. Retry to reconnect.");
    });
    async function subscribe() {
      const events = await client.workspace.onChat(
        { workspaceId, mode: { type: "full" } },
        { signal: controller.signal }
      );
      for await (const event of events) {
        if (controller.signal.aborted) return;
        // This is a one-shot queue handoff, not replayable transcript state. Consume
        // it here so React rerenders cannot restore it twice or restart the socket.
        if (event.type === "restore-to-input") {
          if (event.workspaceId === workspaceId) restore.current?.(event);
          continue;
        }
        if (event.type === "delete") {
          // A page read before a truncate must not resurrect deleted history.
          historyRequest.current?.abort();
          historyRequest.current = null;
          historyCursor.current = null;
          setLoadingOlder(false);
        }
        setTranscript((current) => applyChatEvent(current, event));
      }
      if (!controller.signal.aborted)
        throw new Error(
          "Conversation disconnected. Retry to reload the full history before sending."
        );
    }
    subscribe().catch((cause: unknown) => {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not load the conversation. Retry to reconnect."
        );
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
      setTranscript((current) => {
        // Pages are historical snapshots; never replay old stream lifecycle events
        // over the current live turn or replace a newer copy of an existing row.
        let next = current;
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
