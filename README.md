<div align="center">

<img src="./public/logo.svg" width="96" alt="PiForge" />

# PiForge

**给 Pi Coding Agent 配一张安静的三栏工作台**
*Local-first desktop workbench for the Pi coding agent — multi-session, multi-agent, cache-aware.*

[![Release](https://img.shields.io/github/v/release/Yourstandby/PiForge?sort=semver)](https://github.com/Yourstandby/PiForge/releases)
[![CI](https://github.com/Yourstandby/PiForge/actions/workflows/ci.yml/badge.svg)](https://github.com/Yourstandby/PiForge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Pi Core](https://img.shields.io/badge/pi--coding--agent-1.6.0-111)](https://github.com/earendil-works/pi)

v0.12.2 · Windows / macOS / Linux · 内置 Pi Coding Agent，无需单独安装

</div>

---

## 这是什么

Agent 在终端里跑得很好，直到你同时开三个项目、想看清它到底烧了多少 token、想在中途叫停一次写操作，
或者想让它自己再拉两个子 Agent 去调研 —— 终端就开始捉襟见肘。

PiForge 把这一整套搬进一个原生窗口：

- **左栏**：按工作目录归组的项目与历史会话
- **中间**：多标签对话、实时流式、运行中队列
- **右栏**：文件树与查看器、内置浏览器、终端、Git、Agent 舰队、编排、插件

主 Agent 负责改代码，子 Agent 只读调研与审计，各自独立上下文。推理、文件读写、会话记录全部留在本机。

---

## 功能

### 会话与工作台

| 功能 | 说明 |
|---|---|
| **多标签对话** | 同一项目并发多条会话，标签可切换、可关闭、可恢复 |
| **项目归你管** | 项目按 CWD 自动归组，可重命名、可从侧栏移除 —— 只写本地偏好，不删会话、不碰目录 |
| **双轨分支** | 物理 Fork（独立会话文件）与会话内回退两条路径，配合分支导航器对比不同试错结果 |
| **会话导出** | 任意会话导出为 HTML 或 Markdown，便于归档与分享 |
| **右侧工作区** | 文件树 / 查看器、内置浏览器（含域名权限）、终端、Git 面板（worktree、branch clone）、舰队、编排、插件、MCP 资源 |
| **原生外壳** | 系统托盘常驻、关闭窗口先问（最小化到托盘 / 退出，可记住选择）、自动更新检查 |
| **外观与语言** | 浅色 / 深色 / Glacier 三套主题，中文 / English 界面（可跟随系统） |

### 上下文与成本

- **缓存友好的 plan 模式**：工具声明只由工具预设决定，计划段落以尾部 `display:false` 消息注入 ——
  在 plan 与执行模式之间来回切换，请求前缀字节不变，不会整段重发历史（v0.12.1）。
- **上下文可视化与压缩**：环形占用量提示 + 四段式摘要，压缩摘要固定中文、默认只接管正文。
- **Token 账本**：只累计真实 `usage`，按会话隔离；流式阶段没有数字就不显示数字。
  用量按 < 1000 精确、≥ 1000 一位小数缩写（`2.9K` / `69.8K`）。
- **无进展看门狗**：默认 90 秒无有效进展才亮红灯（预设 90 / 120 / 300 / 600 秒），长活不再被误杀。
- **可测的预算**：`npm run measure:prefix` / `measure:long-session` / `measure:increment`
  给出前缀命中率与单轮增量，数字归档在 `docs/measurements/`。

### 模式与安全边界

- **plan / ask / full 三模式**：plan 只能读，写操作在执行期被拒（理由 `Plan mode: planning only`）；
  ask 对敏感工具先弹确认；full 全速执行。模式随会话持久化。
- **工具预设**：`none` / `default` / `full` 三档，决定模型能看到哪些工具。
- **文件授权链路**：访问范围按授权根目录 + 路径策略校验，「文件不存在」与「越权」分开报。
- **codemode 默认 `only`**：脚本在沙箱 worker 里跑，不默认放开全部能力。
- **扩展 UI 原生桥**：扩展的 confirm / select / input / editor / notify 走原生弹窗，不退回终端。

### 多智能体

- **子 Agent**：`spawn_agent` 拉出独立上下文的只读调研者；结果带「有无测试/构建证据」标记，
  未验证的结果不会被当成已验证。
- **常驻舰队**：`herdr_*` 工具管理多个长期 Agent，各自会话、各自状态。
- **编排**：并行 worker 在独立 Git worktree 里干活，报告与改动文件回到主会话。
- **可观测**：运行中工具徽章、工具调用统计、流健康提示（重连与握手阶段分开表达）。

### 扩展生态

- **MCP**：全局 `~/.pi/agent/mcp.json` 与项目 `<cwd>/.pi/mcp.json` 两级配置，可视化增删与资源浏览。
- **Skills / Extensions / Plugins**：统一 UI 管理启用、诊断与安装。
- **模型与供应商**：多模型随时切换、辅助模型（小模型干杂活）、自动路由、自定义 OpenAI 兼容 provider。
- **Pi 核心可换**：三个 `@earendil-works/pi-*` 包精确锁定 1.6.0，界面内可查询与切换版本。

---

## 最新版本 v0.12.2

主题：**运行中不再看着像卡死，排队消息想改就改，计划不烂尾。**

- 跑工具时不再把对话历史抹成空白；真没历史时给「重新加载」并按 1.5s→6s 退避自动补取。
- 排队消息可**编辑**（保留附件与位置）、可**⚡ 立即发送**、可**⏫ 插到队首**。
- 计划停在半路不再消失：未完成就留着卡片，给「继续执行 / 放弃剩余」两个出口；
  完成态去掉删除线，已完成步折叠成一行。
- `mcp_servers` 段字节按签名锁存，MCP 连上后不再打破前缀缓存。
- 舰队 / 编排面板补 `AgentSpawnTrigger` 手动派生入口，不必等主 Agent 调工具。

完整变更：[CHANGELOG.md](./CHANGELOG.md) · [docs/releases/v0.12.2.md](./docs/releases/v0.12.2.md)

---

## 安装

从 [Releases](https://github.com/Yourstandby/PiForge/releases) 下载对应安装包：

| 平台 | 产物 | 首次运行 |
|---|---|---|
| Windows | `PiForge-Setup-x.y.z.exe` / `PiForge.zip` | SmartScreen 拦截时选「更多信息 → 仍要运行」 |
| macOS | `.dmg`（Universal，Intel + Apple Silicon） | 右键 →「打开」，或 `xattr -dr com.apple.quarantine /Applications/PiForge.app` |
| Linux | `.AppImage` / `.deb` | AppImage 直接运行；deb 未签名，需 `sudo dpkg -i` |

> 安装包尚未做代码签名，系统会拦截，属预期行为；请用上面的方式手动信任。

## 从源码运行

要求 **Node 24**（与 CI 同版本）与 npm，Windows / macOS / Linux 均可。

```bash
git clone git@github.com:Yourstandby/PiForge.git
cd PiForge
npm install

npm run dev            # 浏览器模式：http://localhost:30141
npm run dev:electron   # Electron 窗口
```

> `dev:electron` 加载的是 `out/` 下的静态导出。若 `out/` 落后于 `app/ components/ lib/ hooks/ public/`，
> 前置护栏会直接报错并提示先跑 `npm run build:static` —— 否则你会一直对着旧 UI 调试。
> 只想警告不拦：`PIFORGE_SKIP_STATIC_FRESHNESS=1`。

常用脚本：

| 脚本 | 用途 |
|---|---|
| `npm run dev` / `dev:electron` | 浏览器 / 桌面开发模式 |
| `npm run build:static` | Next 静态导出到 `out/` |
| `npm run build:agent-host` / `build:electron` | 编译 Host / 主进程 |
| `npm run dist` | 完整打包（静态导出 + Host + Electron + 安装包 + 冒烟） |
| `npm run lint` / `npm test` | 静态检查 / 单元测试 |
| `npm run smoke:agent-host` | Host 启动与 RPC 冒烟 |
| `npm run measure:prefix` | 前缀缓存命中率度量 |

---

## 架构

**三进程 + 单管道，无内部端口。**

<pre><code>
┌──────────────┐   preload RPC    ┌──────────────┐   命名管道    ┌────────────────┐
│  Renderer    │ ◀──────────────▶ │ Electron     │ ◀───────────▶ │  Agent Host    │
│  (Next.js)   │                  │ Main         │               │  Pi SDK / 工具  │
└──────────────┘                  └──────────────┘               └────────────────┘
       ▲                                  │
       └──── piforge://app（静态导出）──────┘
</code></pre>

| 进程 | 职责 | 禁止 |
|---|---|---|
| **Renderer**（Next.js） | UI 渲染、交互、通过 preload 桥发 RPC | 直接 import Pi SDK、spawn 进程、读写 `~/.pi/agent/` |
| **Electron Main** | 窗口、托盘、更新、`piforge://` 协议转发 | 承载业务逻辑、绕过 Host 读写会话 |
| **Agent Host** | AgentSession、工具执行、受管进程、LTM、文件授权、子 Agent、MCP | 渲染 UI、依赖 Next 运行时 |

- 打包后渲染进程加载 `piforge://app/` 静态资源，`/api/**` 由主进程经命名管道转给 Host ——
  没有 localhost 端口可连，CSP 也不需要为任何端口开口子。
- Host 默认以 `ELECTRON_RUN_AS_NODE` 子进程启动（`PIFORGE_HOST_TRANSPORT=utility` 可切 Electron UtilityProcess），
  堆上限、env 隔离与退出语义都有单测守着。
- 边界契约与演进理由见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

---

## 质量与验证

```bash
npm run lint     # eslint，0 error 为基线
npx tsc --noEmit # 类型检查
npm test         # node:test：lib / agent-host / electron / hooks / components / scripts
```

仓库里还有一组不靠人工盯的冒烟脚本：`smoke:static-fresh`、`smoke:packaged-static`、
`smoke:packaged-layout`、`smoke:agent-isolation`、`smoke:extension-ui`、`smoke:host-reconnect`；
启动耗时、进程内存、增量 token 都有对应度量脚本，历史数据在 `docs/measurements/`。

## 目录结构

| 目录 | 内容 |
|---|---|
| `app/` `components/` `hooks/` | Next.js 渲染层：三栏界面、对话、面板与设置 |
| `lib/` | 跨进程共享逻辑：模式与工具策略、路径授权、会话模型、格式化 |
| `agent-host/` | Agent Host：Pi SDK 适配、工具、MCP、子 Agent、LTM、看门狗 |
| `electron/` | 主进程：窗口、托盘、`piforge://` 协议、命名管道桥、更新 |
| `contract/` | 主进程 ↔ Host 的类型化协议 |
| `scripts/` | 构建、冒烟、度量、发布脚本 |
| `docs/` | 架构契约、发布说明、度量与研究记录 |
| `bench/` | 启动与资源基准 |

## 文档

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) —— 三进程边界与通信契约
- [CHANGELOG.md](./CHANGELOG.md) —— 逐版本「改了什么 / 默认行为变没变」
- [docs/releases/](./docs/releases) —— 各版本发布说明与安装提示
- [docs/measurements/](./docs/measurements) —— 前缀缓存、增量、启动与内存数据
- [CONTRIBUTING.md](./CONTRIBUTING.md) / [AGENTS.md](./AGENTS.md) —— 参与开发与给 Agent 的工程约定

## 许可证

MIT License，详见 [LICENSE](./LICENSE)。
