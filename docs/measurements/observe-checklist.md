# 观察清单（v0.8.3 上线后看什么）

只列**信号**和**排查命令**，不预设修法。有反馈再动手，没反馈就停。

## 1. `shell` 反复 `tool_search`

- 信号：同一会话里 `tool_search` 出现 ≥2 次且 query 都是 shell；或激活后仍只用 `bash`。
- 看：会话 JSONL 里的 toolCall 名称序列（`tool_search` / `shell` / `bash` 的计数）。
- 命令：
  ```bash
  # 最近一个会话的工具调用序列
  rg -o '"type":"toolCall","name":"[a-z_]+"' ~/.pi/agent/sessions/**/*.jsonl | tail -40
  # 或让度量脚本统计（30 轮）
  npm run measure:long-session -- --scenario on-demand
  ```
- 相关护栏：`npm run smoke:prefix-budget`（命名对齐、棘轮）。

## 2. 激活后 `prefixHash` 不一致

- 信号：`smoke:prefix-budget` 里 `前缀棘轮: unexpectedChanges>0`；或设置 `PIFORGE_DEBUG_PREFIX=1`
  时出现 `[prefix] UNEXPECTED change`。
- 看：差异段是 tools 还是 system；是否只新增了一个按需域。
- 命令：
  ```bash
  PIFORGE_DEBUG_PREFIX=1 npm run dev:electron      # 看 [prefix] 日志
  npm run smoke:prefix-budget                       # unexpectedChanges 必须为 0
  node scripts/measure-prefix.mjs --mode host --turns 4 --probe-search shell --cache-stats
  ```

## 3. 长命令前台超时

- 信号：`bash`/`powershell` 的工具结果里出现超时/截断提示；或用户抱怨长任务卡住。
- 看：是命令本身超时，还是输出被截断（`[输出过长已截断]` / `tool_history_get` 提示）。
- 命令：
  ```bash
  # 某个工具调用的完整输出是否落盘
  ls -t <agentDir>/tool-outputs | head
  # 会话里最近的 bash 调用参数与结果长度
  rg -o '"name":"bash".{0,200}' ~/.pi/agent/sessions/**/*.jsonl | tail -5
  ```

## 4. 稳定段命中率低于 97.98%

- 信号：`measure:long-session` 输出的 `稳定段 cacheRead 命中率` 掉到 97.98% 以下，
  或 `cacheRead` 曲线在某一轮突然掉到 0。
- 看：掉的那一轮前后是否有 `prefixAudit.lastChange`；是否有工具增删 / 模式切换。
- 命令：
  ```bash
  npm run measure:long-session                     # 断言 ≥90%，同时打印中位数
  npm run smoke:prefix-budget                      # 记录型 provider 的 99.5% 基线
  node scripts/measure-prefix.mjs --mode host --api anthropic-messages --turns 6 --cache-stats
  ```

## 5. 用户反馈「设置没生效」

- 信号：改了「按需工具域」但新会话仍按旧配置声明。
- 看：设置页显示的**来源**（env / settings / default）；环境变量是否存在；
  会话是不是新建的（改动只对新会话生效）。
- 命令：
  ```bash
  curl -s localhost:30141/api/desktop-settings | jq .onDemandEffective
  echo "$PIFORGE_ON_DEMAND_DOMAINS"                # 非空 → 覆盖设置项
  cat ~/.pi/agent/desktop-settings.json | jq .onDemandDomains
  ```

## 6. 其他随手可查

```bash
npm run measure:prefix            # 前缀 6 244 / 核心 710 / 命中率
npm run measure:increment         # 去重 A/B（错误必须完整返回）
npm run smoke:prefix-budget       # 四种配置：默认 / 设置项 / env=0 / env=1
```
