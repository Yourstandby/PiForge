import assert from "node:assert/strict";
import { test } from "node:test";
import { computeRevealChain } from "./file-reveal.ts";

test("展开深层文件的祖先目录", () => {
  const chain = computeRevealChain("D:/work/proj", "D:/work/proj/figures/out/fig.pdf");
  assert.deepEqual(chain.ancestors, ["D:/work/proj/figures", "D:/work/proj/figures/out"]);
  assert.equal(chain.target, "D:/work/proj/figures/out/fig.pdf");
});

test("项目根下的文件无需展开", () => {
  const chain = computeRevealChain("D:/work/proj", "D:/work/proj/README.md");
  assert.deepEqual(chain.ancestors, []);
  assert.equal(chain.target, "D:/work/proj/README.md");
});

test("Windows 反斜杠路径归一后仍能定位", () => {
  const chain = computeRevealChain("D:\\work\\proj", "D:\\work\\proj\\lib\\a.ts");
  assert.deepEqual(chain.ancestors, ["D:/work/proj/lib"]);
  assert.equal(chain.target, "D:/work/proj/lib/a.ts");
});

test("cwd 末尾斜杠不影响定位", () => {
  const chain = computeRevealChain("D:/work/proj/", "D:/work/proj/lib/a.ts");
  assert.deepEqual(chain.ancestors, ["D:/work/proj/lib"]);
});

test("项目外的文件不展开（退出只打开预览）", () => {
  assert.equal(computeRevealChain("D:/work/proj", "D:/other/a.ts").target, null);
  assert.equal(computeRevealChain("D:/work/proj", "C:/Users/x/a.ts").target, null);
});

test("目标就是 cwd 本身时不动树", () => {
  assert.equal(computeRevealChain("D:/work/proj", "D:/work/proj").target, null);
});

test("前缀相似的兄弟目录不算项目内", () => {
  assert.equal(computeRevealChain("D:/work/proj", "D:/work/proj2/a.ts").target, null);
});
