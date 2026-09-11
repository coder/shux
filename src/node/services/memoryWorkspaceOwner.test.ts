import { describe, expect, it } from "bun:test";
import type { Config } from "@/node/config";
import {
  pinDescendantWorkspaceMemoryOwners,
  resolveWorkspaceMemoryOwnerId,
} from "./memoryWorkspaceOwner";

type ProjectsConfig = ReturnType<Config["loadConfigOrDefault"]>;

function topology(
  workspaces: Array<{ id: string; parentWorkspaceId?: string; memoryOwnerWorkspaceId?: string }>
): ProjectsConfig {
  return {
    projects: new Map([
      ["/tmp/project", { workspaces: workspaces.map((ws) => ({ path: `/tmp/${ws.id}`, ...ws })) }],
    ]),
  } as unknown as ProjectsConfig;
}

describe("pinDescendantWorkspaceMemoryOwners", () => {
  it("pins each surviving child to the owner it resolves to now", () => {
    const cfg = topology([
      { id: "ws-owner" },
      { id: "ws-other" },
      { id: "ws-mid", parentWorkspaceId: "ws-owner" },
      // No pin: the walk through ws-mid reaches ws-owner.
      { id: "ws-plain", parentWorkspaceId: "ws-mid" },
      // Stale pin (its owner is gone): the resolver walks past it today, but
      // once ws-mid is removed that walk would dangle — replaced.
      { id: "ws-stale", parentWorkspaceId: "ws-mid", memoryOwnerWorkspaceId: "ws-gone" },
      // Pin to another live notebook while the parent is still registered:
      // a state this code never writes (pins are recorded as an ancestor is
      // removed). The live chain wins — the child has been using ws-owner's
      // notebook — and the removal re-pins it to that (r84), rather than
      // letting corrupt raw config redirect it across task trees.
      { id: "ws-pinned", parentWorkspaceId: "ws-mid", memoryOwnerWorkspaceId: "ws-other" },
      // Not a child of the removed node: untouched.
      { id: "ws-sibling", parentWorkspaceId: "ws-owner" },
    ]);
    const before = Object.fromEntries(
      ["ws-plain", "ws-stale", "ws-pinned"].map((id) => [
        id,
        resolveWorkspaceMemoryOwnerId(cfg, id),
      ])
    );
    expect(before).toEqual({
      "ws-plain": "ws-owner",
      "ws-stale": "ws-owner",
      "ws-pinned": "ws-owner",
    });

    const pinned = pinDescendantWorkspaceMemoryOwners(cfg, "ws-mid");
    expect(Object.fromEntries(pinned)).toEqual(before);
    const entries = [...cfg.projects.values()][0].workspaces;
    const pinOf = (id: string) => entries.find((ws) => ws.id === id)!.memoryOwnerWorkspaceId;
    expect(pinOf("ws-plain")).toBe("ws-owner");
    expect(pinOf("ws-stale")).toBe("ws-owner");
    expect(pinOf("ws-pinned")).toBe("ws-owner");
    expect(pinOf("ws-sibling")).toBeUndefined();

    // With ws-mid gone, every pinned child still resolves as before.
    const after = topology(
      entries
        .filter((ws) => ws.id !== "ws-mid")
        .map((ws) => ({
          id: ws.id!,
          ...(ws.parentWorkspaceId === undefined
            ? {}
            : { parentWorkspaceId: ws.parentWorkspaceId }),
          ...(ws.memoryOwnerWorkspaceId === undefined
            ? {}
            : { memoryOwnerWorkspaceId: ws.memoryOwnerWorkspaceId }),
        }))
    );
    for (const [id, owner] of Object.entries(before)) {
      expect(resolveWorkspaceMemoryOwnerId(after, id)).toBe(owner);
    }
  });

  it("honors a pin only once the recorded parent is gone", () => {
    const live = topology([
      { id: "ws-owner" },
      { id: "ws-other" },
      { id: "ws-child", parentWorkspaceId: "ws-owner", memoryOwnerWorkspaceId: "ws-other" },
      { id: "ws-grand", parentWorkspaceId: "ws-child" },
    ]);
    // Parent registered: the chain decides, for the child and everything below it.
    expect(resolveWorkspaceMemoryOwnerId(live, "ws-child")).toBe("ws-owner");
    expect(resolveWorkspaceMemoryOwnerId(live, "ws-grand")).toBe("ws-owner");
    // Parent gone: the (live) pin decides; a pin whose owner is gone too
    // leaves the child on its own store.
    const dangling = topology([
      { id: "ws-other" },
      { id: "ws-child", parentWorkspaceId: "ws-owner", memoryOwnerWorkspaceId: "ws-other" },
      { id: "ws-grand", parentWorkspaceId: "ws-child" },
      { id: "ws-orphan", parentWorkspaceId: "ws-owner", memoryOwnerWorkspaceId: "ws-gone" },
    ]);
    expect(resolveWorkspaceMemoryOwnerId(dangling, "ws-child")).toBe("ws-other");
    expect(resolveWorkspaceMemoryOwnerId(dangling, "ws-grand")).toBe("ws-other");
    expect(resolveWorkspaceMemoryOwnerId(dangling, "ws-orphan")).toBe("ws-orphan");
  });
});
