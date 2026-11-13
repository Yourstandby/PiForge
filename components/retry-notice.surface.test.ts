/**
 * 结构护栏：模型连不上时，界面必须真的把原因画出来。
 *
 * 之前踩过的坑：pi 发 `auto_retry_start` → Host 透传 → reducer 存进 `retryInfo`
 * → hook 导出，链路全通，但 `components/` 下没有任何一个组件读它，
 * 于是用户只看到转圈。这里把「接线」和「不过滤」两端钉死。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");

test("ChatSurface 把 chat.retryInfo 接到界面上", () => {
  const src = read("components/ChatSurface.tsx");
  assert.equal(src.includes('import { RetryNotice } from "./RetryNotice";'), true, "必须 import 提示组件");
  assert.equal(src.includes("<RetryNotice info={chat.retryInfo} />"), true, "retryInfo 必须有渲染出口");
});

test("RetryNotice 是可见的 status 区域", () => {
  const src = read("components/RetryNotice.tsx");
  assert.equal(src.includes('role="status"'), true);
  assert.equal(src.includes("data-model-retry"), true);
});

test("重试提示不走 ui-error 的传输噪声过滤（否则本地模型 ECONNREFUSED 又被静默）", () => {
  const lib = read("lib/retry-notice.ts");
  const component = read("components/RetryNotice.tsx");
  assert.equal(/from\s+"[^"]*ui-error"/.test(lib), false, "不得 import ui-error");
  assert.equal(/from\s+"[^"]*ui-error"/.test(component), false, "不得 import ui-error");
  assert.equal(lib.includes("visibleErrorMessage("), false);
});
