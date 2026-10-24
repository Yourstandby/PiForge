<div align="center">

<img src="./public/logo.svg" width="92" alt="PiForge" />

# PiForge

**把 Pi Coding Agent 装进一张安静的三栏工作台**<br />
*A local-first desktop workbench for the Pi coding agent — multi-session, multi-agent, cache-aware.*

Windows-first · Local-first · Electron + Next.js 静态导出 + Agent Host · 零内部端口 · MIT

[架构](./docs/ARCHITECTURE.md) · [发布记录](./docs/releases) · [实测数据](./docs/measurements) · [变更日志](./CHANGELOG.md)

</div>

---

PiForge 不是「聊天框套壳」。左栏是项目与会话，中栏是多标签对话，右栏常驻文件树 / 内置浏览器 / 终端 / Git / Agents / 编排 / 插件面板。主 Agent 改代码的同时可以派子 Agent 去调研、让常驻舰队 Agent 盯审计——互不干扰，全部在本机。

底层复用官方 [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi-coding-agent)（锁定 `1.4.0`）。**不 fork SDK、不在中间加代理层**：整个 Pi 只经过 `agent-host/sdk-adapter.ts` 一个文件，`npm run check:sdk-imports` 在 CI 里强制这条边界。

## 它长什么样

[![PiForge 主界面](./docs/assets/generated/poster-light@2x.png)](./docs/assets/generated/demo.mp4)

## 能力

| | 能力 | 一句话 |
| --- | --- | --- |
| 🩺 | **无进展看门狗** | 程序层盯「有效进展」，卡住亮灯；**零 Token**、零 prompt 注入 |
| 🖐 | **人工介入** | Skip / 极简询问 / 深度诊断，复用手边已有的队列通路 |
| 🧠 | **上下文可视化与压缩** | 上下文环 + 四段式摘要，切点永远落在用户轮次上 |
| 🤖 | **子 Agent / 常驻舰队** | 一次性 `spawn_agent` 与可反复下发的 `herdr_*`，各自独立上下文 |
| ⚡ | **启动与内存** | 静态导出替代 Next 运行时、Host 传输层可切、V8 堆按传输层分档 |
| 💰 | **Token 账本** | 成本结构可审计（`audit:token`），优化全部以实测为准 |
| 🧱 | **三进程隔离** | Agent 只住 Host，Next 只做 UI 与转发，零内部端口 |
| 🌙 | **夜晚模式** | 跟随系统 / 浅色 / 深色，令牌化主题，首屏无闪烁 |

