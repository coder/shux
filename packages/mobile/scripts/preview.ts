import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import httpProxy from "http-proxy";
import { normalizeEndpoint } from "../src/endpoint";

export interface PreviewOptions {
  endpoint: string;
  origin: string;
  metro?: string;
  staticDirectory?: string;
}

export function createPreviewServer(options: PreviewOptions) {
  const endpoint = normalizeEndpoint(options.endpoint);
  const target = new URL(endpoint);
  const origin = new URL(options.origin);
  // Subscriptions are long-lived streamed responses; the server's keep-alive comments
  // arrive well within this idle bound, so only a dead upstream trips it.
  const proxy = httpProxy.createProxyServer({ changeOrigin: true, proxyTimeout: 30_000 });
  proxy.on("proxyRes", (proxyRes, _req, res) => {
    // http-proxy leaves the browser's streamed response open when the upstream dies
    // mid-stream; the client must see the drop to reconnect.
    proxyRes.once("close", () => {
      if (!res.writableEnded) res.destroy();
    });
  });
  const allowed = (req: http.IncomingMessage) =>
    req.headers.host === origin.host &&
    (!req.headers.origin || req.headers.origin === origin.origin) &&
    req.headers["sec-fetch-site"] !== "cross-site";

  function route(req: http.IncomingMessage): string | null {
    const pathname = (req.url ?? "/").split("?")[0];
    if (pathname === "/__xum/orpc" || pathname?.startsWith("/__xum/orpc/")) {
      req.url = `${target.pathname.replace(/\/$/, "")}${req.url!.slice("/__xum".length)}`;
      // SECURITY: only a same-origin caller can use this fixed upstream. Do not
      // leak preview cookies/forwarded identity or let the client pick a target.
      for (const key of Object.keys(req.headers)) {
        if (
          key.startsWith("x-forwarded-") ||
          ["cookie", "forwarded", "referer", "origin"].includes(key)
        )
          delete req.headers[key];
      }
      req.headers.origin = target.origin;
      return target.origin;
    }
    if (pathname?.startsWith("/__xum")) return null;
    return options.staticDirectory ? null : (options.metro ?? "http://127.0.0.1:8081");
  }

  const server = http.createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!allowed(req)) {
      res.writeHead(403).end("Preview origin rejected");
      return;
    }
    if (req.method === "GET" && req.url === "/__xum") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ endpoint }));
      return;
    }
    const upstream = route(req);
    if (upstream) {
      proxy.web(req, res, { target: upstream }, () => {
        if (!res.headersSent) res.writeHead(502);
        res.end("Preview upstream unavailable");
      });
      return;
    }
    if (options.staticDirectory && !req.url?.startsWith("/__xum") && req.method === "GET") {
      serveStatic(options.staticDirectory, req.url ?? "/", res).catch(() =>
        res.writeHead(404).end("Not found")
      );
      return;
    }
    res.writeHead(404).end("Not found");
  });
  server.on("close", () => proxy.close());
  return server;
}

async function serveStatic(directory: string, url: string, res: http.ServerResponse) {
  const root = path.resolve(directory);
  const pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
  const file = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!file.startsWith(`${root}${path.sep}`)) {
    res.writeHead(403).end();
    return;
  }
  const data = await readFile(file);
  const types: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
  };
  res.setHeader("Content-Type", types[path.extname(file)] ?? "application/octet-stream");
  res.end(data);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const endpoint = process.env.XUM_MOBILE_ENDPOINT;
  if (!endpoint)
    throw new Error(
      "Set XUM_MOBILE_ENDPOINT to the running Xum server URL (never include a token)."
    );
  const port = Number(process.env.XUM_MOBILE_PORT ?? "8082");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid XUM_MOBILE_PORT");
  const origin = process.env.XUM_MOBILE_ORIGIN ?? `http://127.0.0.1:${port}`;
  const server = createPreviewServer({
    endpoint,
    origin,
    metro: process.env.XUM_MOBILE_METRO,
    staticDirectory: process.env.XUM_MOBILE_STATIC_DIR,
  });
  server.listen(port, "127.0.0.1", () => console.log(`Xum mobile preview: ${origin}`));
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => server.close(() => process.exit(0)));
}
