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

底层复用官方 [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi-coding-agent)（当前锁定 `1.1.0`）。**我们不 fork SDK，也不在中间加代理层**：整个 Pi 只经过一个文件——`agent-host/sdk-adapter.ts`。上游升级只改这一层，并用 CI 脚本强制这条边界。

## ✨ v0.8.2 的四个方向

| | 方向 | 一句话 |
| --- | --- | --- |
| 🧠 | **上下文可视化** | 把"离硬顶还有多远"变成底栏一个环，不再靠猜 |
| 🤖 | **子 Agent 与输出风格** | 子 Agent 默认继承父 Agent 工具；输出只砍水分不砍推理 |
| ⚡ | **性能与内存** | 解析/扫描进 Worker，流式渲染按引用缓存，关标签就清定时器 |
| 🧭 | **控制面补齐** | 会话分页、技能分组、图片灯箱、完成回执、状态栏让位 |

> 更早的版本（v0.4 三进程隔离 → v0.5 多智能体 → v0.6 worktree/浏览器/舰队 → v0.7 自定义 Provider/沙箱插件/编排 → v0.8.0 设置中心/上下文压缩/启动提速 → v0.8.1 Agents 实时同步/手动舰队/省钱阀门）见 [`docs/releases`](./docs/releases)。

---

## 🧠 一、上下文可视化：从"感觉快满了"到"看得见"

长会话的成本大头是**每轮重放历史**，但旧 UI 只显示 tokens/s 和本轮产出，用户看不出上下文已经贴到硬顶。

- `agent-host/context-budget.ts` 是**纯函数**：把用量换算成相对硬顶的比例与等级（观察区 60% / 临界 85% / 越顶），前端只负责上色，不再各自猜阈值。
- 硬顶常量**单一来源**仍在 `agent-host/compaction-plan.ts`，展示层不另立一套。
- 底栏是一个 14px 的环：走满 = 贴到硬顶，变红 = 已越顶并脉冲，具体数字全部收进 tooltip 与 `aria-label`（图形比「上下文 102.4k / 硬顶 48k」可读）。
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
- **状态栏让位**：引擎健康点与 pi 核心版本迁入标题栏「系统状态」弹层（复用模块级轮询，弹层不打开就不查上游版本）；额度/余额拆成右侧固定宽度区，数字变化不再拉宽整行；金额按 3 位有效数字显示（`0.001034` 不再被降级成 `<0.0001`）。

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
| `npm test` | 单元 / 路由测试（当前 1091 项，3 项按平台跳过） |
| `npm run smoke:agent-host` | Host RPC / 受管进程 / 会话冒烟 |
| `npm run smoke:agent-isolation` | 客户端断连后 Host 继续流式输出、重连续传 |
| `npm run smoke:host-reconnect` | Next 断线重连与事件重放 |
| `npm run smoke:extension-ui` | Extension UI Bridge `confirm` 往返 |
| `npm run check:sdk-imports` | 强制只有 `sdk-adapter.ts` 直接 import Pi SDK |
| `npm run check:pi-updates` | 查询 npm registry，报告 Pi 新版本 |

</details>

## 🧭 界面速览

- **左栏 · 会话**：搜索、项目分组、按日期分组的历史（滚动分页）、行内「克隆 / 复刻」（目录克隆或独立 worktree）。
- **中栏 · 对话**：多标签并行、流式渲染、增量挂载历史（首屏 20 轮）、内联代码 Diff、消息级分支 `‹ 1/2 ›`。
- **右栏 · 面板**：文件树（悬浮预览 / 编辑）、浏览器（Main 持有）、终端（ANSI 日志流）、Git、**Agents**、舰队、编排、插件。
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

1. **工具定序 + 装载锁定** —— 工具名强制 ASCII 字典序，同一状态原样复用上一份数组；默认只声明核心工具（`bash`/`edit`/`powershell`/`read`/`write`）。
2. **动态工具存根** —— 扩展工具 > 5 个时只发「名字 + 一句话」目录；模型用 `tool_search` 或 `desktop_use_tool` 点名后才注入完整 schema。`spawn_agent` / `herdr_spawn` 等派生原语常驻声明，永远可调。
3. **工具输出预算** —— 命令/日志类 100 行 / 8KB，`read` 300 行 / 16KB，超出换成 `[输出过长已截断，共 X 行]` + grep/sed 续读提示；原文落盘，`tool_history_get` 可翻页；模型自己给的分页提示原样保留。
4. **稳定提示词** —— 输出风格等策略文本集中在 `agent-host/prompts/`，只放静态常量，禁止任何动态插值。
5. **历史滑动窗口** —— 最近 6 轮原样保留，切点只在用户消息上；窗口外攒够 3 轮或上下文占用 ≥ 60% 就压，被压区间须 ≥ 3k tokens（压了不省就别压）。

实测（真实函数，chars/3.2 估 token）：

| 场景 | 改造前 | 改造后 | 节省 |
| --- | --- | --- | --- |
| grep 400 行 | 7,433 | 1,534 | 79% |
| read 2000 行源码 | 37,087 | 2,679 | 93% |
| bash 1500 行构建日志 | 17,590 | 985 | 94% |
| browser_read 12KB 正文 | 5,779 | 1,600 | 72% |

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
- **测试**：`npm test` → **1091 项**（3 项按平台跳过），覆盖 Host 域、RPC 路由、会话读写与分页、Git、插件沙箱、Agent 阀门与工具授权、上下文预算、图片附件、UI 纯逻辑（分组 / 分类 / 轮次缓存 / 作用域）。
- **冒烟**：Host RPC、事件重放、Extension UI Bridge、packaged 产物（standalone server / 浏览器 bridge / 子 Agent 事件代理 / 舰队面板）。
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
