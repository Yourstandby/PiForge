/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Windows-only electron-builder workaround (stage 11 module 4).
 *
 * Electron-builder generates a temporary installer with BUILD_UNINSTALLER and
 * executes it to extract the uninstaller. In restricted Windows shells that
 * execution fails inside NSIS with:
 *   AssignProcessToJobObject: (6) The handle is invalid.
 *
 * The installer file already contains the uninstaller payload. electron-builder
 * ships UninstallerReader (used on macOS Catalina) that extracts it without
 * executing anything. Patch WineVmManager.exec for that one call.
 */
if (process.platform === "win32") {
  const path = require("node:path");
  const { WineVmManager } = require("app-builder-lib/out/vm/WineVm.js");
  const { AppPackageHelper, UninstallerReader } = require("app-builder-lib/out/targets/nsis/nsisUtil.js");

  const marker = Symbol.for("piforge.nsisJobObjectPatch");
  if (!WineVmManager.prototype[marker]) {
    const originalExec = WineVmManager.prototype.exec;
    WineVmManager.prototype.exec = async function patchedExec(file, args, options, ...rest) {
      const isUninstallerBuild = typeof file === "string" &&
        /\.exe$/i.test(file) &&
        Array.isArray(args) &&
        args.length === 0;
      if (isUninstallerBuild && options?.env?.__COMPAT_LAYER === "RunAsInvoker") {
        const uninstallerPath = path.join(
          path.dirname(file),
          `${path.basename(file, "exe")}__uninstaller.exe`,
        );
        await UninstallerReader.exec(file, uninstallerPath);
        return "";
      }
      return originalExec.call(this, file, args, options, ...rest);
    };
    Object.defineProperty(WineVmManager.prototype, marker, { value: true });
  }

  // Antivirus scanners often keep the temporary .nsis.7z open for a moment
  // after NSIS finishes. A locked cleanup file must not fail an otherwise
  // complete installer build (latest.yml would never be written).
  const finishMarker = Symbol.for("piforge.nsisCleanupPatch");
  if (!AppPackageHelper.prototype[finishMarker]) {
    const originalFinish = AppPackageHelper.prototype.finishBuild;
    AppPackageHelper.prototype.finishBuild = async function patchedFinishBuild(...args) {
      try {
        return await originalFinish.apply(this, args);
      } catch (error) {
        const code = error && typeof error === "object" ? error.code : undefined;
        if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") throw error;
        // Leave the temporary archive for the next clean build.
      }
    };
    Object.defineProperty(AppPackageHelper.prototype, finishMarker, { value: true });
  }
}
