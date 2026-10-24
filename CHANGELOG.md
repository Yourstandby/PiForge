# Changelog

迁移条目按「改了什么 / 默认行为变没变 / 开关怎么用」组织。详细数据见 `docs/measurements/`
（三个口径：记录型 provider、真实 deepseek 会话、重复场景 A/B，三者不要混读）。

## 未发布 — 调用压缩（工具调用次数 / 思考预算）

主题：**同样的任务少问几轮**。不删工具、不降能力，只压缩「模型往返次数」和「thinking 占 output」。

### 改了什么

- **codemode 默认开启，且默认 `only`**（`lib/desktop-settings.ts`）：普通工具不再声明给模型，
  改由一次脚本批量调用（`createCodemodeExtension({ mode })` 下发，**不写** `~/.pi/agent/settings.json`）。
  `agent.updateCodemode` 契约新增可选 `mode`，设置页切换后下一条消息生效（SDK 的 `getMode` 惰性读取）。
- **提示词新增四条批量/预算约束**（`agent-host/prompts/output-style.ts` 的 `BATCHING_RULES`）：
  批量优先、先引用后补测、调用预算（≤15 次模型调用 / ≤45 次工具调用，接近上限先交付结论再问）、
  报错先读完 traceback 再改。纯静态常量，只进一次前缀。
- **截断续读引导改写**（`agent-host/tool-output-budget.ts`）：从「grep/sed 逐段读」改成
  「一次 codemode 脚本批量读，或用 `tool_history_get` 翻页」。只在被截断时出现，稳态零成本。
- **Host 首次启动补写 `defaultThinkingLevel: "low"`**（`agent-host/settings-defaults.ts`）：
  只在该键缺失时写一次，原子写，解析失败即放弃；之后在常规设置里改回来即可。
  不写 `thinkingBudgets`——pi 的 low 预算本来就是 2048。

### 默认行为变没变

变了，三处：新会话默认走 codemode（可在「扩展与 MCP → Codemode」关掉或切回「照常声明工具」）；
新会话默认思考等级 low（常规设置可改）；首次启动会写一行 `defaultThinkingLevel`。
工具集、审批策略、工具输出预算、`onDemandDomains` 均未改动。

### 开关怎么用

- 关掉批量层：「扩展与 MCP → Codemode」开关置为关闭（工具恢复直呼，脚本仍可用）。
- 只想让工具照常声明、不要 `only`：同页「工具呈现方式」选「照常声明工具」（`codemodeMode: "on"`）。
- 思考预算：常规设置 → 默认思考等级（写回 `~/.pi/agent/settings.json`）。

## 未发布 — 夜晚模式

### 改了什么

- 常规设置新增「夜晚模式」：跟随系统 / 浅色 / 深色，写入 `localStorage["pi-theme"]`，
  `<html data-theme>` + `color-scheme` 由内联启动脚本先落一次（无闪烁），
  `components/ThemeBoot.tsx` 挂载后校正并在「跟随系统」时监听 `prefers-color-scheme`。
- `app/globals.css`：新增 `:root[data-theme="dark"]` 令牌组（`--color-*` 与旧 `--bg/--text` 系列）；
  规则区里写死的浅色字面量统一换成令牌；历史组件里的 `bg-white` / `bg-[#hex]` 等字面量由
  文件末尾的映射表兜底（`scripts/gen-dark-remap.mjs` 生成）。
- 顺手修掉两处硬编码浅色：`components/FilePanel.tsx` 的 `explorerTokens`（行内覆盖了全局令牌，
  导致文件树在夜晚模式下仍用深色字）；`ChatSurface` 空会话画布改用 `--empty-canvas`。

### 默认行为变没变

没变：默认仍是浅色霜蓝（`system` 时按系统偏好）。不想要夜晚模式可忽略该设置项。

## v0.9.2 — agent-host 冷启动 bundle · 上下文硬顶随窗口缩放

主题：**冷启动从 32s 回到秒级**。host 打单文件 bundle，上下文预算改成跟模型窗口联动。

### 改了什么

- agent-host 打 esbuild 单文件 bundle（`agent-host/bundle/host.mjs`）：冷启动不再逐文件解析
  5,917 个 ESM 模块（图加载 3.1–3.5 s → 0.70–0.74 s）。缺 bundle 时自动回退逐文件树。
- 新增零依赖阶段打点（`agent-host/host-phases.ts`，`[agent-host] [phase] <name> ms=<n> delta=<n>`），
  `bench/startup_stats.py` 解析 `main.log` 出每次启动的 p50/p95 与阶段表。
