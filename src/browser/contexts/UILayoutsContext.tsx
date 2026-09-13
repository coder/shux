import {
  useCallback,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAPI } from "@/browser/contexts/API";
import assert from "@/common/utils/assert";
import {
  DEFAULT_LAYOUT_PRESETS_CONFIG,
  normalizeLayoutPresetsConfig,
  type LayoutPreset,
  type LayoutPresetsConfig,
  type LayoutSlotNumber,
} from "@/common/types/uiLayouts";
import {
  applyLayoutPresetToWorkspace,
  createPresetFromCurrentWorkspace,
  deleteSlotAndShiftFollowingSlots,
  getLayoutsConfigOrDefault,
  getPresetForSlot,
  updateSlotKeybindOverride,
  updateSlotPreset,
} from "@/browser/utils/uiLayouts";
import type { Keybind } from "@/common/types/keybind";

interface UILayoutsContextValue {
  layoutPresets: LayoutPresetsConfig;
  loaded: boolean;
  loadFailed: boolean;
  refresh: () => Promise<void>;
  saveAll: (next: LayoutPresetsConfig) => Promise<void>;

  applySlotToWorkspace: (workspaceId: string, slot: LayoutSlotNumber) => Promise<void>;

  /** Capture the currently-selected workspace's layout into the given slot. */
  saveCurrentWorkspaceToSlot: (
    workspaceId: string,
    slot: LayoutSlotNumber,
    name?: string | null
  ) => Promise<LayoutPreset>;

  renameSlot: (slot: LayoutSlotNumber, newName: string) => Promise<void>;
  deleteSlot: (slot: LayoutSlotNumber) => Promise<void>;
  setSlotKeybindOverride: (slot: LayoutSlotNumber, keybind: Keybind | undefined) => Promise<void>;
}

const UILayoutsContext = createContext<UILayoutsContextValue | null>(null);

export function useUILayouts(): UILayoutsContextValue {
  const ctx = useContext(UILayoutsContext);
  if (!ctx) {
    throw new Error("useUILayouts must be used within UILayoutsProvider");
  }
  return ctx;
}

