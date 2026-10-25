import assert from "node:assert/strict";
import test from "node:test";
import {
  CODEMODE_WORKERS_ENV,
  DEFAULT_CODEMODE_MAX_WORKERS,
  applyCodemodeWorkerPool,
  formatCodemodeWorkerPoolLine,
  resolveCodemodeWorkerPool,
} from "./codemode-worker-pool.ts";

test("PI_CODEMODE_MAX_WORKERS=4 wins over the default", () => {
  const pool = resolveCodemodeWorkerPool({ env: { [CODEMODE_WORKERS_ENV]: "4" } });
  assert.deepEqual(pool, { value: 4, source: "env" });
});

test("an unusable env value falls back to the SDK default of 2", () => {
  for (const raw of ["", "  ", "abc", "0", "-1", "2.5", "NaN"]) {
    const pool = resolveCodemodeWorkerPool({ env: { [CODEMODE_WORKERS_ENV]: raw } });
    assert.deepEqual(pool, { value: DEFAULT_CODEMODE_MAX_WORKERS, source: "default" }, raw);
  }
  assert.deepEqual(resolveCodemodeWorkerPool({ env: {} }), {
    value: DEFAULT_CODEMODE_MAX_WORKERS,
    source: "default",
  });
});

test("the settings value wins over the environment", () => {
  const pool = resolveCodemodeWorkerPool({ setting: 6, env: { [CODEMODE_WORKERS_ENV]: "4" } });
  assert.deepEqual(pool, { value: 6, source: "setting" });
});

test("a settings value outside 1-8 is ignored, the env still applies", () => {
  for (const setting of [0, 9, 2.5, "4", null, undefined]) {
    const pool = resolveCodemodeWorkerPool({ setting, env: { [CODEMODE_WORKERS_ENV]: "4" } });
    assert.deepEqual(pool, { value: 4, source: "env" }, String(setting));
  }
});

test("applyCodemodeWorkerPool writes the env the SDK reads on every script", () => {
  const previous = process.env[CODEMODE_WORKERS_ENV];
  try {
    delete process.env[CODEMODE_WORKERS_ENV];
    const applied = applyCodemodeWorkerPool({ setting: 4 });
    assert.deepEqual(applied, { value: 4, source: "setting" });
    assert.equal(process.env[CODEMODE_WORKERS_ENV], "4");

    // 设置被清掉（null）且环境变量也没值时，回到默认 2。
    // 必须显式传 `env: {}`：不传就按模块加载时的启动快照解析，而在 PiForge 自己的
    // Host 子进程里 PI_CODEMODE_MAX_WORKERS=2 是继承来的，source 会是 env 而不是 default。
    const afterClear = applyCodemodeWorkerPool({ setting: null, env: {} });
    assert.deepEqual(afterClear, { value: DEFAULT_CODEMODE_MAX_WORKERS, source: "default" });
    assert.equal(process.env[CODEMODE_WORKERS_ENV], String(DEFAULT_CODEMODE_MAX_WORKERS));
  } finally {
    if (previous === undefined) delete process.env[CODEMODE_WORKERS_ENV];
    else process.env[CODEMODE_WORKERS_ENV] = previous;
  }
});

test("the startup log line names the pool size, its source and the hint", () => {
  const line = formatCodemodeWorkerPoolLine({ value: 4, source: "env" });
  assert.match(line, /codemode worker pool = 4/);
  assert.match(line, /source=env/);
  assert.match(line, /raise to 4 via settings or PI_CODEMODE_MAX_WORKERS/);
});
