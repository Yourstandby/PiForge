# 按需工具激活：命名对齐修复 + 中频域 A/B（第 8 步）

## 一、命名对齐（先修根因）

### 根因

`tool_search` 的候选是**注册表里所有 `deferred` 工具**，包括我们为了合并而镜像注册的旧名字
（`run_bg` / `browser_read` / `powershell` / `memory_*` …）。模型照着返回的 `- run_bg: …`
调用，但声明层只发 wire name（`shell` / `memory`），provider 于是回
`unsupported call` —— 模型重试或放弃，这就是「命名改变导致失败」。

### 修法（`agent-host/desktop-tool-search-alignment.ts`）

1. **过滤**：结果里只保留 wire name（与 `getAllTools()` 的名字逐字节一致，不美化、不缩写）；
   内部注册名只出现在 `details.dropped` 里，永不进模型可读文本。
2. **撤销激活**：把被 `tool_search` 拉进 active 的内部名全部撤掉（声明层也不会发它们）。
3. **重排 active**：SDK 的 `tool_search` 用 `setActiveTools([...active, ...matches])` 把新工具
   **追加在末尾**，而我们的声明用 ASCII 字典序 —— 不重排的话，激活那条请求是「追加序」、
   下一轮又变回「字典序」，同一集合两种字节序 = **两次前缀写入**（实测这一抖动让激活成本从
   4 600 变成 8 675 tok）。现在对齐扩展在返回结果时立即 `canonicalToolOrder` 重排。
4. **时序约束**：结果文本固定带一句
   `Call the loaded tool(s) on your NEXT turn. … do not chain tool_search and the loaded tool.`

### 断言（进 token-guards）

`measure-prefix` 每次运行都会扫所有请求体：`tool_search` 返回文本里 `- name:` 列出的名字，
必须都出现在**同一条请求**的 `tools` 声明里；不一致退出码 **9**。
`smoke:prefix-budget` 的三种配置都会跑这条断言。

## 二、A/B 定义与执行

- 中频域选择：30 轮真实会话里 `shell`（PowerShell + 后台进程）是除核心 `bash/read` 外唯一被真实
  调用的域（实测 `shell×4`，`browser/fleet/memory/orchestrator` 为 0），所以拿它做 B。
- A：全部常驻 —— `PIFORGE_ON_DEMAND_DOMAINS=0`，前缀 **6 988**，声明 12 个。
- B：只把 `shell` 改成按需 —— 前缀 **6 240**，声明 11 个；首次使用先 `tool_search`，激活后棘轮常驻。
- 脚本：`--scenario on-demand`（30 轮，前 8 轮里真实调用 `shell` 4 次：run/read/run/wait），
  第 15 轮后停顿 65s。两次运行同模型（deepseek-flash）、同 cwd、同 prompt。
- 先做序列收敛验证（记录型 provider）：A 的最终调用 = `shell{run,echo piforge-probe}`；
  B = `tool_search(shell)` → 同一句 `shell{run,echo piforge-probe}`。**收敛**后才跑真实模型。

## 三、五项指标（按第 7 步的三口径标注）

| 指标 | A（常驻） | B（shell 按需） | 口径 |
| --- | ---: | ---: | --- |
| 静态前缀 | 6 988 tok / 12 工具 | **6 240 tok / 11 工具**（−748） | 记录型 provider |
| 激活尖峰（首次 tool_search + 重写） | 0 | **4 600 tok**（cacheCreation，重排修好后；修前 8 675） | 记录型 provider |
| 回本轮次 | — | **6.2 轮**（4 600 ÷ 748） | 记录型 provider |
| 30 轮未缓存 input | 12 553 | 13 821 | 真实 deepseek（受跨会话缓存影响，见下） |
| 30 轮 cacheRead | 598 528 | 646 656 | 真实 deepseek（B 的 transcript 更长） |
| 稳定段命中率 | 97.98% | 97.98% | 真实 deepseek |
| 每轮未缓存 input 中位数 | 395 | 425 | 真实 deepseek |
| shell 调用 / tool_search | 4 / 0 | 4 / 1 | 真实 deepseek（会话 JSONL 统计） |

### 净收益（按第 8 步公式）

```
稳态每轮节省 = 6 988 − 6 240 = 748 tok
回本轮次     = 4 600 ÷ 748 ≈ 6.2 轮
净收益       = 748 × (30 − 6.2) − 4 600 ≈ +13 200 tok  →  > 0
命中率       = 97.98% vs A 97.98%（≥ 95% 门槛）
```
→ **B 默认开启**（`DEFAULT_ON_DEMAND_DOMAINS = ["shell"]`）。

### 真实会话总量的口径提醒

真实 30 轮里 B 的未缓存 input 比 A 多 1 268 tok、cacheRead 多 48k，原因不在前缀：
A 的第 1 轮命中了**跨会话**的 DeepSeek 缓存（t1 in=497），B 的前缀是新的（t1 in=920，本来就要写）；
另外 B 的模型多跑了几轮 bash（27 vs 24），transcript 更长。**决策用的是记录型 provider 的
前缀差 + 激活成本**（可复现），真实数据只用来确认「命中率没有下降」。

## 四、anthropic-messages 缓存断点

`--api anthropic-messages --probe-search shell --dump-requests`：

| 请求 | tools | tools[-1].cache_control | system[-1].cache_control | 含 shell |
| --- | ---: | --- | --- | --- |
| 01（title） | 0 | — | ✓ | — |
| 02（激活前） | 11 | ✓ | ✓ | ✗ |
| 03（激活那轮） | 12 | ✓ | ✓ | ✓ |
| 04–07（之后） | 12 | ✓ | ✓ | ✓ |

激活后连续两轮 `prefixHash` 一致（`8ae23042…`），棘轮审计 `expectedChanges=1 /
unexpectedChanges=0`。

## 五、护栏（并入第 7 步的 token-guards，不新建 job）

| 配置 | 断言 | 当前值 |
| --- | --- | --- |
| 默认（shell 按需） | 前缀 ≤7 200、命中率 ≥90%、中位数 ≤200、字段白名单、命名对齐、棘轮 | 6 240 / 99.5% / 29 / ✓ / ✓ / 0 |
| 默认 + `--probe-search shell` | 激活 → 声明 → 分派、连续两轮 hash 一致 | ✓ / ✓ |
| `PIFORGE_ON_DEMAND_DOMAINS=1` | memory / orchestrator 两个探针 | ✓ / ✓ |
| `PIFORGE_ON_DEMAND_DOMAINS=0` | A 组（全常驻），前缀 6 988 | ✓ |

切回 A 只需 `PIFORGE_ON_DEMAND_DOMAINS=0`，无需改代码。

## 六、结论与边界

- 只对**中频域** `shell` 默认按需；`memory` / `orchestrator` 仍是负收益（第 5 步实测），保持常驻。
- 不删任何工具：旧名字仍可 `executeTool`，UI/审批/i18n 沿用旧名。
- 核心四件套 710 tok 不变；默认前缀从 6 991 **降到** 6 240（不违反「不因本步变大」）。
