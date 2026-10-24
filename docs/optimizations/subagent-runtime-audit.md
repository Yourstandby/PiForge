# 子 Agent 运行时审计：有效工作时间占比

> 口径：真实 `spawnSubagent()` 路径（`agent-host/subagents.ts`）+ 真实模型 `deepseek/deepseek-flash`，
> 17 次派发，探针脚本在 `tmp/subagent-audit/`（未提交、不改产品代码）。
> 相关文档：[`token-consumption-audit.md`](./token-consumption-audit.md) · [`subagent-prompt-ab.md`](./subagent-prompt-ab.md) · [`token-line-closure.md`](./token-line-closure.md)

## 0. 先说三件"拿不到"的事（不是省事，是现在的代码就取不到）

| 想要的指标 | 现状 | 原因 |
|---|---|---|
| 每个子 Agent 的 `cacheRead` / `input` / `output` | **不可观测** | `record.usage` 在 `subagents.ts:373-377` 被累计，但**全仓没有一处读取**；`SubagentView` 里也没有 usage 字段，`subagents.list` 与面板都拿不到 |
| 子 Agent 的会话 JSONL（可事后 grep usage） | **不存在** | `SessionManager.inMemory()` 硬编码在 `subagents.ts:345`。上一版加的 `PIFORGE_SESSION_DIR` 只被 `resolveChildSessionDir()` 求值后**打了一行日志**（`subagents.ts:324-327`），`isolation` 变量此后未被使用 → 这个开关**没接线** |
| `PIFORGE_DEBUG_API=1` 能给出 usage | **不能** | 它只打印 HTTP 路由耗时（`server.ts:745-748`）和路由首载 heap（`api-router.ts:159`），与 token 无关 |

所以本报告**不伪造** token 列：下表 `cacheRead` / `output` 一律标 `n/a`，改用"墙钟 + 工具区间 + 可用结论"三个真能测的量，
外加一次账户级成本实测（DeepSeek 余额粒度 ¥0.01，本次 4 路并发 Δ<¥0.01，**低于可测粒度**）。

## 1. 主表：单次子 Agent 调用（n=17）

说明：`工具耗时` = 该子 Agent 所有工具调用区间的**并集**（并发工具不重复计时）；
`模型等待` = 总时长 − 工具耗时（含首 token 延迟，即 prompt 处理 + 生成间隙）；
`有效产出` = 主 Agent **最终真正拿到**的可用结论字符数（cancelled 一律 0 —— 见 §4）。

| # | 臂 / 子 Agent | 总时长 | 工具耗时 | 模型等待 | 首 token | 有效产出 | cacheRead | output |
|---|---|---|---|---|---|---|---|---|
| 1 | same-1 audit-guards | 4463ms | 837ms (19%) | 3626ms | 1527ms | 0 | n/a | n/a |
| 2 | same-2 audit-guards | 5020ms | 1033ms (21%) | 3987ms | 1318ms | 0 | n/a | n/a |
| 3 | same-3 audit-guards | 4670ms | 907ms (19%) | 3763ms | 1436ms | 0 | n/a | n/a |
| 4 | same-4 audit-guards | 4280ms | 919ms (21%) | 3361ms | 1431ms | 0 | n/a | n/a |
| 5 | split m-guards | 3989ms | 333ms (8%) | 3656ms | 3988ms | 0 | n/a | n/a |
| 6 | split m-progress | 3970ms | 303ms (8%) | 3667ms | 3969ms | 0 | n/a | n/a |
| 7 | split m-toolgrants | 5217ms | 1610ms (31%) | 3607ms | 5216ms | 0 | n/a | n/a |
| 8 | split m-contextbudget | 5443ms | 1595ms (29%) | 3848ms | 1738ms | 0 | n/a | n/a |
| 9 | tiny-1 | 3396ms | 253ms (7%) | 3143ms | 3396ms | **621c** | n/a | n/a |
| 10 | tiny-2 | 2911ms | 317ms (11%) | 2594ms | 1502ms | **521c** | n/a | n/a |
| 11 | tiny-3 | 2973ms | 108ms (4%) | 2865ms | 2973ms | 0 | n/a | n/a |
| 12 | tiny-4 | 2505ms | 94ms (4%) | 2411ms | 2504ms | **341c** | n/a | n/a |
| 13 | tiny-5 | 3250ms | 109ms (3%) | 3141ms | 3250ms | 0 | n/a | n/a |
| 14 | tiny-6 | 3413ms | 181ms (5%) | 3232ms | 3413ms | 0 | n/a | n/a |
| 15 | tiny-7 | 3653ms | 233ms (6%) | 3420ms | 3653ms | 0 | n/a | n/a |
| 16 | tiny-8 | 2124ms | 101ms (5%) | 2023ms | 2123ms | **388c** | n/a | n/a |
| 17 | solo guards（3 问） | 3911ms | 331ms (8%) | 3580ms | 1093ms | 0 | n/a | n/a |

