# Token 成本度量（基线 + 回归护栏）

`scripts/measure-prefix.mjs` 用**本地记录型 provider** 让真实的会话创建路径发一次请求，
再把请求体拆成 `system prompt / tools / 历史` 三段算账。不花钱、不联网、结果可比。

```bash
npm run build:agent-host                 # 度量需要 agent-host/dist
npm run measure:prefix                   # PiForge vs pi CLI（--mode both）
npm run measure:prefix -- --mode host    # 只看 PiForge
npm run measure:prefix -- --json > tmp/prefix.json
npm run measure:prefix -- --dump tmp/prefix-dump        # 导出两侧 system/tools 原文，便于 diff
npm run measure:prefix -- --baseline docs/measurements/prefix-baseline-v0.8.3.json
npm run measure:prefix -- --api anthropic-messages      # 验 cache_control 断点布局
npm run measure:prefix -- --no-addons                   # 关掉两个可关的提示词附加项
npm run measure:prefix -- --turns 4 --language message  # 回复语言放在用户消息侧（位置实验）
npm run measure:prefix -- --cache-stats --cache-warming idle --cache-ttl-ms 15000 --pause-ms 20000
npm run measure:prefix -- --resume --cache-stats        # 恢复会话的首轮预热
npm run measure:prefix -- --probe orchestrator:status   # 真调一次多态工具，验证分派链路
npm run measure:prefix -- --codemode off              # 关掉 codemode（工具照常声明）再量
npm run smoke:prefix-budget                             # 护栏：默认配置前缀 ≤7600 + 命中率 ≥90% + 按需域探针（需 --codemode off）
npm run measure:long-session                            # 30 轮真实模型会话（需要 auth.json）
npm run measure:increment                               # 工具结果去重 A/B（记录型 provider）
```

## 三个口径（不要混读）

| 口径 | 怎么测 | 这个数字能回答什么 | 不能回答什么 |
| --- | --- | --- | --- |
| **记录型 provider 稳定段** | `measure:prefix` / `smoke:prefix-budget`（假 provider，固定假回复） | 我们自己发出的请求体是否稳定：前缀大小、命中率、每轮新增 token 中位数（实测 **29 tok**）、transcript 字段、棘轮 | 真实模型/真实缓存的价格与 TTL 行为 |
| **真实 deepseek 30 轮会话** | `measure:long-session`（真凭据、真缓存） | 真实环境下的命中率（96–98%）、每轮未缓存 input 中位数（实测 **395–446 tok**）、停顿/激活的尖峰 | 与 pi CLI 的逐轮对比（CLI 无 headless 多轮接口）；跨会话缓存会污染「总量」类对比 |
| **重复场景 A/B** | `measure:increment`（假 provider，脚本化重复调用） | 去重省了多少：最后一条请求体 **−17.2%**、工具结果字符 −52%、错误是否完整 | 日常会话的平均收益（取决于重复读的频率） |

> 典型误读：把「29 tok/轮」当成真实会话的每轮成本（那是假 provider 的新增 token），
> 或把「−17.2%」当成 30 轮会话的整体降幅（那是重复内容极端的脚本场景）。

## 基线并列（每步改了什么 / 哪个指标动了）

| 版本 | 主要改动 | 静态前缀 | 声明工具 | 真实会话命中率 | 真实会话中位数 |
| --- | --- | ---: | ---: | ---: | ---: |
| v0.8.2 | 起点 | 8 146 | 23 | 98.3% | 437 tok |
| 第 2–4 步 | 多态工具合并、按需域机制、缓存保活/预热、前缀棘轮 | 6 339（按需）/ 6 988（常驻） | 10 / 12 | 94.9% | 414 tok |
| 第 5 步 | 实测后回退按需域 → 常驻声明 | **6 988** | **12** | 94.9% | 414 tok |
| 第 6 步 | 工具结果去重 + transcript 字段护栏 | **6 991** | 12 | 96.3% | 446 tok |
| 第 7 步 | CI 固化 + 口径澄清（无行为变更） | 6 991 | 12 | —（未改代码） | — |
| 第 8 步 | shell 默认按需 + tool_search 命名对齐 | **6 240** | **11** | 97.98% | 425 tok |

