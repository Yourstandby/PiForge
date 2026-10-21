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

## ✨ v0.8.0 你立刻能感受到的六件事

| | 能力 | 说明 |
| --- | --- | --- |
| 🎛 | **统一设置中心** | 右上齿轮一个「常规」面板：思考等级、运行中 `Enter` 行为、隐藏思考、缓存未命中提示、自动压缩、空闲预热、技能斜杠命令……改完即生效并持久化 |
| 🧠 | **上下文自动压缩** | 保留最近若干轮原文，切点永远落在用户消息上（不劈轮次），四段式摘要 + 自动提取改动文件 |
| 🤖 | **多 Agent 与常驻舰队** | 临时子 Agent（用完即销毁）+ 舰队 Agent（手建配置、持久化、可反复下发消息），右侧 Agents 面板实时同步 |
| 💰 | **Token 经济** | 前缀缓存定序、工具输出预算、动态工具存根、Agent 省钱阀门 —— 长会话每轮开销显著下降 |
| 🐚 | **PowerShell 一等公民** | Windows 默认 `pwsh` 7（回退 5.1），统一 `-NoProfile -NonInteractive` 与 UTF-8，中文/多行/引号都不再乱码 |
| ⚡ | **启动提速** | Host 与 Next 并行拉起，首屏不再等会话扫盘，记住上次项目秒开 |

> 更早的版本（v0.4 三进程隔离 → v0.5 多智能体 → v0.6 worktree/浏览器/舰队 → v0.7 自定义 Provider/沙箱插件/编排）见 [`docs/releases`](./docs/releases)。

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
| `npm test` | 单元 / 路由测试（当前 1026 项，3 项按平台跳过） |
| `npm run smoke:agent-host` | Host RPC / 受管进程 / 会话冒烟 |
| `npm run smoke:agent-isolation` | 客户端断连后 Host 继续流式输出、重连续传 |
| `npm run smoke:host-reconnect` | Next 断线重连与事件重放 |
| `npm run smoke:extension-ui` | Extension UI Bridge `confirm` 往返 |
| `npm run check:sdk-imports` | 强制只有 `sdk-adapter.ts` 直接 import Pi SDK |
| `npm run check:pi-updates` | 查询 npm registry，报告 Pi 新版本 |

</details>

## 🧭 界面速览

- **左栏 · 会话**：搜索、项目分组、按日期分组的历史、行内「克隆 / 复刻」（目录克隆或独立 worktree）。
- **中栏 · 对话**：多标签并行、流式渲染、增量挂载历史（首屏 20 轮）、内联代码 Diff、消息级分支 `‹ 1/2 ›`。
- **右栏 · 面板**：文件树（悬浮预览 / 编辑）、浏览器（Main 持有）、终端（ANSI 日志流）、Git、**Agents**、舰队、编排、插件。

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

## 🤖 多 Agent：临时子 Agent vs 常驻舰队

| | 临时子 Agent | 舰队 Agent |
| --- | --- | --- |
| 谁创建 | 主 Agent 调 `spawn_agent` | 主 Agent 调 `herdr_spawn`，或面板「**+ 新建 / 加载 Agent**」 |
| 生命周期 | 一次任务，用完即销毁 | 常驻待命，可反复下发消息 |
| 上下文 | 独立 in-memory 会话，绝不写主 JSONL | 同左，但保留上下文直到休眠 |
| 配置 | 由主 Agent 现场写 | 名称 / System Prompt / 只读工具权限，写入 `<agentDir>/fleet/agents.json`，重启回显 |
| 对话方式 | 一次性返回报告 | 卡片内直接输入消息（底层 `herdr_message`） |

右侧 **Agents** 面板把两类 Agent 放在同一张列表里，运行中的永远置顶：

- 两条 SSE 主题（`subagents` / `fleet`）实时推送，不靠轮询；断线才降级为轮询并明示。
- 子 Agent 帽子标注 Running / Idle / Failed，舰队卡片带「舰队」徽章与 `轮数/3`。
- 支持从 JSON 导入配置：单条、数组、`{ "profiles": [...] }` 三种形态都认。

### 💸 Agent 省钱阀门（硬闸，不是建议）

| 阀门 | 阈值 | 行为 |
| --- | --- | --- |
| 轮数上限 | 3 轮 | 第 4 轮直接被拒，提示「汇总已有结论、新建 Agent」而不是继续追问同一段上下文 |
| 强制摘要 | 1200 字符 | 回给主 Agent 的只有结论 + 关键要点；原始长日志只留在面板里 |
| 上下文熔断 | 10k tokens / 轮 | 立刻 `abort()` 并标记「上下文熔断」，之后拒绝新指令（需重新唤醒） |

实现集中在 `agent-host/agent-guards.ts`，两个 runner（`subagents.ts` / `herdr-manager.ts`）共用同一套判定，并有单测覆盖阈值边界。

## 💰 Token 经济：省钱的大头是「别让前缀变」

Prompt 缓存按**字节级前缀**命中：system prompt 或 `tools` 数组抖一下，后面整段历史就按未命中重新计费。所以：

1. **工具定序 + 装载锁定** —— 工具名强制 ASCII 字典序，同一状态原样复用上一份数组；默认只声明核心工具（`bash`/`edit`/`powershell`/`read`/`write`）。
2. **动态工具存根** —— 扩展工具 > 5 个时只发「名字 + 一句话」目录；模型用 `tool_search` 或 `desktop_use_tool` 点名后才注入完整 schema。`spawn_agent` / `herdr_spawn` 等派生原语常驻声明，永远可调。
3. **工具输出预算** —— 命令/日志类 100 行 / 8KB，`read` 300 行 / 16KB，超出换成 `[输出过长已截断，共 X 行]` + grep/sed 续读提示；原文落盘，`tool_history_get` 可翻页；模型自己给的分页提示原样保留。
4. **历史滑动窗口** —— 最近 6 轮原样保留，切点只在用户消息上；窗口外攒够 3 轮或上下文占用 ≥ 60% 就压，被压区间须 ≥ 3k tokens（压了不省就别压）。

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
- **测试**：`npm test` → **1026 项**（含跨平台过滤），覆盖 Host 域、RPC 路由、会话读写、Git、插件沙箱、Agent 阀门与 UI 纯逻辑。
- **冒烟**：Host RPC、事件重放、Extension UI Bridge、packaged 产物（standalone server / 浏览器 bridge / 子 Agent 事件代理 / 舰队面板）。
- **边界校验**：`check:sdk-imports`（SDK 收口）、`check:electron-deps`、`check:pi-updates`。

## 🗂 目录结构

```text
agent-host/    Agent Host：SDK 适配器、会话/工具、LTM、受管进程、插件沙箱、编排 Worker、Agent 阀门
contract/      Host ↔ Next ↔ Renderer 的 RPC 方法与域类型（单一事实来源）
app/           Next.js 页面与 API 路由（sessions / agent / fleet / files / git / processes）
components/    三栏工作台、悬浮文件窗、Markdown、输入框、设置面板、Agents / 编排 / 插件面板
hooks/         Agent 会话、事件流、草稿、面板与配置热重载
lib/           RPC 客户端、会话读写、模型路由、Git、Token/Agent 纯逻辑（不持有会话状态）
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
