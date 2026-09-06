import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { ExperimentsService } from "./experimentsService";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { TelemetryService } from "./telemetryService";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const OVERRIDES_FILE = "feature_flags.json";

function createTelemetryService(): {
  telemetryService: TelemetryService;
  setFeatureFlagVariant: ReturnType<typeof mock>;
} {
  const setFeatureFlagVariant = mock(() => undefined);
  return {
    telemetryService: { setFeatureFlagVariant } as unknown as TelemetryService,
    setFeatureFlagVariant,
  };
}

describe("ExperimentsService", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-experiments-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function readOverridesFile(): Promise<{
    experiments?: unknown;
    overrides?: Record<string, unknown>;
  }> {
    const raw = await fs.readFile(path.join(tempDir, OVERRIDES_FILE), "utf-8");
    return JSON.parse(raw) as { experiments?: unknown; overrides?: Record<string, unknown> };
  }

  test("failed Design persistence rejects the toggle without publishing it", async () => {
    const { telemetryService } = createTelemetryService();
    const service = new ExperimentsService({ telemetryService, xumHome: tempDir });
    await service.setOverride(EXPERIMENT_IDS.CLAUDE_DESIGN_MCP, true);
    const file = path.join(tempDir, OVERRIDES_FILE);
    const backup = `${file}.backup`;
    await fs.rename(file, backup);
    await fs.mkdir(file);
    try {
      const error: unknown = await service
        .setOverride(EXPERIMENT_IDS.CLAUDE_DESIGN_MCP, false)
        .then(
          () => undefined,
          (failure: unknown) => failure
        );
      expect(error).toBeInstanceOf(Error);
      expect(service.isExperimentEnabled(EXPERIMENT_IDS.CLAUDE_DESIGN_MCP)).toBe(true);
    } finally {
      await fs.rmdir(file);
      await fs.rename(backup, file);
    }
    expect((await readOverridesFile()).overrides?.[EXPERIMENT_IDS.CLAUDE_DESIGN_MCP]).toBe(true);
  });

  test("stale sibling flag mutations preserve a durable Design disable", async () => {
    const { telemetryService } = createTelemetryService();
    const first = new ExperimentsService({ telemetryService, xumHome: tempDir });
    await first.setOverride(EXPERIMENT_IDS.CLAUDE_DESIGN_MCP, true);
    const sibling = new ExperimentsService({ telemetryService, xumHome: tempDir });
    await sibling.initialize();
    await first.setOverride(EXPERIMENT_IDS.CLAUDE_DESIGN_MCP, false);
    await sibling.setOverride(EXPERIMENT_IDS.TIMELINE, true);
    expect((await readOverridesFile()).overrides?.[EXPERIMENT_IDS.CLAUDE_DESIGN_MCP]).toBe(false);
    expect((await first.getOverrides())[EXPERIMENT_IDS.TIMELINE]).toBe(true);
  });

  test("disk reconciliation updates and clears sibling telemetry variants", async () => {
    const first = createTelemetryService();
    const service = new ExperimentsService({
      telemetryService: first.telemetryService,
      xumHome: tempDir,
    });
    const sibling = new ExperimentsService({
      telemetryService: createTelemetryService().telemetryService,
      xumHome: tempDir,
    });
    await service.setOverride(EXPERIMENT_IDS.CLAUDE_DESIGN_MCP, true);
    await sibling.setOverride(EXPERIMENT_IDS.CLAUDE_DESIGN_MCP, false);
    await service.getOverrides();
    expect(first.setFeatureFlagVariant).toHaveBeenLastCalledWith(
      EXPERIMENT_IDS.CLAUDE_DESIGN_MCP,
      false
    );
    await sibling.setOverride(EXPERIMENT_IDS.CLAUDE_DESIGN_MCP, null);
    await service.setOverride(EXPERIMENT_IDS.TIMELINE, true);
    expect(first.setFeatureFlagVariant).toHaveBeenCalledWith(
      EXPERIMENT_IDS.CLAUDE_DESIGN_MCP,
      null
    );
    expect(service.isExperimentEnabled(EXPERIMENT_IDS.CLAUDE_DESIGN_MCP)).toBe(false);
  });

  test("experiments are disabled until the user sets an override", async () => {
    const { telemetryService } = createTelemetryService();
    const service = new ExperimentsService({ telemetryService, xumHome: tempDir });
    await service.initialize();

    expect(service.isExperimentEnabled(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING)).toBe(false);

    await service.setOverride(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING, true);

    expect(service.isExperimentEnabled(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING)).toBe(true);
  });

  test("overrides survive a restart and re-apply their telemetry variant", async () => {
    const first = createTelemetryService();
    const service = new ExperimentsService({
      telemetryService: first.telemetryService,
      xumHome: tempDir,
    });
    await service.setOverride(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES, true);

    expect((await readOverridesFile()).overrides).toEqual({
      [EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES]: true,
    });

    const second = createTelemetryService();
    const reloaded = new ExperimentsService({
      telemetryService: second.telemetryService,
      xumHome: tempDir,
    });
    await reloaded.initialize();

    expect(reloaded.isExperimentEnabled(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES)).toBe(true);
    expect(second.setFeatureFlagVariant).toHaveBeenCalledWith(
      EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES,
      true
    );
  });

  test("clearing an override disables the experiment and drops its telemetry variant", async () => {
    const { telemetryService, setFeatureFlagVariant } = createTelemetryService();
    const service = new ExperimentsService({ telemetryService, xumHome: tempDir });
    await service.setOverride(EXPERIMENT_IDS.MEMORY, true);

    await service.setOverride(EXPERIMENT_IDS.MEMORY, null);

    expect(service.isExperimentEnabled(EXPERIMENT_IDS.MEMORY)).toBe(false);
    expect((await readOverridesFile()).overrides).toEqual({});
    expect(setFeatureFlagVariant).toHaveBeenLastCalledWith(EXPERIMENT_IDS.MEMORY, null);
  });

  test("an explicit false override keeps the experiment disabled", async () => {
    const { telemetryService } = createTelemetryService();
    const service = new ExperimentsService({ telemetryService, xumHome: tempDir });
    await service.setOverride(EXPERIMENT_IDS.AGENT_BROWSER, false);

    expect(service.isExperimentEnabled(EXPERIMENT_IDS.AGENT_BROWSER)).toBe(false);
    expect((await readOverridesFile()).overrides).toEqual({
      [EXPERIMENT_IDS.AGENT_BROWSER]: false,
    });
  });

  test("platform-restricted experiments ignore overrides on unsupported platforms", async () => {
    await fs.writeFile(
      path.join(tempDir, OVERRIDES_FILE),
      JSON.stringify({
        version: 1,
        experiments: {},
        overrides: { [EXPERIMENT_IDS.PORTABLE_DESKTOP]: true },
      }),
      "utf-8"
    );

    const { telemetryService, setFeatureFlagVariant } = createTelemetryService();
    const service = new ExperimentsService({
      telemetryService,
      xumHome: tempDir,
      platform: "darwin",
    });
    await service.initialize();

    expect(service.isExperimentEnabled(EXPERIMENT_IDS.PORTABLE_DESKTOP)).toBe(false);

    await service.setOverride(EXPERIMENT_IDS.PORTABLE_DESKTOP, true);

    expect((await readOverridesFile()).overrides).toEqual({});
    expect(setFeatureFlagVariant).toHaveBeenCalledWith(EXPERIMENT_IDS.PORTABLE_DESKTOP, null);
  });

  test("overrides written by a build with remote evaluation still load", async () => {
    await fs.writeFile(
      path.join(tempDir, OVERRIDES_FILE),
      JSON.stringify({
        version: 1,
        experiments: {
          [EXPERIMENT_IDS.TOOL_SEARCH]: { value: "test", fetchedAtMs: Date.now() },
        },
        overrides: { [EXPERIMENT_IDS.AGENT_BROWSER]: true },
      }),
      "utf-8"
    );

    const { telemetryService } = createTelemetryService();
    const service = new ExperimentsService({ telemetryService, xumHome: tempDir });
    await service.initialize();

    expect(service.isExperimentEnabled(EXPERIMENT_IDS.AGENT_BROWSER)).toBe(true);
    // A cached remote assignment must not survive as an implicit opt-in.
    expect(service.isExperimentEnabled(EXPERIMENT_IDS.TOOL_SEARCH)).toBe(false);
  });

  test("legacy exclusive-only override keeps PTC enabled after upgrade", async () => {
    // "programmatic-tool-calling-exclusive" was a separate experiment before
    // PTC became exclusive-only. A user who had ONLY that toggle enabled opted
    // into exactly the posture the merged PTC experiment activates, so the
    // alias must keep PTC on instead of silently disabling it.
    await fs.writeFile(
      path.join(tempDir, OVERRIDES_FILE),
      JSON.stringify({
        version: 1,
        experiments: {},
        overrides: { "programmatic-tool-calling-exclusive": true },
      }),
      "utf-8"
    );

    const { telemetryService } = createTelemetryService();
    const service = new ExperimentsService({ telemetryService, xumHome: tempDir });
    await service.initialize();

    expect(service.isExperimentEnabled(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING)).toBe(true);
    expect(await service.getOverrides()).toEqual({
      [EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING]: true,
    });
  });

  test("initialization persists the downgrade mirror for a bare ptc:true file", async () => {
    // A pre-merge file can carry ptc:true without the legacy exclusive key
    // (setOverride is the only other writer): a user who upgrades and never
    // touches a setting must still downgrade into the exclusive posture, not
    // the removed supplement mode (r30).
    await fs.writeFile(
      path.join(tempDir, OVERRIDES_FILE),
      JSON.stringify({
        version: 1,
        experiments: {},
        overrides: { "programmatic-tool-calling": true },
      }),
      "utf-8"
    );

    const { telemetryService } = createTelemetryService();
    const service = new ExperimentsService({ telemetryService, xumHome: tempDir });
    await service.initialize();

    expect((await readOverridesFile()).overrides).toEqual({
      [EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING]: true,
      "programmatic-tool-calling-exclusive": true,
    });
  });

  test("a disabled legacy exclusive override stays ignored", async () => {
    await fs.writeFile(
      path.join(tempDir, OVERRIDES_FILE),
      JSON.stringify({
        version: 1,
        experiments: {},
        overrides: { "programmatic-tool-calling-exclusive": false },
      }),
      "utf-8"
    );

    const { telemetryService } = createTelemetryService();
    const service = new ExperimentsService({ telemetryService, xumHome: tempDir });
    await service.initialize();

    expect(service.isExperimentEnabled(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING)).toBe(false);
    expect(await service.getOverrides()).toEqual({});
  });

  test("enabled PTC writes the legacy exclusive key for downgrade compatibility", async () => {
    // A downgraded build reads a bare ptc:true as the removed (~2x cost)
    // supplement mode; mirroring the legacy exclusive key preserves the
    // exclusive posture across downgrade. Disabling PTC drops both keys.
    const { telemetryService } = createTelemetryService();
    const service = new ExperimentsService({ telemetryService, xumHome: tempDir });
    await service.setOverride(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING, true);

    expect((await readOverridesFile()).overrides).toEqual({
      [EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING]: true,
      "programmatic-tool-calling-exclusive": true,
    });

    await service.setOverride(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING, null);
    expect((await readOverridesFile()).overrides).toEqual({});
  });

  test("a client with empty local state does not clear overrides it never knew about", async () => {
    await fs.writeFile(
      path.join(tempDir, OVERRIDES_FILE),
      JSON.stringify({
        version: 1,
        experiments: {},
        overrides: { [EXPERIMENT_IDS.SKILL_DYNAMIC_CONTEXT]: true },
      }),
      "utf-8"
    );

    const { telemetryService } = createTelemetryService();
    const service = new ExperimentsService({ telemetryService, xumHome: tempDir });
    await service.initialize();

    // A second renderer (different origin, so empty localStorage) uploads nothing and
    // reads state back. It must not disable what another client persisted.
    await service.setOverride(EXPERIMENT_IDS.AGENT_BROWSER, true);

    expect(await service.getOverrides()).toEqual({
      [EXPERIMENT_IDS.SKILL_DYNAMIC_CONTEXT]: true,
      [EXPERIMENT_IDS.AGENT_BROWSER]: true,
    });
    expect(service.isExperimentEnabled(EXPERIMENT_IDS.SKILL_DYNAMIC_CONTEXT)).toBe(true);
  });

  test("getOverrides hides overrides for platform-unsupported experiments", async () => {
    await fs.writeFile(
      path.join(tempDir, OVERRIDES_FILE),
      JSON.stringify({
        version: 1,
        experiments: {},
        overrides: { [EXPERIMENT_IDS.PORTABLE_DESKTOP]: true },
      }),
      "utf-8"
    );

    const { telemetryService } = createTelemetryService();
    const service = new ExperimentsService({
      telemetryService,
      xumHome: tempDir,
      platform: "darwin",
    });

    expect(await service.getOverrides()).toEqual({});
  });

  test("writes an empty experiments map so older builds still read overrides", async () => {
    const { telemetryService } = createTelemetryService();
    const service = new ExperimentsService({ telemetryService, xumHome: tempDir });
    await service.setOverride(EXPERIMENT_IDS.TIMELINE, true);

    expect((await readOverridesFile()).experiments).toEqual({});
  });
});
