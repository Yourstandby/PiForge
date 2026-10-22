import assert from "node:assert/strict";
import test from "node:test";

import type { SessionInfo } from "../../lib/types.ts";
import { mergeSessionList } from "./session-merge.ts";

function session(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    path: `/tmp/${id}.jsonl`,
    id,
    cwd: "D:/Pi/PiForge",
    name: id,
    created: "2026-10-22T00:00:00.000Z",
    modified: "2026-10-22T00:00:00.000Z",
    messageCount: 2,
    firstMessage: id,
    ...overrides,
  };
}

test("unchanged rows keep their object identity (no re-render, no flicker)", () => {
  const previous = [session("a"), session("b")];
  const merged = mergeSessionList(previous, previous.map((item) => ({ ...item })));
  assert.equal(merged[0], previous[0]);
  assert.equal(merged[1], previous[1]);
});

test("a renamed row is replaced but keeps its position", () => {
  const previous = [session("a"), session("b"), session("c")];
  const merged = mergeSessionList(previous, [
    session("a"),
    session("b", { name: "新标题" }),
    session("c"),
  ]);
  assert.equal(merged[1].name, "新标题");
  assert.deepEqual(merged.map((item) => item.id), ["a", "b", "c"]);
  assert.equal(merged[0], previous[0]);
  assert.equal(merged[2], previous[2]);
});

test("new sessions appear first, deleted ones disappear", () => {
  const previous = [session("a"), session("b")];
  const merged = mergeSessionList(previous, [session("fresh"), session("a")]);
  assert.deepEqual(merged.map((item) => item.id), ["fresh", "a"]);
});

test("an empty previous list just renders the server order", () => {
  const merged = mergeSessionList([], [session("a"), session("b")]);
  assert.deepEqual(merged.map((item) => item.id), ["a", "b"]);
});
