import test from "node:test";
import assert from "node:assert/strict";
import {
  SKILL_CATEGORY_ORDER,
  categorizeSkill,
  resolveSkillCategory,
  summarizeSkill,
  writeCategoryOverride,
} from "./skill-category.ts";

const skill = (name: string, description = "") => ({
  name,
  description,
  filePath: `C:/skills/${name}/SKILL.md`,
});

test("categorizeSkill routes by keyword", () => {
  assert.equal(categorizeSkill(skill("ui-ux-pro-max", "Comprehensive design guide")), "design");
  assert.equal(categorizeSkill(skill("frontend-design", "distinctive visual design")), "design");
  assert.equal(categorizeSkill(skill("react-helper", "patterns for react and next.js")), "frontend");
  assert.equal(categorizeSkill(skill("vitest-runner", "run vitest suites")), "testing");
  assert.equal(categorizeSkill(skill("release-notes", "publish release notes")), "release");
  assert.equal(categorizeSkill(skill("karpathy-methodology", "Apply AI methodology")), "workflow");
  assert.equal(categorizeSkill(skill("find-skills", "discover and install agent skills")), "meta");
  assert.equal(categorizeSkill(skill("misc", "does something")), "other");
});

test("categorizeSkill is case insensitive and falls back to other", () => {
  assert.equal(categorizeSkill(skill("X", "React Testing")), "frontend");
  assert.equal(categorizeSkill(skill("empty", "")), "other");
});

test("summarizeSkill trims to the first sentence within max chars", () => {
  assert.equal(summarizeSkill("Short sentence. Second one."), "Short sentence");
  assert.equal(
    summarizeSkill("Helps users discover and install agent skills when they ask questions about how to do something."),
    "Helps users discover and…",
  );
  assert.equal(summarizeSkill("第一句话。第二句。"), "第一句话");
  assert.equal(summarizeSkill(""), "");
  assert.equal(summarizeSkill("a".repeat(40), 5), "aaaa…");
});

test("writeCategoryOverride sets, clears and ignores bad ids", () => {
  let overrides = {};
  overrides = writeCategoryOverride(overrides, "C:/skills/x/SKILL.md", "testing");
  assert.deepEqual(resolveSkillCategory(skill("x", "design"), overrides), { id: "testing", manual: true });
  overrides = writeCategoryOverride(overrides, "C:/skills/x/SKILL.md", null);
  assert.deepEqual(resolveSkillCategory(skill("x", "design"), overrides), { id: "design", manual: false });
});

test("category order covers every id", () => {
  assert.equal(new Set(SKILL_CATEGORY_ORDER).size, SKILL_CATEGORY_ORDER.length);
  assert.ok(SKILL_CATEGORY_ORDER.includes("other"));
});
