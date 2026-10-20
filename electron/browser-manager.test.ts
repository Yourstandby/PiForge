import test from "node:test";
import assert from "node:assert/strict";
import { BrowserManager, type BrowserPageContents, type BrowserSurface } from "./browser-manager.ts";

class FakeContents implements BrowserPageContents {
  url = "about:blank";
  title = "";
  back = false;
  forward = false;
  loaded: string[] = [];
  actions: string[] = [];
  listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  async loadURL(url: string): Promise<void> {
    this.url = url;
    this.loaded.push(url);
    this.emit("did-start-loading");
    this.emit("did-finish-load");
  }
  getURL(): string { return this.url; }
  getTitle(): string { return this.title; }
  canGoBack(): boolean { return this.back; }
  canGoForward(): boolean { return this.forward; }
  goBack(): void { this.actions.push("back"); }
  goForward(): void { this.actions.push("forward"); }
  reload(): void { this.actions.push("reload"); }
  stop(): void { this.actions.push("stop"); }
  async executeJavaScript(): Promise<unknown> { return { text: "hello 世界", url: this.url, title: "标题" }; }
  async capturePage(): Promise<{ toPNG(): Uint8Array }> { return { toPNG: () => new Uint8Array([1, 2, 3]) }; }
  on(event: string, listener: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
  removeListener(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((item) => item !== listener));
  }
  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

function setup() {
  const contents = new FakeContents();
  const bounds: unknown[] = [];
  const visibility: boolean[] = [];
  const surface: BrowserSurface = {
    webContents: contents,
    setBounds(value) { bounds.push(value); },
    setVisible(value) { visibility.push(value); },
  };
  const manager = new BrowserManager({ createSurface: () => surface });
  return { manager, contents, bounds, visibility };
}

test("Main browser manager owns navigation, bounds and visibility", async () => {
  const { manager, contents, bounds, visibility } = setup();
  manager.setBounds({ x: 10.4, y: 20, width: 300.6, height: 200 }, true);
  assert.deepEqual(bounds.at(-1), { x: 10, y: 20, width: 301, height: 200 });
  assert.equal(visibility.at(-1), true);

  await manager.navigate("http://localhost:3000");
  assert.deepEqual(contents.loaded, ["http://localhost:3000"]);
  const state = manager.getState();
  assert.equal(state.url, "http://localhost:3000");
  assert.equal(state.visible, true);
});

test("Main browser manager executes Host commands", async () => {
  const { manager, contents } = setup();
  manager.setBounds({ x: 0, y: 0, width: 800, height: 600 }, true);
  const open = await manager.executeCommand({ id: "1", kind: "open", url: "http://localhost:5173" });
  assert.equal(open.ok, true);
  assert.equal(open.url, "http://localhost:5173");

  const read = await manager.executeCommand({ id: "2", kind: "read" });
  assert.equal(read.ok, true);
  assert.match(read.text ?? "", /hello 世界/);

  const shot = await manager.executeCommand({ id: "3", kind: "screenshot" });
  assert.equal(shot.ok, true);
  assert.equal(shot.image?.mimeType, "image/png");

  await manager.executeCommand({ id: "4", kind: "back" });
  await manager.executeCommand({ id: "5", kind: "forward" });
  await manager.executeCommand({ id: "6", kind: "reload" });
  assert.deepEqual(contents.actions, ["back", "forward", "reload"]);
});

test("Main browser manager refuses reads and screenshots before load", async () => {
  const { manager } = setup();
  const read = await manager.executeCommand({ id: "r", kind: "read" });
  assert.equal(read.ok, false);
  assert.equal(read.code, "BROWSER_NOT_READY");
  const shot = await manager.executeCommand({ id: "s", kind: "screenshot" });
  assert.equal(shot.ok, false);
  assert.equal(shot.code, "BROWSER_NOT_READY");
});

test("bounds generation and loading readiness are independent", async () => {
  const { manager, contents } = setup();
  manager.setBounds({ x: 0, y: 0, width: 800, height: 600 }, true);
  const generation = manager.getState().boundsGeneration;
  assert.equal(generation, 1);
  await manager.navigate("http://localhost:3000");
  contents.emit("did-start-loading");
  assert.equal(manager.getState().ready, false);
  assert.equal(manager.getState().boundsGeneration, generation);
  manager.setBounds({ x: 0, y: 0, width: 0, height: 0 }, true);
  assert.equal(manager.getState().boundsGeneration, generation, "invalid bounds must not bump generation");
});

test("hidden views cannot be captured", async () => {
  const { manager } = setup();
  manager.setBounds({ x: 0, y: 0, width: 800, height: 600 }, false);
  await manager.navigate("http://localhost:3000");
  const shot = await manager.executeCommand({ id: "hidden", kind: "screenshot" });
  assert.equal(shot.ok, false);
  assert.equal(shot.code, "BROWSER_NOT_READY");
});

test("Main browser manager rejects non-http navigation", async () => {
  const { manager } = setup();
  await assert.rejects(() => manager.navigate("file:///etc/passwd"), /Only http/);
  const result = await manager.executeCommand({ id: "x", kind: "open", url: "javascript:alert(1)" });
  assert.equal(result.ok, false);
});

test("Main browser manager can stop loading", async () => {
  const { manager, contents } = setup();
  manager.setBounds({ x: 0, y: 0, width: 800, height: 600 }, true);
  await manager.navigate("http://localhost:3000");
  manager.stop();
  assert.deepEqual(contents.actions, ["stop"]);
});
