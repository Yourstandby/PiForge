import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHostSpawnSpec,
  hostRuntimePlan,
  hostShutdownFrame,
  parseHostStdinLine,
  resolveHostTransport,
} from "./host-launcher.ts";
import * as shared from "../contract/host-stdin.ts";

const EMPTY_HEAP = { semiSpaceMb: null, oldSpaceMb: null };
const DEFAULT_HEAP = { semiSpaceMb: 8, oldSpaceMb: 256 };

test("resolveHostTransport: 未设置 → utility（默认行为不变）", () => {
  const decision = resolveHostTransport({ env: {} });
  assert.equal(decision.transport, "utility");
  assert.equal(decision.code, "default_utility");
});

test("resolveHostTransport: PIFORGE_HOST_TRANSPORT=node / utility 生效", () => {
  assert.equal(resolveHostTransport({ env: { PIFORGE_HOST_TRANSPORT: "node" } }).transport, "node");
  assert.equal(resolveHostTransport({ env: { PIFORGE_HOST_TRANSPORT: " UTILITY " } }).transport, "utility");
});

test("resolveHostTransport: 非法值回落 utility，并写明原因（不静默）", () => {
  const decision = resolveHostTransport({ env: { PIFORGE_HOST_TRANSPORT: "subprocess" } });
  assert.equal(decision.transport, "utility");
  assert.equal(decision.code, "invalid_env");
  assert.match(decision.reason, /subprocess/);
});

test("hostRuntimePlan: utility 只能设老生代（新生代设不了，notes 要说明）", () => {
  const plan = hostRuntimePlan({ transport: "utility", heap: DEFAULT_HEAP });
  assert.deepEqual(plan.execArgv, ["--js-flags=--max-old-space-size=256"]);
  assert.equal(plan.nodeOptions, null);
  assert.equal(plan.effective.semiSpaceMb, null);
  assert.match(plan.notes.join(""), /只能设老生代/);
});

test("hostRuntimePlan: node 模式两个 flag 都进 NODE_OPTIONS", () => {
  const plan = hostRuntimePlan({ transport: "node", heap: DEFAULT_HEAP });
  assert.match(String(plan.nodeOptions), /--max-old-space-size=256/);
  assert.match(String(plan.nodeOptions), /--max-semi-space-size=8/);
  assert.equal(plan.effective.semiSpaceMb, 8);
  assert.equal(plan.effective.oldSpaceMb, 256);
});

test("hostRuntimePlan: 继承的 NODE_OPTIONS 会被保留，但旧的堆参数被替换（不叠加）", () => {
  const plan = hostRuntimePlan({
    transport: "node",
    heap: DEFAULT_HEAP,
    existingNodeOptions: "--enable-source-maps --max-old-space-size=4096",
  });
  assert.match(String(plan.nodeOptions), /--enable-source-maps/);
  assert.equal(String(plan.nodeOptions).includes("4096"), false);
  assert.equal(String(plan.nodeOptions).match(/--max-old-space-size/g)?.length, 1);
});

test("hostRuntimePlan: PIFORGE_HOST_HEAP=default（null/null）时不自作主张加参数", () => {
  const utility = hostRuntimePlan({ transport: "utility", heap: EMPTY_HEAP });
  assert.deepEqual(utility.execArgv, []);
  const node = hostRuntimePlan({ transport: "node", heap: EMPTY_HEAP });
  assert.equal(node.nodeOptions, null);
  assert.equal(node.effective.heapLimitMb, null);
});

test("hostRuntimePlan: --cpu-prof 之类运行时参数在 node 模式走 argv，不进 NODE_OPTIONS", () => {
  const plan = hostRuntimePlan({
    transport: "node",
    heap: DEFAULT_HEAP,
    extraRuntimeFlags: ["--cpu-prof"],
  });
  assert.deepEqual(plan.runtimeFlags, ["--cpu-prof"]);
  assert.equal(String(plan.nodeOptions).includes("cpu-prof"), false);
});

