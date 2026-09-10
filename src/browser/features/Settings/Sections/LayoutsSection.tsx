import React, { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import assert from "@/common/utils/assert";
import { KebabMenu, type KebabMenuItem } from "@/browser/components/KebabMenu/KebabMenu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { useUILayouts } from "@/browser/contexts/UILayoutsContext";
import { useConfirmDialog } from "@/browser/contexts/ConfirmDialogContext";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { getEffectiveSlotKeybind } from "@/browser/utils/uiLayouts";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { formatKeybind, isMac, KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";
import { SELECTED_WORKSPACE_KEY } from "@/common/constants/storage";
import type { Keybind } from "@/common/types/keybind";
import type { LayoutSlotNumber } from "@/common/types/uiLayouts";

function isModifierOnlyKey(key: string): boolean {
  return key === "Shift" || key === "Control" || key === "Alt" || key === "Meta";
}

function normalizeCapturedKeybind(e: KeyboardEvent): Keybind | null {
  if (!e.key || isModifierOnlyKey(e.key)) {
    return null;
  }

  // On macOS, we represent Cmd as ctrl=true so bindings remain cross-platform.
  const onMac = isMac();
  const ctrl = e.ctrlKey ? true : onMac ? e.metaKey : false;
  const meta = !onMac ? e.metaKey : false;

  return {
    key: e.key,
    code: e.code || undefined,
    ctrl: ctrl ? true : undefined,
    alt: e.altKey ? true : undefined,
    shift: e.shiftKey ? true : undefined,
    meta: meta ? true : undefined,
  };
}

function collectKeybindEventCandidates(keybind: Keybind): Array<{ key: string; code?: string }> {
  const candidates: Array<{ key: string; code?: string }> = [];
  const seen = new Set<string>();

  const pushCandidate = (key: string, code: string | undefined) => {
    const token = `${key}::${code ?? ""}`;
    if (seen.has(token)) {
      return;
    }
    seen.add(token);
    candidates.push(code ? { key, code } : { key });
  };

  pushCandidate(keybind.key, keybind.code);

  return candidates;
}

function isLegacyShiftedSymbolKeybind(keybind: Keybind): boolean {
  return (
    keybind.code == null &&
    keybind.shift === true &&
    keybind.key.length === 1 &&
    /[^a-z0-9]/i.test(keybind.key)
  );
}

function keybindConflicts(a: Keybind, b: Keybind): boolean {
  const candidateMap = new Map<string, { key: string; code?: string }>();
  const addCandidate = (key: string, code: string | undefined) => {
    const token = `${key}::${code ?? ""}`;
    candidateMap.set(token, code ? { key, code } : { key });
  };

  for (const candidate of [
    ...collectKeybindEventCandidates(a),
    ...collectKeybindEventCandidates(b),
  ]) {
    addCandidate(candidate.key, candidate.code);
  }

  const addLegacyBridgeCandidate = (legacy: Keybind, coded: Keybind) => {
    if (!isLegacyShiftedSymbolKeybind(legacy) || coded.code == null) {
      return;
    }
    // Legacy (pre-code) shifted symbol bindings are still persisted for some users.
    // Include a bridged candidate so key-only legacy bindings can still conflict
    // with newer code-based shortcuts that share the same physical key event.
    addCandidate(legacy.key, coded.code);
  };

  addLegacyBridgeCandidate(a, b);
  addLegacyBridgeCandidate(b, a);

  for (const candidate of candidateMap.values()) {
    for (const ctrlKey of [false, true]) {
      for (const altKey of [false, true]) {
        for (const shiftKey of [false, true]) {
          for (const metaKey of [false, true]) {
            const eventInit: KeyboardEventInit = {
              key: candidate.key,
              ctrlKey,
              altKey,
              shiftKey,
              metaKey,
            };
            if (candidate.code != null) {
              eventInit.code = candidate.code;
            }

            const ev = new KeyboardEvent("keydown", eventInit);

            if (matchesKeybind(ev, a) && matchesKeybind(ev, b)) {
              return true;
            }
          }
        }
      }
    }
  }

  return false;
}

function validateSlotKeybindOverride(params: {
  slot: LayoutSlotNumber;
  keybind: Keybind;
  existing: Array<{ slot: LayoutSlotNumber; keybind: Keybind }>;
}): string | null {
  const hasModifier = [
    params.keybind.ctrl,
    params.keybind.alt,
    params.keybind.shift,
    params.keybind.meta,
  ].some((v) => v === true);
  if (!hasModifier) {
    return "Keybind must include at least one modifier key.";
  }

  for (const core of Object.values(KEYBINDS)) {
    if (keybindConflicts(params.keybind, core)) {
      return `Conflicts with an existing xum shortcut (${formatKeybind(core)}).`;
    }
  }

  for (const entry of params.existing) {
    if (entry.slot === params.slot) {
      continue;
    }
    if (keybindConflicts(params.keybind, entry.keybind)) {
      return `Conflicts with Slot ${entry.slot} (${formatKeybind(entry.keybind)}).`;
    }
  }

  return null;
}

interface PersistedWorkspaceSelection {
  workspaceId: string;
}

function isPersistedWorkspaceSelection(value: unknown): value is PersistedWorkspaceSelection {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<Record<keyof PersistedWorkspaceSelection, unknown>>;
  return typeof candidate.workspaceId === "string";
}

function formatWorkspaceLabel(projectName: string, namedWorkspacePath: string): string {
  return `${projectName}/${namedWorkspacePath.split("/").pop() ?? namedWorkspacePath}`;
}

export function LayoutsSection() {
  const {
    layoutPresets,
    loaded,
    loadFailed,
    applySlotToWorkspace,
    saveCurrentWorkspaceToSlot,
    renameSlot,
    deleteSlot,
    setSlotKeybindOverride,
  } = useUILayouts();
  const { selectedWorkspace, workspaceMetadata } = useWorkspaceContext();
  const { confirm: confirmDialog } = useConfirmDialog();

  const [actionError, setActionError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<{
    slot: LayoutSlotNumber;
    value: string;
    original: string;
  } | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  const [capturingSlot, setCapturingSlot] = useState<LayoutSlotNumber | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);

  // selectedWorkspace is URL-derived and becomes null on /settings routes.
  // Fall back to the last selected workspace so capture/apply actions remain usable.
  const persistedWorkspaceSelection = useMemo(() => {
    const raw = readPersistedState<unknown>(SELECTED_WORKSPACE_KEY, null);
    return isPersistedWorkspaceSelection(raw) ? raw : null;
  }, []);
  const fallbackWorkspaceMetadata = useMemo(() => {
    const fallbackWorkspaceId = persistedWorkspaceSelection?.workspaceId;
    if (!fallbackWorkspaceId) {
      return null;
    }

    return workspaceMetadata.get(fallbackWorkspaceId) ?? null;
  }, [persistedWorkspaceSelection, workspaceMetadata]);

  const workspaceId = selectedWorkspace?.workspaceId ?? fallbackWorkspaceMetadata?.id ?? null;
  const selectedWorkspaceLabel = selectedWorkspace
    ? formatWorkspaceLabel(selectedWorkspace.projectName, selectedWorkspace.namedWorkspacePath)
    : fallbackWorkspaceMetadata
      ? formatWorkspaceLabel(
          fallbackWorkspaceMetadata.projectName,
          fallbackWorkspaceMetadata.namedWorkspacePath
        )
      : null;

  const existingKeybinds = useMemo(() => {
    const existing: Array<{ slot: LayoutSlotNumber; keybind: Keybind }> = [];

    // Built-in defaults for Slots 1–9 are treated as "reserved" regardless of whether a preset
    // is assigned (so users don't accidentally create conflicts for later).
    for (const slot of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
      const keybind = getEffectiveSlotKeybind(layoutPresets, slot);
      assert(keybind, `Slot ${slot} must have a default keybind`);
      existing.push({ slot, keybind });
    }

    // Additional slots only participate in conflict detection if they have a custom override.
    for (const slotConfig of layoutPresets.slots) {
      if (slotConfig.slot <= 9) {
        continue;
      }
      if (!slotConfig.keybindOverride) {
        continue;
      }
      existing.push({ slot: slotConfig.slot, keybind: slotConfig.keybindOverride });
    }

    return existing;
  }, [layoutPresets]);

  const visibleSlots = useMemo(() => {
    return layoutPresets.slots
      .filter(
        (slot): slot is typeof slot & { preset: NonNullable<(typeof slot)["preset"]> } =>
          slot.preset !== undefined
      )
      .sort((a, b) => a.slot - b.slot);
  }, [layoutPresets]);

  const nextSlotNumber = useMemo((): LayoutSlotNumber => {
    const used = new Set<number>();
    for (const slot of layoutPresets.slots) {
      if (slot.preset) {
        used.add(slot.slot);
      }
    }

    let candidate = 1;
    while (used.has(candidate)) {
      candidate += 1;
    }

    return candidate;
  }, [layoutPresets]);

  const submitRename = async (slot: LayoutSlotNumber, nextName: string): Promise<void> => {
    const trimmed = nextName.trim();
    if (!trimmed) {
      setNameError("Name cannot be empty.");
      return;
    }

    try {
      await renameSlot(slot, trimmed);
      setEditingName(null);
      setNameError(null);
    } catch {
      setNameError("Failed to rename.");
    }
  };

  const handleAddLayout = async (): Promise<void> => {
    setActionError(null);

    if (!workspaceId) {
      setActionError("Select a workspace to capture its layout.");
      return;
    }

    try {
      const preset = await saveCurrentWorkspaceToSlot(
        workspaceId,
        nextSlotNumber,
        `Layout ${nextSlotNumber}`
      );
      setEditingName({ slot: nextSlotNumber, value: preset.name, original: preset.name });
      setNameError(null);
    } catch {
      setActionError("Failed to add layout.");
    }
  };

  const handleCaptureKeyDown = (
    slot: LayoutSlotNumber,
    e: React.KeyboardEvent<HTMLInputElement>
  ): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      stopKeyboardPropagation(e);
      setCapturingSlot(null);
      setCaptureError(null);
      return;
    }

    const captured = normalizeCapturedKeybind(e.nativeEvent);
    if (!captured) {
      return;
    }

    e.preventDefault();
    stopKeyboardPropagation(e);

    const error = validateSlotKeybindOverride({
      slot,
      keybind: captured,
      existing: existingKeybinds,
    });

    if (error) {
      setCaptureError(error);
      return;
    }

    void setSlotKeybindOverride(slot, captured).catch(() => {
      setCaptureError("Failed to save keybind override.");
    });

    setCapturingSlot(null);
    setCaptureError(null);
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-foreground text-sm font-medium">Layout Slots</h3>
        <div className="text-muted mt-1 text-xs">
          Layouts are saved globally and can be applied to any workspace.
        </div>
        <div className="text-muted mt-1 text-xs">
          Slots 1–9 have default Ctrl/Cmd+Alt+1..9 hotkeys. Additional layouts can be added and
          assigned custom hotkeys.
        </div>
        {selectedWorkspaceLabel ? null : (
          <div className="text-muted mt-1 text-xs">
            Select a workspace to capture or apply layouts.
          </div>
        )}
      </div>

      {!loaded ? <div className="text-muted text-sm">Loading…</div> : null}
      {loadFailed ? (
        <div className="text-muted text-sm">
          Failed to load layouts from config. Using defaults.
        </div>
      ) : null}
      {actionError ? <div className="text-sm text-red-500">{actionError}</div> : null}

      {visibleSlots.length > 0 ? (
        <div className="space-y-2">
          {visibleSlots.map((slotConfig) => {
            const slot = slotConfig.slot;
            const preset = slotConfig.preset;
            const effectiveKeybind = getEffectiveSlotKeybind(layoutPresets, slot);

            const isEditingName = editingName?.slot === slot;
            const isCapturing = capturingSlot === slot;

            const menuItems: KebabMenuItem[] = [
              {
                label: "Apply",
                disabled: !workspaceId,
                tooltip: workspaceId ? undefined : "Select a workspace to apply layouts.",
                onClick: () => {
                  setActionError(null);
                  if (!workspaceId) return;
                  void applySlotToWorkspace(workspaceId, slot).catch(() => {
                    setActionError("Failed to apply layout.");
                  });
                },
              },
              {
                label: "Update from current workspace",
                disabled: !workspaceId,
                tooltip: workspaceId ? undefined : "Select a workspace to capture its layout.",
                onClick: () => {
                  setActionError(null);
                  if (!workspaceId) {
                    setActionError("Select a workspace to capture its layout.");
                    return;
                  }

                  void saveCurrentWorkspaceToSlot(workspaceId, slot).catch(() => {
                    setActionError("Failed to update layout.");
                  });
                },
              },
              {
                label: "Delete layout",
                onClick: () => {
                  void (async () => {
                    const ok = await confirmDialog({
                      title: `Delete layout "${preset.name}"?`,
                      confirmLabel: "Delete",
                      confirmVariant: "destructive",
                    });
                    if (!ok) return;

                    setActionError(null);

                    setEditingName(null);
                    setCapturingSlot(null);
                    setCaptureError(null);

                    void deleteSlot(slot).catch(() => {
                      setActionError("Failed to delete layout.");
                    });
                  })();
                },
              },
            ];

            return (
              <div
                key={slot}
                className="border-border-medium bg-background-secondary flex flex-col gap-1 rounded border px-3 py-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="text-muted shrink-0 text-xs">Slot {slot}</div>

                    <div className="min-w-0 flex-1">
                      {isEditingName ? (
                        <input
                          className="bg-input-bg text-input-text border-input-border focus:border-input-border-focus w-full min-w-0 rounded-sm border px-1 text-sm outline-none"
                          value={editingName.value}
                          onChange={(e) =>
                            setEditingName({ ...editingName, value: e.target.value })
                          }
                          onKeyDown={(e) => {
                            stopKeyboardPropagation(e);

                            if (e.key === "Enter") {
                              e.preventDefault();
                              void submitRename(slot, editingName.value);
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              setEditingName(null);
                              setNameError(null);
                            }
                          }}
                          onBlur={() => void submitRename(slot, editingName.value)}
                          autoFocus
                          aria-label={`Rename layout Slot ${slot}`}
                        />
                      ) : (
                        <Tooltip disableHoverableContent>
                          <TooltipTrigger asChild>
                            <span
                              className="text-foreground block truncate text-sm font-medium"
                              onDoubleClick={(e) => {
                                e.stopPropagation();
                                setActionError(null);
                                setCapturingSlot(null);
                                setCaptureError(null);
                                setEditingName({
                                  slot,
                                  value: preset.name,
                                  original: preset.name,
                                });
                                setNameError(null);
                              }}
                              title="Double-click to rename"
                            >
                              {preset.name}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent align="start">Double-click to rename</TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {isCapturing ? (
                      <div className="flex items-center gap-1">
                        <div className="relative">
                          <kbd className="bg-background-secondary text-foreground border-border-medium rounded border px-2 py-0.5 font-mono text-xs">
                            Press keys…
                          </kbd>
                          <input
                            className="absolute inset-0 h-full w-full opacity-0"
                            autoFocus
                            onKeyDown={(e) => handleCaptureKeyDown(slot, e)}
                            aria-label={`Set hotkey for Slot ${slot}`}
                          />
                        </div>

                        {slotConfig.keybindOverride ? (
                          <Tooltip disableHoverableContent>
                            <TooltipTrigger asChild>
                              <Button
                                variant="secondary"
                                size="icon"
                                className="h-6 w-6 [&_svg]:size-3"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();

                                  setActionError(null);
                                  void setSlotKeybindOverride(slot, undefined)
                                    .then(() => {
                                      setCapturingSlot(null);
                                      setCaptureError(null);
                                    })
                                    .catch(() => {
                                      setCaptureError("Failed to reset hotkey.");
                                    });
                                }}
                                aria-label={
                                  slot <= 9
                                    ? `Reset hotkey for Slot ${slot}`
                                    : `Clear hotkey for Slot ${slot}`
                                }
                              >
                                <X />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent align="end">
                              {slot <= 9 ? "Reset to default" : "Clear hotkey"}
                            </TooltipContent>
                          </Tooltip>
                        ) : null}
                      </div>
                    ) : (
                      <Tooltip disableHoverableContent>
                        <TooltipTrigger asChild>
                          <kbd
                            className="bg-background-secondary text-foreground border-border-medium cursor-pointer rounded border px-2 py-0.5 font-mono text-xs"
                            onDoubleClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();

                              setActionError(null);
                              setEditingName(null);
                              setNameError(null);
                              setCapturingSlot(slot);
                              setCaptureError(null);
                            }}
                          >
                            {effectiveKeybind ? formatKeybind(effectiveKeybind) : "No hotkey"}
                          </kbd>
                        </TooltipTrigger>
                        <TooltipContent align="end">Double-click to change hotkey</TooltipContent>
                      </Tooltip>
                    )}

                    <KebabMenu items={menuItems} />
                  </div>
                </div>

                {isCapturing ? (
                  <div className="text-muted text-xs">
                    Press a key combo (Esc to cancel)
                    {captureError ? <div className="mt-1 text-red-500">{captureError}</div> : null}
                  </div>
                ) : null}

                {isEditingName && nameError ? (
                  <div className="text-xs text-red-500">{nameError}</div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      <Button
        variant="secondary"
        size="lg"
        className="w-full"
        disabled={!workspaceId}
        onClick={() => void handleAddLayout()}
      >
        <Plus />
        Add layout
      </Button>
    </div>
  );
}