分臂汇总：

| 臂 | 并发 | 墙钟 | Σ 单次 | 工具占比中位 | 成功 | 主 Agent 阻塞 |
|---|---|---|---|---|---|---|
| same（同题 ×4） | 4 | 5024ms | 18433ms | 20% | **0/4** | 100% |
| split（4 内聚模块） | 4 | 5452ms | 18619ms | 19% | **0/4** | 100% |
| tiny（单问 ×4，跑两轮） | 4 | 3528ms | ~24s | 5% | **4/8** | 100% |

## 2. 上下文规模

| 项 | 实测 | 来源 |
|---|---|---|
| 子 Agent 固定前缀（`contract` 变体，默认） | **2474 字符 ≈ 728 tok** | `buildSubagentSystemPrompt()` 实算 |
| 同上，`legacy` 变体（对照） | 529 字符 ≈ 156 tok | 同上；默认是 `contract` |
| 仓库上下文文件 / skills / 扩展 / MCP | **0**（`noContextFiles/noSkills/noExtensions: true`） | `subagents.ts:328-338` |
| 单轮上下文硬闸 | 10 000 tok（`CONTEXT_BREAKER_TOKENS`） | `agent-guards.ts:19` |
| 回主 Agent 的摘要上限 | 1200 字符（≈300 tok） | `agent-guards.ts:20` |
| 每次调用的 cacheRead / output | **不可测**（见 §0） | — |

推论：所谓"上下文加载耗时"在子 Agent 上是**近似零**——它压根不加载项目上下文，前缀只有 728 tok。
首 token 延迟（1.1–5.2s）不是加载上下文，而是**模型处理 prompt + 思考**的时间，属于"等待"而不是"干活"。

## 3. 并行度

- 并发上限 `MAX_RUNNING = 4`（`subagents.ts:51`），实测 4 路能真并发：墙钟 5024ms vs Σ 18433ms ≈ **3.7× 加速**。
- **主 Agent 等待占比 = 100%**：`spawn_agent` 是同步工具调用，`await session.prompt(task)` 返回前主 Agent 什么都不能做；
  4 路并发的全部收益都体现在"这一段阻塞变短"，而没有体现在"主 Agent 同时干别的"。
- 并行没有串行化的浪费：4 路 `startedAt` 差 <120ms，无排队。

## 4. 任务切分：不是"单文件 vs 内聚模块"的问题，是"内聚模块 × 2 轮"的问题

- 子 Agent 只拿到 `task` 文本 + `cwd` + 工具白名单；**没有任何跨 Agent 上下文传递**（父会话 JSONL 不可见、上下文文件被禁用）。
  证据：16/16 次运行都以 `find`/`ls`/`grep` 重新找路开头，同一个文件被 4 个 Agent 各找一遍。
- 每个"内聚模块"任务实际需要 **4–5 次工具调用**（`find → read → grep → read …`）。
- 但轮数阀门 `checkTurnBudget(assistantTurns + 1)` 在 `nextTurn >= 3` 时就 abort（`subagents.ts:355-364` + `agent-guards.ts:33-37`），
  即**实际只有 2 轮可用**。结果：

```
solo 实测时间线（第 3 轮 message_end 被中断）：
1093ms  TEXT  "我会定位到该文件…" + find
2412ms  read ok
3908ms  【轮数上限】已用满 3 轮对话上限 → abort，进行中的 grep 立刻 error
3911ms  FINISHED cancelled
```

- 8/8 的内聚模块任务（same ×4 + split ×4）全部撞上轮数阀门；**已经读到的结论被丢弃**：
  `ok === false` 分支只回 `Sub-agent "x" was cancelled.`（43–50 字符），
  `finalText` 已经算出来了却没被使用 → 主 Agent 只能重开一个新子 Agent 再烧一遍。

## 5. 异构性：4 个子 Agent 是同构的

- 代码层：`spawnSubagent()` 的 `model` 默认继承父 Agent（`subagents.ts:345-352`），system prompt 是**单一变体**，
  **任何调用方都无法让 4 个子 Agent 有不同的模型或不同的提示词**；可变的只有 `task` 文本与工具白名单。
