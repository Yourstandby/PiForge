import { NextResponse } from "next/server";
import { existsSync } from "fs";
import type { AgentCommandDto, AgentModeDto, ToolPresetDto } from "@contract/domains/agent";
import { validateAgentCommand } from "@/lib/agent-commands";
import { getAgentHostClient } from "@/lib/agent-host-client";
import { jsonAgentHostError } from "@/lib/agent-host-http";
import { jsonError } from "@/lib/api-error";
import { validateAgentCwd } from "@/lib/path-policy";

// POST /api/agent/new  body: { cwd: string; type: string; message: string; ... }
// The Agent Host owns session creation and prompt dispatch; this route only
// performs HTTP-boundary validation and the trust gate.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: string; [key: string]: unknown };
    const { cwd, ...command } = body;

    if (!cwd || typeof cwd !== "string") {
      return jsonError(req, 400, "cwd is required");
    }
    if (!existsSync(cwd)) {
      return jsonError(req, 400, `Directory does not exist: ${cwd}`);
    }

    const cwdError = validateAgentCwd(cwd);
    if (cwdError) {
      return jsonError(req, 400, cwdError);
    }

    const cmdError = validateAgentCommand(command);
    if (cmdError) {
      return jsonError(req, 400, cmdError);
    }

    const {
      provider,
      modelId,
      toolNames,
      thinkingLevel,
      agentMode,
      toolPreset,
      ...promptCommand
    } = command as {
      provider?: string;
      modelId?: string;
      toolNames?: string[];
      thinkingLevel?: string;
      agentMode?: string;
      toolPreset?: string;
      [key: string]: unknown;
    };

    const client = getAgentHostClient();

    const trustGate = await client.call("trust.evaluate", { cwd });
    if (trustGate.action === "prompt") {
      return NextResponse.json(trustGate.payload, { status: 409 });
    }

    const result = await client.call("agent.create", {
      cwd,
      command: promptCommand as AgentCommandDto,
      ...(provider !== undefined ? { provider } : {}),
      ...(modelId !== undefined ? { modelId } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      ...(toolNames !== undefined ? { toolNames } : {}),
      ...(agentMode !== undefined ? { agentMode: agentMode as AgentModeDto } : {}),
      ...(toolPreset !== undefined ? { toolPreset: toolPreset as ToolPresetDto } : {}),
    });

    // The host registers the cwd as an allowed root when it starts the session.
    return NextResponse.json({ success: true, sessionId: result.sessionId });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/agent/new", method: "POST" });
  }
}
