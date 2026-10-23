import { NextResponse } from "../../../lib/next-server-shim.ts";
import { homedir } from "os";

export async function GET() {
  return NextResponse.json({ home: homedir() });
}
