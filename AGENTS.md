# PiForge - Development Notes

PiForge 是 Pi Coding Agent 的 Windows 桌面端，衍生自
[Chasen-Liao/pi-agent-desktop](https://github.com/Chasen-Liao/pi-agent-desktop)（MIT）。

## 🚨 最高优先级：架构与 UI 铁律

每次修改代码前，必须熟读并严格遵守以下规则：

### 1. 架构铁律
- **拒绝过度封装**：直接复用官方 `@earendil-works/pi-coding-agent`，不要在 Electron 中间加额外的网络层或代理。
- **性能优化**：流式渲染、增量加载历史会话（首屏 20 轮）、工具输出大段文本需懒加载（Lazy Render）。
- **批处理**：引导模型合并工具调用，减少往返。

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

- **开发（浏览器）**：`npm run dev`（端口 30141）
- **开发（桌面端）**：`npm run dev:electron`（已绕过 path.txt 加密报错）
- **打包**：`npm run dist`（生成 NSIS 安装包）
- **类型检查**：`npx tsc --noEmit`
- **Lint**：`npm run lint`

## Key Traps (踩坑记录)

1. **Fork 预注册顺序**：`send("fork")` 创建新文件，`startRpcSession` 预注册，再 `destroy` 旧 wrapper。
2. **ToolCall 字段归一化**：SDK 存 `{id, name, arguments}`，前端用 `{toolCallId, toolName, input}`。使用 `normalizeToolCalls()` 进行转换。
3. **模型列表**：`createPiRuntime` 必须走 `createAgentSessionServices`，否则扩展模型会消失。
4. **打包配置**：`node_modules` 必须放在 extraResources；前端依赖放 devDependencies。

## globalThis 状态（HMR 安全，必须挂全局）
*(保持原样，防止热更新丢失状态)*
- `__piSessions`：活跃会话表
- `__piSessionPathCacheState`：路径缓存
- `__piStartLocks` / `__piWriteLocks`：并发锁
- `__piAllowedRootsCache`：文件白名单
- `__piLtmService`：LTM 单例

---

## 外部参考与指令

- **MCP 工具**：如果 `.codegraph/` 存在，优先用 `codegraph_explore` 查代码，少用 `grep`。
- **Next.js 提示**：不要凭记忆写 Next.js 代码，版本有 breaking changes，必要时查 `node_modules/next/dist/docs/`。

<!-- 本文件由人类维护，AI 修改代码前必须重新阅读本文件。 -->