三件不变的事实：**核心四件套 710 tok**（三个版本一致）、`prefixAudit.unexpectedChanges=0`、
记录型 provider 的稳定段命中率 99.6%。

口径：`cjk=1 token/char`，其他 `4 chars/token`（与 `lib/live-usage.ts` 完全一致）。
只用于同一口径下的**相对比较**，不冒充厂商分词器。

## v0.8.3（多态工具合并后）vs v0.8.2

| 指标 | pi CLI | v0.8.2 | v0.8.3 | v0.8.2→v0.8.3 |
| --- | ---: | ---: | ---: | ---: |
| system prompt ≈tok | 3 117 | 4 401 | 3 772 | −14.3% |
| tools ≈tok | 710 | 3 745 | 2 567 | −31.4% |
| 　其中扩展工具 | 0 | 3 035 | 1 857 | −38.8% |
| **静态前缀 ≈tok** | **3 827** | **8 146** | **6 339** | **−22.2%** |
| 首轮请求体 ≈tok | 3 969 | 8 306 | 6 489 | −21.9% |
| 声明工具数 | 4 | 23 | 10 | −57% |

连续两轮 `prefixHash` 一致（默认流程不打掉缓存）；`--api anthropic-messages` 下
断点布局为 `system=✓ tools=✓ messages=1`，合并后仍然落在 tools 末尾 + system 末尾。

### 每个工具的变化

| 域 | 原工具（≈tok） | 合并后 | Δ |
| --- | --- | ---: | ---: |
| browser | `browser_interact` 127 + `browser_read` 158 + `web_preview` 242 = 527 | 223 | −58% |
| shell | `run_bg` 265 + `process_read` 170 + `process_wait` 191 + `powershell` 139 = 765 | 564 | −26% |
| fleet | `spawn_agent` 289 + `herdr_spawn` 282 + `herdr_status` 70 + `herdr_message` 149 = 790 | 659 | −17% |
| orchestrator | `orchestrator_spawn` 234 + `orchestrator_status` 75 = 309 | 342 | +11% |
| memory | `memory_save` 100 + `memory_recall` 85 + `memory_forget` 60 = 245 | 275 | +12% |

`orchestrator` / `memory` 变大是合并的固定成本：两个动作的信息量本来就少，
多态工具还要付一份域级前言和 action 目录。它们换回来的是**声明工具数 −11**、
`<tools>` 一行简介从 19 条降到 7 条（269 → 120 tok）。

### 第 3 步：memory / orchestrator 改为按需域

两个域从默认声明集合移出，注册成 `deferred`：模型先 `tool_search`，激活后**下一轮**才进入声明。
代价是首次使用多 1 次往返 + 一次前缀重写（当时整段历史 ~6.5k tok 作废），收益是每轮少 617 tok。

| | 常驻声明 | 首次使用 | 每轮成本 |
| --- | --- | --- | ---: |
| browser / shell / fleet | 是 | 直接可调 | 1 458 tok |
| memory / orchestrator | 否（`tool_search` 激活） | +1 次往返 + 1 次前缀重写 | 0 tok（未用时） |

`tool_search` 只回显 description 的**第一行**，所以多态工具的第一行固定写成
`Memory: recall | save | forget.` —— 模型搜到就知道能干什么；下一轮完整 schema（含
`(requires …; opt …)` 与每个参数的约束）一起进来，不会出现「搜到了但参数不对」的二次往返。
`smoke:prefix-budget` 里的两个探针实测：`tool_search("memory")` → 声明集合出现 `memory`
→ `memory{action:"recall"}` 返回 `No matching memories.`；orchestrator 同理。

### 第 3 步：回复语言 addendum 的位置实验

两种注入方式各跑 4 轮（`--language message` 打开 message 侧）：

| 方式 | system ≈tok | 前缀 ≈tok | 每轮 body（4 轮） | prefixHash |
| --- | ---: | ---: | --- | --- |
| (a) 前缀（现网默认） | 3 772 | 6 339 | 6 489 / 6 517 / 6 546 / 6 574 | 两轮一致 ✓ |
| (b) 用户消息侧 | 3 660 | 6 227 | 6 495 / 6 644 / 6 792 / 6 941 | 两轮一致 ✓ |

