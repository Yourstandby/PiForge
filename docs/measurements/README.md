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
npm run smoke:prefix-budget                             # 回归护栏：前缀 ≤7200 tok + 分派探针
```

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

## 用它来验收后续步骤

1. 前缀稳定化：多跑几个「带工具调用」的回合，`prefixHash` 不该变；
   一变就要看到 `!! 前缀在两轮之间变化` 与作废 token 数。
2. 内容去重：`turn N body` 的增长速度应慢于历史条数增长速度。
3. 回归护栏：`npm run smoke:prefix-budget` 在 CI/发布前跑；阈值 **6 500 tok**
   （当前 6 339 + 2.5% 余量），并且会跑 memory / orchestrator 两个「搜索 → 激活 → 分派」探针。
