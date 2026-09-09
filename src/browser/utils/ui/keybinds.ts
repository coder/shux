/**
 * Centralized keybind utilities for consistent keyboard shortcut handling
 * and OS-aware display across the application.
 *
 * NOTE: This file is the source of truth for keybind definitions.
 * When adding/modifying keybinds, update docs/keybinds.md ONLY if the keybind
 * is not discoverable in the UI (e.g., no tooltip, placeholder text, or visible hint).
 */

import { stopKeyboardPropagation } from "@/browser/utils/events";
import type { Keybind } from "@/common/types/keybind";

export type { Keybind };

/**
 * Detect if running on macOS
 */
export function isMac(): boolean {
  try {
    if (typeof window === "undefined") return false;

    // Prefer Electron's preload API when available.
    interface MinimalAPI {
      platform?: string;
    }
    // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
    const api = (window as unknown as { api?: MinimalAPI }).api;
    if (api?.platform != null) {
      return api.platform === "darwin";
    }

    // Browser mode fallback: detect platform via Navigator.
    if (typeof navigator === "undefined") return false;
    interface MinimalNavigator {
      platform?: string;
      userAgent?: string;
      userAgentData?: {
        platform?: string;
      };
    }
    // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
    const nav = navigator as unknown as MinimalNavigator;
    const platform = nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? "";
    return /mac|iphone|ipad|ipod/i.test(platform);
  } catch {
    return false;
  }
}

/**
 * Check if a keyboard event matches a keybind definition.
 * On macOS, ctrl in the definition defaults to matching Ctrl or Cmd unless overridden.
 */
export function matchesKeybind(
  event: React.KeyboardEvent | KeyboardEvent,
  keybind: Keybind
): boolean {
  const expectedCode = keybind.code?.trim();
  if (expectedCode) {
    // Prefer KeyboardEvent.code when provided so shifted punctuation shortcuts
    // remain stable even when event.key changes by layout (e.g. Shift+. => ">" on US).
    if (!event.code || event.code.toLowerCase() !== expectedCode.toLowerCase()) {
      return false;
    }
  } else {
    // Guard against undefined event.key (can happen with dead keys, modifier-only events, etc.)
    if (!event.key) {
      return false;
    }

    // Check key match (case-insensitive for letters)
    if (event.key.toLowerCase() !== keybind.key.toLowerCase()) {
      return false;
    }
  }

  const onMac = isMac();
  const macCtrlBehavior = keybind.macCtrlBehavior ?? "either";
  const ctrlPressed = event.ctrlKey;
  const metaPressed = event.metaKey;

  let ctrlRequired = false;
  let ctrlAllowed = false;
  let metaRequired = keybind.meta ?? false;
  let metaAllowed = metaRequired;

  if (keybind.ctrl) {
    if (onMac) {
      switch (macCtrlBehavior) {
        case "control": {
          ctrlRequired = true;
          ctrlAllowed = true;
          // Only allow Cmd if explicitly requested via meta flag
          break;
        }
        case "command": {
          metaRequired = true;
          metaAllowed = true;
          ctrlAllowed = true;
          break;
        }
        case "either": {
          ctrlAllowed = true;
          metaAllowed = true;
          if (!ctrlPressed && !metaPressed) return false;
          break;
        }
      }
    } else {
      ctrlRequired = true;
      ctrlAllowed = true;
    }
  } else {
    ctrlAllowed = false;
  }

  if (ctrlRequired && !ctrlPressed) return false;
  if (!ctrlAllowed && ctrlPressed) return false;

  const allowShift = keybind.allowShift ?? false;

  if (keybind.shift && !event.shiftKey) return false;
  if (!keybind.shift && !allowShift && event.shiftKey) return false;

  if (keybind.alt && !event.altKey) return false;
  if (!keybind.alt && event.altKey) return false;

  if (metaRequired && !metaPressed) return false;

  if (!metaAllowed) {
    // If Cmd is allowed implicitly via ctrl behavior, mark it now
    if (onMac && keybind.ctrl && macCtrlBehavior !== "control") {
      metaAllowed = true;
    }
  }

  if (!metaAllowed && metaPressed) {
    return false;
  }

  return true;
}

