import { useCallback, useEffect, useRef, useState } from "react";
import { useOptionalAPI } from "@/browser/contexts/API";
import {
  sanitizeFallbackModelString,
  sanitizeModelFallbacks,
} from "@/common/utils/ai/modelFallbacks";
import type { ModelFallbacks } from "@/common/config/schemas/appConfigOnDisk";

export interface ModelFallbacksState {
  /** Per-model refusal-fallback chains, keyed by canonical source model. */
  modelFallbacks: ModelFallbacks;
  // Arrow-function property types so consumers can destructure without
  // tripping @typescript-eslint/unbound-method.
  /** Replace (or clear, with an empty array) one source model's fallback chain. */
  setFallbackChain: (sourceModel: string, models: string[]) => void;
}

/**
 * Reads/writes the per-model refusal-fallback chain map from app config.
 *
 * Mirrors useMinThinkingLevels: fetch on mount, subscribe to config changes,
 * optimistically apply local edits while ignoring stale fetches. Writes are
 * full-map replacements sanitized by the backend (canonical keys, no
 * self-fallbacks/duplicates, capped chain length).
 */
export function useModelFallbacks(): ModelFallbacksState {
  const api = useOptionalAPI()?.api ?? null;
  const [modelFallbacks, setMap] = useState<ModelFallbacks>({});
  // Ignore stale config fetches so backend refreshes can't overwrite newer optimistic edits.
  const fetchVersionRef = useRef(0);

  const fetchConfig = useCallback(async () => {
    const getConfig = api?.config?.getConfig;
    if (!getConfig) {
      return;
    }

    const fetchVersion = ++fetchVersionRef.current;

    try {
      const config = await getConfig();
      if (fetchVersion !== fetchVersionRef.current) {
        return;
      }
      setMap(config.modelFallbacks ?? {});
    } catch {
      // Best-effort only.
    }
  }, [api]);

  useEffect(() => {
    const onConfigChanged = api?.config?.onConfigChanged;
    if (!onConfigChanged) {
      return;
    }

    const abortController = new AbortController();
    const { signal } = abortController;
    let iterator: AsyncIterator<unknown> | null = null;

    void fetchConfig();

    (async () => {
      try {
        const subscribedIterator = await onConfigChanged(undefined, { signal });
        if (signal.aborted) {
          void subscribedIterator.return?.();
          return;
        }
        iterator = subscribedIterator;
        for await (const _ of subscribedIterator) {
          if (signal.aborted) {
            break;
          }
          void fetchConfig();
        }
      } catch {
        // Subscription cancelled via abort signal - expected on cleanup.
      }
    })();

    return () => {
      abortController.abort();
      void iterator?.return?.();
    };
  }, [api, fetchConfig]);

  const setFallbackChain = useCallback(
    (sourceModel: string, models: string[]) => {
      // Coder gateway keys stay gateway-scoped (see sanitizeFallbackModelString);
      // the editor passes metadata-aware normalized sources already.
      const key = sanitizeFallbackModelString(sourceModel);
      if (!key) {
        return;
      }

      const next = { ...modelFallbacks };
      if (models.length === 0) {
        delete next[key];
      } else {
        // Preserve hand-edited fields (enabled/triggers) the editor doesn't
        // surface yet; only the chain itself is being replaced.
        next[key] = { ...next[key], models };
      }
      // Mirror the backend's strict-on-write sanitization locally so the UI
      // immediately reflects what will actually persist.
      const sanitized = sanitizeModelFallbacks(next);

      fetchVersionRef.current++;
      setMap(sanitized);

      api?.config?.updateModelFallbacks({ modelFallbacks: sanitized }).catch(() => {
        // If the write fails, re-fetch so the UI reverts to the backend's actual
        // chains rather than displaying one the send path never applies.
        void fetchConfig();
      });
    },
    [api, fetchConfig, modelFallbacks]
  );

  return {
    modelFallbacks,
    setFallbackChain,
  };
}
