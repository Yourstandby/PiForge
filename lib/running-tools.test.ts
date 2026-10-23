import assert from "node:assert/strict";
import test from "node:test";
import {
  collectRunningTools,
  mergeRunningToolsWithPinned,
  pinRunningTools,
} from "./running-tools.ts";

const call = (id: string, name: string) => ({
  role: "assistant",
  content: [{ type: "toolCall", toolCallId: id, toolName: name, input: {} }],
});
const result = (id: string) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "x",
  content: [{ type: "text", text: "ok" }],
});

const names = (tools: { name: string }[]) => tools.map((tool) => tool.name);

test("并行调用：只把还没有结果的那些算成 running", () => {
  const tools = collectRunningTools({
    agentRunning: true,
    messages: [call("a", "read"), call("b", "write"), call("c", "bash"), result("a")] as never,
  });
  assert.deepEqual(names(tools).sort(), ["bash", "write"]);
});

test("事件流丢了也能从消息算出来（agentPhase 为空时）", () => {
  const tools = collectRunningTools({
    agentRunning: true,
    messages: [call("r1", "read"), call("w1", "write")] as never,
    phaseTools: null,
  });
  assert.deepEqual(names(tools), ["read", "write"]);
});

test("agentPhase 里刚 start、结果还没落盘的工具也并进来", () => {
  const tools = collectRunningTools({
    agentRunning: true,
    messages: [call("r1", "read")] as never,
    phaseTools: [{ id: "pw1", name: "pwsh" }],
  });
  assert.deepEqual(names(tools).sort(), ["pwsh", "read"]);
});

test("已有 toolResult 的 id 不会被事件流的残留拖出来", () => {
  const tools = collectRunningTools({
    agentRunning: true,
    messages: [call("r1", "read"), result("r1")] as never,
    phaseTools: [{ id: "r1", name: "read" }],
  });
  assert.deepEqual(tools, []);
});

test("agent 没在跑时一律不算（中止后残留不显示成 running）", () => {
  const tools = collectRunningTools({
    agentRunning: false,
    messages: [call("r1", "read")] as never,
    phaseTools: [{ id: "r1", name: "read" }],
  });
  assert.deepEqual(tools, []);
});

test("同一次调用被 SDK 与归一化两种字段拼法写两遍也只算一次", () => {
  const tools = collectRunningTools({
    agentRunning: true,
    messages: [
      { role: "assistant", content: [{ type: "toolCall", id: "x1", name: "read", arguments: {} }] },
      { role: "assistant", content: [{ type: "toolCall", toolCallId: "x1", toolName: "read" }] },
    ] as never,
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "read");
});

test("长会话只回看尾部，不会因为历史 toolCall 卡住", () => {
  const messages = [call("old", "read"), result("old")];
  for (let index = 0; index < 120; index += 1) {
    messages.push({ role: "user", content: [{ type: "text", text: `m${index}` }] } as never);
  }
  const tools = collectRunningTools({ agentRunning: true, messages: messages as never });
  assert.deepEqual(tools, []);
});

// ── 毫秒级工具的最短可见时长（read / write 徽章要能看见） ──────────────

const live = (id: string, name: string) => ({ id, name });

test("pin：新出现的工具钉 now+minVisible，已结束的到期后清掉", () => {
  const now = 1000;
  const first = pinRunningTools([live("r1", "read")], new Map(), now, 700);
  assert.equal(first.get("r1")?.until, 1700);

  // read 已经结束，但还在 700ms 窗口内 → 继续钉住
  const second = pinRunningTools([], first, now + 300, 700);
  assert.equal(second.get("r1")?.until, 1700);

  // 超时 → 丢掉
  assert.equal(pinRunningTools([], second, now + 701, 700).size, 0);
});

test("pin：正在跑的工具不会因为反复 pin 被无限延长", () => {
  const pinned = pinRunningTools([live("b1", "bash")], new Map(), 0, 700);
  const again = pinRunningTools([live("b1", "bash")], pinned, 500, 700);
  assert.equal(again.get("b1")?.until, 700);
});

test("merge：刚结束的 read/write 仍出现在徽章列表里，并排在正在跑的工具后面", () => {
  const now = 1000;
  const pinned = pinRunningTools([live("r1", "read"), live("w1", "write")], new Map(), now, 700);
  const after = mergeRunningToolsWithPinned([live("b1", "bash")], pinned);
  assert.deepEqual(
    after.map((tool) => tool.name),
    ["bash", "read", "write"],
  );
  // 过期清理后只剩真正在跑的
  assert.deepEqual(
    mergeRunningToolsWithPinned(
      [live("b1", "bash")],
      pinRunningTools([live("b1", "bash")], pinned, now + 800, 700),
    ).map((tool) => tool.name),
    ["bash"],
  );
});
