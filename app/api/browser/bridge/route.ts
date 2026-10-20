import { NextResponse } from "next/server";
import { errorMessage, getRequestId, jsonError, logApiError } from "@/lib/api-error";
import {
  pushBrowserSnapshot,
  recordBrowserPoll,
  resolveBrowserCommand,
  takeBrowserCommands,
  type BrowserCommandResult,
  type BrowserPageSnapshot,
} from "@/lib/browser-bridge";

export const dynamic = "force-dynamic";

// GET /api/browser/bridge
// Renderer poll: reports liveness and drains commands queued by `web_preview`.
export async function GET(req: Request) {
  try {
    recordBrowserPoll();
    return NextResponse.json({
      connected: true,
      commands: takeBrowserCommands(),
    });
  } catch (error) {
    const requestId = getRequestId(req);
    logApiError({ route: "/api/browser/bridge", method: "GET", requestId, error });
    return jsonError(req, 500, errorMessage(error));
  }
}

// POST /api/browser/bridge
// Renderer pushes the current page snapshot and/or the result of a command.
export async function POST(req: Request) {
  const requestId = getRequestId(req);
  try {
    const body = (await req.json()) as {
      snapshot?: Partial<BrowserPageSnapshot>;
      result?: BrowserCommandResult;
    };

    recordBrowserPoll();
    if (body.snapshot && typeof body.snapshot === "object") {
      pushBrowserSnapshot(body.snapshot);
    }
    if (body.result && typeof body.result?.id === "string") {
      resolveBrowserCommand(body.result);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    logApiError({ route: "/api/browser/bridge", method: "POST", requestId, error });
    return jsonError(req, 400, errorMessage(error));
  }
}
