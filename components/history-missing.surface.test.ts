import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./ChatSurface.tsx", import.meta.url), "utf8");

/**
 * 运行中拿不到历史时，对话区原先只有一句「PiForge 正在思考…」——静默空白让用户
 * 以为整个应用卡死。这里钉住两件事：说清原因 + 给重试出口，并且运行期间自动补取。
 */
test("运行中一条历史都没有时给出重试出口", () => {
  assert.match(source, /chat\.agentRunning && messages\.length === 0/);
  assert.match(source, /data-history-missing="true"/);
  assert.match(source, /重新加载/);
});

test("运行期间自动补取历史（有上限，历史回来就停）", () => {
  assert.match(source, /if \(!session \|\| !chat\.agentRunning \|\| messages\.length > 0\) return;/);
  assert.match(source, /attempt >= 6/);
});
