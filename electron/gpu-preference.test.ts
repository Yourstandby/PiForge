import test from "node:test";
import assert from "node:assert/strict";
import {
  EVIDENCE_TTL_MS,
  SOFTWARE_LAUNCHES_THRESHOLD,
  describeReEvaluation,
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
  const evidence = recordGpuObservation(null, { compositing: "disabled_software" }, NOW);
  assert.equal(evidence.softwareLaunches, 1);
  const decision = resolveGpuMode({ evidence, env: {}, now: NOW + 1_000 });
  assert.equal(decision.mode, "default");
});

test("连续 2 次软件合成 → 本轮加 --disable-gpu（gpu 进程 ~254MB → ~155MB）", () => {
  let evidence = recordGpuObservation(null, { compositing: "disabled_software" }, NOW);
  evidence = recordGpuObservation(evidence, { compositing: "disabled_software" }, NOW + 1_000);
  assert.equal(evidence.softwareLaunches, SOFTWARE_LAUNCHES_THRESHOLD);
  const decision = resolveGpuMode({ evidence, env: {}, now: NOW + 2_000 });
  assert.equal(decision.mode, "nogpu");
  assert.deepEqual(decision.switches, ["disable-gpu"]);
  assert.match(decision.reason, /disabled_software/);
});

test("硬件加速恢复可用（enabled）→ 计数清零，下一轮回到默认", () => {
  let evidence = recordGpuObservation(null, { compositing: "disabled_software" }, NOW);
  evidence = recordGpuObservation(evidence, { compositing: "disabled_software" }, NOW + 1_000);
  assert.equal(resolveGpuMode({ evidence, env: {}, now: NOW + 2_000 }).mode, "nogpu");

  evidence = recordGpuObservation(evidence, { compositing: "enabled" }, NOW + 3_000);
  assert.equal(evidence.softwareLaunches, 0);
  assert.equal(resolveGpuMode({ evidence, env: {}, now: NOW + 4_000 }).mode, "default");
});

test("证据 30 天后过期 → 重新按默认探测（换机器能自愈）", () => {
  let evidence = recordGpuObservation(null, { compositing: "disabled_software" }, NOW);
  evidence = recordGpuObservation(evidence, { compositing: "disabled_software" }, NOW + 1_000);
  assert.equal(resolveGpuMode({ evidence, env: {}, now: NOW + EVIDENCE_TTL_MS + 5_000 }).mode, "default");
});

test("PIFORGE_GPU_MODE 可强制覆盖三个模式", () => {
  const software = recordGpuObservation(recordGpuObservation(null, { compositing: "disabled_software" }, NOW), { compositing: "disabled_software" }, NOW);
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
  assert.equal(parseGpuEvidence('{"version":3,"softwareLaunches":9}'), null, "未知版本");
  assert.equal(parseGpuEvidence('{"version":2,"lastGpuCompositing":"enabled"}'), null, "缺计数 → 视为损坏");
  assert.equal(parseGpuEvidence('{"version":2,"softwareLaunches":9}')?.softwareLaunches, 2, "有计数就接受（夹到阈值）");
  assert.equal(parseGpuEvidence('{"version":1}'), null);
  const parsed = parseGpuEvidence('{"version":1,"softwareLaunches":99,"lastGpuCompositing":"disabled_software","recordedAt":123}');
  assert.equal(parsed?.softwareLaunches, SOFTWARE_LAUNCHES_THRESHOLD, "计数被夹到阈值");
  assert.equal(parsed?.probedAt, 123, "v1 的 recordedAt 迁移为 probedAt");
});

test("emptyEvidence 是干净起点", () => {
  assert.deepEqual(emptyEvidence(), {
    version: 2,
    softwareLaunches: 0,
    lastGpuCompositing: null,
    probedAt: 0,
    gpuFeatureStatus: null,
    decision: null,
  });
});

test("计数不会超过阈值（避免证据文件无限增长）", () => {
  let evidence = emptyEvidence();
  for (let i = 0; i < 5; i += 1) evidence = recordGpuObservation(evidence, { compositing: "disabled_software" }, NOW + i);
  assert.equal(evidence.softwareLaunches, SOFTWARE_LAUNCHES_THRESHOLD);
});

test("v2 证据：完整快照 + 决策被解析出来（跨机器对齐用）", () => {
  const raw = JSON.stringify({
    version: 2,
    softwareLaunches: 2,
    lastGpuCompositing: "disabled_software",
    probedAt: 1_700_000_000_000,
    gpuFeatureStatus: { gpu_compositing: "disabled_software", opengl: "disabled_off" },
    decision: { mode: "nogpu", code: "consecutive_software" },
  });
  const parsed = parseGpuEvidence(raw);
  assert.equal(parsed?.gpuFeatureStatus?.opengl, "disabled_off");
  assert.deepEqual(parsed?.decision, { mode: "nogpu", code: "consecutive_software" });
  assert.equal(parsed?.probedAt, 1_700_000_000_000);
});

test("坏 decision 字段不会让整份证据失效（只丢弃该字段）", () => {
  const parsed = parseGpuEvidence(
    '{"version":2,"softwareLaunches":2,"lastGpuCompositing":"disabled_software","probedAt":5,"decision":{"mode":"weird","code":"nope"}}',
  );
  assert.equal(parsed?.softwareLaunches, 2);
  assert.equal(parsed?.decision, null);
});

test("describeReEvaluation 只在模式/依据变化时输出一行（可 grep）", () => {
  const nogpu = resolveGpuMode({
    evidence: recordGpuObservation(
      recordGpuObservation(null, { compositing: "disabled_software" }, NOW),
      { compositing: "disabled_software" },
      NOW + 1,
    ),
    env: {},
    now: NOW + 2,
  });
  assert.equal(nogpu.code, "consecutive_software");
  assert.equal(describeReEvaluation(null, nogpu), "gpu mode re-evaluated: none→nogpu, reason=consecutive_software");
  assert.equal(describeReEvaluation({ mode: "default", code: "observing" }, nogpu), "gpu mode re-evaluated: default→nogpu, reason=consecutive_software");
  assert.equal(describeReEvaluation({ mode: "nogpu", code: "consecutive_software" }, nogpu), null, "没变化就不刷日志");

  const expired = resolveGpuMode({ evidence: { ...nogpuEvidence(), probedAt: NOW - EVIDENCE_TTL_MS - 1 }, env: {}, now: NOW });
  assert.equal(expired.code, "expired");
  assert.match(String(describeReEvaluation({ mode: "nogpu", code: "consecutive_software" }, expired)), /nogpu→default, reason=expired/);
});

function nogpuEvidence() {
  return recordGpuObservation(
    recordGpuObservation(null, { compositing: "disabled_software" }, NOW),
    { compositing: "disabled_software" },
    NOW + 1,
  );
}
