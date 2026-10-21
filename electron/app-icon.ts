import path from "path";

/**
 * Path of the brand icon shipped with the app (`build/` is copied into the
 * asar through `files:` in electron-builder.yml, so this resolves both in dev
 * (`app.getAppPath()` = repo root) and when packaged (`…/resources/app.asar`).
 */
export function getAppIconPath(appPath: string, platform: NodeJS.Platform = process.platform): string {
  const iconName =
    platform === "darwin" ? "icon.icns" : platform === "linux" ? "icon.png" : "icon.ico";
  return path.join(appPath, "build", iconName);
}
