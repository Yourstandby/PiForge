import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserDeniedReason,
  browserPermissionPrompt,
  clearAllBrowserSessionGrants,
  forgetSessionBrowserPermissions,
  grantSessionBrowserPermissions,
  hasSessionBrowserGrant,
  missingBrowserPermissions,
  readBrowserPermissions,
} from "./browser-permissions.ts";
import { writeDesktopSettings } from "../lib/desktop-settings.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function useAgentDir(dir: string): () => void {
  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = dir;
  return () => {
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
    clearAllBrowserSessionGrants();
  };
}

test("browser permissions are off unless desktop-settings enables them", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-browser-perms-"));
  const restore = useAgentDir(dir);
  try {
    assert.deepEqual(readBrowserPermissions(), { read: false, interact: false });

    writeDesktopSettings(dir, {
      defaultAgentMode: "full",
      defaultToolPreset: "default",
      browserReadEnabled: true,
    });
    assert.deepEqual(readBrowserPermissions(), { read: true, interact: false });

    writeDesktopSettings(dir, {
      defaultAgentMode: "full",
      defaultToolPreset: "default",
      browserReadEnabled: true,
      browserInteractEnabled: true,
    });
    assert.deepEqual(readBrowserPermissions(), { read: true, interact: true });
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session grants cover only the requested capability and can be forgotten", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-browser-grants-"));
  const restore = useAgentDir(dir);
  try {
    const sessionId = "session-1";
    assert.deepEqual(missingBrowserPermissions(sessionId, ["read"]), ["read"]);
    assert.equal(hasSessionBrowserGrant(sessionId, "read"), false);

    grantSessionBrowserPermissions(sessionId, ["read"]);
    assert.equal(hasSessionBrowserGrant(sessionId, "read"), true);
    assert.equal(hasSessionBrowserGrant(sessionId, "interact"), false);
    assert.deepEqual(missingBrowserPermissions(sessionId, ["read", "interact"]), ["interact"]);

    // Another session never inherits the grant.
    assert.deepEqual(missingBrowserPermissions("session-2", ["read"]), ["read"]);

    forgetSessionBrowserPermissions(sessionId);
    assert.deepEqual(missingBrowserPermissions(sessionId, ["read"]), ["read"]);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("permission prompt and denial text name the requested capabilities", () => {
  assert.match(browserPermissionPrompt(["read"]), /读取网页内容/);
  assert.match(browserPermissionPrompt(["read"]), /当前会话生效/);
  assert.match(browserPermissionPrompt(["interact"]), /打开 \/ 导航网页/);
  const both = browserPermissionPrompt(["read", "interact"]);
  assert.match(both, /读取网页内容并导航内置浏览器/);

  assert.match(browserDeniedReason(["read"]), /未授予「读取网页内容」/);
  assert.match(browserDeniedReason(["read", "interact"]), /读取网页内容」和「操作内置浏览器/);
});
