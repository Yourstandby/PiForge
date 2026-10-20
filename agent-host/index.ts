/**
 * Agent Host entry point.
 *
 * Runs as an Electron `utilityProcess` in the desktop app, and as a plain
 * Node process under `scripts/dev.mjs` / the handshake smoke test. It must not
 * import Electron APIs — only the contract and Node built-ins.
 */
import process from "node:process";
import { PROTOCOL_VERSION, type ParentMessage } from "../contract/protocol.ts";
import { createAgentHostServer } from "./server.ts";

interface ParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
}

function log(message: string): void {
  console.log(`[agent-host] ${message}`);
}

function logError(message: string, detail?: unknown): void {
  console.error(`[agent-host] ${message}`, detail ?? "");
}

function getParentPort(): ParentPort | undefined {
  return (process as unknown as { parentPort?: ParentPort }).parentPort;
}

async function main(): Promise<void> {
  const endpoint = process.env.PIFORGE_AGENT_ENDPOINT?.trim();
  const token = process.env.PIFORGE_AGENT_TOKEN?.trim();
  if (!endpoint || !token) {
    logError("PIFORGE_AGENT_ENDPOINT and PIFORGE_AGENT_TOKEN are required");
    process.exit(2);
  }

  const parentPort = getParentPort();
  let shuttingDown = false;
  const server = createAgentHostServer({
    endpoint,
    token,
    log,
    onReady: (readyEndpoint) => {
      log(`ready protocol=${PROTOCOL_VERSION} endpoint=${readyEndpoint}`);
      parentPort?.postMessage({
        type: "host_ready",
        endpoint: readyEndpoint,
        protocolVersion: PROTOCOL_VERSION,
        pid: process.pid,
      });
    },
    onFatal: (error) => {
      logError("fatal server error", error);
    },
  });

  const shutdown = async (reason: string, code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (${reason})`);
    try {
      await server.close();
    } catch (error) {
      logError("error while closing server", error);
    }
    process.exit(code);
  };

  parentPort?.on("message", (event) => {
    const message = event.data as ParentMessage | null;
    if (message && typeof message === "object" && message.type === "shutdown") {
      void shutdown(message.reason ?? "parent request");
    }
  });

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (error) => {
    logError("uncaught exception", error);
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    logError("unhandled rejection", reason);
    void shutdown("unhandledRejection", 1);
  });

  try {
    await server.start();
  } catch (error) {
    logError("failed to start", error);
    process.exit(1);
  }
}

void main();