结论：**(b) 前缀短 112 tok，但每条用户消息多背 104 tok，4 轮累计反而多 746 tok（+2.9%）**，
而且每轮多产生一条消息（结构上多一个变动点）。→ 回退到 (a)，默认仍在前缀；
(b) 保留为 `PIFORGE_LANGUAGE_IN_MESSAGE=1` 的度量开关，不进 UI。
`outputStyleGuidelines` / `responseLanguageGuideline` 两个设置项保持默认开。

### 为什么没到 5 950

5 950 的推算假设「合并能把 schema 砍一半」。实测不成立：schema 的大头是
**动作语义与参数说明**，而这一步的硬约束是「语义一条不少、不得压成一句话」。
真正省下来的只有重复的骨架与公共字段，所以落点是 6 970（−14.4%）。要继续往下只有三条路：

| 方案 | 实测/推算前缀 | 代价 |
| --- | ---: | --- |
| 已做：`memory` + `orchestrator` 改按需 | 6 339 | 首次使用 +1 次往返 + 一次前缀重写 |
| 关掉两个提示词附加项（设置项，`--no-addons` 实测） | 6 033 | 输出风格/回复语言约束消失（用户可感知） |
| 把 per-action 说明压到 1 句 | ≈5 950 | 语义降级，与「不降模型质量」冲突 → **不做** |

前两条是纯配置/声明策略，第三条会动质量，需要单独拍板。

## 验证过的链路

- **分派**：`--probe fleet:status` → `fleet{action:"status"}` → `ctx.executeTool("herdr_status")`
  → 结果 `The fleet is empty.` 回到模型；`--probe orchestrator:status` 同样通过。
  `smoke:prefix-budget` 跑的就是这个探针。
- **缓存断点**（`--api anthropic-messages`）：`system=✓ tools=✓ messages=1`。
- **设置项开关**（`--no-addons`）：system 3 798 → 3 491 tok，前缀 6 970 → 6 786 tok。
- **UI/审批兼容**：`lib/normalize.ts` 把 `shell{action:"run"}` 还原成 `run_bg{...}`，
  前端渲染、图标、i18n、Ask 确认、运行指示器全部沿用旧工具名（1146 个测试未改一行 UI 断言）。

## 第 4 步：缓存保活 + 首轮预热

recorder 现在按「最长公共前缀 + TTL」模拟 Anthropic prompt cache（`--cache-ttl-ms`），
所以每轮真实请求的 `cacheRead / cacheCreation / input` 都能看见。相关开关：

```bash
# 停顿超过 TTL（默认 5 分钟；这里缩到 15s 便于观察）
node scripts/measure-prefix.mjs --mode host --api anthropic-messages --turns 3   --cache-ttl-ms 15000 --pause-ms 20000 --cache-stats
# 同一停顿，但开着 idle 保活（--cache-econ-force 抬高假模型价格，让 pi 的经济性判断通过）
node scripts/measure-prefix.mjs --mode host --api anthropic-messages --turns 3   --cache-ttl-ms 15000 --pause-ms 20000 --cache-warming idle --cache-econ-force --cache-stats
# 恢复会话时的首轮预热
node scripts/measure-prefix.mjs --mode host --api anthropic-messages --turns 2 --resume --cache-stats
```

### 停顿超过 TTL（前缀 6 431 tok，TTL 15s，停顿 20s）

| 场景 | 停顿后的下一轮 | 结果 |
| --- | --- | --- |
| `cacheWarming=off` | `cacheRead 0 / cacheCreate 6 466` | 缓存过期，整段前缀按写入重算 |
| `cacheWarming=idle` | 停顿期间 4 次 warm（每次 `read 6 431 / create 0`），之后 `read 6 431 / create 35` | 缓存被保活，只付新增消息 |

