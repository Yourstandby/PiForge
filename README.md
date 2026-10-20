<div align="center">

<img src="./public/logo.svg" width="88" alt="PiForge" />

# PiForge

**极简、高级的 Pi Coding Agent 桌面端**  
*A minimal, polished desktop workbench for the Pi coding agent.*

Windows-first · Local-first · Electron + Next.js · MIT

</div>

---

PiForge 把 Pi Coding Agent 的会话、工具调用与项目文件收进一个安静的三栏工作台：左侧管理会话，中间用浏览器式多会话标签并行对话，右侧常驻文件树、内置浏览器、终端与 Git 面板。界面采用 **霜蓝 × 米白** 的浅色体系，强调留白、克制和可读性。

底层直接复用官方 [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi-coding-agent) SDK，不引入额外代理层或外部服务；会话、SSE 流式回复、工具执行与文件读写都在本地完成。v0.4.0 起采用 **Electron Main + Agent Host + Next/Renderer 三进程隔离**：即使 Next 重启，正在运行的 Agent 也不会中断。

> 当前版本：`v0.4.0`（Agent Host Isolation）

## 🧱 进程架构

```text
Electron Main ──spawn──▶ Next.js server ──HTTP/SSE──▶ Renderer / webview
      │                        │
      └──utilityProcess──▶ Agent Host（Pi SDK · tools · LTM · processes）
                               ▲
                               └── named pipe（无 TCP 端口）
```

Agent Host 关闭时会先排空会话 JSONL、终止所有受管进程树；Next 侧不持有任何 Agent 会话状态。

## ✦ 核心特性

- **三进程隔离（v0.4.0 核心）** — Main 只负责窗口 / 托盘 / 更新；Agent Host 独立承载 Pi SDK、AgentSession、工具执行、LTM 与受管进程；Next.js 只做页面、HTTP 与 SSE。Host 崩溃会自动重启并恢复订阅，Next 重启不会杀掉正在流式输出的 Agent。Host 与 Next 只通过命名管道 / Unix Socket 通信，零内部 TCP 端口。
- **多会话并行标签** — 中栏顶部是浏览器式标签条，标签名带 VS Code 风格面包屑（项目名 › 会话标题）；多开互不干扰，草稿、流式输出与滚动位置各自独立。
- **多模态输入** — 把图片或代码文件直接拖进输入框，`Ctrl+V` 粘贴截图（自动转 base64 缩略图）随消息发给视觉模型；代码文件自动转成 `@` 文件引用。
- **Plan 模式** — 输入框下方一键开启：Agent 只读分析并先输出修改计划，界面提供「批准并执行 / 拒绝」，批准后自动进入执行模式。
- **内联代码 Diff** — `edit` / `write` 工具调用卡片里直接渲染绿加红代码 Diff（复用 `lib/diff-lines.ts` 的双行号渲染器），不用切到 Git 面板就能看清 AI 改了哪几行。
- **极速快捷键** — `Ctrl+K` 清空对话、`Ctrl+Shift+C` 导出 Markdown、`Ctrl+Tab` 切换标签、`↑` / `↓` 回溯历史提示词，全部原生键盘事件实现。
- **内置浏览器与终端** — 右侧面板拥有原生 Electron `webview` 浏览器（Agent 可通过 `web_preview` 读取页面文本 / 截图，自动跟随 `run_bg` 启动的本地服务）与零依赖 ANSI 终端日志流（bash 与后台进程输出合并展示）。
- **独立 Git 面板** — 按目录分组的工作区改动、双行号可视化 Diff、底部填写提交信息一键 `git add -A` + commit。
- **MCP 高级管理** — 设置面板内完成 MCP 生命周期管理：OAuth 登录 / 取消登录 / 退出登录、凭据刷新、连接测试；服务端提供 Resources 或 Resource Templates 时可直接浏览并预览内容。连接、OAuth 与资源读取全部在 Agent Host 内执行（凭据复用 Pi 的 `mcp-auth.json`），Next 只走 RPC 代理。默认采用「工具搜索」暴露方式，模型按需通过 `tool_search` 发现并激活 MCP 工具，避免把所有工具一次性塞给大模型。
- **生图与决策模型** — 设置 → 辅助模型分别为生图与结构化决策选择 Provider / Model。输入框工具栏、`/imagine` 斜杠命令都能触发 `generate_image`：图片直接渲染在对话的工具卡片里（URL 或 Base64 Markdown 图片也支持）。`classify_decision` 用决策模型做分类 / 打分 / 是否判断，工具卡片以小徽章 + JSON 展示结果。两条通道的 API 调用全部在 Agent Host 内完成，未配置时不会向模型声明工具，不占提示词。
- **浏览器分权** — Agent 使用内置浏览器前必须获得授权：设置 → 开发环境可永久开启「只读（页面文本 / 截图）」与「允许交互（打开 / 导航）」；未开启时 Agent 调用 `web_preview` 会弹出轻量确认框，确认后仅对当前会话生效。权限校验在 Agent Host 的 `tool_call` 钩子内完成，`Next` 只做代理。
- **开发环境检测** — 设置 → 开发环境 · 环境检测由 Agent Host 扫描 PATH，列出 Node、Python、Git、Bash、Bun、jq 等工具的版本号与可执行文件路径；Node / Git / Bash 等关键工具缺失时给出提示。
- **大工具结果持久化** — 工具输出超过 10KB 或 2000 行时不再全量塞进上下文：只保留前后各 40 行预览，完整内容写入会话目录 `tool-outputs/`，并在结尾提示用 `tool_history_get`（`toolCallId` / `offset` / `limit`）分页取回，压缩上下文后依然可查。工具卡片底部提供「查看完整输出」按钮，可在卡片内分页浏览完整日志。
- **霜蓝米白极简 UI** — 固定三栏、低对比浅色、细腻阴影；不引入深色主题干扰阅读。
- **悬浮文件预览** — 文件树常驻右侧，点击文件弹出带阴影的悬浮窗；支持代码高亮、行号、Markdown / HTML / 图片预览与就地编辑。
- **Auto 智能模型路由** — 在模型菜单选择 `Auto`，按提问长度、关键词、图片与上下文规模自动切换快 / 强模型；快、强模型可在设置中指定。
- **点击文件直达** — 聊天中的 `@src/index.ts`、`components/Workbench.tsx:42` 和 Markdown 本地链接可直接打开并在悬浮窗内定位高亮。
- **会话与上下文** — 自动生成标题、手动压缩上下文并提示释放的 Token、Steer 打断、Follow-up 队列与拖拽排序、草稿按会话持久化。
- **输入效率** — `@` 文件补全、`/` 斜杠命令（`/clear`、`/new`、`/compact` 等）、`Enter` 发送 / `Esc` 中断。
- **执行树与工具结果** — 工具调用卡片展开后展示嵌套子调用链、状态、耗时与结果；普通 Bash 保持简洁。
- **Git 感知** — 文件树显示 `M` / `U` / `A` / `D` / `R` 标记，状态栏一键跳转到右侧 Git 面板。
- **轻量受管进程** — Agent 通过 `run_bg` 启动 `npm run dev` 等长任务，右侧「进程」Tab 实时查看脱敏日志、停止或重启；输出同时汇入「终端」Tab。
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

