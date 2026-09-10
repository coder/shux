// Minimal MCP server used by integration tests.
//
// Intentionally tiny and dependency-free: it speaks JSON-RPC over stdio
// (newline-delimited JSON) and exposes a screenshot tool plus deterministic prompts.
//
// This lets integration tests cover MCP image conversion and prompt invocation without
// launching a real browser or external MCP service.

const readline = require("readline");

/**
 * Write a JSON-RPC message to stdout.
 *
 * NOTE: @ai-sdk/mcp stdio transport uses newline-delimited JSON.
 */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const SERVER_INFO = { name: "mux-test-screenshot-mcp", version: "0.0.0" };

// Simulates a conforming prompt-only server: advertises no tools capability and
// rejects tools/list outright.
const PROMPTS_ONLY = process.argv.includes("--prompts-only");

const TOOLS = [
  {
    name: "take_screenshot",
    description: "Return a deterministic screenshot image payload (base64) for tests.",
    inputSchema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["png", "jpeg"],
          description: "Image format",
        },
      },
      additionalProperties: true,
    },
  },
];

const PROMPTS = [
  {
    name: "review",
    description: "Build a deterministic review prompt for tests.",
    arguments: [
      { name: "path", description: "Path to review", required: true },
      { name: "focus", description: "Optional review focus", required: false },
    ],
  },
  {
    name: "status",
    description: "Build a no-argument status prompt for tests.",
  },
];

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (message?.jsonrpc !== "2.0") return;

  // Notifications have no id; ignore.
  if (message.id === undefined) {
    return;
  }

  const id = message.id;

  try {
    switch (message.method) {
      case "initialize": {
        const protocolVersion = message.params?.protocolVersion ?? "2024-11-05";
        send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            capabilities: PROMPTS_ONLY ? { prompts: {} } : { tools: {}, prompts: {} },
            serverInfo: SERVER_INFO,
          },
        });
        return;
      }

      case "tools/list": {
        if (PROMPTS_ONLY) {
          send({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: "Method not found: tools/list" },
          });
          return;
        }
        send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
        return;
      }

      case "prompts/list": {
        // One prompt per page so integration tests pin whole-catalog pagination.
        const cursor = message.params?.cursor;
        const index = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
        const prompts = PROMPTS.slice(index, index + 1);
        const nextCursor = index + 1 < PROMPTS.length ? String(index + 1) : undefined;
        send({
          jsonrpc: "2.0",
          id,
          result: { prompts, ...(nextCursor !== undefined ? { nextCursor } : {}) },
        });
        return;
      }

      case "prompts/get": {
        const promptName = message.params?.name;
        // Unlisted prompt that never responds, for client-side abort tests.
        if (promptName === "hang") {
          return;
        }
        if (!PROMPTS.some((prompt) => prompt.name === promptName)) {
          send({
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: `Unknown prompt: ${promptName}` },
          });
          return;
        }
        const args = message.params?.arguments ?? {};
        if (promptName === "review" && !args.path) {
          send({
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "path is required" },
          });
          return;
        }
        send({
          jsonrpc: "2.0",
          id,
          result: {
            description: `Expanded ${promptName} prompt`,
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text:
                    promptName === "review"
                      ? `Review ${args.path}${args.focus ? ` with focus on ${args.focus}` : ""}`
                      : "Report workspace status",
                },
              },
            ],
          },
        });
        return;
      }

      case "tools/call": {
        const toolName = message.params?.name;
        if (toolName !== "take_screenshot") {
          send({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Unknown tool: ${toolName}` },
          });
          return;
        }

        const format = message.params?.arguments?.format;
        const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";

        // Produce a deterministic payload large enough for tests (>1000 chars base64).
        const fillByte = mimeType === "image/jpeg" ? 0x22 : 0x11;
        const data = Buffer.alloc(2048, fillByte).toString("base64");

        send({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "image", data, mimeType }],
          },
        });
        return;
      }

      default: {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        });
        return;
      }
    }
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

rl.on("close", () => {
  process.exit(0);
});

process.on("SIGTERM", () => {
  rl.close();
});

process.on("SIGINT", () => {
  rl.close();
});
