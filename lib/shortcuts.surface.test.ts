/**
 * Structural guard for the v0.3.0 shortcut layer.
 *
 * The handlers live in components (they need tab/draft/messages state), so this
 * asserts each surface still registers the shortcut it owns — a cheap tripwire
 * against a refactor silently dropping one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");

test("Ctrl+Tab cycles session tabs in Workbench", () => {
  const src = read("components/Workbench.tsx");
  assert.match(src, /event\.key !== "Tab"/);
  assert.match(src, /cycleTab\(event\.shiftKey \? -1 : 1\)/);
  assert.match(src, /addEventListener\("keydown", onKeyDown, true\)/);
});

test("ChatSurface owns Ctrl+Shift+C copy and Ctrl+K clear", () => {
  const src = read("components/ChatSurface.tsx");
  assert.match(src, /conversationToMarkdown\(chat\.messages\)/);
  assert.match(src, /navigator\.clipboard\.writeText/);
  assert.match(src, /对话已复制/);
  assert.match(src, /handleSend\("\/clear"\)/);
});

test("Composer walks prompt history with ArrowUp/ArrowDown", () => {
  const src = read("components/Composer.tsx");
  assert.match(src, /stepHistory\(historyIndex, "older", history\.length\)/);
  assert.match(src, /stepHistory\(historyIndex, "newer", history\.length\)/);
  assert.match(src, /rememberPrompt\(text\)/);
});

test("Esc still aborts the active tab only", () => {
  const src = read("components/ChatSurface.tsx");
  assert.match(src, /if \(!escAgentRunning \|\| !active\) return;/);
});
