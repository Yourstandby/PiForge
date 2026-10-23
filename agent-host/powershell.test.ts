import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  buildPowerShellArgs,
  pickPowerShell,
  resolvePowerShell,
} from "./powershell.ts";
import { desktopRuntimeTools } from "./desktop-runtime-tools.ts";

test("PowerShell invocation is non-interactive and forces UTF-8", () => {
  const args = buildPowerShellArgs("Write-Output 'hi'");
  assert.deepEqual(args.slice(0, 5), [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
  ]);
  const script = args[5];
  assert.match(script, /\[Console\]::OutputEncoding=\[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
  assert.match(script, /\$OutputEncoding=\[Console\]::OutputEncoding/);
  assert.match(script, /PYTHONIOENCODING='utf-8'/);
  assert.ok(script.endsWith("Write-Output 'hi'"), "user script must be appended unchanged");
});

test("PowerShell resolution prefers pwsh 7 and falls back to 5.1", () => {
  const existing = new Set(["C:/pwsh.exe", "C:/powershell.exe"]);
  assert.deepEqual(
    pickPowerShell({ pwsh: "C:/pwsh.exe", windowsPowerShell: "C:/powershell.exe" }, (path) => existing.has(path)),
    { kind: "pwsh", executable: "C:/pwsh.exe" },
  );
  assert.deepEqual(
    pickPowerShell({ pwsh: "C:/missing.exe", windowsPowerShell: "C:/powershell.exe" }, (path) => existing.has(path)),
    { kind: "windows-powershell", executable: "C:/powershell.exe" },
  );
  assert.equal(pickPowerShell({}, () => false), null);
});

test("PowerShell is folded into the shell facade, never declared on its own", () => {
  const registered = [{ name: "powershell", description: "" }];
  const shellRegistered = [...registered, { name: "shell", description: "" }];
  // 旧名字不再直接声明（已收进 shell 的 exec 动作）。
  assert.ok(
    !desktopRuntimeTools("full", "default", false, shellRegistered, [], undefined, "win32").includes("powershell"),
  );
  // 声明的是 shell 多态工具 —— 第 8 步起它默认按需，激活后才会被声明。
  assert.ok(
    desktopRuntimeTools("full", "default", false, shellRegistered, ["shell"], undefined, "win32").includes(
      "shell"
    ),
  );
  // plan 模式只读：shell 只在只读动作白名单里出现（由 policy 逐动作判定）。
  assert.ok(
    !desktopRuntimeTools("plan", "default", false, shellRegistered, [], undefined, "win32").includes("shell"),
  );
});

test("PowerShell preserves Unicode, quotes and multiline output", { skip: process.platform !== "win32" }, () => {
  const found = resolvePowerShell();
  assert.ok(found, "PowerShell must be available on Windows");
  const script = [
    "Write-Output '你好，世界'",
    "Write-Output 'quoted \"value\" and spaces'",
    "Write-Output \"line-one`nline-two\"",
  ].join("\n");
  const result = spawnSync(found.executable, buildPowerShellArgs(script), {
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout ?? "", /你好，世界/);
  assert.match(result.stdout ?? "", /quoted "value" and spaces/);
  assert.match(result.stdout ?? "", /line-one\r?\nline-two/);
  assert.match(result.stdout ?? "", /line-two/);
});
