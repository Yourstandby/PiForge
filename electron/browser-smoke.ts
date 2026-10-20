/** Env-gated packaged BrowserManager/Bridge smoke. Never used in normal startup. */
import { BrowserWindow, WebContentsView, app } from "electron";
import net from "node:net";
import { BrowserManager, type BrowserCommand, type BrowserCommandResult } from "./browser-manager";
import { BrowserHostBridge } from "./browser-host-bridge";

export async function runBrowserSmoke(): Promise<void> {
  const endpoint = process.env.SMOKE_BROWSER_ENDPOINT;
  const token = process.env.SMOKE_BROWSER_TOKEN;
  const fixtureUrl = process.env.SMOKE_BROWSER_FIXTURE;
  if (!endpoint || !token || !fixtureUrl) {
    console.error("SMOKE_BROWSER requires ENDPOINT, TOKEN and FIXTURE");
    app.exit(1);
    return;
  }

  const window = new BrowserWindow({
    show: false,
    x: 0,
    y: 0,
    width: 900,
    height: 700,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  const view = new WebContentsView({
    webPreferences: { partition: "persist:piforge-browser-smoke", sandbox: true, contextIsolation: true },
  });
  window.contentView.addChildView(view);
  // Electron refuses to composite a never-shown view (capturePage throws
  // UnknownVizError). Keep it fully transparent but composited so the
  // screenshot smoke runs without a visible window.
  window.setOpacity(0);
  window.showInactive();
  const manager = new BrowserManager({
    createSurface: () => ({
      webContents: view.webContents as never,
      setBounds: (bounds) => view.setBounds(bounds),
      setVisible: (visible) => view.setVisible(visible),
      close: () => view.webContents.close(),
    }),
  });
  manager.setBounds({ x: 0, y: 0, width: 800, height: 600 }, true);

  const seen = new Set<string>();
  const results: Record<string, unknown> = {};
  const bridge = new BrowserHostBridge({
    endpoint,
    token,
    connect: (pipe) => net.connect(pipe),
    getManager: () => manager,
    windowId: "smoke-window",
    ownerId: "smoke-owner",
    pollMs: 100,
    snapshotMs: 500,
    onCommandResult: (command: BrowserCommand, result: BrowserCommandResult) => {
      seen.add(command.kind);
      results[command.kind] = {
        ok: result.ok,
        code: result.code,
        url: result.url,
        bytes: result.image?.data.length ?? 0,
        error: result.error,
        ready: result.ready,
        boundsGeneration: result.boundsGeneration,
      };
      if (seen.has("open") && seen.has("read") && seen.has("screenshot")) {
        console.log(`SMOKE_BROWSER_OK ${JSON.stringify(results)}`);
        bridge.stop();
        window.destroy();
        app.exit(0);
      }
    },
  });

  try {
    await manager.navigate(fixtureUrl);
    bridge.start();
  } catch (error) {
    console.error("SMOKE_BROWSER_FAILED", error);
    bridge.stop();
    window.destroy();
    app.exit(1);
  }
}
