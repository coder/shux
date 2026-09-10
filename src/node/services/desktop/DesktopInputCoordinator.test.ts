import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Workspace } from "@/common/types/project";
import { Config } from "@/node/config";
import {
  DesktopInputCoordinator,
  settleArchivedSharedDesktopTask,
} from "./DesktopInputCoordinator";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function workspace(id: string, fields: Partial<Workspace> = {}): Workspace {
  return { id, name: id, path: `/tmp/desktop-coordinator/${id}`, ...fields };
}

const owner = workspace("owner");
const borrower = (id: string, fields: Partial<Workspace> = {}) =>
  workspace(id, {
    parentWorkspaceId: "owner",
    taskDesktopOwnerWorkspaceId: "owner",
    taskStatus: "reported",
    ...fields,
  });

async function withCoordinator(
  run: (
    coordinator: DesktopInputCoordinator,
    write: (workspaces: Workspace[]) => Promise<void>,
    config: Config
  ) => Promise<void>
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-coordinator-"));
  const config = new Config(root);
  const write = async (workspaces: Workspace[]) => {
    await config.editConfig((current) => {
      current.projects.set("/tmp/desktop-coordinator", { workspaces });
      return current;
    });
  };
  try {
    await write([owner, borrower("child")]);
    await run(new DesktopInputCoordinator(config), write, config);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("DesktopInputCoordinator", () => {
  test("resolves flattened ancestry and leaves legacy children isolated", async () => {
    await withCoordinator(async (coordinator, write) => {
      await write([
        owner,
        borrower("child"),
        borrower("nested", { parentWorkspaceId: "child" }),
        workspace("legacy", {
          parentWorkspaceId: "child",
          runtimeConfig: { type: "worktree", srcBaseDir: "/tmp" },
        }),
      ]);
      expect(coordinator.resolveTarget("nested")).toEqual({
        ownerWorkspaceId: "owner",
        ownerName: "owner",
      });
      expect(coordinator.resolveTarget("legacy").ownerWorkspaceId).toBe("legacy");
      await write([{ ...owner, name: "renamed" }, borrower("child")]);
      expect(coordinator.resolveTarget("child").ownerName).toBe("renamed");
    });
  });

  test("rejects missing, unrelated, cyclic, chained, archived, and unsupported targets", async () => {
    await withCoordinator(async (coordinator, write) => {
      const invalid: Array<{ entries: Workspace[]; message: string }> = [
        { entries: [borrower("child")], message: "not found" },
        { entries: [owner], message: "not found" },
        {
          entries: [owner, borrower("child", { parentWorkspaceId: undefined })],
          message: "not an ancestor",
        },
        {
          entries: [{ ...owner, parentWorkspaceId: "child" }, borrower("child")],
          message: "cycle",
        },
        {
          entries: [owner, borrower("child", { parentWorkspaceId: "missing" })],
          message: "ancestor workspace not found",
        },
        {
          entries: [{ ...owner, taskDesktopOwnerWorkspaceId: "other" }, borrower("child")],
          message: "itself be bound",
        },
        {
          entries: [owner, borrower("child", { taskDesktopOwnerWorkspaceId: "child" })],
          message: "itself be bound",
        },
        {
          entries: [owner, borrower("child", { taskDesktopOwnerWorkspaceId: "" })],
          message: "Invalid desktop owner",
        },
        {
          entries: [{ ...owner, archivedAt: "2026-09-01T00:00:00Z" }, borrower("child")],
          message: "archived",
        },
        {
          entries: [owner, borrower("child", { archivedAt: "2026-09-01T00:00:00Z" })],
          message: "archived",
        },
        {
          entries: [
            { ...owner, runtimeConfig: { type: "ssh", host: "host", srcBaseDir: "/tmp" } },
            borrower("child"),
          ],
          message: "Unsupported desktop runtime",
        },
        {
          entries: [
            owner,
            borrower("child", { runtimeConfig: { type: "docker", image: "image" } }),
          ],
          message: "Unsupported desktop runtime",
        },
      ];
      for (const { entries, message } of invalid) {
        await write(entries);
        expect(() => coordinator.resolveTarget("child")).toThrow(message);
      }
    });
  });

  test("only the single active borrower can input and either lifecycle status claims control", async () => {
    await withCoordinator(async (coordinator, write) => {
      const states: Array<Partial<Workspace>> = [
        ...(["queued", "starting", "running", "awaiting_report"] as const).map((taskStatus) => ({
          taskStatus,
        })),
        ...(["queued", "starting", "running"] as const).map((taskExecutionStatus) => ({
          taskExecutionStatus,
        })),
      ];
      for (const state of states) {
        await write([owner, borrower("child", state), borrower("other")]);
        expect(await coordinator.withInput("child", () => Promise.resolve("input"))).toBe("input");
        expect(coordinator.withInput("owner", () => Promise.resolve())).rejects.toThrow(
          "controlled by"
        );
        expect(coordinator.withInput("other", () => Promise.resolve())).rejects.toThrow(
          "controlled by"
        );
      }
      await write([owner, borrower("child")]);
      expect(coordinator.withInput("child", () => Promise.resolve())).rejects.toThrow("not active");
      expect(await coordinator.withInput("owner", () => Promise.resolve("input"))).toBe("input");
      await write([
        owner,
        borrower("child", { taskStatus: "running" }),
        borrower("other", { taskExecutionStatus: "running" }),
      ]);
      for (const id of ["owner", "child", "other"]) {
        expect(coordinator.withInput(id, () => Promise.resolve())).rejects.toThrow(
          "multiple active"
        );
      }
    });
  });

  test("an archived borrower with a stale active status neither holds nor blocks the desktop", async () => {
    await withCoordinator(async (coordinator, write) => {
      const archivedAt = "2026-09-01T00:00:00Z";
      for (const stale of [
        { taskStatus: "queued" as const },
        { taskExecutionStatus: "running" as const },
      ]) {
        await write([owner, borrower("child", { ...stale, archivedAt }), borrower("other")]);
        // Codex P1: the stale row was counted as a borrower and then failed the archived check,
        // wedging every owner input and admission until the child was unarchived.
        expect(await coordinator.withInput("owner", () => Promise.resolve("input"))).toBe("input");
        expect(await coordinator.withAdmission("other", () => Promise.resolve("admit"))).toBe(
          "admit"
        );
        expect(
          await coordinator.withReservation("owner", "next", () => Promise.resolve("reserved"))
        ).toBe("reserved");
        // The archived requester itself stays denied.
        expect(coordinator.withInput("child", () => Promise.resolve())).rejects.toThrow("archived");
        expect(coordinator.withAdmission("child", () => Promise.resolve())).rejects.toThrow(
          "archived"
        );
      }
      // Control is only released by archival: the same stale row unarchived blocks again.
      await write([
        owner,
        borrower("child", {
          taskStatus: "queued",
          archivedAt,
          unarchivedAt: "2026-09-02T00:00:00Z",
        }),
        borrower("other"),
      ]);
      expect(coordinator.withInput("owner", () => Promise.resolve())).rejects.toThrow(
        "controlled by"
      );
    });
  });

  test("unarchiving a stale execution mirror cannot steal a sibling's desktop", async () => {
    await withCoordinator(async (coordinator, write) => {
      for (const taskExecutionStatus of ["queued", "starting", "running"] as const) {
        const restored = borrower("restored", {
          taskExecutionId: "old-execution",
          taskExecutionStatus,
          archivedAt: "2026-09-01T00:00:00Z",
        });
        settleArchivedSharedDesktopTask(restored);
        restored.unarchivedAt = "2026-09-02T00:00:00Z";
        await write([owner, restored, borrower("active", { taskStatus: "running" })]);
        expect(await coordinator.withInput("active", () => Promise.resolve("input"))).toBe("input");
        expect(restored.taskExecutionStatus).toBe("interrupted");
        expect(restored.taskExecutionId).toBe("old-execution");
        expect(coordinator.withAdmission("restored", () => Promise.resolve())).rejects.toThrow(
          "controlled by active borrower active"
        );
      }
    });
  });

  test("settleArchivedSharedDesktopTask interrupts only bound active children and keeps queued briefs", () => {
    for (const taskStatus of ["queued", "starting", "running", "awaiting_report"] as const) {
      const child = borrower("child", { taskStatus, taskPrompt: "brief" });
      expect(settleArchivedSharedDesktopTask(child)).toBe(true);
      expect(child.taskStatus).toBe("interrupted");
      expect(child.taskPrompt).toBe("brief");
    }
    const untouched: Workspace[] = [
      borrower("reported"),
      borrower("interrupted", { taskStatus: "interrupted" }),
      workspace("isolated", { parentWorkspaceId: "owner", taskStatus: "queued" }),
      workspace("owner-running", { taskStatus: "running" }),
    ];
    for (const entry of untouched) {
      const before = { ...entry };
      expect(settleArchivedSharedDesktopTask(entry)).toBe(false);
      expect(entry).toEqual(before);
    }
  });

  test("an open input holds admission, then persisted admission blocks later owner input", async () => {
    await withCoordinator(async (coordinator, write) => {
      const entered = deferred();
      const release = deferred();
      let admitted = false;
      const input = coordinator.withInput("owner", async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const admission = coordinator.withAdmission("child", async () => {
        admitted = true;
        await write([owner, borrower("child", { taskStatus: "running" })]);
      });
      const nextInput = coordinator.withInput("owner", () => Promise.resolve());
      const rejectedInput = nextInput.catch((error: unknown) => error);
      expect(admitted).toBe(false);
      release.resolve();
      await Promise.all([input, admission]);
      expect(String(await rejectedInput)).toContain("controlled by");
      expect(admitted).toBe(true);
    });
  });

  test.each(["admission", "reservation"] as const)(
    "another backend's %s waits for the owner's in-flight input",
    async (mode) => {
      await withCoordinator(async (coordinator, write, config) => {
        const other = new DesktopInputCoordinator(new Config(config.rootDir));
        const entered = deferred();
        const release = deferred();
        const events: string[] = [];
        const input = coordinator.withInput("owner", async () => {
          entered.resolve();
          await release.promise;
          events.push("input finished");
        });
        await entered.promise;
        const admit = async () => {
          events.push("admitted");
          await write([owner, borrower("child", { taskStatus: "running" })]);
        };
        const admission =
          mode === "admission"
            ? other.withAdmission("child", admit)
            : other.withReservation("owner", "child", admit);
        try {
          // Flush the independent coordinator's local gate; it must still wait for owner input.
          await Promise.resolve();
          expect(events).toEqual([]);
        } finally {
          release.resolve();
          await Promise.all([input, admission]);
        }
        expect(events).toEqual(["input finished", "admitted"]);
        expect(await other.withInput("child", () => Promise.resolve("clicked"))).toBe("clicked");
        expect(coordinator.withInput("owner", () => Promise.resolve())).rejects.toThrow(
          "controlled by"
        );
      });
    }
  );

  test("overlapping reservations observe persisted winners and permit the same borrower", async () => {
    await withCoordinator(async (coordinator, write) => {
      const entered = deferred();
      const release = deferred();
      let losingCallback = false;
      const first = coordinator.withReservation("owner", "first", async () => {
        entered.resolve();
        await release.promise;
        await write([owner, borrower("first", { taskStatus: "queued" })]);
      });
      await entered.promise;
      const second = coordinator.withReservation("owner", "second", () => {
        losingCallback = true;
        return Promise.resolve();
      });
      const rejected = second.catch((error: unknown) => error);
      release.resolve();
      await first;
      expect(String(await rejected)).toContain("controlled by");
      expect(losingCallback).toBe(false);
      expect(
        await coordinator.withReservation("owner", "first", () => Promise.resolve("same"))
      ).toBe("same");
    });
  });

  test("mixed-owner batches lock in stable order and validate every owner before admission", async () => {
    await withCoordinator(async (coordinator, write) => {
      const otherOwner = workspace("other-owner");
      const otherChild = borrower("other-child", {
        parentWorkspaceId: "other-owner",
        taskDesktopOwnerWorkspaceId: "other-owner",
      });
      await write([owner, otherOwner, borrower("child"), otherChild]);
      const reservations = [
        { ownerWorkspaceId: "owner", borrowerWorkspaceId: "child" },
        { ownerWorkspaceId: "other-owner", borrowerWorkspaceId: "other-child" },
      ];
      // Both calls begin before either owns its second gate: opposite input ordering must
      // not let each batch hold one owner's gate while waiting forever for the other.
      expect(
        await Promise.all([
          coordinator.withReservations(reservations, () => Promise.resolve("forward")),
          coordinator.withReservations([...reservations].reverse(), () =>
            Promise.resolve("reverse")
          ),
        ])
      ).toEqual(["forward", "reverse"]);
      const entered = deferred();
      const release = deferred();
      const first = coordinator.withReservations(reservations, async () => {
        entered.resolve();
        await release.promise;
        await write([
          owner,
          otherOwner,
          borrower("child", { taskStatus: "queued" }),
          { ...otherChild, taskStatus: "queued" },
        ]);
      });
      await entered.promise;
      let secondEntered = false;
      const second = coordinator.withReservations([...reservations].reverse(), () => {
        secondEntered = true;
        return Promise.resolve("same borrowers");
      });
      const input = coordinator
        .withInput("other-owner", () => Promise.resolve())
        .catch((error: unknown) => error);
      expect(secondEntered).toBe(false);
      release.resolve();
      await first;
      expect(await second).toBe("same borrowers");
      expect(String(await input)).toContain("controlled by");

      let admitted = false;
      expect(
        coordinator.withReservations(
          [
            { ownerWorkspaceId: "owner", borrowerWorkspaceId: "child" },
            { ownerWorkspaceId: "other-owner", borrowerWorkspaceId: "competitor" },
          ],
          () => {
            admitted = true;
            return Promise.resolve();
          }
        )
      ).rejects.toThrow("controlled by");
      expect(admitted).toBe(false);
    });
  });

  test("rejects conflicting batch owners before callbacks and deduplicates identical reservations", async () => {
    await withCoordinator(async (coordinator) => {
      let admissions = 0;
      const reserve = () => {
        admissions += 1;
        return Promise.resolve(admissions);
      };
      expect(
        coordinator.withReservations(
          [
            { ownerWorkspaceId: "owner", borrowerWorkspaceId: "child" },
            { ownerWorkspaceId: "owner", borrowerWorkspaceId: "other" },
          ],
          reserve
        )
      ).rejects.toThrow("multiple borrowers in one batch");
      expect(admissions).toBe(0);
      expect(
        await coordinator.withReservations(
          [
            { ownerWorkspaceId: "owner", borrowerWorkspaceId: "child" },
            { ownerWorkspaceId: "owner", borrowerWorkspaceId: "child" },
          ],
          reserve
        )
      ).toBe(1);
      expect(await coordinator.withReservations([], reserve)).toBe(2);
    });
  });

  test("revalidates queued operations and releases the gate after failures", async () => {
    await withCoordinator(async (coordinator, write) => {
      const entered = deferred();
      const release = deferred();
      const first = coordinator.withInput("owner", async () => {
        entered.resolve();
        await release.promise;
        throw new Error("input failed");
      });
      const failed = first.catch((error: unknown) => error);
      await entered.promise;
      const admission = coordinator.withAdmission("child", () => Promise.resolve());
      const rejected = admission.catch((error: unknown) => error);
      await write([owner]);
      release.resolve();
      expect(String(await failed)).toContain("input failed");
      expect(String(await rejected)).toContain("not found");
      expect(await coordinator.withInput("owner", () => Promise.resolve("released"))).toBe(
        "released"
      );
    });
  });

  test("isolated remote admissions are unchanged and unrelated owners do not block", async () => {
    await withCoordinator(async (coordinator, write) => {
      await write([
        owner,
        workspace("remote", { runtimeConfig: { type: "ssh", host: "host", srcBaseDir: "/tmp" } }),
        workspace("other"),
      ]);
      const entered = deferred();
      const release = deferred();
      const input = coordinator.withInput("owner", async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      try {
        expect(await coordinator.withAdmission("remote", () => Promise.resolve("admitted"))).toBe(
          "admitted"
        );
        expect(await coordinator.withInput("other", () => Promise.resolve("input"))).toBe("input");
      } finally {
        release.resolve();
        await input;
      }
    });
  });
});
