import { NextResponse } from "../../../../lib/next-server-shim.ts";
import { resolveSessionPath, getHeaderAsync } from "../../../../lib/session-reader.ts";
import { getAgentHostClient, AgentHostError } from "../../../../lib/agent-host-client.ts";
import { jsonAgentHostError } from "../../../../lib/agent-host-http.ts";
import { jsonError } from "../../../../lib/api-error.ts";
import { validateAgentCommand } from "../../../../lib/agent-commands.ts";

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await req.json() as { type: string; [key: string]: unknown };

    // Defense in depth at the HTTP boundary; the host validates again.
    const cmdError = validateAgentCommand(body);
    if (cmdError) {
      return jsonError(req, 400, cmdError);
    }

    const client = getAgentHostClient();
    try {
      const result = await client.call("agent.command", { sessionId: id, command: body });
      return NextResponse.json({ success: true, data: result.data });
    } catch (error) {
      if (!(error instanceof AgentHostError) || error.code !== "SESSION_NOT_FOUND") {
        throw error;
      }
    }

    // Cold path: the session is not live yet. Resolve its file, run the trust
    // gate, let the host start it, then retry the command.
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return jsonError(req, 404, "Session not found");
    }

    const header = await getHeaderAsync(filePath);
    const cwd = header?.cwd ?? process.cwd();

    const trustGate = await client.call("trust.evaluate", { cwd });
    if (trustGate.action === "prompt") {
      return NextResponse.json(trustGate.payload, { status: 409 });
    }

    await client.call("agent.ensure", { sessionId: id, filePath, cwd });
    const result = await client.call("agent.command", { sessionId: id, command: body });
    return NextResponse.json({ success: true, data: result.data });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/agent/[id]", method: "POST" });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const state = await getAgentHostClient().call("agent.state", { sessionId: id });
    return NextResponse.json(state);
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/agent/[id]", method: "GET" });
  }
}
