# soak 记录：node 传输层 + `semi=4,old=192`（切默认前的 30 轮）

> 命令：`node scripts/soak-host-heap.mjs --rounds 15 --session-rounds 15 --max-host-rss-mb 240 --max-cpu 0.5 \`
> `  --env PIFORGE_HOST_TRANSPORT=node --env PIFORGE_HOST_HEAP=semi=4,old=192`
> 环境：打包版 `release/win-unpacked/PiForge.exe`，30 轮共用隔离 userData，
> 真实会话 = 本机最大会话（26 MB，只加载 transcript，不调用模型）。

**汇总：30/30 轮有效 · host RSS 中位 216.9 MB / 峰值 252.9 MB · 空闲 CPU 中位 0.35% · OOM 0 次**

判据（`docs/optimizations/l1-transport-implementation.md` §6.1）：

| 判据 | 目标 | 实测 | 判定 |
|---|---|---|---|
| OOM | 0 | 0 | ✅ |
| RSS 中位 | ≤240 MB | 216.9 MB | ✅ |
| RSS 峰值 | ≤276 MB（中位 × 1.15） | 252.9 MB | ✅ |
| 空闲 CPU 中位 | ≤0.5% | 0.35% | ✅ |

| 轮 | 类型 | host RSS (MB) | host CPU (%) | host ready (ms) |
|---|---|---|---|---|
| 1 | boot | 203 | 0.7 | 1799ms |
| 2 | boot | 203.6 | 0.53 | 1799ms |
| 3 | boot | 215 | 0.35 | 1957ms |
| 4 | boot | 215.1 | 0.52 | 1888ms |
| 5 | boot | 208.6 | 0.35 | 1834ms |
| 6 | boot | 217.6 | 0.17 | 1747ms |
| 7 | boot | 211.8 | 0.86 | 2124ms |
| 8 | boot | 200 | 0.35 | 1747ms |
| 9 | boot | 212.4 | 0 | 1933ms |
| 10 | boot | 218.2 | 0.69 | 1734ms |
| 11 | boot | 202.9 | 0.18 | 1792ms |
| 12 | boot | 216.8 | 0.18 | 1731ms |
| 13 | boot | 178.4 | 0.5 | 1792ms |
| 14 | boot | 215.6 | 0.53 | 1800ms |
| 15 | boot | 212.6 | 0 | 1801ms |
| 16 | session | 220.4 | 0.68 | 1766ms |
| 17 | session | 227.5 | 0.34 | 1832ms |
| 18 | session | 219.9 | 0.35 | 1768ms |
| 19 | session | 218.1 | 0 | 1704ms |
| 20 | session | 220.1 | 0 | 1753ms |
| 21 | session | 252.9 | 0.35 | 1699ms |
| 22 | session | 214.1 | 0.35 | 1709ms |
| 23 | session | 216.9 | 0.17 | 1715ms |
| 24 | session | 221.5 | 0.35 | 1826ms |
| 25 | session | 221.6 | 0.51 | 1682ms |
| 26 | session | 225.8 | 0.53 | 1697ms |
| 27 | session | 231 | 0.52 | 1673ms |
| 28 | session | 230.5 | 0.35 | 1693ms |
| 29 | session | 212.9 | 0 | 1795ms |
| 30 | session | 237.7 | 0.35 | 1743ms |

备注：前几轮（`#1`–`#15`）是纯起停（200–218 MB），`#16` 起加载 26 MB 会话（212–238 MB）；
CPU 单轮峰值 0.69%（`#16`，大会话装载期），中位 0.35%。
