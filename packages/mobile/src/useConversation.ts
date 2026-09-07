import { useEffect, useRef, useState } from "react";
import type { MobileClient } from "./api";
import { applyChatEvent, createTranscriptState } from "./transcript";
import type { SettingsData } from "./settings";
import { linkedAbortController } from "./useConnection";

export function useConversation(client: MobileClient, workspaceId: string, signal: AbortSignal) {
  const [transcript, setTranscript] = useState(createTranscriptState);
  const [settings, setSettings] = useState<Omit<SettingsData, "policy"> | null>(null);
  const [policy, setPolicy] = useState<SettingsData["policy"]>(null);
  const [error, setError] = useState<string | null>(null);
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
    async function subscribe() {
      const [config, providers, agents] = await Promise.all([
        client.config.getConfig(undefined, { signal: controller.signal }),
        client.providers.getConfig(undefined, { signal: controller.signal }),
        client.agents.list({ workspaceId }, { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      setSettings({ config, providers, agents });
      const events = await client.workspace.onChat(
        { workspaceId, mode: { type: "full" } },
        { signal: controller.signal }
      );
      for await (const event of events) {
        if (controller.signal.aborted) return;
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
    loadingOlder,
    historyError,
    loadOlder,
  };
}
