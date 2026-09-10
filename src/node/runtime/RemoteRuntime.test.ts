import { describe, expect, it } from "bun:test";
import type { ExecOptions, ExecStream } from "./Runtime";
import type { SpawnResult } from "./RemoteRuntime";
import { TestRemoteRuntime } from "./testRemoteRuntime";

class RecordingRemoteRuntime extends TestRemoteRuntime {
  spawnCount = 0;

  protected override spawnRemoteProcess(): Promise<SpawnResult> {
    this.spawnCount += 1;
    throw new Error("spawn should not be called");
  }
}

function createStream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

class CanonicalPathRemoteRuntime extends RecordingRemoteRuntime {
  commands: string[] = [];

  override resolvePath(filePath: string): Promise<string> {
    if (filePath === "~") return Promise.resolve("/home/test");
    if (filePath.startsWith("~/")) return Promise.resolve(`/home/test/${filePath.slice(2)}`);
    return Promise.resolve(filePath);
  }

  override exec(command: string, _options: ExecOptions): Promise<ExecStream> {
    this.commands.push(command);
    return Promise.resolve({
      stdout: createStream(command.startsWith("stat ") ? "1 2 regular file\n" : "contents"),
      stderr: createStream(""),
      stdin: new WritableStream<Uint8Array>(),
      exitCode: Promise.resolve(0),
      duration: Promise.resolve(0),
    });
  }
}

/**
 * Fake exec: records the abortSignal readFile passes and returns a wedged
 * cat whose stdout never yields — exactly the stalled remote read the r18
 * cancellation fix must be able to kill.
 */
class ReadFileRemoteRuntime extends RecordingRemoteRuntime {
  capturedSignal: AbortSignal | undefined;

  override exec(_command: string, options: ExecOptions): Promise<ExecStream> {
    this.capturedSignal = options.abortSignal;
    return Promise.resolve({
      stdout: new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
      }),
      stderr: new ReadableStream<Uint8Array>({
        start: (controller) => controller.close(),
      }),
      stdin: new WritableStream<Uint8Array>(),
      // Wedged process: never exits on its own.
      exitCode: new Promise<number>(() => undefined),
      duration: new Promise<number>(() => undefined),
    });
  }
}

describe("RemoteRuntime file path canonicalization", () => {
  it("resolves relative and tilde paths inside file operations", async () => {
    const runtime = new CanonicalPathRemoteRuntime();

    const reader = runtime.readFile("nested/../read.txt").getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    const writer = runtime.writeFile("~/write.txt").getWriter();
    await writer.close();
    await runtime.stat("nested/../stat.txt");
    await runtime.ensureDir("~/dir");

    expect(runtime.commands).toContain("cat '/workspace/read.txt'");
    expect(runtime.commands.some((command) => command.includes("'/home/test/write.txt'"))).toBe(
      true
    );
    expect(runtime.commands).toContain("stat -L -c '%s %Y %F' '/workspace/stat.txt'");
    expect(runtime.commands).toContain("mkdir -p '/home/test/dir'");
  });
});

describe("RemoteRuntime.readFile", () => {
  it("cancelling the stream aborts the underlying cat exec", async () => {
    // r18: without cancel forwarding, a cancelled reader (e.g. mux.load's
    // byte ceiling) left the remote cat blocked until its 300s timeout,
    // accumulating remote processes across repeated caught failures.
    const runtime = new ReadFileRemoteRuntime();
    const reader = runtime.readFile("/workspace/huge.bin").getReader();
    // Let start() run: exec is invoked and captures its signal.
    await Bun.sleep(0);
    expect(runtime.capturedSignal).toBeDefined();
    expect(runtime.capturedSignal?.aborted).toBe(false);

    await reader.cancel();
    expect(runtime.capturedSignal?.aborted).toBe(true);
  });

  it("a caller abort forwards into the cat exec", async () => {
    const runtime = new ReadFileRemoteRuntime();
    const abort = new AbortController();
    const stream = runtime.readFile("/workspace/huge.bin", abort.signal);
    const reader = stream.getReader();
    await Bun.sleep(0);
    expect(runtime.capturedSignal?.aborted).toBe(false);

    abort.abort();
    expect(runtime.capturedSignal?.aborted).toBe(true);
    reader.releaseLock();
  });
});

describe("RemoteRuntime file operation aborts", () => {
  it("stat settles immediately when aborted instead of waiting out path resolution", async () => {
    const runtime = new RecordingRemoteRuntime();
    let resolverSettled = false;
    runtime.resolvePath = () =>
      new Promise((resolve) =>
        setTimeout(() => {
          resolverSettled = true;
          resolve("/workspace");
        }, 1000)
      );
    const controller = new AbortController();
    controller.abort();

    const rejected = await runtime.stat("relative/file.txt", controller.signal).then(
      () => false,
      () => true
    );
    expect(rejected).toBe(true);
    expect(resolverSettled).toBe(false);
  });
});

describe("RemoteRuntime.writeFile", () => {
  it("does not start a remote write command when aborted before the first write", async () => {
    const runtime = new RecordingRemoteRuntime();
    const writer = runtime.writeFile("/workspace/file.txt").getWriter();

    try {
      await writer.abort("cancelled");
      throw new Error("Expected writer abort to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("cancelled");
    }

    expect(runtime.spawnCount).toBe(0);
  });
});
