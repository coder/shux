import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// These tests run the bundled module in a node child process: the Docker
// server runtime is node, and neither issue #3699's module-eval asset read
// nor happy-dom's subresource fetching reproduces under the bun test runner.
describe("web_fetch server bundle", () => {
  let tempDir: string;
  let bundlePath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mux-web-fetch-bundle-"));
    bundlePath = join(tempDir, "web_fetch.bundle.js");

    const bundleResult = spawnSync(
      "bun",
      [
        "x",
        "esbuild",
        resolve("src/node/services/tools/web_fetch.ts"),
        "--bundle",
        "--platform=node",
        "--target=node22",
        "--format=cjs",
        `--outfile=${bundlePath}`,
        "--external:@lydell/node-pty",
        "--external:node-pty",
        "--external:electron",
        "--external:ssh2",
        "--alias:jsonc-parser=jsonc-parser/lib/esm/main.js",
      ],
      { encoding: "utf8" }
    );
    expect(bundleResult.status, bundleResult.stderr).toBe(0);
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads from outside the repository without runtime asset reads", () => {
    // Guards against module-eval-time runtime asset reads such as issue #3699's stylesheet failure.
    const loadResult = spawnSync(
      "node",
      [
        "-e",
        `const exports = require(${JSON.stringify(bundlePath)}); if (typeof exports.createWebFetchTool !== "function") process.exit(1);`,
      ],
      { cwd: tempDir, encoding: "utf8" }
    );
    expect(loadResult.status, loadResult.stderr).toBe(0);
  }, 30_000);

  it("does not fetch subresources from untrusted HTML while parsing", () => {
    // Subresources target loopback: the SSRF surface that
    // assertWebFetchTargetAllowed blocks for the top-level URL.
    const scriptPath = join(tempDir, "ssrf-check.cjs");
    writeFileSync(
      scriptPath,
      `
      const net = require("node:net");
      const { parseHtmlDocument } = require(${JSON.stringify(bundlePath)});

      const hits = [];
      const server = net.createServer((socket) => {
        socket.on("data", (data) => {
          const match = /^GET (\\S+)/.exec(data.toString());
          if (match) hits.push(match[1]);
        });
        socket.end();
      });
      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        const hostileHtml =
          '<!DOCTYPE html><html><head><title>Hostile Page</title>' +
          '<link rel="stylesheet" href="http://127.0.0.1:' + port + '/steal.css">' +
          '</head><body>' +
          '<iframe src="http://127.0.0.1:' + port + '/internal-admin"></iframe>' +
          '<script src="http://127.0.0.1:' + port + '/evil.js"><\\/script>' +
          '<article><h1>Cover story</h1><p>Plausible article text.</p></article>' +
          '</body></html>';
        const document = parseHtmlDocument(hostileHtml, "https://93.184.216.34/page");
        if (document.title !== "Hostile Page") {
          console.error("PARSE_BROKEN: title=" + document.title);
          process.exit(2);
        }
        // Subresource loads are asynchronous; give any leaked request time to arrive.
        setTimeout(() => {
          server.close();
          if (hits.length > 0) {
            console.error("SUBRESOURCE_FETCHED: " + hits.join(","));
            process.exit(1);
          }
          process.exit(0);
        }, 500);
      });
      `
    );

    const result = spawnSync("node", [scriptPath], { cwd: tempDir, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  }, 30_000);
});
