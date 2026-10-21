<div align="center">

<img src="./public/logo.svg" width="88" alt="PiForge" />

# PiForge

**插件化、可热插拔 Pi 核心的 Coding Agent 桌面端**<br />
*A plugin-extensible desktop workbench with a hot-swappable Pi core.*

Windows-first · Local-first · Electron + Next.js · MIT

</div>

---

PiForge 把 Pi Coding Agent 的会话、工具调用与项目文件收进一个安静的三栏工作台：左侧管理会话，中间用浏览器式多会话标签并行对话，右侧常驻文件树、内置浏览器、终端、Git、舰队、编排与插件面板。界面采用 **霜蓝 × 米白** 的浅色体系，强调留白、克制和可读性。

底层复用官方 [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi-coding-agent) SDK；v0.7.0 起通过 `agent-host/sdk-adapter.ts` **把整个 Pi SDK 收口到单一适配器**，Pi 升级只需改一层，甚至为未来从 `resources/pi-core/` 动态加载预留了同构接口。v0.4.0 起采用 **Electron Main + Agent Host + Next/Renderer 三进程隔离**：即使 Next 重启，正在运行的 Agent 也不会中断。v0.5.0 补齐 **多智能体工作台**；v0.6.0 把会话推进到独立 Git worktree、Main 持有的浏览器与常驻舰队；v0.7.0 进一步加入 **自定义 Provider、沙箱插件系统、进程级 Worktree 编排、local WebSocket 总线**，并修复了 Windows NSIS 打包链路。

> 当前版本：`v0.7.0`（Plugin Bus · Orchestrator · Hot-swappable Pi Core）

## 🧱 进程架构

