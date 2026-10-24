<div align="center">

<img src="./public/logo.svg" width="92" alt="PiForge" />

# PiForge

**把 Pi Coding Agent 装进一张安静的三栏工作台**<br />
*A local-first desktop workbench for the Pi coding agent — multi-session, multi-agent, cache-aware.*

Windows-first · Local-first · Electron + Next.js + Agent Host · 零内部端口 · MIT

[架构](./docs/ARCHITECTURE.md) · [性能实测](./docs/optimizations/v0.9.x-performance-final.md) · [Token 实测](./docs/optimizations/token-line-closure.md) · [发布记录](./docs/releases)

</div>

---

[![PiForge 主界面](./docs/assets/generated/poster-light@2x.png)](./docs/assets/generated/demo.mp4)

PiForge 不是又一个「聊天框套壳」。它把 Agent 真正需要的东西放在同一屏：左边是项目与会话，中间是浏览器式多标签对话，右边常驻文件树、内置浏览器、终端、Git、Agents、编排与插件面板。你可以一边让主 Agent 改代码，一边派两个子 Agent 去调研，再让一个常驻舰队 Agent 盯着安全审计——全部互不干扰，全部在本机。

底层复用官方 [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi-coding-agent)（当前锁定 `1.1.0`）。**我们不 fork SDK，也不在中间加代理层**：整个 Pi 只经过一个文件——`agent-host/sdk-adapter.ts`。上游升级只改这一层，并用 `npm run check:sdk-imports` 强制这条边界。

## 📊 先说清楚现在的数字

