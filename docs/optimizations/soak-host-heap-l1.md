# L1 soak 记录（30 轮：15 起停 + 15 真实会话）

> 命令：`node scripts/soak-host-heap.mjs --rounds 15 --session-rounds 15 --max-host-rss-mb 280 --max-cpu 2`
> 环境：打包版 `release/win-unpacked/PiForge.exe`，隔离 userData（30 轮共用，模拟真实使用累积），
> 真实会话 = `PIFORGE_OPEN_PATH=/?session=<本机最大会话 26 MB>`（只加载 transcript，**不调用模型**）。

**汇总：30/30 轮有效 · host RSS 中位 289.5 MB / 最大 349.4 MB · 空闲 CPU 中位 0.34% · OOM 0 次**

- **0 OOM**：`<userData>/host-oom.json` 从未生成（取证由 `agent-host/index.ts` 写，
  触发条件 `heap out of memory` / `allocation failed` / exit 134 / SIGABRT）。
- **空闲 CPU 中位 0.34%**（目标 ≤1%）→ **通过**。
- **host RSS 中位 289.5 MB / 最大 349.4 MB** → **未达到 220 MB 目标**。
  第 22、25 轮的 336–349 MB 尖峰与大会话加载 / 老生代扩容同时发生；中位更接近真实稳态。
- 单次 `measure-packaged`（全新 userData）实测 **262–268 MB**；soak 共用一个 userData，
  会话文件累积后中位升到 289.5 MB。两个口径都列出，避免"只报最好的一次"。

| 轮 | 类型 | host RSS (MB) | host CPU (%) | host ready (ms) |
|---|---|---|---|---|
| 1 | boot | 265 | 0.69 | 1863ms |
| 2 | boot | 268.1 | 0.19 | 1863ms |
| 3 | boot | 281.6 | 0 | 1839ms |
| 4 | boot | 291.2 | 0 | 2294ms |
| 5 | boot | 286.4 | 0.72 | 1807ms |
| 6 | boot | 290.2 | 0.35 | 2084ms |
| 7 | boot | 264.5 | 0.51 | 2288ms |
| 8 | boot | 299.2 | 0 | 2386ms |
| 9 | boot | 273.8 | 0.17 | 2202ms |
| 10 | boot | 295 | 0.34 | 2431ms |
| 11 | boot | 271.1 | 0.17 | 2337ms |
| 12 | boot | 273.3 | 0.55 | 2314ms |
| 13 | boot | 286.4 | 0 | 2385ms |
| 14 | boot | 296.1 | 0.37 | 2489ms |
| 15 | boot | 274.4 | 0 | 2094ms |
| 16 | session | 289.7 | 0.35 | 1879ms |
| 17 | session | 289.5 | 1.72 | 1902ms |
| 18 | session | 290 | 0.78 | 1810ms |
| 19 | session | 291.1 | 0.34 | 1777ms |
| 20 | session | 286 | 0.53 | 1788ms |
| 21 | session | 299.2 | 19.49 | 1808ms |
| 22 | session | 349.4 | 0 | 1801ms |
| 23 | session | 288.5 | 0.35 | 1779ms |
| 24 | session | 292.1 | 0.17 | 1854ms |
| 25 | session | 336.4 | 0 | 1787ms |
| 26 | session | 285.7 | 0 | 1724ms |
| 27 | session | 287.8 | 0 | 1815ms |
| 28 | session | 280.7 | 0 | 1722ms |
| 29 | session | 292.9 | 0 | 1784ms |
| 30 | session | 294.4 | 0.35 | 1755ms |