/**
 * Check if the event target is an editable element (input, textarea, select, contentEditable).
 * Used to prevent global keyboard shortcuts from interfering with text input.
 */
export function isEditableElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    target.contentEditable === "true"
  );
}

/**
 * Data attribute used to identify terminal containers.
 * Used by isTerminalFocused() to detect when keyboard events should be
 * routed to the terminal instead of handled globally.
 */
export const TERMINAL_CONTAINER_ATTR = "data-terminal-container";

/**
 * Data attribute used to identify focused browser viewports.
 * Used by isBrowserViewportFocused() to let the live browser session keep browser-owned
 * keystrokes instead of having capture/bubble-phase app shortcuts steal them first.
 */
export const BROWSER_VIEWPORT_ATTR = "data-browser-viewport";
export const DESKTOP_VIEWPORT_ATTR = "data-desktop-viewport";

export function isDesktopViewportFocused(target: EventTarget | null): boolean {
  return hasClosestWithAttr(target, DESKTOP_VIEWPORT_ATTR);
}

/**
 * Data attribute used to opt an element (or one of its ancestors) into allowing Escape
 * to interrupt streams, even when the event target is editable (input/textarea/etc).
 *
 * This is intentionally opt-in to keep Escape safe-by-default in text inputs.
 */
export const ESCAPE_INTERRUPTS_STREAM_ATTR = "data-escape-interrupts-stream";

/**
 * Check whether the event target (or an ancestor) carries the given data attribute.
 * Shared guard for isTerminalFocused, isBrowserViewportFocused, and
 * allowsEscapeToInterruptStream — all three previously duplicated the same
 * null → HTMLElement → closest() boilerplate.
 */
function hasClosestWithAttr(target: EventTarget | null, attr: string): boolean {
  if (!target) {
    return false;
  }
  // Check if HTMLElement exists (not available in non-DOM test environments)
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) {
    return false;
  }
  return target.closest(`[${attr}]`) !== null;
}

export function allowsEscapeToInterruptStream(target: EventTarget | null): boolean {
  return hasClosestWithAttr(target, ESCAPE_INTERRUPTS_STREAM_ATTR);
}

/**
 * Check if the event target is inside a terminal container.
 * Used to let terminal components handle their own keyboard shortcuts
 * (like Ctrl+C for SIGINT) instead of intercepting them globally.
 */
export function isTerminalFocused(target: EventTarget | null): boolean {
  return hasClosestWithAttr(target, TERMINAL_CONTAINER_ATTR);
}

/**
 * Check if the event target is inside a browser viewport container.
 * Used by global keyboard handlers to avoid stealing keystrokes from live browser sessions.
 */
export function isBrowserViewportFocused(target: EventTarget | null): boolean {
  return hasClosestWithAttr(target, BROWSER_VIEWPORT_ATTR);
}

/**
 * Check if a modal dialog is currently open.
 * Used by capture-phase keyboard handlers to skip shortcuts while a modal is active,
 * since bubble-phase stopPropagation from dialog onKeyDown can't block capture-phase listeners.
 *
 * Only matches true modal dialogs (aria-modal="true"), not non-modal Radix popovers
 * which also use role="dialog" but should not suppress global shortcuts.
 */
