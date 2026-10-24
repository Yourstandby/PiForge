import { NextResponse } from "../../../../lib/next-server-shim.ts";
import type {
  BrowserCommandResult,
  BrowserPageSnapshot,
} from "../../../../contract/domains/browser.ts";
import { getAgentHostClient } from "../../../../lib/agent-host-client.ts";
import { jsonAgentHostError } from "../../../../lib/agent-host-http.ts";

export const dynamic = "force-dynamic";

// GET /api/browser/bridge
// Renderer poll: reports liveness and drains commands queued by `web_preview`.
export async function GET(req: Request) {
  try {
    const result = await getAgentHostClient().call("browser.poll", {});
    return NextResponse.json(result);
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/browser/bridge", method: "GET" });
  }
}

// POST /api/browser/bridge
// Renderer pushes the current page snapshot and/or the result of a command.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      snapshot?: Partial<BrowserPageSnapshot>;
      result?: BrowserCommandResult;
    };
    const client = getAgentHostClient();

    if (body.snapshot && typeof body.snapshot === "object") {
      await client.call("browser.pushSnapshot", { snapshot: body.snapshot });
    }
    if (body.result && typeof body.result?.id === "string") {
      await client.call("browser.resolveCommand", { result: body.result });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/browser/bridge", method: "POST" });
  }
}
