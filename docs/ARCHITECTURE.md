# PiForge 架构契约

> 本文档是 PiForge 的**边界契约**，不是功能说明书。
> 与 `AGENTS.md` 冲突时以 `AGENTS.md` 的铁律为准；本文档负责解释“为什么这样划边界”。
> 项目：PiForge — Pi Coding Agent 的极简 Windows 桌面工作台
> 当前版本：v0.5.0（阶段八已完成：自动更新、发布管线、PowerShell、Sub-Agent 验证、会话韧性、Extension UI Bridge 冒烟）

---

## 1. 三进程边界

```text
┌─────────────────┐   preload bridge    ┌─────────────────┐   命名管道 / Socket    ┌─────────────────┐
│  Renderer       │ ◀─────────────────▶ │  Electron Main  │ ◀────────────────────▶ │  Agent Host     │
│  (Next.js UI)   │   类型化 RPC 契约    │  窗口/托盘/更新  │   类型化 RPC 契约       │  SDK/工具/进程   │
└─────────────────┘                     └─────────────────┘                        └─────────────────┘
```

| 进程 | 职责 | 禁止 |
|---|---|---|
| Renderer（Next.js） | UI 渲染、用户交互、通过 preload bridge 发 RPC | 禁止直接 import Pi SDK；禁止 spawn 进程；禁止读写 `~/.pi/agent/`；禁止维护 pending 队列 |
| Electron Main | 窗口、托盘、自动更新、生命周期、原生对话框 | 禁止承载业务逻辑；禁止直接调 Pi SDK；禁止绕过 Host 读写会话文件 |
| Agent Host | AgentSession、工具执行、受管进程、LTM、文件授权、Extension UI Bridge、Sub-Agent | 禁止渲染 UI；禁止依赖 Next 运行时 |

**铁律**：业务逻辑全部下沉到 Agent Host。Next 只做代理和 UI 渲染。Electron Main 只管窗口/托盘/更新。

## 2. 通信契约

- **Renderer ↔ Main**：`preload.ts` 通过 `contextBridge` 暴露类型化 API，禁止 `nodeIntegration`，禁止 `remote`。
- **Main ↔ Host**：命名管道（Windows）/ Unix Socket（POSIX），零 localhost TCP 服务。
- **Next ↔ Host**：Next 作为 Host 的 RPC 客户端，不直连 SDK；流式事件带单调 `seq`，断线重连从 `lastDeliveredSeq+1` 重放（经命名管道，非 HTTP SSE）。
- **文件授权**：Next 的 `/api/files`、`file-index`、`git`、`statusline`、`processes` 必须先调 Host `files.authorize`；Next 不维护 allowed-roots。
- **Extension UI Bridge**：Extension 的 `confirm`/`select`/`input`/`editor`/`notify` 由 Host 分配 UUID + Deferred Promise，Renderer 通过 preload bridge 回传结果。禁止在 Next 侧维护 pending 队列，禁止为此新增 HTTP 路由。

## 3. 目录职责

```text
PiForge/
├── agent-host/          ★ 独占：Pi SDK / AgentSession / 工具执行 / 受管进程 / LTM / Sub-Agent
│   ├── process-*.ts       受管进程状态机与清理
│   ├── tool-outputs.ts    大工具输出落盘
│   ├── session-branches.ts 会话分支
│   ├── subagents.ts       Sub-Agent 隔离
│   └── ...
├── electron/            Electron Main：窗口 / 托盘 / 更新 / preload
├── app/                 Next.js：API 代理层 + UI 入口
├── components/          Renderer 组件（极简、克制）
├── hooks/               前端 hooks（不承载业务逻辑）
├── lib/                 Next 侧共享库（RPC 客户端、normalize、i18n）
└── docs/                本文档 + 阶段八设计
```

**边界规则**：

- `agent-host/` 可以 import `lib/` 的纯函数，反向禁止。
- `app/api/*` 只做参数校验 + 调 Host RPC + 返回，不写业务逻辑。
- `components/` 只通过 `hooks/` 和 preload bridge 拿数据，不直接 fetch Host。

## 4. 状态归属

| 状态 | 归属 | 理由 |
|---|---|---|
| AgentSession / 工具执行 / 受管进程 | Host 单例 | 生命周期与 SDK 绑定 |
| LTM 数据库 | Host 单例（`__piforgeLtmService`） | 单进程独占，避免跨进程锁 |
| 会话文件写入锁 | Host（`__piforgeWriteLocks`） | 写入只发生在 Host |
| Next↔Host 客户端 | Next `globalThis.__piforgeAgentHostClient` | HMR 安全 |
| 会话路径缓存 | Next `globalThis.__piforgeSessionPathCacheState` | HMR 安全，只读缓存 |
| UI 状态（选中会话、面板宽度） | Renderer 本地 state | 不跨进程 |

**禁止**：Next 侧出现 `__piSessions`、`__piAllowedRootsCache`、`__piLtmService` 等旧全局；Host 侧禁止持有 UI 状态。

## 5. v0.5.0 已完成能力的边界（一句话）

- **MCP 高级管理**：连接/OAuth/资源读取全在 Host `mcp-service.ts`，Next 只代理。
- **生图/决策模型**：Host `aux-models.ts`，未配置不进工具列表。
- **浏览器分权 + 环境检测**：Host `browser-permissions.ts` + `dev-tools.ts`，会话级临时授权。
- **大工具输出持久化**：Host `tool-outputs.ts`，>10KB/>2000 行落盘，路径白名单。
- **代码块应用 + 文件拖拽**：Host `files.applyCode` 原子写入。
- **树状分支对话**：复用 Pi 原生 `parentId` 树，Host `session-branches.ts`。
- **Sub-Agent 并行**：Host `subagents.ts`，`SessionManager.inMemory` 隔离，最多 4 并发，15 分钟超时。
- **受管进程生命周期治理**：Host `process-*.ts`，状态机 + 有界清理 + crash reaper，不是安全沙箱。

