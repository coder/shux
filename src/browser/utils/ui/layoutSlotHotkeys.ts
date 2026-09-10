import type { LayoutPresetsConfig, LayoutSlotNumber } from "@/common/types/uiLayouts";
import { getEffectiveSlotKeybind, getPresetForSlot } from "@/browser/utils/uiLayouts";
import {
  matchesKeybind,
  isBrowserViewportFocused,
  isDesktopViewportFocused,
  isTerminalFocused,
  isDialogOpen,
} from "@/browser/utils/ui/keybinds";

export function handleLayoutSlotHotkeys(
  e: KeyboardEvent,
  params: {
    isCommandPaletteOpen: boolean;
    isSettingsOpen: boolean;
    selectedWorkspaceId: string | null;
    layoutPresets: LayoutPresetsConfig;
    applySlotToWorkspace: (workspaceId: string, slot: LayoutSlotNumber) => Promise<void>;
  }
): boolean {
  if (params.isCommandPaletteOpen || params.isSettingsOpen) {
    return false;
  }

  // Dialogs are modal — don't process layout hotkeys when one is open.
  // This runs in capture phase, so bubble-phase stopPropagation from dialog onKeyDown can't block it.
  if (isDialogOpen()) {
    return false;
  }

  const workspaceId = params.selectedWorkspaceId;
  if (!workspaceId) {
    return false;
  }

  // Slot hotkeys are global, but we avoid stealing keyboard shortcuts from terminals
  // or the focused browser viewport.
  if (
    isTerminalFocused(e.target) ||
    isBrowserViewportFocused(e.target) ||
    isDesktopViewportFocused(e.target)
  ) {
    return false;
  }

  // AltGr is commonly implemented as Ctrl+Alt; avoid treating it as our shortcut.
  if (typeof e.getModifierState === "function" && e.getModifierState("AltGraph")) {
    return false;
  }

  for (const slot of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
    const preset = getPresetForSlot(params.layoutPresets, slot);
    if (!preset) {
      continue;
    }

    const keybind = getEffectiveSlotKeybind(params.layoutPresets, slot);
    if (!keybind || !matchesKeybind(e, keybind)) {
      continue;
    }

    e.preventDefault();
    void params.applySlotToWorkspace(workspaceId, slot).catch(() => {
      // Best-effort only.
    });
    return true;
  }

  // Custom overrides for additional slots (10+).
  for (const slotConfig of params.layoutPresets.slots) {
    if (slotConfig.slot <= 9) {
      continue;
    }
    if (!slotConfig.preset || !slotConfig.keybindOverride) {
      continue;
    }
    if (!matchesKeybind(e, slotConfig.keybindOverride)) {
      continue;
    }

    e.preventDefault();
    void params.applySlotToWorkspace(workspaceId, slotConfig.slot).catch(() => {
      // Best-effort only.
    });
    return true;
  }

  return false;
}
