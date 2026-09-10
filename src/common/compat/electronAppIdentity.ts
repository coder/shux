import { XUM_PRODUCT_NAME, XUM_PRODUCT_SLUG } from "@/common/constants/product";

export interface ElectronAppIdentity {
  /** Value for `app.setName()` / `app.getName()` (menus, about). */
  appName: string;
  /**
   * Directory name under Electron `appData` for `userData`.
   * Always the lowercase slug so display-cased `app.setName()` cannot fork storage.
   */
  userDataDirName: string;
  /** Linux-only desktop-file identity for WM_CLASS / Wayland app_id. */
  chromeDesktop: string | undefined;
}

/**
 * Split display identity from desktop/userData identity.
 *
 * Linux still needs the lowercase slug for WM_CLASS, native-Wayland app_id,
 * `.desktop` files, and icon names. macOS/Windows should keep the product
 * display name so the application menu is `Xum`, not `xum`.
 */
export function getElectronAppIdentity(platform: NodeJS.Platform): ElectronAppIdentity {
  const isLinux = platform === "linux";
  return {
    appName: isLinux ? XUM_PRODUCT_SLUG : XUM_PRODUCT_NAME,
    userDataDirName: XUM_PRODUCT_SLUG,
    chromeDesktop: isLinux ? `${XUM_PRODUCT_SLUG}.desktop` : undefined,
  };
}
