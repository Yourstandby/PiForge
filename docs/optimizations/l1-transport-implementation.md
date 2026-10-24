# L1 传输层落地报告：双实现（默认仍 utility）

> 代码：`electron/host-launcher.ts`（决策/拼装）+ `electron/main.ts`（启停）+ `agent-host/index.ts`（stdin 通道）
> + `agent-host/child-env.ts`（受管进程环境清理）+ `contract/host-stdin.ts`（关闭协议）。
> 开关：`PIFORGE_HOST_TRANSPORT=utility|node`，**默认 utility，未切默认**。
> 验收基调：**先按同一口径比（都加载同样东西），再下结论** —— 上一轮的探针结论就栽在口径上（见 §1）。

## 0. 口径更正（本轮补记，2026-10-24）

上一轮报告里有两处需要明确更正，避免以后被当成"可达目标"引用：

| 旧说法 | 实际情况 |
|---|---|
| "node 模式 116 MB vs utility 265.6 MB → −150 MB" | **不是同一件事**：116 MB 是**裸 host**（`probe-host-runtime.mjs`，只起服务 + `host.health`）；265.6 MB 是 `measure-packaged` 里**加载了 API 桥 + 会话索引 + 扩展**的 host。差值主要来自"加载 vs 未加载" |
| "220 MB 只差一点" | 220 MB 只在**轻载 + 更紧堆参数**下成立（实测 209–221 MB）；**加载 26 MB 大会话时两种传输层都是 286 MB 左右** |

更正后的真实收益（打包版、同口径、最终产物）：

| 指标 | 数值 |
|---|---|
| 轻载稳态中位 | utility 268.4 MB → **node 209.1 MB（−59 MB / −22%）** |
| 最坏情况尖峰（30 轮 soak） | utility 349.4 MB → **node 296.6 MB（−53 MB）** |
| 堆上限 | utility 352 MB（设不了新生代）→ **node 280 MB（硬上限）** |
| 门禁 | **220 MB 只适合轻载**；**稳态门禁用 240 MB**（node 实测 193–230） |

## 1. 先纠正上一轮的一个口径错误

上一轮探针给出"node 模式 116 MB vs utility 265.6 MB → −150 MB"，但那两个数**不是同一件事**：

- 探针里的 host 是**裸 host**（只起服务 + `host.health`）；
- `measure-packaged` 里的 host **加载了 API 桥、会话索引、扩展**。

所以那 −150 MB 主要来自"加载 vs 未加载"，不是传输层。本轮全部改成**打包版 + 同一命令**对比，
结论缩水但真实：**中位 −15~20 MB，尖峰 −50 MB**。

`docs/optimizations/l1-run-as-node-probe.md` 保留为"可行性验证"的历史记录，数字以本文为准。

## 2. 实现要点（对应立项时列的 4 个风险）

| 风险 | 处理 | 证据 |
|---|---|---|
| **父子消息通道**（`parentPort`） | node 模式改走 **stdin 一帧 JSON**；协议定义在 `contract/host-stdin.ts`，两侧共用（electron/ 因 rootDir 限制有一份等价实现，**单测逐字节断言两份一致**） | `contract/host-stdin.test.ts`(5) + `electron/host-launcher.test.ts`(13) |
| **生命周期** | `before-quit` 已经是"先请 host 排空再退出"；node 模式关闭 = 写 shutdown 帧 + `stdin.end()`，host 侧 `stdin end` 也触发退出（父进程死亡兜底） | 停 App 后 `Get-CimInstance` 查不到残留 host/受管进程 |
| **`ELECTRON_RUN_AS_NODE` 传染** | 只写进 host 自己的 env（`buildHostSpawnSpec`），**不写 `process.env`**；受管进程 spawn 前统一过 `managedProcessEnv()` 清理 | `agent-host/child-env.test.ts`(5) + `host-launcher.test.ts` 断言 utility 模式 env 里没有该变量 |
| **重启逻辑** | 两种句柄都走 `child.once("exit")` + 现有 `scheduleAgentHostRestart()`（`isQuitting` 守卫不变） | 手工 kill host：日志出现 "Agent Host exited"（带 `transport`）→ 自动重启 |

顺带修掉两个真问题：

1. **stdin 通道不能靠"不是 TTY"去猜**：探针/冒烟用 `stdio: ["ignore"]` 启动，stdin 会**立刻 end**，
   host 一度把它当"父进程已死"而秒退。现在由启动方显式设 `PIFORGE_HOST_STDIN_CONTROL=1`。
2. **"exited before becoming ready" 每次正常退出都误报**：两个 exit 处理器竞争，先注册的那个把
   `agentHostReady` 置 false，后注册的就以为"没就绪"。改成用本 Promise 自己的 `settled` 判定。

