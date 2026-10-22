/**
 * 技能自动分类 + 一句话概述。
 *
 * 纯前端、纯同步、零网络：只用 skill 的 name / description 做关键词匹配，
 * 不调用模型、不读磁盘。手动覆盖存在 localStorage（不污染 SKILL.md）。
 */

export type SkillCategoryId =
  | "design"
  | "frontend"
  | "backend"
  | "testing"
  | "docs"
  | "release"
  | "workflow"
  | "meta"
  | "other";

/** 展示顺序与 i18n key（`skills.category.<id>`）。 */
export const SKILL_CATEGORY_ORDER: SkillCategoryId[] = [
  "design",
  "frontend",
  "backend",
  "testing",
  "docs",
  "release",
  "workflow",
  "meta",
  "other",
];

/** 先命中的规则决定分类；顺序 = 优先级。 */
const RULES: Array<{ id: SkillCategoryId; keywords: string[] }> = [
  {
    id: "design",
    keywords: ["design", "ui/ux", "ui-ux", "ux", "visual", "brand", "设计", "视觉", "美观"],
  },
  {
    id: "frontend",
    keywords: ["react", "next.js", "nextjs", "vue", "svelte", "angular", "css", "tailwind", "component", "frontend", "前端", "组件"],
  },
  {
    id: "backend",
    keywords: ["backend", "api", "server", "database", "sql", "node.js", "后端", "接口", "数据库"],
  },
  {
    id: "testing",
    keywords: ["test", "jest", "vitest", "playwright", "e2e", "coverage", "测试", "回归"],
  },
  {
    id: "docs",
    keywords: ["documentation", "readme", "markdown", "changelog", "文档", "说明"],
  },
  {
    id: "release",
    keywords: ["deploy", "deployment", "release", "publish", "ci/cd", "pipeline", "npm publish", "发布", "部署", "上线"],
  },
  {
    id: "workflow",
    keywords: ["workflow", "methodology", "process", "review", "refactor", "plan", "流程", "工作流", "方法论", "重构"],
  },
  {
    id: "meta",
    keywords: ["find-skills", "skill router", "skills.sh", "install a skill", "discover and install", "技能", "元技能"],
  },
];

export interface CategorizableSkill {
  name: string;
  description: string;
  filePath: string;
}

function haystack(skill: CategorizableSkill): string {
  return `${skill.name} ${skill.description}`.toLowerCase();
}

/** 关键词自动分类；无命中归到 `other`。 */
export function categorizeSkill(skill: CategorizableSkill): SkillCategoryId {
  const text = haystack(skill);
  for (const rule of RULES) {
    if (rule.keywords.some((keyword) => text.includes(keyword))) return rule.id;
  }
  return "other";
}

const STORAGE_KEY = "piforge.skillCategories";

export type SkillCategoryOverrides = Record<string, SkillCategoryId>;

function isCategoryId(value: unknown): value is SkillCategoryId {
  return typeof value === "string" && SKILL_CATEGORY_ORDER.includes(value as SkillCategoryId);
}

/** 读取手动分类覆盖（浏览器端；SSR / 损坏数据一律返回空表）。 */
export function readCategoryOverrides(): SkillCategoryOverrides {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const result: SkillCategoryOverrides = {};
    for (const [path, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isCategoryId(value)) result[path] = value;
    }
    return result;
  } catch {
    return {};
  }
}

/** 写入/清除单个覆盖；`null` 表示恢复自动分类。返回写入后的全表。 */
export function writeCategoryOverride(
  overrides: SkillCategoryOverrides,
  filePath: string,
  category: SkillCategoryId | null,
): SkillCategoryOverrides {
  const next = { ...overrides };
  if (category) next[filePath] = category;
  else delete next[filePath];
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* 存储不可用时仅本次会话生效 */
    }
  }
  return next;
}

/** 手动覆盖优先，否则关键词自动分类。 */
export function resolveSkillCategory(
  skill: CategorizableSkill,
  overrides: SkillCategoryOverrides,
): { id: SkillCategoryId; manual: boolean } {
  const manual = overrides[skill.filePath];
  if (isCategoryId(manual)) return { id: manual, manual: true };
  return { id: categorizeSkill(skill), manual: false };
}

/** 概述：取首个句子并截到 `max` 个字符（默认 25，超出加省略号）。 */
export function summarizeSkill(description: string, max = 25): string {
  const text = (description ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const sentence = text.split(/(?<=[.。!?！？])\s*/)[0] ?? text;
  const trimmed = sentence.replace(/[.。]$/, "").trim();
  const chars = Array.from(trimmed);
  if (chars.length <= max) return trimmed;
  if (max <= 1) return "…";
  return `${chars.slice(0, max - 1).join("")}…`;
}
