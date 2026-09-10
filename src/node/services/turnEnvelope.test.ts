import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import {
  dynamicTool,
  jsonSchema,
  tool,
  type FlexibleSchema,
  type JSONSchema7,
  type Tool,
} from "ai";
import { z } from "zod";
import { createMuxMessage } from "@/common/types/message";
import { sanitizeToolSchemaForOpenAI } from "@/common/utils/tools/schemaSanitizer";
import { DisposableTempDir } from "@/node/services/tempDir";
import {
  BLOBS_DIR_NAME,
  DURABLE_EVENTS_FILE_NAME,
  DurableEventJournal,
} from "@/node/utils/journal/durableEventJournal";
import {
  buildToolsetManifest,
  emitTurnEnvelope,
  hashToolSchema,
  providerToolFingerprint,
} from "./turnEnvelope";

const SHA256_HEX = /^[0-9a-f]{64}$/;

function makeTool<INPUT>(schema: FlexibleSchema<INPUT>): Tool {
  return tool({ description: "test tool", inputSchema: schema });
}

async function listBlobFiles(sessionDir: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(sessionDir, BLOBS_DIR_NAME), {
    recursive: true,
    withFileTypes: true,
  });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

describe("buildToolsetManifest", () => {
  test("sorts by tool name and hashes schemas insensitive to key order", () => {
    const manifest = buildToolsetManifest({
      zebra: makeTool(jsonSchema({ type: "object", properties: { a: {}, b: {} } })),
      alpha: makeTool(z.object({ value: z.string() })),
    });
    expect(manifest.map((entry) => entry.name)).toEqual(["alpha", "zebra"]);
    for (const entry of manifest) {
      expect(entry.schemaHash).toMatch(SHA256_HEX);
    }

    // Same logical JSON schema declared with reversed property insertion
    // order must fingerprint identically (stable stringify).
    const reordered = buildToolsetManifest({
      zebra: makeTool(jsonSchema({ properties: { b: {}, a: {} }, type: "object" })),
    });
    expect(reordered[0].schemaHash).toBe(manifest[1].schemaHash);

    // Different schema shape must fingerprint differently.
    const different = buildToolsetManifest({
      zebra: makeTool(jsonSchema({ type: "object", properties: { c: {} } })),
    });
    expect(different[0].schemaHash).not.toBe(manifest[1].schemaHash);
  });

  test("provider-defined tools fingerprint by wire identity, matching replay reconstruction", () => {
    // Runtime shape (AI SDK provider tool): type/id/args plus a client-side
    // inputSchema that never reaches the wire.
    const runtimeTool = {
      type: "provider",
      id: "anthropic.web_search_20250305",
      args: { maxUses: 1000 },
      inputSchema: z.object({ query: z.string() }),
    };
    const manifest = buildToolsetManifest({
      web_search: runtimeTool as unknown as Parameters<typeof buildToolsetManifest>[0][string],
    });

    // The contract: envelope hash == hash of the wire identity, so replay
    // (which only sees {type, id, args}) reproduces it exactly.
    expect(manifest[0].schemaHash).toBe(
      hashToolSchema(providerToolFingerprint("anthropic.web_search_20250305", { maxUses: 1000 }))
    );

    // args participate in the fingerprint: config changes are cache-relevant.
    const changedArgs = buildToolsetManifest({
      web_search: {
        ...runtimeTool,
        args: { maxUses: 5 },
      } as unknown as Parameters<typeof buildToolsetManifest>[0][string],
    });
    expect(changedArgs[0].schemaHash).not.toBe(manifest[0].schemaHash);
  });

  test("fingerprints legacy .parameters/.schema tool shapes and tolerates sparse entries", () => {
    // v3-style adapters declare schemas via `.parameters` or `.schema` instead
    // of `.inputSchema`. These shapes fall outside the AI SDK v5 `Tool` type,
    // so the double cast simulates the runtime object.
    const legacy = (key: "parameters" | "schema", schema: FlexibleSchema<unknown>): Tool =>
      ({ description: "legacy tool", [key]: schema }) as unknown as Tool;

    const manifest = buildToolsetManifest({
      a: legacy("parameters", z.object({ value: z.string() })),
      b: legacy("parameters", z.object({ other: z.number() })),
      c: legacy("schema", z.object({ other: z.number() })),
    });
    // Distinct legacy shapes must not collapse to one fingerprint.
    expect(manifest[0].schemaHash).not.toBe(manifest[1].schemaHash);
    // The same logical schema fingerprints identically regardless of which
    // property (`.inputSchema`, `.parameters`, `.schema`) declared it.
    expect(manifest[2].schemaHash).toBe(manifest[1].schemaHash);
    const modern = buildToolsetManifest({ a: makeTool(z.object({ value: z.string() })) });
    expect(modern[0].schemaHash).toBe(manifest[0].schemaHash);

    // A sparse map entry must not throw; it hashes as the empty schema.
    const sparse = buildToolsetManifest({ ghost: undefined } as unknown as Record<string, Tool>);
    expect(sparse).toHaveLength(1);
    expect(sparse[0].schemaHash).toMatch(SHA256_HEX);
  });

  test("fingerprints MCP dynamic tools and bare jsonSchema-wrapper objects", () => {
    const schema: JSONSchema7 = {
      type: "object",
      properties: { value: { type: "string" } },
      additionalProperties: false,
    };

    const manifest = buildToolsetManifest({
      // Real MCP shape: mcpClient.ts builds tools via dynamicTool + jsonSchema().
      mcp: dynamicTool({
        description: "mcp tool",
        inputSchema: jsonSchema(schema),
        execute: () => Promise.resolve("ok"),
      }),
      // Wrapper exposing only a jsonSchema payload, without the AI SDK schema
      // symbol — asSchema would call it as a function and throw.
      bare: { description: "bare wrapper", inputSchema: { jsonSchema: schema } } as unknown as Tool,
      reference: makeTool(jsonSchema(schema)),
    });

    expect(manifest.map((entry) => entry.name)).toEqual(["bare", "mcp", "reference"]);
    // The same logical schema fingerprints identically regardless of wrapper shape.
    expect(new Set(manifest.map((entry) => entry.schemaHash)).size).toBe(1);
    expect(manifest[0].schemaHash).toMatch(SHA256_HEX);
  });

  test("fingerprints plain JSON Schema objects on .parameters/.schema", () => {
    const schema: JSONSchema7 = {
      type: "object",
      properties: { value: { type: "string" } },
      additionalProperties: false,
    };

    const manifest = buildToolsetManifest({
      viaParameters: { description: "plain", parameters: schema } as unknown as Tool,
      viaSchema: { description: "plain", schema } as unknown as Tool,
      viaWrapper: makeTool(jsonSchema(schema)),
    });
    // A plain JSON Schema is already the model-visible schema, so it must
    // fingerprint identically to the same schema behind a jsonSchema() wrapper.
    expect(new Set(manifest.map((entry) => entry.schemaHash)).size).toBe(1);

    const different = buildToolsetManifest({
      viaParameters: {
        description: "plain",
        parameters: { type: "object", properties: { other: { type: "number" } } },
      } as unknown as Tool,
    });
    expect(different[0].schemaHash).not.toBe(manifest[0].schemaHash);
  });

  test("fingerprints OpenAI-sanitized tools by their sanitized (model-visible) schema", () => {
    // `minimum` is stripped by sanitizeToolSchemaForOpenAI; the fingerprint
    // must track the sanitized schema the provider actually receives.
    const unsanitized: JSONSchema7 = {
      type: "object",
      properties: { count: { type: "number", minimum: 1 } },
      additionalProperties: false,
    };
    const stripped: JSONSchema7 = {
      type: "object",
      properties: { count: { type: "number" } },
      additionalProperties: false,
    };

    const mcpTool = dynamicTool({
      description: "mcp tool",
      inputSchema: jsonSchema(unsanitized),
      execute: () => Promise.resolve("ok"),
    });
    const v3Tool = { description: "v3 tool", parameters: unsanitized } as unknown as Tool;

    const manifest = buildToolsetManifest({
      mcpSanitized: sanitizeToolSchemaForOpenAI(mcpTool),
      v3Sanitized: sanitizeToolSchemaForOpenAI(v3Tool),
      strippedReference: makeTool(jsonSchema(stripped)),
      original: mcpTool,
    });
    const byName = Object.fromEntries(manifest.map((entry) => [entry.name, entry.schemaHash]));
    expect(byName.mcpSanitized).toBe(byName.strippedReference);
    expect(byName.v3Sanitized).toBe(byName.strippedReference);
    expect(byName.original).not.toBe(byName.strippedReference);
  });
});

