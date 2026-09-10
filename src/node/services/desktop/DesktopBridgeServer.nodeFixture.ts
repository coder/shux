// Run the real watcher under Node, like the desktop/server backend. Bun's fs.watch can drop
// atomic-replace notifications while its test loop is idle; Bun still drives the external writer.
import * as http from "node:http";
import * as net from "node:net";
import { once } from "node:events";
import assert from "node:assert/strict";
import { Config } from "@/node/config";
import type { ExperimentsService } from "@/node/services/experimentsService";
import type { WorkspaceService } from "@/node/services/workspaceService";
import { DesktopBridgeServer } from "./DesktopBridgeServer";
import { DesktopSessionManager } from "./DesktopSessionManager";
import { DesktopTokenManager } from "./DesktopTokenManager";

async function run(): Promise<void> {
  const rootDir = process.argv[2];
  assert(rootDir, "Bridge fixture requires a config root");
  const tcp = net.createServer((socket) => {
    socket.on("error", () => socket.destroy());
    socket.on("data", (data) => socket.write(data));
    socket.write(Buffer.from([0]));
  });
  tcp.listen(0, "127.0.0.1");
  await once(tcp, "listening");
  const tcpAddress = tcp.address();
  assert(tcpAddress && typeof tcpAddress !== "string");
  const vncPort = tcpAddress.port;

  // Only the PortableDesktop transport is replaced: target resolution, config watching,
  // WebSocket authentication/revocation and TCP forwarding use the production services.
  class FixtureSessionManager extends DesktopSessionManager {
    override getLiveSessionConnection(workspaceId: string) {
      try {
        const { ownerWorkspaceId } = this.resolveTarget(workspaceId);
        return {
          ownerWorkspaceId,
          sessionId: `session:${ownerWorkspaceId}`,
          vncPort,
        };
      } catch {
        return null;
      }
    }
  }
  const experimentsService: Partial<ExperimentsService> = { isExperimentEnabled: () => true };
  const workspaceService: Partial<WorkspaceService> = { getInfo: () => Promise.resolve(null) };
  const manager = new FixtureSessionManager({
    config: new Config(rootDir),
    experimentsService: experimentsService as ExperimentsService,
    workspaceService: workspaceService as WorkspaceService,
  });
  const tokens = new DesktopTokenManager();
  const bridge = new DesktopBridgeServer({
    desktopSessionManager: manager,
    desktopTokenManager: tokens,
  });
  const server = http.createServer((request, response) => {
    const workspaceId = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get(
      "workspaceId"
    );
    const session = workspaceId ? manager.getLiveSessionConnection(workspaceId) : null;
    if (!workspaceId || !session) {
      response.writeHead(404).end();
      return;
    }
    response.end(tokens.mint(workspaceId, session.sessionId));
  });
  server.on("upgrade", (request, socket, head) => bridge.handleUpgrade(request, socket, head));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const stopped = once(process, "message");
  process.send?.({ port: address.port });
  await stopped;
  await bridge.stop();
  await manager.closeAll();
  tokens.dispose();
  await Promise.all([
    new Promise<void>((resolve) => server.close(() => resolve())),
    new Promise<void>((resolve) => tcp.close(() => resolve())),
  ]);
  process.disconnect?.();
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  process.disconnect?.();
});
