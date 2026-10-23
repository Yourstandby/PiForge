<div align="center">

<img src="./public/logo.svg" width="92" alt="PiForge" />

# PiForge

**把 Pi Coding Agent 装进一张安静的三栏工作台**<br />
*A local-first desktop workbench for the Pi coding agent — multi-session, multi-agent, cache-aware.*

Windows-first · Local-first · Electron + Next.js + Agent Host · MIT

[官网/文档](./docs/ARCHITECTURE.md) · [发布记录](./docs/releases) · [参与贡献](./CONTRIBUTING.md)

</div>

---

[![PiForge 主界面](./docs/assets/generated/poster-light@2x.png)](./docs/assets/generated/demo.mp4)

PiForge 不是又一个「聊天框套壳」。它把 Agent 真正需要的东西放在同一屏：左边是项目与会话，中间是浏览器式多标签对话，右边常驻文件树、内置浏览器、终端、Git、Agents、编排与插件面板。你可以一边让主 Agent 改代码，一边派两个子 Agent 去调研，再让一个常驻舰队 Agent 盯着安全审计——全部互不干扰，全部在本机。

**v0.9.0 新增的核心能力是「看得见卡住」**：无进展看门狗在程序层盯着每个工具的有效进展（零 Token、零 prompt 注入），卡住了亮灯，你点一下 Skip 或问一句话就能接管。

底层复用官方 [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi-coding-agent)（当前锁定 `1.1.0`）。**我们不 fork SDK，也不在中间加代理层**：整个 Pi 只经过一个文件——`agent-host/sdk-adapter.ts`。上游升级只改这一层，并用 CI 脚本强制这条边界。

## ✨ v0.9.0：卡住看得见，介入点一下

| | 能力 | 一句话 |
| --- | --- | --- |
| 🩺 | **无进展看门狗** | 程序层盯「有效进展」，卡住就亮灯，全程零 Token |
| 🖐 | **人工介入** | Skip / 极简询问 / 深度诊断，复用手边已有的队列通路 |
| 📊 | **用量条** | Token、缓存命中、上下文、上游额度常驻输入框下方 |
| 🪟 | **窄窗口浮层** | 视口 ≤ 1080px 时侧栏变浮层，聊天区独占宽度 |
| 🖼 | **灯箱修复** | 复制永远失败（只认 PNG）、大图糊（错用了降采样图） |

