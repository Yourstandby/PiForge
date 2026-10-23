# Changelog

本文件的迁移条目按「用户能感知的行为变化」组织；详细数据在 `docs/measurements/`。

## Unreleased — v0.8.3

### 新增

- **按需工具域（设置页）**：运行 → 「按需工具域」多选，写入
  `desktop-settings.json` 的 `onDemandDomains`。默认只勾 `shell`。
- 设置页显示**实际生效**的按需域列表与来源（设置项 / 环境变量 / 默认值）。

### 语义澄清（老用户必读）

`PIFORGE_ON_DEMAND_DOMAINS` 的取值语义**保持不变**，这次只是把它搬到 UI，并明确优先级：

| 取值 | 含义 |
| --- | --- |
| `0` | 全部常驻（等价于取消所有勾选） |
| `1` | **兼容别名**：`memory` + `orchestrator` 按需（第 3–5 步的历史行为） |
| `shell` / `browser,shell` | 显式列表：列出的域按需 |
| 未设置 | 读设置项 `onDemandDomains`；设置项也没有 → 默认 `shell` |

- **优先级**：环境变量 > 设置项 > 默认值。环境变量存在时设置页的勾选被禁用（会提示原因）。
- 如果你之前把 `=1` 当作「全部按需」在用：它从来不是全按需，一直是
  memory + orchestrator；升级后行为不变。想全常驻请设 `0`。
- 默认值（`shell` 按需）来自第 8 步 A/B：前缀 6 988 → 6 240，回本 6.2 轮，
  30 轮净收益 ≈ +13 200 tok，命中率不变。

### 修复

- `tool_search` 现在只返回**可调用的 wire name**；之前会把内部注册名（`run_bg`、`browser_read`…）
  返给模型，导致 `unsupported call`。同时按 canonical 顺序重排 active，消除激活时的一次额外前缀写入。
- 结果文本明确要求「新工具下一轮再调用，不要和 `tool_search` 同轮连调」。

### 不变

- 核心四件套 `read`/`bash`/`edit`/`write` 的 schema（710 tok）不变。
- 默认静态前缀 6 244 tok（≤ 7 200 护栏），稳定段缓存命中率 99.5%（记录型 provider）。
- 仍然**不做自动压缩**，不删任何工具（旧工具名仍可被工具内部调用，UI/审批沿用旧名）。