- 实测层（same 臂）：4 个相同 prompt 的子 Agent 工具序列**逐条相同**（`find → ls → read → grep`，4/4），
  耗时 4280–5020ms，失败方式完全一致 → 4 路并发等于**同一次调用重复 4 次**，增量信息 = 0。

## 6. 一句话结论

**瓶颈在任务切分（不是上下文加载，也不是并行协调）**：内聚模块任务需要 4–5 次工具调用，而轮数阀门实际只给 2 轮 →
8/8 模块任务被判"超轮次取消"且结论被丢弃，成功率 4/17 ≈ 24%，且这 4 次成功全部来自"单问、1–2 次工具调用"的琐碎任务；
工具执行只占墙钟 5–20%，上下文前缀只有 728 tok，4 路并行确实拿到 3.7× 加速但产出是 0。

## 7. 三个可验证的改进假设（不改代码，只列假设 + 验证方法）

### H1（最大收益）：轮数口径 off-by-one，放宽 1 轮就能让模块任务收口

- **假设**：`checkTurnBudget(nextTurn)` 用 `used < maxTurns` 判定，`nextTurn = assistantTurns + 1`，
  等价于**只允许 2 轮真实产出**。把它改成"第 3 轮 message_end 之后才拦"（或多给 1 轮），
  内聚模块任务成功率可从 0/8 升到 ≥6/8，且总墙钟时间不明显上升（多 1 轮 ≈ +1.3s，仍在并行窗口内）。
- **验证方法**：固定 4 个模块任务、`n=8`，两臂只差"任务能用的轮数"——臂 A 用现网默认，臂 B 在探针里把
  任务拆成"2 个问题 / 每个子 Agent"（等价于放宽预算，不改产品代码）。判据：成功率 A≈0 → B≥75%，
  且 Σ工具耗时不变 → 说明瓶颈是轮数而不是任务难度。脚本：`tmp/subagent-audit/harness.mjs --arm split`。

### H2：缺跨 Agent 上下文传递，把 `file:line` 锚点写进 task 可省掉一半工具往返

- **假设**：子 Agent 每个任务的头 2 次工具调用（`find` + `ls`）纯粹在找路；若父 Agent 在 `task` 里直接给
  `agent-host/agent-guards.ts:33` 这样的锚点，工具调用数可从 4–5 降到 2–3，直接让 H1 的轮数压力消失。
- **验证方法**：同一 `m-guards` 任务两臂各 `n=8`：臂 A 只给模块名，臂 B 追加 3 个 `file:line` 锚点。
  判据：工具调用数中位 4.5 → ≤3、成功率显著上升、`totalMs` 不升。工具调用数与耗时可从
  `subagents.list()` 的 `toolCalls[].startedAt/endedAt` 直接读（无需新增日志）。

### H3：把已采集的 `record.usage` 暴露出来，token 才可审计（否则只能靠墙钟猜）

- **假设**：`record.usage`（`input/cacheRead/output/cost`）已经在累加却无人读取，`PIFORGE_SESSION_DIR` 也没接线，
  导致"子 Agent token 成本"永久不可量化。把 usage 汇入 `SubagentView`（或把 `isolation.dir` 真正交给 `SessionManager`）
  之后，每次派发的 cacheRead/output 可被直接读出，本表的 `n/a` 两列才有数。
- **验证方法（不依赖产品改动，先证伪"账户级可测"）**：本次已实测 DeepSeek 余额在 4 路并发前后的 Δ = ¥0.00（粒度 ¥0.01），
  **账户级不可分辨**。改用探针侧口径验证：给 `tmp/subagent-audit/` 探针加一个只读的 `onSubagentsChange` 采样
  （现在事件里没有 usage 字段，所以必须先暴露）——先跑一次 `--arm tiny` 记录 `subagents.list()` 的
  `durationMs`/`toolCalls` 作为基线，改动后再跑同一臂，判据：新增 usage 字段的 `cacheRead + input` 与
  "728 tok 前缀 × 轮数 + 工具输出"估算相差 <30%，即视为采集正确。

## 8. 复现

```bash
node tmp/subagent-audit/harness.mjs --arm same|split|tiny   # 4 路并发实测，写 run-*.json
node tmp/subagent-audit/agg.mjs                             # 汇总成本报告里的数字
node tmp/subagent-audit/prefix.mjs                           # 子 Agent 固定前缀字符/token
node tmp/subagent-audit/one.mjs                              # 单次调用时间线（含轮数阀门触发点）
```

偏差声明：单机、单模型（`deepseek-flash`）、17 次派发、温度非零（tiny 臂同题 8 次得到 4 成 4 败，说明
"能否在 2 轮内收口"本身有随机性 → H1 的收益应按成功率而非单次快慢评估）。
