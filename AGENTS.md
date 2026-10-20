# PiForge - Development Notes

PiForge 是 Pi Coding Agent 的 Windows 桌面端，衍生自
[Chasen-Liao/pi-agent-desktop](https://github.com/Chasen-Liao/pi-agent-desktop)（MIT）。

## 🚨 最高优先级：架构与 UI 铁律

每次修改代码前，必须熟读并严格遵守以下规则：

### 1. 架构铁律
- **拒绝过度封装**：直接复用官方 `@earendil-works/pi-coding-agent`，不要在 Electron 中间加额外的网络层或代理。
- **性能优化**：流式渲染、增量加载历史会话（首屏 20 轮）、工具输出大段文本需懒加载（Lazy Render）。
- **批处理**：引导模型合并工具调用，减少往返。
- **Agent Host 隔离（v0.4.0）**：Pi SDK / AgentSession / 工具执行 / 受管进程 / LTM 只允许运行在 `agent-host/`。Next 侧禁止直接导入会话 API、禁止 spawn 受管进程、禁止直接读写 LTM 数据库。
- **文件授权铁律**：Next 的 `/api/files`、file-index、git、statusline、processes 必须先调用 Host `files.authorize`；Next 不维护 allowed-roots。
- **零内部端口**：Host 与 Next 只走命名管道 / Unix Socket，不新增 localhost TCP 服务。

### 2. UI 铁律（改前端前必看）
- **左栏（SessionSidebar）**：宽度固定 `260px`，背景 `#F5F5F7`。禁止内嵌文件树或重复按钮。
- **会话列表**：单行截断（`truncate`），字号 `13px`，颜色 `#374151`。选中项为浅蓝底（`#E8EFFB`）+ 蓝字（`#2563EB`）。
- **项目标题**：加粗，`12px`，`#6B7280`，与子项有明显缩进。
- **全局主题**：浅色霜蓝主题，主区背景 `#FCFCFA`，卡片/输入框纯白带柔和阴影。禁止引入深色样式。

### 3. AI 行为准则（防暴走）
- **拒绝过度思考**：不要长篇大论写规划报告，直接看代码、写代码。
- **禁止乱删文件**：清理死代码前必须确认无引用，禁止破坏核心业务逻辑。
- **验证闭环**：改完必须运行 `npx tsc --noEmit` 和 `npm run lint`。

---

## 当前 UI 状态与目录结构

界面已稳定在三栏架构（`components/Workbench.tsx`）：

- **左栏**：`components/SessionSidebar.tsx`（包含搜索、项目分组、历史列表、设置齿轮）。
- **中栏**：`components/ChatSurface.tsx`（包含 `Transcript` 消息渲染、`Composer` 输入框、`StatusBar` 底部状态）。
- **右栏**：`components/FilePanel.tsx`（包含 `FileExplorer` 文件树、`FileViewer` 多标签页）。
- **顶栏**：`components/TitleBar.tsx`（支持 Electron 窗口拖拽）。

> 注：旧的 `MessageView` 等组件已被替代，新代码请统一使用 `Transcript.tsx` 和 `Composer.tsx`。

## 构建与运行

- **开发（浏览器）**：`npm run dev`（先编译并启动 Agent Host，再启动 Next.js，端口 30141）
- **开发（桌面端）**：`npm run dev:electron`（已绕过 path.txt 加密报错）
- **打包**：`npm run dist`（生成 NSIS 安装包）；无签名/受限环境用 `npm run pack` 只产出 win-unpacked
- **Host 冒烟**：`npm run smoke:agent-host` / `npm run smoke:agent-isolation` / `npm run smoke:host-reconnect`
- **类型检查**：`npx tsc --noEmit`
- **Lint**：`npm run lint`

## Key Traps (踩坑记录)

1. **Fork 预注册顺序**：`send("fork")` 创建新文件，`startRpcSession` 预注册，再 `destroy` 旧 wrapper。
2. **ToolCall 字段归一化**：SDK 存 `{id, name, arguments}`，前端用 `{toolCallId, toolName, input}`。使用 `normalizeToolCalls()` 进行转换。
3. **模型列表**：`createPiRuntime` 必须走 `createAgentSessionServices`，否则扩展模型会消失。
4. **打包配置**：`node_modules` 必须放在 extraResources；前端依赖放 devDependencies。
5. **Host ESM 打包**：`agent-host/dist` 复制到 `resources/standalone/agent-host/`，入口是稳定 wrapper + `{"type":"module"}`；Pi/pi-mcp/typebox 从共享的 `standalone/node_modules` 解析。
6. **SSE 断线续传**：agent 事件带单调 seq；Next 断开时 Host 保持会话，重连默认从 lastDeliveredSeq+1 重放；不要在 Next 维护事件队列。
7. **文件白名单**：Host 返回 realpath 后 Next 才做 IO；新会话 cwd 由 Host 在 agent.create/ensure 时注册，Next 不再有 allowed-roots 缓存。

## globalThis 状态

### Next 侧（HMR 安全，必须挂全局）
- `__piforgeAgentHostClient`：Next↔Host 单例客户端
- `__piforgeSessionPathCacheState`：session id → 文件路径缓存
- `__piforgeConfigWatcher` / `__piforgeFileIndexCache` / `__piforgeGitWorktreeLocks`
- `__piforgeUpstreamUsageCache` / `__piforgeLoginCallbacks` / `__piforgeFxRateCache`

### Agent Host 侧（单进程，无需 HMR）
- `__piforgeLtmService`：LTM sqlite 单例
- `__piforgeWriteLocks`：会话文件写入锁

> Next 侧禁止再出现 `__piSessions`、`__piStartLocks`、`__piAllowedRootsCache`、`__piLtmService` 等旧全局。

---

## 外部参考与指令

- **MCP 工具**：如果 `.codegraph/` 存在，优先用 `codegraph_explore` 查代码，少用 `grep`。
- **Next.js 提示**：不要凭记忆写 Next.js 代码，版本有 breaking changes，必要时查 `node_modules/next/dist/docs/`。

<!-- 本文件由人类维护，AI 修改代码前必须重新阅读本文件。 -->

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
