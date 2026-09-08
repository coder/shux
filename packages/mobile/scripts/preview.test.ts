import { afterEach, describe, expect, test } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createPreviewServer } from "./preview";

const servers: http.Server[] = [];
async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});

const origin = "http://127.0.0.1:8082";
const host = "127.0.0.1:8082";

describe("fixed-target mobile preview", () => {
  test("forwards the configured path prefix and auth, but not browser identity", async () => {
    const endpoint = await listen(
      http.createServer((req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ url: req.url, headers: req.headers }));
      })
    );
    const preview = await listen(
      createPreviewServer({ endpoint: `${endpoint}/@me/dev/apps/xum`, origin })
    );
    const result = await fetch(`${preview}/__xum/orpc/workspace/list`, {
      method: "POST",
      headers: {
        host,
        origin,
        Authorization: "Bearer test-only",
        Cookie: "secret-preview-cookie",
        "X-Forwarded-Host": "attacker.test",
        Forwarded: "host=attacker.test",
      },
    });
    const body = await result.json();
    expect(result.status).toBe(200);
    expect(body.url).toBe("/@me/dev/apps/xum/orpc/workspace/list");
    expect(body.headers.authorization).toBe("Bearer test-only");
    expect(body.headers.origin).toBe(endpoint);
    expect(body.headers.cookie).toBeUndefined();
    expect(body.headers.forwarded).toBeUndefined();
    expect(body.headers["x-forwarded-host"]).toBeUndefined();
  });

  test("rejects cross-origin and DNS-rebound callers before hitting upstream", async () => {
    let requests = 0;
    const endpoint = await listen(
      http.createServer((_req, res) => {
        requests++;
        res.end();
      })
    );
    const preview = await listen(createPreviewServer({ endpoint, origin }));
    const rejectedHeaders: Array<Record<string, string>> = [
      { host, origin: "https://attacker.test" },
      { host: "attacker.test", origin },
      { host, "sec-fetch-site": "cross-site" },
    ];
    for (const headers of rejectedHeaders) {
      expect((await fetch(`${preview}/__xum/orpc`, { headers })).status).toBe(403);
    }
    expect(requests).toBe(0);
  });

  test("exposes only the configured endpoint and refuses arbitrary proxy routes", async () => {
    const endpoint = "https://xum.example.com/prefix";
    const preview = await listen(createPreviewServer({ endpoint, origin }));
    const result = await fetch(`${preview}/__xum`, { headers: { host } });
    expect(await result.json()).toEqual({ endpoint });
    expect(
      (await fetch(`${preview}/__xum/https://attacker.test`, { headers: { host } })).status
    ).toBe(404);
  });
});

test("streams a long-lived subscription response through without buffering", async () => {
  let push!: (chunk: string) => void;
  const endpoint = await listen(
    http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      push = (chunk) => res.write(chunk);
      push(": open\n\n");
    })
  );
  const preview = await listen(createPreviewServer({ endpoint, origin }));
  const response = await fetch(`${preview}/__xum/orpc/workspace/onChat`, {
    method: "POST",
    headers: { host, origin },
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  expect(decoder.decode((await reader.read()).value)).toContain(": open");
  // A second chunk must arrive while the upstream response is still open.
  push("event: message\ndata: {}\n\n");
  expect(decoder.decode((await reader.read()).value)).toContain("event: message");
  await reader.cancel();
});
