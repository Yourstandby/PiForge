/**
 * Electron-side CSP builder. Mirrors lib/csp.ts (electron tsc rootDir is electron/
 * only, so we cannot import from ../lib without expanding the electron build).
 * Keep in sync with lib/csp.ts — both are covered by lib/csp.test.ts contract
 * and electron structural tests on main.ts usage.
 */

export type ElectronCspPort = number;

export function buildElectronCspHeader(port: ElectronCspPort): string {
  return [
    "default-src 'self'",
    `connect-src 'self' http://127.0.0.1:${port} ws://127.0.0.1:${port}`,
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // Keep in sync with lib/csp.ts — the built-in browser frames live pages.
    "frame-src 'self' http: https:",
    "media-src 'self' data:",
  ].join("; ");
}

/**
 * 静态直出（`piforge://app`）版本的 CSP：**没有** localhost 端口可连。
 *
 * 数据面全走 `protocol.handle`（`/api/**` → 命名管道 → Agent Host），
 * 所以 `connect-src` 只需要向本协议自己开口，攻击面比 0.9.0 的
 * `http://127.0.0.1:30141` 更小。
 */
export function buildStaticAppCspHeader(): string {
  return [
    "default-src 'self'",
    "connect-src 'self' piforge:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // Keep in sync with lib/csp.ts — the built-in browser frames live pages.
    "frame-src 'self' http: https:",
    "media-src 'self' data:",
  ].join("; ");
}
