import { NextResponse } from "../../../lib/next-server-shim.ts";
import { jsonError } from "../../../lib/api-error.ts";
import { authorizeHostPath, hostFileAccessError } from "../../../lib/host-files.ts";
import { getAgentHostClient } from "../../../lib/agent-host-client.ts";
import { jsonAgentHostError } from "../../../lib/agent-host-http.ts";

export const dynamic = "force-dynamic";

// GET /api/processes - list managed background processes (host-owned)
export async function GET(req: Request) {
  try {
    const result = await getAgentHostClient().call("processes.list", {});
    return NextResponse.json(result);
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/processes", method: "GET" });
  }
}

// POST /api/processes - { action: start|stop|restart|remove|stdin, ... }
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      action?: string;
      id?: string;
      cwd?: string;
      command?: string;
      name?: string;
      input?: string;
    };
    const client = getAgentHostClient();

    switch (body.action) {
      case "start": {
        if (!body.cwd || !body.command) return jsonError(req, 400, "Missing cwd or command");
        try {
          await authorizeHostPath(body.cwd, "list", body.cwd);
        } catch (error) {
          return hostFileAccessError(req, error, "/api/processes", "POST");
        }
        const result = await client.call("processes.start", {
          cwd: body.cwd,
          command: body.command,
          owner: "user",
          ...(body.name !== undefined ? { name: body.name } : {}),
        });
        return NextResponse.json({ process: result.process });
      }
      case "stop": {
        if (!body.id) return jsonError(req, 400, "Missing id");
        const result = await client.call("processes.stop", { id: body.id });
        if (!result.ok) return jsonError(req, 404, "Process not found");
        return NextResponse.json({ success: true });
      }
      case "stdin": {
        if (!body.id || typeof body.input !== "string") {
          return jsonError(req, 400, "Missing id or input");
        }
        const result = await client.call("processes.stdin", { id: body.id, input: body.input });
        if (!result.ok) return jsonError(req, 409, "Process is not running or stdin is closed");
        return NextResponse.json({ success: true });
      }
      case "force-stop": {
        if (!body.id) return jsonError(req, 400, "Missing id");
        const result = await client.call("processes.forceStop", { id: body.id });
        if (!result.ok) return jsonError(req, 404, "Process not found");
        return NextResponse.json({ success: true });
      }
      case "restart": {
        if (!body.id) return jsonError(req, 400, "Missing id");
        const result = await client.call("processes.restart", { id: body.id });
        if (!result.process) return jsonError(req, 404, "Process not found");
        return NextResponse.json({ process: result.process });
      }
      case "remove": {
        if (!body.id) return jsonError(req, 400, "Missing id");
        const result = await client.call("processes.remove", { id: body.id });
        if (!result.ok) return jsonError(req, 404, "Process not found");
        return NextResponse.json({ success: true });
      }
      default:
        return jsonError(req, 400, `Unknown action: ${String(body.action)}`);
    }
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/processes", method: "POST" });
  }
}
