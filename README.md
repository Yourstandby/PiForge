<div align="center">

<img src="./public/logo.svg" width="88" alt="PiForge" />

# PiForge

**极简、高级的 Pi Coding Agent 桌面端**  
*A minimal, polished desktop workbench for the Pi coding agent.*

Windows-first · Local-first · Electron + Next.js · MIT

</div>

---

PiForge 把 Pi Coding Agent 的会话、工具调用与项目文件收进一个安静的三栏工作台：左侧管理会话，中间专注对话，右侧常驻项目文件。界面采用 **霜蓝 × 米白** 的浅色体系，强调留白、克制和可读性。

底层直接复用官方 [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi-coding-agent) SDK，不引入额外代理层或外部服务；会话、SSE 流式回复、工具执行与文件读写都在本地完成。

> 当前版本：`v0.1.0`（开源预览版）

## ✦ 核心特性

- **霜蓝米白极简 UI** — 固定三栏、低对比浅色、细腻阴影；不引入深色主题干扰阅读。
- **悬浮文件预览** — 文件树常驻右侧，点击文件弹出带阴影的悬浮窗；支持代码高亮、行号、Markdown / HTML / 图片预览与就地编辑。
- **Auto 智能模型路由** — 在模型菜单选择 `Auto`，按提问长度、关键词、图片与上下文规模自动切换快 / 强模型；快、强模型可在设置中指定。
- **点击文件直达** — 聊天中的 `@src/index.ts`、`components/Workbench.tsx:42` 和 Markdown 本地链接可直接打开并在悬浮窗内定位高亮。
- **会话与上下文** — 自动生成标题、手动压缩上下文并提示释放的 Token、Steer 打断、Follow-up 队列与拖拽排序、草稿按会话持久化。
- **输入效率** — `@` 文件补全、`/` 斜杠命令（`/clear`、`/new`、`/compact` 等）、`Enter` 发送 / `Esc` 中断。
- **执行树与工具结果** — 工具调用卡片展开后展示嵌套子调用链、状态、耗时与结果；普通 Bash 保持简洁。
- **Git 感知** — 文件树显示 `M` / `U` / `A` / `D` / `R` 标记；状态栏一键打开仓库级 Git Diff。
- **轻量受管进程** — Agent 通过 `run_bg` 启动 `npm run dev` 等长任务，右侧「进程」Tab 实时查看脱敏日志、停止或重启。
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

会依次执行 Next.js standalone 构建、Electron 主进程编译、`electron-builder` 打包与产物冒烟测试，输出：

```text
release/PiForge-Setup-0.1.0.exe
```

> 国内网络环境可在安装依赖前设置 Electron 镜像，例如
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。
> 打包前请确认 Node.js 与 npm 可用；首次打包会下载 Electron 二进制。

## 🧭 使用速览

| 操作 | 说明 |
| --- | --- |
| `@` | 在输入框引用项目文件 |
| `/` | 打开斜杠命令面板 |
| `Enter` | 发送；Agent 生成中则立即 Steer |
| `Alt + Enter` | Agent 生成中加入 Follow-up 队列 |
| `Esc` | 立即中断当前生成 |
| 设置 → Auto 路由 | 指定快模型与强模型 |
| 状态栏 `GitCompare` | 在右侧悬浮窗查看 Git Diff |
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
