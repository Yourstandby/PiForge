import test from "node:test";
import assert from "node:assert/strict";
import {
  EVIDENCE_TTL_MS,
  SOFTWARE_LAUNCHES_THRESHOLD,
  emptyEvidence,
  isSoftwareCompositing,
  parseGpuEvidence,
  recordGpuObservation,
  resolveGpuMode,
} from "./gpu-preference.ts";

const NOW = 1_700_000_000_000;

test("isSoftwareCompositing 只认软件合成的两种取值", () => {
  assert.equal(isSoftwareCompositing("disabled_software"), true);
  assert.equal(isSoftwareCompositing("unavailable_software"), true);
  assert.equal(isSoftwareCompositing("enabled"), false);
  assert.equal(isSoftwareCompositing("disabled_off"), false);
  assert.equal(isSoftwareCompositing(undefined), false);
});

test("首次启动没有证据 → 保持 Chromium 默认（不动 GPU 进程）", () => {
  const decision = resolveGpuMode({ evidence: null, env: {}, now: NOW });
  assert.equal(decision.mode, "default");
  assert.deepEqual(decision.switches, []);
});

test("只观察到 1 次软件合成时仍按默认跑（避免误判）", () => {
  const evidence = recordGpuObservation(null, "disabled_software", NOW);
  assert.equal(evidence.softwareLaunches, 1);
  const decision = resolveGpuMode({ evidence, env: {}, now: NOW + 1_000 });
  assert.equal(decision.mode, "default");
});

test("连续 2 次软件合成 → 本轮加 --disable-gpu（gpu 进程 ~254MB → ~155MB）", () => {
  let evidence = recordGpuObservation(null, "disabled_software", NOW);
  evidence = recordGpuObservation(evidence, "disabled_software", NOW + 1_000);
  assert.equal(evidence.softwareLaunches, SOFTWARE_LAUNCHES_THRESHOLD);
  const decision = resolveGpuMode({ evidence, env: {}, now: NOW + 2_000 });
  assert.equal(decision.mode, "nogpu");
  assert.deepEqual(decision.switches, ["disable-gpu"]);
  assert.match(decision.reason, /disabled_software/);
});

test("硬件加速恢复可用（enabled）→ 计数清零，下一轮回到默认", () => {
  let evidence = recordGpuObservation(null, "disabled_software", NOW);
  evidence = recordGpuObservation(evidence, "disabled_software", NOW + 1_000);
  assert.equal(resolveGpuMode({ evidence, env: {}, now: NOW + 2_000 }).mode, "nogpu");

  evidence = recordGpuObservation(evidence, "enabled", NOW + 3_000);
  assert.equal(evidence.softwareLaunches, 0);
  assert.equal(resolveGpuMode({ evidence, env: {}, now: NOW + 4_000 }).mode, "default");
});

test("证据 30 天后过期 → 重新按默认探测（换机器能自愈）", () => {
  let evidence = recordGpuObservation(null, "disabled_software", NOW);
  evidence = recordGpuObservation(evidence, "disabled_software", NOW + 1_000);
  assert.equal(resolveGpuMode({ evidence, env: {}, now: NOW + EVIDENCE_TTL_MS + 5_000 }).mode, "default");
});

test("PIFORGE_GPU_MODE 可强制覆盖三个模式", () => {
  const software = recordGpuObservation(recordGpuObservation(null, "disabled_software", NOW), "disabled_software", NOW);
  assert.equal(resolveGpuMode({ evidence: software, env: { PIFORGE_GPU_MODE: "default" }, now: NOW }).mode, "default");
  assert.deepEqual(
    resolveGpuMode({ evidence: null, env: { PIFORGE_GPU_MODE: "nogpu" }, now: NOW }).switches,
    ["disable-gpu"],
  );
  assert.deepEqual(
    resolveGpuMode({ evidence: null, env: { PIFORGE_GPU_MODE: "inprocess" }, now: NOW }).switches,
    ["in-process-gpu"],
  );
  // 大小写/空格容错
  assert.equal(resolveGpuMode({ evidence: null, env: { PIFORGE_GPU_MODE: " NoGPU " }, now: NOW }).mode, "nogpu");
});

test("证据文件损坏 / 版本不符 → 当作没有证据（绝不因为坏文件关掉硬件加速）", () => {
  assert.equal(parseGpuEvidence(null), null);
  assert.equal(parseGpuEvidence("not json"), null);
  assert.equal(parseGpuEvidence('{"version":2,"softwareLaunches":9}'), null);
  assert.equal(parseGpuEvidence('{"version":1}'), null);
  const parsed = parseGpuEvidence('{"version":1,"softwareLaunches":99,"lastGpuCompositing":"disabled_software","recordedAt":123}');
  assert.equal(parsed?.softwareLaunches, SOFTWARE_LAUNCHES_THRESHOLD, "计数被夹到阈值");
  assert.equal(parsed?.recordedAt, 123);
});

test("emptyEvidence 是干净起点", () => {
  assert.deepEqual(emptyEvidence(), {
    version: 1,
    softwareLaunches: 0,
    lastGpuCompositing: null,
    recordedAt: 0,
  });
});

test("计数不会超过阈值（避免证据文件无限增长）", () => {
  let evidence = emptyEvidence();
  for (let i = 0; i < 5; i += 1) evidence = recordGpuObservation(evidence, "disabled_software", NOW + i);
  assert.equal(evidence.softwareLaunches, SOFTWARE_LAUNCHES_THRESHOLD);
});
