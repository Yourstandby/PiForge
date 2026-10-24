# PiForge 0.9.2 —— 工具调用与思考时间压缩方案（源码级）

> 目标：在不删除任何工具、不降低模型能力的前提下，把"同题模型调用次数"从 60–120 压到 ≤30、thinking 占 output 从 54–58% 降到 ≤45%，缓存命中保持 ≥96%。
> 基线数据：2026-10-23 / 10-24 本机 deepseek-flash 实测（见附录 A）。
> 版本锚点：PiForge 0.9.2 / pi SDK 1.4.0。以下路径 `<RES>` = `C:\Program Files\PiForge\resources\standalone`，对应仓库内 `standalone/…`（`.js.map` 已确认源码路径为 `lib/*.ts`、`agent-host/*.ts`）。

---

## 0. 约束（写死在方案里的红线）

| 项 | 结论 | 依据 |
|---|---|---|
| `defaultTools` | **不动**，保留 11 个工具 | `lib/domain-tools.ts` 的 5 域 + 核心 4 + tool_search / desktop_use_tool / tool_history_get，是相对 PAD 的全部差异点 |
| `onDemandDomains`（memory / orchestrator） | **不开启** | `lib/domain-tools.ts` 注释：30 轮实测多付 ~21k 未缓存 token，只省回 ~18k，净负收益 |
| `watchdog` / 审批策略 / 工具输出预算 | **不动** | 输出预算 4,000 字符 / 60 行（`agent-host/tool-output-budget.ts`）已经比 PAD 更省，再压会推高调用次数 |
| 模型 / provider | 不动 | 解码速度两边同为 160–180 tok/s，差距与模型无关 |
| system prompt 稳定性 | 只允许**一次性**变更 | `agent-host/prompt-prefix.ts`：字节级前缀变化会让整段历史按未命中计费 |

---

## 1. 改动清单（5 项，按落地顺序）

### P0-1 桌面设置默认值：开启 codemode + 默认思考预算

文件：`lib/desktop-settings.ts`（编译产物 `lib/desktop-settings.js`）

```ts
// 现状
export function defaultDesktopSettings() {
    return {
        defaultAgentMode: DEFAULT_AGENT_MODE,
        defaultToolPreset: DEFAULT_TOOL_PRESET,
        codemodeEnabled: false,
        browserReadEnabled: false,
        browserInteractEnabled: false,
    };
}

// 改为
export function defaultDesktopSettings() {
    return {
        defaultAgentMode: DEFAULT_AGENT_MODE,
        defaultToolPreset: DEFAULT_TOOL_PRESET,
        codemodeEnabled: true,        // 批量执行层默认开启
        codemodeMode: "only",         // 工具不直呼给模型，改由脚本调用
        thinkingLevel: "low",         // 默认思考预算
        browserReadEnabled: false,
        browserInteractEnabled: false,
    };
}
```

同步补 `validateDesktopSettings()`（同文件 114 行附近，照 `codemodeEnabled must be a boolean` 的写法）：

```ts
if (obj.codemodeMode !== undefined && obj.codemodeMode !== "on" && obj.codemodeMode !== "only")
    return "codemodeMode must be on|only";
if (obj.thinkingLevel !== undefined && !["off","minimal","low","medium","high"].includes(obj.thinkingLevel))
    return "thinkingLevel invalid";
```

读取点已存在，无需改调用签名：`agent-host/rpc-manager.ts:134 initPolicy(mode, preset, codemodeEnabled)`、`1098 / 1195` 从 desktop settings 取值。

### P0-2 把默认思考预算真正下发到会话

文件：`agent-host/server.ts`（编译产物 `agent-host/server.js:921`

```ts
// 现状
const thinkingLevel = typeof params.thinkingLevel === "string" ? params.thinkingLevel : undefined
...
if (thinkingLevel) await session.send({ type: "set_thinking_level", level: thinkingLevel });

// 改为：显式参数 > 桌面设置 > 不设置
const settings = defaultDesktopSettings();
const thinkingLevel =
    typeof params.thinkingLevel === "string" ? params.thinkingLevel :
    (settings.thinkingLevel ?? undefined);
if (thinkingLevel && thinkingLevel !== session.state?.thinkingLevel)
    await session.send({ type: "set_thinking_level", level: thinkingLevel });
```

同时写入 pi 侧预算（**只写一次**，不每轮写），文件：`lib/extensions-config.ts`（`settings.json` 写入点，`writeFileAtomic` 在 122 行）：

```json
{
  "defaultThinkingLevel": "low",
  "thinkingBudgets": { "low": 2048 },
  "codemode.mode": "only",
  "defaultTools": ["+codemode"]
}
```

