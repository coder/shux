import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  advanceWorkspaceMemoryRevision,
  readWorkspaceMemoryRevision,
  workspaceMemoryRevisionPath,
} from "./workspaceMemoryRevision";

describe("advanceWorkspaceMemoryRevision", () => {
  let sessionDir: string;
  beforeEach(async () => {
    sessionDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "xum-memory-revision-"));
  });
  afterEach(async () => {
    await fsPromises.rm(sessionDir, { recursive: true, force: true });
  });

  it("advances monotonically past a clock that runs ahead of wall time", async () => {
    const ahead = Date.now() + 60_000;
    await fsPromises.writeFile(workspaceMemoryRevisionPath(sessionDir), String(ahead));
    expect(await advanceWorkspaceMemoryRevision(sessionDir)).toBe(ahead + 1);
    expect(await readWorkspaceMemoryRevision(sessionDir)).toBe(ahead + 1);
  });

  it("refuses to advance an exhausted clock and leaves the file as it is", async () => {
    // 2^53 - 1 reads as valid, but `+ 1` is no longer a safe integer: writing
    // it would persist a value the strict reader rejects forever.
    const revisionPath = workspaceMemoryRevisionPath(sessionDir);
    await fsPromises.writeFile(revisionPath, String(Number.MAX_SAFE_INTEGER));
    const attempt = advanceWorkspaceMemoryRevision(sessionDir);
    expect(
      await attempt.then(
        () => null,
        (error: unknown) => String(error)
      )
    ).toContain("exhausted");
    expect(await fsPromises.readFile(revisionPath, "utf-8")).toBe(String(Number.MAX_SAFE_INTEGER));
  });
});
