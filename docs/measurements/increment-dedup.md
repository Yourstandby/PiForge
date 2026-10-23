# 每轮增量去重 + resume 字段裁剪（第 6 步）

## 一、工具结果去重

**做了什么**（`agent-host/desktop-dedupe-extension.ts`，挂在 `tool_result` 钩子上）：

| 场景 | 行为 |
| --- | --- |
| 同一文件 + 同一区间（path/offset/limit）第二次 `read` | 只回 `Unchanged since toolCall <id>: same path and range, file not modified (N chars)` |
| 同一命令第二次 `bash`，输出完全一致 | 只回 `Unchanged since toolCall <id>: same command, identical output` |
| 同一命令输出变长且**旧输出是新输出的前缀** | 只回尾部差异（`Same as toolCall <id> plus N new chars at the end: …`） |
| 任何 `isError` / 非零退出码 | **原样完整返回**，不参与去重（错误、堆栈、失败详情一字不少） |
| 文件 mtime/size 变了、读的区间不同、输出不是前缀关系 | 照常回全文 |

安全阀：`read` 需要「路径+区间+文件 stamp+内容哈希」四重一致才省略；小输出（<400 字符）
不值得省，一律回全文；缓存 LRU 128 条；`PIFORGE_DEDUPE_TOOL_RESULTS=0` 可整体关闭（A/B 用）。

### 实测（记录型 provider，可重复）

`npm run measure:increment`：同一串 7 次工具调用（重复 read、重复命令、追加后重跑同命令、
失败命令、不同区间 read），比较「最后一条请求体」：

| 指标 | 去重 OFF | 去重 ON | 变化 |
| --- | ---: | ---: | ---: |
| 最后一条请求体 ≈tok | 11 234 | 9 320 | **−1 914（−17.0%）** |
| 累计工具结果字符 | 12 048 | 5 781 | −52% |
| 去重命中 | — | 3 次 | read / 相同输出 / 尾部差异 |
| 失败命令结果完整 | ✓ | ✓ | 不参与去重 |

> 注意这是「重复内容多」的极端脚本；日常会话里命中率取决于重复读文件的频率。30 轮真实
> 长会话（prompt 各不相同）里命中很少，所以稳态指标没有明显变化，但也**没有变差**。

## 二、resume 回放字段裁剪

先用 `--dump-requests` 把 resume 后第一条请求体捞出来（OpenAI 形状）：

```
messages: [system, user, assistant, tool, assistant, user]
assistant keys: role, content, tool_calls
tool      keys: role, content, tool_call_id
system    keys: role, content
```

**结论：SDK 在 provider 边界已经做了裁剪** —— `details` / `usage` / `customType` / `entryId`
这些只存在于 session JSONL（给统计和 UI 用），不会进入模型请求。所以这一步**没有可削的字段**，
不加过滤代码（避免在热路径上多一次深拷贝）。

把它固化成护栏：`measure-prefix --assert-lean-transcript` 扫描所有请求体的消息键，
出现白名单以外的键（`details`/`usage`/`customType`/`display`/`entryId`/`timestamp`/…）
就失败（退出码 7）。`smoke:prefix-budget` 已包含。

## 三、30 轮真实会话（改动后）

`npm run measure:long-session`（deepseek-flash，30 轮，两次 65s 停顿）：

- 稳定段命中率 **96.3%**（≥90% 门槛）
- 稳定段每轮未缓存 input 中位数 **446 tok**（新增 `--max-median-input 1500` 护栏）
- 前缀仍是 **6 988 tok / 12 个工具**，核心四件套 710 不变，`prefixAudit.unexpectedChanges=0`

没有观察到「因为去重导致模型重读全文」的二次往返：去重文案带 `toolCall` id，模型要正文
可以换区间读（不同区间不去重），文件被改过也会自动回全文。

与改前（第 5 步实测，同 prompt 同模型）对比：

| 口径 | 稳定段命中率 | 每轮未缓存 input 中位数 | P90 |
| --- | ---: | ---: | ---: |
| 改前（第 5 步默认） | 94.9% | 414 tok | 1 343 |
| 改后（本步 + 去重） | 96.3% | 446 tok | — |

长会话里 prompt 各不相同、重复读少，所以中位数基本持平（±30 tok 属于 provider 计费抖动）；
去重的收益集中在「同一文件反复读/同一命令反复跑」的轮次，见上面的 A/B（−17%）。

## 四、护栏汇总

| 护栏 | 位置 | 阈值 |
| --- | --- | --- |
| 静态前缀 | `smoke:prefix-budget` | ≤ 7 200 tok（当前 6 988） |
| 稳定段缓存命中率 | `smoke:prefix-budget` | ≥ 90%（当前 99.6%） |
| 稳定段每轮新增 token 中位数 | `smoke:prefix-budget` | ≤ 200（当前 29） |
| transcript 只含模型字段 | `smoke:prefix-budget` | 无 `details`/`usage`/UI 字段 |
| 真实会话命中率 | `measure:long-session` | ≥ 90%（实测 96.3%） |
| 真实会话每轮未缓存 input 中位数 | `measure:long-session` | ≤ 1 500（实测 446） |
| 去重命中 + 错误完整 | `measure:increment` | 命中 ≥1 且错误原样 |
| 前缀棘轮 | `smoke:prefix-budget`（两种配置） | `unexpectedChanges=0` |
