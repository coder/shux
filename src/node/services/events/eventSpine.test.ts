import { describe, expect, test } from "bun:test";
import { EventSpine, type ToolExecuteContext, type ToolExecutionHost } from "./eventSpine";
import type { Runtime } from "@/node/runtime/Runtime";

// The spine never touches the host runtime; a null-backed stub is sufficient.
const stubRuntime = null as unknown as Runtime;

function makeToolCtx(overrides?: Partial<ToolExecuteContext>): ToolExecuteContext {
  const host: ToolExecutionHost = {
    runtime: stubRuntime,
    runtimeTempDir: "/tmp",
    cwd: "/tmp",
    workspaceId: "ws-test",
  };
  return { toolName: "test_tool", args: { a: 1 }, host, executed: false, ...overrides };
}

describe("EventSpine waterfall", () => {
  test("runs terminal when no middleware is registered", async () => {
    const spine = new EventSpine();
    const ctx = makeToolCtx();
    await spine.run("tool.execute", ctx, (c) => {
      c.result = "ran";
      c.executed = true;
    });
    expect(ctx.result).toBe("ran");
    expect(ctx.executed).toBe(true);
  });

  test("middleware composes around the terminal in registration order", async () => {
    const spine = new EventSpine();
    const calls: string[] = [];
    spine.use("tool.execute", async (_ctx, next) => {
      calls.push("a:before");
      await next();
      calls.push("a:after");
    });
    spine.use("tool.execute", async (_ctx, next) => {
      calls.push("b:before");
      await next();
      calls.push("b:after");
    });
    await spine.run("tool.execute", makeToolCtx(), () => {
      calls.push("terminal");
    });
    expect(calls).toEqual(["a:before", "b:before", "terminal", "b:after", "a:after"]);
  });

  test("explicit order overrides registration order", async () => {
    const spine = new EventSpine();
    const calls: string[] = [];
    spine.use(
      "tool.execute",
      async (_ctx, next) => {
        calls.push("late");
        await next();
      },
      { order: 10 }
    );
    spine.use(
      "tool.execute",
      async (_ctx, next) => {
        calls.push("early");
        await next();
      },
      { order: -10 }
    );
    await spine.run("tool.execute", makeToolCtx());
    expect(calls).toEqual(["early", "late"]);
  });

  test("blocking middleware skips terminal and downstream middleware", async () => {
    const spine = new EventSpine();
    const calls: string[] = [];
    spine.use("tool.execute", (ctx, _next) => {
      ctx.blocked = { result: { error: "denied" } };
      calls.push("blocker");
    });
    spine.use("tool.execute", async (_ctx, next) => {
      calls.push("downstream");
      await next();
    });
    const ctx = makeToolCtx();
    await spine.run("tool.execute", ctx, () => {
      calls.push("terminal");
    });
    expect(calls).toEqual(["blocker"]);
    expect(ctx.blocked?.result).toEqual({ error: "denied" });
    expect(ctx.executed).toBe(false);
  });

  test("middleware may rewrite args before terminal and result after", async () => {
    const spine = new EventSpine();
    spine.use("tool.execute", async (ctx, next) => {
      ctx.args = { a: 2 };
      await next();
      ctx.result = `${String(ctx.result)}+audited`;
    });
    const ctx = makeToolCtx();
    await spine.run("tool.execute", ctx, (c) => {
      c.result = `ran(${JSON.stringify(c.args)})`;
      c.executed = true;
    });
    expect(ctx.result).toBe('ran({"a":2})+audited');
  });

  test("calling next() twice throws", async () => {
    const spine = new EventSpine();
    spine.use("tool.execute", async (_ctx, next) => {
      await next();
      await next();
    });
    try {
      await spine.run("tool.execute", makeToolCtx());
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(String(e)).toContain("called next() more than once");
    }
  });

  test("useBefore/useAfter sugar wraps the pipeline; after is skipped when blocked", async () => {
    const spine = new EventSpine();
    const calls: string[] = [];
    spine.useBefore("tool.execute", (ctx) => {
      calls.push("before");
      if (ctx.toolName === "blocked_tool") {
        ctx.blocked = { result: { error: "no" } };
      }
    });
    spine.useAfter("tool.execute", () => {
      calls.push("after");
    });

    await spine.run("tool.execute", makeToolCtx(), (c) => {
      calls.push("terminal");
      c.executed = true;
    });
    expect(calls).toEqual(["before", "terminal", "after"]);

    calls.length = 0;
    const blockedCtx = makeToolCtx({ toolName: "blocked_tool" });
    await spine.run("tool.execute", blockedCtx, (c) => {
      calls.push("terminal");
      c.executed = true;
    });
    expect(calls).toEqual(["before"]);
    expect(blockedCtx.executed).toBe(false);
  });

  test("unregister removes middleware", async () => {
    const spine = new EventSpine();
    const calls: string[] = [];
    const unregister = spine.use("tool.execute", async (_ctx, next) => {
      calls.push("mw");
      await next();
    });
    expect(spine.hasMiddleware("tool.execute")).toBe(true);
    unregister();
    expect(spine.hasMiddleware("tool.execute")).toBe(false);
    await spine.run("tool.execute", makeToolCtx());
    expect(calls).toEqual([]);
  });
});

