import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  ADDITIONAL_SYSTEM_CONTEXT_DISABLED_FILENAME,
  ADDITIONAL_SYSTEM_CONTEXT_FILENAME,
  effectiveAdditionalSystemContext,
  mergeAdditionalSystemInstructions,
  readAdditionalSystemContext,
  writeAdditionalSystemContext,
} from "./additionalSystemContext";

function createSessionDirProvider(root: string) {
  return {
    sessionsDir: root,
  };
}

describe("additionalSystemContext", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-additional-context-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("read/write persists workspace scratchpad content (enabled by default)", async () => {
    const config = createSessionDirProvider(tempDir);

    await writeAdditionalSystemContext(config, "workspace-1", {
      content: "Remember the API contract.",
      enabled: true,
    });

    await expect(readAdditionalSystemContext(config, "workspace-1")).resolves.toEqual({
      content: "Remember the API contract.",
      enabled: true,
    });
    await expect(
      fs.readFile(path.join(tempDir, "workspace-1", ADDITIONAL_SYSTEM_CONTEXT_FILENAME), "utf-8")
    ).resolves.toBe("Remember the API contract.");
  });

  test("empty content removes durable scratchpad file and disabled marker", async () => {
    const config = createSessionDirProvider(tempDir);
    const scratchpadPath = path.join(tempDir, "workspace-1", ADDITIONAL_SYSTEM_CONTEXT_FILENAME);
    const disabledPath = path.join(
      tempDir,
      "workspace-1",
      ADDITIONAL_SYSTEM_CONTEXT_DISABLED_FILENAME
    );

    await writeAdditionalSystemContext(config, "workspace-1", {
      content: "temporary",
      enabled: false,
    });
    await expect(fs.stat(disabledPath)).resolves.toBeDefined();

    await writeAdditionalSystemContext(config, "workspace-1", { content: "", enabled: false });

    await expect(readAdditionalSystemContext(config, "workspace-1")).resolves.toEqual({
      content: "",
      enabled: true,
    });
    await expect(fs.stat(scratchpadPath)).rejects.toThrow();
    await expect(fs.stat(disabledPath)).rejects.toThrow();
  });

  test("disabling preserves content but suppresses prompt injection", async () => {
    const config = createSessionDirProvider(tempDir);

    await writeAdditionalSystemContext(config, "workspace-1", {
      content: "Sticky note",
      enabled: false,
    });

    const record = await readAdditionalSystemContext(config, "workspace-1");
    expect(record).toEqual({ content: "Sticky note", enabled: false });
    // Content stays on disk so the user can re-enable without losing it.
    await expect(
      fs.readFile(path.join(tempDir, "workspace-1", ADDITIONAL_SYSTEM_CONTEXT_FILENAME), "utf-8")
    ).resolves.toBe("Sticky note");
    // But the effective injection is empty.
    expect(effectiveAdditionalSystemContext(record)).toBe("");
  });

  test("re-enabling removes the disabled marker", async () => {
    const config = createSessionDirProvider(tempDir);
    const disabledPath = path.join(
      tempDir,
      "workspace-1",
      ADDITIONAL_SYSTEM_CONTEXT_DISABLED_FILENAME
    );

    await writeAdditionalSystemContext(config, "workspace-1", {
      content: "Keep me",
      enabled: false,
    });
    await expect(fs.stat(disabledPath)).resolves.toBeDefined();

    await writeAdditionalSystemContext(config, "workspace-1", {
      content: "Keep me",
      enabled: true,
    });

    await expect(fs.stat(disabledPath)).rejects.toThrow();
    await expect(readAdditionalSystemContext(config, "workspace-1")).resolves.toEqual({
      content: "Keep me",
      enabled: true,
    });
  });

  test("mergeAdditionalSystemInstructions appends scratchpad before request-specific instructions", () => {
    expect(mergeAdditionalSystemInstructions("scratch", "request")).toBe("scratch\n\nrequest");
    expect(mergeAdditionalSystemInstructions("scratch", "scratch\n\nrequest")).toBe(
      "scratch\n\nrequest"
    );
    expect(mergeAdditionalSystemInstructions("scratch", undefined)).toBe("scratch");
    expect(mergeAdditionalSystemInstructions("", "request")).toBe("request");
    expect(mergeAdditionalSystemInstructions("", undefined)).toBeUndefined();
  });
});