> 只做"缺失时补写"（`if (!('defaultThinkingLevel' in data))`），避免每轮覆盖用户手改值。

### P0-3 提示词加"批量/预算"四条（静态常量，缓存安全）

文件：`agent-host/prompts/output-style.ts`（编译产物 `agent-host/prompts/output-style.js`）

```ts
export const BATCHING_RULES = [
    "批量优先：一次 codemode 脚本内完成全部读取、检查、分支与并行调用，禁止逐个工具串行调用。",
    "先引用后补测：已有测量、历史结论、文档中已存在的数字直接引用，禁止重跑；只补缺口。",
    "调用预算：同一任务 ≤15 次模型调用；达到预算先交付结论，再申请继续。",
    "报错先读完整 traceback 再改；同一命令禁止原样重试。",
];
```

在 `agent-host/desktop-output-style-extension.ts` 里与现有 guidelines 合并（该扩展已在 `before_agent_start` 注入，天然只进一次前缀）：

```ts
const missing = [...OUTPUT_STYLE_GUIDELINES, ...BATCHING_RULES]
    .filter((line) => !existing.includes(line));
```

预期前缀增量：约 +260 字符（≈80 tok），一次性缓存未命中成本 < $0.0001。

### P0-4 截断提示改成"批量读取"引导（零稳态成本）

文件：`agent-host/tool-output-budget.ts:105`

```ts
// 现状
export const TRUNCATION_HINT = '如需查看完整内容，请使用 grep、sed 等工具分段读取（例：grep -n "关键词" 文件 | sed -n \'1,120p\'）。';

// 改为
export const TRUNCATION_HINT =
  '不要逐条续读：用一次 codemode 脚本批量 grep/sed 多处，或用 tool_history_get 按 offset/limit 翻页。';
```

只在该工具输出被截断时出现，稳态零 token 成本，直接打掉"read → 再 read → 再 read"的轮次链。

### P1-1 domain-tools 加"决策留痕"注释（不改逻辑）

文件：`lib/domain-tools.ts`，在 `ON_DEMAND_DOMAINS` 上方补一行：

```ts
// 2026-10-24 复核：memory / orchestrator 仍保持常驻声明。
// 按需化在 30 轮 deepseek 会话上是净负收益（+21k 未缓存 vs −18k 稳态节省）。
```

防止后续维护者顺手把这两个域改成按需，重新引入 20k 级缓存惩罚。

### P1-2（可选）超预算观测

文件：`agent-host/rpc-manager.ts`，在 usage 汇总处加一次性计数：同一 user turn 内 `assistantMessageCount > 15` 时发一条只进 UI、不进上下文的 notice（`showCacheMissNotices` 同款通道）。用于验证 P0-3 是否真的生效，不进 prompt。

---

## 2. 验收（可直接跑）

采集脚本：`D:\Pi\PAD\bench-calls.cjs`（附录 B，读 `~/.pi/agent/sessions/**` 与 `usage-log.jsonl`）。

同题口径：开新会话，输入同一句对比题，只跑首轮，记录：

| 指标 | 基线（PiForge 0.9.2） | 目标 | 硬门槛 |
|---|---:|---:|---:|
| 模型调用 / 首轮 | 43–49（10-24） | ≤30 | ≤35 |
| thinking / output | 54–58% | ≤45% | ≤50% |
| 缓存命中 | 96–99% | ≥96% | ≥94% |
| 首轮账单 | $0.0558–0.0981 | ≤$0.06 | ≤$0.08 |
| 工具调用总数 | 75–91 | 20–40 | ≤45 |
| 功能 smoke | — | 全过 | 全过 |

功能 smoke（**必须全过，证明没删功能**）：

```bash
# 1) fleet：能起子 Agent 并收摘要
# 2) orchestrator：能建 worktree（无并发时也应返回明确错误而非"工具不存在"）
# 3) memory：recall 一条已存记忆
# 4) browser：open 一个本地端口并 read
# 5) tool_history_get：对一次被截断的 bash 输出翻页
```

判定：5 项全部有真实返回才算"未降功能"；任一项报 `tool not found` 即视为方案失败，回滚 P0-1。

---

## 3. 回滚

```powershell
# 配置层（无需重装）
Copy-Item "$env:USERPROFILE\.pi\agent\desktop-settings.json" "$env:USERPROFILE\.pi\agent\desktop-settings.json.bak" -Force
# 置回 codemodeEnabled=false / codemodeMode="on" / thinkingLevel="high" 后重启应用

# 源码层
git revert <P0-1..P0-4 的提交>
```

回滚后必须**开新会话**：system prompt 前缀已变，旧会话历史会全价重算一次。

---

## 4. 风险与对策

