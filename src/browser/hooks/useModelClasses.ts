import { useEffect, useRef, useState } from "react";
import { useOptionalAPI } from "@/browser/contexts/API";
import { getErrorMessage } from "@/common/utils/errors";

export interface ModelClassesState {
  /** Class name → model value in one-shot syntax ("haiku+0"). */
  modelClasses: Record<string, string>;
  /**
   * True while the map reflects live backend truth (first fetch landed and
   * the config subscription is delivering). Consumers gate their controls on
   * this: editing a row whose current value cannot be trusted invites
   * blind overwrites of that entry.
   */
  loaded: boolean;
  /**
   * Classes with a write still in flight (state publishes on the write's
   * ack). Editors must disable a pending row's controls: a second edit built
   * from the still-unpublished rendered state would compose against the old
   * value and overwrite the first edit.
   */
  pendingWrites: Record<string, number>;
  /**
   * The backend's message for the most recent write that failed (config.json
   * read-only or full, the RPC rejecting). The map reverts to backend truth on
   * the failure's refetch, so without this the selection would silently snap
   * back; consumers must show it. Cleared when the next write is attempted.
   */
  writeError: string | null;
  // Arrow-function property type so consumers can destructure without
  // tripping @typescript-eslint/unbound-method.
  /** Set (or clear, with null/empty) one class's model value. */
  setModelClass: (className: string, value: string | null) => void;
}

/**
 * Reads/writes the model-classes map (skill routing indirection) from app
 * config. Fetch on mount, subscribe to config changes, publish local edits on
 * their write's ack. Writes are PER-ENTRY and merged inside the backend's
 * config transaction, so a concurrent Settings consumer editing a different
 * class — or a hand-edited custom class — can never be deleted by a stale
 * client-side map snapshot.
 */
