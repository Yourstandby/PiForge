import test from "node:test";
import assert from "node:assert/strict";
import { buildSessionContext } from "./session-reader.ts";
import type { SessionEntry } from "./types.ts";

test("context edits retain provenance for Fork and omit removed contributions", () => {
  const entries: SessionEntry[] = [
    { type: "message", id: "first", parentId: null, timestamp: "2026-09-30", message: { role: "user", content: "first" } },
    { type: "message", id: "second", parentId: "first", timestamp: "2026-09-30", message: { role: "user", content: "second" } },
    { type: "context_edit", id: "omit", parentId: "second", timestamp: "2026-09-30", targetId: "first", replacement: null },
    { type: "context_edit", id: "replace", parentId: "omit", timestamp: "2026-09-30", targetId: "second", replacement: { content: "replacement" } },
  ];
  const result = buildSessionContext(entries);
  assert.deepEqual(result.messages.map((message) => message.content), ["replacement"]);
  assert.deepEqual(result.entryIds, ["second"]);
  assert.deepEqual(buildSessionContext(entries, "second").entryIds, ["first", "second"]);
  assert.deepEqual(buildSessionContext(entries, null).messages, []);
});

test("compaction no longer hides the history before it (display projection)", () => {
  const entries: SessionEntry[] = [
    { type: "message", id: "u1", parentId: null, timestamp: "2026-09-30", message: { role: "user", content: "first question" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-30", message: { role: "assistant", content: [{ type: "text", text: "first answer" }], model: "m", provider: "p" } },
    { type: "message", id: "u2", parentId: "a1", timestamp: "2026-09-30", message: { role: "user", content: "second question" } },
    { type: "compaction", id: "c1", parentId: "u2", timestamp: "2026-09-30", summary: "summary of above", firstKeptEntryId: "u3", tokensBefore: 1234 },
    { type: "message", id: "u3", parentId: "c1", timestamp: "2026-09-30", message: { role: "user", content: "third question" } },
  ];
  const result = buildSessionContext(entries, "u3");
  // 压缩点之前的提问依然在，压缩点自身只占一条 custom 标记（不进导航的提问刻度）
  assert.deepEqual(
    result.messages.map((message) => message.role),
    ["user", "assistant", "user", "custom", "user"],
  );
  assert.deepEqual(result.entryIds, ["u1", "a1", "u2", "c1", "u3"]);
  assert.deepEqual(
    result.messages.filter((message) => message.role === "user").map((message) => message.content),
    ["first question", "second question", "third question"],
  );
  const marker = result.messages[3] as { display?: boolean; content?: unknown };
  assert.equal(marker.display, true);
  assert.match(JSON.stringify(marker.content), /summary of above/);
});