## 3. 实测数据（全部本机、打包版、隔离 userData）

### 3.1 空闲 / 轻载（不打开会话）

同一命令反复跑：`measure-packaged --exe release/win-unpacked/PiForge.exe --seconds 10 --settle 15`
（下面是**最终提交的打包产物**上测的；早期一版产物实测 node 228.8 / 202.3 / 220.7 / 221.4 / 196.8，同量级）

| 模式 | 逐次 host RSS (MB) | 中位 |
|---|---|---|
| utility（现状） | 257.6 / 267.9 / 259.3 / 274.0 / 266.0 / 274.3 / 272.5 / 280.2 | **268.4** |
| **node** | 192.8 / 200.5 / 205.1 / 209.1 / 218.3 / 221.2 / 230.2 | **209.1** |

→ 中位 **−59 MB（−22%）**。`--max-host-rss-mb 220` 门禁：7 次里 **4 次通过**（192.8–218.3），
3 次擦线超（221.2 / 230.2 等）。**所以是"多数通过但不稳定"，不能算稳定 PASS。**

### 3.2 加载 26 MB 真实会话（`PIFORGE_OPEN_PATH=/?session=<26MB>`）

| 模式 | 逐次 |
|---|---|---|
| utility | 279.9 / 335.4 / **286.6** MB |
| **node** | 302.9 / 294.5 / **286.3** MB |

→ 大会话下两种传输层**基本持平**（286 vs 287），且**都远超 220 MB**。
原因：老生代被压到 256 MB、新生代 8 MB，长上下文让 GC 更频繁，RSS 里 native/临时缓冲占比上升。

### 3.3 node + 更紧的堆（`PIFORGE_HOST_HEAP=semi=4,old=192`）

| 场景 | host RSS |
|---|---|
| 轻载 | **209.9 MB**（≤220 ✅） |
| 26 MB 会话 | **286.4 MB**（>220 ❌） |

### 3.4 探针（裸 host，验收项：limit 280 / RSS ≤150）

```
node scripts/probe-host-runtime.mjs
| node（基线下限）              | 280 | 136 | 136 | 2032 ms | ok |
| ELECTRON_RUN_AS_NODE=1（候选） | 280 | 116 | 116 | 1416 ms | ok |
```
→ **limit 280 MB ✅ / 空闲 RSS 116 MB ≤150 ✅**

### 3.5 30 轮 soak（node 模式，15 起停 + 15 真实会话）

```
node scripts/soak-host-heap.mjs --rounds 15 --session-rounds 15 \
  --max-host-rss-mb 340 --max-cpu 3 --env PIFORGE_HOST_TRANSPORT=node

汇总：30/30 轮有效 · host RSS 中位 275.7 MB / 最大 296.6 MB · 空闲 CPU 中位 0.38% · OOM 0 次
soak-host-heap: PASS（对 340 MB 门槛）
```
起停轮 208–237 MB，大会话轮 275–297 MB。对照上一轮 utility soak：**中位 289.5 / 最大 349.4**。

| | utility soak | node soak | 差 |
|---|---|---|---|
| RSS 中位 | 289.5 MB | **275.7 MB** | −13.8 |
| RSS 最大 | 349.4 MB | **296.6 MB** | **−52.8** |
| 空闲 CPU 中位 | 0.34% | 0.38% | +0.04pp（噪声级） |
| OOM | 0 | **0** | — |

### 3.6 受管进程级联回收

- `npm run smoke:agent-host` → **OK**（含 start/stop、日志、级联清理；顺带修掉一条 `handshaked`
  断言漂移：host 会给内部 api 客户端预热，计数是 ≥1 不是 =1）
- `npm run smoke:agent-isolation` → **OK**
- 手工：node 模式启动 App → 退出后 `Get-CimInstance` 查不到残留 `agent-host\index.js` 进程

### 3.7 token 面（必须零变化）

```
npm run smoke:prefix-budget  → exit 0
前缀合计 ≈ 6640 tok；整条请求体 ≈ 6799 tok；稳定段 cacheRead 命中率 99.6%
```

## 4. 验收结论（诚实版）

| 验收项 | 目标 | 实测 | 判定 |
|---|---|---|---|
| probe limit | 280 MB | **280 MB** | ✅ |
| probe 空闲 RSS | ≤150 MB | **116 MB** | ✅ |
| 打包版 `--max-host-rss-mb 220`（轻载） | PASS | 中位 **209.1**，7 次里 4 次过（192.8–230.2） | ⚠️ **多数通过、不稳定** |
| 打包版 `--max-host-rss-mb 220`（26 MB 会话） | PASS | **286–303** | ❌ **未达成** |
| 30 轮 soak | 0 OOM | **0 OOM**，CPU 中位 0.38% | ✅ |
| token 零变化 | 6 640 tok / 99.6% | 一致 | ✅ |
| 默认不改 | 仍 utility | 仍 utility | ✅ |