> 注意：pi 的 warmer 要求 ①模型声明 `cost` + `promptCache`，②预计省下的钱 ≥ $0.05。
> 6.3k token 的前缀在真实定价下约值 $0.004，**达不到门槛**，所以真实会话里通常是
> `state=inactive reason=expected savings below threshold`。这不是没接通，是 pi 的
> 决策；前缀涨到 ~25k 以上才会真的开始保活。设置页现在显示的就是这个真实状态
> （`mode` + `state` + `reason`），不再把 `undefined` 显示成 `off`。

### 首轮预热（恢复会话）

| 请求 | kind | maxTokens | input | cacheRead | cacheCreate |
| --- | --- | --- | ---: | ---: | ---: |
| 1 | title | 48 | 0 | 0 | 96 |
| 2 | turn（第一次对话） | 16384 | 0 | 0 | 6 431 |
| 3 | **warm（恢复时预热）** | **1** | 0 | 6 431 | 16 |
| 4 | turn（恢复后第一条消息） | 16384 | 0 | 6 446 | 20 |

预热请求必须与真实请求**同前缀**才划算：第一版在 `applyAgentMode` 之前预热，
`state.tools` 还缺 `tool_search` / `tool_history_get`，写进缓存的是另一条前缀（白付一次
写入）；改成「装载落定后再预热 + 过滤 transcript 里的 system 消息」之后，预热只花 16 tok。

### 激活前后（按需域）

`--probe-search memory` 现在的输出：

```
✓ tool_search("memory") 激活后该域进入声明集合
✓ 前缀棘轮: turns=3 stable=2 expectedChanges=1 unexpectedChanges=0
✓ 激活后连续两轮 prefixHash 一致: 367f613f167e / 367f613f167e
```

`expectedChanges=1` 就是「memory 第一次进入声明集合」那一次；之后 `stays latched`。
`get_state.prefixAudit` 里能直接读到 `turns/stableTurns/expectedChanges/unexpectedChanges`
与最后一次变化的差异段（`lastChange`）。`smoke:prefix-budget` 会把
`unexpectedChanges > 0` 当失败（退出码 4/5）。

## 第 5 步：超长会话实测后的两处调整

30 轮真实会话（deepseek-flash，含工具调用/停顿/激活）的完整报告见
[`long-session.md`](./long-session.md)。结论直接改了默认配置：

1. **memory / orchestrator 恢复常驻声明**（`ON_DEMAND_DOMAINS` 默认关闭，
   `PIFORGE_ON_DEMAND_DOMAINS=1` 才开）。实测按需版本 30 轮未缓存 input 49 378 tok，
   常驻版本 37 731，v0.8.2 23 903 —— 激活的一次性开销盖过了 617 tok/轮的节省。
   前缀因此回到 **6 988 tok / 12 个工具**（仍比 v0.8.2 的 8 146 / 23 个低 14%）。
2. **缓存保活**在 deepseek 上全程 `inactive`（模型无 `promptCache` 元数据，
   且 6 988 tok 的省钱期望 < $0.05 门槛）。保活机制本身改用记录型 provider 验证
   （合成模型 + TTL 15s + 强制经济性）：停顿期间 4 次 warm 全命中。

`smoke:prefix-budget` 现在跑两种配置：默认（前缀 ≤7 200、稳定段命中率 ≥90%、
无非预期前缀变化）与 `PIFORGE_ON_DEMAND_DOMAINS=1`（tool_search 激活 + 激活后
连续两轮 prefixHash 一致）。

## 第 6 步：每轮增量去重 + resume 字段裁剪

详见 [`increment-dedup.md`](./increment-dedup.md)。

- `read` 同路径同区间、`bash` 同命令的重复结果不再整段回放（相同输出一句话、输出变长时
  只回尾部差异）；**错误永远完整返回**；文件被改过/区间不同照常回全文。
  A/B：最后一条请求体 11 234 → 9 320 tok（−17%），工具结果字符 −52%。
- resume 请求体实测**只带** `role/content/tool_calls/tool_call_id` —— SDK 已在 provider
  边界裁掉 `details/usage/customType`，这一步无字段可削；新增
  `--assert-lean-transcript` 护栏防止将来泄漏。
- 新增 `npm run measure:increment`（去重 A/B，记录型 provider）。

