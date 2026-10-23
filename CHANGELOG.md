# Changelog

迁移条目按「改了什么 / 默认行为变没变 / 开关怎么用」组织。详细数据见 `docs/measurements/`
（三个口径：记录型 provider、真实 deepseek 会话、重复场景 A/B）。

## Unreleased — v0.8.3

### 改了什么

- **工具合并 23 → 12**：20 个扩展工具按域收成 5 个多态工具（`browser` / `shell` / `fleet` /
  `orchestrator` / `memory`，用 `action` 分派），核心四件套 `read`/`bash`/`edit`/`write`
  的 schema 不变（710 tok）。旧工具名仍可被工具内部调用，UI / 审批 / i18n 沿用旧名。
- **缓存保活与首轮预热**：CacheWarming 首次真正接到设置上（桌面默认 `idle`），设置页显示
  实际生效的模式与状态；恢复会话时用 `maxTokens:1` 预放一次前缀（实测预热只花 16 tok）。
- **工具结果去重**：同文件同区间的重复 `read`、同命令的重复 `bash` 不再整段回放
  （相同输出一句话、输出变长只回尾部差异）；错误与非零退出永远完整返回。
- **按需工具域**：中频域 `shell` 默认不声明，首次用时 `tool_search` 激活后常驻；
  `tool_search` 只返回可调用的 wire name，并按 canonical 顺序重排 active（消除激活时的一次额外前缀写入）。
- **设置页「按需工具域」多选**：写 `desktop-settings.json` 的 `onDemandDomains`，
  显示实际生效列表与来源。

### 默认行为变没变

| 项 | v0.8.2 | v0.8.3（默认） |
| --- | --- | --- |
| 声明工具数 | 23 | **12**（其中 `shell` 首次使用时激活） |
| 静态前缀 | 8 146 tok | **6 244 tok**（核心四件套 710 不变） |
| 缓存保活 | UI 显示假 `off`，实际未接管 | 桌面默认 `idle`，设置页显示真实状态 |
| 工具结果 | 重复内容整段回放 | 重复内容去重，错误完整 |
| 自动压缩 | 关闭 | **仍然关闭**（无自动压缩） |

### 开关怎么用

`PIFORGE_ON_DEMAND_DOMAINS`（环境变量）与设置项 `onDemandDomains`：

| 取值 | 含义 |
| --- | --- |
| `0` | **全部常驻**（想回到「每轮都带完整 schema」就用这个） |
| `1` | **兼容别名**：`memory` + `orchestrator` 按需（不是「全按需」，这是第 3–5 步的历史语义） |
| `shell` / `browser,shell` | 显式列表：列出的域按需，其余常驻 |
| 未设置 | 读设置项 `onDemandDomains`；设置项也没写过 → 默认 `shell` |

- **优先级：环境变量 > 设置项 `onDemandDomains` > 默认值（`shell`）**。
  环境变量存在时设置页的勾选被禁用，并提示来源。
- 默认只有 `shell` 按需；`memory` / `orchestrator` 实测按需是负收益，**默认常驻**；
  勾选它们只给黄色提示，不禁止。
- 设置项改动**对新建会话生效**，当前会话需重新加载。
- 老用户如果之前用过 `=1`：行为不变（一直是 memory + orchestrator）。
