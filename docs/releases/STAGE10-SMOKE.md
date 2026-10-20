# 阶段十 Packaged Smoke 检查清单

> 环境：Windows x64 · `release/win-unpacked` · Node 24 · Electron 43.7.7  
> 基线：`dev/v0.6.0` @ `1358d86`，dev 测试 877 pass / 0 fail / 3 skipped  
> 日志目录：`release/logs/`

## 结果总览

| # | 检查项 | 命令 | 结果 | 日志 |
|---|---|---|---|---|
| 0 | packaged 产物可生成 | `npm run pack` | PASS | 控制台 |
| 1 | Host → Next SSE 生命周期代理 | `node scripts/smoke-packaged-events.mjs` | PASS | `release/logs/stage10-events.log` |
| 2 | Main BrowserManager + 命名管道 bridge | `node scripts/smoke-packaged-browser.mjs` | PASS | `release/logs/stage10-browser.log` |
| 3 | 窗口最小化/恢复后的舰队刷新 | `node scripts/smoke-packaged-fleet-ui.mjs` | PASS | `release/logs/stage10-fleet-ui.log` |
| 4 | 舰队面板只读渲染 | 同上 | PASS | 同上 |

## 1. Host → Next 代理链路

- packaged Host + packaged Next standalone 真实启动。
- throwaway extension 用 faux provider 调用 `spawnSubagent()`，产生真实生命周期。
- 先建立 `/api/subagents/events`，再触发 `agent.create`。
- 断言收到 `subagent_started`、`subagent_output`、`subagent_finished`。
- 最终日志：

```text
packaged-events smoke: OK (subagent_finished -> subagent_started -> subagent_output -> subagent_finished)
```

说明：Host 100ms 广播会合并状态，`subagents.changed` 现在额外携带 `events[]` 有序增量；smoke 从 `events[]` 验证三段事件。首尾重复的 `subagent_finished` 是“最近事件 + 增量数组”同时出现，不是重复派发。

## 2. Main BrowserManager / BrowserHostBridge

- 真实 `release/win-unpacked/PiForge.exe`，`SMOKE_BROWSER=1` 动态加载 smoke 入口，正常启动路径不加载。
- 创建 `BrowserWindow` + `WebContentsView`，调用生产 `BrowserManager`。
- fake Host 通过命名管道依次下发 `open` / `read` / `screenshot`。
- 断言：read 文本含 fixture、PNG 非空、`ready=true`、`boundsGeneration>0`、快照带 `windowId/ownerId`。

```text
SMOKE_BROWSER_OK {... "screenshot":{"ok":true,...,"bytes":31392,"ready":true,"boundsGeneration":1}}
packaged-browser smoke: OK (open/read/screenshot, 31392 base64 chars)
```

边界：Electron 对从未显示的 `WebContentsView` 调用 `capturePage()` 会抛 `UnknownVizError`。smoke 窗口因此使用 `opacity: 0 + showInactive()`（不可见但参与合成），不是普通 `show:false`。这不影响生产 BrowserPanel 的显示路径。

## 3. 舰队面板刷新与只读

```text
SMOKE_FLEET_OK {"method":"minimize","minimized":true,"beforeTs":1792508778905,"afterTs":1792508785010,"readOnly":true}
packaged-fleet-ui smoke: OK
```

- 真实 `minimize()` 5 秒后 `restore()`。
- 恢复后 `data-last-loaded-at` 增大（约 6 秒跨度，包含主动 refresh）。
- DOM 中无 textarea / 文本输入 / 发送按钮，`readOnly=true`。
- 日志末尾的 `Scheduling Agent Host restart` 是 smoke 主动 `app.exit()` 时 Host 退出触发的正常重启调度，不是 smoke 失败。

## 4. 自动化测试

```text
npx tsc --noEmit        PASS
npm run lint            PASS (0 error, 3 pre-existing warnings)
npm run build:agent-host PASS
npm run build:electron  PASS
npm test                PASS (885 pass / 0 fail / 3 skipped)
```

## 未覆盖边界（诚实记录）

- Herdr 舰队是 Host 内 inMemory AgentSession，不是 OS 子进程；只复用 managed 状态枚举/迁移，不进入 PID/taskkill/readiness 清理路径。
- packaged-events 的 extension 直接调用 `spawnSubagent()`，未经过真实模型工具选择；验证的是事件/代理链路，不是模型行为。
- packaged-browser smoke 使用 fake Host 命名管道，只验证 Main 侧 bridge 协议与 WebContentsView；未连接真实 Host 的 Agent tool 调用链（该链路由 Host 单测覆盖）。
- 未实现多窗口共享或每子 Agent 独立浏览器 page；`windowId` / `ownerId` 仅预留透传。
- 舰队面板 smoke 时舰队为空，只验证只读布局与刷新；未做有 Agent 卡片时的视觉截图比对。