## 第 7 步：CI 固化 + 一个被否掉的实验

### CI

`.github/workflows/ci.yml` 新增 `token-guards` job（ubuntu，无需凭据）：

| 步骤 | 护栏 / 退出码 |
| --- | --- |
| `smoke:prefix-budget` | 前缀 ≤7 200（退出码 2）、命中率 <90（6）、中位数 >200（8）、字段泄漏（7）、棘轮异常（4/5） |
| `measure:increment` | 去重命中为 0 或错误被去重 → 退出码 2 |
| `measure:long-session` | 仅当仓库配置 `DEEPSEEK_API_KEY` 时运行；命中率 <90（3）、中位数 >1 500（4）、无模型输出（2） |

真实会话缺凭据时只打一条 `::notice`，不会把 CI 变红；其余护栏不需要任何 secret。

> **前缀阈值口径**：`--max-prefix 7 200` 以**清空 `HOME` 后的干净基线 6 240**（默认 `shell` 按需、11 工具）为准。
> 本机装了 `~/.agents/skills` 时，该目录会以 `<skills>` 段进 system prompt（+1 598 字符 ≈ +400 tok，前缀 **6 640**），
> 属于**预期环境差异，不是回归**；逼近 7 200 时先用 `HOME=<空目录>` 重跑一次，确认是环境差异还是真实回归。

### 可选实验：高上下文时「写 memory + 释放原文」（未合并）

在实验分支（未提交）里加了 2 条 guideline，令模型在上下文占比高时先写 memory、
少复述、用 toolCall 引用代替重读。30 轮真实会话（deepseek-flash）对比：

| 指标 | 现状（第 6 步） | 实验分支 | 结论 |
| --- | ---: | ---: | --- |
| 静态前缀 | 6 988–6 991 | **7 042（+51）** | 违反「前缀不变」的硬约束 |
| 稳定段命中率 | 96.3% | 97.2% | 噪声范围内，无收益 |
| 每轮未缓存 input 中位数 | 446 | 395 | 与历史抖动（414/437/446）重叠，不算改善 |

关键问题：**没有释放机制**。「释放原文」要么压缩历史（本项目明确不做自动压缩），
要么靠 provider 的上下文窗口裁剪（不可控）。纯提示词只能改变模型行为，删不掉已存在的
token，所以**不合并**，也不留任何默认开关。

## 第 8 步：按需工具激活（中频域 A/B）

详见 [`on-demand-tools.md`](./on-demand-tools.md)。

- **命名对齐**：`tool_search` 以前会把内部注册名（`run_bg`/`browser_read`…）返回给模型，
  wire name 对不上 → `unsupported call`。现在只返回可调用的 wire name、撤掉内部名的激活、
  **按 canonical 顺序重排 active**（否则激活那轮是追加序、下一轮变字典序 = 两次前缀写入），
  并在结果里写明「新工具下一轮再调，不要同轮连调」。
- **A/B**：只把中频域 `shell` 改成按需。前缀 6 988 → 6 240（每轮省 748），激活 4 600，
  回本 6.2 轮，30 轮净收益 ≈ +13 200 tok，命中率不变（97.98% vs 97.98%）→ **默认开启**。
- `memory` / `orchestrator` 仍是负收益，保持常驻；`PIFORGE_ON_DEMAND_DOMAINS=0` 可一键回到全常驻，
  `=1` 是「两个低频域按需」的历史配置，也接受 `browser,shell` 这种显式列表。

## 用它来验收后续步骤

1. 前缀稳定化：多跑几个「带工具调用」的回合，`prefixHash` 不该变；
   一变就要看到 `!! 前缀在两轮之间变化` 与作废 token 数。
2. 内容去重：`turn N body` 的增长速度应慢于历史条数增长速度。
3. 回归护栏：`npm run smoke:prefix-budget` 在 CI/发布前跑；阈值 **7 200 tok**
   （干净基线 6 240 / A 组全常驻 6 988；带 `~/.agents/skills` 时 6 640 属预期环境差异），
   并跑「稳定段命中率 ≥ 90%」与按需域的激活探针（两种配置）。