export function useModelClasses(): ModelClassesState {
  const api = useOptionalAPI()?.api ?? null;
  const [modelClasses, setMap] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  // Ignore stale config fetches so backend refreshes can't overwrite newer optimistic edits.
  const fetchVersionRef = useRef(0);
  // Bumped whenever the API client changes: write acknowledgements (and their
  // failure refetches) belong to the client that issued them — an old client's
  // late ack must not publish its entry over state fetched from the
  // replacement client, nor invalidate the replacement's in-flight fetch.
  const clientGenerationRef = useRef(0);
  // Populated by the subscription effect below; lets the write-failure revert
  // in setModelClass reuse the same stale-guarded fetch. A ref (not a
  // useCallback) keeps this within the repo's React Compiler conventions —
  // no manual memoization for identity stabilization.
  const refetchRef = useRef<() => Promise<void>>(() => {
    // No-op until the subscription effect installs the real fetch.
    return Promise.resolve();
  });
  // Whether the config-change subscription is currently delivering. Fetches
  // may only (re)mark the hook loaded while it is: a fetch that outlives a
  // dead subscription (the post-subscribe fetch racing the stream's death,
  // or a write-path revert issued during the resubscribe backoff) would
  // otherwise re-mark the editor live on state that can no longer track
  // peer edits.
  const subscriptionLiveRef = useRef(false);
  // The most recently started fetch (set synchronously at dispatch, cleared
  // when it settles while still the latest). The write chain drains this
  // before unlocking a row: an awaited refetch can be superseded mid-flight
  // by a newer notification-triggered fetch (the newer call bumps the
  // version, so the awaited one discards its result at the stale guard) —
  // unlocking then would re-enable editing on a map still about to change.
  const latestFetchRef = useRef<Promise<void> | null>(null);
  // Serializes writes so rapid edits persist in order and the last one wins.
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());
  // Per-class in-flight write counts; consumers disable pending rows.
  const [pendingWrites, setPendingWrites] = useState<Record<string, number>>({});

  useEffect(() => {
    // A client swap (disconnect/reconnect) invalidates anything fetched from
    // the previous client: mark the hook unloaded until THIS client's fetch
    // lands, and bump the fetch version so an in-flight fetch against the
    // old client cannot re-mark the hook loaded.
    fetchVersionRef.current++;
    clientGenerationRef.current++;
    subscriptionLiveRef.current = false;
    setLoaded(false);
    // The serialization chain and pending-row counts belong to the old
    // client too: queueing behind an old-client request could block forever
    // if it never settles, and orphaned pending counts would keep rows
    // disabled. Old completions skip their own bookkeeping via the
    // generation guards below.
    writeChainRef.current = Promise.resolve();
    setPendingWrites({});

    const getConfig = api?.config?.getConfig;
    const onConfigChanged = api?.config?.onConfigChanged;
    if (!getConfig || !onConfigChanged) {
      return;
    }

    const fetchConfig = async () => {
      const fetchVersion = ++fetchVersionRef.current;
      const run = (async () => {
        try {
          const config = await getConfig();
          if (fetchVersion !== fetchVersionRef.current) {
            return;
          }
          setMap(config.modelClasses ?? {});
          // The loaded upgrade requires a LIVE subscription: a fetch resolving
          // after the stream died reflects truth at a moment peer edits were
          // already invisible, so it must not re-enable the editor — the
          // resubscribe's own post-subscribe fetch does that.
          if (subscriptionLiveRef.current) {
            setLoaded(true);
          }
        } catch {
          // A failed refresh leaves the rendered map possibly BEHIND another
          // process's edit (the notification that triggered this fetch): mark
          // the hook unloaded so the editor's controls disable until a later
          // fetch re-establishes truth. Stale-version failures change
          // nothing — a newer fetch owns the state. While the subscription
          // itself is still LIVE, no further notification is guaranteed (the
          // write's own notification often precedes its ack), so schedule an
          // authoritative retry rather than leaving every control disabled
          // until an unrelated config change or reconnect. Transport retry
          // backoff, not component coordination.
          if (fetchVersion === fetchVersionRef.current) {
            setLoaded(false);
            setTimeout(() => {
              if (
                !signal.aborted &&
                subscriptionLiveRef.current &&
                fetchVersion === fetchVersionRef.current
              ) {
                void fetchConfig();
              }
            }, 2_000);
          }
        }
      })();
      latestFetchRef.current = run;
      void run.finally(() => {
        if (latestFetchRef.current === run) {
          latestFetchRef.current = null;
        }
      });
      await run;
    };
    refetchRef.current = fetchConfig;

    const abortController = new AbortController();
    const { signal } = abortController;
    let iterator: AsyncIterator<unknown> | null = null;

    (async () => {
      while (!signal.aborted) {
        try {
          const subscribedIterator = await onConfigChanged(undefined, { signal });
          if (signal.aborted) {
            void subscribedIterator.return?.();
            return;
          }
          iterator = subscribedIterator;
          subscriptionLiveRef.current = true;
          // Authoritative fetch only AFTER the subscription is live: the
          // stream has no replay, so an edit landing between a
          // pre-subscription read and registration would be silently missed —
          // the hook would stay loaded on a stale map. If subscribing fails,
          // no fetch runs and the editor stays disabled (loaded=false)
          // rather than editable-but-stale.
          void fetchConfig();
          for await (const _ of subscribedIterator) {
            if (signal.aborted) {
              break;
            }
            // A peer changed the config: the rendered map is stale until the
            // refetch lands. An edit composed meanwhile (model + thinking pair
            // read from the stale row) would overwrite the peer's value for
            // that class, and the post-write refetch cannot recover it — so
            // the map is untrusted (controls disabled) while the notification's
            // fetch is outstanding; the fetch re-marks it loaded.
            setLoaded(false);
            void fetchConfig();
          }
        } catch {
          // Aborted cleanup or a transport failure — classified below.
        }
        if (signal.aborted) {
          return;
        }
        // The subscription ended WITHOUT cleanup (transport interruption
        // while the API object survived): peer edits are invisible from this
        // moment. Drop liveness and fence any in-flight fetch (it raced the
        // same dead stream and would otherwise resolve after this and
        // re-mark the hook loaded), go unloaded, then re-establish the
        // subscription — its post-subscribe fetch re-loads the editor once
        // notifications flow again. The delay is transport retry backoff,
        // not component coordination.
        subscriptionLiveRef.current = false;
        fetchVersionRef.current++;
        setLoaded(false);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    })();

    return () => {
      abortController.abort();
      void iterator?.return?.();
    };
  }, [api]);

  const setModelClass = (className: string, value: string | null) => {
    const key = className.trim();
    // Refuse edits while the rendered value cannot be trusted (before the
    // first fetch, or while the subscription is down): the user would be
    // blindly overwriting an entry they cannot see.
    if (!key || !loaded) {
      return;
    }

    // Guarded lookup rather than a chained call: in partial-API environments
    // (story mocks, tests) a missing route must not throw synchronously.
    const updateModelClass = api?.config?.updateModelClass;
    if (!updateModelClass) {
      return;
    }

    const trimmed = value?.trim() ?? "";
    setPendingWrites((current) => ({ ...current, [key]: (current[key] ?? 0) + 1 }));
    setWriteError(null);

    // Await whichever fetch currently owns the latest version, not just the
    // one this chain started: a peer notification can supersede our refetch
    // mid-flight (bumping the version so ours discards its result), and
    // unlocking the row on the superseded await would re-enable editing
    // before the authoritative map displays.
    const awaitLatestFetch = async (): Promise<void> => {
      while (latestFetchRef.current != null) {
        const inFlight = latestFetchRef.current;
        await inFlight;
        if (latestFetchRef.current === inFlight) {
          return;
        }
      }
    };

    // The ack/revert below is only meaningful for the client that took the
    // write: after a client swap, the old client's late completion must not
    // publish over (or refetch under) the replacement client's state.
    const writeGeneration = clientGenerationRef.current;

    // Persist BEFORE publishing: routing reads the backend map at send time,
    // so optimistically advertising the new mapping would let a quick
    // follow-up skill invocation stream on the OLD route while the editor
    // claims the new one. The selects update on the write's ack instead.
    writeChainRef.current = writeChainRef.current
      .then(async () => {
        if (clientGenerationRef.current !== writeGeneration) {
          return;
        }
        // Per-entry write, merged inside the backend's config transaction:
        // no map composition happens client-side, so a stale local snapshot
        // can never delete a peer consumer's class or a hand-edited entry
        // this build cannot parse.
        await updateModelClass({ className: key, model: trimmed ? trimmed : null });
        if (clientGenerationRef.current !== writeGeneration) {
          return;
        }
        // The ack is the freshest truth for this entry. Invalidate in-flight
        // fetches whose snapshot may predate this write, patch the entry
        // locally, then refetch authoritatively: the write's own
        // config-change notification usually arrives BEFORE this ack, so the
        // version bump fences that notification's fetch too — without an
        // explicit refetch, a concurrent peer edit it carried would stay
        // invisible indefinitely (no further notification is guaranteed) and
        // a later local edit of that class would overwrite the peer's value.
        fetchVersionRef.current++;
        setMap((current) => {
          const next = { ...current };
          if (!trimmed) {
            delete next[key];
          } else {
            next[key] = trimmed;
          }
          return next;
        });
        // AWAITED (never fire-and-forget): the row must stay pending until
        // the authoritative map is displayed — clearing pendingWrites while
        // a fetch is still in flight would re-enable the row on the locally
        // patched value and let the next edit overwrite a peer's unseen
        // write of the SAME class. fetchConfig never rejects, and the drain
        // covers newer fetches that superseded ours.
        await refetchRef.current();
        await awaitLatestFetch();
      })
      .catch(async (error: unknown) => {
        // If the write fails, re-fetch so the UI reverts to the backend's
        // actual value rather than displaying a class routing never applies.
        // A stale-generation failure is not ours to handle: refetchRef already
        // points at the replacement client's fetch, which owns its own state.
        // AWAITED like the ack path (including the latest-fetch drain):
        // clearing pendingWrites while the revert is in flight would
        // re-enable the row on stale state and let the next edit overwrite
        // a peer's unseen write of the same class.
        if (clientGenerationRef.current !== writeGeneration) {
          return;
        }
        // The revert alone would look like the selection silently snapping
        // back; surface the backend's actionable message with it.
        setWriteError(getErrorMessage(error));
        await refetchRef.current();
        await awaitLatestFetch();
      })
      .finally(() => {
        // A client swap already wiped this write's bookkeeping; decrementing
        // here would corrupt the replacement client's fresh pending counts.
        if (clientGenerationRef.current !== writeGeneration) {
          return;
        }
        setPendingWrites((current) => {
          const count = (current[key] ?? 0) - 1;
          if (count > 0) {
            return { ...current, [key]: count };
          }
          const { [key]: _drop, ...rest } = current;
          return rest;
        });
      });
  };

  return {
    modelClasses,
    loaded,
    pendingWrites,
    writeError,
    setModelClass,
  };
}
