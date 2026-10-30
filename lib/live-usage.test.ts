import test from "node:test";
import assert from "node:assert/strict";
import { clearLiveUsage, setLiveUsage, subscribeLiveUsage } from "./live-usage.ts";

test("订阅方只收到自己会话的实时用量", () => {
  const seenA: (number | null)[] = [];
  const seenB: (number | null)[] = [];
  const unA = subscribeLiveUsage((u) => seenA.push(u?.cost ?? null), "a");
  const unB = subscribeLiveUsage((u) => seenB.push(u?.cost ?? null), "b");

  setLiveUsage({ sessionId: "a", tokens: 10, cost: 0.1 });
  setLiveUsage({ sessionId: "b", tokens: 20, cost: 0.2 });

  unA();
  unB();
  setLiveUsage(null);

  // 初始 null → A 自己的 0.1 → B 在跑时归零
  assert.deepEqual(seenA, [null, 0.1, null]);
  assert.deepEqual(seenB, [null, null, 0.2]);
});

test("clearLiveUsage 不会清掉别的会话的实时值", () => {
  const seen: (number | null)[] = [];
  const un = subscribeLiveUsage((u) => seen.push(u?.cost ?? null), "b");

  setLiveUsage({ sessionId: "a", tokens: 10, cost: 0.1 });
  clearLiveUsage("a"); // 清掉 a：b 的订阅者只多看到一次 null
  setLiveUsage({ sessionId: "b", tokens: 20, cost: 0.2 });
  clearLiveUsage("a"); // 当前是 b，不该被 a 卸下时清空

  un();
  assert.deepEqual(seen, [null, null, null, 0.2]);
  setLiveUsage(null);
});

test("未声明会话的订阅拿不到实时值", () => {
  const seen: (number | null)[] = [];
  const un = subscribeLiveUsage((u) => seen.push(u?.cost ?? null));
  setLiveUsage({ sessionId: "a", tokens: 10, cost: 0.1 });
  un();
  assert.deepEqual(seen, [null, null]);
  setLiveUsage(null);
});
