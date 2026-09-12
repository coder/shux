import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { isReadableHistoryMessage } from "./historyScanner";
import { normalizeLegacyMuxMetadata } from "@/node/utils/messages/legacy";
import { scanHistoryRows } from "./historyRowScanner";
import { createHistoryMessageEvidence } from "./historyMessageEvidence";

const date = "2026-09-11T12:00:00Z";
const run = () => ({
  id: "wfr_test",
  workspaceId: "workspace",
  source: "source",
  sourceHash: "hash",
  workflow: { name: "test-flow", description: "Description", scope: "project", executable: true },
  args: { input: [null, true, "value", 1] },
  status: "running",
  createdAt: date,
  updatedAt: date,
  events: [{ sequence: 1, type: "status", at: date, status: "running" }],
  steps: [],
});
const message = (parts: unknown = [{ type: "text", text: "hello" }]) => ({
  id: "message",
  role: "user",
  parts,
  metadata: { historySequence: 3, compactionReplacementNonce: "nonce" },
});
const tool = (record: unknown = run()) => ({
  type: "dynamic-tool",
  toolCallId: "call",
  toolName: "workflow_run",
  state: "output-available",
  input: {},
  output: {},
  workflowRun: { runId: "wfr_test", timestamp: 1, run: record },
});
function native(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
function readable(value: unknown) {
  try {
    return isReadableHistoryMessage(value);
  } catch {
    return false;
  }
}

describe("streamed history message evidence", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "history-message-evidence-"));
  });
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function inspect(
    rows: Array<string | Buffer>,
    targets = { id: "message", nonce: "nonce" }
  ) {
    const file = path.join(directory, "chat.jsonl");
    const content = Buffer.concat(rows.flatMap((row) => [Buffer.from(row), Buffer.from("\n")]));
    await fs.writeFile(file, content);
    const results: Array<ReturnType<ReturnType<typeof createHistoryMessageEvidence>["finish"]>> =
      [];
    await scanHistoryRows(
      file,
      () => {
        const evidence = createHistoryMessageEvidence(content.length, targets);
        return {
          token: evidence.token.bind(evidence),
          finish(row) {
            results.push(evidence.finish(row));
          },
        };
      },
      { decoding: "replacement" }
    );
    return results;
  }
  async function differential(rows: string[]) {
    const results = await inspect(rows);
    expect(results).toHaveLength(rows.length);
    for (const [index, text] of rows.entries()) {
      const parsed = native(text);
      const result = results[index];
      expect(result.readable, `row ${index}: ${text}`).toBe(readable(parsed));
      if (readable(parsed) && isReadableHistoryMessage(parsed)) {
        expect(result.id?.length).toBe(parsed.id.length);
        expect(result.id?.sha256).toBe(
          createHash("sha256").update(Buffer.from(parsed.id, "utf16le")).digest("hex")
        );
        expect(result.id?.matchesExpected).toBe(parsed.id === "message");
        expect(result.sequence).toEqual(parsed.metadata?.historySequence);
        expect(result.matchesNonce).toBe(
          !!parsed.metadata &&
            "compactionReplacementNonce" in parsed.metadata &&
            parsed.metadata.compactionReplacementNonce === "nonce"
        );
        expect(result.systemRole).toBe(String(parsed.role) === "system");
        expect(result.normalizationChanged, text).toBe(
          JSON.stringify(normalizeLegacyMuxMetadata(parsed)) !== JSON.stringify(parsed)
        );
      }
    }
  }

  it("matches native basic parts, legacy roles, metadata permissiveness, and malformed rows", async () => {
    const values: unknown[] = [
      message(),
      message([]),
      message([{ type: "reasoning", text: "why", signature: "kept" }]),
      message([{ type: "file", url: "data:test", mediaType: "x", filename: "name" }]),
      message([tool()]),
      message([{ type: "text" }]),
      message([null]),
      message({}),
      ...[
        "user",
        "assistant",
        "system",
        ["user"],
        [["system"]],
        [null],
        ["", "user"],
        {},
        null,
        1,
      ].map((role) => ({ ...message(), role })),
      ...[
        {},
        [],
        null,
        false,
        { createdAt: "bad", compactionPublicationGeneration: {} },
        { cmuxMetadata: {} },
        { compacted: true, idleCompacted: true },
        { compacted: false, idleCompacted: true },
      ].map((metadata) => ({ ...message(), metadata })),
      { ...message(), createdAt: { arbitrary: true } },
    ];
    await differential([
      ...values.map((value) => JSON.stringify(value)),
      '{"id":"m",',
      JSON.stringify(message()) + "oops",
      "{}",
      "[]",
      "null",
    ]);
  });

  it("retains JSON.parse last-wins behavior without accepting invalid parts or duplicate event sequences", async () => {
    const valid = JSON.stringify(message());
    const workflow = JSON.stringify(message([tool()]));
    await differential([
      valid.replace('"parts":', '"parts":[{"type":"bogus"}],"parts":'),
      valid.replace('"parts":', '"parts":[{"type":"text","text":1}],"parts":'),
      valid.replace('"id":"message"', '"id":null,"id":"message"'),
      valid.replace('"role":"user"', '"role":false,"role":"user"'),
      valid.replace('"metadata":', '"metadata":null,"metadata":'),
      valid.replace('"text":"hello"', '"text":false,"text":"hello"'),
      valid.replace('"text":"hello"', '"text":"hello","text":false'),
      workflow.replace('"args":', '"args":1e999,"args":'),
      workflow.replace('"args":{"input":[null,true,"value",1]}', '"args":{"key":1e999,"key":1}'),
      workflow.replace('"args":{"input":[null,true,"value",1]}', '"args":{"key":1,"key":1e999}'),
      JSON.stringify(message([tool({ ...run(), events: [run().events[0], run().events[0]] })])),
      workflow.replace('"events":', '"events":[{"bad":true}],"events":'),
    ]);
  });

  it("validates actual workflow variants, strict fields, and unbounded JSON values", async () => {
    const events = [
      { type: "phase", name: "phase", details: [1] },
      { type: "log", message: "log", data: {} },
      { type: "agent-step", stepId: "s", inputHash: "h", status: "reserved" },
      { type: "task", stepId: "s", taskId: "t", status: "running" },
      { type: "timeout", stepId: "s", taskId: "t", phase: "soft" },
      { type: "workflow", stepId: "s", runId: "wfr_child", name: "child", status: "started" },
      { type: "patch", stepId: "s", sourceTaskId: "t", status: "applied" },
      { type: "action", stepId: "s", name: "action", status: "cached", effect: "read" },
      { type: "validation", stepId: "s", success: true },
      { type: "result", result: { reportMarkdown: "result", structuredOutput: { a: [1, null] } } },
      { type: "error", message: "failed" },
    ].map((event, index) => ({ ...event, sequence: index + 1, at: date }));
    const rich = {
      ...run(),
      events,
      parentWorkflow: { runId: "wfr_parent", stepId: "s", inputHash: "h", depth: 1 },
      workflow: {
        ...run().workflow,
        scope: "scratch",
        phaseManifest: { provenance: "declared", phases: [{ name: "phase", parallel: true }] },
      },
      steps: [
        {
          stepId: "s",
          inputHash: "h",
          status: "completed",
          startedAt: date,
          completedAt: date,
          timeout: { softDeadlineAt: date, finalizationToken: "token" },
          result: { reportMarkdown: "done", title: null, structuredOutput: [1] },
        },
      ],
    };
    const good = JSON.stringify(message([tool(rich)]));
    await differential([
      good,
      good.replace('"depth":1', '"depth":-1'),
      good.replace('"depth":1', '"depth":1,"extra":true'),
      good.replace('"depth":1', '"depth":1,"__proto__":true'),
      good.replace('"parallel":true', '"parallel":true,"extra":null'),
      good.replace('"provenance":"declared"', '"provenance":"declared","extra":true'),
      good.replace('"finalizationToken":"token"', '"finalizationToken":"token","extra":1'),
      good.replace('"args":{"input":[null,true,"value",1]}', '"args":[{"value":1e999}]'),
      good.replace('"input":{}', '"input":{"value":1e999}'),
      good.replace('"output":{}', '"output":[1e999]'),
      good.replace('"args":{"input":[null,true,"value",1]}', '"args":{"__proto__":1e999}'),
      good.replace('"executable":true', '"executable":false'),
      good.replace('"executable":true', '"executable":false,"blockedReason":"blocked"'),
      good.replace('"sequence":2', '"sequence":1'),
      good.replace('"at":"' + date + '"', '"at":"' + date + '","data":1e999'),
    ]);
  });

  it("preserves full date validity across arbitrary fractional precision", async () => {
    const dates = [
      date,
      "2024-02-29T23:59:59+02:30",
      "2025-02-29T00:00:00Z",
      "2026-09-11T12:00Z",
      "2026-09-11T12:00:00." + "1".repeat(10000) + "Z",
      "2026-09-11T12:00:00." + "0".repeat(10000) + "+01:00",
      "2026-09-11T12:00:00." + "0".repeat(5000) + "x" + "0".repeat(5000) + "Z",
      "2026-09-11T12:00:00.Z",
      "2026-09-11T12:00:00Z" + "x".repeat(2000),
    ];
    await differential(
      dates.map((createdAt) => JSON.stringify(message([tool({ ...run(), createdAt })])))
    );
  });

  it("keeps giant ordinary strings, tool payloads, keys and identifiers readable with bounded prefixes", async () => {
    const huge = "x".repeat(2 * 1024 * 1024);
    const row = JSON.stringify({
      ...message([
        { type: "text", text: huge },
        { ...tool(), input: { [huge]: huge } },
      ]),
      id: huge,
      metadata: { historySequence: 9007199254740991, compactionReplacementNonce: huge },
    });
    const [result] = await inspect([row], { id: huge, nonce: huge });
    expect(result.readable).toBe(true);
    expect(result.id?.matchesExpected).toBe(true);
    expect(result.matchesNonce).toBe(true);
    expect(result.id?.length).toBe(huge.length);
    expect(result.id!.prefix.length).toBeLessThan(2048);
    await differential([
      JSON.stringify(
        message([tool({ ...run(), workflow: { ...run().workflow, description: huge } })])
      ),
    ]);
  });

  it("matches schema field mutations without retaining whole workflow records", async () => {
    const rich = {
      ...run(),
      parentWorkflow: { runId: "wfr_parent", stepId: "s", inputHash: "h", depth: 1 },
      workflow: {
        ...run().workflow,
        phaseManifest: { provenance: "declared", phases: [{ name: "phase" }] },
      },
      steps: [
        {
          stepId: "s",
          inputHash: "h",
          status: "completed",
          startedAt: date,
          result: { reportMarkdown: "done" },
          timeout: { softDeadlineAt: date },
        },
      ],
    };
    const base = message([tool(rich)]);
    const paths: Array<Array<string | number>> = [
      [],
      ["parts", 0],
      ["parts", 0, "workflowRun"],
      ["parts", 0, "workflowRun", "run"],
      ["parts", 0, "workflowRun", "run", "workflow"],
      ["parts", 0, "workflowRun", "run", "workflow", "phaseManifest"],
      ["parts", 0, "workflowRun", "run", "workflow", "phaseManifest", "phases", 0],
      ["parts", 0, "workflowRun", "run", "parentWorkflow"],
      ["parts", 0, "workflowRun", "run", "steps", 0],
      ["parts", 0, "workflowRun", "run", "steps", 0, "timeout"],
      ["parts", 0, "workflowRun", "run", "steps", 0, "result"],
      ["parts", 0, "workflowRun", "run", "events", 0],
    ];
    function at(value: unknown, keys: Array<string | number>): Record<string, unknown> {
      for (const key of keys) value = (value as Record<string, unknown>)[key];
      return value as Record<string, unknown>;
    }
    const rows: string[] = [];
    for (const keys of paths) {
      for (const field of [...Object.keys(at(base, keys)), "unknownField"]) {
        for (const replacement of [
          undefined,
          null,
          true,
          false,
          0,
          -1,
          1.5,
          "",
          "x",
          [],
          {},
          [null],
          "x".repeat(1025),
        ]) {
          const candidate: unknown = structuredClone(base);
          at(candidate, keys)[field] = replacement;
          rows.push(JSON.stringify(candidate));
        }
      }
    }
    await differential(rows);
  });

  it("validates every reduced array element and bounded workflow phase counts", async () => {
    const parts = Array.from({ length: 20000 }, () => ({ type: "text", text: "part" }));
    const phases = Array.from({ length: 64 }, () => ({ name: "phase" }));
    const records = [0, 1, 64, 65].map((count) => ({
      ...run(),
      workflow: {
        ...run().workflow,
        phaseManifest: {
          provenance: "declared",
          phases: [...phases, { name: "extra" }].slice(0, count),
        },
      },
    }));
    await differential([
      JSON.stringify(message(parts)),
      JSON.stringify(message([...parts, { type: "text", text: false }])),
      ...records.map((record) => JSON.stringify(message([tool(record)]))),
      JSON.stringify(
        message([
          {
            ...tool(),
            nestedCalls: [{ toolCallId: "n", toolName: "n", state: "input-available" }],
          },
        ])
      ),
      JSON.stringify(
        message([
          {
            ...tool(),
            nestedCalls: [
              {
                toolCallId: "n",
                toolName: "n",
                state: "input-available",
                workflowRun: { runId: "bad", timestamp: 0 },
              },
            ],
          },
        ])
      ),
    ]);
  });

  it("keeps native scalar rounding, escaped identities and complete syntax separate", async () => {
    const row = JSON.stringify(message());
    await differential([
      row.replace('"historySequence":3', '"historySequence":3.0000000000000001'),
      row.replace('"historySequence":3', '"historySequence":-0'),
      row.replace('"historySequence":3', '"historySequence":1e999'),
      row.replace(
        '"historySequence":3',
        '"historySequence":10000000000000000000000000000000001e-34'
      ),
      row.replace('"id":"message"', '"id":"m\\u0065ssage"'),
      row.replace('"id":"message"', '"id":"\\ud800"'),
      row.replace('"id":"message"', '"id":"\\ud801"'),
      row.replace('"text":"hello"', '"text":"\\ud83d\\ude00"'),
      row.replace('"role":"user"', '"role":[{"toString":null}]'),
      row.replace('"role":"user"', '"role":[[["user"]]]'),
    ]);
    const [exact, mismatch] = await inspect([row, row], { id: "message!", nonce: "nonce!" });
    expect(exact.id?.matchesExpected).toBe(false);
    expect(mismatch.matchesNonce).toBe(false);
  });

  it("retains replacement-decoded collision identity while malformed syntax remains unreadable", async () => {
    const raw = Buffer.from(JSON.stringify(message()));
    const invalid = Buffer.concat([raw.subarray(0, 7), Buffer.from([0xff]), raw.subarray(7)]);
    const [result] = await inspect([invalid]);
    expect(result.readable).toBe(readable(native(invalid.toString("utf8"))));
    expect(result.id?.matchesExpected).toBe(false);
  });
});
