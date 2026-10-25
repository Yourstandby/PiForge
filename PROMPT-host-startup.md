&#x20;任务：把 PiForge 0.9.1 的 agent-host 冷启动从 32s 压到 ≤5s



\## 背景（已实测，不要重新论证）



PiForge 0.9.1（`C:\\Program Files\\PiForge`，pi SDK 1.4.0）冷启动实测：



```

11:30:09.951  Startup timing: app ready                  elapsed 0ms

11:30:09.983  Startup timing: agent host spawned          elapsed 34ms

11:30:10.166  Startup timing: loading static app url      elapsed 217ms

11:30:11.985  Startup timing: static app url loaded       elapsed 2037ms   ← UI 已经可用

11:30:29.998  Agent Host still booting after soft timeout timeoutMs=20000

11:30:32.2xx  Static app API request failed ×7（connect failed）

11:30:41.899  \[AgentHost] heap flags: limitMb=204 totalAvailableMb=178     ← host 第一行日志

11:30:41.945  Startup timing: agent host ready            elapsed 31997ms

```



对比基线：

\- PiForge 0.9.0：`agent host startup finished` 10,147ms（走 Next server，13.5s 才显示 UI）。

\- Pi Agent Desktop 0.4.0：app ready → agent-host ready 中位 3.43s（n=17，范围 1.62–9.34s）。



已确认的事实：

1\. \*\*32s 全部发生在 agent-host 子进程内部，且在它输出第一行日志之前\*\*（spawn 09.983 → heap flags 41.899 = 31.9s）。Electron/UI/网络不是瓶颈。

2\. host 入口是未打包的 ESM：`C:\\Program Files\\PiForge\\resources\\standalone\\agent-host\\index.js` 仅 32 字节，实际加载 `standalone\\node\_modules` \*\*20,239 个文件 / 143MB\*\* 的模块图。

3\. 该次启动发生在安装完成后约 3 分钟（安装目录 mtime 19:23–19:27，启动 19:30），伴随 Windows Defender 首次扫描与冷文件缓存。

4\. host 堆被限制在 204MB（`totalAvailableMb=178`），加载期 GC 更频繁。

5\. 该次日志只覆盖一次 0.9.1 启动，因此"首启税"与"结构性加载开销"的占比\*\*尚未分离\*\*——这是本任务的第一步。



\## 目标（按优先级）



|

\#

|

&#x20;目标 

|

&#x20;验收阈值 

|

|

\---

|

\---

|

\---

|

|

&#x20;G1 

|

&#x20;host ready（app ready 起算） 

|

&#x20;连续 3 次冷启动 p50 ≤3.0s、p95 ≤5.0s 

|

|

&#x20;G2 

|

&#x20;首次安装后首启（Defender 未扫描过） 

|

&#x20;≤8.0s 

|

|

&#x20;G3 

|

&#x20;UI 可交互（static app url loaded） 

|

&#x20;≤1.5s，不因改动回退 

|

|

&#x20;G4 

|

&#x20;首个用户请求不出现 

`connect failed`

&#x20;/ soft timeout 

|

&#x20;0 次 

|

|

&#x20;G5 

|

&#x20;功能无回退 

|

&#x20;会话加载、11 工具、fleet/orchestrator、watchdog、process 家族、MCP、usage-log 全部照常 

|



\## 约束



\- 安装版是打包产物，\*\*不要直接改 `C:\\Program Files\\PiForge` 下的文件\*\*。在仓库里的 `.ts` 源头改，走正常构建 + 打包 + 安装流程，再用日志复测。

\- 不改变对外契约：工具名、参数形状、UI 协议、session 文件格式、`Startup timing:` 日志字段名全部保持。

\- 只在 Windows 上验收；不要引入需要 Linux 才能构建的步骤。

\- 禁止用"看起来更快"当结论：每次改动都要有日志里的毫秒数。



\## 第 0 步：先测量，再动手（必须产出阶段表）



1\. 定位 host 启动路径：在仓库里检索 `heap flags`、`agent-host ready`、`websocket bus listening`、`api client prewarmed`，确认这些字符串分别打在哪个函数、模块加载顺序如何。

2\. 在 host 进程内加入\*\*阶段打点\*\*，输出到同一份 `main.log`（形如 `\[AgentHost] \[phase] <name> ms=<n>`），至少覆盖：

