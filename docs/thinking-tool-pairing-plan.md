# 思考流实时化 + 思考/工具配对渲染

> 前端单文件改动（`components/Transcript.tsx`），不碰 `agent-host/`，token 成本 0。

## 1. 现状

```text
agent-host ──stream──▶ streamingMessage
                          │
                          ▼
                  buildTranscriptTurns()
                          │  blocks 本身有序：thinking / tool / text / image
                          ▼
                  RoundProcess  ← ✗ 拆成两个平行数组，顺序丢失
                  ├─ thinking[]
                  └─ tools[]
                          │
                          ▼
        ThinkingSection（折叠，live 只显示「思考中…」）
        ToolsSection   （折叠，全部工具堆在思考之后）
```

问题：
1. 长思考时只剩一行「思考中…」+ 转圈，看不到内容。
2. 工具调用全部堆在思考块下方，看不出「这段思考 → 这一次调用」的因果。

## 2. 目标形态

```text
┌─────────────────────────────────────────────┐
│ ◌ 思考中… · 1.8k 字 · 42 tokens/s      [收起]│
│ ┌─────────────────────────────────────────┐ │
│ │ …（尾部 2000 字，纯文本，自动滚到底）    │ │
│ └─────────────────────────────────────────┘ │
│   ↳ 🔧 read  components/Transcript.tsx  ✓   │
│   ↳ 🔧 grep  "RoundProcess"             ✓   │
│                                             │
│ ◌ 思考中… · 第 2 段                          │
│   ↳ 🔧 edit  components/Transcript.tsx  ⟳   │
│       └ 输出…（懒加载）                      │
└─────────────────────────────────────────────┘
```

规则：
- **live 自动展开**，思考结束、正文开始输出时自动收起为一行摘要。
- 每段思考**紧跟**它之后产生的工具调用（可 0..N 个）。
- 工具结果按 `toolCallId` 回填，与顺序无关。

## 3. 数据改造

```text
RoundProcess
- { thinking: ThinkingItem[]; tools: ToolItem[] }
+ { items: Array<
      | { kind: "thinking"; text; usage; entryId; timestamp }
      | { kind: "tool";     block; usage }
    > }
```

构建逻辑：单次遍历 `blocks`，遇到 `thinking` 就开新分组，遇到 `tool` 就挂到当前分组（若无前置思考则挂到 `standalone` 分组，保证「只有工具没有思考」的老会话不跑偏）。

```text
blocks: [thinking A][tool 1][tool 2][thinking B][tool 3][text]
             │         │        │         │         │
items:  ┌────┴────┬────┴───┬────┘         │         │
        │group0   │        │              │         │
        │ ◌ A     │        │              │         │
        │  ↳ 1    │        │              │         │
        │  ↳ 2    │        │              │         │
        └─────────┴────────┘        group1: ◌ B ↳ 3  │
                                                      ▼
                                             最终回复（普通 text 块）
```

## 4. 渲染约束（防卡顿）

| 项 | 做法 |
|---|---|
| 思考正文 | `whitespace-pre-wrap` 纯文本，**不走 ReactMarkdown** |
| 长文本 | `text.slice(-2000)`，顶部标注「已省略 N 字」 |
| 刷新 | 100ms 节流 + 组件 `memo` |
| 高度 | `max-h-[240px]` 内部滚动，自动跟底 |
| 折叠记忆 | key 改为 `round:${roundKey}:item:${index}` |

## 5. Token 影响

**零。** 改动仅在渲染层：

- 思考块与工具块本就存在于同一条 assistant message，重排不产生请求；
- 不回传模型，不修改 prompt 拼装；
- 生成侧 token 在流式输出时已扣费，显示一次或十次等价。

真正影响 token 的仍是：thinking level、上下文压缩时机、工具输出回填长度。

## 6. 工作量

| 项 | 范围 |
|---|---|
| `RoundProcess` 定义 + 构建 | ~40 行 |
| `ThinkingSection` / `ToolsSection` 合并为分组渲染器 | ~90 行 |
| live 自动展开 / 结束收起 | ~15 行 |
| 节流 + memo | ~15 行 |
| **合计** | **~160 行，单文件** |

## 7. 边界

- [ ] 老会话只有工具、无思考 → `standalone` 分组兜底
- [ ] 一段思考配多个并行工具 → 同一分组内平铺
- [ ] 流式断线重连（`seq` 重放）→ 已渲染尾片需按新消息重算，不追加
- [ ] 折叠状态跨重挂载保持（`stateKey`）
- [ ] 大思考 + 小窗口 → 内部滚动不顶掉输入框
