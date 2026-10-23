/**
 * ⚠️ 自动生成，不要手改 —— 由 `node scripts/generate-api-routes.mjs` 产出。
 * 路由数量：70
 */
export interface ApiRouteEntry {
  /** 归一化后的路径模式（`:param` / `*rest`）。 */
  pattern: string;
  /** 静态段优先的排序权重（生成时已排好序，这里保留给调试用）。 */
  segments: string[];
  /** 懒加载器：只有被请求到时才解析模块。 */
  load: () => Promise<Record<string, unknown>>;
}

export const API_ROUTES: ApiRouteEntry[] = [
  {
    pattern: "/api/mcp/resources/read",
    segments: ["mcp","resources","read"],
    load: () => import("../app/api/mcp/resources/read/route.ts"),
  },
  {
    pattern: "/api/agent/[id]/events",
    segments: ["agent","[id]","events"],
    load: () => import("../app/api/agent/[id]/events/route.ts"),
  },
  {
    pattern: "/api/agent/[id]/intervene",
    segments: ["agent","[id]","intervene"],
    load: () => import("../app/api/agent/[id]/intervene/route.ts"),
  },
  {
    pattern: "/api/auth/api-key/[provider]",
    segments: ["auth","api-key","[provider]"],
    load: () => import("../app/api/auth/api-key/[provider]/route.ts"),
  },
  {
    pattern: "/api/auth/login/[provider]",
    segments: ["auth","login","[provider]"],
    load: () => import("../app/api/auth/login/[provider]/route.ts"),
  },
  {
    pattern: "/api/auth/logout/[provider]",
    segments: ["auth","logout","[provider]"],
    load: () => import("../app/api/auth/logout/[provider]/route.ts"),
  },
  {
    pattern: "/api/sessions/[id]/branch",
    segments: ["sessions","[id]","branch"],
    load: () => import("../app/api/sessions/[id]/branch/route.ts"),
  },
  {
    pattern: "/api/sessions/[id]/branches",
    segments: ["sessions","[id]","branches"],
    load: () => import("../app/api/sessions/[id]/branches/route.ts"),
  },
  {
    pattern: "/api/sessions/[id]/clone",
    segments: ["sessions","[id]","clone"],
    load: () => import("../app/api/sessions/[id]/clone/route.ts"),
  },
  {
    pattern: "/api/sessions/[id]/context",
    segments: ["sessions","[id]","context"],
    load: () => import("../app/api/sessions/[id]/context/route.ts"),
  },
  {
    pattern: "/api/sessions/[id]/export",
    segments: ["sessions","[id]","export"],
    load: () => import("../app/api/sessions/[id]/export/route.ts"),
  },
  {
    pattern: "/api/agent/new",
    segments: ["agent","new"],
    load: () => import("../app/api/agent/new/route.ts"),
  },
  {
    pattern: "/api/auth/all-providers",
    segments: ["auth","all-providers"],
    load: () => import("../app/api/auth/all-providers/route.ts"),
  },
  {
    pattern: "/api/auth/providers",
    segments: ["auth","providers"],
    load: () => import("../app/api/auth/providers/route.ts"),
  },
  {
    pattern: "/api/browser/bridge",
    segments: ["browser","bridge"],
    load: () => import("../app/api/browser/bridge/route.ts"),
  },
  {
    pattern: "/api/config/events",
    segments: ["config","events"],
    load: () => import("../app/api/config/events/route.ts"),
  },
  {
    pattern: "/api/files/apply",
    segments: ["files","apply"],
    load: () => import("../app/api/files/apply/route.ts"),
  },
  {
    pattern: "/api/fleet/events",
    segments: ["fleet","events"],
    load: () => import("../app/api/fleet/events/route.ts"),
  },
  {
    pattern: "/api/git/commit",
    segments: ["git","commit"],
    load: () => import("../app/api/git/commit/route.ts"),
  },
  {
    pattern: "/api/git/diff",
    segments: ["git","diff"],
    load: () => import("../app/api/git/diff/route.ts"),
  },
  {
    pattern: "/api/git/status",
    segments: ["git","status"],
    load: () => import("../app/api/git/status/route.ts"),
  },
  {
    pattern: "/api/mcp/auth",
    segments: ["mcp","auth"],
    load: () => import("../app/api/mcp/auth/route.ts"),
  },
  {
    pattern: "/api/mcp/resources",
    segments: ["mcp","resources"],
    load: () => import("../app/api/mcp/resources/route.ts"),
  },
  {
    pattern: "/api/mcp/test",
    segments: ["mcp","test"],
    load: () => import("../app/api/mcp/test/route.ts"),
  },
  {
    pattern: "/api/mcp/toggle",
    segments: ["mcp","toggle"],
    load: () => import("../app/api/mcp/toggle/route.ts"),
  },
  {
    pattern: "/api/memory/forget",
    segments: ["memory","forget"],
    load: () => import("../app/api/memory/forget/route.ts"),
  },
  {
    pattern: "/api/memory/health",
    segments: ["memory","health"],
    load: () => import("../app/api/memory/health/route.ts"),
  },
  {
    pattern: "/api/memory/recall",
    segments: ["memory","recall"],
    load: () => import("../app/api/memory/recall/route.ts"),
  },
  {
    pattern: "/api/memory/remember",
    segments: ["memory","remember"],
    load: () => import("../app/api/memory/remember/route.ts"),
  },
  {
    pattern: "/api/memory/stats",
    segments: ["memory","stats"],
    load: () => import("../app/api/memory/stats/route.ts"),
  },
  {
    pattern: "/api/models-config/test",
    segments: ["models-config","test"],
    load: () => import("../app/api/models-config/test/route.ts"),
  },
  {
    pattern: "/api/models/auxiliary",
    segments: ["models","auxiliary"],
    load: () => import("../app/api/models/auxiliary/route.ts"),
  },
  {
    pattern: "/api/processes/events",
    segments: ["processes","events"],
    load: () => import("../app/api/processes/events/route.ts"),
  },
  {
    pattern: "/api/projects/create",
    segments: ["projects","create"],
    load: () => import("../app/api/projects/create/route.ts"),
  },
  {
    pattern: "/api/skills/install",
    segments: ["skills","install"],
    load: () => import("../app/api/skills/install/route.ts"),
  },
  {
    pattern: "/api/skills/search",
    segments: ["skills","search"],
    load: () => import("../app/api/skills/search/route.ts"),
  },
  {
    pattern: "/api/subagents/events",
    segments: ["subagents","events"],
    load: () => import("../app/api/subagents/events/route.ts"),
  },
  {
    pattern: "/api/terminal/events",
    segments: ["terminal","events"],
    load: () => import("../app/api/terminal/events/route.ts"),
  },
  {
    pattern: "/api/usage/upstream",
    segments: ["usage","upstream"],
    load: () => import("../app/api/usage/upstream/route.ts"),
  },
  {
    pattern: "/api/agent/[id]",
    segments: ["agent","[id]"],
    load: () => import("../app/api/agent/[id]/route.ts"),
  },
  {
    pattern: "/api/files/[...path]",
    segments: ["files","[...path]"],
    load: () => import("../app/api/files/[...path]/route.ts"),
  },
  {
    pattern: "/api/sessions/[id]",
    segments: ["sessions","[id]"],
    load: () => import("../app/api/sessions/[id]/route.ts"),
  },
  {
    pattern: "/api/default-cwd",
    segments: ["default-cwd"],
    load: () => import("../app/api/default-cwd/route.ts"),
  },
  {
    pattern: "/api/desktop-settings",
    segments: ["desktop-settings"],
    load: () => import("../app/api/desktop-settings/route.ts"),
  },
  {
    pattern: "/api/environment",
    segments: ["environment"],
    load: () => import("../app/api/environment/route.ts"),
  },
  {
    pattern: "/api/extensions",
    segments: ["extensions"],
    load: () => import("../app/api/extensions/route.ts"),
  },
  {
    pattern: "/api/file-index",
    segments: ["file-index"],
    load: () => import("../app/api/file-index/route.ts"),
  },
  {
    pattern: "/api/fleet",
    segments: ["fleet"],
    load: () => import("../app/api/fleet/route.ts"),
  },
  {
    pattern: "/api/fx",
    segments: ["fx"],
    load: () => import("../app/api/fx/route.ts"),
  },
  {
    pattern: "/api/health",
    segments: ["health"],
    load: () => import("../app/api/health/route.ts"),
  },
  {
    pattern: "/api/herdr",
    segments: ["herdr"],
    load: () => import("../app/api/herdr/route.ts"),
  },
  {
    pattern: "/api/home",
    segments: ["home"],
    load: () => import("../app/api/home/route.ts"),
  },
  {
    pattern: "/api/mcp",
    segments: ["mcp"],
    load: () => import("../app/api/mcp/route.ts"),
  },
  {
    pattern: "/api/models",
    segments: ["models"],
    load: () => import("../app/api/models/route.ts"),
  },
  {
    pattern: "/api/models-config",
    segments: ["models-config"],
    load: () => import("../app/api/models-config/route.ts"),
  },
  {
    pattern: "/api/orchestrator",
    segments: ["orchestrator"],
    load: () => import("../app/api/orchestrator/route.ts"),
  },
  {
    pattern: "/api/plugins",
    segments: ["plugins"],
    load: () => import("../app/api/plugins/route.ts"),
  },
  {
    pattern: "/api/processes",
    segments: ["processes"],
    load: () => import("../app/api/processes/route.ts"),
  },
  {
    pattern: "/api/providers",
    segments: ["providers"],
    load: () => import("../app/api/providers/route.ts"),
  },
  {
    pattern: "/api/select-directory",
    segments: ["select-directory"],
    load: () => import("../app/api/select-directory/route.ts"),
  },
  {
    pattern: "/api/sessions",
    segments: ["sessions"],
    load: () => import("../app/api/sessions/route.ts"),
  },
  {
    pattern: "/api/settings",
    segments: ["settings"],
    load: () => import("../app/api/settings/route.ts"),
  },
  {
    pattern: "/api/skills",
    segments: ["skills"],
    load: () => import("../app/api/skills/route.ts"),
  },
  {
    pattern: "/api/statusline",
    segments: ["statusline"],
    load: () => import("../app/api/statusline/route.ts"),
  },
  {
    pattern: "/api/subagents",
    segments: ["subagents"],
    load: () => import("../app/api/subagents/route.ts"),
  },
  {
    pattern: "/api/tool-outputs",
    segments: ["tool-outputs"],
    load: () => import("../app/api/tool-outputs/route.ts"),
  },
  {
    pattern: "/api/trust",
    segments: ["trust"],
    load: () => import("../app/api/trust/route.ts"),
  },
  {
    pattern: "/api/upstream",
    segments: ["upstream"],
    load: () => import("../app/api/upstream/route.ts"),
  },
  {
    pattern: "/api/watchdog",
    segments: ["watchdog"],
    load: () => import("../app/api/watchdog/route.ts"),
  },
];
