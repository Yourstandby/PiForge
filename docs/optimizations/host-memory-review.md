# Step 4 立项评审：host ≤220 MB 的杠杆 ROI（L1–L6）

> 评审输入：`docs/optimizations/v0.9.x-host-memory-plan.md`（拆解）+ 本轮**新增实测**。
> 结论先说：**L1（V8 堆参数）一个杠杆就能达标**（实测 host 289–357 MB → **186–195 MB**），
> L3/L4 属于"锦上添花"，L5 只是诊断。所以"220 MB 复议为 ≤250 MB"的触发条件大概率
> **不会触发**；下文给出精确条件与兜底。

## 1. ROI 总表（实测优先，未实测的明确标注）

| 杠杆 | 预估节省 | 依据 | 工作量 | 风险 | 动 native？ | 判定 |
|---|---|---|---|---|---|---|
| **L1 V8 堆参数**（`--max-semi-space-size` / `--max-old-space-size`） | **−100 … −150 MB**（实测） | 见 §2：host RSS 316/325/289/357 → **190/186/195/173** | **0.5 天**（`utilityProcess.fork` 已有 `execArgv` 通道，1 个常量 + 1 个测试） | 中：堆上限太小会 OOM；semi-space 太小会多 scavenge（负载 CPU 实测与基线同量级：74–118% vs 86–152%，噪声内） | ❌ 纯 V8 参数 | ✅ **先做** |
| L2 git worker 空闲回收 | **−14 MB**（实测） | 329 MB（无 worker）→ 343 MB（拉起 worker）→ 344 MB（复用） | 0.5 天 | 低：下次扫描多付 100–150 ms worker 启动 | ❌ | ✅ 可做（L1 之后） |
| L3 Pi SDK 子系统懒加载（LTM/orchestrator/fleet） | 20–40 MB（**待测**） | 无直接实测；参照 host 启动即 329 MB vs PAD 183 MB 的差值 | 2 天 | 中高：会改工具注册时机，必须守住 `smoke:prefix-budget` | ✅ 部分（native addon 延迟 dlopen） | ⏸ 暂缓 |
| L4 非活动会话 transcript 驻留上限 | 10–30 MB（**待测**，取决于开几个会话） | 无 | 2 天 | 中：切会话多一次磁盘读 | ❌ | ⏸ 暂缓 |
| L5 native 侧定位（152 MB 归属） | 0（诊断） | `rss − heapTotal − external ≈ 152 MB` | 4 小时 | 低 | — | 🅿 有空再做（L1 已达标就不用） |
| L6 worker 线程堆上限 | 5–10 MB（与 L1 重叠） | 每线程 ≈14 MB | 0.5 天 | 低 | ❌ | ❌ 被 L1 覆盖 |

## 2. L1 实测（本轮新做，这是评审的关键依据）

方法：直接起 `agent-host/dist/agent-host/index.js`（独立命名管道），加载 6 条常用路由
（health / sessions / files list / models / processes / watchdog）后静置，读
`WorkingSet64` 与 `TotalProcessorTime`：

| V8 flags | host RSS | 空闲 CPU | 一轮 20 次请求的 CPU |
|---|---|---|---|
| （默认） | **357 MB** | — | — |
| `--max-old-space-size=96` | 274 MB | — | — |
| `--max-semi-space-size=4` | 253 MB | — | — |
| `--max-semi-space-size=8` | 205–264 MB | 0.25% | 95% |
| `--max-semi-space-size=16` | 207–241 MB | 1.73% | 103% |
| **`--max-semi-space-size=8 --max-old-space-size=192`** | **173–195 MB** | 0.25–0.49% | 103–152% |
| （默认，第二轮对照） | 289–325 MB | 0.00–1.48% | 74–118% |

解读：
- 那 300+ MB 里很大一块是 **V8 新生代（semi-space）的常驻arena**，不是活对象
  （`heapUsed` 只有 93 MB）。收紧 semi-space 直接把 RSS 砍掉 100–150 MB；
- `--max-old-space-size` 再补 70–90 MB（把老生代的 GC 余量压掉）；
- CPU 侧没有可见回退（空闲 0.25–0.49%，与基线 0.00–1.48% 同量级；负载样本噪声大，
  需要在真实会话里用 `measure:long-session` 复核）。

**风险与护栏（实施时必须一起做）**
1. `--max-old-space-size` 起步用 **256**（不是 192），跑完 30 轮会话 + 压缩一次再收紧；
2. 加 OOM 观测：host 崩溃时日志里 `Agent Host exited { code: 134 }` / `heap out of memory`
   必须能在 `measure:long-session` 里被捕获；
3. 只给 **utilityProcess（host）** 设 `execArgv`，不动 main / Next；
4. 回归：`smoke:prefix-budget` 必须 exit 0（工具域/前缀零变化）。

## 3. "220 MB 复议为 ≤250 MB"的触发条件（精确定义）

```
若（L1 落地后 host RSS 中位数 > 250 MB）且（L1 + L2 + L4 全部落地后仍 > 250 MB）
则正式复议为 ≤250 MB，并在本文档追加复议记录与依据。
```

按本轮实测，**L1 单杠杆就把中位数压到 ~190 MB**，因此：
- 触发条件**预期不成立**；
- 若 L1 在真实会话下（长会话 + 多会话 + 大文件）回退到 >250 MB，则先做 L2（−14 MB），
  再评估 L4；仍然 >250 MB 才复议。

## 4. 建议实施顺序（只做这些）

1. **L1**（0.5 天）：`electron/main.ts` 给 host 的 `utilityProcess.fork` 传
   `execArgv: ["--max-semi-space-size=8", "--max-old-space-size=256"]`，
   并让 `PIFORGE_HOST_EXEC_ARGV` 可覆盖（排障/实验）。
   验收：`measure:packaged` host ≤220 MB 且 `smoke:prefix-budget` exit 0；
   `measure:long-session` 30 轮无 OOM。
2. **L2**（0.5 天）：git worker 空闲 60 s 回收。
   验收：`audit-route-heap` 场景下 host RSS ≤L1 结果 −10 MB，且 `/api/git/status` 首次仍 ≤600 ms。
3. 其余暂缓；**L3/L4 只有在 L1+L2 后仍 >220 MB 时才立项**。

## 5. 复现命令

```bash
# L1 对照（默认 vs 收紧堆参数）
node /tmp/cap2.mjs                                        # 需自备该脚本；核心逻辑见本文 §2
node /tmp/cap2.mjs --max-semi-space-size=8 --max-old-space-size=192

# 打包版整体
npm run measure:packaged -- --seconds 10 --settle 15
# Host 自身内存/CPU/句柄（1s 粒度）
PIFORGE_DEBUG_HOST_CPU=1 npm run measure:packaged -- --settle 20 --seconds 10
# 路由首载 heap（确认"路由不是主项"）
node scripts/audit-route-heap.mjs --top 15
```
