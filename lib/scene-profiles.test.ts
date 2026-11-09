import assert from "node:assert/strict";
import test from "node:test";
import {
  applySceneProfile,
  auditSceneProfile,
  draftPrivateProfile,
  isLocalEndpoint,
  sceneModel,
} from "./scene-profiles.ts";
import { defaultDesktopSettings, mergeDesktopSettings } from "./desktop-settings.ts";

test("isLocalEndpoint accepts loopback, RFC1918 and mdns, rejects clouds", () => {
  for (const url of [
    "http://127.0.0.1:11434/v1",
    "http://localhost:1234/v1",
    "http://[::1]:8080",
    "http://10.0.0.5/v1",
    "http://192.168.1.7:8000/v1",
    "http://172.16.3.9/v1",
    "http://172.31.255.1/v1",
    "http://box.local:11434/v1",
    "http://gpu.internal/v1",
    "127.0.0.1:11434",
  ]) {
    assert.equal(isLocalEndpoint(url), true, url);
  }
  for (const url of [
    "https://api.deepseek.com/v1",
    "https://api.openai.com/v1",
    "http://172.32.0.1/v1",
    "http://8.8.8.8/v1",
    "not a url",
    "",
    null,
  ]) {
    assert.equal(isLocalEndpoint(url as string), false, String(url));
  }
});

test("audit fails when any lane is missing or cloud-backed", () => {
  const local = { provider: "ollama", modelId: "qwen2.5-coder:7b" };
  const cloud = { provider: "deepseek", modelId: "deepseek-chat" };
  const baseUrls = { ollama: "http://127.0.0.1:11434/v1" };

  const missing = auditSceneProfile({ model: local }, baseUrls);
  assert.equal(missing.ok, false);
  assert.deepEqual(
    missing.issues.map((i) => [i.lane, i.reason]),
    [
      ["autoRoutingFast", "unset"],
      ["autoRoutingStrong", "unset"],
      ["imageModel", "unset"],
      ["decisionModel", "unset"],
    ],
  );

  const leaky = auditSceneProfile(
    {
      model: local,
      autoRoutingFast: cloud,
      autoRoutingStrong: local,
      imageModel: local,
      decisionModel: local,
    },
    baseUrls,
  );
  assert.equal(leaky.ok, false);
  assert.deepEqual(
    leaky.issues.map((i) => [i.lane, i.reason, i.provider]),
    [["autoRoutingFast", "non-local", "deepseek"]],
  );

  const good = auditSceneProfile(
    {
      model: local,
      autoRoutingFast: local,
      autoRoutingStrong: local,
      imageModel: local,
      decisionModel: local,
    },
    baseUrls,
  );
  assert.equal(good.ok, true);
  assert.deepEqual(good.localProviders, ["ollama"]);
});

test("audit flags known clouds as non-local and unknown providers as unsafe", () => {
  const cloud = { provider: "deepseek", modelId: "deepseek-chat" };
  const five = {
    model: cloud,
    autoRoutingFast: cloud,
    autoRoutingStrong: cloud,
    imageModel: cloud,
    decisionModel: cloud,
  };
  const audit = auditSceneProfile(five, {});
  assert.equal(audit.ok, false);
  assert.equal(audit.issues[0].reason, "non-local");
});

test("audit treats unknown providers as unsafe but accepts ollama ids", () => {
  const ref = { provider: "lmstudio", modelId: "qwen3:8b" };
  const profile = {
    model: ref,
    autoRoutingFast: ref,
    autoRoutingStrong: ref,
    imageModel: ref,
    decisionModel: ref,
  };
  assert.equal(auditSceneProfile(profile, {}).ok, true);
  const unknown = auditSceneProfile({ ...profile, model: { provider: "my-gateway", modelId: "x" } }, {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.issues[0].reason, "unknown-provider");
});

test("applySceneProfile pins private lanes and closes browser access", () => {
  const base = { ...defaultDesktopSettings(), browserReadEnabled: true, browserInteractEnabled: true };
  const local = { provider: "ollama", modelId: "qwen2.5-coder:7b" };
  const profile = {
    model: local,
    autoRoutingFast: local,
    autoRoutingStrong: local,
    imageModel: local,
    decisionModel: local,
    browserReadEnabled: true,
  };
  const priv = applySceneProfile(base, "private", profile);
  assert.equal(priv.activeScene, "private");
  assert.equal(priv.browserReadEnabled, false);
  assert.equal(priv.browserInteractEnabled, false);
  assert.deepEqual(priv.autoRoutingFast, local);
  assert.deepEqual(sceneModel(profile), local);

  const normal = applySceneProfile(priv, "normal", { browserReadEnabled: true });
  assert.equal(normal.browserReadEnabled, true);
  assert.equal(normal.activeScene, "normal");
});

test("sceneProfiles survive a settings round-trip and reject junk", () => {
  const local = { provider: "ollama", modelId: "qwen2.5-coder:7b" };
  const merged = mergeDesktopSettings({
    activeScene: "private",
    sceneProfiles: { private: { model: local, imageModel: local }, normal: { model: { provider: "deepseek", modelId: "deepseek-chat" } } },
    junk: 1,
  });
  assert.equal(merged.activeScene, "private");
  assert.deepEqual(merged.sceneProfiles?.private?.model, local);
  assert.equal(merged.sceneProfiles?.normal?.model?.provider, "deepseek");
  assert.equal(mergeDesktopSettings({ activeScene: "leaky" }).activeScene, undefined);
});

test("draftPrivateProfile prefers a registered local provider", () => {
  const models = [
    { provider: "deepseek", id: "deepseek-chat" },
    { provider: "ollama-local", id: "qwen2.5-coder:7b" },
  ];
  const draft = draftPrivateProfile(models, { "ollama-local": "http://127.0.0.1:11434/v1" });
  assert.ok(draft);
  assert.equal(draft.provider, "ollama-local");
  assert.deepEqual(draft.profile.decisionModel, { provider: "ollama-local", modelId: "qwen2.5-coder:7b" });
  assert.equal(draftPrivateProfile([{ provider: "deepseek", id: "deepseek-chat" }], {}), null);
});
