import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, mock, spyOn, test } from "bun:test";
import { Config } from "@/node/config";
import { DisposableProcess } from "@/node/utils/disposableExec";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { build } from "esbuild";
import type { ExperimentsService } from "@/node/services/experimentsService";
import type { WorkspaceService } from "@/node/services/workspaceService";
import { DesktopSessionManager } from "./DesktopSessionManager";
import { WebSocket, type RawData } from "ws";
import { DesktopBridgeServer } from "./DesktopBridgeServer";
import { DesktopTokenManager } from "./DesktopTokenManager";

const VALID_TOKEN = "valid-token";
const VALID_WORKSPACE_ID = "workspace-1";
const VALID_SESSION_ID = "desktop:workspace-1";

interface TcpHarness {
  server: net.Server;
  port: number;
  connectionPromise: Promise<net.Socket>;
  close: () => Promise<void>;
}

interface UpgradeHarness {
  port: number;
  close: () => Promise<void>;
}

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  void promise.catch(() => undefined);
  return { promise, reject, resolve };
}

function createBridgeServer(options: {
  onWorkspaceClose?: (listener: (workspaceId: string | null) => void) => () => void;
  validate?: (token: string) => { workspaceId: string; sessionId: string } | null;
  getLiveSessionConnection?:
    | ((workspaceId: string) => { sessionId: string; vncPort: number } | null)
    | (() => { sessionId: string; vncPort: number } | null);
}): DesktopBridgeServer {
  return new DesktopBridgeServer({
    desktopTokenManager: {
      validate:
        options.validate ??
        mock((token: string) =>
          token === VALID_TOKEN
            ? { workspaceId: VALID_WORKSPACE_ID, sessionId: VALID_SESSION_ID }
            : null
        ),
    },
    desktopSessionManager: {
      getLiveSessionConnection: (workspaceId) => {
        const live = options.getLiveSessionConnection
          ? options.getLiveSessionConnection(workspaceId)
          : workspaceId === VALID_WORKSPACE_ID
            ? { sessionId: VALID_SESSION_ID, vncPort: 5900 }
            : null;
        return live ? { ...live, ownerWorkspaceId: workspaceId } : null;
      },
      onWorkspaceClose: options.onWorkspaceClose ?? (() => () => undefined),
      watchWorkspaceConfig: () => () => undefined,
    },
  });
}

async function listenTcpServer(): Promise<TcpHarness> {
  const sockets = new Set<net.Socket>();
  let resolveConnection: ((socket: net.Socket) => void) | null = null;
  const connectionPromise = new Promise<net.Socket>((resolve) => {
    resolveConnection = resolve;
  });

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    resolveConnection?.(socket);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };

    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP test server to expose a numeric port");
  }

  return {
    server,
    port: address.port,
    connectionPromise,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeTcpServer(server);
    },
  };
}

async function closeTcpServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function listenUpgradeServer(bridgeServer: DesktopBridgeServer): Promise<UpgradeHarness> {
  const sockets = new Set<net.Socket>();
  const server = http.createServer();

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });
  server.on("upgrade", (request, socket, head) => {
    bridgeServer.handleUpgrade(request, socket, head);
  });
  server.on("clientError", (_error, socket) => {
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };

    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected upgrade test server to expose a numeric port");
  }

  return {
    port: address.port,
    close: async () => {
      server.close();
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    },
  };
}

async function waitForWebSocketOpen(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before opening"));
    };

    const cleanup = () => {
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onClose);
    };

    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}

async function waitForWebSocketClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return await new Promise<{ code: number; reason: string }>((resolve, reject) => {
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      resolve({ code, reason: reason.toString() });
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      ws.off("close", onClose);
      ws.off("error", onError);
    };

    ws.once("close", onClose);
    ws.once("error", onError);
  });
}

async function closeWebSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
}

function normalizeBinaryMessage(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }

  return Buffer.from(data);
}

async function waitForWebSocketMessage(ws: WebSocket): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const onMessage = (data: RawData, isBinary: boolean) => {
      cleanup();
      if (!isBinary) {
        reject(new Error("Expected a binary WebSocket message"));
        return;
      }
      resolve(normalizeBinaryMessage(data));
    };

    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before receiving a message"));
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
    };

    ws.once("message", onMessage);
    ws.once("close", onClose);
    ws.once("error", onError);
  });
}

