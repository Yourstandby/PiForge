/**
 * 结构护栏：排队消息的删除必须真的接上。
 *
 * 之前踩过的坑：Composer 的 props 类型里声明了 onRemoveFollowUp，但函数参数
 * 没解构，JSX 里引用的是个空名字 → 类型检查报错 / 删除按钮根本不渲染。
 * 这里把「解构 → 渲染 → 接上宿主命令」三段都钉死，改动时漏一段就红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");

test("Composer destructures onRemoveFollowUp (类型里声明 ≠ 真的能用到)", () => {
  const src = read("components/Composer.tsx");
  // 函数参数里必须出现解构出来的名字，且紧跟着是类型声明的同样写法。
  const signature = src.slice(0, src.indexOf("}) {"));
  assert.equal(signature.includes("onRemoveFollowUp,"), true, "props 必须在函数参数里解构");
  assert.equal(src.includes("onRemoveFollowUp?: (id: string) => void;"), true, "对外类型仍然保留");
});

test("Composer renders a per-item delete button that calls onRemoveFollowUp", () => {
  const src = read("components/Composer.tsx");
  assert.equal(src.includes("{onRemoveFollowUp && ("), true, "只有接上回调才渲染删除按钮");
  assert.equal(src.includes("onClick={() => onRemoveFollowUp(item.id)}"), true);
  assert.equal(src.includes("删除队列消息"), true, "按钮要有可读的 aria-label/title");
});

test("ChatSurface wires the delete callback from the session hook", () => {
  const surface = read("components/ChatSurface.tsx");
  assert.equal(surface.includes("onRemoveFollowUp={chat.handleRemoveFollowUp}"), true);

  const hook = read("hooks/useAgentSession.ts");
  assert.equal(hook.includes("const handleRemoveFollowUp = useCallback("), true);
  assert.equal(hook.includes("type: \"remove_follow_up\","), true, "必须交给宿主真正出队，只删本地会被快照请回来");
  assert.equal(hook.includes("expectedRevision: previous.revision"), true);
  assert.equal(/^\s+handleRemoveFollowUp,$/m.test(hook), true, "hook 返回值里要导出");
});

test("host handles remove_follow_up", () => {
  const rpc = read("agent-host/rpc-manager.ts");
  assert.equal(rpc.includes("case \"remove_follow_up\":"), true);
  const queue = read("agent-host/follow-up-queue.ts");
  assert.equal(/\bremove\(/.test(queue), true);
});
