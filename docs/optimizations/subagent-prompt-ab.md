# 子 Agent 提示词对照实验（旧 vs JSON 契约）

> 状态：**脚本已交付，正式对照未执行**（本轮按约定只写实现 + 实验脚本）。
> 相关文档：token 线收口 [`token-line-closure.md`](./token-line-closure.md) ·
> A/B 方法学 [`context-governance-ab.md`](./context-governance-ab.md) ·
> 实验工具坑位 [`preview-harness-pitfalls.md`](./preview-harness-pitfalls.md)。

## 0. 一句话

把「子 Agent 的输出契约」从"散文报告"改成"可应用的 `git diff` + 最终回复 JSON"，
预期收益是**主 Agent 不用再人肉落地补丁**、且输出 token 更短。这份文档给出判据、
脚本用法和**先说清楚的偏差风险**，跑之前请把 §5 读一遍。

## 1. 两条被固化的约束（落点）

| # | 约束 | 落点文件 | 验收方式 |
|---|---|---|---|
| 1 | **diff 必须可应用**：代码修改只输出 `git diff`，且必须能 `git apply`；给不出补丁 → `status: need_help` 并说明缺什么 | `agent-host/subagent-prompt.ts`（`PATCH_CONTRACT`）/ 由 `subagents.ts`、`herdr-manager.ts` 共用 | `subagent-prompt.test.ts`：prompt 必须含 `git apply`、`Never describe a change as prose instead of a patch`、`need_help`；实验里用 `git apply --check` 实测 |
| 2 | **JSON 只约束最终回复**：工具调用阶段（read/grep/edit/bash）不受 JSON 限制；只有返回主 Agent 的那一条是 `status/conclusion/key_changes/patch/error_trace/next_steps` | 同上（`TOOL_PHASE_EXEMPTION` + `FINAL_REPLY_CONTRACT`） | `subagent-prompt.test.ts`：必须含 `Do NOT wrap tool calls in JSON`、`free to call tools normally`；并断言不存在 "every message/turn must be JSON" 之类误读 |

两条都是**默认生效**的（`PIFORGE_SUBAGENT_PROMPT` 默认 `contract`），回退：`PIFORGE_SUBAGENT_PROMPT=legacy`。

### 为什么约束 2 必须写清楚

一个 prompt 里同时要求"结构化输出"和"干活"，模型很容易理解成"每一步都要 JSON"：
于是把 `read` 的意图写进 JSON 文本里、工具根本没被调用，最后编一个结论交差。
所以 prompt 里显式写了顺序：**先调用工具、最后才格式化**。

## 2. 两条开发版专用约束

| # | 约束 | 落点 | 说明 |
|---|---|---|---|
| 3 | 会话隔离：子 Agent 不写进共享 `~/.pi/agent/sessions` | `agent-host/session-isolation.ts` + `subagents.ts` 的启动守卫 | 现状本来就是 `SessionManager.inMemory()`（**零落盘**，所以 `audit:token` 里从来没有子 Agent 记录）。新增 `PIFORGE_SESSION_DIR` 供"需要落盘的实验/工具"使用，并在 host 侧校验：指向共享 `sessions/` 内部 → **拒绝并回落 in-memory** |
| 4 | 「无进展」按**可观测事件**判定 | `agent-host/progress-guard.ts` + 两个 runner | 旧口径按"连续 N 轮没有结论"会误杀探索性任务（前几轮只 `read`/`grep` 是正常节奏）。新口径：`read`/`grep`/`find`/`ls`/`bash`/`edit`/`write` 等**任何动作**都算进展，连续 **5 轮**什么都没有才判空转 |

细则（都在单测里）：

- 不算进展的元动作：`tool_search`、`memory*`、`spawn_agent`、`herdr_spawn/status`、`orchestrator_status` —— 它们不改变"对任务的理解"，只是绕圈；
- 中途只要出现一次动作就清零（不是"累计 5 次空转"）；
- 阈值可覆盖（`checkProgressBudget(state, threshold)`），最小为 1；
- 对**一次性子 Agent**：轮数阀门（3 轮）先到期，空转判定是第二道网；
- 对**常驻舰队 Agent**：没有轮数上限，所以这条是它**唯一**的空转刹车。

## 3. 实验设计（`scripts/ab-subagent-prompt.mjs`）

```
node scripts/ab-subagent-prompt.mjs --plan        # 只打印方案与预算（默认，不花 token）
node scripts/ab-subagent-prompt.mjs --selfcheck   # 自检判据（不花 token）
node scripts/ab-subagent-prompt.mjs --run --spend # 真跑（2 臂 × 3 次）
node scripts/ab-subagent-prompt.mjs --report      # 汇总 + 判据
```