- **压缩策略默认交回 pi**：不再注册 PiForge 自研的桌面压缩扩展，触发与摘要都走
  pi 原生 `shouldCompact` + `DEFAULT_COMPACTION_SETTINGS`（reserve 16k / keepRecent 20k）。
  自研的「窗口 / 预算 / 硬顶」触发只在 `PIFORGE_DESKTOP_COMPACTION=1` 时接管，
  代码与单测保留，随时可 A/B。
- 预算提示从百分比改为 `已用 / 窗口 token`，分母只有模型窗口，不掺任何压缩硬顶。
- 消息区懒渲染改双阈值滞回（水合 1200px / 卸载 2000px，单阈值会在边界反复抖），
  上滚即锁住贴底接管，解除点是真正距底 < 40px。

### 默认行为变没变

- 工具名、参数形状、UI 协议、session 文件格式、`Startup timing:` 字段名全部未变。
- 默认压缩**完全由 pi 决定**（窗口 − 16k reserve，保留最近 20k token）；PiForge 侧
  不再有任何绝对 token 硬顶，也不再抢占 `session_before_compact` 改写摘要。
- 打包产物多一个 `resources/standalone/agent-host/host.mjs`（约 15 MB）；
  `standalone/node_modules` 仍保留（Next standalone 与用户扩展还在用它）。

### 开关怎么用

- 回到逐文件入口：删掉 `agent-host/bundle/host.mjs` 后重跑 `npm run build:standalone`，自动回退。
- 单独重打 bundle：`npm run bundle:agent-host`；只测启动：`python bench/startup_stats.py`。
- `PIFORGE_DESKTOP_COMPACTION=1` → 回到自研压缩触发（窗口 3 轮 / 45% 预算 / 120k 硬顶 + 四段式摘要）；
  不设 = 交给 pi 原生策略。

### 数字

| 项 | 改前 | 改后 |
| --- | --- | --- |
| host ready（app ready 起算） | 2670 / 2796 ms | **1194 / 1064 / 867** → p50 1064、p95 1194 |
| ESM 模块图加载 | 3.1–3.5 s（5,917 文件） | 0.70–0.74 s |
| UI 可交互（static app url loaded） | p50 982 ms | p50 785 ms |
| 全新拷贝 + 全新 userData 首启（G2 代理） | — | 1799 ms |
| 单测 | — | 1 398 项：1 394 通过 / 0 失败 / 4 跳过 |

详细阶段表与前后对比见 `docs/releases/v0.9.2.md` 与 `docs/optimizations/host-cold-start-bundle.md`。

## v0.9.1 — 子 Agent 轮数阀门修复 · 输出契约 · Pi 核心 1.4.0

主题：**子 Agent 不再两轮被判死**。只改阀门、结算顺序与失败回包，不动并行架构与提示词契约。

### 改了什么

- 子 Agent 轮数上限 **3 → 6**（`PIFORGE_SUBAGENT_MAX_TURNS` 可覆盖），判据修成 `used <= maxTurns`，
  第 `maxTurns+1` 轮才拦；结算顺序改为「空转 → 上下文 → 轮数」，让 progress-guard 有机会生效。
- `ok:false` 回包改为结构化 `need_help`（turns / last_action / reason / next_steps），不再只剩 `Cancelled`。
- 子 Agent 输出契约固化：`patch` 必须是可 `git apply` 的 diff；JSON 只约束最终回复；
  `PIFORGE_SUBAGENT_PROMPT=legacy|contract`（默认 `contract`）可回退。
- Pi 核心 `@earendil-works/pi-*` 1.1.0 → 1.4.0（精确锁定）；接口适配只落在 `agent-host/sdk-adapter.ts`。
- 新增每周自动升级雷达 `.github/workflows/pi-auto-upgrade.yml`（只提 PR，不发版）。

### 默认行为变没变

- 前缀 6 640 tok（干净基线 6 240，本机带 `~/.agents/skills`）、11 个工具、核心四件套 710 tok 均未变。
- 子 Agent 默认契约从「散文 + 3 轮」变为「可应用补丁 + 6 轮」，这是本版唯一有感的默认变化。

### 开关怎么用

- `PIFORGE_SUBAGENT_MAX_TURNS=3` → 回到旧上限；不设 = 6。
- `PIFORGE_SUBAGENT_PROMPT=legacy` → 回到旧提示词；不设 = contract。
- 常驻舰队（`herdr_*`）不受上限约束（`maxTurns = null`）。

详细说明与验证数据见 `docs/releases/v0.9.1.md`。

## v0.9.0 — Watchdog 零 Token 监控 · 人工介入 · 用量条

主题：**卡住看得见，介入点一下**。监控与介入全部在程序层，不产生任何 LLM 请求；
前缀、核心四件套、命中率三个硬数字保持不变。

