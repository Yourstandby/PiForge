import { NextResponse } from "next/server";
import { errorMessage, getRequestId, jsonError, logApiError } from "@/lib/api-error";
import { getAllowedRoots, isPathAllowed } from "@/lib/allowed-roots";
import {
  listManagedProcesses,
  removeManagedProcessEntry,
  restartManagedProcess,
  sendManagedProcessInput,
  startManagedProcess,
  stopManagedProcess,
} from "@/lib/managed-processes";

export const dynamic = "force-dynamic";

// GET /api/processes - list managed background processes
export async function GET(req: Request) {
  try {
    return NextResponse.json({ processes: listManagedProcesses() });
  } catch (error) {
    const requestId = getRequestId(req);
    logApiError({ route: "/api/processes", method: "GET", requestId, error });
    return jsonError(req, 500, errorMessage(error));
  }
}

// POST /api/processes - { action: start|stop|restart|remove, ... }
export async function POST(req: Request) {
  const requestId = getRequestId(req);
  try {
    const body = (await req.json()) as {
      action?: string;
      id?: string;
      cwd?: string;
      command?: string;
      name?: string;
      input?: string;
    };

    switch (body.action) {
      case "start": {
        if (!body.cwd || !body.command) return jsonError(req, 400, "Missing cwd or command");
        const allowedRoots = await getAllowedRoots();
        if (!isPathAllowed(body.cwd, allowedRoots)) {
          return jsonError(req, 403, "Access denied");
        }
        const process = startManagedProcess({
          cwd: body.cwd,
          command: body.command,
          name: body.name,
        });
        return NextResponse.json({ process });
      }
      case "stop": {
        if (!body.id) return jsonError(req, 400, "Missing id");
        const stopped = await stopManagedProcess(body.id);
        if (!stopped) return jsonError(req, 404, "Process not found");
        return NextResponse.json({ success: true });
      }
      case "stdin": {
        if (!body.id || typeof body.input !== "string") {
          return jsonError(req, 400, "Missing id or input");
        }
        const sent = sendManagedProcessInput(body.id, body.input);
        if (!sent) return jsonError(req, 409, "Process is not running or stdin is closed");
        return NextResponse.json({ success: true });
      }
      case "restart": {
        if (!body.id) return jsonError(req, 400, "Missing id");
        const process = await restartManagedProcess(body.id);
        if (!process) return jsonError(req, 404, "Process not found");
        return NextResponse.json({ process });
      }
      case "remove": {
        if (!body.id) return jsonError(req, 400, "Missing id");
        const removed = await removeManagedProcessEntry(body.id);
        if (!removed) return jsonError(req, 404, "Process not found");
        return NextResponse.json({ success: true });
      }
      default:
        return jsonError(req, 400, `Unknown action: ${String(body.action)}`);
    }
  } catch (error) {
    logApiError({ route: "/api/processes", method: "POST", requestId, error });
    return jsonError(req, 500, errorMessage(error));
  }
}
