# L1 传输层验证：`ELECTRON_RUN_AS_NODE` 子进程（临时分支验证，未合并）

> 验证在临时分支 `probe/run-as-node` 上完成，**验证完已删分支**，只带回探针脚本与本文。
> **运行时代码一行未改** ——
> 验证脚本 `scripts/probe-host-runtime.mjs` 只是一个外部探针：启动 host、走真实
> 命名管道握手、调 `host.health`、空闲采样 RSS。
> 目标：确认"换成 `ELECTRON_RUN_AS_NODE` 子进程后，heap limit 能到 280 MB、
> 空闲 RSS 能落到 173–195 MB"。**结论：达到，而且更好。**

## 1. 为什么卡在 265 MB（上一轮的归因回顾）

`utilityProcess.fork()` 的 `execArgv` 只能带**一个** `--js-flags`：

| 机制 | host `heap_size_limit` |
|---|---|
| `execArgv: ["--max-old-space-size=256"]` | 4192 MB（不生效） |
| host 环境 `NODE_OPTIONS=…` | 被 Electron 从 utilityProcess 环境剥掉 |
| `app.commandLine.appendSwitch("js-flags", …)` | V8 已初始化，太晚 |
| **`execArgv: ["--js-flags=--max-old-space-size=256"]`** | **352 MB** ✅（现在用的） |
| `--js-flags="--max-old-space-size=256 --max-semi-space-size=8"` | 无效（Electron 重拼命令行时按空格拆开） |

所以新生代收不下去，host 停在 262–290 MB，220 MB 目标达不成。
**换传输层 = 换掉"谁给你拼命令行"这件事。**

## 2. 验证方式（不改主分支）

```bash
# 探针：自己拉 host 起来，握手 → host.health → 空闲采样 8s
node scripts/probe-host-runtime.mjs            # node 基线 + ELECTRON_RUN_AS_NODE 候选
node scripts/probe-host-runtime.mjs --json     # 机器可读
```

探针做的事：
1. 造一个随机命名管道 endpoint + token；
2. `spawn(binary, [agent-host/dist/agent-host/index.js], { env: { ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--max-old-space-size=256 --max-semi-space-size=8" } })`；
3. 等 host 打印 `[agent-host] ready`，从它自己的 `heap flags` 日志里读**真实** `limitMb`；
4. 连管道、`hello` → `{kind:"req", id:1, method:"host.health"}`；
5. 稳定 3s 后每 1s 采一次 `WorkingSet64`（PowerShell），取中位/最大。

对照组的现状数字来自同一口径的 `measure-packaged.mjs`（打包版 `utilityProcess`，host 265.6 MB）。

## 3. 实测结果

| 运行方式 | heap limit | 空闲 RSS 中位 | 空闲 RSS 最大 | ready | host.health |
|---|---|---|---|---|---|
| `utilityProcess`（现状，打包版） | **352 MB** | **265.6 MB** | 268 MB | 1 768 ms | ok |
| `node`（基线下限，同一份 dist） | **280 MB** | **136 MB** | 136 MB | 1 982 ms | ok |
| **`ELECTRON_RUN_AS_NODE=1`（候选）** | **280 MB** | **116 MB** | 116 MB | **1 506 ms** | ok |

- **heap limit 280 MB** ✅（目标是 280）：`NODE_OPTIONS` 里两个 flag 都生效了。
- **空闲 RSS 116 MB** ✅（目标 173–195 MB，还低了 57–79 MB）→ 相对现状 **−149.6 MB（−56%）**。
- ready 反而更快（1 506 vs 1 768 ms）：少了 Chromium utility 进程的脚手架。

> 口径说明：三行都是**空闲**（不打开会话）。所以是苹果对苹果：
> 现状的 265.6 MB 也是 `measure-packaged` 稳定后的空闲值。

## 4. 结论：**值得立项**

理由（按重要性）：

1. 收益明确且大：host 265.6 → 116 MB，直接跨过 220 MB 目标，总内存也能跟着降 ~150 MB；
2. 成本可控：host 本来就是**命名管道服务端**（`scripts/smoke-agent-host.mjs` 里一直用
   `node` 直接跑它），对 Electron 运行时有零依赖 —— 探针已经证明"换壳"后握手/健康检查全通；
3. 风险已知且集中在一个文件（`electron/main.ts` 的启动/关闭路径）。

## 5. 立项时要处理的风险（都是从代码里读出来的，不是猜的）

| 风险 | 现状依赖 | 处理方式 |
|---|---|---|
| **父子消息通道** | `child.postMessage({type:"shutdown"})`（`electron/main.ts`）+ host 侧 `process.parentPort`（`agent-host/index.ts`） | 改走 stdin/stdout 帧或现有管道的新方法（`host.shutdown` 已经有了）；`parentPort?.` 已经是可选调用，不会崩 |
| **生命周期** | `utilityProcess` 随 App 退出被回收 | 普通子进程需要在 `app.on("before-quit")` 显式 kill + `detached:false`；再加"父死子亡"兜底（stdin 关闭即退出） |
| **崩溃归因** | Chromium Task Manager / `serviceName` | 已经自己做了：`host-oom.json`、`isHeapExhaustion()`、`[host-cpu]` 诊断 |
| **env 隔离** | `ELECTRON_RUN_AS_NODE` 会传染给子进程 | 只在本进程的 `env` 里设，不要写进 `process.env` 全局；host 拉起的受管进程要显式删掉该变量 |
| **重启/单例** | `scheduleAgentHostRestart()` 基于 utilityProcess 事件 | 换成 `child.once("exit")`（探针已验证 exit 事件正常） |
| 打包路径 | `app.isPackaged ? resourcesPath/standalone : appPath` | 不变；`process.execPath` 就是 `PiForge.exe`，加 `ELECTRON_RUN_AS_NODE=1` 即以 node 模式跑 |

**未覆盖的边界**（下一轮立项验证要补）：
1. **带真实会话**的 RSS（本轮只测空闲；会话装载后的 heap 峰值没测）；
2. 打包版（`PiForge.exe` 当 node 用）实测 —— 本轮用的是 `node_modules/electron/dist/electron.exe`；
3. 受管进程（`processes.*`）在普通子进程模式下的父子级联回收；
4. 30 轮 soak 重跑（L1 的验收口径不变：0 OOM / CPU 中位 ≤1%）。

## 6. 建议的落地步骤（立项后，1.5 天）

1. `electron/host-launcher.ts`：抽象出 `spawnHost()`，两种实现（utilityProcess / run-as-node）由
   `PIFORGE_HOST_TRANSPORT=utility|node` 切换，**默认仍是 utility**；
2. host 侧把 `parentPort` 依赖替换成"父进程 stdin 关闭即退出"的兜底；
3. 打包版跑 `probe-host-runtime.mjs`（改造成能指向 `PiForge.exe`）+ `measure-packaged --max-rss-mb 220`；
4. 30 轮 soak + `smoke:prefix-budget` exit 0 之后，才把默认切成 `node`。
