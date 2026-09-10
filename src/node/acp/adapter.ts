import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { MuxAgent } from "./agent";
import type { ServerConnection } from "./serverConnection";

/**
 * ACP framing is sent over process.stdout.  Any non-protocol output to stdout
 * (e.g., from mux's logger at info/debug level, or from an in-process server)
 * would corrupt the NDJSON stream seen by editors.
 *
 * Call this **before** any code that may log to stdout (including
 * `connectToServer`, which may start an in-process server).
 *
 * In Node.js, `console.log`, `console.info`, `console.debug`, and
 * `console.dir` all write to stdout.  We redirect every one of them to stderr
 * (via `console.error`) so only ACP JSON-RPC frames appear on stdout.
 * `console.error`/`console.warn` already target stderr and are unaffected.
 */
export function isolateStdoutForAcp(): void {
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
  console.dir = console.error;
}

export async function runAcpAdapter(server: ServerConnection): Promise<void> {
  assert(server != null, "runAcpAdapter: server connection is required");

  // ACP SDK expects Web streams; process stdio is Node stream instances.
  // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
  const input = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const stream = ndJsonStream(output, input);

  let waitForDisconnectCleanup: () => Promise<void> = () => Promise.resolve();
  const connection = new AgentSideConnection((conn) => {
    const createdAgent = new MuxAgent(conn, server);
    waitForDisconnectCleanup = () => createdAgent.waitForDisconnectCleanup();
    return createdAgent;
  }, stream);

  try {
    await connection.closed;
  } finally {
    await waitForDisconnectCleanup();
    await server.close();
  }
}