| 风险 | 概率 | 对策 |
|---|---|---|
| DeepSeek Flash 写 codemode 脚本失败率高（>15% 脚本报错） | 中 | 保留 `codemodeMode: "on"` 作为一键回退；失败率用 P1-2 的计数观测 3 天 |
| 规则"≤15 次调用"让复杂重构提前收手 | 中 | 规则已写"先交付结论，再申请继续"，不允许直接放弃 |
| 前缀变更导致一次性全价 | 确定 | 只改一次、集中一个提交；改完不要在中途动 settings / skills（config-watcher reload 会再破一次缓存） |
| 关掉直呼后审批 UI 看不到单次工具事件 | 低 | codemode 内调用是真实调用，`desktop-approval-extension` 仍逐次触发；上线前用 browser 交互验证一次审批弹窗 |
| thinking 降到 low 后漏验证 | 中 | 用 P0-3 的"该跑的测试要跑"保留验证要求，只砍呈现冗余；对比 3 个真实重构任务的成功率 |

---

## 附录 A：基线证据

| 会话 | 应用 | 调用 | 工具 | thinking/out | 缓存 | 账单 | 账单/次 |
|---|---|---:|---:|---:|---:|---:|---:|
| `01a167dd` | PiForge | 94 | 143 | 57.6% | 99.0% | $0.1692 | $0.00180 |
| `01a167de` | PAD | 27 | 45 | 53.7% | 81.3% | $0.0909 | $0.00337 |
| `01a16814` | PiForge | 120 | 131 | 40.2% | 96.0% | $0.2631 | $0.00219 |
| `01a1680b` | PAD | 27 | 46 | 63.2% | 85.9% | $0.1257 | $0.00466 |
| `01a16db0` | PiForge 10-24 | 60 | 75 | 48.0% | 98.0% | $0.1275 | $0.00212 |
| `01a16dcb` | PiForge 10-24 | 74 | 91 | 45.7% | 98.8% | $0.0912 | $0.00123 |

结论：单次调用成本 PiForge 已优于 PAD 1.9–2.1 倍，**唯一劣势是调用次数**（3.5–4.4 倍）。本方案只打这一个指标。

## 附录 B：采集脚本 `D:\Pi\PAD\bench-calls.cjs`

```js
const fs=require('fs'),path=require('path');
const root=path.join(process.env.USERPROFILE,'.pi','agent','sessions');
const walk=(d,o=[])=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
  if(e.isDirectory())walk(p,o);else if(e.name.endsWith('.jsonl'))o.push(p);}return o;};
for(const f of walk(root)){
  const lines=fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean);
  const d={id:path.basename(f).split('_')[1].slice(0,8),req:0,tool:0,thinkChars:0,outTok:0,inTok:0,cache:0,cost:0,start:null,end:null};
  for(const l of lines){let o;try{o=JSON.parse(l)}catch(e){continue}
    if(o.type==='session'){d.start=o.timestamp;continue}
    if(o.type!=='message')continue;const m=o.message;d.end=o.timestamp;
    if(m.role!=='assistant')continue;const u=m.usage||{};
    d.req++;d.outTok+=u.output||0;d.inTok+=u.input||0;d.cache+=u.cacheRead||0;d.cost+=(u.cost&&u.cost.total)||0;
    for(const c of (Array.isArray(m.content)?m.content:[])){
      if(c.type==='toolCall')d.tool++;
      if(c.type==='thinking')d.thinkChars+=(c.thinking||c.text||'').length;
    }
  }
  const hit=d.cache/(d.inTok+d.cache||1)*100;
  console.log(d.start?.slice(0,16),d.id,`req=${d.req}`,`tool=${d.tool}`,
    `thinkTok≈${Math.round(d.thinkChars/3.2)}`,`out=${d.outTok}`,`cacheHit=${hit.toFixed(1)}%`,`$${d.cost.toFixed(4)}`);
}
```

## 附录 C：改动文件总览

| # | 文件（仓库路径） | 类型 | 影响面 |
|---|---|---|---|
| P0-1 | `lib/desktop-settings.ts` | 默认值 + 校验 | 新会话默认行为 |
| P0-2 | `agent-host/server.ts`、`lib/extensions-config.ts` | 逻辑 + 缺失时补写 | 思考预算与 codemode 模式下发 |
| P0-3 | `agent-host/prompts/output-style.ts`、`agent-host/desktop-output-style-extension.ts` | 静态常量 | 每轮前缀 +~260 字符（一次） |
| P0-4 | `agent-host/tool-output-budget.ts` | 文案常量 | 仅在截断时生效 |
| P1-1 | `lib/domain-tools.ts` | 注释 | 零运行时影响 |
| P1-2 | `agent-host/rpc-manager.ts` | 只发 UI notice | 不进上下文 |
