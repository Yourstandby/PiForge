/**
 * 结构护栏：「已交给宿主」和「已进会话」必须在界面上分得开。
 *
 * 踩过的坑（2026-11-22，yourstandby 会话）：steer / 排队提交后，乐观气泡和
 * 已落库的气泡长得一模一样，用户以为没发出去又按一次，于是同一秒冒出两条
 * 内容相近的消息。这里钉死三件事：视图带投递态、缓存按投递态失效、界面有标记。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");

test("轮次视图带上投递态", () => {
  const src = read("components/Transcript.tsx");
  assert.ok(/deliveryPending\?: boolean;/.test(src), "TranscriptTurnView 要声明 deliveryPending");
  assert.ok(
    src.includes('const deliveryState = (message as { deliveryState?: string }).deliveryState;'),
    "从消息上读 deliveryState",
  );
  assert.ok(/systemNote,\s*deliveryPending,/.test(src), "用户轮次要把它带进视图");
});

test("投递态变化必须让轮次缓存失效", () => {
  const src = read("components/Transcript.tsx");
  assert.ok(src.includes("function deliveryRefOf("), "要有投递态的引用键");
  assert.ok(
    src.includes("refsOf: (message) => [...toolResultRefsOf(message, results), deliveryRefOf(message)]"),
    "引用键里必须带上投递态，否则「投递中」永远不消失",
  );
});

test("界面把「投递中」显式标出来", () => {
  const src = read("components/Transcript.tsx");
  assert.ok(src.includes("{turn.deliveryPending && ("), "只有投递中的轮次才显示标记");
  assert.ok(src.includes("投递中…"), "要有可读文案");
  assert.ok(src.includes('title="消息已交给宿主，还在等这一轮接住它"'), "悬停要说明是在等哪一步");
});

test("宿主拒收的消息必须标成「未送达」，不能长得像已送达", () => {
  const transcript = read("components/Transcript.tsx");
  assert.ok(transcript.includes('deliveryState === "failed"'), "要能把 failed 读成失败态");
  assert.ok(/deliveryFailed\?: boolean;/.test(transcript), "视图要声明 deliveryFailed");
  assert.ok(transcript.includes("{turn.deliveryFailed && ("), "失败轮次要显式标出");
  assert.ok(transcript.includes("未送达"), "要有可读文案");

  const session = read("hooks/useAgentSession.ts");
  assert.ok(session.includes("function markDeliveryFailed("), "失败要落成失败态，而不是清成已送达");
  assert.ok(/return markDeliveryFailed\(message\);/.test(session), "失败回调要走标记而不是清除");

  const surface = read("components/ChatSurface.tsx");
  assert.ok(surface.includes("chat.handleRetryDelivery("), "失败提示要能一键重试");
});
