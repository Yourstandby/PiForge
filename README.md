
<div align="center">

<img src="./public/logo.svg" width="92" alt="PiForge" />

# PiForge

**把 Pi Coding Agent 装进一张安静的三栏工作台**
*A local-first desktop workbench for the Pi coding agent — multi-session, multi-agent, cache‑aware.*

[![Release](https://img.shields.io/github/v/release/Yourstandby/PiForge?sort=semver)](https://github.com/Yourstandby/PiForge/releases)
[![CI](https://github.com/Yourstandby/PiForge/actions/workflows/ci.yml/badge.svg)](https://github.com/Yourstandby/PiForge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

</div>

--- 

## 简介

PiForge 是一款 **本地优先** 的桌面工作台，专为 Pi Coding Agent 设计。左侧展示项目与会话，中间是多标签对话，右侧提供文件树、内置浏览器、终端、Git、舰队 Agent、编排与插件面板。主 Agent 可改代码，子 Agent 可调研、审计，互不干扰，一切运行在本机。

## 快速安装

- **Windows**：下载最新的 <code>PiForge-Setup-x.x.x.exe</code>（或 <code>PiForge.zip</code>）并运行。若出现 SmartScreen，请选择「仍要运行」。
- **macOS**：下载 <code>.dmg</code>，打开后拖入 <code>/Applications</code>。首次运行可能需要在「系统偏好设置 → 安全性与隐私」中允许。
- **Linux**：下载 <code>.AppImage</code> 或 <code>.deb</code>，自行添加执行权限或使用 <code>sudo dpkg -i</code> 安装。

> 安装包未签名，可能会被系统拦截，请按提示手动信任。

## 主要特性

| 图标 | 功能 | 描述 |
|---|---|---|
| ♻️ | **缓存友好 plan 模式** | 切换模式不重发前缀，历史缓存保持完整 |
| 🩺 | **无进展看门狗** | 自动监测卡顿并提示 |
| 🖐 | **人工介入** | Skip / 简易询问 / 深度诊断 |
| 🧠 | **上下文可视化 & 压缩** | 环形上下文 + 四段式摘要 |
| 🤖 | **子 Agent / 常驻舰队** | <code>spawn_agent</code> 与 <code>herdr_*</code> 独立上下文 |
| 🗂 | **项目 & 会话管理** | 项目可改名/隐藏，会话按时间分组 |
| 💰 | **Token 账本** | 只报真实 usage，审计成本结构 |
| ⚡️ | **启动 & 内存优化** | 静态导出、可切传输层、V8 堆分档 |
| 🧱 | **三进程隔离** | Agent Host、Next UI、Electron 主进程 |
| 🌙 | **夜间模式** | 系统跟随、浅色/深色主题切换 |

## 最新版本 v0.12.1 — 计划模式不再重发上下文

- **切 plan 不烧缓存**：计划段落改为尾部 <code>display:false</code> 注入，前缀字节保持不变，切换不再导致整段历史重发。
- **只读拦截**：写操作在 <code>tool_call</code> 阶段被拒，返回 <code>Plan mode: planning only</code>。
- **进度卡片渲染**：折叠函数兼容 {toolCallId, toolName, input} 与 {id, name, arguments} 两种形状，卡片首次出现。
- **plan 工具常驻**：与 <code>tool_search</code> / <code>desktop_use_tool</code> 一样恒常驻，不再被工具存根吞掉 schema。

详细变更见 [CHANGELOG.md](./CHANGELOG.md) 与 [docs/releases/v0.12.1.md](./docs/releases/v0.12.1.md)。

## 架构概览

PiForge 采用 **三进程 + 单管道** 设计：

<pre><code>
Electron Main ──协议处理──▶ piforge://app（静态导出，无 Next 运行时）
      │                          │
      │                          └──/api/** 走命名管道──▶ Agent Host（Pi SDK + 工具 + 受管进程）
      │                                                        │
      └── Renderer (Next.js) ── UI 渲染、交互
</code></pre>

- **Renderer**（Next.js）负责 UI 与用户交互，仅通过 <code>preload</code> 桥接 RPC。
- **Electron Main** 负责窗口、托盘、自动更新以及协议转发。
- **Agent Host** 运行 Pi SDK、工具调用、子 Agent 与插件桥接，所有业务逻辑均在此层。

完整边界契约请参阅 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## 开发与贡献

- 阅读 [CONTRIBUTING.md](./CONTRIBUTING.md) 与 [AGENTS.md](./AGENTS.md)。
- 本地开发：<code>npm install && npm run dev</code>。
- 提交前确保 <code>npm run lint && npm test</code> 全部通过。

## 许可证

MIT License – 详见 [LICENSE](./LICENSE)。
