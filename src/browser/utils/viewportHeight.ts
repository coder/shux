import { isIosStandaloneWebApp } from "@/browser/utils/env";

export const APP_VIEWPORT_HEIGHT_PROPERTY = "--app-viewport-height";

function syncViewportHeight(): void {
  document.documentElement.style.setProperty(
    APP_VIEWPORT_HEIGHT_PROPERTY,
    `${window.innerHeight}px`
  );
}

/**
 * Size the app shell from window.innerHeight on iOS home-screen web apps, where iOS 26 can
 * resolve 100dvh as if a browser toolbar were still present and leave a blank band under
 * the footer. Other environments keep the CSS dvh fallback.
 */
export function installViewportHeightSync(): () => void {
  if (!isIosStandaloneWebApp()) {
    return () => undefined;
  }

  syncViewportHeight();
  window.addEventListener("resize", syncViewportHeight);

  return () => {
    window.removeEventListener("resize", syncViewportHeight);
    document.documentElement.style.removeProperty(APP_VIEWPORT_HEIGHT_PROPERTY);
  };
}