## 📦 自行打包

```bash
npm run dist
```

会依次执行 Next.js standalone 构建、Electron 主进程编译、`electron-builder` 打包与产物冒烟测试，默认产出 NSIS 安装包。

只想拿到免安装目录（不生成安装包）：

```bash
npm run build:standalone
npm run build:electron
npx electron-builder --dir      # → release/win-unpacked
```

把目录压成可直接分发的压缩包：

```powershell
Compress-Archive -Path 'release\win-unpacked\*' -DestinationPath 'release\PiForge-0.4.0-win-x64.zip' -CompressionLevel Optimal
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

## 🏗 架构与目录

```text
app/           Next.js 页面与 API 路由（sessions / agent / files / git / processes）
components/    三栏工作台、悬浮文件窗、Markdown、输入框、配置面板
hooks/         Agent 会话、事件流、草稿、面板与配置热重载
lib/           RPC 管理、会话读写、模型路由、Git、受管进程、LTM
electron/      主进程、preload、托盘、标题栏与更新逻辑
scripts/       构建、图标生成、standalone 冒烟测试
```

PiForge 复用了上游的进程内 AgentSession + SSE 架构：服务端直接持有 SDK 会话，浏览器与 Electron 共用同一套 UI。详细约定见 [`AGENTS.md`](./AGENTS.md) 与 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

## 🤝 参与贡献

欢迎轻量、聚焦、可验证的 Issue 与 PR。提交前请阅读 [`CONTRIBUTING.md`](./CONTRIBUTING.md)，并遵守 [`AGENTS.md`](./AGENTS.md) 中的架构铁律与 UI 铁律。

## 🙏 致谢与协议

PiForge 基于 [Chasen-Liao/pi-agent-desktop](https://github.com/Chasen-Liao/pi-agent-desktop)（MIT）衍生，向上游 [agegr/pi-web](https://github.com/agegr/pi-web) 与 [Pi coding agent](https://github.com/badlogic/pi-mono) 致敬。

以 **MIT License** 发布，详见 [`LICENSE`](./LICENSE)。
