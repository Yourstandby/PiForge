/** Env-gated packaged Fleet panel visibility/throttling smoke. */
import type { BrowserWindow } from "electron";
import { app } from "electron";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function execute<T>(window: BrowserWindow, code: string): Promise<T> {
  return window.webContents.executeJavaScript(code, true) as Promise<T>;
}

export async function runFleetSmoke(window: BrowserWindow): Promise<void> {
  try {
    const clickDeadline = Date.now() + 30_000;
    for (;;) {
      const state = await execute<{ clicked: boolean; rendered: boolean }>(window, `(() => {
        const panel = document.querySelector('[data-testid="herdr-panel"]');
        if (panel) return { clicked: false, rendered: true };
        const buttons = Array.from(document.querySelectorAll("button"));
        const fleet = buttons.find((button) => (button.textContent || "").includes("舰队"));
        if (!fleet) return { clicked: false, rendered: false };
        fleet.click();
        return { clicked: true, rendered: Boolean(document.querySelector('[data-testid="herdr-panel"]')) };
      })()`);
      if (state.rendered) break;
      if (Date.now() > clickDeadline) throw new Error("Fleet panel did not render");
      await sleep(400);
    }
    await sleep(500);

    const before = await execute<{ ts: number; readOnly: boolean }>(window, `(() => {
      const panel = document.querySelector('[data-testid="herdr-panel"]');
      return {
        ts: Number(panel?.getAttribute("data-last-loaded-at") || 0),
        readOnly: !panel?.querySelector("textarea, input[type=text], button[data-herdr-send]"),
      };
    })()`);

    window.minimize();
    await sleep(1_000);
    const minimized = window.isMinimized();
    let method = "minimize";
    if (!minimized) {
      method = "hide";
      window.hide();
    }
    await sleep(5_000);
    window.restore();
    window.show();
    window.focus();
    const deadline = Date.now() + 2_000;
    let after = before.ts;
    while (Date.now() < deadline) {
      after = await execute<number>(window, `Number(document.querySelector('[data-testid="herdr-panel"]')?.getAttribute("data-last-loaded-at") || 0)`);
      if (after > before.ts) break;
      await sleep(100);
    }
    if (!(after > before.ts)) throw new Error("Fleet panel did not refresh after restore");
    console.log(`SMOKE_FLEET_OK ${JSON.stringify({ method, minimized, beforeTs: before.ts, afterTs: after, readOnly: before.readOnly })}`);
    app.exit(before.readOnly ? 0 : 1);
  } catch (error) {
    console.error("SMOKE_FLEET_FAILED", error);
    app.exit(1);
  }
}
