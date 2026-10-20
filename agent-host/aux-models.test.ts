import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuxModelError,
  auxToolAvailability,
  classifyDecision,
  generateImage,
  getAuxCatalogue,
  invalidateAuxRuntime,
  readAuxConfig,
  setAuxConfig,
} from "./aux-models.ts";
import { readDesktopSettings } from "../lib/desktop-settings.ts";
import { desktopRuntimeTools } from "./desktop-runtime-tools.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/** Point pi's agent dir at a temp directory for one test. */
function useAgentDir(dir: string): () => void {
  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = dir;
  invalidateAuxRuntime();
  return () => {
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
    invalidateAuxRuntime();
  };
}

/** Static catalogue entries: they resolve without credentials. */
const IMAGE_MODEL = { provider: "openrouter", modelId: "black-forest-labs/flux.2-pro" };
const DECISION_MODEL = { provider: "openai", modelId: "gpt-6-luna" };

test("auxiliary model selections persist in desktop-settings.json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "piforge-aux-config-"));
  const restore = useAgentDir(join(dir, "agent"));
  try {
    assert.deepEqual(readAuxConfig(), { image: null, decision: null });
    assert.deepEqual(auxToolAvailability(), { image: false, decision: false });

    const saved = await setAuxConfig({ image: IMAGE_MODEL, decision: DECISION_MODEL });
    assert.deepEqual(saved, { image: IMAGE_MODEL, decision: DECISION_MODEL });
    assert.deepEqual(readAuxConfig(), { image: IMAGE_MODEL, decision: DECISION_MODEL });
    assert.deepEqual(auxToolAvailability(), { image: true, decision: true });

    const settings = readDesktopSettings(join(dir, "agent"));
    assert.deepEqual(settings.imageModel, IMAGE_MODEL);
    assert.deepEqual(settings.decisionModel, DECISION_MODEL);

    // `null` clears one lane without touching the other.
    const cleared = await setAuxConfig({ image: null });
    assert.deepEqual(cleared, { image: null, decision: DECISION_MODEL });
    assert.deepEqual(auxToolAvailability(), { image: false, decision: true });
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown auxiliary models are rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "piforge-aux-invalid-"));
  const restore = useAgentDir(join(dir, "agent"));
  try {
    await assert.rejects(
      () => setAuxConfig({ image: { provider: "openrouter", modelId: "not-a-real-model" } }),
      (error: unknown) => error instanceof AuxModelError && error.code === "E_INVALID_PARAMS",
    );
    await assert.rejects(
      () => setAuxConfig({ decision: { provider: "nope", modelId: "nope" } }),
      (error: unknown) => error instanceof AuxModelError && error.code === "E_INVALID_PARAMS",
    );
    assert.deepEqual(readAuxConfig(), { image: null, decision: null });
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalogue returns available lanes and the stored selection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "piforge-aux-catalogue-"));
  const restore = useAgentDir(join(dir, "agent"));
  try {
    await setAuxConfig({ image: IMAGE_MODEL });
    const catalogue = await getAuxCatalogue();
    assert.ok(Array.isArray(catalogue.image));
    assert.ok(Array.isArray(catalogue.classifier));
    // No credentials in this temp agent dir: nothing is available yet.
    assert.deepEqual(catalogue.image, []);
    assert.deepEqual(catalogue.classifier, []);
    assert.deepEqual(catalogue.config.image, IMAGE_MODEL);
    assert.equal(catalogue.config.decision, null);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("image generation reports unconfigured credentials instead of throwing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "piforge-aux-image-"));
  const restore = useAgentDir(join(dir, "agent"));
  try {
    await setAuxConfig({ image: IMAGE_MODEL });
    const report = await generateImage("a cat reading a book");
    assert.equal(report.ok, false);
    assert.match(report.error ?? "", /not configured/i);
    assert.deepEqual(report.images, []);
    assert.equal(report.prompt, "a cat reading a book");
    assert.equal(typeof report.elapsedMs, "number");
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("image generation without a model raises AUX_MODEL_NOT_CONFIGURED", async () => {
  const dir = mkdtempSync(join(tmpdir(), "piforge-aux-image-missing-"));
  const restore = useAgentDir(join(dir, "agent"));
  try {
    await assert.rejects(
      () => generateImage("a cat"),
      (error: unknown) => error instanceof AuxModelError && error.code === "AUX_MODEL_NOT_CONFIGURED",
    );
    await assert.rejects(
      () => generateImage(""),
      (error: unknown) => error instanceof AuxModelError && error.code === "E_INVALID_PARAMS",
    );
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decision model validation and unconfigured credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "piforge-aux-decision-"));
  const restore = useAgentDir(join(dir, "agent"));
  try {
    await assert.rejects(
      () => classifyDecision({ state: {}, questions: [] }),
      (error: unknown) => error instanceof AuxModelError && error.code === "E_INVALID_PARAMS",
    );
    await assert.rejects(
      () => classifyDecision({
        state: {},
        questions: [{ key: "risk", mode: "choice", instructions: "pick", choices: [] }],
      }),
      (error: unknown) => error instanceof AuxModelError && error.code === "E_INVALID_PARAMS",
    );

    await setAuxConfig({ decision: DECISION_MODEL });
    const report = await classifyDecision({
      state: { diff: "+42 lines" },
      questions: [{
        key: "risk",
        mode: "choice",
        instructions: "How risky is this change?",
        choices: ["low", "medium", "high"],
      }],
    });
    assert.equal(report.ok, false);
    assert.match(report.error ?? "", /not configured/i);
    assert.deepEqual(report.answers, {});
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aux tools are only declared once configured", () => {
  const registered = [
    { name: "read", description: "" },
    { name: "generate_image", description: "" },
    { name: "classify_decision", description: "" },
  ];
  const without = desktopRuntimeTools("full", "default", false, registered, []);
  assert.ok(!without.includes("generate_image"));
  assert.ok(!without.includes("classify_decision"));

  const onlyImage = desktopRuntimeTools("full", "default", false, registered, [], {
    image: true,
    decision: false,
  });
  assert.ok(onlyImage.includes("generate_image"));
  assert.ok(!onlyImage.includes("classify_decision"));

  const both = desktopRuntimeTools("full", "default", false, registered, [], {
    image: true,
    decision: true,
  });
  assert.ok(both.includes("generate_image"));
  assert.ok(both.includes("classify_decision"));

  // Plan mode and the "none" preset still strip every declaration.
  assert.ok(!desktopRuntimeTools("plan", "default", false, registered, [], { image: true, decision: true }).includes("generate_image"));
  assert.ok(!desktopRuntimeTools("full", "none", false, registered, [], { image: true, decision: true }).includes("generate_image"));
});
