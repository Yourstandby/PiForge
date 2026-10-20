import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "./types.ts";
import { conversationToMarkdown } from "./conversation-markdown.ts";

const messages = [
  {
    role: "user",
    content: [
      { type: "text", text: "帮我加个按钮" },
      { type: "image", data: "abc", mimeType: "image/png" },
    ],
  },
  {
    role: "assistant",
    content: [
      { type: "text", text: "好的，我先改 components/A.tsx。" },
      { type: "thinking", thinking: "先看现有结构\n再改" },
      { type: "toolCall", toolName: "edit", input: { path: "components/A.tsx", edits: [{ oldText: "a", newText: "b" }] } },
    ],
  },
  {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "edit",
    content: [{ type: "text", text: "Edited components/A.tsx (1 replacement)" }],
  },
] as unknown as AgentMessage[];

test("renders user/assistant/tool sections as markdown", () => {
  const md = conversationToMarkdown(messages);
  assert.match(md, /^# PiForge 对话导出/);
  assert.match(md, /## 用户\n\n帮我加个按钮/);
  assert.match(md, /_\[1 张图片附件\]_/);
  assert.match(md, /## 助手/);
  assert.match(md, /> 思考：先看现有结构\n> 再改/);
  assert.match(md, /\*\*工具调用\*\* `edit`/);
  assert.match(md, /```json[\s\S]*"components\/A.tsx"[\s\S]*```/);
  assert.match(md, /<details><summary>edit 结果<\/summary>/);
  assert.match(md, /Edited components\/A.tsx \(1 replacement\)/);
});

test("clips tool output and long inputs", () => {
  const md = conversationToMarkdown(
    [
      {
        role: "toolResult",
        toolCallId: "c",
        toolName: "bash",
        content: [{ type: "text", text: "x".repeat(500) }],
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", toolName: "bash", input: { command: "y".repeat(800) } }],
      },
    ] as unknown as AgentMessage[],
    { maxToolOutputChars: 50, maxToolInputChars: 60 },
  );
  assert.match(md, /已截断，原长 500 字符/);
  assert.match(md, /已截断，原长 \d+ 字符/);
});

test("fences content that itself contains backticks", () => {
  const md = conversationToMarkdown([
    {
      role: "toolResult",
      toolCallId: "c",
      toolName: "read",
      content: [{ type: "text", text: "```js\nconst a = 1;\n```" }],
    },
  ] as unknown as AgentMessage[]);
  assert.match(md, /````text/);
});

test("empty conversation still returns a heading", () => {
  assert.equal(conversationToMarkdown([]).trim(), "# PiForge 对话导出");
});