调用压缩（0.9.4 起默认）：codemode 默认开启且为 `only`——普通工具不再逐条声明给模型，改由一次脚本批量调用；提示词内置批量与调用预算。不想用可关，工具恢复直呼（见[设置](#设置与开关)）。

## 架构：三进程、一条管道、零内部端口

```text
Electron Main ──协议处理──▶ piforge://app（静态导出，无 Next 运行时）
      │                          │
      │                          └──/api/** 走命名管道──▶ Agent Host（Pi SDK + 工具 + 受管进程）
      │                                                        │
      ├──spawn（默认 node / 可切 utilityProcess）──▶ Agent Host ──┼──WebSocket（自动端口，仅插件/流式总线）
      │                                                        └──独立 OS Worker ──▶ 每个 Worker 独占 Git worktree
      └──bounds 上报──▶ Main 持有的 WebContentsView（内置浏览器）
```

三条不能破的边界（评审与 CI 都查）：

1. **Agent 只住在 Host**：SDK / AgentSession / 工具执行 / 受管进程 / LTM 全在 `agent-host/`，Next 不持有任何会话状态。
2. **只走命名管道 / Unix Socket**：不做 localhost TCP。Next 重启不会杀掉正在流式输出的 Agent，重连按 `seq` 续传。
3. **文件先授权再 IO**：`/api/files`、git、statusline、processes 都必须先过 Host 的 `files.authorize`，白名单只在 Host。

### Host 启动方式

| 传输层 | 启动方式 | V8 堆 | 默认 |
| --- | --- | --- | --- |
| `node` | `process.execPath` + `ELECTRON_RUN_AS_NODE=1` | `NODE_OPTIONS`：新生代 4 + 老生代 192 | ✅ |
| `utility` | `utilityProcess.fork()` | `--js-flags=--max-old-space-size=256` | `PIFORGE_HOST_TRANSPORT=utility` 回退 |

三条硬规则（踩过坑，别改）：`ELECTRON_RUN_AS_NODE` 只进 Host 子进程 env，绝不写进 `process.env`；受管进程必须剔除它（`agent-host/child-env.ts`）；stdin 控制通道要显式 `PIFORGE_HOST_STDIN_CONTROL=1` 开启，不靠「stdin 不是 TTY」去猜。

## 快速开始

需要 **Node.js 20+ / npm 10+**（主要目标平台 Windows 10/11，Linux / macOS 走 CI 验证）。

```bash
git clone https://github.com/Yourstandby/PiForge.git
cd PiForge
npm install

npm run dev:electron   # 桌面窗口（推荐）
npm run dev            # 浏览器开发模式 → http://localhost:30141（仅开发期有端口）
```

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev:electron` | 编译 Host / Electron 主进程并打开桌面窗口 |
| `npm run dev` | 编译 Agent Host + 启动 Next dev（**仅开发期**用 30141） |
| `npm run pack` | 产出 `release/win-unpacked`（无签名 / 受限环境用，含打包冒烟） |
| `npm run dist` | NSIS 安装包 + ZIP + `latest.yml` |
| `npm run dist:mac` / `pack:mac` | macOS universal dmg/zip / 免安装目录 |
| `npx tsc --noEmit` · `npm run lint` · `npm test` | 类型检查 · ESLint · 单元与路由测试 |
| `npm run smoke:agent-host` | Host RPC / 受管进程 / 会话 / 看门狗 / 介入拒绝路径 |
| `npm run smoke:agent-isolation` | 客户端断连后 Host 继续流式输出、重连续传 |
| `npm run smoke:host-reconnect` | Next 断线重连与事件重放 |
| `npm run smoke:extension-ui` | Extension UI Bridge `confirm` 往返（Host 不挂起） |
| `npm run smoke:shell` | 静态导出新鲜度 + 打包顺序 |
| `npm run smoke:prefix-budget` | 前缀预算护栏 |
| `npm run measure:packaged` · `soak:host-heap` | 打包版内存/CPU/端口实测（含门禁） · 30 轮 soak |

数字不放 README 正文：每个指标都有对应命令与存档，见 [`docs/measurements`](./docs/measurements) 与 [`docs/optimizations`](./docs/optimizations)。**提数字之前先给命令**。

## 设置与开关

- **Codemode**：扩展与 MCP → Codemode。关闭 = 工具恢复直呼（脚本仍可用）；「照常声明工具」= `codemodeMode: "on"`。
- **思考等级**：常规设置 → 默认思考等级。首次启动只在该键缺失时写一次 `defaultThinkingLevel: "low"`。
- **夜晚模式**：跟随系统 / 浅色 / 深色，写 `localStorage["pi-theme"]`，`app/globals.css` 的 `:root[data-theme="dark"]` 提供令牌。新组件一律用令牌，禁止写深色字面量。
- **实验开关**（默认关闭，默认行为不变）：`PIFORGE_HOST_TRANSPORT` / `PIFORGE_HOST_HEAP` / `PIFORGE_USE_NEXT` / `PIFORGE_SUBAGENT_MAX_TURNS`，见 [`docs/optimizations`](./docs/optimizations)。

## 目录结构

```text
agent-host/        Agent Host：Pi SDK 适配、RPC、工具、受管进程、LTM、扩展（唯一能碰 Pi 的地方）
contract/          Host ↔ Next 的事件与命令契约（events.ts / commands.ts）
app/               Next.js App Router：UI 与 /api/**（全部转发给 Host）
components/        三栏界面：SessionSidebar / ChatSurface / Transcript / Composer / FilePanel / TitleBar
lib/               设置、主题、文件策略、会话路径、git worktree 等纯逻辑 + 单测
electron/          主进程、preload bridge、startup 页
scripts/           构建、打包、冒烟与实测脚本（smoke-* / measure-* / audit-*）
docs/              架构、优化与实测记录、发布说明；docs/releases/vX.Y.Z.md 由 CI 用来发 Release
```

## 质量与验证

改完必须跑：`npx tsc --noEmit`（大仓库需 `NODE_OPTIONS=--max-old-space-size=6144`，否则 OOM）、`npm run lint`、`npm test`。

CI 四条线（`.github/workflows/`）：

- `ci.yml`：lint · typecheck · test、token guards、Next 构建、Windows 专用测试；**纯文档改动（`**.md` / `docs/**`）不触发**。
- `desktop-packages.yml`：push `v*` tag 触发，三平台并行 `dist`（含打包内冒烟）→ 统一发布 12 个资产 + `SHA256SUMS.txt`。`workflow_dispatch` 可预演。
- 打包冒烟分三层：`smoke-packaged-layout`（布局/体积）、`smoke-packaged-static`（渲染进程真的挂上 Workbench）、`smoke-packaged-standalone`（打包后的 Agent Host + Extension UI Bridge 往返）。

发布流程见 [`docs/RELEASING.md`](./docs/RELEASING.md)；分支保护：`main` 只接受 PR 合并。

## 文档索引

| 主题 | 位置 |
| --- | --- |
| 架构与边界 | [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) |
| 发布流程 | [`docs/RELEASING.md`](./docs/RELEASING.md) |
| 各版本逐条变更 | [`CHANGELOG.md`](./CHANGELOG.md) / [`docs/releases`](./docs/releases) |
| 内存 / CPU / 启动 / Token 实测 | [`docs/measurements`](./docs/measurements) · [`docs/optimizations`](./docs/optimizations) |
| UI 设计规范 | [`docs/ui-design-spec.md`](./docs/ui-design-spec.md) |
| 开发铁律（改代码前必读） | [`AGENTS.md`](./AGENTS.md) |

## 参与贡献

欢迎轻量、聚焦、可验证的 Issue 与 PR。提交前读 [`CONTRIBUTING.md`](./CONTRIBUTING.md)，并遵守 [`AGENTS.md`](./AGENTS.md)：不做过度封装、不破坏三进程边界、改完跑通类型检查 / lint / 测试。

## 致谢与协议

PiForge 在 [Chasen-Liao/pi-agent-desktop](https://github.com/Chasen-Liao/pi-agent-desktop)（MIT）与 [DLYZZT/pi-desktop](https://github.com/DLYZZT/pi-desktop) 的设计思路上重写实现，向上游 [Pi coding agent](https://github.com/badlogic/pi-mono) 致敬。**学设计、重实现，不搬运代码。**

以 **MIT License** 发布，详见 [`LICENSE`](./LICENSE)。
