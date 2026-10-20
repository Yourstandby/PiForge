# PiForge 架构契约

> 本文档是 PiForge 的**边界契约**，不是功能说明书。
> 与 `AGENTS.md` 冲突时以 `AGENTS.md` 的铁律为准；本文档负责解释“为什么这样划边界”。
> 项目：PiForge — Pi Coding Agent 的极简 Windows 桌面工作台
> 当前版本：v0.5.0（已打包、已打 tag，未推送未发 Release）

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

## 7. 与对标项目的取舍

| 项目 | 学 | 不学 | 原因 |
|---|---|---|---|
| DLYZZT/pi-desktop | 三进程架构、类型化 IPC、受管进程语义、浏览器分权、大结果持久化、PowerShell 原生、自动更新与发布管线 | 消息渠道、Herdr 集成、macOS/Linux 打包矩阵、扩展生态 | 功能密度太高，违反极简定位 |
| Chasen-Liao/pi-agent-desktop | Extension UI Bridge、Agent 安全模式、消息队列、会话加载重试、项目信任握手、分支导航 | 38 条 REST 路由、SSE over HTTP、`globalThis.__piSessions`、LTM SQLite、Worktree 克隆、三平台打包 | 其通信模型与"零内部端口"铁律冲突；LTM/Worktree 过重 |

**原则**：学设计、重实现，不搬运代码（上游 Apache-2.0/MIT，与本项目许可证不同）。尤其不要照搬 Chasen 的 `app/api/` REST 路由形态。

## 8. 给新会话的一句话

读 `AGENTS.md` 确认铁律，读本文档确认边界，然后从阶段八第 1 步开始，每步单独 commit 后停下汇报。不要读聊天历史，不要 grep 全仓库，不要凭记忆写 Next.js 代码。
