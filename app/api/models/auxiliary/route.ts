import { NextResponse } from "next/server";
import { getRequestId } from "@/lib/api-error";
import { getAgentHostClient } from "@/lib/agent-host-client";
import { jsonAgentHostError } from "@/lib/agent-host-http";
import type { AuxModelSelection } from "@contract/domains/aux-models";

export const dynamic = "force-dynamic";

/** GET /api/models/auxiliary — available image/decision models plus the current selection. */
export async function GET(req: Request) {
  const requestId = getRequestId(req);
  try {
    const catalogue = await getAgentHostClient().call(
      "models.auxCatalogue",
      {},
      { timeoutMs: 30_000 },
    );
    return NextResponse.json(catalogue, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/models/auxiliary", method: "GET" });
  }
}

/** PUT /api/models/auxiliary — persist the image/decision model selection (null clears). */
export async function PUT(req: Request) {
  const requestId = getRequestId(req);
  try {
    const body = (await req.json()) as {
      image?: AuxModelSelection | null;
      decision?: AuxModelSelection | null;
    };
    const config = await getAgentHostClient().call(
      "models.setAuxConfig",
      {
        ...(body?.image !== undefined ? { image: body.image } : {}),
        ...(body?.decision !== undefined ? { decision: body.decision } : {}),
      },
      { timeoutMs: 30_000 },
    );
    return NextResponse.json(config, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/models/auxiliary", method: "PUT" });
  }
}
