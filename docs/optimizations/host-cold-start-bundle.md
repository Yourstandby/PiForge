# Agent Host 冷启动：单文件 bundle（v0.9.1 → 0.9.2）

> 结论先说：**32 s 里 ≈90% 是按文件解析 ESM 模块图的固定开销**（打包版 5,917 个 `.js` /
> `node_modules` 共 20,239 个文件），首启时再被 Windows Defender 首次扫描放大。
> 扩展发现、toolchain 扫描、MCP 连接实测都 < 100 ms，不在关键路径上。
> 把 Agent Host + Pi SDK 打成单文件后，`spawn → host ready` 从 **4.4–5.4 s** 降到 **1.24–1.38 s**。

## 1. 阶段表（同一台机器、隔离 userData、连续 3 次冷启动）

命令：

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File bench/run-cold-starts.ps1 -Runs 3 -GapSec 30
python bench/startup_stats.py --log "%TEMP%\piforge-cold-start-bench\logs\main.log" --starts 3
```

### 改前（tsc 逐文件产物，5,917 个 `.js`）

| app ready → host ready | spawn → heap flags | app ready → static loaded | spawn → ready |
| --- | --- | --- | --- |
| 5569 | 533 | 1307 | 5387 |
| 4550 | 322 | 1026 | 4415 |
| — | — | — | — |

host 进程内阶段（delta, ms）：`server.module 4751 / 4000`、`config.sync 9 / 8`、
`pipe.listen 2 / 2`、`ws.bus 93 / 99`、`plugins.init 4 / 4`。

### 改后（单文件 `host.mjs`，2,365 个模块 → 1 个 14.5 MB 文件）

| app ready → host ready | spawn → heap flags | app ready → static loaded | spawn → ready |
| --- | --- | --- | --- |
| 1572 | 793 | 1511 | 1366 |
| 1550 | 867 | 1316 | 1384 |
| 1407 | 773 | 1210 | 1244 |

**p50 = 1550 ms，p95 = 1572 ms**（目标 p50 ≤ 3.0 s / p95 ≤ 5.0 s）。

host 进程内阶段（delta, ms）：`node.bootstrap 0–1`、`server.module 320–340`、
`config.sync 14–26`、`pipe.listen 3–7`、`ws.bus 40–59`、`plugins.init 7–12`、`ready 0–1`。

> 打点口径：`node.bootstrap` 是 `process.uptime()` 反推的"进程启动 → 入口模块体"，
> 单文件 bundle 下它把 15 MB 的一次性编译也算在内（实测 ms≈583–619）。
> 跨进程的 `spawn → heap flags / spawn → ready` 用日志时间戳差，不受打点口径影响。

### 背靠背复测（同会话，改前/改后各 3 次，2026-10-24 12:22–12:25）

| 指标 (ms) | 改前 p50 / p95 | 改后 p50 / p95 |
| --- | --- | --- |
| app ready → host ready | 2670 / 2796 | **1064 / 1194** |
| spawn → host ready | 2561 / 2619 | 972 / 1082 |
| app ready → static app url loaded | 982 / 1013 | 785 / 1076 |
| host 内 `server.module` | 2243 / 2303 | 282–340 |
| host 内 `ws.bus`（已知未优化） | 65 / 88 | 40 / 59 |

G3（static loaded）差异在噪声内（样本区间重叠 865–1013 vs 749–1076），改后 p50 反而低 197 ms。

### 未打包 vs 打包（同一入口，单进程 import 计时）

| 入口 | 3 次 samples |
| --- | --- |
| `agent-host/dist/agent-host/index.js`（ESM 图） | 3346 / 3464 / 3144 ms |
| `agent-host/bundle/host.mjs`（单文件） | 720 / 697 / 740 ms |

## 2. 改了什么

| 文件 | 作用 |
| --- | --- |
| `agent-host/host-phases.ts`（新增） | 零依赖阶段打点，`[agent-host] [phase] <name> ms=<n> delta=<n>` |
| `agent-host/index.ts` | `server.ts` 改为动态 import（否则打点全落在图加载之后）+ `node.bootstrap` / `server.module` / `ready` |
| `agent-host/server.ts` | `config.sync` / `pipe.listen` / `ws.bus` / `plugins.init` 四个阶段点 |
| `scripts/bundle-agent-host.mjs`（新增） | esbuild 打单文件 ESM，校验没有残留 bare import，并复制 `image-resize-worker.js` |
| `scripts/ensure-standalone-agent-host.mjs` | 优先用 bundle，生成 wrapper 补 `PI_PACKAGE_DIR` |
| `package.json` | `build:agent-host` 增加 bundle 步骤；新增 `bundle:agent-host`、`bench:startup`；devDependency `esbuild` |

两个必须处理的 SDK 运行时耦合（否则功能静默坏掉）：

1. `dist/utils/image-resize.js` 用 `new URL("./image-resize-worker.js", import.meta.url)` 定位 Worker。
   打包后 `import.meta.url` 变成 bundle 自己 → 构建脚本把该文件复制到 `host.mjs` 旁边。
2. `getPackageDir()` 从 `import.meta.url` 往上找 `package.json`（themes / quickjs wasm / export 模板都靠它）。
   打包后找不到 → 生成的 wrapper 在 import bundle **之前**设 `PI_PACKAGE_DIR` 指向真实包目录。
3. ESM 输出里 esbuild 的 `__require` 需要作用域里有 `require`，否则 CJS 依赖
   （`cross-spawn → require("child_process")`）直接抛 `Dynamic require ... is not supported`；
   bundle banner 里补 `createRequire(import.meta.url)`。

## 3. 复现

```bash
npm run build:agent-host                     # tsc + bundle（需要 NODE_OPTIONS=--max-old-space-size=4096）
node scripts/bundle-agent-host.mjs           # 只重打 bundle
PIFORGE_HOST_ENTRY=agent-host/bundle/host.mjs \
  PI_PACKAGE_DIR=node_modules/@earendil-works/pi-coding-agent \
  node scripts/smoke-agent-host.mjs          # bundle 版 host 冒烟
python bench/startup_stats.py                # 读 %APPDATA%\piforge\logs\main.log
```

## 4. 风险与边界

- 打包后 host 不再需要 `standalone/node_modules` 里的 Pi SDK 才能启动，但**仍然保留**这棵树：
  Next standalone、扩展（jiti 加载的用户扩展）与 `PI_PACKAGE_DIR` 都还在用它，删掉会连带改布局。
- bundle 是未压缩的单文件，栈里出现的是 bundle 行号；排障需要看 `agent-host/dist` 或临时关掉 bundle
  （`ensure-standalone-agent-host.mjs` 在缺少 `agent-host/bundle/host.mjs` 时自动回退到逐文件树）。
- 未做：V8 compile cache（实测对逐文件图收益不稳：5.5 s → 4.5–5.8 s，bundle 之后已无必要）、
  堆上限调整（`limitMb=204` 保持不变，非本次瓶颈）。