describe("request assembly snapshots", () => {
  function context(workspaceId = "one") {
    return { workspaceId, modelString: "model", systemMessage: "base", tools: {} };
  }

  test("scopes generic registrations in both live dispatch and certification", async () => {
    const spine = new EventSpine();
    spine.useBefore(
      "request.assemble",
      (ctx) => {
        ctx.systemMessage += " other";
      },
      { workspaceId: "two" }
    );
    expect(spine.captureRequestAssembly("one").preservesToolset).toBe(true);
    expect(spine.captureRequestAssembly("two").preservesToolset).toBe(false);
    const ctx = context();
    await spine.run("request.assemble", ctx);
    expect(ctx.systemMessage).toBe("base");
    spine.useAfter("request.assemble", () => undefined);
    expect(spine.captureRequestAssembly("one").preservesToolset).toBe(false);
  });

  test("context-only callbacks cannot see or replace tools", async () => {
    const spine = new EventSpine();
    spine.useRequestContext((ctx) => {
      expect("tools" in ctx).toBe(false);
      Reflect.set(ctx, "tools", { injected: {} });
      ctx.systemMessage += " context";
    });
    const snapshot = spine.captureRequestAssembly("one");
    const ctx = context();
    const tools = ctx.tools;
    expect(snapshot.preservesToolset).toBe(true);
    await snapshot.run(ctx);
    expect(ctx.tools).toBe(tools);
    expect(ctx.tools).toEqual({});
    expect(ctx.systemMessage).toBe("base context");
  });

  test("pins ordered registrations through unregister/register and awaited execution", async () => {
    const spine = new EventSpine();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    spine.useRequestContext(
      async (ctx) => {
        started.resolve();
        await release.promise;
        ctx.systemMessage += " first";
      },
      { order: -1 }
    );
    const unregister = spine.useRequestContext((ctx) => {
      ctx.systemMessage += " admitted";
    });
    const snapshot = spine.captureRequestAssembly("one");
    const ctx = context();
    const running = snapshot.run(ctx);
    await started.promise;
    unregister();
    spine.useRequestContext((next) => {
      next.systemMessage += " next";
    });
    release.resolve();
    await running;
    expect(ctx.systemMessage).toBe("base first admitted");
    const later = context();
    await spine.captureRequestAssembly("one").run(later);
    expect(later.systemMessage).toBe("base first next");
  });

  test("a snapshot rejects dispatch for a different workspace", async () => {
    const snapshot = new EventSpine().captureRequestAssembly("one");
    const error = await snapshot.run(context("two")).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
  });
});

describe("EventSpine observers", () => {
  test("fan-out delivers payloads and unsubscribe stops delivery", () => {
    const spine = new EventSpine();
    const seen: string[] = [];
    const unsubscribe = spine.subscribe("workspace.created", (p) => seen.push(p.workspaceId));
    spine.emit("workspace.created", { workspaceId: "ws-1" });
    unsubscribe();
    spine.emit("workspace.created", { workspaceId: "ws-2" });
    expect(seen).toEqual(["ws-1"]);
  });

  test("a throwing observer does not break the emitter or other observers", () => {
    const spine = new EventSpine();
    const seen: string[] = [];
    spine.subscribe("stream.start", () => {
      throw new Error("bad observer");
    });
    spine.subscribe("stream.start", (p) => seen.push(p.messageId));
    expect(() => spine.emit("stream.start", { workspaceId: "ws", messageId: "m1" })).not.toThrow();
    expect(seen).toEqual(["m1"]);
  });

  test("a rejecting async observer does not break the emitter or other observers", async () => {
    const spine = new EventSpine();
    const seen: string[] = [];
    spine.subscribe("stream.start", async () => {
      await Promise.resolve();
      throw new Error("bad async observer");
    });
    spine.subscribe("stream.start", (p) => seen.push(p.messageId));
    expect(() => spine.emit("stream.start", { workspaceId: "ws", messageId: "m1" })).not.toThrow();
    expect(seen).toEqual(["m1"]);
    // Let the rejection settle: it must be captured (logged), not surface as
    // an unhandled rejection that could take down the main process.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