> v0.8.3 的省钱改造（工具 23 → 12、按需域、结果去重、缓存保活）未单独发布，随本版首次发出，见下文 [Token 经济](#-token-经济省钱的大头是别让前缀变)。
> 更早的版本（v0.4 三进程隔离 → v0.5 多智能体 → v0.6 worktree/浏览器/舰队 → v0.7 自定义 Provider/沙箱插件/编排 → v0.8.0 设置中心/上下文压缩/启动提速 → v0.8.1 Agents 实时同步/手动舰队/省钱阀门 → v0.8.2 上下文可视化/子 Agent 授权/性能）见 [`docs/releases`](./docs/releases)。

---

## 🩺 核心竞争力：Watchdog & Intervention（零 Token 监控）

普通桌面端对付「卡住」只有两条路：让模型自己反思（每问一次就是一次 LLM 请求），或者让用户盯着进度条猜。PiForge 把监控搬到程序层，把处置权交回用户。

### 1. 零 Token 消耗：监控不在模型里

`agent-host/watchdog.ts` 只有 `setInterval` + 内存状态机 + 内存队列：

- **不调模型** —— 整个模块不 import 任何发送接口，连 `prompt()` 都碰不到；
- **不写 prompt** —— 通知只进 `notices` 环形队列（上限 50 条），`watchdog.status` 只读回给 UI；system prompt / 对话历史 / 会话 JSONL 一个字节都不改；
- **不阻塞主流程** —— 观察者是同步「读事件 → 更新计数」，扫描在独立定时器里跑并 `.unref()`：不 sleep、不轮询、不等待。

所以「盯着 8 个并发工具跑 6 分钟」和「什么也不干」的账单完全一样。

### 2. 数据面与控制面隔离：心跳不牵动聊天流

- 事件在 Host 侧被顺手观测（`observeAgentEvent`，O(1)、无 IO），状态只活在该进程内存里；
- Renderer 走一条模块级单例轮询（有活跃任务 1s / 空闲 4s / 窗口隐藏时不查），用 `useSyncExternalStore` 订阅；
- 快照按签名去重（状态 / 最后活动 / 步骤数 / 通知序号），`idle_seconds` 这种逐秒变化的量交给组件自己的本地时钟算 —— **每秒跳动不会让整棵对话树重渲染**；
- 对话区不订阅整体快照：只有正在执行的那几张工具卡订阅自己的停滞视图。

### 3. 三道防线：分层自愈，不是单点监控

| 层 | 在哪 | 兜住什么 |
| --- | --- | --- |
| ① 进程树硬超时 | `process-killer.ts` / `managed-processes.ts` | 优雅终止 → 2.5s 后 `SIGKILL` / `taskkill /T /F`（最多重试 2 次）；`process_wait` 默认 30s 上限（最大 5min），子 Agent 单轮默认 5min |
| ② 看门狗干预 | `watchdog.ts` + `intervention.ts` | 20s 无有效进展 → 30s/60s/120s 退避提醒 → 标 `failed`；人点一下即可注入指令 |
| ③ 后台进程接管 | `crash-reaper.ts` | Host 启动时清点上次遗留的进程状态文件：只终止 agent 起的进程、先验身份、验不了就留着并上报（fail-closed）；心跳 30s 内视为活、owner pid 还活着一律不碰 |

三层各管一段：① 兜「进程失控」，② 兜「进程活着但没进展」，③ 兜「Host 自己没了」。

### 4. 两把尺子 + 并发感知

- `lastActivityAt` 只在**有效进展**（成功且不重复的动作、正文增量）时刷新；`lastAttemptAt` 记一切尝试。看门狗只看前者，所以「反复跑同一条报错命令」不会被误判成有进展（同一签名成功两次算重复）。
- `lastLivenessAt` 记「活的迹象」（工具启动、流式输出也算），心跳条用它显示「最后活动 N 秒前」，6 个工具并发时也不会永远显示 0 秒前。
- 并发按 `toolCallId` 逐个建档（最多 16 个）：**任意一个**工具超阈即判停滞，面板能直接说「3 个工具执行中，最久 N 秒无输出」。

### 5. 异步介入：省钱也省队列

三个动作全部复用既有通路（运行中 `steer` → 有排队则插队首 → 否则 `prompt`），没有新的模型直连：

| 动作 | 注入什么 | 代价 |
| --- | --- | --- |
| **Skip（强制跳过）** | 「当前工具已因无进展被系统跳过，请换方案继续」 | 一次极短请求 |
| **极简询问**（默认） | 「禁止执行任何新工具核实，一句话（20 字内）说明卡在哪、要不要跳过」 | 一句话 |
| **深度诊断** | 允许跑工具去核实状态（`ask`） | 可能上万 Token |

守卫写在 Host 侧（不信前端按钮状态）：

- 同动作冷却 **3 秒**（防连点、防两个窗口同时点）；
- 单任务上限 **5 次**（超出提示「直接结束或重新发起任务」）；
- **没有活跃任务直接拒绝**（`no_active_task`）—— 任务已结束就没有「介入」这回事。

代价很具体：模型被「你为什么卡了」一追问就会去跑 `tsc` / `grep` 自证，一次烧掉上万 Token 并把执行流堵死。所以默认动作是「禁工具、限一句」。

### 6. 配置参数

| 概念名 | 真实环境变量 | 默认 | 说明 |
| --- | --- | --- | --- |
| `WATCHDOG_ENABLED` | `PIFORGE_WATCHDOG` | `1`（开） | `0/false/off/no` 关闭：不建定时器、不记状态，`watchdog.status` 只回 `{enabled:false}`，行为等同 v0.8.2 |
| `STALL_TIMEOUT_SECONDS` | `PIFORGE_WATCHDOG_STALL_MS` | `20_000`（20s） | 多久无有效进展算疑似卡顿；**UI 可热切换**（15/30/60/90 秒），Host 钳制 5s–10min |
| `TICK_SECONDS` | `PIFORGE_WATCHDOG_TICK_MS` | `10_000`（10s） | 扫描周期，只在 Host 启动时读 |
| 按需工具域 | `PIFORGE_ON_DEMAND_DOMAINS` | `shell` | 见 [开关与迁移](#-开关与迁移) |

升级判定：任务级连续 3 次扫描无进展才 `stalled`；单个工具已超阈则首次扫描就升级；退避通知 30s / 60s / 120s，用完标 `failed`（只标 UI，不干预模型）。改阈值只写内存配置：不重建定时器、不重置任务、不产生通知。

---

> **已有能力（v0.8.2 起）**：下面四节是 v0.8.2 建立的能力。v0.9.0 在它们之上只追加了停滞状态灯、用量条、窄窗口浮层与灯箱修复（见文首），这四节的实现未动。

## 🧠 一、上下文可视化：从"感觉快满了"到"看得见"

长会话的成本大头是**每轮重放历史**，但旧 UI 只显示 tokens/s 和本轮产出，用户看不出上下文已经贴到硬顶。

- `agent-host/context-budget.ts` 是**纯函数**：把用量换算成相对硬顶的比例与等级（观察区 60% / 临界 85% / 越顶），前端只负责上色，不再各自猜阈值。
- 硬顶常量**单一来源**仍在 `agent-host/compaction-plan.ts`，展示层不另立一套。
- 输入框旁一个 14px 的环（`ContextRing`）：走满 = 贴到硬顶，变红 = 已越顶并脉冲，具体数字全部收进 tooltip 与 `aria-label`（图形比「上下文 102.4k / 硬顶 48k」可读）。
- 压缩进行中环会转起来；触发原因、被压区间体积可用 `PIFORGE_DEBUG_COMPACT=1` 打印。

> 保留最近若干轮原文，切点永远落在用户消息上（不劈轮次），四段式摘要 + 自动提取改动文件。

## 🤖 二、子 Agent 与输出风格：能干活，但别烧钱

### 工具授权（`agent-host/tool-grants.ts`）

破过的坑：子 Agent 固定只拿 `read/grep/find/ls`，父 Agent 让它跑测试、看 diff、改一行配置时，它只能空转或者瞎编——这不是省钱，是把推理质量按件贱卖。

| 规则 | 行为 |
| --- | --- |
| 默认继承 | 父 Agent 当前的 `activeTools`；`bash / read / write / edit` 运行时存在就**强制保留** |
| 显式放宽 | 父 Agent 传 `tools: [...]` 时取**并集**（只会更宽，不会更窄） |
| 绝不下放 | 递归与 UI 副作用工具（`spawn_agent`、`herdr_*`、`orchestrator_*`、受管进程、浏览器） |
| 权限缺失 | 请求了运行时没有的工具 → 第一轮直接 `PERMISSION_MISSING`，不允许空转到熔断 |

授权只读 `pi.getAllTools()` 的**全量注册表**，绝不读工具存根目录：存根开启不影响提权，子 Agent 的工具集也不会回写父 Agent 的声明（前缀缓存保持字节级稳定）。

### 输出风格（`agent-host/prompts/output-style.ts`）

单独成文件、**只放静态字符串**：prompt 缓存按前缀命中，system prompt 里混进时间戳/随机 id/会话路径，整段前缀就失效。目标是**不降低推理质量，只砍掉输出里的水分**——先要求深入思考，再约束最终呈现：禁客套、禁复述问题、改代码只给 diff、非明确要求不展开长文。

### 生命周期

| 项目 | 行为 |
| --- | --- |
| 单轮超时 | 默认 **5 分钟**（原 15 分钟），可被调用方覆盖，夹在 1s–30min；到点 `abort` + 强制终止，不留 zombie |
| 空闲休眠 | 空闲 5 分钟自动 `dispose` + stopped（60s 扫一次），`MAX_FLEET=4` 的槽位不被挂机会话吃掉 |
| 一次性任务 | `herdr_spawn` 支持"完成即退出"，不占常驻槽位 |

### 省钱阀门（硬闸，不是建议）

| 阀门 | 阈值 | 行为 |
| --- | --- | --- |
| 轮数上限 | 3 轮 | 第 4 轮直接被拒，提示「汇总已有结论、新建 Agent」 |
| 强制摘要 | 1200 字符 | 回给主 Agent 的只有结论 + 关键要点；原始长日志只留在面板 |
| 上下文熔断 | 10k tokens / 轮 | 立刻 `abort()` 并标记「上下文熔断」，之后拒绝新指令 |

### 临时子 Agent vs 常驻舰队

| | 临时子 Agent | 舰队 Agent |
| --- | --- | --- |
| 谁创建 | 主 Agent 调 `spawn_agent` | `herdr_spawn`，或面板「**+ 新建 / 加载 Agent**」 |
| 生命周期 | 一次任务，用完即销毁 | 常驻待命，可反复下发消息（空闲自动休眠） |
| 上下文 | 独立 in-memory 会话，绝不写主 JSONL | 同左，但保留上下文直到休眠 |
| 配置 | 由主 Agent 现场写 | 名称 / System Prompt / 工具权限 → `<agentDir>/fleet/agents.json`，重启回显 |
| 对话方式 | 一次性返回报告 | 卡片内直接输入消息（底层 `herdr_message`） |

## ⚡ 三、性能与内存：长会话不该越来越卡

### 三个 Worker

| 文件 | 解决什么 |
| --- | --- |
| `lib/jsonl-worker.ts` | >1MB 会话文件整体进 `worker_threads`（源码内联，standalone 不用多带文件）；失败/超时一律回落内联解析 |
| `lib/git-status-worker.ts` | `git rev-parse` + `git status` 进 worker（20s 超时），主线程只做 cwd 相对路径换算；仓库再大也不拖 Event Loop |
| `lib/session-scan-worker.ts` | 会话索引扫描与分页同理，首屏不等扫盘 |

### 三处内存/渲染修正

- **轮次身份缓存**（`lib/transcript-turn-cache.ts`）：`messages` 每帧都变，但历史消息对象引用不变。按「消息对象同一 **且** 它引用的工具结果对象也同一」命中缓存，`TurnRow` 的 `memo` 才真的生效——修掉流式期间每帧全量重渲（开发日志里 `turn 173 rendered 777 times` 就是这么来的）。
- **滚动位置记忆**（`lib/chat-scroll-memory.ts`）：`display:none` 隐藏后 `scrollTop` 恒为 0、`clientHeight` 也是 0，旧代码因此在切走时记下 0，切回来就跳回第一条消息。现在只在量得出高度时才信 DOM。
- **会话作用域登记**（`lib/session-scope.ts` + `hooks/useSessionScope.ts`）：凡是挂在某个会话上的 `setInterval` / `ResizeObserver` / `setTimeout`（对账、贴底滚动、自动标题、乐观刷新）都必须登记，切会话或关标签一次性 `disposeSession()`，旧会话再也不会回调。

## 🧭 四、控制面补齐：把"看得见、管得住"补完

### 会话列表分页

- 首屏 **20 条**，滚动到底每次追加 **10 条**（`SESSION_PAGE_SIZE` / `SESSION_PAGE_STEP`）；索引 TTL 10s，扫描并发 8、`SessionInfo` 读取并发 4、缓存上限 400。
- 刷新不会把列表缩回第一页（按 `loadedDepthRef` 深度重取），修掉"项目分组消失又出现"的跳动。
- 空闲预取下一批（并发 1、2s 超时），滚到底时数据已在缓存里；行内标记"已在标签页打开"。
- 一轮任务结束只补一次列表刷新（1.2s 节流），不再每个工具回合都扫盘。

### 技能面板

- 每个技能带 `scope: global | project` 与来源 `agents | pi | package | other`，项目级 `.pi/skills` 与用户级 `~/.agents/skills` 分开显示。
- 修掉 Git Bash / msys2 下 `HOME=/c/Users/x` 导致用户级技能整批丢失（Windows 上拼出的目录根本不存在）。
- 关键词自动分类（设计 / 前端 / 后端 / 测试 / 文档 / 发布 / 工作流 / 元技能 / 其它）+ 一句话概述；手动分类存 `localStorage`，不污染 `SKILL.md`；扫描结果 5s 缓存。

### 图片

- 贴图先在本地缩到视觉模型 **1568px** 长边上限（`createImageBitmap` + `OffscreenCanvas` 走合成线程）：模型看到的信息一样，上传体积与计费 token 降 4~10 倍；任何一步不可用就退回原始读取，绝不因为优化让图片贴不进去。
- 缩放注记只给模型看，渲染前剥除，用户看不到自己"没说过的话"。
- 对话与工具输出里的图片点开即灯箱：缩放 / 平移 / 旋转 / 下载 / 复制 / 翻页，键盘 `+ - R`。

### 回执、归属与状态栏

- **任务结束卡片**：只有"忙 → 空闲"这一跳才算跑完，附最后一条回复摘要（1200 字符截断）；后台标签保留绿点直到切回。
- **Agents 归属**：右侧面板按 `项目 › 会话` 分组，排序 `session > project > other`，运行中置顶；数据全部走既有 SSE（`subagents` / `fleet`），**零轮询**，1 秒只驱动「耗时」一个数字。
- **状态栏让位**：引擎健康点与 pi 核心版本迁入标题栏「系统状态」弹层（复用模块级轮询，弹层不打开就不查上游版本）；Token / 缓存 / 额度已全部迁到输入框下方的用量条，数字变化不再拉宽底栏；金额按 3 位有效数字显示（`0.001034` 不再被降级成 `<0.0001`）。

---

## 🧱 架构：三进程，一条管道，零内部端口

```text
Electron Main ──spawn──▶ Next.js server ──HTTP/SSE──▶ Renderer（只做 UI 与 DOM 占位）
      │                        │
      │                        ├──命名管道 RPC──▶ Agent Host（Pi SDK · tools · plugins · LTM）
      │                        └──bounds 上报──▶ Main 持有的 WebContentsView（内置浏览器）
      └──utilityProcess──▶ Agent Host
                               ├──127.0.0.1 WebSocket（自动端口）──▶ 插件 / 流式总线
                               └──独立 OS Worker ──▶ 每个 Worker 独占 Git worktree
```

三条不能破的边界（CI 与代码评审都会查）：

1. **Agent 只住在 Host**：SDK / AgentSession / 工具执行 / 受管进程 / LTM 全部在 `agent-host/`，Next 不持有任何会话状态。
2. **只走命名管道**：Host ↔ Next 不做 localhost TCP；Next 重启不会杀掉正在流式输出的 Agent，重连按 `seq` 续传。
3. **文件先授权再 IO**：`/api/files`、git、statusline、processes 都必须先 `files.authorize`，白名单只在 Host。

## 🚀 快速开始

需要 **Node.js 20+ / npm 10+**（Windows 10/11 为主要目标平台）。

```bash
git clone https://github.com/yourstandby/PiForge.git
cd PiForge
npm install

npm run dev            # 浏览器开发模式 → http://localhost:30141
npm run dev:electron   # 桌面窗口（同时编译 Host 与 Electron 主进程）
```

<details>
<summary><b>常用命令</b></summary>

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 编译并启动 Agent Host + Next（端口 `30141`） |
| `npm run dev:electron` | 编译 Host / Electron 主进程并打开桌面窗口 |
| `npm run dist` | 打包 Windows NSIS 安装包（含图标、冒烟、`latest.yml`） |
| `npm run pack` | 只产出 `release/win-unpacked`（无签名/受限环境用） |
| `npx tsc --noEmit` | TypeScript 类型检查 |
| `npm run lint` | ESLint |
| `npm test` | 单元 / 路由测试（当前 1 253 项，3 项按平台跳过） |
| `npm run smoke:agent-host` | Host RPC / 受管进程 / 会话冒烟（含 `watchdog.status` / `agent.intervene` 断言） |
| `npm run smoke:agent-isolation` | 客户端断连后 Host 继续流式输出、重连续传 |
| `npm run smoke:host-reconnect` | Next 断线重连与事件重放 |
| `npm run smoke:extension-ui` | Extension UI Bridge `confirm` 往返 |
| `npm run check:sdk-imports` | 强制只有 `sdk-adapter.ts` 直接 import Pi SDK |
| `npm run check:pi-updates` | 查询 npm registry，报告 Pi 新版本 |

</details>

## 🧭 界面速览

- **左栏 · 会话**：搜索、项目分组、按日期分组的历史（滚动分页）、行内「克隆 / 复刻」（目录克隆或独立 worktree）。
- **中栏 · 对话**：多标签并行、流式渲染、增量挂载历史（首屏 20 轮）、内联代码 Diff、消息级分支 `‹ 1/2 ›`；输入框下方常驻用量条（Token / 缓存命中 / 上下文 / 上游额度）。
- **右栏 · 面板**：文件树（悬浮预览 / 编辑）、浏览器（Main 持有）、终端（ANSI 日志流）、Git、**系统监控**（看门狗）、**Agents**、舰队、编排、插件。
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

## 💰 Token 经济：省钱的大头是「别让前缀变」

Prompt 缓存按**字节级前缀**命中：system prompt 或 `tools` 数组抖一下，后面整段历史就按未命中重新计费。所以：

1. **工具定序 + 装载锁定** —— 工具名强制 ASCII 字典序，同一状态原样复用上一份数组；默认只声明核心工具（`bash`/`edit`/`read`/`write`）+ 5 个多态工具。
2. **多态工具（v0.8.3）** —— 20 个扩展工具按域收成 5 个：`browser` / `shell` / `fleet` / `orchestrator` / `memory`，用 `action` 分派。旧工具仍以 `deferred` 注册（`ctx.executeTool` 可调、UI 与审批沿用旧名字），只是不再各带一份 schema。实测扩展工具 3 035 → 1 913 tok，声明工具数 23 → **12**（默认只让 `shell` 按需时声明 **11**）。
3. **动态工具存根** —— 扩展工具 > 5 个时只发「名字 + 一句话」目录；模型用 `tool_search` 或 `desktop_use_tool` 点名后才注入完整 schema。5 个多态工具与通道工具常驻声明，永远可调。
4. **前缀度量基线** —— `npm run measure:prefix` 用本地记录型 provider 把真实请求体拆成 system/tools/历史三段算账，并与 pi CLI（仅 4 个核心工具）对比；`npm run smoke:prefix-budget` 是回归护栏。详见 `docs/measurements/README.md`。
5. **工具输出预算** —— 命令/日志类 100 行 / 8KB，`read` 300 行 / 16KB，超出换成 `[输出过长已截断，共 X 行]` + grep/sed 续读提示；原文落盘，`tool_history_get` 可翻页；模型自己给的分页提示原样保留。
6. **稳定提示词** —— 输出风格等策略文本集中在 `agent-host/prompts/`，只放静态常量，禁止任何动态插值。
7. **历史滑动窗口** —— 最近 6 轮原样保留，切点只在用户消息上；窗口外攒够 3 轮或上下文占用 ≥ 60% 就压，被压区间须 ≥ 3k tokens（压了不省就别压）。

实测（真实函数，chars/3.2 估 token）：

| 场景 | 改造前 | 改造后 | 节省 |
| --- | --- | --- | --- |
| grep 400 行 | 7,433 | 1,534 | 79% |
| read 2000 行源码 | 37,087 | 2,679 | 93% |
| bash 1500 行构建日志 | 17,590 | 985 | 94% |
| browser_read 12KB 正文 | 5,779 | 1,600 | 72% |

### v0.9.0 的四个数字（与前版一致，无回归）

| 项 | 数值 | 口径 |
| --- | --- | --- |
| 静态前缀 | **6 244**（记录型复测 6 240，±4 为仓库文档体积抖动） | 记录型 provider（可复现，决策用） |
| 声明工具数 | **12**（A 组全常驻）/ **11**（默认 `shell` 按需） | `measure:prefix` 的 tools 列 |
| 核心四件套 | **710 tok** | `measure:prefix` 的 core 列；与 pi CLI 四件套逐字节一致 |
| 稳定段命中率 | **99.5%**（记录型）/ **97.98%**（真实会话 30 轮） | 两者不可互换 |

**三个口径不要混读**（详见 [`docs/measurements/README.md`](./docs/measurements/README.md)）：

1. **记录型 provider** —— 本地假 provider 抓真实请求体，可复现，用来决策前缀与激活成本；
2. **真实 deepseek 30 轮** —— 用来确认命中率/中位数没下降，受 provider 计费与跨会话缓存影响，数字会抖；
3. **重复场景 A/B** —— 只用于验证结果去重收益（`measure:increment`）。

> 本机复测：`npm run smoke:prefix-budget` 退出码 0，3 轮 cacheRead 命中 99.5%。前缀数字与环境有关：若 `~/.agents/skills` 下有已安装技能，它会以 `<skills>` 段进入 system prompt（本机 +1 598 字符 ≈ +400 tok，前缀变 6 640），属于环境差异不是代码回归；基线口径是清空个人技能目录（`HOME=<空目录>`）后测得 6 240 / 11 工具 / 核心 710。

### 开关与迁移（`onDemandDomains`）

**做了什么**：中频域 `shell`（PowerShell + 后台进程）从「每轮声明」改成「首次用时 `tool_search`
激活，之后棘轮常驻」；核心四件套与其余域不变。

**为什么只对它**：30 轮真实会话里 `shell` 是除 `bash/read` 外唯一被真实调用的域（`shell×4`），
其余域为 0 次 —— 把它们按需化只会付发现往返（第 5 步实测 memory/orchestrator 净收益为负，已回退）。
`shell` 的 A/B：前缀 6 988 → **6 240**（每轮省 748），激活 4 600、回本 6.2 轮，
30 轮净收益 ≈ **+13 200 tok**，命中率不变（97.98% vs 97.98%）。

**同时修掉的根因**：`tool_search` 以前会把内部注册名（`run_bg`/`browser_read`…）返回给模型，
wire name 对不上 → `unsupported call`。现在只返回可调用的 wire name、撤掉内部名的激活、
并把 active 按 canonical 顺序重排（否则激活那轮是追加序、下一轮变字典序 = 两次前缀写入），
结果文本里明确写「新工具下一轮再调，不要同轮连调」。

**怎么改**（设置页 → 运行 → 「按需工具域」多选，默认只勾 `shell`）：

```bash
PIFORGE_ON_DEMAND_DOMAINS=0             # 全部常驻（A 组，前缀 6 988）
PIFORGE_ON_DEMAND_DOMAINS=1             # 兼容别名：memory + orchestrator 按需（历史语义，不是「全按需」）
PIFORGE_ON_DEMAND_DOMAINS=browser,shell # 显式列表
# 都不设置时读设置项 onDemandDomains；设置项也没有 → 默认 shell
```

| 取值 | 含义 |
| --- | --- |
| `0` / 空数组 | **全部常驻** —— 想回到「每轮都带完整 schema」就用这个（前缀 6 988） |
| `1` | **兼容别名**：`memory` + `orchestrator` 按需（不是「全按需」） |
| `shell` / `browser,shell` | 显式列表：列出的域按需，其余常驻 |
| 未设置 | 读设置项 `onDemandDomains`；设置项也没写过 → 默认 `shell` |

- **优先级：环境变量 > 设置项 `onDemandDomains` > 默认值（`shell`）**。环境变量存在时，设置页显示生效值并禁用勾选。
- 设置项改动**对新建会话生效**，当前会话需重新加载。
- 老用户如果之前用过 `=1`：行为不变（一直是 memory + orchestrator）；勾选 `memory` / `orchestrator` 仍只给黄色提示（实测负收益），不禁止。

### 配置参数表

| 参数 | 环境变量 | 默认 | 来源优先级 |
| --- | --- | --- | --- |
| 看门狗开关 | `PIFORGE_WATCHDOG` | 开 | env > 默认 |
| 停滞阈值 | `PIFORGE_WATCHDOG_STALL_MS` | 20s | **面板下拉框（运行期热切换）** > env > 20s；Host 钳制 5s–10min |
| 扫描周期 | `PIFORGE_WATCHDOG_TICK_MS` | 10s | env > 默认（只在 Host 启动时读） |
| 按需工具域 | `PIFORGE_ON_DEMAND_DOMAINS` | `shell` | env > 设置项 `onDemandDomains` > `shell` |

### 当前状态与硬约束（v0.9.0）

| 硬约束 | 落实结果 | 护栏 |
| --- | --- | --- |
| 不降质量 | 工具合并保留全部动作语义；按需域实测后回退常驻（避免发现往返与尖峰）；去重只作用于成功且重复的内容，错误永远完整 | `measure:increment`（错误原样）、`prefix-ratchet` 单测、真实会话 30 轮 |
| 不删可感知功能 / 工具 | 旧工具名仍可调用，UI/审批/i18n 沿用；声明结构未动（仍是 12 / 默认 11）；设置页显示缓存保活真实状态 | `smoke:prefix-budget` 三种配置 + 全量测试 |
| 不引入自动压缩 | 没有任何自动压缩/上下文改写；`applyAutoCompactionPolicy` 仍是「显式设置才开」；看门狗只标记、不代模型做决定 | `agent-host/rpc-manager.test.ts` |
| 核心四件套 710 tok | v0.8.2 / v0.8.3 / v0.9.0 三个版本一致 | `measure:prefix` 的 core 列 |
| 默认前缀 6 244 | 6 240–6 244（记录型；±4 来自仓库文档体积） | `smoke:prefix-budget --max-prefix 7200` |
| 稳定段命中率 ≥ 97.98% | 记录型 provider 99.5–99.6%；真实会话 97.98% | 记录型 90% 硬门槛 + `measure:long-session --min-hit-rate 90` |

### 路线图（已规划，未实现）

| 方向 | 现状 | 为什么还没做 |
| --- | --- | --- |
| **自动杀进程**（命中 `stalled` 直接终止进程树） | 当前只能人工点 Skip | 杀错比卡住贵：必须先把「疑似阻塞点」判据跑满真实场景 |
| **极简询问自动化**（停滞即自动问一句） | `ask_brief` 已上线，但需手点 | 自动追问需要先验证冷却+上限在长会话里不刷屏（当前上限 5 次/任务） |
| **`browser` 域按需化** | 仍常驻 | 30 轮真实会话里 `browser` 被调 0 次，没有真实频率可测，不拿假设换往返 |

**明确不做**（违反硬约束，已判定收益不痛）：

- **per-action 说明压到 1 句**（≈ −1 000 tok/轮）：语义降级，违反「不降质量」；
- **关闭输出风格 / 回复语言附加项**（≈ −298 tok/轮）：用户可感知的风格约束消失；
- **用 provider 侧上下文裁剪替代历史摘要**：信息丢失不可控，且触碰「不自动压缩」红线。

调试开关：`PIFORGE_DEBUG_PREFIX=1`（打印前缀哪一段变了 + 首个差异字符）、`PIFORGE_DEBUG_COMPACT=1`（压缩触发原因与体积）、`PIFORGE_PREFIX_STRIP_CWD=1`（把 cwd 从 system prompt 挪进用户消息，默认关闭 —— 会话内 cwd 是常量，挪走反而多付 token）。

## 📦 打包与发布

```bash
npm run dist     # Windows：NSIS + ZIP + latest.yml（含图标检查与打包后冒烟）
npm run pack     # 只出免安装目录 release/win-unpacked
```

发布完全交给 GitHub Actions：推送 `v*` tag（或 `workflow_dispatch` 预演）构建三平台产物，上传 NSIS/ZIP/`latest.yml` 与 `SHA256SUMS.txt`。自动更新由 Electron Main 主导、更新源在构建时固定（`app-update.yml`），运行时不可切换。

> `main` 受分支保护：改动走 `dev/vX.Y.Z` 分支 + PR 合并。

## 🧪 质量与验证

- **类型 / 风格**：`npx tsc --noEmit`、`npm run lint`。
- **测试**：`npm test` → **1 253 项**（3 项按平台跳过），覆盖 Host 域、RPC 路由、会话读写与分页、Git、插件沙箱、Agent 阀门与工具授权、上下文预算、图片附件、看门狗 / 介入 / 进度追踪、UI 纯逻辑（分组 / 分类 / 轮次缓存 / 作用域）。
- **冒烟**：Host RPC（含看门狗只读接口与介入拒绝路径）、事件重放、Extension UI Bridge、packaged 产物（standalone server / 浏览器 bridge / 子 Agent 事件代理 / 舰队面板）。
- **边界校验**：`check:sdk-imports`（SDK 收口）、`check:electron-deps`、`check:pi-updates`。

## 🗂 目录结构

```text
agent-host/    Agent Host：SDK 适配器、会话/工具、LTM、受管进程、插件沙箱、编排 Worker、
               Agent 阀门与工具授权、上下文预算、静态提示词（prompts/）
contract/      Host ↔ Next ↔ Renderer 的 RPC 方法与域类型（单一事实来源）
app/           Next.js 页面与 API 路由（sessions / agent / fleet / files / git / skills / processes）
components/    三栏工作台、悬浮文件窗、Markdown、输入框、图片灯箱、设置面板、Agents / 编排 / 插件面板
hooks/         Agent 会话、事件流、草稿、会话作用域、面板与配置热重载
lib/           RPC 客户端、会话读写与分页、模型路由、Git、Worker 隔离、Token/Agent 纯逻辑（不持有会话状态）
electron/      主进程、preload、托盘、标题栏、更新逻辑与 Main BrowserManager
scripts/       构建、图标、SDK 边界/升级雷达、NSIS 补丁、standalone / packaged 冒烟
docs/          架构、发布记录、调研与设计稿
```

详细约定见 [`AGENTS.md`](./AGENTS.md)（架构与 UI 铁律）与 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

## 🤝 参与贡献

欢迎轻量、聚焦、可验证的 Issue 与 PR。提交前请阅读 [`CONTRIBUTING.md`](./CONTRIBUTING.md)，并遵守 [`AGENTS.md`](./AGENTS.md) 里的铁律：不做过度封装、不破坏三进程边界、改完跑通类型检查 / lint / 测试。

## 🙏 致谢与协议

PiForge 在 [Chasen-Liao/pi-agent-desktop](https://github.com/Chasen-Liao/pi-agent-desktop)（MIT）与 [DLYZZT/pi-desktop](https://github.com/DLYZZT/pi-desktop) 的设计思路上重写实现，向上游 [Pi coding agent](https://github.com/badlogic/pi-mono) 致敬。**学设计、重实现，不搬运代码。**

以 **MIT License** 发布，详见 [`LICENSE`](./LICENSE)。
