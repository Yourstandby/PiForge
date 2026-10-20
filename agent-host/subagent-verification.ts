/**
 * Sub-agent verification guardrail (v0.5.0 stage 8 step 4).
 *
 * Children are read-only, so the Host cannot re-run their tests. Instead it
 * inspects the final report (and the tools they called) for concrete execution
 * evidence: a test/build/lint/typecheck result with a pass/fail outcome.
 * No evidence => `verified: false`, which is surfaced in the UI but does NOT
 * block the parent by default.
 */
import type {
  SubagentToolCallView,
  SubagentVerification,
} from "../contract/domains/subagents.ts";

const MAX_EVIDENCE = 5;
const MAX_EVIDENCE_LINE = 240;
const MAX_OUTPUT_SCAN = 20_000;

/** "tests passed", "12 passing", "tsc --noEmit: 0 errors", "build succeeded". */
const SUCCESS_RE =
  /\b(?:tests?|specs?|suites?|vitest|jest|pytest|tsc|typecheck|type-check|lint|eslint|build|compile)\b[^\n]{0,120}?\b(?:pass(?:ed|es|ing)?|ok|success(?:ful(?:ly)?)?|green|0 (?:failed|failures?|errors?)|no (?:failures?|errors?)|clean)\b/i;

/** "3 tests failed", "1 failing", "build failed". */
const FAILURE_RE =
  /\b(?:tests?|specs?|suites?|vitest|jest|pytest|tsc|typecheck|type-check|lint|eslint|build|compile)\b[^\n]{0,120}?\b(?:fail(?:ed|ing|ures?)?|errors?|broken)\b/i;

const NEGATION_RE =
  /\b(?:not|didn'?t|did not|unable to|cannot|can'?t|couldn'?t)\b[^\n]{0,40}\b(?:run|execute|verify|test)\b|未(?:运行|执行)|无法(?:运行|执行)|没有(?:运行|执行)/i;

/** Commands that would produce verification evidence if they had run. */
const TEST_COMMAND_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|vitest|jest|tsc|lint|typecheck|build)\b|\b(?:tsc|eslint|vitest|jest|pytest|go test|cargo test|dotnet test)\b/i;

const TEST_PATH_RE =
  /(?:^|[\s"'`(])(?:[\w.@-]+\/)*(?:__tests__|tests?|specs?)\/[\w./-]+|[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?/i;

function bounded(line: string): string {
  const clean = line.replace(/\s+/g, " ").trim();
  return clean.length > MAX_EVIDENCE_LINE ? `${clean.slice(0, MAX_EVIDENCE_LINE - 1)}…` : clean;
}

function pushUnique(target: string[], value: string): void {
  if (target.length >= MAX_EVIDENCE) return;
  if (!target.includes(value)) target.push(value);
}

export interface SubagentVerificationInput {
  output: string;
  toolCalls: Array<Pick<SubagentToolCallView, "name" | "detail">>;
}

export function checkSubagentVerification(
  input: SubagentVerificationInput,
  now: number = Date.now(),
): SubagentVerification {
  const output = (input.output ?? "").slice(-MAX_OUTPUT_SCAN);
  const evidence: string[] = [];
  let success = 0;
  let failure = 0;
  let weak = 0;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = bounded(rawLine);
    if (!line || NEGATION_RE.test(line)) continue;
    if (TEST_PATH_RE.test(line)) {
      weak += 1;
      pushUnique(evidence, `test reference: ${line}`);
      continue;
    }
    if (FAILURE_RE.test(line) && !/0 (?:failed|failures?|errors?)/i.test(line)) {
      failure += 1;
      pushUnique(evidence, `failure: ${line}`);
      continue;
    }
    if (SUCCESS_RE.test(line)) {
      success += 1;
      pushUnique(evidence, `result: ${line}`);
    }
  }

  for (const call of input.toolCalls) {
    const detail = (call.detail ?? "").trim();
    if (!detail) continue;
    if (call.name === "bash" || call.name === "powershell") {
      if (TEST_COMMAND_RE.test(detail)) {
        weak += 1;
        pushUnique(evidence, `command: ${bounded(detail)}`);
      }
    } else if (TEST_PATH_RE.test(detail)) {
      weak += 1;
      pushUnique(evidence, `inspected: ${bounded(detail)}`);
    }
  }

  if (failure > 0) {
    return {
      verified: false,
      checkedAt: now,
      reason: `完成报告包含 ${failure} 条测试/构建失败证据`,
      evidence,
    };
  }
  if (success > 0) {
    return {
      verified: true,
      checkedAt: now,
      reason: `找到 ${success} 条测试/构建通过证据`,
      evidence,
    };
  }
  if (weak > 0) {
    return {
      verified: false,
      checkedAt: now,
      reason: "只引用了测试文件或命令，但没有执行结果",
      evidence,
    };
  }
  return {
    verified: false,
    checkedAt: now,
    reason: "未找到测试执行证据",
    evidence: evidence.length > 0 ? evidence : ["no verification evidence in the final report"],
  };
}
