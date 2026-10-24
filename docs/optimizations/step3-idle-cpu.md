# 外壳层 Step 3：空闲 CPU 归零 + GPU 归因（本轮结果）

> 本轮只做三件事：A（扫描型路由去常驻 / CPU）、B（gpu 瘦身）、C（提交切分）。
> 不碰 `prompt-prefix.ts` / 工具域 / `smoke:prefix-budget`（token 面零变化，见 §4）。

## 1. 汇总（全部本机实测，打包版 + 隔离 userData）

| 项 | 改前实测 | 目标 | 改后实测 | 判定 |
|---|---|---|---|---|
| 空闲 CPU（10s 采样，单核口径） | 6.4–10.9%（host 6.1–9.5%） | ≤3% | **1.26% / 0.78% / 0.63%**（另 5 次：0.14 / 0.45 / 0.79 / 1.03 / 1.07） | ✅ 达成（中位 0.78%） |
| gpu 进程 RSS | 168–272 MB | ≤150 MB | 230–259 MB | ❌ 未达成（见 §3，基线所限） |
| app ready → host ready | 1 304–2 442 ms | ≤5 000 | 1 774–1 975 ms | ✅ 保持 |
| renderer RSS | 127–132 MB | ≤200 | 125–128 MB | ✅ 保持 |
| next-server 进程 / 30141 端口 | 0 / 无 | 0 / 无 | 0 / 无 | ✅ 保持 |
| token 面 | 前缀 6 640 tok、命中 99.6% | 不变 | **6 640 tok、99.6%**（`smoke:prefix-budget` exit 0） | ✅ 零变化 |

## 2. A：扫描型路由与"周期性 burst"

### 2.1 归因方法（可复跑）

```bash
# ① 每条路由的静态依赖图（模块数 / 字节 / 第三方包归属）
node scripts/audit-route-deps.mjs --top 15

# ② host 侧每条 API 的耗时（≥5ms 才打；含首载开销）
PIFORGE_DEBUG_API=1 node scripts/measure-packaged.mjs --exe release/win-unpacked/PiForge.exe --settle 20 --seconds 20

# ③ host 自身每秒 CPU/RSS/活跃句柄（1s 粒度，能把"burst"和"常驻"分开）
PIFORGE_DEBUG_HOST_CPU=1 ...（同上）
```

### 2.2 实测结论（这是本轮最重要的发现）

`/api/sessions`、`/api/models`、`/api/usage/upstream`、`/api/file-index` **并不是**常驻负担：

```
[api-load] /api/sessions     16ms heap+2.88MB ext+0.06MB
[api-load] /api/models        8ms heap+2.68MB ext+0.00MB
[api-load] /api/usage/upstream 11ms heap+1.84MB ext+0.06MB
[api-load] /api/file-index     4ms heap+1.57MB ext+0.00MB
```

全部 70 条路由首载合计约 25 MB heap、1–16 ms —— 懒加载已经把它们压到很小。
真正的 CPU 是**一次性 burst**，而不是常驻：

| burst | 组成（host 侧实测） |
|---|---|
| 启动后 0–5 s（host 自身 33–42%/s） | `/api/sessions` 771ms、`/api/models` 308ms、`/api/usage/upstream` 311ms、`/api/git/status` 511ms×3、`/api/fx` 761ms |
| 之后周期性（42%/s 或 46.9%/s 的单秒） | **`/api/git/status` 870ms**，每 20 s 一次（文件树旧定时器） |

两个根因与修法：

1. **`files.authorize` 首调 418 ms**（建连 + 握手 + 扫会话目录算 allowed-roots），
   而渲染进程第一批请求几乎同时到 → 一起排队。修法（`agent-host/server.ts`）：
   `host_ready` 之后 fire-and-forget 预热进程内 API 客户端（`host.health` +
   `files.allowedRoots`），并给 `getAllowedRoots()` 加单飞（`agent-host/allowed-roots.ts`），
   预热与真实请求撞车时不再各扫一遍。修后首调 418ms → **1ms**。
2. **git 扫描风暴**：文件树 20 s 定时 + Git 面板 15 s 定时 + 刷新键三路并发，
   每次 = 新建 worker + 2 个 git 进程；并发时单次从 250 ms 恶化到 **2.5–4 s**
   （git 抢 index.lock）。修法见提交 `perf(host): git 快照缓存/单飞 + 常驻 worker`
   —— status+branch 合成一次快照、3 s TTL、单飞、常驻 worker（不再每次 new Worker）；
   渲染侧去掉定时器，改 `refreshKey` + 聚焦（30 s 节流）。
   修后：`/api/git/status` 缓存命中 **2ms**，日志里再无秒级扫描。