```text
Electron Main ──spawn──▶ Next.js server ──HTTP/SSE──▶ Renderer（仅 UI + DOM 占位）
      │                        │
      │                        ├──命名管道 RPC──▶ Agent Host（Pi SDK 适配器 · tools · plugins · LTM）
      │                        └──bounds 上报──▶ Main 持有的 WebContentsView（内置浏览器）
      └──utilityProcess──▶ Agent Host
                               │
                               ├──127.0.0.1 WebSocket（自动端口）──▶ 插件 / UI 流式总线
                               └──独立 OS Worker 进程 ──▶ 每个 Worker 独占 Git worktree

Agent Host 关闭时会先排空会话 JSONL、终止所有受管进程树与编排 Worker；Next 侧不持有任何 Agent 会话状态。会话 RPC 仍走命名管道 / Unix Socket；v0.7.0 新增的 localhost WebSocket 只用于插件总线、事件中继和后续多模态流，不替代 Host 控制面。

## ✦ v0.7.0 新能力

1. **模型无关的自定义 Provider** — 设置 →「自定义 Provider」可直接填写 BaseURL / API Key / API 协议与模型列表，支持 Ollama、LM Studio、vLLM、自建 OpenAI/Anthropic 兼容网关。Host 将配置原子写入 `custom-providers.json` 并同步 `models.json`，界面只看到掩码密钥；保存后运行中的会话在下一轮重新加载模型。
2. **local WebSocket 总线** — Host 启动时在 `127.0.0.1` 自动分配端口，复用启动 token 做握手鉴权；为插件通信、事件中继与后续音频/视频流提供底座，端口冲突由操作系统分配规避。
3. **沙箱插件系统** — `~/.pi/agent/plugins/<id>/` 可放 `plugin.json` + JS/TS 入口，导出 `activate(api)` 即可注册工具、MCP 风格工具、提示词与只读面板。插件运行在 `node:vm` 沙箱：没有 `require` / `fs` / `child_process` / `fetch`，禁用 `eval`/`Function`，特权操作只能通过 `api.hostCall()` 走 Host RPC；设置 →「插件管理」可启停，右侧「插件」Tab 展示注入面板。
4. **Session Orchestrator** — 主 Agent 可用 `orchestrator_spawn` 把独立任务分发到**独立 OS Worker 进程 + 独立 Git worktree**，最多 4 个并行；Worker 崩溃不会拖垮 Host。右侧「编排」Tab 以树状图展示主会话、Worker、分支、状态、耗时、变更文件与验证徽章。
5. **Pi 核心可升级防线** — Pi 包精确锁定 `1.1.0`；`npm run check:sdk-imports` 在 CI 强制只有适配器能 import 原生 SDK；`npm run check:pi-updates` 查询 npm registry 并报告新版本；`createHostAgentSession()` 统一构造错误。
6. **Windows NSIS 打包修复** — 解决 electron-builder 生成卸载器时的 `AssignProcessToJobObject` 失败，并容忍杀软短暂占用临时 `.nsis.7z`；`npm run dist` 现在稳定产出 NSIS + ZIP + `latest.yml`。

## ✦ 核心特性

### v0.6.0 三大新能力

1. **会话克隆到 Git Worktree** — 会话的「克隆 / 复刻」对话框新增工作区模式：选「目录克隆」沿用原来的整段复制，选「Worktree 克隆」则在新分支上创建隔离工作目录（目录与分支名留空自动生成，默认落在仓库同级），后续 Agent 的改动只落在这份 worktree 里。Git 操作、目标路径授权与分支 ownership 标记全部在 Agent Host 内完成，Next 只发一次 RPC 并拿到元数据。
2. **内置浏览器迁入 Electron Main** — 浏览器从 Renderer 的 `webview` 改为 Main 持有的 `WebContentsView`：Renderer 只留一个 DOM 占位并上报 bounds，Host 下发的 `open` / `read` / `screenshot` 命令经命名管道交给 Main 执行，返回快照带 `windowId` / `ownerId` / `boundsGeneration`。窗口尺寸变化、视图挂载与 Host 重启后都会重新对齐，页面仍然只有一份。
3. **Herdr 常驻舰队** — 与一次性 sub-agent 不同，`herdr_spawn` 启动的是常驻 Agent：独立 inMemory 会话、只读工具集与父级模型，可用 `herdr_message` 反复追问、`herdr_status` 轮询状态，最多 4 个并发、保留 20 条记录。生命周期状态机复用 managed process 枚举（`starting → running → stopping → stopped/crashed/exited`），右侧「舰队」Tab 只读展示状态、耗时、工具调用与未验证徽章，启停始终由 Host 决定。

### v0.6.0 阶段十：闭环加固

- **packaged smoke 三件套** — `smoke-packaged-events.mjs` 验证 Host → Next 的 `subagent_started / output / finished` 代理链路；`smoke-packaged-browser.mjs` 用命名管道 fake Host 驱动真实 `BrowserManager`（open / read / screenshot）；`smoke-packaged-fleet-ui.mjs` 真实最小化 / 恢复窗口，校验舰队面板刷新时间戳前进且保持只读。
- **增量事件数组** — `subagents.changed` 广播额外携带有序 `events[]`，Next 直接按序转发，不在侧边维护事件队列。
- **全量验证** — `npx tsc --noEmit`、`npm run lint`、`npm run build:agent-host`、`npm run build:electron`、`npm test`（885 pass / 0 fail / 3 skipped）与 `npm run pack` 全部通过，检查清单见 [`docs/releases/STAGE10-SMOKE.md`](./docs/releases/STAGE10-SMOKE.md)。

### v0.5.0 七大核心特性

1. **MCP 高级管理** — OAuth 登录 / 退出 / 凭据刷新、连接测试、Resources 浏览与预览；连接与令牌全部在 Agent Host 内完成。
2. **生图 / 决策模型** — 设置里为两条非对话模型通道选择 Provider + Model；`/imagine` 与 `generate_image` 直接出图，`classify_decision` 输出分类 / 打分徽章。
3. **浏览器分权** — 「只读」与「允许交互」两档授权，默认关闭；未授权时弹一次性的会话级确认，Host 在 `tool_call` 钩子强制校验。
4. **开发环境检测** — Host 扫描 PATH，列出 Node / Python / Git / Bash / Bun / jq 的版本与路径，关键工具缺失即时提示。
5. **大工具输出持久化** — 超过 10KB / 2000 行自动截断预览并落盘 `tool-outputs/`，`tool_history_get` 分页取回，上下文压缩后依然可查。
6. **一键应用与树状分支** — 代码块「应用」到右侧打开的文件（覆盖 / 追加）；消息级「分支」+ `‹ 1/2 ›` 切换器，在平行对话间无损切换。
7. **Sub-Agents 并行协作** — `spawn_agent` 派生独立上下文的只读子 Agent（最多 4 个并行），右侧 Agents Tab 实时查看状态、工具与流式输出。

### v0.5.0 阶段八：发布基础设施与 Windows 原生体验

8. **自动更新** — Electron Main 主导 `electron-updater`：更新源在构建时固定到本仓库 GitHub Releases（`app-update.yml`），运行时不可切换；发现版本后先询问用户再下载，下载完成可立即重启安装，正常退出时也会安装已下载更新。
9. **发布管线** — GitHub Actions 由 `v*` tag 触发，也支持 `workflow_dispatch` 预演；Windows 产出 NSIS 安装包 + ZIP，并生成 `latest.yml` 与 `SHA256SUMS.txt`，Linux/macOS 产物一并上传 Release。
10. **PowerShell 一等公民** — Agent Host 优先使用 `pwsh` 7、回退 Windows PowerShell 5.1，固定 `-NoProfile -NonInteractive -ExecutionPolicy Bypass` 并强制 UTF-8 控制台/管道编码；支持中文、多行与引号。`run_bg` 新增 `shell: "powershell"`，后台 PowerShell 任务复用同一受管进程状态机。
11. **Sub-Agent 验证护栏** — Host 检查子 Agent 最终报告中的测试/构建证据；无证据标记 `verified: false`，Agents Tab 与 `spawn_agent` 卡片显示「未验证」徽章，默认只提示、不阻断主流程。
12. **会话标题、搜索与韧性** — 首条用户消息后台生成 ≤15 字标题，手动命名始终优先；搜索覆盖标题、首条消息与 session id；项目内按今天/昨天/过去 7 天/过去 30 天/更早分组。运行中 `Enter` 立即 Steer、`Alt+Enter` 加入可拖拽重排的 Follow-up 队列；会话加载有 15s deadline + 单次重试。
13. **Extension UI Bridge 回归** — confirm/select/input/editor 的 UUID + Deferred Promise 契约保持 Host 独占；packaged smoke 会真实触发一次 `confirm` 并回传结果，验证 Host 不挂起、Renderer 路径可用。

- **三进程隔离（v0.4.0 核心）** — Main 只负责窗口 / 托盘 / 更新；Agent Host 独立承载 Pi SDK、AgentSession、工具执行、LTM 与受管进程；Next.js 只做页面、HTTP 与 SSE。Host 崩溃会自动重启并恢复订阅，Next 重启不会杀掉正在流式输出的 Agent。Host 与 Next 只通过命名管道 / Unix Socket 通信，零内部 TCP 端口。
- **多会话并行标签** — 中栏顶部是浏览器式标签条，标签名带 VS Code 风格面包屑（项目名 › 会话标题）；多开互不干扰，草稿、流式输出与滚动位置各自独立。
- **多模态输入** — 把图片或代码文件直接拖进输入框，`Ctrl+V` 粘贴截图（自动转 base64 缩略图）随消息发给视觉模型；代码文件自动转成 `@` 文件引用。
- **Plan 模式** — 输入框下方一键开启：Agent 只读分析并先输出修改计划，界面提供「批准并执行 / 拒绝」，批准后自动进入执行模式。
- **内联代码 Diff** — `edit` / `write` 工具调用卡片里直接渲染绿加红代码 Diff（复用 `lib/diff-lines.ts` 的双行号渲染器），不用切到 Git 面板就能看清 AI 改了哪几行。
- **极速快捷键** — `Ctrl+K` 清空对话、`Ctrl+Shift+C` 导出 Markdown、`Ctrl+Tab` 切换标签、`↑` / `↓` 回溯历史提示词，全部原生键盘事件实现。
- **内置浏览器与终端** — 右侧面板拥有 Main 持有的 `WebContentsView` 浏览器（Renderer 只负责占位与 bounds，Agent 通过 `web_preview` 读取页面文本 / 截图，自动跟随 `run_bg` 启动的本地服务）与零依赖 ANSI 终端日志流（bash 与后台进程输出合并展示）。
- **独立 Git 面板** — 按目录分组的工作区改动、双行号可视化 Diff、底部填写提交信息一键 `git add -A` + commit。
- **MCP 高级管理** — 设置面板内完成 MCP 生命周期管理：OAuth 登录 / 取消登录 / 退出登录、凭据刷新、连接测试；服务端提供 Resources 或 Resource Templates 时可直接浏览并预览内容。连接、OAuth 与资源读取全部在 Agent Host 内执行（凭据复用 Pi 的 `mcp-auth.json`），Next 只走 RPC 代理。默认采用「工具搜索」暴露方式，模型按需通过 `tool_search` 发现并激活 MCP 工具，避免把所有工具一次性塞给大模型。
- **生图与决策模型** — 设置 → 辅助模型分别为生图与结构化决策选择 Provider / Model。输入框工具栏、`/imagine` 斜杠命令都能触发 `generate_image`：图片直接渲染在对话的工具卡片里（URL 或 Base64 Markdown 图片也支持）。`classify_decision` 用决策模型做分类 / 打分 / 是否判断，工具卡片以小徽章 + JSON 展示结果。两条通道的 API 调用全部在 Agent Host 内完成，未配置时不会向模型声明工具，不占提示词。
- **浏览器分权** — Agent 使用内置浏览器前必须获得授权：设置 → 开发环境可永久开启「只读（页面文本 / 截图）」与「允许交互（打开 / 导航）」；未开启时 Agent 调用 `web_preview` 会弹出轻量确认框，确认后仅对当前会话生效。权限校验在 Agent Host 的 `tool_call` 钩子内完成，`Next` 只做代理。
- **开发环境检测** — 设置 → 开发环境 · 环境检测由 Agent Host 扫描 PATH，列出 Node、Python、Git、Bash、Bun、jq 等工具的版本号与可执行文件路径；Node / Git / Bash 等关键工具缺失时给出提示。
- **大工具结果持久化** — 工具输出超过 10KB 或 2000 行时不再全量塞进上下文：只保留前后各 40 行预览，完整内容写入会话目录 `tool-outputs/`，并在结尾提示用 `tool_history_get`（`toolCallId` / `offset` / `limit`）分页取回，压缩上下文后依然可查。工具卡片底部提供「查看完整输出」按钮，可在卡片内分页浏览完整日志。
- **树状分支对话** — 会话 JSONL 本身就是树（每条 entry 带 `parentId`）。历史消息悬浮工具栏新增「分支」：以该消息为终点截断后续上下文，再发送消息即形成平行分支；气泡上方显示 `‹ 1/2 ›` 切换器，左右切换时只重载当前 transcript，草稿与流式状态不丢失。切换在 Agent Host 内完成（live 会话走 `navigateTree`，冷会话记住叶节点待下次启动），宿主外的 UI 只做展示。
- **子 Agent 并行协作** — 主 Agent 可用 `spawn_agent` 把独立调研任务交给子 Agent：子 Agent 拥有**独立上下文**（内存 SessionManager，绝不写入主会话 JSONL）、只读工具（read/grep/find/ls）与父级模型，最多 4 个并行；完成后把精炼报告作为 `tool_result` 返回主 Agent。右侧面板新增 **Agents** Tab，实时显示名称、Running/Idle、耗时、工具调用与流式输出，可展开日志或停止运行。生命周期事件（started / output / finished）由 Host 广播，Next 仅代理。
- **代码块一键应用** — Markdown 代码块右上角「应用」按钮直接写入右侧打开的文件：确认框内可选「覆盖文件」或「追加到文件」，写入由 Agent Host 校验可写路径后原子完成，并自动刷新文件视图。
- **文件拖拽引用** — 从右侧文件树把文件拖进输入框，自动插入 `@相对路径` 引用，与 `@` 补全、粘贴图片共用同一套输入体验。
- **霜蓝米白极简 UI** — 固定三栏、低对比浅色、细腻阴影；不引入深色主题干扰阅读。
- **悬浮文件预览** — 文件树常驻右侧，点击文件弹出带阴影的悬浮窗；支持代码高亮、行号、Markdown / HTML / 图片预览与就地编辑。
- **Auto 智能模型路由** — 在模型菜单选择 `Auto`，按提问长度、关键词、图片与上下文规模自动切换快 / 强模型；快、强模型可在设置中指定。
- **点击文件直达** — 聊天中的 `@src/index.ts`、`components/Workbench.tsx:42` 和 Markdown 本地链接可直接打开并在悬浮窗内定位高亮。
- **会话与上下文** — 自动生成标题、手动压缩上下文并提示释放的 Token、Steer 打断、Follow-up 队列与拖拽排序、草稿按会话持久化。
- **输入效率** — `@` 文件补全、`/` 斜杠命令（`/clear`、`/new`、`/compact` 等）、`Enter` 发送 / `Esc` 中断。
- **执行树与工具结果** — 工具调用卡片展开后展示嵌套子调用链、状态、耗时与结果；普通 Bash 保持简洁。
- **Git 感知** — 文件树显示 `M` / `U` / `A` / `D` / `R` 标记，状态栏一键跳转到右侧 Git 面板。
- **受管进程生命周期** — `run_bg` 启动的每个后台任务都由 Agent Host 托管：`starting → running → stopping → stopped/crashed/exited` 状态机、owner（Agent / 用户）、readiness（等待/就绪/失败）、loopback endpoint、退出原因与耗时一目了然。支持优雅停止、强制停止（POSIX 进程组 / Windows `taskkill /T`，带超时与重试）、保留 processId 的重启；清理失败会显式上报并可重试。Host 崩溃后由 crash reaper 依据 owner 与进程身份校验回收遗留进程树（校验失败 fail-closed，绝不乱杀）。Agent 侧只新增只读的 `process_wait`（等待就绪/退出）与 `process_read`（游标分页读日志），**没有** stop/restart 工具，停止与重启始终由用户在面板操作。这是生命周期控制，不是安全沙箱。输出同时汇入「终端」Tab，日志自动脱敏并隐藏用户主目录路径。
- **本地优先** — 配置、会话 `.jsonl`、长期记忆与进程状态都在本机；不依赖 PiForge 自己的云端。

## 🚀 从源码运行

**环境要求**

- Node.js 20+（推荐 LTS）
- npm 10+
- Windows 10/11（主要目标平台；浏览器开发模式跨平台可用）

```bash
git clone https://github.com/yourstandby/PiForge.git
cd PiForge
npm install
npm run dev
```

打开 **http://localhost:30141**。

```bash
# Electron 桌面窗口（需要本机 Electron 运行环境）
npm run dev:electron
```

**常用命令**

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 浏览器开发模式，端口 `30141` |
| `npm run dev:electron` | 编译 Electron 主进程并打开桌面窗口 |
| `npx tsc --noEmit` | TypeScript 类型检查 |
| `npm run lint` | ESLint |
| `npm test` | 单元 / 路由测试 |
| `npm run smoke:agent-host` | Host RPC / 受管进程 / 会话冒烟 |
| `npm run smoke:extension-ui` | Extension UI Bridge confirm 往返冒烟 |
| `npm run smoke:host-reconnect` | Next 断线重连与事件重放冒烟 |
| `npm run smoke:agent-isolation` | 客户端断连后 Host 继续流式输出、重连续传冒烟 |
| `npm run check:sdk-imports` | 校验只有 `sdk-adapter.ts` 直接 import Pi SDK |
| `npm run check:pi-updates` | 查询 npm registry，报告 Pi 新版本 |
| `node scripts/smoke-packaged-events.mjs` | packaged 产物：Host → Next 子 Agent 事件代理 |
| `node scripts/smoke-packaged-browser.mjs` | packaged 产物：Main BrowserManager + 命名管道 bridge |
| `node scripts/smoke-packaged-fleet-ui.mjs` | packaged 产物：最小化 / 恢复后的舰队面板刷新与只读 |

## 📦 自行打包

```bash
npm run dist
```

会依次执行 Next.js standalone 构建、Electron 主进程编译、`node scripts/build-installer.mjs`（预加载 Windows NSIS Job Object 补丁）与产物冒烟测试。Windows 产出 `PiForge-Setup-<version>.exe`、`PiForge-<version>-win-x64.zip` 和 `latest.yml`；packaged smoke 会加载打包后的 Host，并跑一次 Extension UI Bridge confirm 往返。

发布由 GitHub Actions 的 `Desktop packages` workflow 接管：推送 `v*` tag 自动构建三平台产物，上传 NSIS/ZIP/latest.yml 以及 `SHA256SUMS.txt`；也可手动 `workflow_dispatch` 只做构建预演。

只想拿到免安装目录（不生成安装包）：

```bash
npm run build:standalone
npm run build:electron
npx electron-builder --dir      # → release/win-unpacked
```

把目录压成可直接分发的压缩包：

```powershell
Compress-Archive -Path 'release\win-unpacked\*' -DestinationPath 'release\PiForge-0.7.0-win-x64.zip' -CompressionLevel Optimal
```

> 国内网络环境可在安装依赖前设置 Electron 镜像，例如
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。
> 打包前请确认 Node.js 与 npm 可用；首次打包会下载 Electron 二进制。

## 🧭 使用速览

| 操作 | 说明 |
| --- | --- |
| `@` | 在输入框引用项目文件 |
| 拖拽文件 / `Ctrl + V` | 图片变缩略图附件、代码文件变 `@` 引用；截图可直接粘贴发给视觉模型 |
| `/` | 打开斜杠命令面板 |
| `/imagine 描述` | 让 Agent 调用生图模型生成图片（也可点输入框工具栏的图片按钮） |
| `Enter` | 发送；Agent 生成中则立即 Steer |
| `Alt + Enter` | Agent 生成中加入 Follow-up 队列 |
| `Esc` | 立即中断当前生成 |
| `Ctrl + K` | 清空当前对话（等同 `/clear`） |
| `Ctrl + Shift + C` | 复制整段对话的 Markdown 源码 |
| `Ctrl + Tab` / `Ctrl + Shift + Tab` | 在多会话标签之间右 / 左切换 |
| `↑` / `↓` | 输入框为空时回溯历史提示词（`↓` 翻回原草稿） |
| Plan 模式 | 状态栏开关：先出计划，界面「批准并执行」后才改代码 |
| 设置 → Auto 路由 | 指定快模型与强模型 |
| 右侧 Git Tab | 改动列表 → 点文件看双行号 Diff → 底部填写信息直接提交 |
| 右侧 浏览器 / 终端 | 输入 `localhost:端口` 预览本地服务；终端实时显示 bash 与后台进程输出 |
| 右侧文件树 | 点击文件 → 悬浮预览 / 编辑；拖动左边缘调整宽度（280–800px） |
| 会话行「克隆」 | 选「Worktree 克隆」把当前会话复制到新分支的独立工作目录 |
| 右侧 舰队 Tab | 查看 `herdr_spawn` 启动的常驻 Agent：状态、耗时、工具调用与未验证徽章 |
| 右侧 编排 Tab | 查看 `orchestrator_spawn` 的 Worker 树、Git worktree、变更文件与验证状态 |
| 右侧 插件 Tab | 查看启用插件注入的只读面板 |
| 设置 → 自定义 Provider | 配置 Ollama / LM Studio / 自建网关的 BaseURL、密钥与模型 |
| 设置 → 插件管理 | 启用 / 禁用 `~/.pi/agent/plugins/` 下的沙箱插件 |

## 🏗 架构与目录

```text
agent-host/    Agent Host：SDK 适配器、会话/工具、LTM、受管进程、插件沙箱、WebSocket 总线、编排 Worker
contract/      宿主与 Next / Renderer 之间的 RPC 方法与域类型（单一事实来源）
app/           Next.js 页面与 API 路由（sessions / agent / herdr / files / git / processes）
components/    三栏工作台、悬浮文件窗、Markdown、输入框、配置面板、舰队/编排/插件面板
hooks/         Agent 会话、事件流、草稿、面板与配置热重载
lib/           RPC 客户端、会话读写、模型路由、Git、受管进程、LTM（不持有会话状态）
electron/      主进程、preload、托盘、标题栏、更新逻辑与 Main BrowserManager
scripts/       构建、图标生成、SDK 边界/升级雷达、NSIS 补丁、standalone / packaged 冒烟测试
```

PiForge 复用上游的进程内 AgentSession + SSE 架构，但会话本身只存在于 Agent Host：Next 通过命名管道 RPC 代理，Renderer 通过 HTTP/SSE 消费事件，Main 只管窗口、更新与浏览器视图。详细约定见 [`AGENTS.md`](./AGENTS.md) 与 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

## 🤝 参与贡献

欢迎轻量、聚焦、可验证的 Issue 与 PR。提交前请阅读 [`CONTRIBUTING.md`](./CONTRIBUTING.md)，并遵守 [`AGENTS.md`](./AGENTS.md) 中的架构铁律与 UI 铁律。

## 🙏 致谢与协议

PiForge 基于 [Chasen-Liao/pi-agent-desktop](https://github.com/Chasen-Liao/pi-agent-desktop)（MIT）衍生，向上游 [agegr/pi-web](https://github.com/agegr/pi-web) 与 [Pi coding agent](https://github.com/badlogic/pi-mono) 致敬。

以 **MIT License** 发布，详见 [`LICENSE`](./LICENSE)。
