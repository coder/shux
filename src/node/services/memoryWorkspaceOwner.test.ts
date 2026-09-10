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
      // Valid pin to another live notebook: that is the notebook this child
      // uses; kept (continuity), not redirected to ws-mid's owner.
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
      "ws-pinned": "ws-other",
    });

    const pinned = pinDescendantWorkspaceMemoryOwners(cfg, "ws-mid");
    expect(Object.fromEntries(pinned)).toEqual(before);
    const entries = [...cfg.projects.values()][0].workspaces;
    const pinOf = (id: string) => entries.find((ws) => ws.id === id)!.memoryOwnerWorkspaceId;
    expect(pinOf("ws-plain")).toBe("ws-owner");
    expect(pinOf("ws-stale")).toBe("ws-owner");
    expect(pinOf("ws-pinned")).toBe("ws-other");
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
});
