/**
 * Desktop titlebar utilities for Electron's integrated titlebar.
 *
 * In Electron mode (window.api exists), the native titlebar is hidden and we need:
 * 1. Drag regions for window dragging
 * 2. Insets for native window controls (traffic lights on mac, overlay on win/linux)
 *
 * In browser/mux server mode, these are no-ops.
 *
 * ## Architecture
 *
 * Titlebar insets are centralized via CSS custom properties:
 * - `--titlebar-left-inset`: Space for macOS traffic lights (80px on darwin, 0 elsewhere)
 * - `--titlebar-right-inset`: Space for Windows/Linux overlay (138px on win32/linux, 0 elsewhere)
 *
 * Call `initTitlebarInsets()` once at app startup to set these properties on :root.
 * Components then use `var(--titlebar-left-inset)` in CSS/styles without needing
 * to import platform detection logic.
 */

/**
 * Whether we're running in Electron desktop mode.
 * Checks for getIsRosetta function which only exists in real Electron preload,
 * not in story mocks that just set window.api for testing specific features.
 */
export function isDesktopMode(): boolean {
  return typeof window !== "undefined" && typeof window.api?.getIsRosetta === "function";
}

/**
 * Returns the platform string in desktop mode, undefined in browser mode.
 */
export function getDesktopPlatform(): NodeJS.Platform | undefined {
  return window.api?.platform;
}

/**
 * Left inset (in pixels) to reserve for macOS traffic lights.
 * Only applies in Electron + macOS.
 *
 * The value accounts for the traffic lights (~68px) plus comfortable padding.
 */
export const MAC_TRAFFIC_LIGHTS_INSET = 80;

/**
 * Right inset (in pixels) to reserve for Windows/Linux titlebar overlay buttons.
 * Only applies in Electron + Windows/Linux.
 *
 * The value accounts for min/max/close buttons (~138px on Windows).
 */
export const WIN_LINUX_OVERLAY_INSET = 138;

/**
 * Desktop titlebar height in pixels. Keep in sync with the Tailwind classes below.
 */
export const DESKTOP_TITLEBAR_HEIGHT_PX = 36;

/**
 * Tailwind height classes for the desktop titlebar.
 * Use these in components that need to align with the titlebar height.
 */
export const DESKTOP_TITLEBAR_HEIGHT_CLASS = "h-9";
export const DESKTOP_TITLEBAR_MIN_HEIGHT_CLASS = "min-h-9";

/**
 * Returns the left inset needed for macOS traffic lights.
 * Returns 0 if not in desktop mode or not on macOS.
 */
export function getTitlebarLeftInset(): number {
  if (!isDesktopMode()) return 0;
  if (getDesktopPlatform() === "darwin") return MAC_TRAFFIC_LIGHTS_INSET;
  return 0;
}

/**
 * Returns the right inset needed for Windows/Linux titlebar overlay.
 * Returns 0 if not in desktop mode or on macOS.
 */
export function getTitlebarRightInset(): number {
  if (!isDesktopMode()) return 0;
  const platform = getDesktopPlatform();
  if (platform === "win32" || platform === "linux") return WIN_LINUX_OVERLAY_INSET;
  return 0;
}

/**
 * Initialize CSS custom properties for titlebar insets.
 * Call once at app startup. Sets:
 * - `--titlebar-left-inset`: macOS traffic lights (80px) or 0
 * - `--titlebar-right-inset`: Windows/Linux overlay (138px) or 0
 *
 * Components can then use these variables without importing platform logic:
 * ```css
 * padding-left: var(--titlebar-left-inset, 0px);
 * ```
 */
export function initTitlebarInsets(): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  root.style.setProperty("--titlebar-left-inset", `${getTitlebarLeftInset()}px`);
  root.style.setProperty("--titlebar-right-inset", `${getTitlebarRightInset()}px`);
}