export function isDialogOpen(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

/**
 * Format a keybind for display to users.
 * Returns Mac-style symbols on macOS, or Windows-style text elsewhere.
 */
export function formatKeybind(keybind: Keybind): string {
  const parts: string[] = [];

  if (isMac()) {
    // Mac-style formatting with symbols (using Unicode escapes for safety)
    // For ctrl on Mac, we actually mean Cmd in most cases since matcher treats them as equivalent
    if (keybind.ctrl && !keybind.meta) {
      const macCtrlBehavior = keybind.macCtrlBehavior ?? "either";
      if (macCtrlBehavior === "control") {
        parts.push("\u2303"); // ⌃ Control
      } else {
        parts.push("\u2318"); // ⌘ Command
      }
    } else if (keybind.ctrl) {
      parts.push("\u2303"); // ⌃ Control
    }
    if (keybind.alt) parts.push("\u2325"); // ⌥ Option
    if (keybind.shift) parts.push("\u21E7"); // ⇧ Shift
    if (keybind.meta) parts.push("\u2318"); // ⌘ Command
  } else {
    // Windows/Linux-style formatting with text
    if (keybind.ctrl) parts.push("Ctrl");
    if (keybind.alt) parts.push("Alt");
    if (keybind.shift) parts.push("Shift");
    if (keybind.meta) parts.push("Meta");
  }

  // Add the key (handle special cases, then capitalize single letters)
  let key: string;
  if (keybind.key === " ") {
    key = "Space";
  } else if (keybind.key.length === 1) {
    key = keybind.key.toUpperCase();
  } else {
    key = keybind.key;
  }
  parts.push(key);

  return isMac() ? parts.join("\u00B7") : parts.join("+"); // · on Mac, + elsewhere
}

/**
 * Whether a keybind is deprecated. Deprecated keybinds still match/fire, but
 * generated keybind references (e.g. Settings → Keybinds) filter them out so we
 * don't advertise legacy shortcuts to users.
 */
export function isKeybindDeprecated(keybind: Keybind): boolean {
  return keybind.deprecated === true;
}

/**
 * Centralized registry of application keybinds.
 * Single source of truth for all keyboard shortcuts.
 * In general we try to use shortcuts the user would naturally expect.
 * We also like vim keybinds.
 */
export const KEYBINDS = {
  /** Copy selected transcript Markdown while its context menu is open. */
  COPY_MARKDOWN: { key: "m" },

  /** Open agent picker (focuses search) */
  TOGGLE_AGENT: { key: "A", ctrl: true, shift: true },

  /** Cycle to next manual agent without opening picker */
  // Use the physical Period key so Cmd+. keeps working on macOS and layouts
  // where KeyboardEvent.key varies for this shortcut.
  CYCLE_AGENT: { key: ".", code: "Period", ctrl: true, allowShift: true },

  /** Send message / Submit form */
  SEND_MESSAGE: { key: "Enter" },

  /** Send an existing queued message immediately */
  SEND_QUEUED_MESSAGE_NOW: { key: "Enter", ctrl: true, shift: true },

  /** Send message after current turn ends */
  SEND_MESSAGE_AFTER_TURN: { key: "Enter", ctrl: true },

  /** Insert newline in text input */
  NEW_LINE: { key: "Enter", shift: true },

  /** Cancel current action / Close modal (excludes stream interruption) */
  CANCEL: { key: "Escape" },

  /** Cancel editing message (exit edit mode) */
  CANCEL_EDIT: { key: "Escape" },

  /** Save edit (Cmd/Ctrl+Enter) */
  SAVE_EDIT: { key: "Enter", ctrl: true },

  /** Interrupt active stream (destructive - stops AI generation) */
  // Vim mode: Ctrl+C (familiar from terminal interrupt)
  // Non-Vim mode: Esc (intuitive cancel/stop key)
  INTERRUPT_STREAM_VIM: { key: "c", ctrl: true, macCtrlBehavior: "control" },
  INTERRUPT_STREAM_NORMAL: { key: "Escape" },

  /** Continue an interrupted stream (R = resume; transcript-focused, like Shift+G) */
  RESUME_STREAM: { key: "R", shift: true },

  /** Focus chat input */
  FOCUS_INPUT_I: { key: "i" },

  /** Focus chat input (alternate) */
  FOCUS_INPUT_A: { key: "a" },

  /** Create new workspace for current project */
  NEW_WORKSPACE: { key: "n", ctrl: true },

  /** Create a project-less scratch chat */
  NEW_SCRATCH_CHAT: { key: "n", ctrl: true, shift: true },

  /** Edit title of current workspace (inline edit) */
  EDIT_WORKSPACE_TITLE: { key: "F2" },

  /** Generate new title for current workspace via AI */
  GENERATE_WORKSPACE_TITLE: { key: "F2", shift: true },

  /** Archive current workspace */
  // macOS: Cmd+Shift+Backspace, Win/Linux: Ctrl+Shift+Backspace
  ARCHIVE_WORKSPACE: { key: "Backspace", ctrl: true, shift: true, macCtrlBehavior: "command" },

  /** Pin/unpin current workspace (chat) in the sidebar */
  // Use the physical P key: macOS Option+P produces "π" for event.key, so match on code.
  PIN_WORKSPACE: { key: "p", code: "KeyP", ctrl: true, alt: true },

  /** Move the selected pinned chat up/down within its pinned block */
  // Same ctrl+alt layer as PIN_WORKSPACE. Arrow keys are unaffected by macOS
  // Option remapping, so matching on key alone is safe here.
  MOVE_PINNED_UP: { key: "ArrowUp", ctrl: true, alt: true },
  MOVE_PINNED_DOWN: { key: "ArrowDown", ctrl: true, alt: true },

  /** Jump to bottom of chat */
  JUMP_TO_BOTTOM: { key: "G", shift: true },

  /** Load older transcript messages when pagination is available */
  LOAD_OLDER_MESSAGES: { key: "h", shift: true },

  /** Navigate to next workspace in current project */
  NEXT_WORKSPACE: { key: "j", ctrl: true },

  /** Navigate to previous workspace in current project */
  PREV_WORKSPACE: { key: "k", ctrl: true },

  /** Toggle sidebar visibility */
  // VS Code-style quick toggle
  // macOS: Cmd+P, Win/Linux: Ctrl+P
  TOGGLE_SIDEBAR: { key: "P", ctrl: true },

  /** Cycle through configured models */
  CYCLE_MODEL: { key: "/", ctrl: true },

  /** Open new integrated terminal tab in sidebar */
  // macOS: Cmd+T, Win/Linux: Ctrl+T
  OPEN_TERMINAL: { key: "T", ctrl: true },

  /** Open workspace in editor */
  // macOS: Cmd+Shift+E, Win/Linux: Ctrl+Shift+E
  OPEN_IN_EDITOR: { key: "E", ctrl: true, shift: true },

  /** Configure MCP servers for current workspace */
  // macOS: Cmd+Shift+M, Win/Linux: Ctrl+Shift+M
  CONFIGURE_MCP: { key: "M", ctrl: true, shift: true },

  /** Configure heartbeat settings for current workspace */
  // macOS: Cmd+Shift+H, Win/Linux: Ctrl+Shift+H
  CONFIGURE_HEARTBEAT: { key: "H", ctrl: true, shift: true },

  /** Open Command Palette */
  // VS Code-style palette
  // macOS: Cmd+Shift+P, Win/Linux: Ctrl+Shift+P
  OPEN_COMMAND_PALETTE: { key: "P", ctrl: true, shift: true },

  /** Open Command Palette directly in command mode (prefills ">") */
  // F4 avoids browser-level collisions with Ctrl/Cmd+Shift+P in Firefox.
  OPEN_COMMAND_PALETTE_ACTIONS: { key: "F4" },

  /**
   * @deprecated Superseded by INCREASE_THINKING / DECREASE_THINKING.
   * Cycles the thinking level forward, wrapping at the ends. Still honored so
   * existing muscle memory keeps working, but marked `deprecated` so it stays
   * out of generated keybind references (Settings → Keybinds, docs).
   */
  // macOS: Cmd+Shift+T, Win/Linux: Ctrl+Shift+T
  TOGGLE_THINKING: { key: "T", ctrl: true, shift: true, deprecated: true },

  /** Increase thinking level by one step (clamps at the model's maximum) */
  // macOS: Cmd+Shift+], Win/Linux: Ctrl+Shift+]
  // `code` pins the physical bracket key so Shift producing "}" doesn't break matching.
  INCREASE_THINKING: { key: "]", code: "BracketRight", ctrl: true, shift: true },

  /** Decrease thinking level by one step (clamps at the model's minimum / off) */
  // macOS: Cmd+Shift+[, Win/Linux: Ctrl+Shift+[
  // `code` pins the physical bracket key so Shift producing "{" doesn't break matching.
  DECREASE_THINKING: { key: "[", code: "BracketLeft", ctrl: true, shift: true },

  /** Toggle OpenAI fast mode for the selected workspace model */
  // macOS: Cmd+Shift+F, Win/Linux: Ctrl+Shift+F
  TOGGLE_FAST_MODE: { key: "F", ctrl: true, shift: true },

  /** Focus chat input from anywhere */
  // Works even when focus is already in an input field
  // macOS: Cmd+I, Win/Linux: Ctrl+I
  FOCUS_CHAT: { key: "I", ctrl: true },

  /** Close current tab in right sidebar (if closeable - currently only terminal tabs) */
  // macOS: Cmd+W (matches Ghostty), Win/Linux: Ctrl+W
  CLOSE_TAB: { key: "w", ctrl: true, macCtrlBehavior: "command" },

  /** Reveal the selected timeline event in the transcript */
  REVEAL_TIMELINE_EVENT: { key: "Enter", ctrl: true, shift: true },

  /** Open the timeline dialog on small viewports where the right sidebar is hidden */
  OPEN_TIMELINE_DIALOG: { key: "t", shift: true },

  /** Reveal the last prompt in the transcript while its popup is open */
  REVEAL_LAST_PROMPT: { key: "Enter", ctrl: true, alt: true },

  /** Switch to tab by position in right sidebar (1-9) */
  // macOS: Cmd+N, Win/Linux: Ctrl+N
  // NOTE: Both Ctrl and Cmd work for switching tabs on Mac (macOS has no standard Cmd+number behavior)
  SIDEBAR_TAB_1: { key: "1", ctrl: true, description: "Tab 1" },
  SIDEBAR_TAB_2: { key: "2", ctrl: true, description: "Tab 2" },
  SIDEBAR_TAB_3: { key: "3", ctrl: true, description: "Tab 3" },
  SIDEBAR_TAB_4: { key: "4", ctrl: true, description: "Tab 4" },
  SIDEBAR_TAB_5: { key: "5", ctrl: true, description: "Tab 5" },
  SIDEBAR_TAB_6: { key: "6", ctrl: true, description: "Tab 6" },
  SIDEBAR_TAB_7: { key: "7", ctrl: true, description: "Tab 7" },
  SIDEBAR_TAB_8: { key: "8", ctrl: true, description: "Tab 8" },
  SIDEBAR_TAB_9: { key: "9", ctrl: true, description: "Tab 9" },

  /** Refresh diff in Code Review panel */
  // macOS: Cmd+R, Win/Linux: Ctrl+R
  REFRESH_REVIEW: { key: "r", ctrl: true },

  /** Focus search input in Code Review panel */
  // macOS: Cmd+F, Win/Linux: Ctrl+F
  FOCUS_REVIEW_SEARCH: { key: "f", ctrl: true },

  /** Focus search input in Code Review panel (quick) */
  // GitHub-style: / to focus search
  FOCUS_REVIEW_SEARCH_QUICK: { key: "/", allowShift: true },

  /** Mark selected hunk as read/unread in Code Review panel */
  TOGGLE_HUNK_READ: { key: "m" },

  /** Mark selected hunk as read in Code Review panel */
  MARK_HUNK_READ: { key: "r" },

  /** Mark selected hunk as unread in Code Review panel, or undo the last read hunk in immersive review */
  MARK_HUNK_UNREAD: { key: "u" },

  /** Mark entire file (all hunks) as read in Code Review panel */
  MARK_FILE_READ: { key: "M", shift: true },

  /** Toggle hunk expand/collapse in Code Review panel */
  TOGGLE_HUNK_COLLAPSE: { key: " " },

  /** Open settings modal */
  // macOS: Cmd+, Win/Linux: Ctrl+,
  OPEN_SETTINGS: { key: ",", ctrl: true },

  /** Open analytics dashboard */
  // macOS: Cmd+Shift+Y, Win/Linux: Ctrl+Shift+Y
  // "Y" for analYtics — Ctrl+. is reserved for CYCLE_AGENT
  OPEN_ANALYTICS: { key: "Y", ctrl: true, shift: true },

  /** Toggle voice input (dictation) */
  // macOS: Cmd+D, Win/Linux: Ctrl+D
  // "D" for Dictate - intuitive and available
  TOGGLE_VOICE_INPUT: { key: "d", ctrl: true },

  /** Navigate back in history */
  // macOS: Cmd+[, Win/Linux: Ctrl+[
  // Standard browser/editor back navigation
  NAVIGATE_BACK: { key: "[", ctrl: true },

  /** Navigate forward in history */
  // macOS: Cmd+], Win/Linux: Ctrl+]
  // Standard browser/editor forward navigation
  NAVIGATE_FORWARD: { key: "]", ctrl: true },

  /** Toggle notifications on response for current workspace */
  // macOS: Cmd+Shift+N, Win/Linux: Ctrl+Shift+N
  // "N" for Notifications
  TOGGLE_NOTIFICATIONS: { key: "N", ctrl: true, shift: true },

  TOGGLE_DRIFT_MODE: { key: "G", ctrl: true, shift: true },

  SHOW_WORKSPACE_DETAILS: { key: "D", ctrl: true, shift: true },

  SHOW_LAST_PROMPT: { key: "L", ctrl: true, shift: true },

  SETTINGS_BACKUP_SAVE: { key: "s", code: "KeyS", ctrl: true, alt: true },
  SETTINGS_BACKUP_VALIDATE: { key: "v", code: "KeyV", ctrl: true, alt: true },
  SETTINGS_BACKUP_PREVIEW: { key: "e", code: "KeyE", ctrl: true, alt: true },
  SETTINGS_BACKUP_PUSH: { key: "b", code: "KeyB", ctrl: true, alt: true },
  SETTINGS_BACKUP_RESTORE: { key: "r", code: "KeyR", ctrl: true, alt: true },
  SETTINGS_BACKUP_OVERRIDE_SECRET_SCAN: { key: "o", code: "KeyO", ctrl: true, alt: true },
  SETTINGS_BACKUP_APPROVE_COMMANDS: { key: "a", code: "KeyA", ctrl: true, alt: true },
  // Not Ctrl+Alt+P: that is PIN_WORKSPACE, which is global.
  SETTINGS_BACKUP_TOGGLE_PROJECTS: { key: "j", code: "KeyJ", ctrl: true, alt: true },

  /** Confirm action in confirmation dialogs */
  CONFIRM_DIALOG_YES: { key: "y", allowShift: true },

  /** Cancel/dismiss confirmation dialogs */
  CONFIRM_DIALOG_NO: { key: "n", allowShift: true },

  /** Toggle immersive review mode */
  TOGGLE_REVIEW_IMMERSIVE: { key: "i", shift: true },

  /**
   * Toggle the Assisted (agent-flagged hunks only) filter in the Code Review panel.
   *
   * Plain "p" (Pin filter) — chosen to avoid the global FOCUS_INPUT_A
   * collision on plain "a" and the dual-handler clash with
   * `TOGGLE_PLAN_ANNOTATE` on Shift+A. The review-panel handler already
   * gates on `isPanelFocused` + `isEditableElement`, so this single-letter
   * binding only fires when the user is genuinely in the review pane.
   */
  TOGGLE_ASSISTED_REVIEW: { key: "p" },

  /** Navigate to next file in immersive review */
  REVIEW_NEXT_FILE: { key: "l" },

  /** Navigate to previous file in immersive review */
  REVIEW_PREV_FILE: { key: "h" },

  /** Navigate to next hunk in immersive review */
  REVIEW_NEXT_HUNK: { key: "j" },

  /** Navigate to previous hunk in immersive review */
  REVIEW_PREV_HUNK: { key: "k" },

  /** Move line cursor down in immersive review */
  REVIEW_CURSOR_DOWN: { key: "ArrowDown", allowShift: true },

  /** Move line cursor up in immersive review */
  REVIEW_CURSOR_UP: { key: "ArrowUp", allowShift: true },

  /** Jump line cursor 10 lines down in immersive review */
  REVIEW_CURSOR_JUMP_DOWN: { key: "ArrowDown", ctrl: true, allowShift: true },

  /** Jump line cursor 10 lines up in immersive review */
  REVIEW_CURSOR_JUMP_UP: { key: "ArrowUp", ctrl: true, allowShift: true },

  /** Quick "I like this" feedback in immersive review */
  REVIEW_QUICK_LIKE: { key: "l", shift: true },

  /** Quick "I don't like this" feedback in immersive review */
  REVIEW_QUICK_DISLIKE: { key: "d", shift: true },

  /** Add comment in immersive review */
  REVIEW_COMMENT: { key: "c", shift: true },

  /** Toggle focus between diff and notes sidebar in immersive review */
  REVIEW_FOCUS_NOTES: { key: "Tab" },

  /** Copy the active file's full contents to the clipboard in immersive review */
  REVIEW_COPY_FILE: { key: "y" },

  /** Toggle plan annotation mode in propose_plan */
  TOGGLE_PLAN_ANNOTATE: { key: "a", shift: true },

  /** Copy image to clipboard (scoped to image lightbox / image context menu) */
  IMAGE_COPY: { key: "c", ctrl: true },

  /** Download image (scoped to image lightbox / image context menu) */
  IMAGE_DOWNLOAD: { key: "s", ctrl: true },

  TOGGLE_POWER_MODE: { key: "F12", shift: true },
} as const;

/**
 * Create a keyboard event handler for inline edit inputs.
 * Handles Enter to save and Escape to cancel (with stopPropagation to prevent modal close).
 */
export function createEditKeyHandler(options: {
  onSave: () => void;
  onCancel: () => void;
}): (e: React.KeyboardEvent) => void {
  return (e) => {
    if (e.key === "Enter") {
      options.onSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      stopKeyboardPropagation(e);
      options.onCancel();
    }
  };
}

/**
 * Format a numbered quick-select keybind (Cmd/Ctrl+1 through Cmd/Ctrl+9).
 * Returns empty string for indices outside 0-8 range.
 * @param index Zero-based index (0 = Cmd/Ctrl+1, 8 = Cmd/Ctrl+9)
 */
export function formatNumberedKeybind(index: number): string {
  if (index < 0 || index > 8) return "";
  const num = index + 1;
  return isMac() ? `\u2318${num}` : `Ctrl+${num}`;
}

/**
 * Check if a keyboard event matches a numbered quick-select keybind (Cmd/Ctrl+1-9).
 * @returns The zero-based index (0-8) if matched, or -1 if not matched
 */
export function matchNumberedKeybind(event: KeyboardEvent): number {
  const modKey = isMac() ? event.metaKey : event.ctrlKey;
  if (!modKey) return -1;
  if (event.key < "1" || event.key > "9") return -1;
  return parseInt(event.key, 10) - 1;
}