&#x20;  - `process.start`（`process.uptime()` 反推）→ 模块图加载完 → 配置读取（`models.json`/`settings.json`）→ 插件/扩展发现（`\~/.pi/agent/extensions`、`\~/.pi/agent/npm`）→ pi SDK 初始化 → toolchain 扫描（日志里 `toolchain scan ... candidates=16`）→ MCP 连接 → bus/pipe 监听 → ready。

3\. 用 3 次冷启动产出阶段表（每次重启前记录起点），把 31.9s 拆成"Node/V8 启动 / ESM 图加载 / 插件发现 / 扫描 / 其他"。\*\*没有这张表就不要改代码。\*\*



参考定位入口（先用它们验证你的理解，不要照抄）：

```

resources/standalone/agent-host/index.js          # 32 字节入口

resources/standalone/agent-host/lib/              # host 实现

%APPDATA%\\piforge\\logs\\main.log                   # Startup timing / AgentHost 日志

```



\## 第 1 步：按证据修，从最可能到最不可能



按阶段表的结果选择，不要全部一起上：



1\. \*\*未打包的 ESM 模块图\*\*（最可能）：把 agent-host 用 esbuild 打成单文件（保留 `next`/静态 UI 侧不变），或改为 Node SEA / 预编译快照。验收时对比"文件数"与"加载毫秒数"。

2\. \*\*插件/扩展在 ready 之前同步加载\*\*：把扩展发现、`\~/.pi/agent/npm` 扫描、MCP 连接移到 ready 之后异步完成；ready 前只加载核心四件套所需模块。

3\. \*\*toolchain 扫描阻塞 ready\*\*：日志显示 `toolchain scan candidates=16` 周期性执行，确认它是否在 ready 路径上；改成就绪后首帧空闲时执行，后续增量。

4\. \*\*堆上限 204MB 导致加载期 GC\*\*：核对 `limitMb=204 / totalAvailableMb=178` 的计算逻辑（`PIFORGE\_HOST\_HEAP\_\*` 环境变量），给出在 16GB 机器上的合理上限（如 512MB–1GB），并验证 `--max-semi-space-size` 是否被正确传入（日志里 `execArgv=\[]` 说明当前没传）。

5\. \*\*首启 Defender 扫描\*\*：如果阶段表显示大量时间在"文件读取"而非"JS 执行"，给出可落地缓解（如安装时向 Defender 注册排除项的引导提示，或减少需要读取的文件数——最终仍以第 1 项打包为主）。



\## 第 2 步：验收（可执行，不接受口头结论）



1\. 写 `bench/startup\_stats.py`（或 .ps1）：解析 `%APPDATA%\\piforge\\logs\\main.log`，输出每次启动的 `app ready → agent host ready`、`spawn → heap flags`、`app ready → static loaded`，以及阶段表。

2\. 至少 3 次重启（每次间隔 ≥30s）产出 p50/p95；再做一次"重装后首启"（卸载→安装→立刻启动）验证 G2。

3\. 回归清单逐项跑一遍并记录证据：

&#x20;  - 新会话首问返回正常，日志无 `connect failed`；

&#x20;  - 会话加载 `\[session-load] ... elapsed` 正常；

&#x20;  - 11 个工具全部可调用（含 `browser`、`fleet`、`orchestrator`、`tool\_search`、`tool\_history\_get`）；

&#x20;  - `process\_start/read/wait` 家族可用；

&#x20;  - watchdog 面板有数据；`usage-log.jsonl` 每条轮次继续写入。

4\. 把前后对比写进 `D:\\Pi\\PiFo\\BENCH-2026-10-24.md` 的"启动"小节（替换单次 32s 样本），保留原始日志片段。



\## 交付物



1\. 代码改动（diff），每条改动对应阶段表里的一段耗时。

2\. 阶段表：改前 / 改后，单位 ms，含 3 次样本。

3\. `bench/startup\_stats.py` + 使用说明一行命令可复现。

4\. 回归证据清单（命令 + 输出摘要）。

5\. 一句话根因结论：32s 中 X% 是 A，Y% 是 B，Z% 是首启税。



\## 不要做的事



\- 不要用"减少功能"换启动速度（除非单独提案并标注代价）。

\- 不要只改 Electron 侧等待逻辑（如把 soft timeout 从 20s 调到 60s）冒充修复。

\- 不要在安装版 asar/chunk 上打补丁。

\- 不要在没有阶段表的情况下宣称"已优化"。

