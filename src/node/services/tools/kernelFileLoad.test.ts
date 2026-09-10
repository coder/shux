import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";

import { createKernelFileLoader } from "./kernelFileLoad";

describe("createKernelFileLoader line counting", () => {
  it("does not count a trailing newline as an extra line", async () => {
    // The {lines} summary is model-visible and used directly for exact-count
    // tasks; a conventional newline-terminated file must not report one more
    // line than it contains.
    using tmp = new DisposableTempDir("kernel-load-lines");
    await fs.writeFile(nodePath.join(tmp.path, "terminated.txt"), "line1\nline2\n", "utf8");
    await fs.writeFile(nodePath.join(tmp.path, "unterminated.txt"), "line1\nline2", "utf8");
    await fs.writeFile(nodePath.join(tmp.path, "empty.txt"), "", "utf8");
    await fs.writeFile(nodePath.join(tmp.path, "blank-line.txt"), "line1\n\nline3\n", "utf8");

    const load = createKernelFileLoader({ cwd: tmp.path, runtime: new LocalRuntime(tmp.path) });

    expect((await load({ path: "terminated.txt" })).lines).toBe(2);
    expect((await load({ path: "unterminated.txt" })).lines).toBe(2);
    expect((await load({ path: "empty.txt" })).lines).toBe(0);
    // Interior blank lines still count as records.
    expect((await load({ path: "blank-line.txt" })).lines).toBe(3);
  });
});

describe("createKernelFileLoader hook gating", () => {
  it("routes loads through the file_read tool_pre gate; blocked paths never reach vars", async () => {
    // Security regression (Codex P1): mux.load rides file_read's capability
    // grant, so it must also ride file_read's hook gate — a trusted tool_pre
    // denying sensitive paths for file_read must deny the bulk load too, or
    // prompt-injected kernel code could exfiltrate a denied .env via vars.
    using tmp = new DisposableTempDir("kernel-load-hooks");
    await fs.writeFile(nodePath.join(tmp.path, ".env"), "SECRET=1\n", "utf8");
    await fs.writeFile(nodePath.join(tmp.path, "notes.txt"), "hello\n", "utf8");
    const hookDir = nodePath.join(tmp.path, ".xum");
    await fs.mkdir(hookDir, { recursive: true });
    const hookPath = nodePath.join(hookDir, "tool_pre");
    await fs.writeFile(
      hookPath,
      `#!/bin/bash
case "$XUM_TOOL_INPUT" in
  *".env"*) echo "denied: sensitive path"; exit 1;;
esac
exit 0
`
    );
    await fs.chmod(hookPath, 0o755);

    const runtime = new LocalRuntime(tmp.path);
    const load = createKernelFileLoader({
      cwd: tmp.path,
      runtime,
      hooks: { runtime, cwd: tmp.path, runtimeTempDir: tmp.path, workspaceId: "test-ws" },
    });

    // Denied path: a catchable guest error, no content escapes the read.
    expect(load({ path: ".env" })).rejects.toThrow(/denied: sensitive path/);
    // Allowed path: loads normally through the same pipeline.
    expect((await load({ path: "notes.txt" })).content).toBe("hello\n");
  });
});

