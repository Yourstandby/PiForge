import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTerminalText, parseAnsi, stripAnsi } from "./ansi.ts";

test("plain text becomes a single span", () => {
  assert.deepEqual(parseAnsi("hello"), [{ text: "hello" }]);
});

test("foreground and reset are applied", () => {
  const spans = parseAnsi("\u001b[31mred\u001b[0m plain");
  assert.equal(spans.length, 2);
  assert.equal(spans[0].text, "red");
  assert.equal(spans[0].fg, "#c02a2a");
  assert.equal(spans[1].text, " plain");
  assert.equal(spans[1].fg, undefined);
});

test("bold, bright colors and background survive", () => {
  const spans = parseAnsi("\u001b[1;92;44mhi");
  assert.equal(spans[0].bold, true);
  assert.equal(spans[0].fg, "#16a34a");
  assert.equal(spans[0].bg, "#1d4ed8");
});

test("256-color and truecolor sequences are consumed", () => {
  const spans = parseAnsi("\u001b[38;5;196mx\u001b[0m\u001b[38;2;10;20;30my");
  assert.equal(spans[0].text, "x");
  assert.equal(spans[0].fg, "rgb(255, 0, 0)");
  assert.equal(spans[1].text, "y");
  assert.equal(spans[1].fg, "rgb(10, 20, 30)");
});

test("unknown CSI sequences are dropped, not printed", () => {
  assert.equal(stripAnsi("a\u001b[2Kb\u001b[1;1Hc"), "abc");
  assert.equal(parseAnsi("a\u001b[2Kb").map((span) => span.text).join(""), "ab");
});

test("OSC sequences and CR overwrites are removed", () => {
  assert.equal(normalizeTerminalText("title\u001b]0;window\u0007done"), "titledone");
  assert.equal(normalizeTerminalText("progress 10%\rprogress 100%"), "progress 100%");
  assert.equal(normalizeTerminalText("a\r\nb"), "a\nb");
});
