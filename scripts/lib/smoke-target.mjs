/**
 * 打包冒烟的"要跑哪个可执行文件"解析（三个平台各一套布局）。
 *
 * 抽出来单测的原因：macOS 的布局和前两个平台不一样
 *   - exe 在 `PiForge.app/Contents/MacOS/PiForge`
 *   - resources 在 `PiForge.app/Contents/Resources`（**不是** exe 同级的 resources/）
 * 写错时的表现很有迷惑性：脚本报"缺少可执行文件"，看着像打包没产出，其实是
 * 冒烟脚本自己找错了路径。v0.9.1 之前 macOS 压根没跑过静态冒烟，就是因为这里
 * 只有 win32 / linux 两个分支。
 */

/** 各平台 electron-builder 的默认产物布局（相对仓库根）。 */
export const DEFAULT_TARGETS = {
  win32: "release/win-unpacked/PiForge.exe",
  linux: "release/linux-unpacked/piforge",
  darwin: "release/mac-universal/PiForge.app/Contents/MacOS/PiForge",
};

/**
 * @param {string} [platform] node 的 process.platform
 * @returns {string} 相对仓库根的默认可执行文件路径
 */
export function defaultTarget(platform = process.platform) {
  return DEFAULT_TARGETS[platform] ?? DEFAULT_TARGETS.linux;
}

/**
 * 由可执行文件路径推出 electron-builder 的 `resources/` 目录。
 *
 * - Windows / Linux：`<dir>/resources`
 * - macOS：`<app>/Contents/Resources`（exe 的上级是 `Contents/MacOS`）
 *
 * 用路径特征判断（而不是只信 process.platform），这样在 macOS 之外也能校验
 * mac 布局（例如 CI 里跨平台检查产出的目录结构）。
 *
 * @param {string} exe 可执行文件的绝对或相对路径
 * @returns {string}
 */
export function resourcesDirFor(exe, path) {
  const dir = path.dirname(exe);
  const parent = path.basename(dir);
  const appContents = path.basename(path.dirname(dir));
  if (parent === "MacOS" && appContents === "Contents") {
    return path.join(path.dirname(dir), "Resources");
  }
  return path.join(dir, "resources");
}
