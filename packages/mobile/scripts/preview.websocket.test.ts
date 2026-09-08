import { expect, test } from "bun:test";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { WebSocket } from "ws";
import {
  ORPC_WS_PROTOCOL,
  ORPC_WS_TICKET_PREFIX,
} from "../../../src/common/constants/webSocketAuth";

// Exercise the same Node entry used by make mobile-web. Bun's node:http proxy
// accepts upgrades but can stall binary oRPC frames, invisible to HTTP-only tests.
test("Node preview forwards binary WebSocket frames with ticket protocols intact and browser identity stripped", async () => {
  const ticket = "a".repeat(64);
  const protocols = [ORPC_WS_PROTOCOL, ORPC_WS_TICKET_PREFIX + ticket];
  const requests: Request[] = [];
  const upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, server) {
      const url = new URL(req.url);
      requests.push(req);
      if (
        url.pathname !== "/prefix/orpc/ws" ||
        url.search ||
        req.headers.get("sec-websocket-protocol")?.split(/,\s*/).join(",") !== protocols.join(",")
      )
        return new Response("Unauthorized", { status: 401 });
      return server.upgrade(req) ? undefined : new Response("Upgrade required", { status: 400 });
    },
    websocket: {
      message(socket, message) {
        socket.send(message);
      },
    },
  });
  const reservation = net.createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const child = Bun.spawn(["node", ".expo/preview.mjs"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: {
      ...process.env,
      XUM_MOBILE_ENDPOINT: `http://127.0.0.1:${upstream.port}/prefix`,
      XUM_MOBILE_PORT: String(port),
      XUM_MOBILE_ORIGIN: `http://127.0.0.1:${port}`,
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  let socket: WebSocket | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        const reader = child.stdout.getReader();
        let output = "";
        while (!output.includes("Xum mobile preview:")) {
          const part = await reader.read();
          if (part.done) throw new Error("Preview exited before ready");
          output += new TextDecoder().decode(part.value);
        }
        reader.releaseLock();
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Preview startup timed out")), 3000);
      }),
    ]);
    clearTimeout(timeout);
    const bytes = new Uint8Array([0, 128, 255, 10]);
    socket = new WebSocket(`ws://127.0.0.1:${port}/__xum/orpc/ws`, protocols, {
      headers: {
        origin: `http://127.0.0.1:${port}`,
        cookie: "private-preview-cookie",
        forwarded: "host=attacker.test",
        "x-forwarded-host": "attacker.test",
      },
    });
    socket.binaryType = "arraybuffer";
    const reply = await new Promise<ArrayBuffer>((resolve, reject) => {
      const ws = socket!;
      timeout = setTimeout(() => reject(new Error("Proxy stalled WebSocket frames")), 3000);
      ws.onopen = () => ws.send(bytes);
      ws.onmessage = (event) => resolve(event.data as ArrayBuffer);
      ws.onerror = () => reject(new Error("Proxy WebSocket failed"));
    });
    expect(new Uint8Array(reply)).toEqual(bytes);
    expect(socket.protocol).toBe(protocols[0]);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.get("cookie")).toBeNull();
    expect(requests[0].headers.get("authorization")).toBeNull();
    expect(requests[0].headers.get("forwarded")).toBeNull();
    expect(requests[0].headers.get("x-forwarded-host")).toBeNull();
    expect(requests[0].headers.get("origin")).toBe(`http://127.0.0.1:${upstream.port}`);
    const rejected = net.createConnection({ host: "127.0.0.1", port });
    try {
      await once(rejected, "connect");
      rejected.write(
        [
          "GET /__xum/orpc/ws HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Origin: https://attacker.test",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          `Sec-WebSocket-Protocol: ${protocols.join(", ")}`,
          "",
          "",
        ].join("\r\n")
      );
      const [response] = await once(rejected, "data");
      expect(String(response)).toContain("403 Forbidden");
      expect(requests).toHaveLength(1);
    } finally {
      rejected.destroy();
    }
  } finally {
    clearTimeout(timeout);
    socket?.close();
    child.kill();
    await child.exited;
    upstream.stop(true);
  }
}, 10_000);
