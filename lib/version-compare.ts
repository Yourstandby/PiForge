/**
 * 语义化版本工具：纯函数、零依赖。
 *
 * 单独成文件是因为 `lib/upstream-version.ts` 会 import `node:fs`，
 * 客户端组件（版本选择器）不能拉那份模块，只能引这里。
 */

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** 是否为合法的 x.y.z[-pre][+build]，用于挡住 npm spec 注入。 */
export function isValidVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && VERSION_RE.test(value);
}

/** 语义化版本比较：a > b 返回正数。忽略预发布标签以外的差异，够用于 x.y.z。 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => value.split("-")[0].split(".").map((part) => Number(part) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** 是否预发布版本（1.4.0-beta.1 之类）。 */
export function isPrerelease(value: string): boolean {
  return value.includes("-");
}

/** 版本列表按语义化降序（最新在前）；同版本预发布排在正式版之后。 */
export function sortVersionsDesc(versions: string[]): string[] {
  return [...new Set(versions)].sort((a, b) => {
    const byCore = compareVersions(b, a);
    if (byCore !== 0) return byCore;
    return a.localeCompare(b);
  });
}