test("buildHostSpawnSpec: utility 模式命令为 null、env 里不含 ELECTRON_RUN_AS_NODE", () => {
  const spec = buildHostSpawnSpec({
    decision: { transport: "utility", code: "default_utility", reason: "默认 utilityProcess" },
    entry: "C:\\app\\agent-host\\index.js",
    env: { PATH: "C:\\Windows", ELECTRON_RUN_AS_NODE: "1" },
    binaryPath: "C:\\app\\PiForge.exe",
    heap: DEFAULT_HEAP,
  });
  assert.equal(spec.transport, "utility");
  assert.equal(spec.command, null);
  assert.deepEqual(spec.args, []);
  assert.equal("ELECTRON_RUN_AS_NODE" in spec.env, false);
  assert.equal("PIFORGE_HOST_STDIN_CONTROL" in spec.env, false);
  assert.deepEqual(spec.execArgv, ["--js-flags=--max-old-space-size=256"]);
});

test("buildHostSpawnSpec: node 模式 = 可执行文件 + [flags..., entry]，env 显式带 ELECTRON_RUN_AS_NODE", () => {
  const spec = buildHostSpawnSpec({
    decision: { transport: "node", code: "env_node", reason: "PIFORGE_HOST_TRANSPORT=node" },
    entry: "C:\\app\\agent-host\\index.js",
    env: { PATH: "C:\\Windows", NODE_OPTIONS: "--enable-source-maps" },
    binaryPath: "C:\\app\\PiForge.exe",
    heap: DEFAULT_HEAP,
    extraRuntimeFlags: ["--cpu-prof"],
  });
  assert.equal(spec.command, "C:\\app\\PiForge.exe");
  assert.deepEqual(spec.args, ["--cpu-prof", "C:\\app\\agent-host\\index.js"]);
  assert.equal(spec.env.ELECTRON_RUN_AS_NODE, "1");
  // stdin 控制通道必须**显式**开启：host 不能靠"stdin 不是 TTY"去猜（ignore 的 stdin 会立刻 end）。
  assert.equal(spec.env.PIFORGE_HOST_STDIN_CONTROL, "1");
  assert.match(String(spec.env.NODE_OPTIONS), /--max-semi-space-size=8/);
  assert.match(String(spec.env.NODE_OPTIONS), /--enable-source-maps/);
  assert.deepEqual(spec.execArgv, []);
});

test("buildHostSpawnSpec: 不改动 process.env（ELECTRON_RUN_AS_NODE 不能泄漏到主进程）", () => {
  const before = process.env.ELECTRON_RUN_AS_NODE;
  buildHostSpawnSpec({
    decision: { transport: "node", code: "env_node", reason: "x" },
    entry: "entry.js",
    env: {},
    binaryPath: "/bin/PiForge",
    heap: DEFAULT_HEAP,
  });
  assert.equal(process.env.ELECTRON_RUN_AS_NODE, before);
});

test("buildHostSpawnSpec: 堆参数被关掉时 node 模式不写 NODE_OPTIONS（除了继承的）", () => {
  const spec = buildHostSpawnSpec({
    decision: { transport: "node", code: "env_node", reason: "x" },
    entry: "entry.js",
    env: { PATH: "/bin" },
    binaryPath: "/bin/PiForge",
    heap: EMPTY_HEAP,
  });
  assert.equal("NODE_OPTIONS" in spec.env, false);
});

test("stdin 关闭协议：electron 侧实现与 contract/host-stdin.ts 逐字节一致（两份实现不能漂）", () => {
  for (const reason of [undefined, "app-quit", "before-quit"]) {
    assert.equal(hostShutdownFrame(reason), shared.hostShutdownFrame(reason));
    assert.deepEqual(
      parseHostStdinLine(hostShutdownFrame(reason)),
      shared.parseHostStdinLine(shared.hostShutdownFrame(reason)),
    );
  }
  for (const line of ["", "{}", "not json", '{"type":"shutdown","reason":1}', '{"type":"ping"}']) {
    assert.deepEqual(parseHostStdinLine(line), shared.parseHostStdinLine(line));
  }
});