export function UILayoutsProvider(props: { children: ReactNode }) {
  const { api } = useAPI();

  const [layoutPresets, setLayoutPresets] = useState<LayoutPresetsConfig>(
    DEFAULT_LAYOUT_PRESETS_CONFIG
  );
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (!api) {
      setLayoutPresets(DEFAULT_LAYOUT_PRESETS_CONFIG);
      setLoaded(true);
      setLoadFailed(false);
      return;
    }

    try {
      const remote = await api.uiLayouts.getAll();
      setLayoutPresets(getLayoutsConfigOrDefault(remote));
      setLoaded(true);
      setLoadFailed(false);
    } catch {
      setLayoutPresets(DEFAULT_LAYOUT_PRESETS_CONFIG);
      setLoaded(true);
      setLoadFailed(true);
    }
  }, [api]);

  const getConfigForWrite = useCallback(async (): Promise<LayoutPresetsConfig> => {
    if (!api) {
      return layoutPresets;
    }

    // Always fetch the latest config right before a write.
    //
    // This prevents stale in-memory state (captured by closures) from accidentally overwriting a
    // newer config when multiple writes happen in sequence (e.g., delete layout → clear hotkey).
    try {
      const remote = await api.uiLayouts.getAll();
      const normalized = getLayoutsConfigOrDefault(remote);

      setLayoutPresets(normalized);
      setLoaded(true);
      setLoadFailed(false);

      return normalized;
    } catch {
      // Best-effort fallback: don't block writes if the config fetch fails.
      return layoutPresets;
    }
  }, [api, layoutPresets]);

  const saveAll = useCallback(
    async (next: LayoutPresetsConfig): Promise<void> => {
      const normalized = normalizeLayoutPresetsConfig(next);

      if (!api) {
        throw new Error("ORPC client not initialized");
      }

      await api.uiLayouts.saveAll({ layoutPresets: normalized });
      setLayoutPresets(normalized);
    },
    [api]
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Presets change behind this provider when a settings restore rewrites config, so hotkeys
  // and palette entries would keep applying the old slots until the app reloaded.
  useEffect(() => {
    const onConfigChanged = api?.config?.onConfigChanged;
    if (!onConfigChanged) return;

    const abortController = new AbortController();
    const { signal } = abortController;
    let iterator: AsyncIterator<unknown> | null = null;

    const runSubscription = async () => {
      try {
        const subscribedIterator = await onConfigChanged(undefined, { signal });
        if (signal.aborted) {
          void subscribedIterator.return?.();
          return;
        }

        iterator = subscribedIterator;
        for await (const _ of subscribedIterator) {
          if (signal.aborted) break;
          void refresh();
        }
      } catch {
        // Config subscriptions are cancelled during unmounts and API reconnects.
      }
    };

    void runSubscription();

    return () => {
      abortController.abort();
      void iterator?.return?.();
    };
  }, [api, refresh]);

  const applySlotToWorkspace = useCallback(
    async (workspaceId: string, slot: LayoutSlotNumber): Promise<void> => {
      const preset = getPresetForSlot(layoutPresets, slot);
      if (!preset) {
        return;
      }

      await applyLayoutPresetToWorkspace(api ?? null, workspaceId, preset);
    },
    [api, layoutPresets]
  );

  const saveCurrentWorkspaceToSlot = useCallback(
    async (
      workspaceId: string,
      slot: LayoutSlotNumber,
      name?: string | null
    ): Promise<LayoutPreset> => {
      assert(
        typeof workspaceId === "string" && workspaceId.length > 0,
        "workspaceId must be non-empty"
      );

      const base = await getConfigForWrite();
      const existingPreset = getPresetForSlot(base, slot);

      const trimmedName = name?.trim();
      const resolvedName =
        trimmedName && trimmedName.length > 0
          ? trimmedName
          : (existingPreset?.name ?? `Slot ${slot}`);

      const preset = createPresetFromCurrentWorkspace(
        workspaceId,
        resolvedName,
        existingPreset?.id
      );
      await saveAll(updateSlotPreset(base, slot, preset));
      return preset;
    },
    [getConfigForWrite, saveAll]
  );

  const renameSlot = useCallback(
    async (slot: LayoutSlotNumber, newName: string): Promise<void> => {
      const trimmed = newName.trim();
      if (!trimmed) {
        return;
      }

      const base = await getConfigForWrite();
      const existingPreset = getPresetForSlot(base, slot);
      if (!existingPreset) {
        return;
      }

      await saveAll(updateSlotPreset(base, slot, { ...existingPreset, name: trimmed }));
    },
    [getConfigForWrite, saveAll]
  );

  const deleteSlot = useCallback(
    async (slot: LayoutSlotNumber): Promise<void> => {
      const base = await getConfigForWrite();
      await saveAll(deleteSlotAndShiftFollowingSlots(base, slot));
    },
    [getConfigForWrite, saveAll]
  );

  const setSlotKeybindOverride = useCallback(
    async (slot: LayoutSlotNumber, keybind: Keybind | undefined): Promise<void> => {
      const base = await getConfigForWrite();
      await saveAll(updateSlotKeybindOverride(base, slot, keybind));
    },
    [getConfigForWrite, saveAll]
  );

  const value: UILayoutsContextValue = useMemo(
    () => ({
      layoutPresets,
      loaded,
      loadFailed,
      refresh,
      saveAll,
      applySlotToWorkspace,
      saveCurrentWorkspaceToSlot,
      renameSlot,
      deleteSlot,
      setSlotKeybindOverride,
    }),
    [
      layoutPresets,
      loaded,
      loadFailed,
      refresh,
      saveAll,
      applySlotToWorkspace,
      saveCurrentWorkspaceToSlot,
      renameSlot,
      deleteSlot,
      setSlotKeybindOverride,
    ]
  );

  return <UILayoutsContext.Provider value={value}>{props.children}</UILayoutsContext.Provider>;
}
