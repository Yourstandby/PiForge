/**
 * 结构护栏：编排面板必须把「隔离的代价」摆在用户眼前。
 *
 * 两条约束：
 *   1. 授予 bash 的 worker 要在界面上被标出来 —— worktree 不是沙箱，这是风险信息，
 *      不能只存在于 Host 的状态里；
 *   2. 干完的 worker 要么显示「已合回」，要么给出「合回」入口 —— 否则隔离成果
 *      永远留在另一个目录里，用户以为活干完了。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");

test("面板把授予 bash 的 worker 标出来", () => {
  const src = read("components/OrchestratorPanel.tsx");
  assert.match(src, /task\.allowBash/, "必须渲染 allowBash 状态");
  assert.match(src, /不是沙箱/, "徽章要说明这是风险而不是能力");
});

test("干完的 worker 有合回入口，合回后显示提交", () => {
  const src = read("components/OrchestratorPanel.tsx");
  assert.match(src, /task\.mergedAt/, "必须渲染已合回状态");
  assert.match(src, /mergedCommit/, "合回后要显示提交号");
  assert.match(src, /canMerge\(/, "未合回且已结束的 worker 要给出合回按钮");
  assert.match(src, /action: "merge"/, "合回动作走后端通道");
});

test("面板不自己跑 git：只调本地 API", () => {
  const src = read("components/OrchestratorPanel.tsx");
  assert.doesNotMatch(src, /execFile|spawnSync|simple-git/, "前端不得直接执行 git");
  assert.match(src, /fetch\("\/api\/orchestrator"/);
});

test("merge 路由带 origin 校验，并映射到 host 的 orchestrator.merge", () => {
  const src = read("app/api/orchestrator/route.ts");
  const mergeBranch = src.slice(src.indexOf('body.action === "merge"'));
  assert.ok(mergeBranch.length > 0, "缺少 action=merge 分支");
  assert.match(mergeBranch, /validateRequestOrigin/, "合并会写仓库，必须校验来源");
  assert.match(mergeBranch, /orchestrator\.merge/);
});

test("host 把合并失败的原因映射成可操作的错误码", () => {
  const src = read("agent-host/server.ts");
  assert.match(src, /"MERGE_CONFLICT"/);
  assert.match(src, /"WORKTREE_DIRTY"/);
  assert.match(src, /case "orchestrator\.merge"/);
});
