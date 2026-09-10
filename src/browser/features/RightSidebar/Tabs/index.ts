/**
 * Tab system for RightSidebar.
 *
 * Lightweight tab metadata lives in `tabConfig.ts`; React label/panel renderers
 * live in `tabRegistry.tsx`. This split keeps shared helpers and the VS Code
 * extension from eagerly importing desktop-only panel code while still giving
 * the desktop sidebar one typed registry surface.
 */

export {
  TAB_REGISTRY,
  isBaseTabId,
  type BaseTabType,
  type TabPanelContext,
  type ReviewStats,
} from "./tabRegistry";

export { getTabName, getTabContentClassName } from "./registry";

// Still exported for legacy/test consumers.
export { TerminalTabLabel } from "./TabLabels";