async function waitForTcpData(socket: net.Socket, timeoutMs = 2_000): Promise<Buffer | null> {
  return await new Promise<Buffer | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      cleanup();
      resolve(chunk);
    };

    const onClose = () => {
      cleanup();
      reject(new Error("TCP socket closed before receiving data"));
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
    };

    socket.once("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

async function createBridgeConfig(rootDir: string): Promise<Config> {
  const config = new Config(rootDir);
  await config.editConfig((current) => {
    current.projects.set(rootDir, {
      workspaces: ["owner", "child", "sibling", "unrelated"].map((id) => ({
        id,
        name: id,
        path: path.join(rootDir, id),
        ...(["child", "sibling"].includes(id)
          ? { parentWorkspaceId: "owner", taskDesktopOwnerWorkspaceId: "owner" }
          : {}),
      })),
    });
    return current;
  });
  return config;
}

async function withSharedBridge(
  run: (harness: {
    manager: DesktopSessionManager;
    bridge: DesktopBridgeServer;
    config: Config;
    closed: (ws: WebSocket) => Promise<{ code: number; reason: string }>;
    connect: (workspaceId: string, waitForVnc?: boolean) => Promise<WebSocket>;
  }) => Promise<void>
): Promise<void> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-bridge-revocation-"));
  const config = await createBridgeConfig(rootDir);
  const experimentsService: Partial<ExperimentsService> = { isExperimentEnabled: () => true };
  const workspaceService: Partial<WorkspaceService> = { getInfo: () => Promise.resolve(null) };
  const manager = new DesktopSessionManager({
    config,
    experimentsService: experimentsService as ExperimentsService,
    workspaceService: workspaceService as WorkspaceService,
  });
  const tcp = await listenTcpServer();
  tcp.server.on("connection", (socket) => {
    socket.on("data", (data) => {
      socket.write(data, (error) => {
        if (error) socket.destroy(error);
      });
    });
    socket.write(Buffer.from([0]));
  });
  const connection = spyOn(manager, "getLiveSessionConnection").mockImplementation(
    (workspaceId) => {
      try {
        const { ownerWorkspaceId } = manager.resolveTarget(workspaceId);
        return { ownerWorkspaceId, sessionId: `session:${ownerWorkspaceId}`, vncPort: tcp.port };
      } catch {
        return null;
      }
    }
  );
  const tokens = new DesktopTokenManager();
  const bridge = new DesktopBridgeServer({
    desktopSessionManager: manager,
    desktopTokenManager: tokens,
  });
  const upgrade = await listenUpgradeServer(bridge);
  const clients = new Map<WebSocket, Promise<{ code: number; reason: string }>>();
  try {
    await run({
      manager,
      bridge,
      config,
      closed: (ws) => {
        const closed = clients.get(ws);
        if (!closed) throw new Error("Unknown test viewer");
        return closed;
      },
      connect: async (workspaceId, waitForVnc = true) => {
        const live = manager.getLiveSessionConnection(workspaceId);
        if (!live) throw new Error("Expected live test connection");
        const token = tokens.mint(workspaceId, live.sessionId);
        const ws = new WebSocket(`ws://127.0.0.1:${upgrade.port}/?token=${token}`);
        clients.set(ws, waitForWebSocketClose(ws));
        ws.on("message", (_data, isBinary) => expect(isBinary).toBe(true));
        const greeting = waitForVnc ? waitForWebSocketMessage(ws) : null;
        await waitForWebSocketOpen(ws);
        if (greeting) expect(await greeting).toEqual(Buffer.from([0]));
        return ws;
      },
    });
  } finally {
    await bridge.stop();
    await Promise.all([...clients.keys()].map(closeWebSocket));
    await upgrade.close();
    await tcp.close();
    tokens.dispose();
    connection.mockRestore();
    await manager.closeAll();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

async function withNodeBridge(
  run: (config: Config, connect: (workspaceId: string) => Promise<WebSocket>) => Promise<void>
): Promise<void> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-node-bridge-"));
  const config = await createBridgeConfig(rootDir);
  const fixturePath = path.join(rootDir, "bridge.mjs");
  await fs.symlink(path.resolve("node_modules"), path.join(rootDir, "node_modules"), "junction");
  await build({
    entryPoints: [path.resolve("src/node/services/desktop/DesktopBridgeServer.nodeFixture.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    packages: "external",
    outfile: fixturePath,
    banner: {
      js: 'import { createRequire as fixtureCreateRequire } from "node:module"; const require = fixtureCreateRequire(import.meta.url);',
    },
  });
  using child = new DisposableProcess(
    spawn("node", [fixturePath, rootDir], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    })
  );
  const exited = once(child.underlying, "exit");
  let stderr = "";
  child.underlying.stderr?.on("data", (data) => {
    stderr += String(data);
  });
  const clients: WebSocket[] = [];
  try {
    const ready = await Promise.race([
      once(child.underlying, "message").then((args: unknown[]) => args[0]),
      exited.then(() => {
        throw new Error(`Node bridge exited before ready: ${stderr}`);
      }),
    ]);
    if (
      typeof ready !== "object" ||
      ready === null ||
      !("port" in ready) ||
      typeof ready.port !== "number"
    ) {
      throw new Error("Expected Node bridge port");
    }
    const baseUrl = `http://127.0.0.1:${ready.port}`;
    await run(config, async (workspaceId) => {
      const response = await fetch(`${baseUrl}/?workspaceId=${encodeURIComponent(workspaceId)}`);
      expect(response.status).toBe(200);
      const ws = new WebSocket(
        `${baseUrl.replace("http:", "ws:")}/?token=${await response.text()}`
      );
      clients.push(ws);
      ws.on("message", (_data, isBinary) => expect(isBinary).toBe(true));
      const greeting = waitForWebSocketMessage(ws);
      await waitForWebSocketOpen(ws);
      expect(await greeting).toEqual(Buffer.from([0]));
      return ws;
    });
  } finally {
    if (child.underlying.connected) child.underlying.send("stop");
    await exited;
    await Promise.all(clients.map(closeWebSocket));
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

async function expectEcho(ws: WebSocket): Promise<void> {
  const echoed = waitForWebSocketMessage(ws);
  ws.send(Buffer.from([1, 2, 3]));
  expect(await echoed).toEqual(Buffer.from([1, 2, 3]));
}

describe("DesktopBridgeServer", () => {
  for (const closingWorkspaceId of ["child", "owner"]) {
    test(`closing ${closingWorkspaceId} revokes established affected bridges only`, async () => {
      await withSharedBridge(async ({ manager, connect }) => {
        const clients = new Map<string, WebSocket>();
        for (const workspaceId of ["owner", "child", "sibling", "unrelated"]) {
          const ws = await connect(workspaceId);
          await expectEcho(ws);
          clients.set(workspaceId, ws);
        }
        const revoked = closingWorkspaceId === "owner" ? ["owner", "child", "sibling"] : ["child"];
        const results = [...clients].map(([workspaceId, ws]) => ({
          workspaceId,
          ws,
          response: waitForWebSocketMessage(ws).then(
            () => "message",
            () => "closed"
          ),
          closed: revoked.includes(workspaceId) ? waitForWebSocketClose(ws) : null,
        }));
        await manager.close(closingWorkspaceId);
        // A post-cleanup input frame exposes the old bug deterministically: an unrevoked
        // connection echoes it instead of closing, without a polling or timeout assertion.
        for (const { ws } of results) ws.send(Buffer.from([4, 5, 6]));
        for (const result of results) {
          expect(await result.response).toBe(result.closed ? "closed" : "message");
          if (result.closed) expect((await result.closed).code).toBe(4002);
        }
        const unrelated = clients.get("unrelated");
        if (!unrelated) throw new Error("Missing unrelated test viewer");
        await expectEcho(unrelated);
      });
    });
  }

  for (const changedWorkspaceId of ["child", "owner"]) {
    for (const change of ["archive", "remove"] as const) {
      test(`another backend's ${change} of ${changedWorkspaceId} revokes idle affected viewers`, async () => {
        await withNodeBridge(async (config, connect) => {
          const owner = await connect("owner");
          const child = await connect("child");
          const unrelated = await connect("unrelated");
          const childClosed = waitForWebSocketClose(child);
          const ownerClosed = changedWorkspaceId === "owner" ? waitForWebSocketClose(owner) : null;
          // This Config instance lives outside the Node backend: no in-process close hook fires.
          await config.editConfig((current) => {
            const project = current.projects.get(config.rootDir);
            if (!project) throw new Error("Missing test project");
            if (change === "remove") {
              project.workspaces = project.workspaces.filter(
                (workspace) => workspace.id !== changedWorkspaceId
              );
            } else {
              const workspace = project.workspaces.find(
                (workspace) => workspace.id === changedWorkspaceId
              );
              if (!workspace) throw new Error("Missing test workspace");
              workspace.archivedAt = "2026-09-04T12:00:00Z";
            }
            return current;
          });
          // No client frame is sent: even an idle viewer must be revoked by persisted state.
          expect((await childClosed).code).toBe(4002);
          if (ownerClosed) expect((await ownerClosed).code).toBe(4002);
          else await expectEcho(owner);
          await expectEcho(unrelated);
        });
      });
    }
  }

  test("watch setup failures reject viewers and watcher errors revoke every active viewer", async () => {
    await withSharedBridge(async ({ manager, bridge, connect, closed: closedEvent }) => {
      const stop = mock(() => undefined);
      let failWatch!: (error: unknown) => void;
      const watch = spyOn(manager, "watchWorkspaceConfig").mockImplementation(
        (_change, onError) => {
          failWatch = onError;
          return stop;
        }
      );
      try {
        const clients = await Promise.all([
          connect("owner"),
          connect("child"),
          connect("unrelated"),
        ]);
        expect(watch).toHaveBeenCalledTimes(1);
        const closed = clients.map(waitForWebSocketClose);
        failWatch(new Error("watch lost"));
        for (const result of await Promise.all(closed)) expect(result.code).toBe(4002);
        expect(stop).toHaveBeenCalledTimes(1);

        watch.mockImplementation(() => {
          throw new Error("watch unavailable");
        });
        const rejected = await connect("child", false);
        expect((await closedEvent(rejected)).code).toBe(4002);
        await bridge.stop();
        expect(stop).toHaveBeenCalledTimes(1);
      } finally {
        watch.mockRestore();
      }
    });
  });

  test("rechecks a target changed before watcher installation without waiting for TCP", async () => {
    await withSharedBridge(async ({ manager, bridge, connect, closed }) => {
      const stop = mock(() => undefined);
      const watch = spyOn(manager, "watchWorkspaceConfig").mockImplementation(() => {
        // The change predates the watch, so no filesystem notification will arrive for it.
        manager.setWorkspaceArchiveGuard((workspaceId) => workspaceId === "child");
        return stop;
      });
      const internal = bridge as unknown as { connectToVnc: () => Promise<net.Socket> };
      const connecting = spyOn(internal, "connectToVnc");
      try {
        const ws = await connect("child", false);
        expect((await closed(ws)).code).toBe(4002);
        expect(connecting).not.toHaveBeenCalled();
        expect(stop).toHaveBeenCalledTimes(1);
      } finally {
        watch.mockRestore();
        connecting.mockRestore();
      }
    });
  });

  test("config notifications preserve an established release channel after admission closes", async () => {
    await withSharedBridge(async ({ manager, connect }) => {
      let changed!: () => void;
      const watch = spyOn(manager, "watchWorkspaceConfig").mockImplementation((onChange) => {
        changed = onChange;
        return () => undefined;
      });
      try {
        const child = await connect("child");
        const live = manager.getLiveSessionConnection("child");
        const lookup = spyOn(manager, "getLiveSessionConnection").mockImplementation(
          (_workspaceId, mode) => (mode === "established" ? live : null)
        );
        try {
          changed();
          await expectEcho(child);
          // Durable invalidation still wins, even for an established release channel.
          lookup.mockReturnValue(null);
          const closed = waitForWebSocketClose(child);
          changed();
          expect((await closed).code).toBe(4002);
        } finally {
          lookup.mockRestore();
        }
      } finally {
        watch.mockRestore();
      }
    });
  });

  test("config revalidation deduplicates requesters and checks owner, session and port bindings", async () => {
    await withSharedBridge(async ({ manager, bridge, connect }) => {
      let changed!: () => void;
      const stop = mock(() => undefined);
      const watch = spyOn(manager, "watchWorkspaceConfig").mockImplementation((onChange) => {
        changed = onChange;
        return stop;
      });
      const initialConnections = new Map(
        ["owner", "child", "unrelated"].map((workspaceId) => [
          workspaceId,
          manager.getLiveSessionConnection(workspaceId),
        ])
      );
      let childOverride: ReturnType<DesktopSessionManager["getLiveSessionConnection"]> | undefined;
      const lookup = spyOn(manager, "getLiveSessionConnection").mockImplementation((workspaceId) =>
        workspaceId === "child" && childOverride !== undefined
          ? childOverride
          : (initialConnections.get(workspaceId) ?? null)
      );
      try {
        const owner = await connect("owner");
        const unrelated = await connect("unrelated");
        for (const field of ["ownerWorkspaceId", "sessionId", "vncPort"] as const) {
          childOverride = undefined;
          const child = await connect("child");
          const duplicate = await connect("child");
          const current = initialConnections.get("child");
          if (!current) throw new Error("Expected child connection");
          const childClosed = [child, duplicate].map(waitForWebSocketClose);
          childOverride =
            field === "vncPort"
              ? { ...current, vncPort: current.vncPort + 1 }
              : { ...current, [field]: "changed" };
          lookup.mockClear();
          changed();
          expect(lookup.mock.calls.filter(([id]) => id === "child")).toHaveLength(1);
          for (const result of await Promise.all(childClosed)) expect(result.code).toBe(4002);
          await expectEcho(owner);
          await expectEcho(unrelated);
        }
        const closed = [owner, unrelated].map(waitForWebSocketClose);
        await bridge.stop();
        await Promise.all(closed);
        expect(stop).toHaveBeenCalledTimes(1);
      } finally {
        lookup.mockRestore();
        watch.mockRestore();
      }
    });
  });

  for (const cleanup of ["child", "owner", "all", "guard", "config", "watch-error"] as const) {
    test(`${cleanup} cleanup refuses a late TCP connection without leaking a subscription`, async () => {
      await withSharedBridge(async ({ manager, bridge, config, connect }) => {
        let changed!: () => void;
        let failed!: (error: unknown) => void;
        const watch = spyOn(manager, "watchWorkspaceConfig").mockImplementation(
          (onChange, onError) => {
            changed = onChange;
            failed = onError;
            return () => undefined;
          }
        );
        interface ConnectingBridge {
          connectToVnc: (port: number, signal: AbortSignal) => Promise<net.Socket>;
        }
        const internal = bridge as unknown as ConnectingBridge;
        const connectToVnc = internal.connectToVnc.bind(bridge);
        const connected = createDeferred<net.Socket>();
        const release = createDeferred<void>();
        const pending = spyOn(internal, "connectToVnc").mockImplementation(async (port, signal) => {
          const tcp = await connectToVnc(port, signal);
          connected.resolve(tcp);
          await release.promise;
          return tcp;
        });
        try {
          const ws = await connect("child", false);
          const tcp = await connected.promise;
          const tcpClosed = new Promise<void>((resolve) => tcp.once("close", () => resolve()));
          const closed = waitForWebSocketClose(ws);
          if (cleanup === "config") {
            await config.editConfig((current) => {
              const child = current.projects
                .get(config.rootDir)
                ?.workspaces.find((workspace) => workspace.id === "child");
              if (!child) throw new Error("Missing child");
              child.archivedAt = "2026-09-04T12:00:00Z";
              return current;
            });
            changed();
            expect((await closed).code).toBe(4002);
          } else if (cleanup === "watch-error") {
            failed(new Error("watch lost"));
            expect((await closed).code).toBe(4002);
          } else if (cleanup === "guard") {
            manager.setWorkspaceArchiveGuard((workspaceId) => workspaceId === "child");
          } else if (cleanup === "all") {
            await manager.closeAll();
          } else {
            await manager.close(cleanup);
          }
          release.resolve();
          expect((await closed).code).toBe(4002);
          await tcpClosed;
          expect(tcp.destroyed).toBe(true);
          const listeners: unknown = Reflect.get(manager, "closeListeners");
          expect(listeners).toBeInstanceOf(Set);
          if (!(listeners instanceof Set)) throw new Error("Expected close subscriptions");
          expect(listeners.size).toBe(0);
          pending.mockRestore();
          await expectEcho(await connect("unrelated"));
        } finally {
          release.resolve();
          pending.mockRestore();
          watch.mockRestore();
        }
      });
    });
  }

  test("shared tokens authorize the requester and bind its owner's session", async () => {
    const tcpHarness = await listenTcpServer();
    const tokens = new DesktopTokenManager();
    const token = tokens.mint("child", "owner-session");
    const getLiveSessionConnection = mock((workspaceId: string) =>
      workspaceId === "child"
        ? { ownerWorkspaceId: "owner", sessionId: "owner-session", vncPort: tcpHarness.port }
        : null
    );
    const noteDetached = mock((_requester: string, _owner: string) => undefined);
    const bridgeServer = new DesktopBridgeServer({
      desktopTokenManager: tokens,
      desktopSessionManager: {
        getLiveSessionConnection,
        onWorkspaceClose: () => () => undefined,
        watchWorkspaceConfig: () => () => undefined,
        noteDetached,
      },
    });
    const upgradeHarness = await listenUpgradeServer(bridgeServer);
    let ws: WebSocket | null = null;
    try {
      expect(bridgeServer.hasActiveBridge("child")).toBe(false);
      ws = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}/?token=${token}&workspaceId=owner`);
      await waitForWebSocketOpen(ws);
      const tcpSocket = await tcpHarness.connectionPromise;
      ws.send(Buffer.from([1, 2, 3]));
      expect(await waitForTcpData(tcpSocket)).toEqual(Buffer.from([1, 2, 3]));
      // The attached bridge counts for the requester and the owner whose desktop it shows,
      // but not for unrelated workspaces.
      expect(bridgeServer.hasActiveBridge("child")).toBe(true);
      expect(bridgeServer.hasActiveBridge("owner")).toBe(true);
      expect(bridgeServer.hasActiveBridge("isolated")).toBe(false);
      await closeWebSocket(ws);
      ws = null;
      // The client's close event can land before the server finishes its own close handling.
      for (let attempt = 0; attempt < 50 && bridgeServer.hasActiveBridge("child"); attempt++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(bridgeServer.hasActiveBridge("child")).toBe(false);
      expect(bridgeServer.hasActiveBridge("owner")).toBe(false);
      // The closed bridge hands requester and owner to the manager's bounded attachment grace.
      expect(noteDetached).toHaveBeenCalledWith("child", "owner");
      expect(getLiveSessionConnection.mock.calls.map((call) => call[0])).toEqual([
        "child",
        "child",
        "child",
      ]);
      const replay = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}/?token=${token}`);
      expect((await waitForWebSocketClose(replay)).code).toBe(4001);
    } finally {
      if (ws) await closeWebSocket(ws);
      tokens.dispose();
      await upgradeHarness.close();
      await bridgeServer.stop();
      await tcpHarness.close();
    }
  });

  test("refuses a requester whose target disappears while connecting to VNC", async () => {
    const tcpHarness = await listenTcpServer();
    let checks = 0;
    const bridgeServer = createBridgeServer({
      getLiveSessionConnection: () => {
        checks += 1;
        return checks <= 2 ? { sessionId: VALID_SESSION_ID, vncPort: tcpHarness.port } : null;
      },
    });
    const upgradeHarness = await listenUpgradeServer(bridgeServer);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}/?token=${VALID_TOKEN}`);
      expect((await waitForWebSocketClose(ws)).code).toBe(4002);
      expect(checks).toBe(3);
    } finally {
      await upgradeHarness.close();
      await bridgeServer.stop();
      await tcpHarness.close();
    }
  });

  test("handleUpgrade bridges binary traffic when mounted on an external HTTP server", async () => {
    const tcpHarness = await listenTcpServer();
    const bridgeServer = createBridgeServer({
      getLiveSessionConnection: mock((workspaceId: string) =>
        workspaceId === VALID_WORKSPACE_ID
          ? { sessionId: VALID_SESSION_ID, vncPort: tcpHarness.port }
          : null
      ),
    });
    const upgradeHarness = await listenUpgradeServer(bridgeServer);

    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}/?token=${VALID_TOKEN}`);
      await waitForWebSocketOpen(ws);

      const tcpSocket = await tcpHarness.connectionPromise;
      ws.send(Buffer.from([0x01, 0x02, 0x03]));
      const forwarded = await waitForTcpData(tcpSocket);
      expect(forwarded).toEqual(Buffer.from([0x01, 0x02, 0x03]));

      tcpSocket.write(Buffer.from([0x0a, 0x0b, 0x0c]));
      expect(await waitForWebSocketMessage(ws)).toEqual(Buffer.from([0x0a, 0x0b, 0x0c]));
    } finally {
      if (ws) {
        await closeWebSocket(ws);
      }
      await upgradeHarness.close();
      await bridgeServer.stop();
      await tcpHarness.close();
    }
  });

  test.each([false, true])(
    "client close flushes buffered input even when workspace revocation wins the close callback (%s)",
    async (revokeFirst) => {
      const tcpHarness = await listenTcpServer();
      let revoke!: (workspaceId: string | null) => void;
      const bridge = createBridgeServer({
        getLiveSessionConnection: () => ({ sessionId: VALID_SESSION_ID, vncPort: tcpHarness.port }),
        onWorkspaceClose: (listener) => {
          revoke = listener;
          return () => undefined;
        },
      });
      const internal = bridge as unknown as {
        connectToVnc: (port: number, signal: AbortSignal) => Promise<net.Socket>;
        activePairs: Set<{ ws: WebSocket }>;
      };
      const connectToVnc = internal.connectToVnc.bind(bridge);
      const connected = createDeferred<net.Socket>();
      const connect = spyOn(internal, "connectToVnc").mockImplementation(async (port, signal) => {
        const tcp = await connectToVnc(port, signal);
        // Keep the release frame in Node's write buffer until cleanup chooses end or destroy.
        tcp.cork();
        connected.resolve(tcp);
        return tcp;
      });
      const upgrade = await listenUpgradeServer(bridge);
      const ws = new WebSocket(`ws://127.0.0.1:${upgrade.port}/?token=${VALID_TOKEN}`);
      try {
        await waitForWebSocketOpen(ws);
        await connected.promise;
        if (revokeFirst) {
          for (const pair of internal.activePairs) {
            pair.ws.prependOnceListener("close", () => revoke(VALID_WORKSPACE_ID));
          }
        }
        const peer = await tcpHarness.connectionPromise;
        const received: Buffer[] = [];
        peer.on("data", (data: Buffer) => received.push(data));
        const ended = once(peer, "end");
        const release = Buffer.from([4, 0, 0, 0, 0, 0, 0xff, 0xe1]);
        ws.send(release);
        await closeWebSocket(ws);
        await ended;
        expect(Buffer.concat(received)).toEqual(release);
        await bridge.stop();
      } finally {
        connect.mockRestore();
        await closeWebSocket(ws);
        await upgrade.close();
        await bridge.stop();
        await tcpHarness.close();
      }
    }
  );

  test("closes with 4001 for invalid or missing tokens", async () => {
    const bridgeServer = createBridgeServer({
      validate: mock(() => null),
      getLiveSessionConnection: mock(() => null),
    });
    const upgradeHarness = await listenUpgradeServer(bridgeServer);

    try {
      for (const suffix of ["", "/?token=bad-token"]) {
        const ws = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}${suffix}`);
        const closeEvent = await waitForWebSocketClose(ws);
        expect(closeEvent.code).toBe(4001);
        expect(closeEvent.reason).toBe("invalid token");
      }
    } finally {
      await upgradeHarness.close();
      await bridgeServer.stop();
    }
  });

  test("closes with 4002 when the live session is missing or mismatched", async () => {
    const scenarios = [
      { name: "missing session", liveSession: null },
      {
        name: "mismatched session",
        liveSession: { sessionId: "desktop:other-workspace", vncPort: 5900 },
      },
    ];

    for (const scenario of scenarios) {
      const bridgeServer = createBridgeServer({
        validate: mock(() => ({ workspaceId: VALID_WORKSPACE_ID, sessionId: VALID_SESSION_ID })),
        getLiveSessionConnection: mock(() => scenario.liveSession),
      });
      const upgradeHarness = await listenUpgradeServer(bridgeServer);

      try {
        const ws = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}/?token=${VALID_TOKEN}`);
        const closeEvent = await waitForWebSocketClose(ws);
        expect(closeEvent.code).toBe(4002);
        expect(closeEvent.reason).toBe("session unavailable");
      } finally {
        await upgradeHarness.close();
        await bridgeServer.stop();
      }
    }
  });

  test("a bridge that never reached VNC leaves no attachment grace", async () => {
    const noteDetached = mock((_requester: string, _owner: string) => undefined);
    const bridgeServer = new DesktopBridgeServer({
      desktopTokenManager: {
        validate: () => ({ workspaceId: VALID_WORKSPACE_ID, sessionId: VALID_SESSION_ID }),
      },
      desktopSessionManager: {
        // An unreachable VNC port: the upgrade is admitted but TCP never connects.
        getLiveSessionConnection: () => ({
          ownerWorkspaceId: VALID_WORKSPACE_ID,
          sessionId: VALID_SESSION_ID,
          vncPort: 1,
        }),
        onWorkspaceClose: () => () => undefined,
        watchWorkspaceConfig: () => () => undefined,
        noteDetached,
      },
    });
    const upgradeHarness = await listenUpgradeServer(bridgeServer);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}/?token=${VALID_TOKEN}`);
      expect((await waitForWebSocketClose(ws)).code).toBe(4003);
      expect(noteDetached).not.toHaveBeenCalled();
    } finally {
      await upgradeHarness.close();
      await bridgeServer.stop();
    }
  });

  test("closes with 4003 when the VNC endpoint cannot be reached", async () => {
    const deadServer = await listenTcpServer();
    const deadPort = deadServer.port;
    await deadServer.close();

    const bridgeServer = createBridgeServer({
      validate: mock(() => ({ workspaceId: VALID_WORKSPACE_ID, sessionId: VALID_SESSION_ID })),
      getLiveSessionConnection: mock(() => ({
        sessionId: VALID_SESSION_ID,
        vncPort: deadPort,
      })),
    });
    const upgradeHarness = await listenUpgradeServer(bridgeServer);

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}/?token=${VALID_TOKEN}`);
      const closeEvent = await waitForWebSocketClose(ws);
      expect(closeEvent.code).toBe(4003);
      expect(closeEvent.reason).toBe("vnc connect failed");
    } finally {
      await upgradeHarness.close();
      await bridgeServer.stop();
    }
  });

  test("stop closes active connections and is idempotent", async () => {
    const tcpHarness = await listenTcpServer();
    const bridgeServer = createBridgeServer({
      validate: mock(() => ({ workspaceId: VALID_WORKSPACE_ID, sessionId: VALID_SESSION_ID })),
      getLiveSessionConnection: mock(() => ({
        sessionId: VALID_SESSION_ID,
        vncPort: tcpHarness.port,
      })),
    });
    const upgradeHarness = await listenUpgradeServer(bridgeServer);
    const hangingConnect = createDeferred<net.Socket>();

    interface PrivateBridgeServer {
      connectToVnc: (port: number) => Promise<net.Socket>;
    }

    let activeWs: WebSocket | null = null;
    let orphanWs: WebSocket | null = null;
    const connectToVncSpy = spyOn(bridgeServer as unknown as PrivateBridgeServer, "connectToVnc");

    try {
      connectToVncSpy.mockRestore();

      activeWs = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}/?token=${VALID_TOKEN}`);
      await waitForWebSocketOpen(activeWs);
      await tcpHarness.connectionPromise;

      connectToVncSpy.mockImplementation(() => hangingConnect.promise);
      orphanWs = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}/?token=${VALID_TOKEN}`);
      await waitForWebSocketOpen(orphanWs);

      const activeClosePromise = waitForWebSocketClose(activeWs);
      const orphanClosePromise = waitForWebSocketClose(orphanWs);
      await bridgeServer.stop();

      const activeCloseEvent = await activeClosePromise;
      expect([1000, 1001]).toContain(activeCloseEvent.code);
      expect(activeCloseEvent.reason).toBe("server stopping");

      const orphanCloseEvent = await orphanClosePromise;
      expect([1000, 1001]).toContain(orphanCloseEvent.code);
      expect(orphanCloseEvent.reason).toBe("server stopping");

      hangingConnect.reject(new Error("stop test cleanup"));
      await bridgeServer.stop();
    } finally {
      hangingConnect.reject(new Error("stop test cleanup"));
      connectToVncSpy.mockRestore();
      if (activeWs && activeWs.readyState !== WebSocket.CLOSED) {
        await closeWebSocket(activeWs);
      }
      if (orphanWs && orphanWs.readyState !== WebSocket.CLOSED) {
        await closeWebSocket(orphanWs);
      }
      await upgradeHarness.close();
      await bridgeServer.stop();
      await tcpHarness.close();
    }
  });

  test("ignores text frames without breaking later binary traffic", async () => {
    const tcpHarness = await listenTcpServer();
    const bridgeServer = createBridgeServer({
      validate: mock(() => ({ workspaceId: VALID_WORKSPACE_ID, sessionId: VALID_SESSION_ID })),
      getLiveSessionConnection: mock(() => ({
        sessionId: VALID_SESSION_ID,
        vncPort: tcpHarness.port,
      })),
    });
    const upgradeHarness = await listenUpgradeServer(bridgeServer);

    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${upgradeHarness.port}/?token=${VALID_TOKEN}`);
      await waitForWebSocketOpen(ws);

      const tcpSocket = await tcpHarness.connectionPromise;
      ws.send("ignored text frame");
      expect(await waitForTcpData(tcpSocket, 200)).toBeNull();

      ws.send(Buffer.from([0xde, 0xad]));
      expect(await waitForTcpData(tcpSocket)).toEqual(Buffer.from([0xde, 0xad]));
    } finally {
      if (ws) {
        await closeWebSocket(ws);
      }
      await upgradeHarness.close();
      await bridgeServer.stop();
      await tcpHarness.close();
    }
  });
});
