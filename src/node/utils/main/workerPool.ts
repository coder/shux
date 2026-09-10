import { Worker } from "node:worker_threads";
import { join, dirname, sep, extname } from "node:path";
import { log } from "@/node/services/log";

interface WorkerRequest {
  messageId: number;
  taskName: string;
  data: unknown;
}

interface WorkerSuccessResponse {
  messageId: number;
  result: unknown;
}

interface WorkerErrorResponse {
  messageId: number;
  error: {
    message: string;
    stack?: string;
  };
}

type WorkerResponse = WorkerSuccessResponse | WorkerErrorResponse;

let messageIdCounter = 0;
const pendingPromises = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

// Track if worker is alive - reject immediately if dead
let workerError: Error | null = null;

// Resolve worker path
// In production: both workerPool.js and tokenizer.worker.js are in dist/utils/main/
// During tests: workerPool.ts is in src/utils/main/ but worker is in dist/utils/main/
const currentDir = dirname(__filename);
const pathParts = currentDir.split(sep);
const hasDist = pathParts.includes("dist");
const srcIndex = pathParts.lastIndexOf("src");

let workerDir: string;
let workerFile = "tokenizer.worker.js";

// Check if we're running under Bun (not Node with ts-jest)
// ts-jest transpiles .ts files but runs them via Node, which can't load .ts workers
// eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
const isBun = !!(process as unknown as { isBun?: boolean }).isBun;

if (isBun && extname(__filename) === ".ts") {
  // Running from source via Bun - use .ts worker directly
  workerDir = currentDir;
  workerFile = "tokenizer.worker.ts";
} else if (srcIndex !== -1 && !hasDist) {
  // Replace 'src' with 'dist' in the path (only if not already in dist)
  pathParts[srcIndex] = "dist";
  workerDir = pathParts.join(sep);
} else {
  workerDir = currentDir;
}

const workerPath = join(workerDir, workerFile);
const worker = new Worker(workerPath);

// Handle messages from worker
worker.on("message", (response: WorkerResponse) => {
  const pending = pendingPromises.get(response.messageId);
  if (!pending) {
    log.error(`No pending promise for messageId ${response.messageId}`);
    return;
  }

  pendingPromises.delete(response.messageId);

  if ("error" in response) {
    const error = new Error(response.error.message);
    error.stack = response.error.stack;
    pending.reject(error);
  } else {
    pending.resolve(response.result);
  }
});

// Handle worker errors
worker.on("error", (error: Error) => {
  log.error("Worker error:", error);
  workerError = error;
  // Reject all pending promises
  for (const pending of pendingPromises.values()) {
    pending.reject(error);
  }
  pendingPromises.clear();
});

// Handle worker exit
worker.on("exit", (code) => {
  if (code !== 0) {
    log.error(`Worker stopped with exit code ${code}`);
    const error = new Error(`Worker stopped with exit code ${code}`);
    workerError = error;
    for (const pending of pendingPromises.values()) {
      pending.reject(error);
    }
    pendingPromises.clear();
  }
});

// Don't block process exit
worker.unref();

/**
 * Run a task on the worker thread
 * @param taskName The name of the task to run (e.g., "countTokens", "encodingName")
 * @param data The data to pass to the task
 * @returns A promise that resolves with the task result
 */
export function run<T>(taskName: string, data: unknown): Promise<T> {
  // If worker already died (e.g., failed to load), reject immediately
  // This prevents hanging promises when the worker is not available
  if (workerError) {
    return Promise.reject(workerError);
  }

  const messageId = messageIdCounter++;
  const request: WorkerRequest = { messageId, taskName, data };

  return new Promise<T>((resolve, reject) => {
    pendingPromises.set(messageId, {
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    worker.postMessage(request);
  });
}
