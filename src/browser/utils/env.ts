/**
 * Environment helpers for the browser/renderer runtime.
 */

export function isVscodeWebview(): boolean {
  return typeof (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi === "function";
}

/**
 * `navigator.standalone` exists only on iOS WebKit and is true only when
 * launched from a Home Screen icon, so this never matches desktop PWAs or Android.
 */
export function isIosStandaloneWebApp(): boolean {
  return (navigator as Navigator & { standalone?: unknown }).standalone === true;
}
