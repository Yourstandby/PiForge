/**
 * `next/server` 的最小替身（架桥用，不是"重写 Next"）。
 *
 * 为什么需要它：PiForge 已经把 70 条 API 路由从 Next 运行时里搬到了 Agent Host
 * （见 docs/optimizations/v0.9.x-performance-plan.md 的 P1-4）。这些路由文件是
 * Web 标准的 `(Request) => Response`，唯一依赖 Next 的地方只有两个符号：
 *
 *   - `NextResponse.json(body, init)` —— 带 JSON content-type 的 Response；
 *   - `NextRequest` —— 带 `nextUrl` 的 Request。
 *
 * 所以这里只实现这两个东西，然后路由文件原封不动地在 Host 里跑。**同时**它也是
 * Next 自己（`npm run dev` / `PIFORGE_USE_NEXT=1` 回退路径）能接受的实现 ——
 * 返回的是普通 `Response`，Next 的 route handler 契约允许这样做。
 *
 * 刻意不实现的能力（当前代码没有用到，用到了会立刻报错而不是静默出错）：
 * `cookies()` / `headers()` / `revalidate` / `NextResponse.redirect|rewrite|next`。
 */

/**
 * 与 Next 的 `NextRequest` 对齐到"路由实际会用到的那一小块"。
 *
 * 参数类型不用 `RequestInfo`：Agent Host 的 tsconfig 只有 ES2022 + @types/node，
 * 没有 DOM lib（`RequestInfo` 是 DOM 里的名字）。这里用 `Request` 的三种入参写法。
 */
export class NextRequest extends Request {
  /** Next 的 `nextUrl` 是 URL 实例；路由里只用到 `searchParams`。 */
  readonly nextUrl: URL;

  constructor(input: string | URL | Request, init?: RequestInit) {
    super(input as Request | URL | string, init);
    this.nextUrl = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  }
}

type NextResponseInit = ResponseInit;

/**
 * 与 `NextResponse` 对齐：`json()` 是唯一被使用的方法。
 *
 * 保持为一个 `Response` 的子类，这样 `instanceof Response` 判断、以及把返回值
 * 直接丢给 Electron `protocol.handle` 都能正常工作。
 */
export class NextResponse extends Response {
  static json(body: unknown, init?: NextResponseInit): NextResponse {
    const headers = new Headers(init?.headers);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json; charset=utf-8");
    }
    return new NextResponse(JSON.stringify(body ?? null), { ...init, headers });
  }
}