### 新增

- **无进展看门狗（Watchdog）**：`agent-host/watchdog.ts` + `progress-tracker.ts`，定时器 + 内存
  状态机，**零模型调用、零 prompt 注入**（通知只进内存环形队列，`watchdog.status` 只读回给 UI）。
  两把尺子：`lastActivityAt`（有效进展：成功且不重复的动作 / 正文增量）与 `lastLivenessAt`
  （活的迹象：含工具启动与流式输出）；并发时每个工具按 `toolCallId` 独立建档。
  **默认行为变了：默认开启**（`PIFORGE_WATCHDOG=0` 可完全关闭）。
- **人工介入（HITL）**：`agent.intervene` 三档动作 `skip`（强制跳过）/ `ask_brief`（极简询问，
  默认）/ `ask`（深度诊断），复用既有 steer → 队首排队 → prompt 三条通路，不新增模型直连。
  **默认行为没变**：不点按钮不会发出任何指令。
- **右侧「系统监控」面板**（`components/watchdog/`）：心跳、逐工具计时、疑似阻塞点、退避通知、
  JSON 详情、停滞阈值下拉框；另有三处只读状态灯（会话列表 / 标签栏 / 工具卡）。
  **默认行为变了：面板标签新增一项**（其余面板不变）。
- **用量条 `UsageStrip`**：Token / 缓存命中 / 上下文占用 / 上游额度常驻输入框下方，点开仍是原
  「用量与额度」弹窗。**默认行为变了：统计从底栏迁到输入框下方**（统计位置变化，底栏只留模式与项目名）。
- **窄视口浮层侧栏**：视口 ≤ 1080px 时左右栏改为浮层并默认收起。
  **默认行为变了：仅窄窗口**；宽窗口仍是三栏常驻。

### 变更

- 上游额度只请求一次：`ChatSurface` 拉取后经 props 下传给用量条与弹窗（原先底栏与弹窗各拉一次）；
  `useUpstreamUsage` 另加 `options.enabled` 开关备用（当前无调用方传 false）。
  **默认行为没变**，只是少一次同源请求。
- 思考档位菜单 3 → 4 档（`auto` / `high` / `medium` / `low`），不再按模型能力过滤，不支持的
  档位由后端收敛。**默认行为变了：菜单多出「低质量（low）」**；老会话持久化的 `off/minimal/
  xhigh/max` 仍正常回显。
- 会话状态灯优先级：看门狗红（停滞）> 运行中蓝 > 等待操作琥珀 > 后台完成绿。
  **默认行为没变**，只是停滞时灯变红。
- 停滞阈值可在面板运行期切换（15 / 30 / 60 / 90 秒），只写 Host 内存配置：不重建定时器、
  不重置任务、不产生通知（Host 侧钳制在 5s–10min）。

### 修复

- 图片灯箱「复制」此前永远显示失败：Chromium/Electron 的 `clipboard.write` 只接受
  `image/png`，现在先把当前图重绘成 PNG 再写剪贴板。
- 灯箱优先显示原图（`previewUrl`）而不是发给模型的降采样版本（长边 1568），大图不再糊。
- 灯箱右键菜单 `Esc` 先关菜单再关查看器；工具栏在 Electron 窗口拖拽条下让位（Windows/macOS 分别留白）。
- **其他 / 护栏**：`smoke:agent-host` 增加 `watchdog.status`、`watchdog.task`、`agent.intervene`
  断言（默认阈值 20s、非法 action 拒绝、会话不存在拒绝）；`prefix-measure` 支持
  `anthropic-messages` 形状的探针（缓存断点验证）；新增看门狗 / 介入 / 进度追踪 / 面板 / 路由单测。

### 迁移

- **无强制动作**。默认前缀、核心四件套、声明工具数、命中率均未变（见下表）。
- 想完全回到 v0.8.2 行为：`PIFORGE_WATCHDOG=0`（不建定时器、不记状态，`watchdog.status`
  只回 `{ enabled: false }`）＋ `PIFORGE_ON_DEMAND_DOMAINS=0`（全部工具常驻，前缀回到 6 988）。
- **v0.8.3 未单独发布**，其改动（工具合并 23 → 12、按需域、结果去重、缓存保活）随本版一起
  发布；该部分的迁移说明见下方 v0.8.3 小节。
- **不在本版**：工作区里未提交的自动更新（`electron/app-update*`、`auto-update-controller`、
  `hooks/useAppUpdater`、`components/AppUpdateRow`）与流式合帧
  （`hooks/agent-session/frame-coalescer.ts`）仍是 WIP，未进入 v0.9.0，也没有默认开关。

