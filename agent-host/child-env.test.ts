import test from "node:test";
import assert from "node:assert/strict";
import { managedProcessEnv, stripElectronRunAsNode } from "./child-env.ts";

test("stripElectronRunAsNode: 去掉两个 Electron-as-Node 变量，其它原样保留", () => {
  const env = {
    ELECTRON_RUN_AS_NODE: "1",
    ELECTRON_RUN_AS_NODE_ENABLED: "1",
    PATH: "C:\\Windows",
    SystemRoot: "C:\\Windows",
    PIFORGE_AGENT_TOKEN: "keep-me",
  };
  assert.deepEqual(stripElectronRunAsNode(env), {
    PATH: "C:\\Windows",
    SystemRoot: "C:\\Windows",
    PIFORGE_AGENT_TOKEN: "keep-me",
  });
});

test("managedProcessEnv: 受管进程永远拿不到 ELECTRON_RUN_AS_NODE（L1 风险 #3）", () => {
  const env = managedProcessEnv({ ELECTRON_RUN_AS_NODE: "1", PATH: "/bin" });
  assert.equal("ELECTRON_RUN_AS_NODE" in env, false);
  assert.equal(env.FORCE_COLOR, "0");
  assert.equal(env.NO_COLOR, "1");
  assert.equal(env.PATH, "/bin");
});

test("managedProcessEnv: extra 最后合并，可覆盖固定项", () => {
  const env = managedProcessEnv({ PATH: "/bin" }, { FORCE_COLOR: "1", PSModulePath: "C:\\m" });
  assert.equal(env.FORCE_COLOR, "1");
  assert.equal(env.PSModulePath, "C:\\m");
});

test("managedProcessEnv: 空环境也能得到稳定的固定项", () => {
  assert.deepEqual(managedProcessEnv({}), { FORCE_COLOR: "0", NO_COLOR: "1" });
});

test("stripElectronRunAsNode: 保留 undefined 键（调用方自行过滤），不抛错", () => {
  const out = stripElectronRunAsNode({ A: undefined, ELECTRON_RUN_AS_NODE: "1" });
  assert.deepEqual(Object.keys(out), ["A"]);
  assert.equal(out.A, undefined);
});
