# 超长会话实测（第 5 步）

## 怎么测的

- 真实模型：`deepseek-flash`（用户已登录的 deepseek 凭据，读 `~/.pi/agent/auth.json`，
  会话写进临时 agentDir，不污染用户目录）。
- 真实 Agent Host（不是 mock）：起 Host → `agent.create` → 30 轮 `prompt`，
  每轮结束从 `agent.state.sessionStats` 读累计值并与上一轮做差，
  得到**逐轮** `input / cacheRead / cacheWrite / output`。
- 30 轮任务全是真活：read / grep / ls / bash / memory recall / orchestrator status；
  第 3、17 轮会触发按需域激活（`PIFORGE_ON_DEMAND_DOMAINS=1` 的版本里）。
- 第 10、20 轮后各停顿 65 秒（模拟用户离开），观察缓存是否过期。
- 命令：`npm run measure:long-session`（等价于
  `node scripts/measure-long-session.mjs --turns 30 --model deepseek-flash`）。

> ⚠️ DeepSeek 的 `prompt_tokens` 与 SDK 的上下文估算差 2–3 倍（v0.8.2 也一样：
> `read` 出现过 44k/45k）。所以**同一 provider 内部横向比较有效**，跨 provider
> 或和 pi CLI 的解析基线只能看量级，不能当绝对值。

## 三条基线（同 30 轮同 prompt）

| 口径 | 静态前缀 | 声明工具 | 稳定段命中率 | 30 轮未缓存 input | 30 轮 cacheRead |
| --- | ---: | ---: | ---: | ---: | ---: |
| v0.8.2 | 8 146 | 23 | 98.3% | **23 903** | 902 400 |
| 第 4 步 HEAD（memory/orchestrator 按需） | 6 339 | 10 | 93.4% | **49 378** | 706 432 |
| 第 5 步 HEAD（恢复常驻声明） | 6 988 | 12 | 94.9% | **37 731** | 672 128 |
| pi CLI（解析基线：同 transcript，前缀 3 827） | 3 827 | 4 | ≈98% | ≈ 21 000 | ≈ 905 000 |

原始数据：`long-session-v082.json` / `long-session-head.json` / `long-session-head-default.json`。

## 逐轮曲线（未缓存 input，单位 tok）

```
v0.8.2     8.6k▁ 325 566 494 1.4k 1.1k 461 423 627 446 │ 583 394 684 408 414 364 676 466 720 336 │ 437 947 399 416 477 422 363 426 419 192
按需       424 380 1.0k 7.8k█ 1.2k 448 445 330 430 404 │ 823 392 508 474 382 460 14.5k███ 13.2k███ 713 488 │ 421 959 368 432 501 350 352 695 299 187
默认声明   1.0k 410 9.5k██ 631 1.1k 448 441 402 434 392 │ 505 602 486 512 420 398 13.4k███ 402 470 431 │ 438 908 402 388 396 407 389 582 388 184
                                         ↑ 第 10 轮后停顿 65s                                ↑ 第 20 轮后停顿 65s
```
（`▁`=平稳，`█`=尖峰；三行的列对应同一批 prompt。）

## 关键结论

### 1. 稳态命中率全部 ≥ 90%

三个版本在停顿前后都是 93–98%，`input` 稳态 300–700 tok/轮。**停顿 65 秒不会让
DeepSeek 的缓存过期**（`read` 在停顿后仍然 20k+/26k+），所以这次没法在这家 provider
上测到 TTL 过期；TTL 过期路径见 `docs/measurements/README.md` 里用记录型 provider
做的「TTL 15s + 停顿 20s」实验。

### 2. 按需域激活的尖峰比预算大一个量级 → **回退路线 2**

| 事件 | 未缓存 input |
| --- | ---: |
| 稳态均值（按需版本） | ≈ 450 / 轮 |
| 第 4 轮 `+memory` 激活 | **7 785** |
| 第 17 轮 `tool_search` 往返 | **14 536** |
| 第 18 轮 `+orchestrator` 激活 | **13 164** |

按需版本 30 轮合计未缓存 **49 378** tok，比恢复常驻声明的 **37 731** 多 11 647，
比 v0.8.2 的 23 903 多 25 475。收起来省的 617 tok/轮（≈18k/30 轮）**盖不住**这笔
一次性开销；而且缓存读单价通常只有输入价的 10%，换算成钱更不划算。

→ **默认恢复 memory / orchestrator 常驻声明**（前缀 6 988，声明 12 个），
按需机制保留在 `PIFORGE_ON_DEMAND_DOMAINS=1` 后面（长会话 >100 轮、或不支持前缀
缓存的模型仍可用）。`smoke:prefix-budget` 会两种配置都跑一遍。

### 3. 缓存保活在 deepseek 上永远 inactive（不是没接通）

30 轮里 `cacheWarming.state` 全程 `inactive`：deepseek 模型条目没有 `promptCache`
元数据，pi 的 warmer 直接 `stop("cache lifetime unavailable")`。这验证了第 4 步的
判断——warmer 需要 ①`cost` + `promptCache` ②预计省钱 ≥ $0.05；前缀 6 988 tok 在
$0.3/M 的输入价下永远达不到门槛。**保活机制本身**用记录型 provider（合成模型带
TTL 15s + 强制经济性）单独验证过：停顿期间 4 次 warm 全命中，下一轮 `read 6 431 /
create 35`。

### 4. 前缀涨到 25k 才会触发保活 —— 本次没走到

30 轮后上下文 16 907 tok（v0.8.2 18 653），前缀本身固定 6 988，都低于 25k 门槛，
所以没有观察到自动保活；这与 `docs/measurements/README.md` 里的经济学推算是自洽的。

## pi CLI 基线说明

pi CLI 的 30 轮同会话只能在 TUI 里跑，没有 headless 脚本接口，本次无法逐轮采集。
表中 pi CLI 一列是按**同一 transcript + pi CLI 静态前缀 3 827 tok**解析计算的量级
基线；稳态命中率与我们一致（都吃 provider 的自动前缀缓存），差异只出现在
缓存未命中的轮次：每次 miss 多付 3 161 tok（6 988 − 3 827）。

## 复现

```bash
npm run build:agent-host
npm run measure:long-session                                   # 当前 HEAD，30 轮
PIFORGE_ON_DEMAND_DOMAINS=1 npm run measure:long-session        # 按需配置对照
# v0.8.2 基线
git worktree add tmp/v082 8fbebca && (cd tmp/v082 && npm run build:agent-host)
node scripts/measure-long-session.mjs --host tmp/v082/agent-host/dist/agent-host/index.js \
  --label v0.8.2 --out docs/measurements/long-session-v082.json
```
