/**
 * 结构护栏：看门狗/HITL 的界面接缝。
 *
 * 断言的是「架构约束」，不是实现细节：
 *   1. 主聊天界面（ChatSurface）不订阅看门狗快照 → 侧栏每秒心跳不可能让它重渲染；
 *   2. 主聊天只保留工具行的微红底色 + 图标，不再有黄条/弹窗；
 *   3. 右侧「系统监控」面板是重订阅者，且介入动作只走本地 RPC 代理。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");

test("ChatSurface never subscribes to watchdog state", () => {
  const src = read("components/ChatSurface.tsx");
  for (const hook of [
    "useWatchdogStore",
    "useWatchdogTask",
    "useWatchdogNotice",
    "useHeartbeat",
    "useTicker",
    "useToolStall",
  ]) {
    assert.equal(src.includes(hook), false, `ChatSurface 不得使用 ${hook}（会拖垮主聊天渲染）`);
  }
  // 只允许「静态会话 id」上下文：它不随看门狗刷新而变化。
  assert.match(src, /<WatchdogSessionProvider sessionId=\{session\?\.id \?\? null\}>/);
  // 主界面上的看门狗视觉件已全部撤掉。
  assert.equal(src.includes("WatchdogHeartbeat"), false);
});

test("tool rows keep only the red tint + icon, no banner or diagnostics popup", () => {
  const src = read("components/Transcript.tsx");
  // 允许 prettier 把这一句折成多行（源码格式化不该让结构护栏误报）。
  assert.match(src, /const stalledRow =\s*stall\?\.level === "stalled"/);
  assert.match(src, /bg-\[#FDF2F2\]/, "整行微红底色仍然保留");
  assert.match(src, /TriangleAlert/, "卡死行仍然有图标提示");
  assert.equal(src.includes("StallDiagnosticsButton"), false, "诊断弹窗已移到右侧面板");
  assert.equal(src.includes("warnedRow"), false, "黄色横幅/黄字设计已撤销");
  assert.equal(src.includes("秒无进展"), false, "工具行不再打印诊断文案");
});

test("the right rail owns the monitor panel and its tab badge", () => {
  const src = read("components/FilePanel.tsx");
  // 图标：Radar（雷达扫描）比 Activity（心电图）更贴合「持续扫描监控」。
  assert.match(src, /\{ id: "monitor" as const, label: "系统监控", Icon: Radar \}/);
  assert.match(src, /<WatchdogPanel sessionId=\{sessionId \?\? null\} \/>/);
  assert.match(src, /<WatchdogTabBadge sessionId=\{sessionId \?\? null\} \/>/);
});

test("multi-session alarms use one shared red-dot language", () => {
  const dot = read("components/watchdog/StatusDot.tsx");
  // 卡死 = 红色呼吸点；这是左栏 / 标签栏 / 右栏导航共用的唯一实现。
  assert.match(dot, /animate-ping rounded-full bg-red-500/);
  assert.match(dot, /export function WatchdogDot/);
  assert.match(dot, /export function TabStatusLight/);

  // 左栏：stalled → 红呼吸；running → 蓝色静态；空闲 → 不渲染。
  const tree = read("components/session-sidebar/SessionTree.tsx");
  assert.match(tree, /useSessionStatusDot\(session\.id\)/);
  assert.match(tree, /<StatusPointer tone=\{statusDot\.tone\} text=\{statusDot\.tooltip\} \/>/);
  assert.equal(tree.includes("sidebar-session-status-dot"), false, "旧 CSS 灯已废弃");

  // 悬浮提示：一行小字「系统检测到该任务已停滞 N 秒」，fix 定位避免被 overflow 裁掉。
  assert.match(dot, /系统检测到该任务已停滞 \$\{task\.idleSeconds\} 秒/);
  assert.match(dot, /role="tooltip"/);
  assert.match(dot, /pointer-events-none fixed/);
  assert.match(dot, /onMouseEnter/);
  // 标签栏与右栏导航复用同一个红点 → 三处 tooltip 文案天然一致。
  assert.match(dot, /text=\{stallTooltip\(task\)\}/);

  // 中间标签栏：看门狗红灯优先，否则回落到原有活动灯。
  const tabs = read("components/SessionTabBar.tsx");
  assert.match(tabs, /<TabStatusLight\s+sessionId=\{tab\.sessionId\}/);

  // 右栏导航徽标只看当前激活会话：不得再去扫别的会话。
  const panel = read("components/watchdog/WatchdogPanel.tsx");
  assert.match(panel, /<WatchdogDot sessionId=\{sessionId\} \/>/);
  assert.equal(panel.includes("state.tasks.some"), false, "后台会话只由左栏红点提示");
});

test("watchdog panel is the single heavy subscriber and intervenes via RPC", () => {
  const src = read("components/watchdog/WatchdogPanel.tsx");
  assert.match(src, /useWatchdogStore\(\)/);
  assert.match(src, /useTicker\(active\)/, "心跳用本地时钟，不额外发请求");
  assert.match(src, /requestIntervention\(sessionId, actionType\)/);
  assert.match(src, /actionType === "skip"\s*\? "正在发送跳过指令…"/);
  // 不允许任何模型直连（fetch 只能打本地 API 路由）。
  assert.equal(/api\/(chat|completions|responses)/.test(src), false);
});

test("ask is split into a token-cheap brief ask by default", () => {
  const panel = read("components/watchdog/WatchdogPanel.tsx");
  // 默认按钮：极简询问；可选按钮：深度诊断。
  assert.match(panel, /label=\{pending === "ask_brief" \? "发送中…" : "极简询问"\}/);
  assert.match(panel, /onClick=\{\(\) => void send\("ask_brief"\)\}/);
  assert.match(panel, /label=\{pending === "ask" \? "发送中…" : "深度诊断"\}/);
  assert.match(panel, /onClick=\{\(\) => void send\("ask"\)\}/);
  assert.equal(panel.includes("询问原因 (Ask)"), false, "旧的一键长追问已下线");

  // 极简提示词：禁工具 + 限一句，且比深度诊断短得多。
  const host = read("agent-host/intervention.ts");
  assert.match(host, /export const BRIEF_ASK_INSTRUCTION =[\s\S]*?请勿执行任何新工具核实/);
  assert.match(host, /请直接用一句话（20字以内）告诉我：你卡在哪个工具了，是否需要我帮你跳过？/);
  // 回归：介入后必须继续原任务，否则模型答完就把原任务结束掉。
  assert.match(host, /不要结束本轮/);
  assert.match(host, /if \(action === "ask_brief"\) return BRIEF_ASK_INSTRUCTION;/);

  // 三种动作都要能在契约层 / 校验层通过，否则前端发出去会被打回。
  const contract = read("contract/domains/watchdog.ts");
  assert.match(contract, /InterventionActionType = "skip" \| "ask" \| "ask_brief"/);
  assert.match(host, /value === "ask_brief"/);
  const route = read("app/api/agent/[id]/intervene/route.ts");
  assert.match(route, /actionType !== "ask_brief"/);
});

test("stall threshold dropdown configures the host at runtime, not via a config file", () => {
  const panel = read("components/watchdog/WatchdogPanel.tsx");
  assert.match(panel, /STALL_MS_PRESETS\.map/, "下拉框只露出 15/30/60/90 秒预设");
  assert.match(panel, /configureStallMs\(next\)/);
  const hook = read("hooks/useWatchdogStatus.ts");
  assert.match(hook, /export const STALL_MS_PRESETS = \[15_000, 30_000, 60_000, 90_000\]/);
  assert.match(hook, /method: "POST"/);
  const route = read("app/api/watchdog/route.ts");
  assert.match(route, /call\("watchdog\.configure"/, "仍然走 Host RPC，不在 Next 侧维护阈值");
  assert.equal(hook.includes("writeFile"), false, "阈值不落盘（重启后回落到默认 20s）");
});

test("interventions go through the local proxy route, not the model", () => {
  const hook = read("hooks/useWatchdogStatus.ts");
  assert.match(hook, /\/api\/agent\/\$\{encodeURIComponent\(sessionId\)\}\/intervene/);
  assert.match(hook, /refreshWatchdog\(\);/, "介入成功后立刻刷新，红灯不用等下一个周期");
  const route = read("app/api/agent/[id]/intervene/route.ts");
  assert.match(route, /call\("agent\.intervene"/);
  assert.equal(route.includes("prompt("), false);
});

test("server wires agent.intervene to the testable orchestrator", () => {
  const server = read("agent-host/server.ts");
  assert.match(server, /case "agent\.intervene"/);
  // 回执必须同步：受理完立刻 result()，投递在后台推进（否则按钮会等工具跑完）。
  assert.match(server, /const accepted = acceptIntervention\(\{ sessionId, actionType \}\)/);
  assert.equal(server.includes("await performIntervention("), false, "投递不得进入回执路径");
  assert.match(server, /void session\.deliverIntervention\(accepted\.message\)/);
  assert.match(server, /shouldInterruptTool\(actionType, accepted\.task\?\.tools\)/);
  assert.match(server, /isInterventionAction\(actionType\)/);
  // 参数非法时必须在进 Host 之前就被打回。
  assert.match(server, /actionType must be 'skip' \| 'ask' \| 'ask_brief'/);
});

test("host-side intervention reuses existing queues only", () => {
  const rpc = read("agent-host/rpc-manager.ts");
  assert.match(rpc, /async deliverIntervention\(message: string\)/);
  assert.match(rpc, /this\.inner\.steer\(message\)/);
  assert.match(rpc, /this\.followUpQueue\.prepend\(/);
  assert.match(rpc, /this\.inner\s*\.prompt\(message\)/);
  const queue = read("agent-host/follow-up-queue.ts");
  assert.match(queue, /prepend\(item: QueuedFollowUp\)/);
});

test("concurrent tools are aggregated in the panel and tracked per tool-call in the host", () => {
  const panel = read("components/watchdog/WatchdogPanel.tsx");
  assert.match(panel, /const tools = task\?\.tools \?\? \[\]/, "面板必须逐个列出并发工具");
  assert.match(panel, /toolSummary\(task\)/, "心跳要有「N 个工具执行中」的聚合文案");
  assert.match(panel, /tool\.overThreshold/, "超阈的工具要单独标红");
  assert.match(panel, /livenessSeconds\(task, now\)/, "最后活动用 liveness 而不是 progress 计时");

  const tracker = read("agent-host/progress-tracker.ts");
  assert.match(tracker, /runningTools: RunningTool\[\]/, "并发工具必须逐个登记");
  assert.match(tracker, /tool_execution_start/, "start 事件要建条目");
  assert.match(tracker, /hasBlockedTool/, "任一工具超阈即可判卡顿");

  const watchdog = read("agent-host/watchdog.ts");
  assert.match(watchdog, /const needed = blockedTool \? 1 : config\.stallScans/);
  assert.match(watchdog, /activeToolCount: tools\.length/);
});
