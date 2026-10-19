# PiForge - Development Notes

PiForge 是 Pi Coding Agent 的 Windows 桌面端，衍生自
[Chasen-Liao/pi-agent-desktop](https://github.com/Chasen-Liao/pi-agent-desktop)（MIT）。
上游功能与架构保持不变，PiForge 只做品牌化、构建目标收敛和一套蓝色主题。

## PiForge 约定

- **品牌**：`package.json` name = `piforge`，productName = `PiForge`，
  appId = `com.piforge.desktop`。用户可见的窗口标题、托盘提示、启动页文案统一为 PiForge。
  安装器仍会关闭 `Pi Agent Desktop.exe` 等旧进程名，方便覆盖安装。
- **图标**：`node scripts/build-brand-icons.mjs` 从内嵌 SVG 重新生成
  `build/icon.{ico,icns,png}`、`build/tray-icon.ico`、`public/logo.png`、`app/favicon.ico`。
- **构建**：`npm run dev`（浏览器）/ `npm run dist`（NSIS 安装包）。开发时不要直接
  `next build`，会污染 `.next/`。
- **多项目窗口**：单进程只跑一个 Next 服务，所有窗口共享；主窗口关闭时隐藏到托盘，
  项目窗口正常关闭。入口：工作台菜单「新建窗口」、`Ctrl+Shift+N`、侧边栏项目行的
  窗口按钮。新窗口通过 `/?cwd=<path>` 直接进入该项目的空白会话。
- **PNG 资产**：应用内 logo 用 `components/BrandLogo.tsx` 内联 SVG；`build/icon.png`
  由 `npm run icons` 生成但不入库（部分 Windows DLP 会透明加密大 PNG）。

## 主题系统（light / dark / glacier）

- 状态：`hooks/useTheme.ts`，纯逻辑在 `lib/theme.ts`，localStorage key 为 `pi-theme`。
- token：`app/globals.css`。`html.dark.theme-glacier` 在 dark 之上覆盖调色板，
  冰川蓝主题保留 `dark` class，因此所有暗色分支（语法高亮、窗口控件）继续生效。
- 入口：工作台菜单（`components/AppShell.tsx`）三选一；`Ctrl+Shift+T` 按
  light → dark → glacier 循环。
- Electron 标题栏：`electron/title-bar-overlay.ts` 按主题名取色，preload 发送主题名。

---

# Upstream notes (pi-agent-desktop)

## Quick Start

```bash
npm run dev          # Web dev server (port 30141)
npm run dev:electron # Electron desktop (dev mode)
npm run dist         # Package: NSIS (Win) / DMG+ZIP (macOS) / DEB (Linux)
npm run dist:mac     # Universal macOS (Intel + Apple Silicon)
```

Typecheck: `npx tsc --noEmit` | Lint: `npm run lint`
Test: `npm test`（含 `middleware.test.ts`；不要去掉 `--test-force-exit`）
Subsets: `npm run test:windows` / `npm run test:macos`
**Never run `next build` during dev** — 污染 `.next/` 并破坏 `npm run dev`。

Release: 按 [docs/RELEASING.md](docs/RELEASING.md)，推 `vX.Y.Z` tag → CI 打包；不用 `npm run release`。
Branch: `dev/`（日常）/ `future/`（大功能），默认 merge commit，见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## CodeGraph MCP

`.codegraph/` 存在时，优先用这些工具代替 grep/find：

- **`codegraph_explore`** — 自然语言查询，返回源码 + 调用链（**首选**）
- **`codegraph_node`** — 文件读取（替代 view_file）或单符号深度查询
- **`codegraph_search`** — 快速符号名 → 位置查找

初始化：`codegraph init`（用户决策，勿自动执行）。

---

## Architecture

> 📖 详细架构文档：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

**双模式**

- **Web**：浏览器 ──HTTP/SSE──▶ Next.js(:30141) ──进程内──▶ AgentSession
- **Desktop**：Electron 主进程托管 Next.js standalone `server.js`（macOS: `utilityProcess`；Win/Linux: `ELECTRON_RUN_AS_NODE=1`）

**关键入口**

| 功能 | 路径 |
| --- | --- |
| 发送消息 | `POST /api/agent/[id]` → `startRpcSession()` → `AgentSessionWrapper` |
| 模型 / 认证 | `createPiRuntime()` → `createAgentSessionServices`（含扩展注册的 provider） |
| 历史浏览 | `GET /api/sessions/*` → `session-reader.ts`（只读，不建 Session） |
| 会话克隆 | `POST /api/sessions/[id]/clone` → 普通目录或 Git Worktree |
| SSE 流 | `GET /api/agent/[id]/events`（30s 心跳） |
| UI 主入口 | `page.tsx` → `AppShell` → `ChatWindow` → `useAgentSession` |
| LTM | `lib/ltm` · `/api/memory/*` · tools: `memory_save/recall/forget` |
| 运行中消息 | Enter=立即 steer，Alt+Enter=Follow-up Queue（可重排） |

**顶层目录**

| 目录 | 内容 |
| --- | --- |
| `app/api/` | 39 条 API 路由 |
| `lib/` | `rpc-manager` / `session-reader` / `session-branch-clone` / `git-worktree` / `ltm` / `i18n` 等服务端库 |
| `components/` | 29 个顶层组件 + 3 个子目录（`chat-input` / `models-config` / `session-sidebar`） |
| `hooks/` | 8 个顶层 hook + `agent-session/` 15 个模块 |
| `electron/` | `main.ts` + `preload.ts` + `tray.ts` + 13 个辅助模块 |
| `bin/pi-web.js` | CLI 入口 |

---

## globalThis 状态（HMR 安全，必须挂全局）

| 变量 | 用途 | 来源文件 |
| --- | --- | --- |
| `__piSessions` | `Map<sessionId, AgentSessionWrapper>` 活跃会话表 | `rpc-manager.ts` |
| `__piSessionPathCacheState` | sessionId → .jsonl 路径缓存状态 | `session-reader.ts` |
| `__piStartLocks` | 并发启动共享 Promise 锁 | `rpc-manager.ts` |
| `__piWriteLocks` | per-file 写入锁 | `session-lock.ts` |
| `__piAllowedRootsCache` | 文件访问白名单（5s TTL） | `allowed-roots.ts` |
| `__piLtmService` | LTM `MemoryService` 单例 | `ltm/service.ts` |
| `__piSessionOnlyTrust` | per-session 信任状态 | `rpc-manager.ts` |
| `__piGitWorktreeLocks` | Worktree 创建/清理并发锁 | `git-worktree.ts` |
| `__piLoginCallbacks` | OAuth 手动输入回调注册表 | `auth/login/[provider]/route.ts` |
| `__piUpstreamUsageCache` | 上游配额查询缓存（120s TTL） | `lib/upstream-usage/service.ts` |

---

## Key Traps

> 完整列表见 [ARCHITECTURE.md §14](docs/ARCHITECTURE.md#14-关键设计决策与陷阱)

### 1. Fork 预注册顺序

`send("fork")` → 创建新 `.jsonl` → `startRpcSession(newId)` 预注册 → `destroy()` 旧 wrapper。中途出错旧 wrapper **保持可用**；孤儿 `.jsonl` 删除与路径缓存失效是 **best-effort**（失败不阻断，随后 rethrow）。

### 2. 分支与工作区别混淆

- **Fork**（消息 Fork 按钮）→ 新 `.jsonl` + 侧边栏子节点
- **会话内分支**（Continue / BranchNavigator）→ 同文件 `navigate_tree`，切换用 `?leafId=`
- **Git Worktree Clone** → 在源 Git 仓库外创建新 worktree 和分支后再 Clone 会话；目标、分支与 worktree 身份无法证明时 fail closed

### 3. ToolCall 字段归一化

SDK 存 `{id, name, arguments}`，前端用 `{toolCallId, toolName, input}`。`normalizeToolCalls()` 在文件加载和 SSE 流两处都转换。

### 3b. 模型列表不要退回 ModelRuntime.create-only

`createPiRuntime` 必须再走 `createAgentSessionServices`，否则扩展注册的模型从选择器消失。详见 [ARCHITECTURE.md §14.17](docs/ARCHITECTURE.md#1417-模型列表必须走-createagentsessionservices2026-09-08-34)。

### 4–6. 打包陷阱（摘要）

- `node_modules` 须独立 extraResources 条目（`filter:["**/*"]` 静默排除它）
- Frontend 依赖放 `devDependencies`；`outputFileTracingExcludes` 排除 `release/`/`.git/`/`dist/`/`*.test.*`
- `build:standalone` 须补齐 Next turbo runtime；macOS Universal 须双架构 Sharp

---

## Misc

**Session 文件**：`~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`（详见 [ARCHITECTURE.md §9](docs/ARCHITECTURE.md#9-pi-会话文件格式)）。`SessionContext.entryIds[]` 与 `messages[]` 一一对应，用于 fork 和 navigate_tree。

**CSS 变量**：完整变量表见 [`app/globals.css`](app/globals.css)，含 `material-*` / `shadow-*` / `duration-*` / `ease-*` / `toast-*` / `think-*` 等动画 token 体系。

**UI 文案**：走 `lib/i18n`（`en` / `zh-CN`）。改文案须同步 `lib/i18n/dictionaries.ts` 双语，不硬编码。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
