import assert from "node:assert/strict";
import test from "node:test";

import { normalizeUserTextForMatch, stripImageDimensionNotes } from "./image-dimension-note.ts";

const NOTE =
  "[Image: original 2798x1800, displayed at 2000x1287. Multiply coordinates by 1.40 to map to original image.]";

test("strips pi's image dimension note and the blank line before it", () => {
  assert.equal(stripImageDimensionNotes(`看看这个界面\n\n${NOTE}`), "看看这个界面");
});

test("keeps normal text untouched (no scan cost when the marker is absent)", () => {
  const text = "第一行\n\n第二行 [Image: 无关闭括号不匹配]";
  assert.equal(stripImageDimensionNotes(text), text);
});

test("match normalization makes optimistic text equal to the persisted text", () => {
  assert.equal(
    normalizeUserTextForMatch(`看看这个界面\n\n${NOTE}`),
    normalizeUserTextForMatch("看看这个界面\n"),
  );
});

test("multiple notes are all removed", () => {
  assert.equal(stripImageDimensionNotes(`${NOTE}\n图二\n${NOTE}`), "图二");
});
