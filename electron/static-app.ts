/**
 * 静态应用直出（P1-4）：`piforge://app/**` 由主进程直接服务，**没有 HTTP 监听**。
 *
 * 两条路径：
 *   - `/api/**` → `AgentHostApiBridge`（命名管道 → Host 内 `app/api` 路由器）；
 *   - 其余路径 → `out/`（`next build` 的静态导出）里的文件，找不到就回 index.html
 *     （PiForge 是单页应用：`app/page.tsx` 渲染整个 Workbench，路由只有 `/`）。
 *
 * 为什么不用 `file://`：CSP/`fetch`/`fetch`-stream 在自定义协议下才有同源语义，
 * 而且 `file://` 的 origin 是 null，preload 暴露的桥和 `connect-src 'self'` 都会失配。
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import type { AgentHostApiBridge } from "./api-bridge";
// 注意：electron 的 tsconfig 是 CommonJS，值导入必须留在同文件/由调用方注入
// （`./csp` 这种无扩展导入在 node --test 下解析不到 `.ts`）。
// 所以 CSP 由调用方传入 —— 顺便让测试可以断言"没有 localhost"。

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

export const STATIC_APP_SCHEME = "piforge";
export const STATIC_APP_ORIGIN = `${STATIC_APP_SCHEME}://app`;

export function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * 把请求路径解析成静态根目录里的真实文件（含目录穿越防护）。
 * `null` 表示文件不存在，调用方决定回退 index.html 还是 404。
 */
export function resolveStaticFile(root: string, pathname: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(pathname);
    } catch {
      return pathname;
    }
  })();
  // 归一化后必须仍在 root 内：`piforge://app/../../etc/passwd` 之类一律拒绝。
  const relativePath = decoded.replace(/^\/+/, "");
  const candidate = path.resolve(root, relativePath);
  const rootWithSep = path.resolve(root) + path.sep;
  if (candidate !== path.resolve(root) && !candidate.startsWith(rootWithSep)) return null;
  try {
    const stats = statSync(candidate);
    if (stats.isFile()) return candidate;
    if (stats.isDirectory()) {
      const indexFile = path.join(candidate, "index.html");
      if (existsSync(indexFile)) return indexFile;
    }
  } catch {
    // 不存在
  }
  return null;
}

export interface StaticAppHandlerOptions {
  root: string | null;
  getBridge: () => AgentHostApiBridge | null;
  log: (message: string, detail?: unknown) => void;
  /** `buildStaticAppCspHeader()` 的结果（由 main 注入，见文件头注释）。 */
  csp: string;
}

/**
 * 生成 `protocol.handle` 的回调体。拆成纯函数是为了让 `electron/static-app.test.ts`
 * 能在没有 Electron 的环境里直接覆盖路由/回退/CSP 逻辑。
 */
export function createStaticAppHandler(options: StaticAppHandlerOptions) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const csp = options.csp;

    if (url.pathname.startsWith("/api/")) {
      // 观测开关：`PIFORGE_DEBUG_API=1` 时把每条 API 请求打出来（看空闲轮询用）。
      if (process.env.PIFORGE_DEBUG_API === "1") {
        options.log("api request", { method: request.method, url: request.url });
      }
      const bridge = options.getBridge();
      if (!bridge) {
        return jsonResponse(503, { error: "Agent Host bridge is not ready", retryable: true }, csp);
      }
      try {
        const body =
          request.method === "GET" || request.method === "HEAD"
            ? null
            : new Uint8Array(await request.arrayBuffer());
        const headers: Record<string, string> = {};
        request.headers.forEach((value, key) => {
          headers[key] = value;
        });
        const result = await bridge.requestStream({
          method: request.method,
          url: request.url,
          headers,
          body,
        });
        const responseHeaders = new Headers(result.headers);
        responseHeaders.set("content-security-policy", csp);
        if (request.method === "HEAD") {
          result.cancel();
          return new Response(null, { status: result.status, headers: responseHeaders });
        }
        return new Response(result.stream, { status: result.status, headers: responseHeaders });
      } catch (error) {
        options.log("Static app API request failed", {
          url: request.url,
          error: error instanceof Error ? error.message : String(error),
        });
        return jsonResponse(503, { error: "Agent Host unavailable", retryable: true }, csp);
      }
    }

    const root = options.root;
    if (!root) {
      return new Response("Static app bundle is missing", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8", "content-security-policy": csp },
      });
    }

    const file = resolveStaticFile(root, url.pathname);
    if (file) {
      const headers = new Headers({
        "content-type": mimeTypeFor(file),
        "content-security-policy": csp,
        // 静态资源不走 Next：自己给缓存策略，避免每次冷启动重读磁盘。
        "cache-control": file.includes(`${path.sep}_next${path.sep}`)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      });
      const body = await readFileBytes(file);
      return new Response(body, { status: 200, headers });
    }

    // 单页应用回退：带扩展名的算资源缺失（真 404），否则交给前端路由。
    const looksLikeAsset = /\.[a-z0-9]+$/i.test(url.pathname);
    const fallback = looksLikeAsset ? null : resolveStaticFile(root, "/index.html");
    if (!fallback) {
      return new Response("Not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8", "content-security-policy": csp },
      });
    }
    const body = await readFileBytes(fallback);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": csp,
        "cache-control": "no-cache",
      },
    });
  };
}

function jsonResponse(status: number, body: unknown, csp: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-security-policy": csp,
      "cache-control": "no-store",
    },
  });
}

/**
 * 整文件读入内存：静态资源都在几 MB 以内，`protocol.handle` 用 Buffer 最简单。
 * 用流式 `createReadStream` 会让 Response 需要 Node→Web 的转换层，收益不成比例。
 */
async function readFileBytes(filePath: string): Promise<ArrayBuffer> {
  void createReadStream;
  const { readFile } = await import("node:fs/promises");
  const buffer = await readFile(filePath);
  // 用 ArrayBuffer 而不是 Uint8Array：`Response` 的 BodyInit 在两套 lib
  // （DOM / @types/node 的 undici）里对泛型 Uint8Array 的写法不一致。
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}
