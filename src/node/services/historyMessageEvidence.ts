import { MuxMessageSchema, NestedToolCallSchema } from "@/common/orpc/schemas/message";
import {
  WorkflowRunEventSchema,
  WorkflowStepRecordSchema,
  WorkflowDeclaredPhaseSchema,
  WorkflowScriptDescriptorSchema,
  WORKFLOW_DECLARED_PHASES_MAX,
} from "@/common/orpc/schemas/workflow";
import { isReadableHistoryMessage } from "./historyScanner";
import type { HistoryRowDescriptor, HistoryRowToken } from "./historyRowScanner";
import { createHistoryStringEvidence, createHistoryNumberEvidence } from "./historyScalarEvidence";

const INVALID = Symbol("invalid history projection");
const STRING_PREFIX = WorkflowScriptDescriptorSchema.shape.description.maxLength! + 1;
type StringFacts = ReturnType<ReturnType<typeof createHistoryStringEvidence>["finish"]>;
interface Value {
  value: unknown;
  string?: StringFacts;
  fields?: Map<string, Value>;
}
type Context =
  | "message"
  | "metadata"
  | "part"
  | "call"
  | "attachment"
  | "run"
  | "workflow"
  | "parent"
  | "manifest"
  | "phase"
  | "step"
  | "timeout"
  | "event"
  | "result"
  | "json"
  | "ignore"
  | "date"
  | "role"
  | "parts"
  | "calls"
  | "events"
  | "steps"
  | "phases";
function grammar(
  scalars: string,
  children: Record<string, Context> = {}
): Readonly<Record<string, Context>> {
  return {
    ...Object.fromEntries<Context>(scalars.split(" ").map((key) => [key, "ignore"])),
    ...children,
  };
}
// Explicit history grammar, not a Zod interpreter. Validation remains with the actual schemas.
const fields = {
  message: grammar("id", { role: "role", parts: "parts", metadata: "metadata" }),
  metadata: grammar(
    "historySequence compactionReplacementNonce cmuxMetadata compacted idleCompacted"
  ),
  part: grammar(
    "type text timestamp toolCallId toolName input output state failed executionStartedAt url mediaType filename",
    { nestedCalls: "calls", workflowRun: "attachment" }
  ),
  call: grammar("toolCallId toolName input output state failed timestamp", {
    workflowRun: "attachment",
  }),
  attachment: grammar("runId timestamp", { run: "run" }),
  run: grammar(
    "id workspaceId source sourceHash agentOutputSchemaRequired agentTypeAliasAllowed attentionPolicy status",
    {
      workflow: "workflow",
      args: "json",
      parentWorkflow: "parent",
      createdAt: "date",
      updatedAt: "date",
      events: "events",
      steps: "steps",
    }
  ),
  workflow: grammar(
    "name description scope sourcePath requestedScriptPath canonicalScriptPath sourceKind sourceHash executable blockedReason",
    { phaseManifest: "manifest" }
  ),
  parent: grammar("runId stepId inputHash depth"),
  manifest: grammar("provenance", { phases: "phases" }),
  phase: grammar("name label description parallel"),
  step: grammar("stepId inputHash status taskId error", {
    startedAt: "date",
    completedAt: "date",
    result: "result",
    timeout: "timeout",
  }),
  timeout: grammar("finalizationToken", {
    executionStartedAt: "date",
    softDeadlineAt: "date",
    hardDeadlineAt: "date",
    softTimedOutAt: "date",
    finalizationPromptSentAt: "date",
    hardTimedOutAt: "date",
  }),
  event: grammar(
    "sequence type status name message stepId inputHash title taskId phase runId sourceTaskId effect sourcePath sourceHash success",
    { at: "date", details: "json", data: "json", result: "result" }
  ),
  result: grammar("reportMarkdown title planFilePath taskId", { structuredOutput: "json" }),
};
const arrays = {
  parts: { context: "part", schema: MuxMessageSchema.shape.parts.element },
  calls: { context: "call", schema: NestedToolCallSchema },
  events: { context: "event", schema: WorkflowRunEventSchema },
  steps: { context: "step", schema: WorkflowStepRecordSchema },
  phases: { context: "phase", schema: WorkflowDeclaredPhaseSchema },
} as const;
const strict = new Set<Context>(["parent", "manifest", "phase", "timeout"]);
interface Frame {
  context: Context;
  array: boolean;
  fields: Map<string, Value>;
  key?: StringFacts;
  valid: boolean;
  count: number;
  sequence: number;
  sample?: unknown;
  roleText?: string;
}
/**
 * Stream only the finite message/workflow shape needed by the existing reader. Large strings and
 * array elements are reduced after their schema checks; JSON objects retain last-key validity.
 * Memory is bounded per scalar and grows only with nesting and distinct JSON-object keys.
 * Returned identity is provisional collision evidence, never durable replacement authority.
 */
