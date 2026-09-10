import { useRef } from "react";
import { useAPI } from "@/browser/contexts/API";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { DEFAULT_RUNTIME_KEY, RUNTIME_ENABLEMENT_KEY } from "@/common/constants/storage";
import {
  DEFAULT_RUNTIME_ENABLEMENT,
  RUNTIME_ENABLEMENT_IDS,
  normalizeRuntimeEnablement,
  type RuntimeEnablement,
  type RuntimeEnablementId,
} from "@/common/types/runtime";

interface RuntimeEnablementState {
  enablement: RuntimeEnablement;
  setRuntimeEnabled: (
    id: RuntimeEnablementId,
    enabled: boolean,
    nextDefaultRuntime?: RuntimeEnablementId | null
  ) => void;
  defaultRuntime: RuntimeEnablementId | null;
  setDefaultRuntime: (id: RuntimeEnablementId | null) => void;
}

function normalizeDefaultRuntime(value: unknown): RuntimeEnablementId | null {
  if (typeof value !== "string") {
    return null;
  }

  return RUNTIME_ENABLEMENT_IDS.includes(value as RuntimeEnablementId)
    ? (value as RuntimeEnablementId)
    : null;
}

export function useRuntimeEnablement(): RuntimeEnablementState {
  const { api } = useAPI();
  const [rawEnablement, setRawEnablement] = usePersistedState<unknown>(
    RUNTIME_ENABLEMENT_KEY,
    DEFAULT_RUNTIME_ENABLEMENT,
    { listener: true }
  );
  const [rawDefaultRuntime, setRawDefaultRuntime] = usePersistedState<unknown>(
    DEFAULT_RUNTIME_KEY,
    null,
    { listener: true }
  );

  // Normalize persisted values so corrupted/legacy payloads don't break toggles.
  // Stabilize the reference: normalizeRuntimeEnablement returns a fresh object every call,
  // so we use a ref to return the same object when the values haven't changed. This prevents
  // downstream effects from re-running on every render.
  const normalized = normalizeRuntimeEnablement(rawEnablement);
  const enablementRef = useRef(normalized);
  const prevSerializedRef = useRef(JSON.stringify(normalized));
  const currentSerialized = JSON.stringify(normalized);
  if (currentSerialized !== prevSerializedRef.current) {
    enablementRef.current = normalized;
    prevSerializedRef.current = currentSerialized;
  }
  const enablement = enablementRef.current;
  const defaultRuntime = normalizeDefaultRuntime(rawDefaultRuntime);

  const setRuntimeEnabled = (
    id: RuntimeEnablementId,
    enabled: boolean,
    nextDefaultRuntime?: RuntimeEnablementId | null
  ) => {
    const nextMap: RuntimeEnablement = {
      ...enablement,
      [id]: enabled,
    };

    // Persist locally first so Settings reflects changes immediately and stays in sync.
    setRawEnablement(nextMap);
    if (nextDefaultRuntime !== undefined) {
      setRawDefaultRuntime(nextDefaultRuntime);
    }

    // Best-effort backend write keeps ~/.xum/config.json aligned across devices.
    const payload: {
      runtimeEnablement: RuntimeEnablement;
      defaultRuntime?: RuntimeEnablementId | null;
    } = { runtimeEnablement: nextMap };

    if (nextDefaultRuntime !== undefined) {
      payload.defaultRuntime = nextDefaultRuntime;
    }

    api?.config?.updateRuntimeEnablement(payload).catch(() => {
      // Best-effort only.
    });
  };

  const setDefaultRuntime = (id: RuntimeEnablementId | null) => {
    // Keep the local cache and config.json aligned for the global default runtime.
    setRawDefaultRuntime(id);

    api?.config?.updateRuntimeEnablement({ defaultRuntime: id }).catch(() => {
      // Best-effort only.
    });
  };

  return { enablement, setRuntimeEnabled, defaultRuntime, setDefaultRuntime };
}
