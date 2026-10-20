# 贡献指南 · Contributing to PiForge

感谢你愿意参与 PiForge。我们偏好**小而专注、能被验证**的改动：一次只解决一个用户能感知的问题，不引入无关重构，不增加重型依赖。

> 提交前请先阅读 [`AGENTS.md`](./AGENTS.md)。其中的【架构铁律】与【UI 铁律】是硬约束，不是建议。

## 提交 Issue

- 先搜索已有 Issue / PR，避免重复。
- Bug 请附：PiForge 版本或 commit、系统版本、复现步骤、期望行为与实际行为。
- 功能建议请写清：要解决什么问题、范围、明确不做什么。
- 不要粘贴 API Key、`auth.json`、完整会话 `.jsonl` 或未脱敏日志。

## 提交 Pull Request

1. 从最新 `main` 拉分支，建议使用 `fix/…`、`feat/…`、`docs/…` 或 `chore/…`。
2. 保持改动聚焦：一个 PR 只做一件事，避免顺手重构无关模块。
3. PR 描述至少包含：
   - **Why**：为什么需要这次改动
   - **Scope**：改了哪些文件 / 行为
   - **Out of scope**：明确没有做什么
   - **Verification**：跑过哪些命令、如何手动验证
4. 提交前本地通过：

```bash
npx tsc --noEmit
npm run lint
npm test
```

5. 涉及 UI 的改动请附截图或简短录屏，并说明在浅色主题、窄窗口、右侧面板展开/收起状态下的表现。

## 架构铁律

- **直接复用官方 SDK**：使用 `@earendil-works/pi-coding-agent`，不要在 Electron / Next 层再加代理、额外网络层或自建 Agent 服务。
- **不引入外部服务器**：会话、文件、Git、进程与配置都在本地完成；不要为轻量功能新增云端依赖。
- **不破坏 SSE 流**：流式消息、工具事件、扩展 UI、会话状态继续走现有 `/api/agent/[id]/events`。
- **性能优先**：历史会话增量加载、长工具输出懒渲染、批量工具调用；不要在主线程做全量磁盘扫描。
- **本地优先**：不把用户会话、密钥或项目文件发送到 PiForge 自己的服务。

## UI 铁律

- **三栏布局不变**：左栏会话 / 中栏聊天 / 右栏文件工作区。
- **左栏固定 260px**：浅灰白背景，单行截断，禁止内嵌文件树或重复按钮。
- **右栏自适应可调**：默认约 560px，支持 280–800px 拖拽；文件树常驻，不得被全屏 Tab 覆盖。
- **浅色霜蓝米白**：主区 `#FCFCFA`，卡片/输入框纯白 + 柔和阴影；不要引入深色主题或高饱和色块。
- **文件预览用悬浮窗**：文件在右侧面板内的悬浮小窗打开，不改变中间聊天区。
- **少即是多**：优先复用已有组件与样式 token，不新增重复按钮、菜单或悬浮层。

## 依赖与代码风格

- 不新增重型依赖（如 PDF / Excel / Monaco 全家桶）；优先使用现有 `react-markdown`、`react-syntax-highlighter`、`lucide-react` 与官方 SDK。
- 用户可见文案统一放入 `lib/i18n/dictionaries.ts`（中英双语），不要硬编码在组件里。
- 业务逻辑与 UI 分离：可测试的解析、路由、路径与状态计算放到 `lib/` 或纯函数模块，并补单元测试。
- 不删除看起来“没用到”的核心模块，先确认引用与运行路径。

## 提交信息

使用清晰的 Conventional Commits 风格：

```text
feat(right-panel): floating file preview
fix(composer): keep draft when switching sessions
docs: refresh README for v0.1.0
```

## 协议

贡献即表示你同意以项目的 **MIT License** 发布你的代码。详见 [`LICENSE`](./LICENSE)。
