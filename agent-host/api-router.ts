/**
 * Host 内的 `/api/**` 路由器（P1-4：拆掉 Next standalone 之后唯一的 API 入口）。
 *
 * 设计取舍：
 *   - **路由文件一行不改**：`app/api/**\/route.ts` 本来就是 Web 标准的
 *     `(Request) => Response`，只通过 `lib/next-server-shim.ts` 提供
 *     `NextResponse.json` / `NextRequest`。所以这里只做"匹配 + 调用"。
 *   - **懒加载**：路由模块按需 `import()`，Host 冷启动不为 70 条路由付钱
 *     （冷启动预算里 2s 是 Pi SDK，不该再被外壳路由挤占）。
 *   - **不缓存响应**：路由自己决定 `cache-control`，这里原样透传。
 *
 * 调用方：`agent-host/server.ts` 的 `api.request` 分支（见 `handleApiRequest`）。
 */
import { NextRequest } from "../lib/next-server-shim.ts";
import { API_ROUTES, type ApiRouteEntry } from "./api-routes.generated.ts";

/**
 * 路由参数。
 *
 * 注意：catch-all（`[...path]`）在 Next 里是 **`string[]`**（`/api/files/a/b` →
 * `["a","b"]`），不是 `"a/b"` —— 路由文件里会直接 `segments.join("/")`。
 * 传错类型不会报错，只会在运行期 `join is not a function`。
 */
export type ApiRouteParams = Record<string, string | string[]>;

export interface ApiRouteMatch {
  entry: ApiRouteEntry;
  params: ApiRouteParams;
}

const REST_SEGMENT = /^\[\.\.\.([^\]]+)\]$/;
const DYNAMIC_SEGMENT = /^\[([^\]]+)\]$/;

/** 把 pathname 切成段（丢掉开头的 `api`，与生成表里的 segments 对齐）。 */
function pathSegments(pathname: string): string[] {
  const parts = pathname.split("/").filter(Boolean);
  // 表里的 segments 不含 `api` 前缀（生成时从 app/api 目录开始算）。
  return parts[0] === "api" ? parts.slice(1) : parts;
}

function tryMatch(entry: ApiRouteEntry, parts: string[]): ApiRouteParams | null {
  const params: ApiRouteParams = {};
  const segments = entry.segments;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const rest = REST_SEGMENT.exec(segment);
    if (rest) {
      const remaining = parts.slice(index);
      if (remaining.length === 0) return null;
      // Next 的 catch-all 参数是数组（`[...path]` → string[]），保持同形。
      params[rest[1]] = remaining.map((part) => safeDecode(part));
      return params;
    }
    const part = parts[index];
    if (part === undefined) return null;
    const dynamic = DYNAMIC_SEGMENT.exec(segment);
    if (dynamic) {
      params[dynamic[1]] = safeDecode(part);
      continue;
    }
    if (segment !== part) return null;
  }
  return parts.length === segments.length ? params : null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 匹配一条路径；表本身已按"静态优先"排序，第一个命中即最具体的路由。 */
export function matchApiRoute(pathname: string): ApiRouteMatch | null {
  const parts = pathSegments(pathname);
  for (const entry of API_ROUTES) {
    const params = tryMatch(entry, parts);
    if (params) return { entry, params };
  }
  return null;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * 执行一条请求。返回值永远是 `Response`（404/405 也走这里），
 * 这样 Electron 的 `protocol.handle` 只需要一个分支。
 */
export async function dispatchApiRequest(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const match = matchApiRoute(url.pathname);
  if (!match) {
    return jsonResponse(404, { error: `No API route for ${url.pathname}` });
  }

  let routeModule: Record<string, unknown>;
  try {
    routeModule = await loadRouteModule(match);
  } catch (error) {
    return jsonResponse(500, {
      error: `Failed to load route ${match.entry.pattern}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const handler = routeModule[request.method];
  if (typeof handler !== "function") {
    const allowed = ["GET", "POST", "PUT", "PATCH", "DELETE"].filter(
      (method) => typeof routeModule[method] === "function",
    );
    return new Response(JSON.stringify({ error: `${request.method} not allowed` }), {
      status: 405,
      headers: { "content-type": "application/json; charset=utf-8", allow: allowed.join(", ") },
    });
  }

  // Next 15+ 的签名：第二个参数里 `params` 是 Promise（路由里会 `await params`）。
  const context = { params: Promise.resolve(match.params) };
  try {
    const response = await (handler as (req: Request, ctx: typeof context) => Promise<Response>)(
      request,
      context,
    );
    if (!response) return jsonResponse(500, { error: "Route handler returned no response" });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        level: "error",
        scope: "api",
        route: match.entry.pattern,
        method: request.method,
        message,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    return jsonResponse(500, { error: message });
  }
}

/** 已经懒加载过的路由（每个进程只首载一次）。 */
const loadedRoutes = new Set<string>();

/**
 * 懒加载一条路由模块；`PIFORGE_DEBUG_API=1` 时打印**首载开销**。
 *
 * 这是"常驻内存归属"的实测口径：`heapUsed` 差值 + `external` 差值 + 首载耗时。
 * 静态依赖图（`scripts/audit-route-deps.mjs`）告诉你"会拉进哪些模块"，
 * 这里告诉你"拉进来值多少 MB"，两者一起才能决定哪条路由值得动态 import。
 */
async function loadRouteModule(match: ApiRouteMatch): Promise<Record<string, unknown>> {
  const firstLoad = !loadedRoutes.has(match.entry.pattern);
  const before = firstLoad && process.env.PIFORGE_DEBUG_API === "1" ? process.memoryUsage() : null;
  const startedAt = Date.now();
  const routeModule = await match.entry.load();
  if (firstLoad) {
    loadedRoutes.add(match.entry.pattern);
    if (before) {
      const after = process.memoryUsage();
      const mb = (bytes: number) => (bytes / 1048576).toFixed(2);
      console.log(
        `[api-load] ${match.entry.pattern} ${Date.now() - startedAt}ms ` +
          `heap+${mb(after.heapUsed - before.heapUsed)}MB ` +
          `ext+${mb(after.external - before.external)}MB ` +
          `rss=${mb(after.rss)}MB`,
      );
    }
  }
  return routeModule;
}

/** 供单测使用：暴露给测试构造请求，不参与运行时逻辑。 */
export function buildApiRequest(input: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | null;
}): NextRequest {
  const init: RequestInit = { method: input.method, headers: input.headers };
  if (input.body !== undefined && input.body !== null && input.method !== "GET" && input.method !== "HEAD") {
    // Uint8Array（Node Buffer）是 fetch 合法 body；两套 lib（DOM / @types/node）
    // 对 body 的泛型写法不一致，这里显式窄化到 RequestInit 认得的最小接口。
    init.body = input.body as unknown as RequestInit["body"];
  }
  return new NextRequest(input.url, init);
}
