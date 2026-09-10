/**
 * Backwards-compat shim for tab display helpers.
 *
 * This file remains so legacy callers can import `getTabContentClassName`,
 * `getTabName`, etc. without pulling in React panel renderers. New non-UI
 * helpers should depend on the lightweight `tabConfig` directly.
 */

import type { TabType } from "@/browser/types/rightSidebar";
import { getTabConfig, isBaseTabId } from "./tabConfig";
import type { ReviewStats as RegistryReviewStats } from "./tabRegistry";

/** Re-exported review stats type (used by RightSidebar wrapper props). */
export type ReviewStats = RegistryReviewStats;

/** Configuration for a terminal tab (still special-cased outside the registry). */
const TERMINAL_TAB_CONTENT_CLASS_NAME = "overflow-hidden p-0";
const TERMINAL_TAB_NAME = "Terminal";

/** Display name for a tab id (incl. terminal). */
export function getTabName(tab: TabType): string {
  if (isBaseTabId(tab)) return getTabConfig(tab).name;
  return TERMINAL_TAB_NAME;
}

/** Content container CSS classes for a tab id (incl. terminal). */
export function getTabContentClassName(tab: TabType): string {
  if (isBaseTabId(tab)) return getTabConfig(tab).contentClassName;
  return TERMINAL_TAB_CONTENT_CLASS_NAME;
}
