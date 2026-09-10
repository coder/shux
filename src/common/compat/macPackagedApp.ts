/**
 * electron-builder names the macOS `.app` directory and `CFBundleExecutable`
 * from `AppInfo.productFilename`, not from display `productName`.
 *
 * In app-builder-lib 24.13.3, `productFilename` is `sanitize(executableName)`
 * when `build.executableName` is set, otherwise sanitized `productName`.
 * `macPackager.applyCommonInfo` assigns that value to `CFBundleExecutable`,
 * and `electronMac.createMacApp` renames Electron.app to `${productFilename}.app`.
 *
 * Do not infer the bundle name from `productName` casing. Default macOS
 * volumes fold case, so `stat("xum.app")` can succeed even when `readdir`
 * stored `Xum.app`.
 */
export function resolveMacPackagedAppNames(build: {
  productName?: string;
  executableName?: string | null;
}): { productFilename: string; appBundleName: string } {
  const productFilename = build.executableName ?? build.productName;
  if (productFilename == null || productFilename.length === 0) {
    throw new Error(
      "build.executableName or build.productName is required to name the macOS app bundle"
    );
  }
  return { productFilename, appBundleName: `${productFilename}.app` };
}
