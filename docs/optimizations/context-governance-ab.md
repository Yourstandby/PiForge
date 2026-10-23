# 上下文治理 A/B 实验方案（L-D + L-B）

> 状态：**方案已落地，本轮不执行**。判分集与执行器都已提交并自检通过：
> `node scripts/ab-context-eval.mjs --validate` / `--selfcheck` / `--plan`。
> 真跑必须显式 `--run --spend`（预估 80 次任务 / 1 200 次模型调用 / ≈$2.6）。

## 0. 为什么先做 L-D 和 L-B

token 审计（`docs/optimizations/token-consumption-audit.md`）的结论是：成本大头是
**每次调用重读上下文**（cacheRead 56% = $12.51/$22.36，请求级中位 146 176 tok/p90 491 392），
而缓存失效只占 6%（前缀失效 5% + 空闲恢复 1%）。所以能动的杠杆只有两个方向：

1. **少读**（缩小每轮上下文）：L-D 工具输出阈值、L-A 压缩阈值；
2. **别拖长**（别让会话长到 400k）：L-B 会话拆分提示。

L-C（subagent 隔离）已用 `audit-subagent-share.mjs` 量化掉了：**上界 0.004%**，
且隔离机制本来就在（见 `context-governance-plan.md` 的 L-C 节），不立项。

## 1. L-D 的前提被实测推翻：基线已经是 4 000 字符

原方案写的是"落盘/截断阈值 8k → 4k"。实测 `agent-host/tool-output-budget.ts`：

| 常量 | 现值 | 说明 |
|---|---|---|
| `DEFAULT_TOOL_OUTPUT_BUDGET.maxChars` | **4 000** | bash / grep / 其它工具输出 |
| `READ_TOOL_OUTPUT_BUDGET.maxChars` | **4 000** | `read` 的文件内容 |
| `DEFAULT_TOOL_OUTPUT_BUDGET.maxLines` | 60 | 行数兜底 |

也就是说 **8k→4k 这件事早就做过了**。因此 A/B 的两臂改成：

- **control**：4 000 字符（现状）；
- **treatment（L-D）**：2 000 字符（`PIFORGE_TOOL_OUTPUT_CHARS=2000`）。

风险方向要说清楚：阈值再收紧会**增加"模型没看全 → 再读一次"的概率**，
所以这个实验有可能是**负收益**（cacheRead 降了但调用次数涨了）。判据里必须同时看
"每次调用 cacheRead"和"每题调用次数"，只看前者会被骗。

## 2. 开关设计（独立、可组合、默认不变）

| 组 | host 环境变量 | 行为 |
|---|---|---|
| `control` | 无 | 现状 |
| `L-D` | `PIFORGE_TOOL_OUTPUT_CHARS=2000` | 工具输出上限 4 000 → 2 000 字符 |
| `L-B` | `PIFORGE_SESSION_SPLIT_HINT=1` | 上下文 ≥200k 时在输入框上方给"开新会话"提示（复用 `lib/token-guard.ts` 的 `session-too-long`，仅提示，不阻断） |
| `L-D+L-B` | 两者都设 | 检验是否叠加 |

实现要求（**尚未实现，等 A/B 立项后才写**）：
- `PIFORGE_TOOL_OUTPUT_CHARS` 在 `toolOutputBudget()` 里读一次环境变量，缺省 4 000；
  非法值（非数字 / <500）忽略并保留默认 —— 与 `PIFORGE_HOST_HEAP` 同样的宽松策略。
- `PIFORGE_SESSION_SPLIT_HINT` 只控制渲染层提示是否显示；**不改任何前缀/工具定义**。
- 两个开关都只在启动时读一次，运行期不变（避免 A/B 中途漂移）。

## 3. 判分集（20 题，`scripts/ab-context-tasks.json`）

四类各 5 题，全部**可机检**；8 题标记 `longContext: true`（这批同时用于将来 L-A 的风险测）：

| 类别 | 题号 | 判据类型 |
|---|---|---|
| code-edit | E1–E5 | `file-matches`（改完文件里必须出现指定片段） |
| doc-lookup | D1–D5 | `json-field` / `json-fields`（把答案写进 `ab-answer.json`） |
| test-fix | T1–T5 | `file-matches` / `json-field`（跑测试并把退出码写进答案） |
| script-write | S1–S5 | `json-field` / `json-field-at-least`（写脚本并运行） |

长上下文题（8 题）：E2/E3/E4/E5（要读 1 900–2 400 行的大文件才能定位）、
T3（要跑 `tsc --noEmit`）、S1（统计 `server.ts` 的 `listen(`）、S2（两个文件行数之和）、
S5（`ChatSurface.tsx` 的 `useEffect(` 计数）。

