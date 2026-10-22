import test from "node:test";
import assert from "node:assert/strict";
import { SessionScope } from "./session-scope.ts";

test("切换会话时清掉上一个会话的定时器", async () => {
  const scope = new SessionScope();
  let ticks = 0;
  scope.setInterval("session-a", () => {
    ticks += 1;
  }, 5);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const before = ticks;
  assert.ok(before > 0, "interval should have fired");

  scope.disposeSession("session-a");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(ticks, before, "no ticks after dispose");
  assert.equal(scope.size(), 0);
});

test("onSessionSwitch 只清上一个会话，不动当前会话", async () => {
  const scope = new SessionScope();
  let a = 0;
  let b = 0;
  scope.setTimeout("a", () => {
    a += 1;
  }, 20);
  scope.setTimeout("b", () => {
    b += 1;
  }, 20);
  scope.onSessionSwitch("a");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(a, 0);
  assert.equal(b, 1);
  scope.disposeAll();
});

test("逃逸的延迟回调不会让登记表无限增长", async () => {
  const scope = new SessionScope();
  scope.setTimeout("s", () => undefined, 5);
  assert.equal(scope.size(), 1);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(scope.size(), 0);
});