**一句话**：双实现已经可用且不劣化任何已达标项；node 传输层的真实收益是
**"轻载稳态 268 → 209 MB（−22%）、给 host 一个硬的 280 MB 堆上限、把最坏情况尖峰 349 → 297"**，
而不是"把稳态降到 150 MB"（那是裸 host 的数字）。**220 MB 目标在加载 26 MB 会话时达不到**
（两种传输层都是 286 MB 左右），这条要在决策时明确接受或改写。

## 5. 切默认的决策点（建议）

切 `PIFORGE_HOST_TRANSPORT=node` 为默认，需要**同时**满足：

1. 接受"稳态 host 仍是 ~200–300 MB"这一现实（220 MB 只在轻载 + 更紧堆参数下成立）；
2. `PIFORGE_HOST_HEAP=semi=4,old=192` 也跑满 30 轮 0 OOM（本轮只做了单次冒烟，没做 soak）；
3. 打包版在 node 模式下连续 3 次 `--max-host-rss-mb 240` 通过（实测 node 7 次全部 ≤230，
   用 240 做稳态线比 220 现实；220 只适合"轻载 + 不加载大会话"的场景）；
4. 至少一周日常使用无 host 崩溃/重启记录（`host-oom.json` 为空 + 日志无 "Agent Host exited"）。

如果只想要"行为零风险"，**继续 utility + 现在的 256 MB 老生代**也完全可以：两者差距只有 ~14 MB 中位，
真正值钱的是 node 模式可以**同时收紧新生代**（`semi=4` 时轻载 210 MB）。

## 6. 切默认（本轮，2026-10-24）

### 6.1 前置 soak（node + `semi=4,old=192`，30 轮）

```
node scripts/soak-host-heap.mjs --rounds 15 --session-rounds 15   --max-host-rss-mb 240 --max-cpu 0.5   --env PIFORGE_HOST_TRANSPORT=node --env PIFORGE_HOST_HEAP=semi=4,old=192
```

| 判据 | 目标 | 实测 | 判定 |
|---|---|---|---|
| OOM | 0 | **0**（`host-oom.json` 未生成） | ✅ |
| RSS 中位 | ≤240 MB | **216.9 MB**（逐轮 157–238） | ✅ |
| RSS 峰值 | ≤276 MB（中位 × 1.15） | 252.9 MB | ✅ |
| 空闲 CPU 中位 | ≤0.5% | **0.35%**（逐轮 0–0.68%） | ✅ |

> 顺带修了 soak 脚本的一个口径问题：它原来拿**最大值**去比中位门禁，一次 GC 抖动就能把
> 30 轮判红。现在 `--max-host-rss-mb` 是中位验收线，峰值单独用 `--max-host-rss-peak`
> （默认中位 × 1.15）。另外加了**预检**：机器上还有别的 PiForge/electron 进程就拒绝启动
> —— 实测被并发实例污染时，同样参数会从 157–221 MB 漂到 234–255 MB，CPU 也会顶穿 0.5%。

### 6.2 默认切换

| 项 | 切换前 | 切换后 |
|---|---|---|
| `PIFORGE_HOST_TRANSPORT` 默认 | utility | **node** |
| 堆默认档 | 8 / 256（utility 只能设老生代） | node：**4 / 192**；utility 保持 8 / 256 |
| utility 回退 | — | `PIFORGE_HOST_TRANSPORT=utility`（一个变量，不改代码） |

实测（打包版，默认环境变量）：

```
host 197.1 MB (gate 240, default) · 内存 831.6 MB / 5 进程 · CPU 0
主进程日志：Agent Host transport {"transport":"node", ..., "semiSpaceMb":4, "oldSpaceMb":192, "heapLimitHintMb":216}
正常退出：没有 "Agent Host exited before becoming ready"（describeHostExit 的 settled 判定生效）
```

### 6.3 门禁默认值（`measure-packaged`）

| 传输层 | 默认 `--max-host-rss-mb` | 依据 |
|---|---|---|
| node | **240 MB** | 实测 193–230，soak 中位 216.9 |
| utility | **290 MB** | 实测 258–280（含 280.1 这种擦线样本） |

大会话（26 MB 会话）场景两者都会到 ~286 MB，此时必须显式给更大的门禁 ——
`--help` 里已经写明这一条，避免下次又拿默认 240 去卡大会话。

### 6.4 回退验证

```
PIFORGE_HOST_TRANSPORT=utility ... \--max-host-rss-mb 默认 → gate 290
host 284.5 MB (gate 290, default) · 内存 918.7 MB / 5 进程   → PASS
```
退出码 0；主进程日志回到 `transport: utility` + `--js-flags=--max-old-space-size=256`。
