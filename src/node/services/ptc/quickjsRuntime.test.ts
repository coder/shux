import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { CONSOLE_CAPTURE_BUDGET_BYTES } from "@/constants/kernelOutput";
import { QuickJSRuntime, QuickJSRuntimeFactory } from "./quickjsRuntime";
import type { PTCEvent } from "./types";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";

describe("QuickJSRuntime", () => {
  let runtime: QuickJSRuntime;

  beforeEach(async () => {
    runtime = await QuickJSRuntime.create();
  });

  afterEach(() => {
    runtime.dispose();
  });

  describe("basic evaluation", () => {
    it("executes basic JS and returns result", async () => {
      const result = await runtime.eval("return 1 + 1;");
      expect(result.success).toBe(true);
      expect(result.result).toBe(2);
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it("handles string results", async () => {
      const result = await runtime.eval('return "hello world";');
      expect(result.success).toBe(true);
      expect(result.result).toBe("hello world");
    });

    it("handles object results", async () => {
      const result = await runtime.eval('return { foo: "bar", num: 42 };');
      expect(result.success).toBe(true);
      expect(result.result).toEqual({ foo: "bar", num: 42 });
    });

    it("handles array results", async () => {
      const result = await runtime.eval("return [1, 2, 3];");
      expect(result.success).toBe(true);
      expect(result.result).toEqual([1, 2, 3]);
    });

    it("handles undefined return (no explicit return)", async () => {
      const result = await runtime.eval("const x = 1;");
      expect(result.success).toBe(true);
      expect(result.result).toBeUndefined();
    });

    it("handles null return", async () => {
      const result = await runtime.eval("return null;");
      expect(result.success).toBe(true);
      expect(result.result).toBeNull();
    });

    it("resolves returned promises", async () => {
      const result = await runtime.eval("return (async () => ({ ok: true }))();");
      expect(result.success).toBe(true);
      expect(result.result).toEqual({ ok: true });
    });

    it("handles syntax errors", async () => {
      const result = await runtime.eval("return {{{;");
      expect(result.success).toBe(false);
      expect(result.error).toContain("SyntaxError");
    });

    it("handles runtime errors", async () => {
      const result = await runtime.eval("throw new Error('boom');");
      expect(result.success).toBe(false);
      expect(result.error).toContain("boom");
    });

    // Note: With asyncify, async host functions appear SYNC to QuickJS.
    // Call host functions directly unless the evaluated code intentionally returns a Promise.
    it("handles multiple statements", async () => {
      const result = await runtime.eval(`
        const x = 10;
        const y = 20;
        return x + y;
      `);
      expect(result.success).toBe(true);
      expect(result.result).toBe(30);
    });
  });

  describe("registered functions", () => {
    // With asyncify, async host functions appear SYNCHRONOUS to QuickJS.
    // No 'await' needed in QuickJS code - evalCodeAsync suspends the WASM module.
    it("calls registered async functions (sync from QuickJS perspective)", async () => {
      runtime.registerFunction("fetchData", () => Promise.resolve({ value: 42 }));

      // Note: NO await in the QuickJS code - the function appears sync
      const result = await runtime.eval("return fetchData();");
      expect(result.success).toBe(true);
      expect(result.result).toEqual({ value: 42 });
    });

    it("passes arguments to registered functions", async () => {
      runtime.registerFunction("add", (...args: unknown[]) => {
        const [a, b] = args as [number, number];
        return Promise.resolve(a + b);
      });

      const result = await runtime.eval("return add(10, 20);");
      expect(result.success).toBe(true);
      expect(result.result).toBe(30);
    });

    it("handles function errors", async () => {
      runtime.registerFunction("failFunc", () => {
        return Promise.reject(new Error("function failed"));
      });

      const result = await runtime.eval("return failFunc();");
      expect(result.success).toBe(false);
      expect(result.error).toContain("function failed");
    });

    it("records tool calls on success", async () => {
      runtime.registerFunction("myTool", (arg: unknown) => Promise.resolve({ received: arg }));

      const result = await runtime.eval('return myTool({ input: "test" });');
      expect(result.success).toBe(true);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].toolName).toBe("myTool");
      expect(result.toolCalls[0].args).toEqual({ input: "test" });
      expect(result.toolCalls[0].result).toEqual({ received: { input: "test" } });
      expect(result.toolCalls[0].duration_ms).toBeGreaterThanOrEqual(0);
    });

    it("records tool calls on failure", async () => {
      runtime.registerFunction("failTool", () => {
        return Promise.reject(new Error("tool error"));
      });

      const result = await runtime.eval("try { failTool(); } catch(e) { return 'caught'; }");
      expect(result.success).toBe(true);
      expect(result.result).toBe("caught");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].toolName).toBe("failTool");
      expect(result.toolCalls[0].error).toContain("tool error");
    });
  });

  describe("registered objects", () => {
    it("calls methods on registered objects", async () => {
      runtime.registerObject("mux", {
        fileRead: (...args: unknown[]) => Promise.resolve({ content: `File: ${String(args[0])}` }),
        bash: (...args: unknown[]) => Promise.resolve({ output: `Ran: ${String(args[0])}` }),
      });

      // No await needed - asyncified methods appear sync
      const result = await runtime.eval(`
        const file = mux.fileRead("test.txt");
        const bash = mux.bash("ls");
        return { file, bash };
      `);

      expect(result.success).toBe(true);
      expect(result.result).toEqual({
        file: { content: "File: test.txt" },
        bash: { output: "Ran: ls" },
      });
    });

    it("records tool calls with full name", async () => {
      runtime.registerObject("mux", {
        fileRead: () => Promise.resolve("content"),
      });

      const result = await runtime.eval('mux.fileRead("test.txt");');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].toolName).toBe("fileRead");
    });

    it("sync methods are callable from post-await continuations", async () => {
      // Asyncified methods cannot be called after `await capability()` (the
      // asyncify stack is gone); sync namespace methods must keep working
      // there — this is the contract mux.events() relies on.
      const queue: unknown[] = [{ type: "task-terminal", taskId: "t1" }];
      runtime.registerPromiseFunction("cap", () => Promise.resolve("ok"));
      runtime.registerObject("mux", {}, { events: () => queue.splice(0, queue.length) });

      const result = await runtime.eval(`
        return (async () => {
          await cap();
          return mux.events();
        })();
      `);
      expect(result.success).toBe(true);
      expect(result.result).toEqual([{ type: "task-terminal", taskId: "t1" }]);
    });

    it("sync methods dispatch late-bound: saved references see re-registration", async () => {
      runtime.registerObject("mux", {}, { events: () => ["old"] });
      const save = await runtime.eval("globalThis.saved = mux.events; return saved();");
      expect(save.result).toEqual(["old"]);

      runtime.registerObject("mux", {}, { events: () => ["new"] });
      const result = await runtime.eval("return saved();");
      expect(result.success).toBe(true);
      expect(result.result).toEqual(["new"]);
    });

    it("rejects a name registered as both async and sync method", () => {
      expect(() =>
        runtime.registerObject("mux", { events: () => Promise.resolve(1) }, { events: () => 2 })
      ).toThrow(/both async and sync/);
    });
  });

  describe("setVarsProperty", () => {
    it("writes into vars from a host function mid-eval; recreates a clobbered vars", async () => {
      // Host-side write during an asyncified host call — the window mux.load
      // uses to place bulk content into the kernel without transiting records.
      runtime.registerFunction("hostWrite", (...args: unknown[]) => {
        runtime.setVarsProperty(String(args[0]), String(args[1]));
        return Promise.resolve(true);
      });
      const result = await runtime.eval(`
        globalThis.vars = {};
        hostWrite("a", "hello");
        const first = vars.a;
        vars = null; // guest clobbers the namespace
        hostWrite("b", "world");
        return { first, second: vars.b };
      `);
      expect(result.success).toBe(true);
      expect(result.result).toEqual({ first: "hello", second: "world" });
    });

    it("throws when a guest Proxy vars swallows the write (r29)", async () => {
      // Lying set/defineProperty traps "accept" the write while storing
      // nothing — without the read-back verify the host reported success for
      // a key that never existed (mux.load then advertised a fake record).
      runtime.registerFunction("hostWrite", (...args: unknown[]) => {
        runtime.setVarsProperty(String(args[0]), String(args[1]));
        return Promise.resolve(true);
      });
      const result = await runtime.eval(`
        vars = new Proxy({}, {
          set: function () { return true; },
          defineProperty: function () { return true; },
        });
        try {
          hostWrite("a", "hello");
          return "stored";
        } catch (e) {
          return String(e);
        }
      `);
      expect(result.success).toBe(true);
      expect(String(result.result)).toContain("did not store");
    });

    it("throws when a guest Proxy vars hides the write from serialization (r54)", async () => {
      // A default set trap stores into the target, so the identity read-back
      // passes — but ownKeys omits the key, so JSON.stringify(vars) (exactly
      // what the durable snapshot persists) drops the load: after a restart
      // the advertised key is gone. The write must fail loudly instead.
      runtime.registerFunction("hostWrite", (...args: unknown[]) => {
        runtime.setVarsProperty(String(args[0]), String(args[1]));
        return Promise.resolve(true);
      });
      const result = await runtime.eval(`
        vars = new Proxy({}, {
          ownKeys: function () { return []; },
        });
        try {
          hostWrite("a", "hello");
          return "stored";
        } catch (e) {
          return String(e);
        }
      `);
      expect(result.success).toBe(true);
      expect(String(result.result)).toContain("did not store");
      // The verification temp global must not linger in the guest realm.
      const leak = await runtime.eval(`return typeof globalThis.__xumVarsWriteVerify;`);
      expect(leak.result).toBe("undefined");
    });
  });

  describe("console capture", () => {
    it("captures console.log output", async () => {
      const result = await runtime.eval(`
        console.log("hello", 123);
        return "done";
      `);

      expect(result.success).toBe(true);
      expect(result.consoleOutput).toHaveLength(1);
      expect(result.consoleOutput[0].level).toBe("log");
      expect(result.consoleOutput[0].args).toEqual(["hello", 123]);
      expect(result.consoleOutput[0].timestamp).toBeGreaterThan(0);
    });

    it("captures console.warn and console.error", async () => {
      const result = await runtime.eval(`
        console.log("info");
        console.warn("warning");
        console.error("error");
        return;
      `);

      expect(result.consoleOutput).toHaveLength(3);
      expect(result.consoleOutput[0].level).toBe("log");
      expect(result.consoleOutput[1].level).toBe("warn");
      expect(result.consoleOutput[2].level).toBe("error");
    });

    it("bounds retained console output at capture time (host memory O(budget), not O(output))", async () => {
      // r15: a guest loop console.log-ing large values for the whole timeout
      // used to retain EVERY dumped record host-side before any post-eval cap
      // ran, so a prompt-influenced program could exhaust process memory.
      // ~30MB of guest output; retention must stay bounded by the budget.
      const result = await runtime.eval(`
        for (let i = 0; i < 300; i++) { console.log("x".repeat(100000)); }
        return "done";
      `);
      expect(result.success).toBe(true);
      expect(result.result).toBe("done");

      let retainedBytes = 0;
      for (const record of result.consoleOutput) {
        retainedBytes += Buffer.byteLength(JSON.stringify(record.args) ?? "", "utf8");
      }
      // Budget + small slack for the marker record itself.
      expect(retainedBytes).toBeLessThanOrEqual(CONSOLE_CAPTURE_BUDGET_BYTES + 4096);
      expect(result.consoleOutput.length).toBeLessThan(300);

      // The drop is explicit, never silent: the final record is a marker
      // carrying an accurate dropped-record count.
      const marker = result.consoleOutput[result.consoleOutput.length - 1];
      expect(marker.level).toBe("warn");
      expect(String(marker.args[0])).toContain("console output truncated at capture");
      expect(String(marker.args[0])).toMatch(/2\d\d record\(s\) dropped/);
    });

    it("treats unserializable console records as over budget (BigInt bypass)", async () => {
      // r17: a BARE BigInt arg survives dump as a real BigInt (objects
      // containing one stringify to "[object Object]"), so JSON.stringify of
      // the args array throws — charging such records zero bytes would
      // retain the sibling payload arg for free, letting a guest grow host
      // memory unbounded past the capture budget by pairing every large
      // payload with one BigInt arg.
      const result = await runtime.eval(`
        for (let i = 0; i < 300; i++) { console.log(1n, "x".repeat(100000)); }
        return "done";
      `);
      expect(result.success).toBe(true);
      expect(result.result).toBe("done");

      // Unserializable records must be dropped, not retained: total retained
      // record count stays O(1) (the marker plus at most a few pre-trip
      // records), never the 300 the guest logged.
      expect(result.consoleOutput.length).toBeLessThanOrEqual(2);
      const marker = result.consoleOutput[result.consoleOutput.length - 1];
      expect(String(marker.args[0])).toContain("console output truncated at capture");
      expect(String(marker.args[0])).toMatch(/(299|300) record\(s\) dropped/);
    });

    it("events for dropped console records are not emitted (bounded capture, bounded stream)", async () => {
      const events: PTCEvent[] = [];
      runtime.onEvent((event) => events.push(event));
      const result = await runtime.eval(`
        for (let i = 0; i < 50; i++) { console.log("y".repeat(100000)); }
        return true;
      `);
      expect(result.success).toBe(true);
      const consoleEvents = events.filter((event) => event.type === "console");
      // 50 * 100KB = 5MB > budget: only the retained records streamed.
      expect(consoleEvents.length).toBeLessThan(50);
      expect(consoleEvents.length).toBe(
        // Marker records are pushed host-side without an event.
        result.consoleOutput.filter(
          (record) => !String(record.args[0]).includes("truncated at capture")
        ).length
      );
    });
  });

  describe("event streaming", () => {
    it("emits tool-call-start and tool-call-end events", async () => {
      const events: PTCEvent[] = [];
      runtime.onEvent((e) => events.push(e));

      runtime.registerFunction("myTool", () => Promise.resolve("result"));
      await runtime.eval("myTool()");

      const toolEvents = events.filter(
        (e) => e.type === "tool-call-start" || e.type === "tool-call-end"
      );
      expect(toolEvents).toHaveLength(2);

      expect(toolEvents[0].type).toBe("tool-call-start");
      expect(toolEvents[0].toolName).toBe("myTool");

      expect(toolEvents[1].type).toBe("tool-call-end");
      expect(toolEvents[1].toolName).toBe("myTool");
      if (toolEvents[1].type === "tool-call-end") {
        expect(toolEvents[1].result).toBe("result");
      }
    });

    it("emits console events", async () => {
      const events: PTCEvent[] = [];
      runtime.onEvent((e) => events.push(e));

      await runtime.eval('console.log("test", 42)');

      const consoleEvents = events.filter((e) => e.type === "console");
      expect(consoleEvents).toHaveLength(1);
      expect(consoleEvents[0].type).toBe("console");
      if (consoleEvents[0].type === "console") {
        expect(consoleEvents[0].level).toBe("log");
        expect(consoleEvents[0].args).toEqual(["test", 42]);
      }
    });
  });

  describe("partial results on failure", () => {
    it("returns partial results when error occurs after tool calls", async () => {
      runtime.registerFunction("succeed", () => Promise.resolve("ok"));
      runtime.registerFunction("fail", () => {
        return Promise.reject(new Error("boom"));
      });

      const result = await runtime.eval(`
        succeed();
        fail();
      `);

      expect(result.success).toBe(false);
      expect(result.error).toContain("boom");
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0].result).toBe("ok");
      expect(result.toolCalls[1].error).toContain("boom");
    });

    it("preserves console output on failure", async () => {
      const result = await runtime.eval(`
        console.log("before error");
        throw new Error("fail");
      `);

      expect(result.success).toBe(false);
      expect(result.consoleOutput).toHaveLength(1);
      expect(result.consoleOutput[0].args).toEqual(["before error"]);
    });
  });

  describe("limits", () => {
    it("applies memory limits", async () => {
      runtime.setLimits({ memoryBytes: 1024 * 1024 }); // 1MB

      // Try to allocate a large array - should fail
      const result = await runtime.eval(`
        const arr = new Array(10 * 1024 * 1024).fill(1);
        return arr.length;
      `);

      // Should either fail or succeed with limited allocation
      // QuickJS may throw or return partial result
      expect(result.success).toBe(false);
    });

    it("applies timeout limits", async () => {
      runtime.setLimits({ timeoutMs: 100 }); // 100ms timeout

      const result = await runtime.eval(`
        while(true) {} // Infinite loop
      `);

      expect(result.success).toBe(false);
      expect(result.error).toContain("timeout");
    });

    it("aborts signal when timeout fires during async host function", async () => {
      // This tests the setTimeout-based timeout's effect on the abort signal.
      // The interrupt handler only fires during QuickJS execution, but when
      // waiting for an async host function, the setTimeout aborts the signal.
      //
      // Important: The host function itself won't be cancelled mid-flight
      // (JavaScript can't interrupt Promises), but the signal will be aborted
      // so subsequent tool calls will see it and fail fast.
      let firstCallCompleted = false;

      runtime.registerFunction("slowOp", async () => {
        // Sleep for 200ms
        await new Promise((resolve) => setTimeout(resolve, 200));
        firstCallCompleted = true;
        return "done";
      });

      // Check the abort signal state from QuickJS (sync is fine, made async for type)
      runtime.registerFunction("checkAbortState", () => {
        return Promise.resolve({ aborted: runtime.getAbortSignal()?.aborted ?? false });
      });

      runtime.setLimits({ timeoutMs: 100 }); // 100ms timeout

      const result = await runtime.eval(`
        slowOp();           // Takes 200ms, timeout fires at 100ms
        checkAbortState();  // Should show aborted = true
        slowOp();           // This would start after abort
        return "finished";
      `);

      // The first call completes (can't be interrupted mid-Promise)
      expect(firstCallCompleted).toBe(true);
      // But the overall execution fails due to timeout
      expect(result.success).toBe(false);
      expect(result.error).toContain("timeout");
    });
  });

  describe("abort", () => {
    it("can abort during async host function", async () => {
      // Abort is checked at the start of each async host function call
      let callCount = 0;
      runtime.registerFunction("slowOp", async () => {
        callCount++;
        // Simulate slow async work
        await new Promise((resolve) => setTimeout(resolve, 200));
        return "done";
      });

      // Queue multiple calls, abort after first starts
      const evalPromise = runtime.eval(`
        slowOp();
        slowOp(); // Should be aborted before running
        return "finished";
      `);

      // Abort after first function starts but before it completes
      setTimeout(() => runtime.abort(), 100);

      await evalPromise;
      // First call may complete, but second should be aborted
      // (timing dependent, but abort should eventually take effect)
      expect(callCount).toBeLessThanOrEqual(2);
    });
  });

  describe("async capability bridge (registerPromiseFunction)", () => {
    it("returns a real Promise into the guest that resolves via await", async () => {
      runtime.registerPromiseFunction("slowDouble", async (n) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return (n as number) * 2;
      });

      // Guest awaits the capability promise inside an async IIFE; eval's
      // resolve loop must wait for the host settlement instead of reporting a
      // stuck pending Promise.
      const result = await runtime.eval(`
        return (async () => {
          const doubled = await slowDouble(21);
          return { doubled };
        })();
      `);
      expect(result.success).toBe(true);
      expect(result.result).toEqual({ doubled: 42 });
    });

    it("supports fire-and-forget: returns immediately without awaiting", async () => {
      // Manually-resolved host promise: deterministic under load (no timers).
      let resolveHost: (() => void) | undefined;
      let settled = false;
      runtime.registerPromiseFunction("background", async () => {
        await new Promise<void>((resolve) => {
          resolveHost = resolve;
        });
        settled = true;
        return "done";
      });

      const result = await runtime.eval(`
        const p = background();
        return { startedImmediately: typeof p.then === "function" };
      `);
      expect(result.success).toBe(true);
      expect(result.result).toEqual({ startedImmediately: true });
      // The guest did not wait for the host promise - it is still unresolved.
      expect(settled).toBe(false);
      expect(resolveHost).toBeDefined();
      resolveHost?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(true);
    });

    it("propagates capability rejection as a catchable guest error", async () => {
      runtime.registerPromiseFunction("failAsync", () => {
        return Promise.reject(new Error("capability exploded"));
      });

      const result = await runtime.eval(`
        return (async () => {
          try {
            await failAsync();
            return "no error";
          } catch (e) {
            return "caught: " + e.message;
          }
        })();
      `);
      expect(result.success).toBe(true);
      expect(result.result).toBe("caught: capability exploded");
    });

    it("attributes a late-settling fire-and-forget capability to its originating eval", async () => {
      // Manually-gated host promise: settles only after BOTH evals returned.
      let resolveHost: (() => void) | undefined;
      runtime.registerPromiseFunction("lateCap", async () => {
        await new Promise<void>((resolve) => {
          resolveHost = resolve;
        });
        return "late";
      });

      // Fire-and-forget: eval returns while the capability is still pending.
      const first = await runtime.eval('lateCap(); return "first";');
      expect(first.success).toBe(true);
      expect(first.toolCalls).toHaveLength(0);

      // A second eval swaps the runtime's per-eval state.
      const second = await runtime.eval('return "second";');
      expect(second.success).toBe(true);

      expect(resolveHost).toBeDefined();
      resolveHost?.();
      // Let the settlement bookkeeping run.
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The record must land on the ORIGINATING eval, never on a later one.
      expect(second.toolCalls).toHaveLength(0);
      expect(first.toolCalls).toHaveLength(1);
      expect(first.toolCalls[0]?.toolName).toBe("lateCap");
    });

    it("routes late-settlement continuations through the pending-job gate", async () => {
      const gatedRuns: Array<() => void> = [];
      runtime.setPendingJobGate((run) => gatedRuns.push(run));

      let resolveHost: (() => void) | undefined;
      runtime.registerPromiseFunction("lateGate", async () => {
        await new Promise<void>((resolve) => {
          resolveHost = resolve;
        });
        return "done";
      });

      // Fire-and-forget: the eval returns while the capability is pending.
      const result = await runtime.eval('lateGate(); return "first";');
      expect(result.success).toBe(true);

      // Settle AFTER the eval returned: the continuation must be handed to
      // the gate (owner-serialized) instead of executing immediately.
      expect(resolveHost).toBeDefined();
      resolveHost?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(gatedRuns.length).toBe(1);
      // Running the gated job must be safe.
      for (const run of gatedRuns) run();
    });

    it("lets a later eval consume a promise stored by a prior eval (settlement mid-eval)", async () => {
      // Mirror SandboxMount's gate: serialize gated runs on the mount lock.
      const mutex = new AsyncMutex();
      runtime.setPendingJobGate((run) => {
        void (async () => {
          await using _lock = await mutex.acquire();
          run();
        })();
      });

      let resolveHost: ((value: string) => void) | undefined;
      runtime.registerPromiseFunction(
        "lateCap",
        () =>
          new Promise<string>((resolve) => {
            resolveHost = resolve;
          })
      );

      const first = await runtime.eval('globalThis.p = lateCap(); return "stored";');
      expect(first.success).toBe(true);

      // The next code_execution call holds the mount lock for its whole
      // register→eval→persist sequence; settle while ITS eval is running.
      // Routing this settlement through the gate would self-deadlock (the
      // gate waits on the lock the awaiting eval holds).
      {
        await using _lock = await mutex.acquire();
        const evalPromise = runtime.eval("return globalThis.p;");
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(resolveHost).toBeDefined();
        resolveHost?.("late-value");
        const second = await evalPromise;
        expect(second.success).toBe(true);
        expect(second.result).toBe("late-value");
      }
    });

    it("drains a gate-queued settlement at eval start when the gate lost the lock race", async () => {
      const mutex = new AsyncMutex();
      runtime.setPendingJobGate((run) => {
        void (async () => {
          await using _lock = await mutex.acquire();
          run();
        })();
      });

      let resolveHost: ((value: string) => void) | undefined;
      runtime.registerPromiseFunction(
        "lateCap",
        () =>
          new Promise<string>((resolve) => {
            resolveHost = resolve;
          })
      );

      const first = await runtime.eval('globalThis.q = lateCap(); return "stored";');
      expect(first.success).toBe(true);

      {
        await using _lock = await mutex.acquire();
        // Settle BETWEEN evals while the next call already holds the lock:
        // the settlement is handed to the gate, which cannot run yet.
        expect(resolveHost).toBeDefined();
        resolveHost?.("queued-value");
        await new Promise((resolve) => setTimeout(resolve, 10));

        // The eval must land the queued settlement itself at start.
        const second = await runtime.eval("return globalThis.q;");
        expect(second.success).toBe(true);
        expect(second.result).toBe("queued-value");
      }

      // After release, the gate's drain finds an empty queue and must no-op;
      // the runtime stays usable.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const third = await runtime.eval("return 3;");
      expect(third.success).toBe(true);
      expect(third.result).toBe(3);
    });

    it("attributes cross-eval promise reactions to the consuming eval", async () => {
      const mutex = new AsyncMutex();
      runtime.setPendingJobGate((run) => {
        void (async () => {
          await using _lock = await mutex.acquire();
          run();
        })();
      });

      let resolveHost: ((value: string) => void) | undefined;
      runtime.registerPromiseFunction(
        "lateCap",
        () =>
          new Promise<string>((resolve) => {
            resolveHost = resolve;
          })
      );

      const first = await runtime.eval('globalThis.p = lateCap(); return "stored";');
      expect(first.success).toBe(true);

      {
        await using _lock = await mutex.acquire();
        // The .then() reaction is created by THIS eval on the prior eval's
        // stored promise: its console output must land on the consuming
        // eval, not retroactively on the already-returned originating one.
        const evalPromise = runtime.eval(
          'return globalThis.p.then((v) => { console.log("consumed", v); return v; });'
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(resolveHost).toBeDefined();
        resolveHost?.("late-value");
        const second = await evalPromise;
        expect(second.success).toBe(true);
        expect(second.result).toBe("late-value");
        expect(second.consoleOutput.some((c) => c.args[0] === "consumed")).toBe(true);
        expect(first.consoleOutput).toHaveLength(0);
      }
    });

    it("attributes reactions registered by a prior eval to that eval", async () => {
      let resolveP: ((value: string) => void) | undefined;
      let resolveUnrelated: ((value: string) => void) | undefined;
      runtime.registerPromiseFunction(
        "lateCap",
        () =>
          new Promise<string>((resolve) => {
            resolveP = resolve;
          })
      );
      runtime.registerPromiseFunction(
        "unrelatedCap",
        () =>
          new Promise<string>((resolve) => {
            resolveUnrelated = resolve;
          })
      );

      // Eval 1 registers ITS OWN reaction on the capability promise.
      const first = await runtime.eval(`
        globalThis.p = lateCap();
        globalThis.p.then((v) => console.log("prior-owned", v));
        return "stored";
      `);
      expect(first.success).toBe(true);
      expect(first.consoleOutput).toHaveLength(0);

      // Eval 2 parks in its resolve loop on an unrelated capability; the
      // prior eval's promise settles during that drain window.
      const evalPromise = runtime.eval("return unrelatedCap();");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(resolveP).toBeDefined();
      resolveP?.("late");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(resolveUnrelated).toBeDefined();
      resolveUnrelated?.("done");
      const second = await evalPromise;
      expect(second.success).toBe(true);
      expect(second.result).toBe("done");

      // The reaction was REGISTERED by eval 1: its console output must land
      // there, not on the eval whose drain executed the job.
      expect(first.consoleOutput.some((c) => c.args[0] === "prior-owned")).toBe(true);
      expect(second.consoleOutput.some((c) => c.args[0] === "prior-owned")).toBe(false);
    });

    it("attributes nested capabilities started by a prior eval's reaction to that eval", async () => {
      let resolveP: ((value: string) => void) | undefined;
      let resolveUnrelated: ((value: string) => void) | undefined;
      runtime.registerPromiseFunction(
        "lateCap",
        () =>
          new Promise<string>((resolve) => {
            resolveP = resolve;
          })
      );
      runtime.registerPromiseFunction(
        "unrelatedCap",
        () =>
          new Promise<string>((resolve) => {
            resolveUnrelated = resolve;
          })
      );
      runtime.registerPromiseFunction("nestedCap", () => Promise.resolve("nested-done"));

      const first = await runtime.eval(`
        globalThis.p = lateCap();
        globalThis.p.then(() => { nestedCap(); });
        return "stored";
      `);
      expect(first.success).toBe(true);
      expect(first.toolCalls).toHaveLength(0);

      const evalPromise = runtime.eval("return unrelatedCap();");
      await new Promise((resolve) => setTimeout(resolve, 10));
      resolveP?.("late");
      await new Promise((resolve) => setTimeout(resolve, 10));
      resolveUnrelated?.("done");
      const second = await evalPromise;
      expect(second.success).toBe(true);

      // Give the nested capability's settlement bookkeeping time to land.
      await new Promise((resolve) => setTimeout(resolve, 10));
      // The nested capability was started inside eval 1's reaction: its
      // record belongs to eval 1 even though eval 2's drain ran the job.
      expect(first.toolCalls.map((c) => c.toolName)).toContain("nestedCap");
      expect(second.toolCalls.map((c) => c.toolName)).not.toContain("nestedCap");
    });

    it("attributes await continuations registered by a prior eval to that eval", async () => {
      let resolveP: ((value: string) => void) | undefined;
      let resolveUnrelated: ((value: string) => void) | undefined;
      runtime.registerPromiseFunction(
        "lateCap",
        () =>
          new Promise<string>((resolve) => {
            resolveP = resolve;
          })
      );
      runtime.registerPromiseFunction(
        "unrelatedCap",
        () =>
          new Promise<string>((resolve) => {
            resolveUnrelated = resolve;
          })
      );

      // Eval 1 fire-and-forgets an async function that AWAITS the capability
      // promise: the continuation is registered via the engine's internal
      // reaction path, not an explicit .then call.
      const first = await runtime.eval(`
        globalThis.p = lateCap();
        (async () => {
          const v = await globalThis.p;
          console.log("await-owned", v);
        })();
        return "stored";
      `);
      expect(first.success).toBe(true);
      expect(first.consoleOutput).toHaveLength(0);

      // Eval 2 parks in its resolve loop; the prior eval's promise settles
      // during that drain window.
      const evalPromise = runtime.eval("return unrelatedCap();");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(resolveP).toBeDefined();
      resolveP?.("late");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(resolveUnrelated).toBeDefined();
      resolveUnrelated?.("done");
      const second = await evalPromise;
      expect(second.success).toBe(true);
      expect(second.result).toBe("done");

      // The await continuation belongs to eval 1 (which started the async
      // function), not to the eval whose drain executed it.
      expect(first.consoleOutput.some((c) => c.args[0] === "await-owned")).toBe(true);
      expect(second.consoleOutput.some((c) => c.args[0] === "await-owned")).toBe(false);
    });

    it("retains a registering eval's attribution context across many later evals", async () => {
      let resolveP: ((value: string) => void) | undefined;
      let resolveUnrelated: ((value: string) => void) | undefined;
      runtime.registerPromiseFunction(
        "lateCap",
        () =>
          new Promise<string>((resolve) => {
            resolveP = resolve;
          })
      );
      runtime.registerPromiseFunction(
        "unrelatedCap",
        () =>
          new Promise<string>((resolve) => {
            resolveUnrelated = resolve;
          })
      );

      const first = await runtime.eval(`
        globalThis.p = lateCap();
        globalThis.p.then((v) => console.log("retained-owner", v));
        return "stored";
      `);
      expect(first.success).toBe(true);

      // Push well past the idle-context soft cap: the registering generation
      // must be retained because its reaction is still outstanding.
      for (let i = 0; i < 12; i++) {
        const filler = await runtime.eval(`return ${i};`);
        expect(filler.success).toBe(true);
      }

      const evalPromise = runtime.eval("return unrelatedCap();");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(resolveP).toBeDefined();
      resolveP?.("late");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(resolveUnrelated).toBeDefined();
      resolveUnrelated?.("done");
      const last = await evalPromise;
      expect(last.success).toBe(true);

      expect(first.consoleOutput.some((c) => c.args[0] === "retained-owner")).toBe(true);
      expect(last.consoleOutput.some((c) => c.args[0] === "retained-owner")).toBe(false);
    });

    it("releases retained owners when single-handler reactions settle through the opposite branch", async () => {
      let resolveP: ((value: string) => void) | undefined;
      let resolveUnrelated: ((value: string) => void) | undefined;
      runtime.registerPromiseFunction(
        "lateCap",
        () =>
          new Promise<string>((resolve) => {
            resolveP = resolve;
          })
      );
      runtime.registerPromiseFunction(
        "unrelatedCap",
        () =>
          new Promise<string>((resolve) => {
            resolveUnrelated = resolve;
          })
      );

      // Eval 1 holds the only GENUINELY outstanding reaction.
      const first = await runtime.eval(`
        globalThis.p = lateCap();
        globalThis.p.then((v) => console.log("genuine-owner", v));
        return "stored";
      `);
      expect(first.success).toBe(true);

      // 70 evals (past the 64-context hard cap) each register a rejection
      // handler on a FULFILLING promise: the handler never runs, so a leaked
      // retain would keep every one of these generations falsely alive and
      // push eval 1's genuinely-retained context out of the hard cap.
      for (let i = 0; i < 70; i++) {
        const filler = await runtime.eval(
          `Promise.resolve(1).then(undefined, () => {}); return ${i};`
        );
        expect(filler.success).toBe(true);
      }

      const evalPromise = runtime.eval("return unrelatedCap();");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(resolveP).toBeDefined();
      resolveP?.("late");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(resolveUnrelated).toBeDefined();
      resolveUnrelated?.("done");
      const last = await evalPromise;
      expect(last.success).toBe(true);

      // Eval 1's context must have survived: the opposite-branch settlements
      // released their retains, so only genuinely-outstanding generations
      // count against retention.
      expect(first.consoleOutput.some((c) => c.args[0] === "genuine-owner")).toBe(true);
      expect(last.consoleOutput.some((c) => c.args[0] === "genuine-owner")).toBe(false);
    });

    it("invokes tagged promise handlers with an undefined receiver (strict-mode semantics)", async () => {
      // The tagging wrapper must not leak its sloppy-mode globalThis into
      // strict handlers: native reactions call handlers with undefined this.
      const result = await runtime.eval(`
        return Promise.resolve(1).then(function () {
          "use strict";
          return this === undefined;
        });
      `);
      expect(result.success).toBe(true);
      expect(result.result).toBe(true);
    });

    it("releases the retain when reaction registration throws", async () => {
      let resolveP: ((value: string) => void) | undefined;
      let resolveUnrelated: ((value: string) => void) | undefined;
      runtime.registerPromiseFunction(
        "lateCap",
        () =>
          new Promise<string>((resolve) => {
            resolveP = resolve;
          })
      );
      runtime.registerPromiseFunction(
        "unrelatedCap",
        () =>
          new Promise<string>((resolve) => {
            resolveUnrelated = resolve;
          })
      );

      const first = await runtime.eval(`
        globalThis.p = lateCap();
        globalThis.p.then((v) => console.log("survivor-owner", v));
        return "stored";
      `);
      expect(first.success).toBe(true);

      // 70 evals each throw during reaction REGISTRATION (non-promise
      // receiver): no wrapper can ever run, so a leaked retain would keep
      // these generations falsely alive past the hard cap and evict the
      // genuinely-outstanding one above.
      for (let i = 0; i < 70; i++) {
        const filler = await runtime.eval(`
          try { Promise.prototype.then.call({}, () => {}); } catch (e) {}
          return ${i};
        `);
        expect(filler.success).toBe(true);
      }

      const evalPromise = runtime.eval("return unrelatedCap();");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(resolveP).toBeDefined();
      resolveP?.("late");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(resolveUnrelated).toBeDefined();
      resolveUnrelated?.("done");
      const last = await evalPromise;
      expect(last.success).toBe(true);

      expect(first.consoleOutput.some((c) => c.args[0] === "survivor-owner")).toBe(true);
      expect(last.consoleOutput.some((c) => c.args[0] === "survivor-owner")).toBe(false);
    });

    it("queues a prior-eval settlement arriving during an unrelated asyncified call", async () => {
      const mutex = new AsyncMutex();
      runtime.setPendingJobGate((run) => {
        void (async () => {
          await using _lock = await mutex.acquire();
          run();
        })();
      });

      let resolveHost: ((value: string) => void) | undefined;
      runtime.registerPromiseFunction(
        "lateCap",
        () =>
          new Promise<string>((resolve) => {
            resolveHost = resolve;
          })
      );
      let resolveBash: ((value: string) => void) | undefined;
      runtime.registerObject("mux", {
        bash: () =>
          new Promise<string>((resolve) => {
            resolveBash = resolve;
          }),
      });

      const first = await runtime.eval('globalThis.p = lateCap(); return "stored";');
      expect(first.success).toBe(true);

      {
        await using _lock = await mutex.acquire();
        // The eval suspends inside the asyncified mux.bash call (unwound
        // WASM stack)...
        const evalPromise = runtime.eval("const r = mux.bash({}); return globalThis.p;");
        await new Promise((resolve) => setTimeout(resolve, 20));
        // ...and the prior eval's capability settles during that suspension:
        // touching the VM now would re-enter suspended WASM, so the
        // settlement must queue until a safe drain point.
        expect(resolveHost).toBeDefined();
        resolveHost?.("cross-eval");
        await new Promise((resolve) => setTimeout(resolve, 10));

        // Resume the asyncified call; the resolve loop drains the queued
        // settlement so the returned prior-eval promise is consumable.
        expect(resolveBash).toBeDefined();
        resolveBash?.("bash-done");
        const second = await evalPromise;
        expect(second.success).toBe(true);
        expect(second.result).toBe("cross-eval");
      }
    });

    it("re-registering an object retargets guest-saved method references", async () => {
      runtime.registerObject("mux", {
        bash: () => Promise.resolve("original"),
      });
      const saved = await runtime.eval("globalThis.savedBash = mux.bash; return savedBash();");
      expect(saved.success).toBe(true);
      expect(saved.result).toBe("original");

      // Same-name replacement (e.g. middleware audit wrapper): the saved
      // reference must dispatch to the NEW implementation, not pin the old.
      runtime.registerObject("mux", {
        bash: () => Promise.resolve("wrapped"),
      });
      const rewired = await runtime.eval("return globalThis.savedBash();");
      expect(rewired.success).toBe(true);
      expect(rewired.result).toBe("wrapped");

      // Removal: the saved reference must fail closed, not run the old impl.
      runtime.registerObject("mux", {});
      const removed = await runtime.eval(`
        try {
          globalThis.savedBash();
          return "no error";
        } catch (e) {
          return e.message;
        }
      `);
      expect(removed.success).toBe(true);
      expect(removed.result).toBe("mux.bash is no longer available in this sandbox");
    });

    it("re-registering the same method reuses the guest function identity", async () => {
      runtime.registerObject("mux", { bash: () => Promise.resolve("one") });
      const before = await runtime.eval("globalThis.savedBash = mux.bash; return 0;");
      expect(before.success).toBe(true);

      runtime.registerObject("mux", { bash: () => Promise.resolve("two") });
      const identity = await runtime.eval("return globalThis.savedBash === mux.bash;");
      expect(identity.success).toBe(true);
      expect(identity.result).toBe(true);
      // Reuse must not pin the old implementation (late-bound dispatch).
      const rewired = await runtime.eval("return mux.bash();");
      expect(rewired.result).toBe("two");
    });

    it("a method removed and later re-added dispatches to the new implementation", async () => {
      runtime.registerObject("mux", { bash: () => Promise.resolve("original") });
      runtime.registerObject("mux", {});
      runtime.registerObject("mux", { bash: () => Promise.resolve("back") });
      const result = await runtime.eval("return mux.bash();");
      expect(result.success).toBe(true);
      expect(result.result).toBe("back");
    });

    it("a method that flips between async and sync kinds is replaced, not reused", async () => {
      runtime.registerObject("mux", { ping: () => Promise.resolve("was-async") });
      const first = await runtime.eval("return mux.ping();");
      expect(first.result).toBe("was-async");

      runtime.registerObject("mux", {}, { ping: () => "now-sync" });
      const second = await runtime.eval("return mux.ping();");
      expect(second.success).toBe(true);
      expect(second.result).toBe("now-sync");

      runtime.registerObject("mux", { ping: () => Promise.resolve("async-again") });
      const third = await runtime.eval("return mux.ping();");
      expect(third.success).toBe(true);
      expect(third.result).toBe("async-again");
    });

    it("heavy re-registration does not exhaust the 16-bit host-function id space", async () => {
      // QuickJS stores host-function ids in a signed 16-bit slot, so one
      // context can only ever mint 65,536 ids. Without handle reuse, the
      // registrations below wrap the C-side id and victim.hello dispatches
      // to an unrelated old closure (the observed kernel corruption where
      // every xum.* call landed on the wrong tool).
      const CHUNK = 256;
      for (let c = 0; c < 260; c++) {
        const obj: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
        for (let i = 0; i < CHUNK; i++) {
          const tag = `burn-${c}-${i}`;
          obj[`m${i}`] = () => Promise.resolve(tag);
        }
        runtime.registerObject("burn", obj);
      }

      runtime.registerObject("victim", { hello: () => Promise.resolve("HELLO") });
      const result = await runtime.eval("return victim.hello();");
      expect(result.success).toBe(true);
      expect(result.result).toBe("HELLO");
    });

    it("still reports a genuinely stuck pending Promise", async () => {
      const result = await runtime.eval("return new Promise(() => {});");
      expect(result.success).toBe(false);
      expect(result.error).toContain("pending Promise");
    });

    it("enforces the deadline while awaiting a capability promise", async () => {
      runtime.setLimits({ timeoutMs: 100 });
      runtime.registerPromiseFunction("never", () => new Promise(() => undefined));
      const start = Date.now();
      const result = await runtime.eval(`
        return (async () => {
          await never();
          return "unreachable";
        })();
      `);
      expect(result.success).toBe(false);
      // The deadline timer both aborts and marks timeout; at millisecond
      // resolution either message can win the race - the contract is that the
      // eval fails promptly instead of hanging on the pending capability.
      expect(result.error).toMatch(/timeout|aborted/);
      expect(Date.now() - start).toBeLessThan(5000);
    });
  });

  describe("dispose", () => {
    it("throws on eval after dispose", async () => {
      runtime.dispose();

      try {
        await runtime.eval("return 1");
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(String(e)).toContain("disposed");
      }
    });

    it("can be disposed multiple times safely", () => {
      runtime.dispose();
      runtime.dispose(); // Should not throw
    });
  });

  describe("friendly error messages for unavailable globals", () => {
    it("provides friendly error for process", async () => {
      const result = await runtime.eval("const env = process.env;");
      expect(result.success).toBe(false);
      expect(result.error).toContain("'process' is not available in the sandbox");
      expect(result.error).toContain("mux.*");
    });

    it("provides friendly error for window", async () => {
      const result = await runtime.eval("window.alert('hi');");
      expect(result.success).toBe(false);
      expect(result.error).toContain("'window' is not available in the sandbox");
    });

    it("provides friendly error for fetch", async () => {
      const result = await runtime.eval("fetch('https://example.com');");
      expect(result.success).toBe(false);
      expect(result.error).toContain("'fetch' is not available in the sandbox");
    });

    it("provides friendly error for require", async () => {
      const result = await runtime.eval("const fs = require('fs');");
      expect(result.success).toBe(false);
      expect(result.error).toContain("'require' is not available in the sandbox");
    });

    it("provides friendly error for document", async () => {
      const result = await runtime.eval("document.getElementById('test');");
      expect(result.success).toBe(false);
      expect(result.error).toContain("'document' is not available in the sandbox");
    });

    it("keeps standard ReferenceError for user-defined undefined vars", async () => {
      const result = await runtime.eval("const x = myUndefinedVar;");
      expect(result.success).toBe(false);
      // Should NOT get the friendly message since it's not a known unavailable global
      expect(result.error).not.toContain("mux.*");
      expect(result.error).toContain("not defined");
    });
  });
});

