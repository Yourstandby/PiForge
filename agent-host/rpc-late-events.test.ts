import test from "node:test";
import assert from "node:assert/strict";
import { AgentSessionWrapper } from "./rpc-manager.ts";

type Receive = (event: unknown) => void;

function makeInner(options: { isStreaming?: boolean } = {}) {
  let receive: Receive = () => {};
  const inner = {
    sessionId: "late-events-stub",
    sessionFile: "stub.jsonl",
    isStreaming: options.isStreaming ?? true,
    isCompacting: false,
    autoCompactionEnabled: false,
    autoRetryEnabled: false,
    model: null,
    getContextUsage: () => null,
    agent: { state: { systemPrompt: "", thinkingLevel: "off" } },
    sessionManager: null,
    modelRuntime: { getModel: () => undefined },
    prompt: () => Promise.resolve(),
    steer: () => Promise.resolve(),
    followUp: () => Promise.resolve(),
    setActiveToolsByName: () => {},
    abort: async () => {},
    getAllTools: () => [],
    getActiveToolNames: () => [],
    dispose: () => {},
    subscribe: (cb: Receive) => {
      receive = cb;
      return () => {};
    },
  };
  return { inner, emit: (event: unknown) => receive(event) };
}

test("abort 之后被放弃那一轮的迟到增量不投递，新一轮开始时恢复", async () => {
  const { inner, emit } = makeInner();
  const wrapper = new AgentSessionWrapper(inner as never);
  const seen: string[] = [];
  wrapper.onEvent((event) => {
    seen.push((event as { type: string }).type);
  });
  wrapper.start();
  try {
    await wrapper.send({ type: "abort" });
    // 底层流不会瞬间静默：这正是会污染界面的那几条。
    emit({ type: "message_update", message: { role: "assistant" } });
    emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "t1" });
    assert.deepEqual(seen, [], "被放弃那一轮的增量必须丢弃");

    // 新一轮真的开始：窗口关闭，正常增量恢复投递。
    emit({ type: "agent_start" });
    emit({ type: "message_update", message: { role: "assistant" } });
    assert.deepEqual(seen, ["agent_start", "message_update"]);
  } finally {
    await wrapper.destroy();
  }
});
