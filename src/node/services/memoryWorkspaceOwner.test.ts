import { describe, expect, it } from "bun:test";
import type { Config } from "@/node/config";
import {
  resolveWorkspaceMemoryOwnerId,
  workspaceMemoryOwnerResolver,
} from "./memoryWorkspaceOwner";

type ProjectsConfig = ReturnType<Config["loadConfigOrDefault"]>;

function topology(workspaces: Array<{ id: string; parentWorkspaceId?: string }>): ProjectsConfig {
  return {
    projects: new Map([
      ["/tmp/project", { workspaces: workspaces.map((ws) => ({ path: `/tmp/${ws.id}`, ...ws })) }],
    ]),
  } as unknown as ProjectsConfig;
}

describe("resolveWorkspaceMemoryOwnerId", () => {
  it("resolves the task-tree root; unknown and parentless ids resolve to themselves", () => {
    const cfg = topology([
      { id: "ws-owner" },
      { id: "ws-child", parentWorkspaceId: "ws-owner" },
      { id: "ws-grandchild", parentWorkspaceId: "ws-child" },
      { id: "ws-solo" },
    ]);
    expect(resolveWorkspaceMemoryOwnerId(cfg, "ws-owner")).toBe("ws-owner");
    expect(resolveWorkspaceMemoryOwnerId(cfg, "ws-child")).toBe("ws-owner");
    expect(resolveWorkspaceMemoryOwnerId(cfg, "ws-grandchild")).toBe("ws-owner");
    expect(resolveWorkspaceMemoryOwnerId(cfg, "ws-solo")).toBe("ws-solo");
    expect(resolveWorkspaceMemoryOwnerId(cfg, "ws-unregistered")).toBe("ws-unregistered");
  });

  it("falls back to the acting workspace on a dangling parent, a cycle, or an over-deep chain", () => {
    // Dangling: the recorded parent is not registered (removed, or never was).
    const dangling = topology([
      { id: "ws-orphan", parentWorkspaceId: "ws-gone" },
      { id: "ws-deep", parentWorkspaceId: "ws-orphan" },
    ]);
    expect(resolveWorkspaceMemoryOwnerId(dangling, "ws-orphan")).toBe("ws-orphan");
    // A chain that dangles above the caller resolves to the CALLER, not to the
    // last registered ancestor: the fallback keeps the private store usable.
    expect(resolveWorkspaceMemoryOwnerId(dangling, "ws-deep")).toBe("ws-deep");

    const cycle = topology([
      { id: "ws-a", parentWorkspaceId: "ws-b" },
      { id: "ws-b", parentWorkspaceId: "ws-a" },
      { id: "ws-c", parentWorkspaceId: "ws-a" },
    ]);
    expect(resolveWorkspaceMemoryOwnerId(cycle, "ws-a")).toBe("ws-a");
    expect(resolveWorkspaceMemoryOwnerId(cycle, "ws-c")).toBe("ws-c");

    const deep = topology(
      Array.from({ length: 40 }, (_, i) => ({
        id: `ws-${i}`,
        ...(i === 0 ? {} : { parentWorkspaceId: `ws-${i - 1}` }),
      }))
    );
    expect(resolveWorkspaceMemoryOwnerId(deep, "ws-20")).toBe("ws-0");
    expect(resolveWorkspaceMemoryOwnerId(deep, "ws-39")).toBe("ws-39");
  });

  it("indexes a snapshot once and reuses the resolver for it", () => {
    const cfg = topology([{ id: "ws-owner" }, { id: "ws-child", parentWorkspaceId: "ws-owner" }]);
    const resolve = workspaceMemoryOwnerResolver(cfg);
    expect(workspaceMemoryOwnerResolver(cfg)).toBe(resolve);
    expect(resolve("ws-child")).toBe("ws-owner");
    // A different snapshot object gets its own index.
    expect(workspaceMemoryOwnerResolver(topology([{ id: "ws-owner" }]))).not.toBe(resolve);
  });
});
