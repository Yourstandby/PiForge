/**
 * 结构护栏：对话里的图片只有一种尺寸口径；同一条消息只会提交一次。
 *
 * 踩过的坑（2026-11-22，yourstandby 会话）：
 * 1. 消息图分别写死 max-h-64 / max-h-72 / max-h-80（用户 / 工具产出 / 助手），
 *    同一张参考图在不同气泡里就是三个大小；且只限高不限宽，宽图按高度换算出
 *    的宽度超出气泡，flex 项不肯收缩 → 图被横向裁成半张；
 * 2. 同一条消息在极短时间内被提交两次 → 界面并排出现两条同一秒的气泡，像被复制。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");

test("图片尺寸只有一个常量，且同时限高限宽", () => {
  const src = read("components/Transcript.tsx");
  assert.ok(src.includes('const CHAT_IMAGE_SIZE = "max-h-64 max-w-full"'), "消息图常量要限高 + 限宽");
  assert.ok(src.includes('const TOOL_IMAGE_SIZE = "max-h-72 max-w-full"'), "工具产出图同样要限宽");

  // 每一处 object-contain 的图片 className 都必须走常量，不许再手写尺寸。
  const literal = [...src.matchAll(/className="([^"]*object-contain[^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(literal, [], `图片 className 必须引用常量，手写的还有: ${literal.join(" | ")}`);

  const templated = [...src.matchAll(/className={`([^`]*object-contain[^`]*)`}/g)].map((m) => m[1]);
  assert.ok(templated.length >= 4, `四处图片渲染都该走常量，实际 ${templated.length}`);
  for (const value of templated) {
    assert.ok(/CHAT_IMAGE_SIZE|TOOL_IMAGE_SIZE/.test(value), value);
  }
});

test("图片外壳允许收缩，不把气泡撑破", () => {
  const src = read("components/Transcript.tsx");
  const start = src.indexOf("function ClickableImage");
  const button = src.slice(start, start + 1200);
  assert.ok(button.includes("max-w-full"), "外壳要有 max-w-full");
  assert.ok(button.includes("min-w-0"), "flex 项要能收缩（min-w-0）");
});

test("Composer 拦截同一段话的重复提交", () => {
  const src = read("components/Composer.tsx");
  assert.ok(src.includes("const DUPLICATE_SUBMIT_MS"), "重复提交窗口要显式命名");
  assert.ok(src.includes("lastSubmitRef"), "要有上一次提交的记账");
  assert.ok(
    /lastSubmitRef\.current\.key === submitKey[\s\S]{0,120}DUPLICATE_SUBMIT_MS/.test(src),
    "同 key 且落在窗口内必须直接 return",
  );
});

test("首 token 之前不报「本轮产出 0」", () => {
  const surface = read("components/ChatSurface.tsx");
  assert.ok(surface.includes("等待首个 token"), "要有等待首 token 的文案");
  assert.ok(
    /chat\.agentRunning && turnOutputTokens \+ liveTokens === 0 && tokensPerSecond === 0[\s\S]{0,200}等待首个 token/.test(
      surface,
    ),
    "等待文案只能出现在「跑着但还没产出」的分支",
  );
});
