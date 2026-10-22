import assert from "node:assert/strict";
import test from "node:test";

import type { AgentMessage, UserMessage } from "../../lib/types.ts";
import {
  reconcileOrAppendPendingUserMessage,
  reconcilePendingUserMessage,
} from "./user-message-reconciliation.ts";

test("canonical prompt event replaces its optimistic bubble instead of duplicating it", () => {
  const optimistic: UserMessage = {
    role: "user",
    content: "Ingest / Compile",
    timestamp: 100,
    clientMessageId: "client-1",
    deliveryState: "pending",
  };
  const canonical: UserMessage = {
    role: "user",
    content: "Ingest / Compile",
    timestamp: 200,
  };

  assert.deepEqual(
    reconcilePendingUserMessage([optimistic] satisfies AgentMessage[], canonical, "client-1"),
    {
      reconciled: true,
      messages: [{ ...canonical, timestamp: 100 }],
    }
  );
});

test("an unrelated user event remains available for normal append handling", () => {
  const optimistic: UserMessage = {
    role: "user",
    content: "first prompt",
    timestamp: 100,
    clientMessageId: "client-1",
    deliveryState: "pending",
  };
  const canonical: UserMessage = {
    role: "user",
    content: "different prompt",
    timestamp: 200,
  };

  assert.deepEqual(
    reconcilePendingUserMessage([optimistic] satisfies AgentMessage[], canonical, "missing-client"),
    { reconciled: false, messages: [optimistic] }
  );
});

test("a stale pending id falls back to appending the canonical event", () => {
  const existing: UserMessage = { role: "user", content: "earlier", timestamp: 100 };
  const canonical: UserMessage = { role: "user", content: "new prompt", timestamp: 200 };

  assert.deepEqual(
    reconcileOrAppendPendingUserMessage([existing], canonical, "stale-client"),
    [existing, canonical]
  );
});

test("image message with pi's dimension note does not create a second bubble", () => {
  const image = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: "AAA" } };
  const optimistic = {
    role: "user" as const,
    content: [{ type: "text" as const, text: "看看这个界面" }, image],
    timestamp: 100,
    clientMessageId: "client-image",
    deliveryState: "pending" as const,
  };
  // pi 落盘时把缩放说明追加进文本，且 id 对不上（模拟事件里丢了 clientMessageId）。
  const canonical = {
    role: "user" as const,
    content: [
      {
        type: "text" as const,
        text: "看看这个界面\n\n[Image: original 2798x1800, displayed at 2000x1287. Multiply coordinates by 1.40 to map to original image.]",
      },
      image,
    ],
    timestamp: 999,
  };
  const next = reconcileOrAppendPendingUserMessage([optimistic] as AgentMessage[], canonical, "client-image");
  assert.equal(next.length, 1, "同一句话不应出现两条用户消息");
  assert.equal(next[0].timestamp, 100, "保留乐观气泡的时间戳");
});