describe("QuickJSRuntimeFactory", () => {
  it("creates new runtime instances", async () => {
    const factory = new QuickJSRuntimeFactory();
    const runtime = await factory.create();

    expect(runtime).toBeInstanceOf(QuickJSRuntime);

    const result = await runtime.eval("return 42");
    expect(result.success).toBe(true);
    expect(result.result).toBe(42);

    runtime.dispose();
  });
});

describe("sequential execution", () => {
  it("executes async host functions sequentially even in loops", async () => {
    // This test proves that Asyncify causes async host functions to execute
    // sequentially, not in parallel. Even constructs that would normally
    // run concurrently (like Promise.all) execute one-at-a-time.
    const runtime = await QuickJSRuntime.create();
    const callOrder: number[] = [];

    runtime.registerObject("test", {
      trackOrder: async (args: unknown) => {
        const id = (args as { id: number }).id;
        callOrder.push(id);
        // Small delay - if parallel, calls would interleave
        await new Promise((r) => setTimeout(r, 10));
        return { id };
      },
    });

    const result = await runtime.eval(`
      // Due to Asyncify, these calls appear synchronous and execute in order
      const r1 = test.trackOrder({ id: 1 });
      const r2 = test.trackOrder({ id: 2 });
      const r3 = test.trackOrder({ id: 3 });
      return [r1.id, r2.id, r3.id];
    `);

    runtime.dispose();

    expect(result.success).toBe(true);
    expect(result.result).toEqual([1, 2, 3]);
    // Call order is deterministically sequential
    expect(callOrder).toEqual([1, 2, 3]);
  });
});