> 顺带发现并修掉一个"测量假象"：`out/` 目录曾在 `.next-static` 切换后**没被更新**，
> 导致我有一轮测的是几小时前的 UI 包（老定时器还在，CPU 当然不降）。现在
> `scripts/next-build.mjs` 会把 `.next-static` 同步到 `out/` 并**校验 chunk 名单一致 +
> out/index.html 新鲜度**，不满足直接失败。

## 3. B：gpu 进程 230–259 MB（未达标，基线所限）

四个消融实验，全部无效（gpu RSS 基本不动）：

| 实验 | 命令 | gpu RSS |
|---|---|---|
| 基线 | `measure-packaged --settle 15` | 237–259 MB |
| 窗口从不显示（进程后台节流） | `PIFORGE_WINDOW_HIDDEN=1` | 239.8 MB |
| 不创建浏览器 WebContentsView | `PIFORGE_DISABLE_BROWSER_BRIDGE=1` | 261.4 MB |
| 去掉标题栏 backdrop-blur + tab 脉冲点 | 已合入 `perf(ui)` 提交 | 230–259 MB |
| 换窗口尺寸（800×600 vs 1400×900） | `PIFORGE_WINDOW_SIZE=800x600` | 466.8 MB（噪声更大，与面积无关） |

结论：**GPU 进程 RSS 是这台机器/这个 Electron 版本的基线**，不随合成面积、
可见性、模糊层数量或 CSS 动画变化。0.9.0 时代同机实测也是 264.8 MB。
要往 150 MB 走，需要换 Electron/Chromium 版本或调整 GPU feature flags
（会改变渲染行为），不属于"外壳层瘦身"，建议单独立项（见 §5）。

B 的两项 CSS 改动仍然保留：标题栏改不透明背景、tab 绿点改静态 —— 它们减少的是
合成层数量与重绘（对"可见窗口"的 CPU 有正向作用），只是**不足以**改变 GPU 基线。

## 4. C：提交切分

```
0cfc308 perf(host): git 快照缓存/单飞 + 常驻 worker + 文件授权单飞
9a4f4d4 feat(shell)!: 打包版静态直出替换 Next standalone（零内部端口）+ Host 就绪分级超时
9ebcc07 perf(ui): 空闲 CPU 与合成开销（轮询节奏 / 背景节流 / 合成友好动画 / 心跳）
15534c8 chore(perf): 实测工具（启动/内存/CPU）+ 优化文档
3bb0db9 test(host): 按需域"激活尖峰"回归护栏
cb88061 chore(update): 汇总作者在途改动（auto-update / pi-core 桥接，原样收录）
```

- 作者在途的 auto-update / pi-core 改动**没有被打散**，单独成 `cb88061`（消息里明确
  标注"不是我写的代码、未验证、原样收录"）。
- `electron/main.ts`、`electron/preload.ts`、`lib/electron-api.ts` 三个文件同时含两边改动：
  先把"只含本轮"的版本提交进 `9a4f4d4`，剩下的 pi-core 部分留在 `cb88061`。可用
  `git show 9a4f4d4 -- electron/main.ts` 对照核对（里面没有任何 `pi-core` 字样）。
- 每个提交都验证过可独立编译（把提交 checkout 到临时 worktree + 链接 node_modules 后
  跑 `tsc`、`tsc -p electron`、`tsc -p agent-host`，三个全绿）：
  中间提交 `0cfc308` 的路由文件用"HEAD 内容 + 快照改动"合成，shell 提交再把 import
  换成 shim —— 这样任意单点 checkout 都是自洽的。

## 5. 下一步立项建议

1. **Step 4（host ≤220 MB）的路由依赖图谱**（本轮已产出工具）：
   `node scripts/audit-route-deps.mjs --json` 显示 24 条路由拉进 `pi-coding-agent`、
   21 条拉进 `path`…… 真正的判断依据应是"模块常驻字节"，所以下一步应把
   `[api-load]` 的 heap 增量做成可归档的 JSON（`--json` 版本），再按"被哪些路由常驻"
   排序决定下沉/懒加载。
2. **gpu 基线专项**：先对比 PAD 的 Electron 版本与 GPU command line（PAD 152 MB vs
   本机 230–259 MB 同为 Electron 43/Chromium 版本？），再决定是否调 feature flags。
3. **`/api/fx` 761 ms** 与 **`/api/models` 308 ms** 属于网络/目录构建，建议加 5 min 磁盘
   缓存（汇率与模型目录都允许 stale），这样冷启动 burst 再小一截。
