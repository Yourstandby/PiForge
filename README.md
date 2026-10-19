# PiForge

PiForge 是 [Pi 编程智能体](https://github.com/badlogic/pi-mono) 的 Windows 桌面工作台。
它把 Pi 的会话、文件与工具能力收进一个原生 Electron 窗口，并加了一套名为
**Glacier（冰川蓝）** 的深蓝主题。

> PiForge 衍生自 [Chasen-Liao/pi-agent-desktop](https://github.com/Chasen-Liao/pi-agent-desktop)（MIT），
> 该上游项目又衍生自 [pi-web](https://github.com/agegr/pi-web)。功能与架构沿用上游，
> PiForge 负责品牌化、Windows 打包与主题扩展。

## 快速开始

```bash
npm install          # 依赖安装（Electron 二进制走镜像时设置 ELECTRON_MIRROR）
npm run dev          # 浏览器开发模式 http://localhost:30141
npm run dev:electron # Electron 桌面开发模式
npm run dist         # 打包 Windows NSIS 安装包到 release/
```

开发期间不要直接运行 `next build`，它会污染 `.next/` 并打断 `npm run dev`。
需要验证生产产物时使用 `npm run build` 或完整的 `npm run dist`。

## Windows 安装包

`npm run dist` 会依次执行 Next.js standalone 构建、Electron 主进程编译、
electron-builder 打包与产物冒烟测试，输出：

```
release/PiForge-Setup-0.1.0.exe
```

安装器沿用上游的进程清理逻辑：升级安装时会关闭 `PiForge.exe`，也会清理
`Pi Agent Desktop.exe` / `Pi Agent.exe` / `PipeAgent.exe` 等旧进程。

## 多项目并行

PiForge 支持同时打开多个项目窗口，所有窗口共享同一个本地 Pi 服务：

- 工作台菜单 `⋯` → **新建窗口**
- `Ctrl+Shift+N`
- 侧边栏项目行悬停 → 窗口图标（直接以该项目打开）
- 新窗口地址形如 `/?cwd=D%3A%5CProjects%5Cdemo`，进入该目录的空白会话

主窗口关闭时隐藏到托盘；项目窗口关闭即销毁，不会堆积隐藏窗口。

## 外观：三套主题

| 主题 | 说明 |
| --- | --- |
| Light | 浅色，低对比冷灰底 |
| Dark | 深色，暖琥珀强调色（上游默认） |
| Glacier | PiForge 蓝色主题：极夜蓝底、冰蓝强调色、顶部极光渐变 |

切换入口在工作台菜单（右上角 `⋯` → 外观），或按 `Ctrl+Shift+T` 在
Light → Dark → Glacier 之间循环。主题保存在 `localStorage["pi-theme"]`。

实现上，Glacier 复用 `dark` 类并追加 `theme-glacier`，只在 `app/globals.css`
覆盖调色板 token；组件结构、交互逻辑与语法高亮逻辑不变。切换主题时 Electron
标题栏颜色由 `electron/title-bar-overlay.ts` 同步。

## 品牌与图标

- `package.json` → `name: piforge`，`desktopName: piforge`
- `electron-builder.yml` → `productName: PiForge`，`appId: com.piforge.desktop`
- 图标由 `npm run icons`（`scripts/build-brand-icons.mjs`）从一个内嵌 SVG 生成
  ICO / ICNS / PNG，覆盖安装器、托盘、窗口与网页 logo

## 项目结构

| 目录 | 内容 |
| --- | --- |
| `app/` | Next.js 页面、39 条 API 路由、全局样式与主题 token |
| `components/` | 会话界面、侧边栏、输入框、配置面板等 React 组件 |
| `hooks/` | 主题、面板布局、Agent 会话等客户端 hook |
| `lib/` | RPC 管理、会话读写、i18n、LTM、Git worktree 等服务端库 |
| `electron/` | 主进程、preload、托盘、标题栏与更新逻辑 |
| `build/` | 安装器脚本与品牌图标 |
| `scripts/` | 构建、冒烟测试与图标生成脚本 |

上游的架构细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 与 [AGENTS.md](AGENTS.md)。

## 致谢与许可

- 上游桌面端：[Chasen-Liao/pi-agent-desktop](https://github.com/Chasen-Liao/pi-agent-desktop)
- 上游 Web 端：[agegr/pi-web](https://github.com/agegr/pi-web)
- Pi 运行时：[badlogic/pi-mono](https://github.com/badlogic/pi-mono)

以 MIT 协议发布，见 [LICENSE](LICENSE)。