### 数字（与 v0.8.3 一致，无回归）

| 项 | v0.8.3 | v0.9.0（默认） | 口径 |
| --- | --- | --- | --- |
| 静态前缀 | 6 244 | **6 244**（记录型复测 6 240，±4 为仓库文档体积） | 记录型 provider |
| 声明工具数 | 11（`shell` 按需）/ 12（全常驻） | **11 / 12**（不变） | `measure:prefix` |
| 核心四件套 | 710 tok | **710 tok** | `measure:prefix` |
| 稳定段命中率 | 99.5% / 97.98% | **99.5% / 97.98%** | 记录型 / 真实 deepseek 30 轮 |
| 自动压缩 | 关闭 | **仍然关闭** | `rpc-manager.test.ts` |

### 验证

- `npx tsc --noEmit` 0 错；`npm run lint` 0 error（4 warning）。
- `npm run smoke:prefix-budget` 退出码 0（默认 6 240 / 11 工具 / 核心 710；3 轮 cacheRead 命中 99.5%）。
  口径注意：`HOME` 下若有 `~/.agents/skills`，`<skills>` 段会进 system prompt（+1 598 字符 ≈ +400 tok →
  prefix 6 640），属于环境差异，不属于代码回归；上表数字取清空技能目录后的口径。
- `npm test` 1 253 项：1 248 通过、3 项按平台跳过。另有 2 项失败位于**未跟踪的 WIP 测试**
  （`electron/auto-update-controller.test.ts` 缺 `.ts` 后缀的 import、`lib/agent-host-client.test.ts`
  等待尚未实现的握手重试），不属于本版改动。

## Unreleased — v0.8.3（随 v0.9.0 一起发布，见上）

### 改了什么

- **工具合并 23 → 12**：20 个扩展工具按域收成 5 个多态工具（`browser` / `shell` / `fleet` /
  `orchestrator` / `memory`，用 `action` 分派），核心四件套 `read`/`bash`/`edit`/`write`
  的 schema 不变（710 tok）。旧工具名仍可被工具内部调用，UI / 审批 / i18n 沿用旧名。
- **缓存保活与首轮预热**：CacheWarming 首次真正接到设置上（桌面默认 `idle`），设置页显示
  实际生效的模式与状态；恢复会话时用 `maxTokens:1` 预放一次前缀（实测预热只花 16 tok）。
- **工具结果去重**：同文件同区间的重复 `read`、同命令的重复 `bash` 不再整段回放
  （相同输出一句话、输出变长只回尾部差异）；错误与非零退出永远完整返回。
- **按需工具域**：中频域 `shell` 默认不声明，首次用时 `tool_search` 激活后常驻；
  `tool_search` 只返回可调用的 wire name，并按 canonical 顺序重排 active（消除激活时的一次额外前缀写入）。
- **设置页「按需工具域」多选**：写 `desktop-settings.json` 的 `onDemandDomains`，
  显示实际生效列表与来源。

### 默认行为变没变

| 项 | v0.8.2 | v0.8.3（默认） |
| --- | --- | --- |
| 声明工具数 | 23 | **12**（其中 `shell` 首次使用时激活） |
| 静态前缀 | 8 146 tok | **6 244 tok**（核心四件套 710 不变） |
| 缓存保活 | UI 显示假 `off`，实际未接管 | 桌面默认 `idle`，设置页显示真实状态 |
| 工具结果 | 重复内容整段回放 | 重复内容去重，错误完整 |
| 自动压缩 | 关闭 | **仍然关闭**（无自动压缩） |

### 开关怎么用

`PIFORGE_ON_DEMAND_DOMAINS`（环境变量）与设置项 `onDemandDomains`：

| 取值 | 含义 |
| --- | --- |
| `0` | **全部常驻**（想回到「每轮都带完整 schema」就用这个） |
| `1` | **兼容别名**：`memory` + `orchestrator` 按需（不是「全按需」，这是第 3–5 步的历史语义） |
| `shell` / `browser,shell` | 显式列表：列出的域按需，其余常驻 |
| 未设置 | 读设置项 `onDemandDomains`；设置项也没写过 → 默认 `shell` |

- **优先级：环境变量 > 设置项 `onDemandDomains` > 默认值（`shell`）**。
  环境变量存在时设置页的勾选被禁用，并提示来源。
- 默认只有 `shell` 按需；`memory` / `orchestrator` 实测按需是负收益，**默认常驻**；
  勾选它们只给黄色提示，不禁止。
- 设置项改动**对新建会话生效**，当前会话需重新加载。
- 老用户如果之前用过 `=1`：行为不变（一直是 memory + orchestrator）。
