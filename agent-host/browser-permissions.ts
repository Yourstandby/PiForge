/**
 * Browser capability policy (v0.5.0 stage 3).
 *
 * The built-in browser is a privileged surface: reading a page can expose
 * logged-in content, and navigating it can act as the user. The agent therefore
 * needs an explicit grant per capability:
 *
 *   - `read`     — read page text / take screenshots
 *   - `interact` — open / navigate the built-in browser
 *
 * Grants live in `desktop-settings.json` (user-chosen defaults) and, for the
 * "allow once for this session" path, in this module's in-memory map keyed by
 * session id. All checks run in the Agent Host.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readDesktopSettings } from "../lib/desktop-settings.ts";

export type BrowserPermissionKind = "read" | "interact";

export interface BrowserPermissions {
  read: boolean;
  interact: boolean;
}

export function readBrowserPermissions(): BrowserPermissions {
  try {
    const settings = readDesktopSettings(getAgentDir());
    return {
      read: settings.browserReadEnabled === true,
      interact: settings.browserInteractEnabled === true,
    };
  } catch {
    return { read: false, interact: false };
  }
}

const sessionGrants = new Map<string, Set<BrowserPermissionKind>>();

export function hasSessionBrowserGrant(sessionId: string, kind: BrowserPermissionKind): boolean {
  return sessionGrants.get(sessionId)?.has(kind) ?? false;
}

export function grantSessionBrowserPermissions(
  sessionId: string,
  kinds: readonly BrowserPermissionKind[],
): void {
  if (kinds.length === 0) return;
  const grants = sessionGrants.get(sessionId) ?? new Set<BrowserPermissionKind>();
  for (const kind of kinds) grants.add(kind);
  sessionGrants.set(sessionId, grants);
}

/** Called when the session ends so grants never outlive it. */
export function forgetSessionBrowserPermissions(sessionId: string): void {
  sessionGrants.delete(sessionId);
}

export function clearAllBrowserSessionGrants(): void {
  sessionGrants.clear();
}

/** Grants that are neither enabled globally nor already allowed for this session. */
export function missingBrowserPermissions(
  sessionId: string,
  kinds: readonly BrowserPermissionKind[],
): BrowserPermissionKind[] {
  const global = readBrowserPermissions();
  return kinds.filter((kind) => {
    const enabled = kind === "read" ? global.read : global.interact;
    return !enabled && !hasSessionBrowserGrant(sessionId, kind);
  });
}

/** User-facing confirmation text for the capabilities the agent just requested. */
export function browserPermissionPrompt(kinds: readonly BrowserPermissionKind[]): string {
  const wantsRead = kinds.includes("read");
  const wantsInteract = kinds.includes("interact");
  const action =
    wantsRead && wantsInteract
      ? "读取网页内容并导航内置浏览器"
      : wantsRead
        ? "读取网页内容（页面文本 / 截图）"
        : "操作内置浏览器（打开 / 导航网页）";
  return [
    `Agent 请求${action}，是否允许？`,
    "本次允许仅对当前会话生效；可在 设置 → 开发环境 → 浏览器权限 中永久开启。",
  ].join("\n");
}

/** Block reason returned to the model when the user declines. */
export function browserDeniedReason(kinds: readonly BrowserPermissionKind[]): string {
  const labels = kinds.map((kind) => (kind === "read" ? "读取网页内容" : "操作内置浏览器"));
  return [
    `浏览器操作被拒绝：用户未授予「${labels.join("」和「")}」权限。`,
    "请让用户在 设置 → 开发环境 → 浏览器权限 中开启，或在下一次调用时同意临时授权。",
  ].join("");
}