- **任务**（两臂完全相同）：修复 `fixture/guards.mjs` 里 `shouldStop()` 的 off-by-one，
  验收 `node --test fixture/guards.test.mjs` 通过。fixture 由脚本在临时 worktree 里生成，
  不依赖仓库现有文件（仓库改动不会让实验失效）。
- **两臂**：`PIFORGE_SUBAGENT_PROMPT=legacy` vs `contract`（只差 system prompt 变体）。
- **隔离**：每次一个独立 `git worktree` + 独立 agent 目录 + `PIFORGE_SESSION_DIR`
  （复用真实 auth/models，但会话不落共享目录）。
- **采集**：输出 token、总成本、成功率（验收退出码）、**补丁能否 `git apply`**（= 是否需要人工补丁）、轮数。

### `--plan` 实测输出

```
子 Agent 提示词对照实验（未执行）
  任务：fix-guard-threshold —— 修复 fixture/guards.mjs 的 off-by-one，验收 node --test 通过
  两臂：PIFORGE_SUBAGENT_PROMPT=legacy  vs  PIFORGE_SUBAGENT_PROMPT=contract
  跑次：6（2 臂 × 3 次），每次一个独立 git worktree
  隔离：独立 agent 目录 + PIFORGE_SESSION_DIR（不写共享 ~/.pi/agent/sessions）
  采集：输出 token / 总成本 / 成功率 / 补丁可 git apply（= 需人工补丁次数）
  预估：48 次调用 ≈ $0.11（每题按 8 次调用估）
  判据：contract 输出 token −30% 且 成功率不降 且 人工补丁 = 0
```

### `--selfcheck` 实测输出（判据可信度）

```
  PASS fixture 初始是红的（验收失败）（exit=1）
  PASS 正确补丁能 git apply（applies=true）
  PASS apply 后验收变绿（exit=0）
  PASS 错误补丁被拒（不会误判成可应用）（applies=false）
  PASS 散文描述被判无补丁（source=prose）
  PASS ```diff 围栏能被提取（source=fenced）
  PASS JSON.patch 字段能被提取（source=json_field）
```

这七条是**实验能不能被信任**的前提：如果"散文"也被判成有补丁，那"人工补丁次数"这个指标就是假的。

## 4. 判据

| 判据 | 阈值 | 为什么 |
|---|---|---|
| contract 臂输出 token | **−30%** 相对 legacy | 结构化 JSON + 只给 diff，理论上比散文报告短 |
| 成功率 | **不下降** | 契约不能以"少说话"为代价换来"不敢干活" |
| 需人工补丁次数（contract） | **= 0** | 这是约束 1 的核心承诺；legacy 臂允许 >0（这正是要解决的问题） |

补充观察项（不参与判定，但要记录）：轮数、总成本、`patchSource`
（`fenced` / `bare` / `json_field` / `prose`）—— 如果 contract 臂大量落在 `prose`，
说明 prompt 没被遵守，比 token 数字更值得关注。

## 5. 偏差风险（跑之前必须接受）

1. **样本太小**：6 次（每臂 3 次）只能看方向，不能给显著结论。要下结论至少每臂 10 次（20 次 ≈ $0.4）。
2. **任务太窄**：单文件 off-by-one 是"最容易被 diff 契约覆盖"的任务类型。
   真实任务是跨文件改动时，`git apply` 的上下文匹配率会下降 —— 那时"人工补丁次数"可能不降反升。
3. **输出 token 的 −30% 可能高估**：legacy 臂的散文报告本来也不长（几百 token），
   而 contract 臂多了 JSON 骨架的固定开销。**如果实测只降 10–20%，也是可接受的结果**，
   真正的收益在"无需人工落地补丁"。
4. **单一模型**：结论只对当前默认模型成立；换模型要重跑（与 token 线收口文档里的重启条件一致）。

## 6. 建议下一步

1. 先跑 `--selfcheck`（已通过）+ `--run --spend`（6 次 ≈ $0.11）看方向；
2. 若方向为正（token 降 + 补丁可用），再加到每臂 10 次并换一个**跨文件**任务复测；
3. 若 contract 臂出现"不敢动手、直接 need_help"的比例升高，就收紧 `PATCH_CONTRACT`
   （加一句"先改文件再用 `git diff` 生成补丁，不要尝试手写补丁上下文"）。
