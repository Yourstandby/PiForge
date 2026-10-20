import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DEV_TOOL_SPECS,
  firstVersionLine,
  probeDevEnvironment,
  type DevToolSpec,
} from "./dev-tools.ts";

test("firstVersionLine prefers stdout and falls back to stderr", () => {
  assert.equal(firstVersionLine("v22.1.0\n", ""), "v22.1.0");
  assert.equal(firstVersionLine("", "Python 3.12.0\n"), "Python 3.12.0");
  assert.equal(firstVersionLine("\n\n  git version 2.45.0  \n", ""), "git version 2.45.0");
  assert.equal(firstVersionLine("", ""), undefined);
});

test("custom specs report found/missing tools and required gaps", async () => {
  const specs: DevToolSpec[] = [
    {
      id: "node",
      name: "Node.js",
      required: true,
      candidates: [{ command: "node", args: ["--version"] }],
    },
    {
      id: "missing",
      name: "Missing Tool",
      required: true,
      candidates: [{ command: "piforge-missing-tool-for-tests", args: ["--version"] }],
    },
    {
      id: "optional-missing",
      name: "Optional Missing",
      required: false,
      candidates: [{ command: "piforge-optional-missing-for-tests", args: ["--version"] }],
    },
  ];
  const report = await probeDevEnvironment({ specs });
  const byId = new Map(report.tools.map((tool) => [tool.id, tool]));

  assert.equal(report.tools.length, 3);
  assert.equal(byId.get("node")?.found, true);
  assert.match(byId.get("node")?.version ?? "", /^v?\d+\./);
  assert.equal(byId.get("missing")?.found, false);
  assert.equal(byId.get("missing")?.error, "not found in PATH");
  assert.equal(byId.get("optional-missing")?.found, false);

  assert.deepEqual(report.missingRequired, ["Missing Tool"]);
  assert.equal(report.platform, process.platform);
  assert.equal(report.arch, process.arch);
  assert.equal(report.hostNode, process.version);
  assert.equal(typeof report.probedAt, "number");
});

test("the default scan covers the documented toolchain and finds Node", { timeout: 30000 }, async () => {
  const report = await probeDevEnvironment({ refresh: true });
  const ids = report.tools.map((tool) => tool.id);
  for (const id of ["node", "python", "git", "bash", "bun", "jq", "npm"]) {
    assert.ok(ids.includes(id), `expected a probe for ${id}`);
  }
  const node = report.tools.find((tool) => tool.id === "node");
  assert.equal(node?.found, true);
  assert.equal(node?.required, true);
  assert.ok(DEFAULT_DEV_TOOL_SPECS.length >= 7);
});
