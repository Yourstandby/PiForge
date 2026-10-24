import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

test("main process quit-and-install is gated on update download state", () => {
  assert.match(source, /decideQuitAndInstall\(updateInstallState\)/);
  assert.match(source, /markUpdateDownloaded\(updateInstallState/);
  // The IPC handler must refuse before download, and the only
  // autoUpdater.quitAndInstall() call site must sit after that gate.
  const handlerIdx = source.indexOf('ipcMain.handle("quit-and-install"');
  assert.ok(handlerIdx >= 0, "quit-and-install IPC handler expected");
  const gateIdx = source.indexOf("decideQuitAndInstall(updateInstallState)", handlerIdx);
  const refusedIdx = source.indexOf("if (!decision.allowed)", gateIdx);
  const installIdx = source.indexOf("autoUpdater.quitAndInstall()", handlerIdx);
  assert.ok(gateIdx > handlerIdx, "gate decision must run inside the handler");
  assert.ok(refusedIdx > gateIdx, "refusal branch must follow the gate");
  assert.ok(installIdx > refusedIdx, "quitAndInstall must only run after the gate allows");
  // The only other allowed call site is the update-downloaded restart dialog:
  // that event fires only after a completed download, and
  // markUpdateDownloaded runs before the dialog that leads to the install.
  const secondInstallIdx = source.indexOf("autoUpdater.quitAndInstall()", installIdx + 1);
  if (secondInstallIdx !== -1) {
    const downloadedIdx = source.indexOf('autoUpdater.on("update-downloaded"');
    const markIdx = source.indexOf("markUpdateDownloaded(updateInstallState", downloadedIdx);
    assert.ok(downloadedIdx !== -1, "update-downloaded handler expected");
    assert.ok(markIdx > downloadedIdx, "update-downloaded handler must mark install state first");
    assert.ok(secondInstallIdx > markIdx, "second quitAndInstall must run inside the update-downloaded flow");
    assert.equal(
      source.indexOf("autoUpdater.quitAndInstall()", secondInstallIdx + 1),
      -1,
      "no further quitAndInstall call sites are allowed"
    );
  }
});

test("update feed is fixed at build time and never overridden at runtime", () => {
  assert.match(source, /app-update\.yml/);
  assert.doesNotMatch(source, /setFeedURL/);
  assert.match(source, /autoUpdater\.autoDownload = false/);
  assert.match(source, /autoUpdater\.autoInstallOnAppQuit = true/);
  assert.match(source, /checkForUpdates\(\)\.catch/);
});

test("packaged readiness requires HTTP health", () => {
  assert.match(source, /requireHttpHealth:\s*app\.isPackaged/);
  assert.match(source, /waitForNextServerReady\(port, nextProcess, \{\s*requireHttpHealth:\s*app\.isPackaged\s*\}\)/);
});

test("packaged macOS server uses a background utility process", () => {
  const packagedStart = source.indexOf("const serverEnv =");
  const monitorStart = source.indexOf("function monitorNextServerProcess", packagedStart);
  assert.ok(packagedStart >= 0 && monitorStart > packagedStart);
  const packagedSource = source.slice(packagedStart, monitorStart);
  assert.match(packagedSource, /process\.platform === "darwin"/);
  assert.match(packagedSource, /utilityProcess\.fork\(serverScript/);
  assert.match(packagedSource, /serviceName: "Pi Agent Next Server"/);
  const darwinBranchStart = packagedSource.indexOf(
    'process.platform === "darwin"',
  );
  const fallbackBranchStart = packagedSource.indexOf(
    ": wrapChildServerProcess",
    darwinBranchStart,
  );
  assert.ok(fallbackBranchStart > darwinBranchStart);
  assert.doesNotMatch(
    packagedSource.slice(darwinBranchStart, fallbackBranchStart),
    /process\.execPath|ELECTRON_RUN_AS_NODE/,
  );
});

test("main waits for app navigation before marking the server ready", () => {
  // P1-4 之后有两条导航路径，两条都必须 `await`（ready 只能在加载完之后置位）：
  //   - Next 回退路径（PIFORGE_USE_NEXT=1）：`showApp(port)`（启动 + 重启各一次）
  //   - 默认静态直出路径：`showStaticApp()`
  const awaitedShowAppCalls = source.match(/await showApp\(port\)/g) ?? [];
  assert.equal(awaitedShowAppCalls.length, 1, "restart path must await Next navigation");
  assert.match(source, /await showStaticApp\(\);/, "default startup must await static navigation");

  const showAppStart = source.indexOf("async function showApp(port: number): Promise<void>");
  const showAppEnd = source.indexOf("\nfunction isAllowedAppUrl", showAppStart);
  assert.ok(showAppStart >= 0 && showAppEnd > showAppStart, "showApp implementation must exist");

  const showAppSource = source.slice(showAppStart, showAppEnd);
  // showApp fans the navigation out to every app window; loadAppUrl owns the
  // bounded retry loop, and `ready` must only be set after all windows loaded.
  const navigationIndex = showAppSource.indexOf("await loadAppUrl(");
  const readyIndex = showAppSource.indexOf('serverState = "ready"');
  assert.ok(navigationIndex >= 0, "showApp must await bounded app navigation");
  assert.ok(readyIndex > navigationIndex, "ready must only be set after navigation completes");

  const loadAppStart = source.indexOf("async function loadAppUrl(");
  const loadAppEnd = source.indexOf("\nasync function showApp", loadAppStart);
  assert.ok(loadAppStart >= 0 && loadAppEnd > loadAppStart, "loadAppUrl implementation must exist");
  const loadAppSource = source.slice(loadAppStart, loadAppEnd);
  assert.match(loadAppSource, /await loadPageWithRetry/);
  assert.match(loadAppSource, /nextProcess !== proc/);
  assert.match(loadAppSource, /proc\.exitCode !== null/);
  assert.match(loadAppSource, /signal: navigationAbort\.signal/);
  assert.match(loadAppSource, /window\.webContents\.stop\(\)/);
});

test("main process CSP uses shared electron CSP builder", () => {
  // P1-4：两条加载路径各用各的 CSP —— Next 回退按端口放行，静态直出只放行 piforge:。
  assert.match(source, /import \{[^}]*buildElectronCspHeader[^}]*\} from "\.\/csp"/);
  assert.match(source, /buildElectronCspHeader\(port\)/);
  assert.match(source, /import \{[^}]*buildStaticAppCspHeader[^}]*\} from "\.\/csp"/);
  assert.match(source, /csp: buildStaticAppCspHeader\(\)/);
});
// The CSP header contents themselves are behaviorally covered in lib/csp.test.ts.
