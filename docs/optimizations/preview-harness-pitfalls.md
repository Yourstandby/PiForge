# 预演/实验工具坑位：5 个会伪造结论的 bug

> 来源：L-A 预演（`scripts/l-a-preview.mjs` + `scripts/ab-run-task.mjs`）过程中真实踩到的坑。
> 每一个都**产出过看起来合理、实际错误的数据** —— 比崩溃更危险。
> 相关文档：`docs/optimizations/l-a-preview-report.md`（预演结论）、
> `docs/optimizations/token-line-closure.md`（token 线收口）、
> `docs/optimizations/v0.9.x-performance-final.md`（运行效率线收口）。

## 0. 为什么单独写一份

这套工具跑一次要 12–15 分钟、花真钱。**结果错了往往看不出来**：
指标自洽、分布合理，只是它测的不是你以为的东西。下面 5 条都按
「症状 → 根因 → 修法 → 现在的默认行为」写，方便下次直接对照。

---

## 1. 历史里的绝对路径会把改动写进**真实仓库**

**症状**：判据全红，`git status` 里却能看到真实仓库的 `electron/host-heap.ts`、
`components/ChatSurface.tsx`、`agent-host/rpc-manager.ts`、`agent-host/server.ts` 被改
（第 1 轮预演就是这样，还顺手在仓库根目录留下了 `ab-answer.json`、`ab-count.mjs`）。

**根因**：transcript 里到处是 `D:\Pi\PiForge\...`。工作树在临时目录，但模型**照着历史里的
绝对路径**改文件 —— 改的是真实仓库，工作树里的 check 当然全红。

**关键细节（第一版修错了）**：会话文件是 JSONL，路径在**文件文本**里是转义形态
`D:\\Pi\\PiForge`（双反斜杠）。按单反斜杠做字符串替换只命中极少数位置，等于没修。

**修法（两层）**：

1. **JSON 层面递归替换**：`JSON.parse` 每一行 → 递归遍历所有字符串值 →
   把 `repoRoot`（两种斜杠形态）替换成工作树路径 → 重新序列化。
   这样转义形态一次覆盖（`ab-run-task.mjs` 的 `rewriteRepoPaths`）。
2. **跑后护栏**：每轮结束跑 `git status --porcelain`，命中 tracked 修改就
   **只回滚那几个文件**（不要用 `git checkout -- .`，会连未提交的文档改动一起冲掉），
   并给这次 run 打 `leakedRepo` 标，汇总时能把它排除。

**现在的默认行为**：`--run` 默认带护栏（`scripts/l-a-preview.mjs` 的 run 循环里），
`leakedRepo` 会写进该次 run 的 JSON。第 3 轮预演抓到 5 次泄漏，全部自动回滚，仓库保持干净。

---

## 2. 改写后的状态文件用了固定文件名 → 各轮历史互相累积

**症状**：后面的 run 表现"怪怪的"：明明该改代码，模型却直接说"已经完成了"；
成功/失败在同一状态里前后不一致。

**根因**：把状态文件改写成 `C1-rw.jsonl` 这种**固定名字**，而 `agent.ensure` 会往文件里
**追加**本次的消息。于是第二轮 run 装载的是"第一轮跑完之后"的会话 —— 历史里已经有上一次的
任务 prompt、工具调用和编辑结果。

**修法**：每次 run 用独立文件名：
`C1-rw-<base36 时间戳>-<4 位随机>.jsonl`（`ab-run-task.mjs`）。

**现在的默认行为**：一次 run 一个会话文件，跑完即弃（状态素材本身只读，永不改写）。

---

## 3. 续跑会话的用量统计把**历史**算进了本题

**症状**：一次单题 run 报出 **81 次调用**、cacheRead 中位 56 960、成本 $0.108 —— 明显不合理
（单题通常 3–15 次调用）。

**根因**：`readUsage()` 从会话文件里读**所有** assistant 消息的 `usage`。续跑会话里本来就有
几百条历史消息（C1 状态保留了 152 条 entry，其中 ~79 条 assistant 带 usage），
全被算成"这道题的开销"。

**修法**：`agent.ensure` 之后先记录当前文件的行数 `usageSkipLines`，
`readUsage(sessionFile, { skipLines })` 只解析这之后的新增行。

**现在的默认行为**：所有续跑 run 都按"本次新增行"计量；新建会话（`agent.create`）等价于
`skipLines = 0`。

---

## 4. `isStreaming` 判定过早退出 → 记成 `calls=0`

**症状**：C3 状态连续两次跑出 `calls=0 / cacheRead=0 / $0.0000 / 4–5s`，
看起来像"模型拒绝回答"。而同一份状态在别的实现下是能跑的。

**根因**：收尾判定写成了"`isStreaming !== true` 且 stats 连续两次不变就结束"。
刚发出 prompt 的那一瞬间 `isStreaming` 还是 `false`（流还没开始），循环立刻退出。

**修法**：必须**先看到本次 run 新增的 assistant 消息**（对比 `baselineAssistant` 计数），
再等 stats 稳定才算收尾。

**现在的默认行为**：`runTask` 的等待循环有两道条件 —— 新增 assistant 消息 && stats 稳定；
超时才 abort 并标 `timedOut`。

---

## 5. 轮内裁剪按消息随手切 → 破坏 toolCall / toolResult 配对

**症状**：状态文件看起来"更小了"，但 `agent.ensure` 之后的 prompt **完全不起作用**
（calls=0，host 日志里没有任何模型请求）；或会话装载直接失败。

**根因**：pi 装载会话时 toolCall 与 toolResult **成对消费**。按消息粒度丢中间内容
（或者在 toolCall 与结果之间插一条合成消息）会留下悬空的调用/结果。

**修法**：最小裁剪单元 =「一个 assistant 消息（含其 toolCall） + 它触发的 toolResult」，
从尾部往前保留整单元；仍超预算时才用**现有运行时预算**（4 000 字符）截断超长的工具输出文本。

**现在的默认行为**：`stressTrimRound()` 只做成对单元裁剪 + 输出截断；C3 压力档就是这样构造的。

---

## 附：同类坑（度量侧，详见运行效率线文档）

不是预演工具的问题，但同属"数字看起来对、其实量错对象"，一并记下：

1. **同名进程聚合**：`measure-packaged` 只按"同名 exe / 同目录"过滤进程，
   机器上有另一个 PiForge 时会把它的进程算进来 —— 实测假读数 `host 477.7 MB / 13 进程 / 2247 MB`。
   现在按 `ParentProcessId` 收敛到本次启动的进程树。
2. **中位门禁 vs 峰值**：soak 原来拿**最大值**去比中位门禁，一次 GC 抖动就能把 30 轮判红。
   现在 `--max-host-rss-mb` 是中位验收线，`--max-host-rss-peak`（默认中位 × 1.15）单独一档。
3. **并发实例污染**：soak 期间跑别的 PiForge/测量脚本，同样参数会从 157–221 MB 漂到 234–255 MB。
   soak 现在有**预检**：检测到别的实例直接拒绝启动。
4. **两个 `--max-*-rss-mb` 混用**：`--max-rss-mb` 是整个 App 总 RSS（实测 850–1130 MB，
   怎么优化都到不了 220），host 单进程的门禁是 `--max-host-rss-mb`。
   细节见 `docs/optimizations/l1-transport-implementation.md` §0。