**自检机制**：每题都有 `expectInitial`，执行器 `--selfcheck` 会在**临时工作树**里
（`git worktree add` + 软链 node_modules，不调模型）跑一遍判据，验证
"现在确实是红的" —— 20/20 一致，说明判据真的能区分"做了"和"没做"。

> 为什么这一步不能省：判据写错（比如目标字符串已经存在于代码里）会让 A/B 结果完全失真。
> 本轮就抓到一个：`E5` 原本要求加 `log("shutdown requested")`，但这段文案在
> `server.ts` 里**已经存在**，自检立刻报 `现状=pass 期望=fail`，改成 `ab-shutdown-trace` 才通过。

## 4. 指标采集（四项，全部脚本化）

| 指标 | 采集方式 | 判定 |
|---|---|---|
| **cacheRead 中位** | 解析该题会话 JSONL 的 `message.usage.cacheRead`（与 `npm run audit:token` 同一解析） | 主指标：L-D 期望 −15~30% |
| **成功率** | 每个 check 的布尔结果（`--selfcheck` 同一个求值函数） | 下降 ≤2pp |
| **总成本** | 汇总 `usage.cost.total` | −10% |
| **耗时** | 从发 prompt 到 `agent.state.isStreaming=false` 的墙钟 | 劣化 ≤10% |
| 辅助：**调用次数/题** | 会话 JSONL 的 assistant 消息条数 | 防止"省 token 但多跑几轮" |

结果落盘：`tmp/ab-runs/<group>__<taskId>.json`，用
`node scripts/ab-context-eval.mjs --report tmp/ab-runs` 汇总成
"组 × 成功率 / cacheRead 中位 / 成本 / 耗时"表。

## 5. 执行流程（真跑时照这个顺序，本轮不执行）

1. `node scripts/ab-context-eval.mjs --validate`（判分集自检，必须通过）
2. `--selfcheck`（判据基线校验，必须 20/20 一致）
3. 实现两个开关（§2），`npx tsc --noEmit` + `npm run lint` + `npm test` 全绿
4. 逐组跑：`--run --spend --group L-D`（每组 20 题，各题在**独立 git worktree** 里跑，
   避免互相污染；跑完删 worktree）
5. `--report` 出表 → 对照 §6 判据给结论
6. 若 L-D 负收益：把 `PIFORGE_TOOL_OUTPUT_CHARS` 保留为实验开关但不改默认值

## 6. 成功判据（与 `context-governance-plan.md` §4 一致）

一次干预"有效"必须**同时**满足：

1. cacheRead 中位从 146 176 降到 **≤100 000**（−30%）—— L-D 单靠 4k→2k 大概率做不到，
   这条主要是给 L-A 用的；L-D 的合格线放宽到 **−15%**（≤124 000）；
2. 成功率下降 **≤2pp** —— 20 题粒度是 5pp/题，所以操作上要求"**与对照组错的题数相同**"
   （对照组错 1 题则实验组最多错 1 题）；
3. 总成本 **−10%**；
4. 耗时劣化 **≤10%**；
5. 调用次数/题 **不增加 >10%**（防止"少读多跑"）。

## 7. 样本量与统计说明（诚实版）

- 20 题 × 4 组 = 80 次任务；每题只跑 **1 次**。
- 这个样本量**不足以下统计显著结论**（20 题的 pass/fail 只能分辨 ≥2pp 的差异，
  且单次运行受模型随机性影响大）。所以本轮判据刻意设成"**成本/耗时看幅度，成功率看是否掉题**"：
  - 若 L-D 成本降幅 >15% 且成功题数不掉 → 进下一轮（每组再补 20 题重复），
  - 若掉 1 题 → 直接判定 "风险 > 收益"，不做重复实验。
- 正式结论必须至少两轮（共 160 次任务），第二轮只跑上一轮的边缘组。

## 8. 明确不做

- 本轮**不跑**任何真实 A/B（不加 `--spend` 就跑不动）。
- 不改 `agent-host/prompt-prefix.ts`、工具域、`npm run smoke:prefix-budget` 基线（6 640 tok / 99.6%）。
- 不做自动预热（P2-3b）、不做输出长度压缩（PiForge 已优于对标：668 vs 1 140 tok/调用）。
- 不在本轮实现 `PIFORGE_TOOL_OUTPUT_CHARS` / `PIFORGE_SESSION_SPLIT_HINT`（等立项）。
