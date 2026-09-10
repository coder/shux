import assert from "node:assert";
import { parentPort } from "node:worker_threads";
import { Tokenizer, models } from "ai-tokenizer";
import type { ModelName } from "ai-tokenizer";
import * as encoding from "ai-tokenizer/encoding";
import { getErrorMessage } from "@/common/utils/errors";

export interface CountTokensInput {
  modelName: ModelName;
  input: string;
}

const tokenizerCache = new Map<ModelName, Tokenizer>();

function getTokenizer(modelName: ModelName): Tokenizer {
  const cached = tokenizerCache.get(modelName);
  if (cached) {
    return cached;
  }

  const model = models[modelName];
  assert(model, `Unknown tokenizer model '${modelName}'`);

  const encodingModule = encoding[model.encoding];
  assert(encodingModule, `Unknown tokenizer encoding '${model.encoding}'`);

  const tokenizer = new Tokenizer(encodingModule);
  tokenizerCache.set(modelName, tokenizer);
  return tokenizer;
}

export function countTokens({ modelName, input }: CountTokensInput): number {
  const tokenizer = getTokenizer(modelName);
  // Token counting is measurement, not a safety boundary: ordinary user/repo
  // text can legitimately contain special-token strings like "<|endoftext|>"
  // (e.g. GPT-2/BPE tasks), and count() -> encode() throws on them by
  // default, which fatally breaks counting for the whole message. Empty
  // allowed + disallowed sets disable the rejection without interpreting the
  // spelling as one reserved token: the literal characters tokenize as
  // ordinary text, keeping counts faithful to what providers see.
  return tokenizer.encode(input, [], []).length;
}

export function encodingName(modelName: ModelName): string {
  const model = models[modelName];
  assert(model, `Unknown tokenizer model '${modelName}'`);
  return model.encoding;
}

// Handle messages from main thread
if (parentPort) {
  parentPort.on("message", (message: { messageId: number; taskName: string; data: unknown }) => {
    try {
      let result: unknown;

      switch (message.taskName) {
        case "countTokens":
          result = countTokens(message.data as CountTokensInput);
          break;
        case "encodingName":
          result = encodingName(message.data as ModelName);
          break;
        default:
          throw new Error(`Unknown task: ${message.taskName}`);
      }

      parentPort!.postMessage({
        messageId: message.messageId,
        result,
      });
    } catch (error) {
      parentPort!.postMessage({
        messageId: message.messageId,
        error: {
          message: getErrorMessage(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      });
    }
  });
}
