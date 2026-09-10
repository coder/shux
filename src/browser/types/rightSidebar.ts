/**
 * Right-sidebar tab types.
 *
 * Static (non-terminal) tab ids are derived from the lightweight tab config
 * (`@/browser/features/RightSidebar/Tabs/tabConfig`) so type-only consumers do
 * not import panel renderers. This file just lifts those ids to the
 * shared type space so other modules don't have to import the registry just
 * to pattern-match on tab ids.
 */

import { isBaseTabId, type BaseTabType } from "@/browser/features/RightSidebar/Tabs/tabConfig";
export type { BaseTabType };

/**
 * Extended tab type that supports multiple terminal instances.
 * - Terminal tabs: "terminal" (placeholder for new) or "terminal:<sessionId>" for real sessions
 */
export type TabType = BaseTabType | `terminal:${string}` | "terminal";

/** Check if a value is a valid tab type (base tab or terminal instance). */
export function isTabType(value: unknown): value is TabType {
  if (typeof value !== "string") return false;
  if (isBaseTabId(value)) return true;
  return value === "terminal" || value.startsWith("terminal:");
}

/** Check if a tab type represents a terminal (either base "terminal" or "terminal:<sessionId>"). */
export function isTerminalTab(tab: TabType): boolean {
  return tab === "terminal" || tab.startsWith("terminal:");
}

/**
 * Get the backend session ID from a terminal tab type.
 * Returns undefined for the placeholder "terminal" tab (new terminal being created).
 */
export function getTerminalSessionId(tab: TabType): string | undefined {
  if (tab === "terminal") return undefined;
  if (tab.startsWith("terminal:")) return tab.slice("terminal:".length);
  return undefined;
}

/** Create a terminal tab type for a given session ID. */
export function makeTerminalTabType(sessionId?: string): TabType {
  return sessionId ? `terminal:${sessionId}` : "terminal";
}

/** Default terminal tab name when no OSC title has been set (0-based index). */
export function getTerminalTabFallbackName(terminalIndex: number): string {
  return terminalIndex === 0 ? "Terminal" : `Terminal ${terminalIndex + 1}`;
}