全部本机实测，每条都有可复现的命令（见 [性能实测](#perf-numbers)）。**不达标和做不到的地方也写在表里。**

| 维度 | 实测 | 门槛 / 说明 |
| --- | --- | --- |
| Agent Host 单进程内存 | **197–217 MB** | 门禁 240 MB（`measure:packaged` 默认按传输层取门禁） |
| 30 轮 soak（起停 + 真实会话） | 中位 **216.9 MB** / 峰值 **252.9 MB** / **0 OOM** | `soak:host-heap`，CPU 中位 0.35% |
| 空闲 CPU | **0.31–0.46%** | 门槛 3% |
| 总内存（5 进程） | **822–947 MB** | 加载 26 MB 大会话时 ~920 MB |
| renderer | **126–132 MB** | — |
| GPU 进程 | **154–155 MB** | 目标 150 未达成，已归因（见下） |
| 冷启动 | 窗口 **68–130 ms** / Host ready **1.3–2.4 s** | — |
| 内部端口 | **0 个**（无 `localhost` TCP、无 30141） | 生产环境渲染进程走 `piforge://app` 静态协议 |
| 安装体积 | NSIS **163.2 MB** / 安装后 **581 MB** | — |
| 前缀基线 | **6 640 tok / 命中 99.6%** | `smoke:prefix-budget`（清空个人技能目录时 6 240） |
| 测试 | **1 321 项，0 失败** | `npm test` + `tsc` + `lint` |

**做不到的也记着**：`gpu ≤150 MB` 在本机不成立（`gpu_compositing` 是 `disabled_software`，硬件加速不可用；4 种开关组合都落在 155 MB，而 150 这个门槛比对标项目自己的 152 MB 还低）。加载 26 MB 大会话时 Host 到 ~286 MB，那是**数据本身**的代价，不是浪费。

## ✨ 能力地图

| | 能力 | 一句话 |
| --- | --- | --- |
| 🩺 | **无进展看门狗** | 程序层盯「有效进展」，卡住就亮灯，**零 Token**、零 prompt 注入 |
| 🖐 | **人工介入** | Skip / 极简询问 / 深度诊断，复用手边已有的队列通路 |
| 🧠 | **上下文可视化与压缩** | 上下文环 + 四段式摘要，切点永远落在用户轮次上 |
| 🤖 | **子 Agent / 常驻舰队** | 一次性 `spawn_agent` 与可反复下发的 `herdr_*`，全部独立上下文 |
| ⚡ | **启动与内存** | 静态导出替代 Next 运行时、Host 传输层可切、V8 堆按传输层分档 |
| 💰 | **Token 账本** | 成本结构可审计（`audit:token`），每条优化都经过实测而不是拍脑袋 |
| 🧱 | **三进程隔离** | Agent 只住在 Host，Next 只做代理与 UI，零内部端口 |

## 🚩 版本状态

- **v0.9.0 已发布**：看门狗 / 人工介入 / 用量条 / 窄窗口浮层。详见 [`docs/releases/v0.9.0.md`](./docs/releases/v0.9.0.md)。
- **v0.9.x（已在 `main`，未发版）**：静态导出取代 Next 运行时、Host 传输层默认切 `node`（`ELECTRON_RUN_AS_NODE` 子进程，堆 4/192）、Token 护栏与两条实验开关、以及两条优化线的**收口文档**。逐条见 [CHANGELOG](./CHANGELOG.md) 与下文各节。

> 分支保护：`main` 只接受 PR 合并，改动走 `dev/vX.Y.Z` 或功能分支。

---

## 🩺 看门狗与人工介入（零 Token 监控）

普通桌面端对付「卡住」只有两条路：让模型自己反思（每问一次就是一次 LLM 请求），或者让用户盯着进度条猜。PiForge 把监控搬到程序层，把处置权交回用户。

**零成本是设计约束，不是优化结果**：

- `agent-host/watchdog.ts` 只有 `setInterval` + 内存状态机 + 环形通知队列（上限 50 条），**不 import 任何发送接口**；
- 通知不进 system prompt、不进对话历史、不写会话 JSONL；
- 观察者是「读事件 → 更新计数」，扫描在独立定时器里跑并 `.unref()`，不 sleep、不阻塞主流程。

所以「盯着 8 个并发工具跑 6 分钟」和「什么也不干」的账单完全一样。

**两把尺子**：`lastActivityAt` 只在**有效进展**（成功且不重复的动作、正文增量）时刷新；`lastLivenessAt` 记「活的迹象」（工具启动、流式输出）。看门狗只看前者 —— 反复跑同一条报错命令不会被误判成有进展。

**三道防线**：

| 层 | 在哪 | 兜住什么 |
| --- | --- | --- |
| ① 进程树硬超时 | `process-killer.ts` / `managed-processes.ts` | 优雅终止 → 2.5s 后 `SIGKILL` / `taskkill /T /F` |
| ② 看门狗干预 | `watchdog.ts` + `intervention.ts` | 20s 无有效进展 → 30/60/120s 退避提醒 → 标 `failed` |
| ③ 后台进程接管 | `crash-reaper.ts` | Host 启动时清点上次遗留的受管进程（只终止 agent 起的、先验身份、验不了就留着并上报） |

**介入三档**（全部复用 steer → 队首排队 → prompt，没有新的模型直连）：

| 动作 | 注入什么 | 代价 |
| --- | --- | --- |
| **Skip** | 「当前工具已因无进展被系统跳过，请换方案继续」 | 一次极短请求 |
| **极简询问**（默认） | 「禁止执行任何新工具核实，一句话说明卡在哪」 | 一句话 |
| **深度诊断** | 允许跑工具核实（可能上万 Token） | 昂贵，谨慎用 |

守卫写在 Host 侧（不信前端按钮）：同动作冷却 3s、单任务上限 5 次、没有活跃任务直接拒绝。代价很具体：模型被「你为什么卡了」一追问就会去跑 `tsc`/`grep` 自证，一次烧掉上万 Token 并把执行流堵死。

---

## 🧠 上下文：可视化 + 压缩

长会话的成本大头是**每轮重放历史**，但旧 UI 只显示 tokens/s 和本轮产出，用户看不出上下文已经贴到硬顶。

- `agent-host/context-budget.ts` 是纯函数：把用量换算成相对硬顶的比例与等级（观察区 60% / 临界 85% / 越顶）；硬顶常量**单一来源**在 `agent-host/compaction-plan.ts`。
- 输入框旁一个 14px 的环（`ContextRing`）：走满 = 贴到硬顶，变红 = 已越顶并脉冲；具体数字收进 tooltip 与 `aria-label`。
- 压缩规则：**保留最近 4 轮原文，切点永远落在用户消息上**（不劈轮次、不拆工具调用与结果）；硬顶 48k，或窗口外攒够 3 轮、或占用 ≥45% 就压；被压区间必须 ≥3k tokens（压了不省就别压）。摘要固定四段（用户意图 / 修改文件 / 关键报错 / 最终决策），文件清单由代码再兜一次。

> 这套阈值**不是**可以随便调的旋钮：触发点前移 30% 会让长上下文题掉 2 题（实测三轮一致，见 [Token 实测](#token-numbers)）。

## 🤖 子 Agent 与常驻舰队

| | 临时子 Agent | 常驻舰队 Agent |
| --- | --- | --- |
| 谁创建 | 主 Agent 调 `spawn_agent` | `herdr_spawn`，或面板「+ 新建 / 加载 Agent」 |
| 生命周期 | 一次任务，用完即销毁 | 常驻待命，可反复下发消息（空闲自动休眠） |
| 上下文 | 独立 in-memory 会话，**绝不写主 JSONL** | 同左，但保留上下文直到休眠 |
| 配置 | 由主 Agent 现场写 | 名称 / System Prompt / 工具权限 → `<agentDir>/fleet/agents.json` |

省钱阀门是**硬闸**，不是建议：单次 3 轮上限（第 4 轮直接拒绝）、单轮上下文 10k 熔断、回包摘要 ≤1200 字符。所以一次派发的成本上界是 30k tok —— 实测全库 60 个会话里只有 **3 次**派发（占工具调用 0.027%），子 Agent 成本上界只占 cacheRead 的 **0.004%**。

---

<a id="perf-numbers"></a>

## ⚡ 性能：本机实测数字

### 做了什么

| 改造 | 效果 |
| --- | --- |
| **静态导出取代 Next 运行时**：生产环境渲染进程加载 `piforge://app`，`/api/**`（70 条路由）经命名管道交给 Agent Host | 去掉一个常驻 Next server 进程（原 471.7 MB），零内部端口；`PIFORGE_USE_NEXT=1` 可回退 |
| **Host 传输层可切**：默认 `node`（`ELECTRON_RUN_AS_NODE` 子进程），`utilityProcess` 保留为回退 | 新生代 4 MB + 老生代 192 MB 都生效（utility 只能设老生代）；轻载中位 **268.4 → 209.1 MB** |
| **空闲 CPU 治理**：`allowed-roots` 单飞、git 快照 3s TTL + single-flight + 常驻 worker、面板定时器下线 | 6.4–10.9% → **0.31–0.46%**（改造首轮为 1.26 / 0.78 / 0.63） |
| **GPU 自适应**：只在观测到「软件合成」的机器上关 GPU，2 次连击 + 30 天过期 + 环境变量覆盖 | GPU 255.9 → **154–155 MB** |
| **渲染增量**：轮次身份缓存、滚动位置记忆、会话作用域登记 | 流式期间不再每帧全量重渲 |

### 怎么自己验证

```bash
npm run pack                                                   # 先产出有效产物
npm run measure:packaged                                       # host / 总内存 / CPU / 端口（host 门禁随传输层：node 240、utility 290）
npm run measure:packaged -- --max-host-rss-mb 220               # 想显式卡线就自己给
npm run soak:host-heap                                         # 30 轮 soak：0 OOM / RSS 中位 / CPU 中位
npm run probe:host-runtime                                     # 传输层对照：heap limit 与空闲 RSS
npm run smoke:shell                                            # 静态导出新鲜度 + 打包顺序
```

### 已知边界（不再投入）

| 项 | 为什么到此为止 |
| --- | --- |
| GPU 155 MB 达不到 150 | 本机硬件加速不可用（`disabled_software`）；4 种开关组合都在 155；`--in-process-gpu` 实测总内存更差，且崩溃半径变大 |
| 大会话 Host ~286 MB | 26 MB transcript 本身就要装载；剩余只有 native 部分可动，属运行时改造 |
| 路由懒加载 | 70 条路由全量 heap ≈ 6.2 MB，收益 <1% |
| `--max-rss-mb 220` 永远不过 | 那是**整个 App 总 RSS**（850–1130 MB）；host 单进程门禁是 `--max-host-rss-mb` |

> 完整归因、口径更正与门禁清单：[`docs/optimizations/v0.9.x-performance-final.md`](./docs/optimizations/v0.9.x-performance-final.md)。

---

<a id="token-numbers"></a>

## 💰 Token 实测：结论是"少动它"

Prompt 缓存按**字节级前缀**命中：system prompt 或 `tools` 数组抖一下，后面整段历史就按未命中重新计费。所以真正有效的省钱手段只有一个方向——**别让前缀变、别让上下文长到离谱**。这两件事 PiForge 已经做到位了：

| 手段 | 做法 |
| --- | --- |
| 工具定序 + 装载锁定 | 工具名强制 ASCII 字典序，同一状态原样复用上一份数组 |
| 多态工具 | 20 个扩展工具按域收成 5 个（`browser`/`shell`/`fleet`/`orchestrator`/`memory`），用 `action` 分派；旧工具仍以 `deferred` 注册可调 |
| 动态工具存根 | 扩展工具 >5 个时只发「名字 + 一句话」目录，`tool_search` 后注入完整 schema |
| 工具输出预算 | 命令/日志 4 000 字符（≈1 000 tok），`read` 同额度但保留头部连续性；原文落盘，`tool_history_get` 可翻页 |
| 稳定提示词 | 输出风格等策略文本集中在 `agent-host/prompts/`，只放静态常量，禁止动态插值 |

**然后我们把"还能不能更省"挨个量了一遍**（60 会话 / 10 227 次调用 / $22.36 的真实账本）：
先排掉两个只占 1% / 5% 的环境因素，再把三条候选逐一实测 —— **没有一个该做**：

| 假设 | 实测 | 结论 |
| --- | --- | --- |
| 空闲恢复重发很贵 | 44 次 / 750k tok / **$0.22（1%）** | 只保留可见性提示 |
| 跨 app 前缀失效很贵 | 35 次 / 3.65M tok / **$1.12（5%）** | 只保留提示，前缀机制未改 |
| 子 Agent 继承父上下文 | 隔离机制本来就有；成本上界 **0.004%** | 不立项 |
| 工具输出 4 000 → 2 000（L-D） | 80 次 A/B：cacheRead **−0.4%**、成本 **+1.4%**、耗时 **+17.8%** | **证伪** |
| 压缩触发点前移 30%（L-A） | 24 次预演 × 3 轮：长上下文题 **6/8 → 4/8**，cacheRead 只 **−0.6%** | **证伪** |

**成本结构**（`audit:token`）：cacheRead **56%（$12.51）** · output 31%（$6.83）· input 14%（$3.02）。
也就是说：**钱花在"每次调用都要重读的上下文"上，而那正是模型答对所需的上下文**。
两种"少读"的做法都试过：把输出预算再压一半**没东西可省**（超过 4 000 字符的只剩 3.4%），
而真能省下来的压缩档位（首轮上下文 −38%）**必须拆开"整轮保留"这条铁律**，那是架构改造而非调参。

### 实验开关（默认关闭，默认行为不变）

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| `PIFORGE_TOOL_OUTPUT_CHARS` | `4000` | 工具输出字符预算（实验臂用 2000；允许 500–200000，非法值保留默认） |
| `PIFORGE_SESSION_SPLIT_HINT` | 关 | 上下文 ≥200k 时给「开新会话」**动作按钮**（信息提示本来就有） |
| `PIFORGE_ON_DEMAND_DOMAINS` | `shell` | 按需工具域（`0` = 全部常驻，前缀 6 988） |

> 完整账本：[`token-consumption-audit.md`](./docs/optimizations/token-consumption-audit.md) ·
> 收口结论与重启条件：[`token-line-closure.md`](./docs/optimizations/token-line-closure.md) ·
> A/B 方法学：[`context-governance-ab.md`](./docs/optimizations/context-governance-ab.md) ·
> 预演工具坑位：[`preview-harness-pitfalls.md`](./docs/optimizations/preview-harness-pitfalls.md)。

---

## 🧱 架构：三进程、一条管道、零内部端口

```text
Electron Main ──协议处理──▶ piforge://app（静态导出，无 Next 运行时）
      │                          │
      │                          └──/api/** 走命名管道──▶ Agent Host（70 条路由 + Pi SDK + 工具 + 受管进程）
      │                                                        │
      ├──spawn（默认 node / 可切 utilityProcess）──▶ Agent Host ──┼──WebSocket（自动端口，仅插件/流式总线）
      │                                                        └──独立 OS Worker ──▶ 每个 Worker 独占 Git worktree
      └──bounds 上报──▶ Main 持有的 WebContentsView（内置浏览器）
```

三条不能破的边界（CI 与代码评审都会查）：

1. **Agent 只住在 Host**：SDK / AgentSession / 工具执行 / 受管进程 / LTM 全在 `agent-host/`，Next 不持有任何会话状态。
2. **只走命名管道**：Host ↔ Next 不做 localhost TCP；Next 重启不会杀掉正在流式输出的 Agent，重连按 `seq` 续传。
3. **文件先授权再 IO**：`/api/files`、git、statusline、processes 都必须先 `files.authorize`，白名单只在 Host。

### 环境变量隔离（Host 启动方式）

| 传输层 | 启动方式 | V8 堆 | 默认 |
| --- | --- | --- | --- |
| `node` | `process.execPath` + `ELECTRON_RUN_AS_NODE=1` | `NODE_OPTIONS`：新生代 4 + 老生代 192（limit 280 MB） | ✅ |
| `utility` | `utilityProcess.fork()` | `execArgv: --js-flags=--max-old-space-size=256`（只能一个 flag） | `PIFORGE_HOST_TRANSPORT=utility` 回退 |

三条硬规则：

1. **`ELECTRON_RUN_AS_NODE` 只进 Host 子进程的 env**，绝不写进 `process.env` —— 否则之后拉起的每个子进程都会变成 node 模式（症状是"双击没反应、没有窗口"）。
2. **受管进程必须清理环境**（`agent-host/child-env.ts`）：剔除 `ELECTRON_RUN_AS_NODE`，其余全量继承（早期白名单曾过滤掉 `SystemRoot`，导致 Host 里 `listen()` 直接失败）。
3. **stdin 控制通道要显式开启**（`PIFORGE_HOST_STDIN_CONTROL=1`）：不能靠"stdin 不是 TTY"去猜 —— 探针/冒烟用 `stdio: ["ignore"]` 启动时 stdin 会立刻 end，Host 会把它当"父进程已死"而秒退。

回退顺序：`PIFORGE_HOST_HEAP=default` → `PIFORGE_HOST_TRANSPORT=utility`（各一个变量，不需要改代码）。

---

## 🚀 快速开始

需要 **Node.js 20+ / npm 10+**（Windows 10/11 为主要目标平台）。

```bash
git clone https://github.com/yourstandby/PiForge.git
cd PiForge
npm install

npm run dev:electron   # 桌面窗口（推荐）
npm run dev            # 浏览器开发模式 → http://localhost:30141（仅开发期有端口）
```

<details>
<summary><b>常用命令</b></summary>

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 编译 Agent Host + 启动 Next dev（**仅开发期**用 30141 端口） |
| `npm run dev:electron` | 编译 Host / Electron 主进程并打开桌面窗口 |
| `npm run pack` | 产出 `release/win-unpacked`（无签名/受限环境用，含打包冒烟） |
| `npm run dist` | 打包 NSIS 安装包 + ZIP + `latest.yml` |
| `npx tsc --noEmit` / `npm run lint` | 类型检查 / ESLint |
| `npm test` | 单元与路由测试（**1 321 项**，0 失败） |
| `npm run smoke:agent-host` | Host RPC / 受管进程 / 会话 / 看门狗 / 介入拒绝路径 |
| `npm run smoke:agent-isolation` | 客户端断连后 Host 继续流式输出、重连续传 |
| `npm run smoke:host-reconnect` | Next 断线重连与事件重放 |
| `npm run smoke:extension-ui` | Extension UI Bridge `confirm` 往返 |
| `npm run smoke:shell` | 静态导出新鲜度 + 打包顺序 |
| `npm run smoke:prefix-budget` | 前缀预算护栏（6 640 tok / 命中 99.6%） |
| `npm run measure:packaged` | 打包版内存/CPU/端口实测（含门禁） |
| `npm run soak:host-heap` | 30 轮 soak（0 OOM / RSS / CPU） |
| `npm run probe:host-runtime` | 传输层对照（heap limit / 空闲 RSS） |
| `npm run audit:token` | Token 账本（成本拆解 / 空闲恢复 / 前缀失效） |
| `npm run audit:subagent` | 子 Agent 占比（派发频率与成本上界） |
| `npm run ab:context` | 上下文治理 A/B 执行器（`--validate` / `--selfcheck` / `--plan` / `--run --spend`） |
| `npm run check:sdk-imports` | 强制只有 `sdk-adapter.ts` 直接 import Pi SDK |

</details>

## 🧭 界面速览

- **左栏 · 会话**：搜索、项目分组、按日期分组的历史（滚动分页）、行内「克隆 / 复刻」（目录克隆或独立 worktree）。
- **中栏 · 对话**：多标签并行、流式渲染、增量挂载历史（首屏 20 轮）、内联代码 Diff、消息级分支 `‹ 1/2 ›`；输入框下方常驻用量条（Token / 缓存命中 / 上下文 / 上游额度）。
- **右栏 · 面板**：文件树（悬浮预览 / 编辑）、浏览器、终端、Git、系统监控（看门狗）、Agents、舰队、编排、插件。
- **顶栏**：项目 / 标签操作、系统状态（引擎健康 + pi 版本）、设置齿轮。

<details>
<summary><b>快捷键</b></summary>

| 操作 | 说明 |
| --- | --- |
| `Enter` | 发送；Agent 生成中则立即 Steer |
| `Alt + Enter` | 生成中加入 Follow-up 队列（可拖拽重排） |
| `Esc` | 立即中断当前生成 |
| `@` | 引用项目文件；`/` 打开斜杠命令面板 |
| `Ctrl + V` / 拖拽 | 截图或文件直接进输入框（图片走视觉模型，代码转 `@` 引用） |
| `Ctrl + K` | 清空当前对话（等同 `/clear`） |
| `Ctrl + Shift + C` | 复制整段对话的 Markdown |
| `Ctrl + Tab` / `Ctrl + Shift + Tab` | 多会话标签右 / 左切换 |
| `↑` / `↓` | 回溯历史提示词（`↓` 翻回原草稿） |

</details>

## 🧪 质量与验证

- **类型 / 风格**：`npx tsc --noEmit`、`npm run lint`。
- **测试**：`npm test` → **1 321 项**（0 失败），覆盖 Host 域、RPC 路由、会话读写与分页、Git、插件沙箱、Agent 阀门与工具授权、上下文预算、图像、看门狗 / 介入 / 进度、Host 传输层与堆参数、Token 护栏、UI 纯逻辑。
- **冒烟**：Host RPC、事件重放、Extension UI Bridge、packaged 产物（静态导出 / 浏览器 bridge / 子 Agent 事件代理 / 舰队面板）。
- **门禁**：`measure:packaged`（host 240 / utility 290 / CPU 3%）、`soak:host-heap`（0 OOM / 中位 240 / 峰值 276 / CPU 0.5%）、`smoke:prefix-budget`（7 200 上限 + 命中率 ≥90%）。
- **实测优先**：每个性能与 token 结论都有可复现脚本；连"实验工具本身会不会骗人"都有文档（[`preview-harness-pitfalls.md`](./docs/optimizations/preview-harness-pitfalls.md)）。

## 📦 打包与发布

```bash
npm run dist     # Windows：NSIS + ZIP + latest.yml（含图标检查与打包后冒烟）
npm run pack     # 只出免安装目录 release/win-unpacked
```

发布由 GitHub Actions 完成：推送 `v*` tag（或 `workflow_dispatch` 预演）构建三平台产物，上传 NSIS/ZIP/`latest.yml` 与 `SHA256SUMS.txt`。自动更新由 Electron Main 主导、更新源在构建时固定（`app-update.yml`），运行时不可切换。

> `main` 受分支保护：改动走 PR 合并（直推会被 repository rule 拒绝）。

## 🗂 目录结构

```text
agent-host/    Agent Host：SDK 适配器、会话/工具、LTM、受管进程、插件沙箱、编排 Worker、
               子 Agent 阀门与工具授权、上下文预算与压缩、静态提示词（prompts/）
contract/      Host ↔ Next ↔ Renderer 的 RPC 方法与域类型（单一事实来源）
app/           Next.js 页面与 API 路由（70 条；生产环境经命名管道在 Host 内执行）
components/    三栏工作台、悬浮文件窗、Markdown、输入框、图片灯箱、设置面板、Agents / 编排 / 插件面板
hooks/         Agent 会话、事件流、草稿、会话作用域、面板与配置热重载
lib/           RPC 客户端、会话读写与分页、模型路由、Git、Worker 隔离、Token/Agent 纯逻辑（不持有会话状态）
electron/      主进程、preload、静态协议、传输层启动器、托盘、标题栏、更新逻辑
scripts/       构建、打包、实测（measure / soak / probe / audit / ab）、冒烟与边界校验
docs/          架构、发布记录、优化实测（optimizations/）与设计稿
```

详细约定见 [`AGENTS.md`](./AGENTS.md)（架构与 UI 铁律）与 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

## 📚 文档索引

| 想知道 | 看这份 |
| --- | --- |
| 三进程边界、通信契约、环境变量隔离 | [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) |
| 运行效率三条线（达标 / 不可动 / 证伪） | [`v0.9.x-performance-final.md`](./docs/optimizations/v0.9.x-performance-final.md) |
| Token 账本与成本结构 | [`token-consumption-audit.md`](./docs/optimizations/token-consumption-audit.md) |
| 为什么不再做 token 优化（含重启条件） | [`token-line-closure.md`](./docs/optimizations/token-line-closure.md) |
| 上下文治理候选与 A/B 方法学 | [`context-governance-plan.md`](./docs/optimizations/context-governance-plan.md) / [`context-governance-ab.md`](./docs/optimizations/context-governance-ab.md) |
| L-A 压缩预演（三轮） | [`l-a-preview-report.md`](./docs/optimizations/l-a-preview-report.md) |
| Host 传输层实现与实测 | [`l1-transport-implementation.md`](./docs/optimizations/l1-transport-implementation.md) |
| 实验工具会不会骗人 | [`preview-harness-pitfalls.md`](./docs/optimizations/preview-harness-pitfalls.md) |
| 各版本逐条变更 | [`CHANGELOG.md`](./CHANGELOG.md) / [`docs/releases`](./docs/releases) |

## 🤝 参与贡献

欢迎轻量、聚焦、可验证的 Issue 与 PR。提交前请阅读 [`CONTRIBUTING.md`](./CONTRIBUTING.md)，并遵守 [`AGENTS.md`](./AGENTS.md) 里的铁律：不做过度封装、不破坏三进程边界、改完跑通类型检查 / lint / 测试。

**提数字之前先给命令**：任何"更快/更省"的改动都要附上对应的实测输出（`measure:packaged` / `soak:host-heap` / `audit:token` 等），以及"什么情况下这个结论不成立"。

## 🙏 致谢与协议

PiForge 在 [Chasen-Liao/pi-agent-desktop](https://github.com/Chasen-Liao/pi-agent-desktop)（MIT）与 [DLYZZT/pi-desktop](https://github.com/DLYZZT/pi-desktop) 的设计思路上重写实现，向上游 [Pi coding agent](https://github.com/badlogic/pi-mono) 致敬。**学设计、重实现，不搬运代码。**

以 **MIT License** 发布，详见 [`LICENSE`](./LICENSE)。
