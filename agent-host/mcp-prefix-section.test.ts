import test from "node:test";
import assert from "node:assert/strict";
import {
  MCP_SERVERS_SECTION,
  mcpSectionSignature,
  stabilizeMcpSection,
  type McpSectionLatch,
} from "./mcp-prefix-section.ts";

const INTRO =
  "MCP servers whose tools are not declared to you. Call the tools of `codemode` servers from codemode scripts.";

/** 第一轮（间接服务器还没连上，没有描述）。 */
const FIRST_TURN = [INTRO, "- mcp__fast_anything (codemode)"].join("\n");

/** 连上之后：`connection.instructions` 的首行补进了描述。 */
const AFTER_CONNECT = [
  INTRO,
  "- mcp__fast_anything (codemode): fast-anything speeds up Python apps by porting hot functions.",
].join("\n");

test("段名与 SDK 的 MCP_SERVERS_SECTION 一致", () => {
  assert.equal(MCP_SERVERS_SECTION, "mcp_servers");
});

test("签名只看名字与暴露方式，忽略描述变化", () => {
  assert.equal(mcpSectionSignature(FIRST_TURN), "mcp__fast_anything(codemode)");
  assert.equal(mcpSectionSignature(AFTER_CONNECT), mcpSectionSignature(FIRST_TURN));
});

test("签名感知服务器增删与暴露方式变化", () => {
  const two = [INTRO, "- mcp__fast_anything (codemode)", "- mcp__icon (tool_search)"].join("\n");
  assert.notEqual(mcpSectionSignature(two), mcpSectionSignature(FIRST_TURN));
  const exposedElsewhere = [INTRO, "- mcp__fast_anything (tool_search)"].join("\n");
  assert.notEqual(mcpSectionSignature(exposedElsewhere), mcpSectionSignature(FIRST_TURN));
});

test("P2 核心：连接带来的描述不再改字节（前缀缓存不被打破）", () => {
  const first = stabilizeMcpSection(FIRST_TURN, null);
  assert.equal(first.section, FIRST_TURN);
  const second = stabilizeMcpSection(AFTER_CONNECT, first.latch);
  assert.equal(second.section, FIRST_TURN, "应沿用锁存字节，而不是把描述补进来");
  assert.deepEqual(second.latch, first.latch);
  // 再多轮也稳定
  const third = stabilizeMcpSection(AFTER_CONNECT, second.latch);
  assert.equal(third.section, FIRST_TURN);
});

test("首轮若已带描述，就保留这份描述（不无谓丢信息）", () => {
  const first = stabilizeMcpSection(AFTER_CONNECT, null);
  const later = stabilizeMcpSection(FIRST_TURN, first.latch);
  assert.equal(later.section, AFTER_CONNECT);
});

test("服务器集合真变了 → 重新锁存一次（允许的一次性失效）", () => {
  const first = stabilizeMcpSection(FIRST_TURN, null);
  const two = [INTRO, "- mcp__fast_anything (codemode)", "- mcp__icon (tool_search)"].join("\n");
  const next = stabilizeMcpSection(two, first.latch as McpSectionLatch);
  assert.equal(next.section, two);
  assert.equal(next.latch?.signature, mcpSectionSignature(two));
});

test("段消失时原样返回，锁存保持不变", () => {
  const latch: McpSectionLatch = { signature: mcpSectionSignature(FIRST_TURN), section: FIRST_TURN };
  const gone = stabilizeMcpSection(undefined, latch);
  assert.equal(gone.section, undefined);
  assert.equal(gone.latch, latch);
  const empty = stabilizeMcpSection("", latch);
  assert.equal(empty.section, "", "空段交给调用方删 key，不在这里改写");
});

test("幂等：同一版内容反复收敛结果不变", () => {
  let state: McpSectionLatch | null = null;
  let last: string | undefined;
  for (const section of [FIRST_TURN, AFTER_CONNECT, AFTER_CONNECT, FIRST_TURN]) {
    const step = stabilizeMcpSection(section, state);
    state = step.latch;
    if (last !== undefined) assert.equal(step.section, last);
    last = step.section;
  }
});