export function createHistoryMessageEvidence(
  sourceBytes: number,
  targets: { id?: string; nonce?: string } = {}
) {
  targets = { ...targets };
  const frames: Frame[] = [];
  let root: Value | undefined;
  let string: ReturnType<typeof createHistoryStringEvidence> | undefined;
  let number: ReturnType<typeof createHistoryNumberEvidence> | undefined;
  let isKey = false;
  let date: string | undefined;
  let datePosition = 0;
  let fraction = false;
  let suffix = false;
  const nextContext = (): Context => {
    const frame = frames.at(-1);
    if (!frame) return "message";
    if (frame.context === "json" || frame.context === "role") return frame.context;
    if (frame.array) return arrays[frame.context as keyof typeof arrays]?.context ?? "ignore";
    const shape = fields[frame.context as keyof typeof fields] as
      | Readonly<Record<string, Context>>
      | undefined;
    return shape?.[frame.key?.prefix ?? ""] ?? "ignore";
  };
  const deliver = (item: Value) => {
    const frame = frames.at(-1);
    if (!frame) {
      root = item;
      return;
    }
    if (frame.array) {
      frame.count++;
      if (frame.context === "role")
        frame.roleText = (
          (frame.roleText ?? "") +
          (frame.count > 1 ? "," : "") +
          // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Match the legacy reader's intentional String(role) coercion.
          (item.value == null ? "" : String(item.value))
        ).slice(0, STRING_PREFIX);
      if (frame.context === "json") frame.valid &&= item.value !== INVALID;
      const schema = arrays[frame.context as keyof typeof arrays]?.schema;
      if (schema) frame.valid &&= schema.safeParse(item.value).success;
      if (frame.context === "events") {
        const sequence = item.fields?.get("sequence")?.value;
        frame.valid &&= typeof sequence === "number" && sequence > frame.sequence;
        if (typeof sequence === "number") frame.sequence = sequence;
      }
      if (frame.context === "phases" && frame.count === 1) frame.sample = item.value;
    } else if (frame.context === "json") {
      // JSON.parse keeps the last occurrence, including an invalid value overwritten later.
      // z.record deliberately ignores this key, including its value's validation.
      if (frame.key!.prefix !== "__proto__")
        frame.fields.set(frame.key!.sha256, { value: item.value !== INVALID });
    } else {
      const shape = fields[frame.context as keyof typeof fields];
      const key = frame.key!.prefix;
      if (shape && Object.hasOwn(shape, key) && key.length === frame.key!.length)
        frame.fields.set(key, item);
      else if (strict.has(frame.context) && key !== "__proto__")
        frame.fields.set("", { value: null });
    }
  };
  return {
    token(token: HistoryRowToken) {
      switch (token.name) {
        case "startObject":
        case "startArray":
          frames.push({
            context: nextContext(),
            array: token.name === "startArray",
            fields: new Map(),
            valid: true,
            count: 0,
            sequence: 0,
          });
          break;
        case "endObject":
        case "endArray": {
          const frame = frames.pop()!;
          let value: unknown;
          if (frame.array) {
            if (frame.context === "phases")
              frame.valid &&= frame.count <= WORKFLOW_DECLARED_PHASES_MAX;
            value = frame.valid
              ? frame.context === "phases" && frame.count
                ? [frame.sample]
                : []
              : INVALID;
          } else if (frame.context === "json") {
            value = [...frame.fields.values()].every((item) => item.value) ? {} : INVALID;
          } else
            value = Object.fromEntries([...frame.fields].map(([key, item]) => [key, item.value]));
          // The legacy reader uses String(role); preserve its array-coercion compatibility.
          if (frame.array && frame.context === "role") value = [frame.roleText ?? ""];
          deliver({ value, fields: frame.fields });
          break;
        }
        case "startKey":
        case "startString": {
          isKey = token.name === "startKey";
          const parent = frames.at(-1);
          const expected =
            !isKey && parent?.context === "message" && parent.key?.prefix === "id"
              ? targets.id
              : !isKey &&
                  parent?.context === "metadata" &&
                  parent.key?.prefix === "compactionReplacementNonce"
                ? targets.nonce
                : undefined;
          string = createHistoryStringEvidence(STRING_PREFIX, expected);
          date = !isKey && nextContext() === "date" ? "" : undefined;
          datePosition = 0;
          fraction = false;
          suffix = false;
          break;
        }
        case "stringChunk":
          string!.push(token.value);
          if (date !== undefined)
            for (const character of token.value) {
              // The schema permits arbitrary fractional precision, but no other unbounded date run.
              if (datePosition++ < 20) {
                date += character;
                fraction = datePosition === 20 && character === ".";
              } else if (fraction && !suffix && /^[0-9]$/.test(character)) {
                if (date.length === 20) date += "0";
              } else {
                suffix = true;
                if (date.length < STRING_PREFIX) date += character;
              }
            }
          break;
        case "endKey":
        case "endString": {
          const facts = string!.finish();
          if (isKey) frames.at(-1)!.key = facts;
          else deliver({ value: date ?? facts.prefix, string: facts });
          string = undefined;
          break;
        }
        case "startNumber":
          number = createHistoryNumberEvidence(sourceBytes);
          break;
        case "numberChunk":
          number!.push(token.value);
          break;
        case "endNumber": {
          const value = number!.finish().value;
          deliver({ value: nextContext() === "json" && !Number.isFinite(value) ? INVALID : value });
          number = undefined;
          break;
        }
        case "trueValue":
        case "falseValue":
        case "nullValue":
          deliver({ value: token.value });
          break;
        case "whitespace":
          break;
        default:
          throw new Error("Replacement projection requires unpacked tokens");
      }
    },
    finish(row: HistoryRowDescriptor) {
      const metadata = root?.fields?.get("metadata")?.fields;
      const readable = row.decodedJsonComplete && isReadableHistoryMessage(root?.value);
      return {
        readable,
        id: root?.fields?.get("id")?.string,
        sequence: metadata?.get("historySequence")?.value,
        matchesNonce: metadata?.get("compactionReplacementNonce")?.string?.matchesExpected ?? false,
        // Match the readable-history role coercion; malformed objects must not be coerced.
        systemRole: readable && String(root?.fields?.get("role")?.value) === "system",
        normalizationChanged:
          !!metadata?.has("cmuxMetadata") || metadata?.get("idleCompacted")?.value === true,
      };
    },
  };
}