describe("createKernelFileLoader hook annotations", () => {
  it("propagates post-hook annotations without leaking full content (r54)", async () => {
    // Codex r54: mux.load returned the pre-hook object, silently dropping
    // tool_post / tool.execute.after annotations (formatter notices,
    // warnings) even though the hooks ran — feedback ordinary file_read
    // exposes to the model. The annotation must ride the load record while
    // the full content stays host-side.
    using tmp = new DisposableTempDir("kernel-load-post-hook");
    await fs.writeFile(nodePath.join(tmp.path, "notes.txt"), "hello\nworld\n", "utf8");
    const hookDir = nodePath.join(tmp.path, ".xum");
    await fs.mkdir(hookDir, { recursive: true });
    const prePath = nodePath.join(hookDir, "tool_pre");
    await fs.writeFile(prePath, "#!/bin/bash\nexit 0\n");
    await fs.chmod(prePath, 0o755);
    const postPath = nodePath.join(hookDir, "tool_post");
    await fs.writeFile(postPath, '#!/bin/bash\necho "formatter notice"\nexit 0\n');
    await fs.chmod(postPath, 0o755);

    const runtime = new LocalRuntime(tmp.path);
    const load = createKernelFileLoader({
      cwd: tmp.path,
      runtime,
      hooks: { runtime, cwd: tmp.path, runtimeTempDir: tmp.path, workspaceId: "test-ws" },
    });

    const annotated = await load({ path: "notes.txt" });
    // Full content still rides the host closure into vars.
    expect(annotated.content).toBe("hello\nworld\n");
    // The transformed model-visible summary carries the hook's annotation...
    const hookResult = annotated.hookResult as {
      bytes?: number;
      hook_output?: string;
    } | null;
    expect(hookResult?.hook_output).toContain("formatter notice");
    expect(hookResult?.bytes).toBe(annotated.bytes);
    // ...but never the full-content field (hooks only observe the summary).
    expect(hookResult).not.toHaveProperty("content");

    // Hooks are rediscovered per call: with the post-hook gone the summary
    // is untransformed and no annotation is attached.
    await fs.rm(postPath);
    const plain = await load({ path: "notes.txt" });
    expect(plain.hookResult).toBeUndefined();
  });
});

describe("createKernelFileLoader byte ceiling", () => {
  it("fails and cancels when the stream exceeds the size the stat reported", async () => {
    // Models /dev/zero (stat size 0, infinite stream) and stat→read growth
    // races without depending on platform device files: the pre-read size
    // check passes, so only a ceiling enforced WHILE consuming the stream
    // bounds host memory. Local readFile ignores the abort signal, so the
    // execution deadline cannot save us either.
    using tmp = new DisposableTempDir("kernel-load-ceiling");
    await fs.writeFile(nodePath.join(tmp.path, "a.txt"), "x", "utf8");

    let cancelled = false;
    const inner = new LocalRuntime(tmp.path);
    const lyingRuntime = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "stat") {
          return async (path: string, signal?: AbortSignal) => ({
            ...(await target.stat(path, signal)),
            size: 0,
          });
        }
        if (prop === "readFile") {
          // 4MB in 64KB chunks — over the 1MB ceiling but finite, so a
          // regression fails this test cleanly instead of hanging it.
          let enqueued = 0;
          return () =>
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (enqueued >= 4 * 1024 * 1024) {
                  controller.close();
                  return;
                }
                enqueued += 64 * 1024;
                controller.enqueue(new Uint8Array(64 * 1024));
              },
              cancel() {
                cancelled = true;
              },
            });
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    const load = createKernelFileLoader({ cwd: tmp.path, runtime: lyingRuntime });
    try {
      await load({ path: "a.txt" });
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(String(e)).toContain("read exceeded");
    }
    // The ceiling must stop the source early — not consume all 4MB first.
    expect(cancelled).toBe(true);
  });
});

describe("createKernelFileLoader cancellation", () => {
  it("threads the abort signal into runtime.stat and runtime.readFile", async () => {
    // Kernel cancellation must reach the underlying I/O: on RemoteRuntime a
    // read without a signal falls back to the 300s cat timeout, holding the
    // persistent-mount lease long past the execution deadline or a removal.
    using tmp = new DisposableTempDir("kernel-load-signal");
    await fs.writeFile(nodePath.join(tmp.path, "a.txt"), "hello\n", "utf8");

    const inner = new LocalRuntime(tmp.path);
    const seenStatSignals: Array<AbortSignal | undefined> = [];
    const seenReadSignals: Array<AbortSignal | undefined> = [];
    // Recording proxy: forward everything, capture the signals the loader
    // passes to the two I/O entry points.
    const recording = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "stat") {
          return (path: string, signal?: AbortSignal) => {
            seenStatSignals.push(signal);
            return target.stat(path, signal);
          };
        }
        if (prop === "readFile") {
          return (path: string, signal?: AbortSignal) => {
            seenReadSignals.push(signal);
            return target.readFile(path, signal);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    const controller = new AbortController();
    const load = createKernelFileLoader({ cwd: tmp.path, runtime: recording });
    await load({ path: "a.txt", abortSignal: controller.signal });

    expect(seenStatSignals).toEqual([controller.signal]);
    expect(seenReadSignals).toEqual([controller.signal]);
  });
});