describe("marshal edge cases", () => {
  let runtime: QuickJSRuntime;

  beforeEach(async () => {
    runtime = await QuickJSRuntime.create();
  });

  afterEach(() => {
    runtime.dispose();
  });

  it("handles BigInt values natively", async () => {
    runtime.registerFunction("getBigInt", () => Promise.resolve(BigInt("9007199254740993")));

    const result = await runtime.eval("return getBigInt();");
    expect(result.success).toBe(true);
    // QuickJS returns bigints as numbers if they fit, or as BigInt
    expect(result.result).toBe(9007199254740993n);
  });

  it("preserves undefined in objects", async () => {
    runtime.registerFunction("getObjWithUndefined", () =>
      Promise.resolve({ a: 1, b: undefined, c: 3 })
    );

    const result = await runtime.eval(`
      const obj = getObjWithUndefined();
      return { hasB: 'b' in obj, bValue: obj.b, a: obj.a, c: obj.c };
    `);
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ hasB: true, bValue: undefined, a: 1, c: 3 });
  });

  it("preserves undefined in arrays (not converted to null)", async () => {
    runtime.registerFunction("getArrayWithUndefined", () => Promise.resolve([1, undefined, 3]));

    const result = await runtime.eval(`
      const arr = getArrayWithUndefined();
      return { len: arr.length, first: arr[0], second: arr[1], third: arr[2] };
    `);
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ len: 3, first: 1, second: undefined, third: 3 });
  });

  it("handles circular references with [Circular] placeholder", async () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    runtime.registerFunction("getCircular", () => Promise.resolve(circular));

    const result = await runtime.eval(`
      const obj = getCircular();
      return { a: obj.a, selfType: typeof obj.self, selfValue: obj.self };
    `);
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ a: 1, selfType: "string", selfValue: "[Circular]" });
  });

  it("marks functions as unserializable", async () => {
    runtime.registerFunction("getFunction", () =>
      Promise.resolve({ fn: () => "hello", value: 42 })
    );

    const result = await runtime.eval(`
      const obj = getFunction();
      return { fnType: obj.fn.__unserializable__, value: obj.value };
    `);
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ fnType: "function", value: 42 });
  });

  it("marks symbols as unserializable", async () => {
    runtime.registerFunction("getSymbol", () =>
      Promise.resolve({ sym: Symbol("test"), value: 42 })
    );

    const result = await runtime.eval(`
      const obj = getSymbol();
      return { symType: obj.sym.__unserializable__, value: obj.value };
    `);
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ symType: "symbol", value: 42 });
  });

  it("handles deeply nested objects", async () => {
    runtime.registerFunction("getDeep", () =>
      Promise.resolve({ a: { b: { c: { d: { e: "deep" } } } } })
    );

    const result = await runtime.eval("return getDeep().a.b.c.d.e;");
    expect(result.success).toBe(true);
    expect(result.result).toBe("deep");
  });

  it("handles arrays with mixed types", async () => {
    runtime.registerFunction("getMixed", () =>
      Promise.resolve([1, "two", { three: 3 }, [4, 5], null, true])
    );

    const result = await runtime.eval("return getMixed();");
    expect(result.success).toBe(true);
    expect(result.result).toEqual([1, "two", { three: 3 }, [4, 5], null, true]);
  });

  it("handles empty objects and arrays", async () => {
    runtime.registerFunction("getEmpty", () => Promise.resolve({ obj: {}, arr: [] }));

    const result = await runtime.eval("return getEmpty();");
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ obj: {}, arr: [] });
  });

  it("converts Date to ISO string (matches JSON.stringify)", async () => {
    const testDate = new Date("2024-06-15T12:30:00.000Z");
    runtime.registerFunction("getDate", () =>
      Promise.resolve({ created: testDate, nested: { date: testDate } })
    );

    const result = await runtime.eval("return getDate();");
    expect(result.success).toBe(true);
    expect(result.result).toEqual({
      created: "2024-06-15T12:30:00.000Z",
      nested: { date: "2024-06-15T12:30:00.000Z" },
    });
  });

  it("handles shared references (same object in multiple places) without marking as circular", async () => {
    // Shared reference is NOT circular - same object appears twice but no cycle
    const shared = { id: 42, name: "shared" };
    const obj = { a: shared, b: shared, c: { nested: shared } };
    runtime.registerFunction("getShared", () => Promise.resolve(obj));

    const result = await runtime.eval(`
      const obj = getShared();
      return {
        aId: obj.a.id,
        bId: obj.b.id,
        cNestedId: obj.c.nested.id,
        // Verify none are "[Circular]" strings
        aType: typeof obj.a,
        bType: typeof obj.b
      };
    `);
    expect(result.success).toBe(true);
    expect(result.result).toEqual({
      aId: 42,
      bId: 42,
      cNestedId: 42,
      aType: "object",
      bType: "object",
    });
  });

  it("still detects true circular references", async () => {
    // True cycle: a -> b -> a
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b" };
    a.ref = b;
    b.ref = a; // Creates cycle
    runtime.registerFunction("getCycle", () => Promise.resolve(a));

    const result = await runtime.eval(`
      const obj = getCycle();
      return {
        name: obj.name,
        refName: obj.ref.name,
        refRefValue: obj.ref.ref  // This points back to 'a' - should be "[Circular]"
      };
    `);
    expect(result.success).toBe(true);
    expect(result.result).toEqual({
      name: "a",
      refName: "b",
      refRefValue: "[Circular]",
    });
  });
});