## 6. 阶段八的架构影响

| 步骤 | 落在哪 | 约束 |
|---|---|---|
| 自动更新 | Electron Main | electron-updater，更新源固定，用户确认后下载 |
| 发布管线 | GitHub Actions | `v*` tag 触发，NSIS + ZIP + latest.yml + SHA-256 |
| PowerShell | Agent Host | pwsh 7 优先回退 5.1，与受管进程衔接 |
| Sub-Agent 验证护栏 | Host + Renderer | 无证据标 `verified: false`，UI 徽章，默认不强制 |
| 会话标题与搜索 | Host 生成 + Renderer 展示 | 后台生成、手动优先、搜索、按日期分组 |
| 文档与测试 | 全仓 | packaged smoke 含 Extension UI Bridge confirm 用例 |

### 6.1 阶段八完成后的固定契约

- **更新源**：`electron-builder.yml` 的 `publish` 固定为 GitHub Releases；更新检查只在打包产物且存在 `app-update.yml` 时启动，`electron/main.ts` 从不调用 `setFeedURL`。用户确认后才下载；`autoInstallOnAppQuit` 保证任务结束后退出安装。
- **发布产物**：`.github/workflows/desktop-packages.yml` 由 `v*` tag 或 `workflow_dispatch` 触发；Windows 必须同时产出 NSIS、ZIP、`latest.yml` 与 `SHA256SUMS.txt`，校验数量后再上传 Release。
- **PowerShell**：Host `powershell.ts` 解析 `pwsh` → `powershell`，固定非交互参数与 UTF-8 编码；前台 `powershell` 工具由 SDK 执行，后台 `run_bg shell:"powershell"` 进入受管进程状态机（readiness/stop/restart/清理一致）。仍是生命周期控制，不是沙箱。
- **Sub-Agent 验证**：Host `subagent-verification.ts` 只扫描完成报告与工具调用，不重跑测试（子 Agent 只读）；`verified:false` 仅在 UI 与工具结果中提示，默认不阻断。
- **会话韧性**：标题只在首条用户消息后后台生成，`shouldAutoNameSession` 保证手动命名优先；搜索覆盖标题/首条消息/id；项目内按本地日历日期分组；`session-loader-api.ts` 提供 15s deadline + 单次重试（超时/网络/5xx）。
- **Extension UI Bridge**：Host 持有 UUID + Deferred Promise，Renderer 通过 preload 回传；`smoke-extension-ui-bridge.mjs` 在 packaged smoke 中触发真实 confirm，验证 Host 不挂起且响应能恢复扩展。

## 7. 阶段九：高级工作流与生态集成的三大架构豁免

> 以下三条是 v0.6.0 的**硬边界**，不是建议。违反其中任何一条，相关 PR 不得合并。

- **浏览器边界（WebContentsView 归 Main）**：共享浏览器实例只能由 **Electron Main** 创建和持有；Next/Renderer 只提供 UI 占位、导航意图与只读状态展示，**绝对禁止**在 Next 或 Renderer 内实例化 `WebContentsView`、`BrowserWindow`、`webview` 之外的浏览器内核。渲染与权限仍由 Main ↔ Host 的既有 IPC/RPC 契约驱动，不新增 localhost TCP。
- **Git 边界（worktree 归 Host）**：所有 `git worktree add/remove/list`、分支身份、ownership marker 与目标路径授权都必须封装在 **Agent Host** 的 `workspace-clone.ts`；Next 只发 RPC 并渲染结果，不得直接调用 `git`、不得直接读写 `.git` 或 worktree 目录。
- **Herdr 边界（舰队归受管进程状态机）**：Agent 舰队的 spawn、停止、重启、readiness、日志与清理必须复用 `agent-host/managed-processes.ts` 的受管进程状态机；UI 只读展示。禁止绕过状态机直接 `spawn` 长驻进程，禁止在 Next/Renderer 侧维护进程表。

## 8. 与对标项目的取舍

| 项目 | 学 | 不学 | 原因 |
|---|---|---|---|
| DLYZZT/pi-desktop | 三进程架构、类型化 IPC、受管进程语义、浏览器分权、大结果持久化、PowerShell 原生、自动更新与发布管线 | 消息渠道、Herdr 集成、macOS/Linux 打包矩阵、扩展生态 | 功能密度太高，违反极简定位 |
| Chasen-Liao/pi-agent-desktop | Extension UI Bridge、Agent 安全模式、消息队列、会话加载重试、项目信任握手、分支导航 | 38 条 REST 路由、SSE over HTTP、`globalThis.__piSessions`、LTM SQLite、Worktree 克隆、三平台打包 | 其通信模型与"零内部端口"铁律冲突；LTM/Worktree 过重 |

**原则**：学设计、重实现，不搬运代码（上游 Apache-2.0/MIT，与本项目许可证不同）。尤其不要照搬 Chasen 的 `app/api/` REST 路由形态。

## 9. 给新会话的一句话

读 `AGENTS.md` 确认铁律，读本文档确认边界，然后从当前未完成阶段继续，每步单独 commit 后停下汇报。不要读聊天历史，不要 grep 全仓库，不要凭记忆写 Next.js 代码。