describe("emitTurnEnvelope", () => {
  test("append failure removes newly created blobs but preserves pre-existing ones (r55)", async () => {
    // Reclamation derives candidates from journal references, so a blob
    // whose envelope row never landed would leak forever — repeated append
    // failures with changing plans/attachments would grow the session blob
    // store without bound. Pre-existing blobs (content-addressed dedup) may
    // be referenced by earlier rows and must survive the cleanup.
    using tmp = new DisposableTempDir("turn-envelope-orphans");
    const journal = new DurableEventJournal(tmp.path);
    // Pre-existing blob with the exact system-prompt content: the failed
    // emit re-puts it (created=false) and must NOT delete it.
    await journal.blobs.put("You are a helpful agent.");
    const blobsBefore = await listBlobFiles(tmp.path);
    expect(blobsBefore).toHaveLength(1);

    const appendSpy = spyOn(journal, "append").mockImplementation(() =>
      Promise.reject(new Error("append down"))
    );
    try {
      // Never throws: envelope emission is observability, not control flow.
      await emitTurnEnvelope({
        journal,
        workspaceId: "ws-orphans",
        systemMessage: "You are a helpful agent.",
        tools: {},
        modelString: "anthropic:claude-test",
        thinkingLevel: "medium",
        providerOptions: {},
        // Unique content — its blob is CREATED by this emit and must be
        // removed when the append fails.
        planContentForTransition: "unique plan content that only this emit stores",
      });
    } finally {
      appendSpy.mockRestore();
    }

    // The created plan blob is gone; the pre-existing prompt blob survives.
    expect(await listBlobFiles(tmp.path)).toEqual(blobsBefore);
    expect(await journal.read()).toHaveLength(0);
  });

  test("emits one row per turn and dedupes identical prompts to one blob", async () => {
    using tmp = new DisposableTempDir("turn-envelope-test");
    const journal = new DurableEventJournal(tmp.path);
    const params = {
      journal,
      workspaceId: "ws-1",
      systemMessage: "You are a helpful agent.",
      tools: { alpha: makeTool(z.object({ value: z.string() })) },
      modelString: "anthropic:claude-test",
      thinkingLevel: "medium",
      providerOptions: { anthropic: { thinking: { type: "enabled" } } },
    };

    await emitTurnEnvelope(params);
    // A retry/continuation of the same request appends its own row.
    await emitTurnEnvelope(params);

    const events = await journal.read();
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.seq)).toEqual([0, 1]);
    expect(new Set(events.map((event) => event.id)).size).toBe(2);
    for (const event of events) {
      expect(event.kind).toBe("turn-envelope");
      if (event.kind !== "turn-envelope") continue;
      expect(event.workspaceId).toBe("ws-1");
      expect(event.data.modelString).toBe("anthropic:claude-test");
      expect(event.data.thinkingLevel).toBe("medium");
      expect(event.data.providerOptionsHash).toMatch(SHA256_HEX);
      expect(event.data.toolsetManifest).toEqual(buildToolsetManifest(params.tools));
      // The full prompt text round-trips through the blob store.
      expect(await journal.blobs.getText(event.data.systemPromptHash)).toBe(params.systemMessage);
    }

    // Identical prompts content-address to a single stored blob.
    expect(await listBlobFiles(tmp.path)).toHaveLength(1);
  });

  test("partial continuation round-trips through the envelope blob", async () => {
    using tmp = new DisposableTempDir("turn-envelope-test");
    const journal = new DurableEventJournal(tmp.path);
    // Refusal-fallback continuation: never persisted to chat.jsonl at the
    // request's sequence, so the envelope's blob is replay's only source.
    const continuation = createMuxMessage(
      "assistant-partial-1",
      "assistant",
      "partial output before refusal",
      { historySequence: 99 }
    );

    await emitTurnEnvelope({
      journal,
      workspaceId: "ws-1",
      systemMessage: "sys",
      tools: {},
      modelString: "anthropic:claude-test",
      thinkingLevel: "off",
      providerOptions: {},
      partialContinuationMessage: continuation,
    });

    const events = await journal.read();
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event?.kind !== "turn-envelope") throw new Error("expected turn-envelope");
    expect(event.data.partialContinuationHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const stored = await journal.blobs.getText(event.data.partialContinuationHash ?? "");
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored ?? "")).toEqual(continuation);
  });

  test("sentinelToolNames persist independently of the narrowed wire manifest", async () => {
    using tmp = new DisposableTempDir("turn-envelope-test");
    const journal = new DurableEventJournal(tmp.path);
    // Forced first-step scoping: the wire manifest carries only the forced
    // tool while the sentinel advertised the full active set.
    await emitTurnEnvelope({
      journal,
      workspaceId: "ws-1",
      systemMessage: "prompt",
      tools: { web_search: makeTool(z.object({ query: z.string() })) },
      modelString: "xai:grok-test",
      thinkingLevel: "off",
      providerOptions: {},
      sentinelToolNames: ["bash", "file_read", "web_search"],
    });

    const events = await journal.read();
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event.kind !== "turn-envelope") throw new Error("expected turn-envelope");
    expect(event.data.toolsetManifest.map((entry) => entry.name)).toEqual(["web_search"]);
    expect(event.data.sentinelToolNames).toEqual(["bash", "file_read", "web_search"]);
  });

  test("providerOptionsHash is stable across key order but tracks content", async () => {
    using tmp = new DisposableTempDir("turn-envelope-options-hash");
    const journal = new DurableEventJournal(tmp.path);
    const base = {
      journal,
      workspaceId: "ws-1",
      systemMessage: "prompt",
      tools: {},
      modelString: "openai:gpt-test",
      thinkingLevel: "off",
    };
    await emitTurnEnvelope({ ...base, providerOptions: { a: 1, b: { c: 2, d: 3 } } });
    await emitTurnEnvelope({ ...base, providerOptions: { b: { d: 3, c: 2 }, a: 1 } });
    await emitTurnEnvelope({ ...base, providerOptions: { a: 1, b: { c: 2, d: 4 } } });

    const hashes = (await journal.read()).map((event) =>
      event.kind === "turn-envelope" ? event.data.providerOptionsHash : ""
    );
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[0]);
  });

  test("degrades gracefully when the journal dir is unwritable", async () => {
    using tmp = new DisposableTempDir("turn-envelope-unwritable");
    // A regular file where the session dir should be makes every mkdir/append
    // inside it fail (ENOTDIR).
    const blockedSessionDir = path.join(tmp.path, "session");
    await fs.writeFile(blockedSessionDir, "not a directory", "utf-8");
    const journal = new DurableEventJournal(blockedSessionDir);

    // Must resolve (log-and-continue), never reject: envelope emission may not
    // fail the turn.
    await emitTurnEnvelope({
      journal,
      workspaceId: "ws-1",
      systemMessage: "prompt",
      tools: {},
      modelString: "openai:gpt-test",
      thinkingLevel: "off",
      providerOptions: {},
    });

    const journalFileExists = await fs
      .access(path.join(blockedSessionDir, DURABLE_EVENTS_FILE_NAME))
      .then(
        () => true,
        () => false
      );
    expect(journalFileExists).toBe(false);
  });
});
