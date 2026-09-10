import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { DevToolsEvent, DevToolsRun, DevToolsStep } from "@/common/types/devtools";
import { Config } from "@/node/config";
import { DevToolsService } from "@/node/services/devToolsService";

function makeRun(id: string, startedAt = "2025-06-01T00:00:00Z"): DevToolsRun {
  return { id, workspaceId: "ws-1", startedAt };
}

function makeStep(overrides: Partial<DevToolsStep> & { id: string; runId: string }): DevToolsStep {
  const { id, runId, ...rest } = overrides;

  return {
    id,
    runId,
    stepNumber: 1,
    type: "generate",
    modelId: "test-model",
    provider: null,
    startedAt: "2025-06-01T00:00:00Z",
    durationMs: 100,
    input: null,
    output: null,
    usage: null,
    error: null,
    rawRequest: null,
    requestHeaders: null,
    responseHeaders: null,
    rawResponse: null,
    rawChunks: null,
    ...rest,
  };
}

function createTestConfig(opts: { sessionsDir: string; enabled?: boolean }): Config {
  const config = new Config(path.dirname(opts.sessionsDir));
  spyOn(config, "getLlmDebugLogsEnabled").mockImplementation(() => opts.enabled ?? true);
  return config;
}

function getDevtoolsLogPath(sessionsDir: string, workspaceId: string): string {
  return path.join(sessionsDir, workspaceId, "devtools.jsonl");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function countStaleStepUpdates(logContents: string, stepId: string): number {
  return logContents.split("\n").reduce((count, line) => {
    if (!line.trim()) {
      return count;
    }

    try {
      const parsed = JSON.parse(line) as {
        type?: unknown;
        stepId?: unknown;
        update?: { error?: unknown } | null;
      };

      if (
        parsed.type === "step-update" &&
        parsed.stepId === stepId &&
        parsed.update?.error === "Interrupted (stale)"
      ) {
        return count + 1;
      }
    } catch {
      // Ignore malformed test fixture lines while counting stale-step updates.
    }

    return count;
  }, 0);
}

describe("DevToolsService", () => {
  let tempDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-devtools-service-test-"));
    sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("when disabled", () => {
    it("createRun/createStep are no-ops, getRuns returns empty, and no file is written", async () => {
      const config = createTestConfig({ sessionsDir, enabled: false });
      const service = new DevToolsService(config);

      await service.createRun("ws-1", makeRun("run-1"));
      await service.createStep("ws-1", makeStep({ id: "step-1", runId: "run-1" }));

      expect(await service.getRuns("ws-1")).toEqual([]);
      expect(await pathExists(getDevtoolsLogPath(sessionsDir, "ws-1"))).toBe(false);
    });

    it("finalizeStaleSteps still finalizes persisted stale data when logging is disabled", async () => {
      const config = createTestConfig({ sessionsDir, enabled: false });
      const run = makeRun("run-1");
      const staleStep = makeStep({
        id: "step-stale",
        runId: "run-1",
        durationMs: null,
        error: null,
      });
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");

      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(
        logPath,
        `${JSON.stringify({ type: "run", run })}\n${JSON.stringify({ type: "step", step: staleStep })}\n`,
        "utf-8"
      );

      const service = new DevToolsService(config);
      await service.finalizeStaleSteps("ws-1");

      const logAfterFirstFinalize = await fs.readFile(logPath, "utf-8");
      expect(countStaleStepUpdates(logAfterFirstFinalize, staleStep.id)).toBe(1);

      await service.finalizeStaleSteps("ws-1");
      const logAfterSecondFinalize = await fs.readFile(logPath, "utf-8");
      expect(countStaleStepUpdates(logAfterSecondFinalize, staleStep.id)).toBe(1);
    });
  });

  describe("when enabled", () => {
    it("createRun stores run and returns a summary with stepCount=0", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));

      await service.createRun("ws-1", makeRun("run-1"));

      const runs = await service.getRuns("ws-1");
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        id: "run-1",
        workspaceId: "ws-1",
        stepCount: 0,
        firstMessage: "",
        hasError: false,
        isInProgress: false,
        totalDurationMs: 0,
        modelId: null,
      });
    });

    it("applies pending toolPolicy metadata to the next run", async () => {
      const config = createTestConfig({ sessionsDir, enabled: true });
      const service = new DevToolsService(config);
      const policy = [
        { regex_match: "propose_plan", action: "require" as const },
        { regex_match: "agent_report", action: "disable" as const },
      ];
      const metadataId = "metadata-1";

      service.setPendingRunMetadata("ws-1", metadataId, { toolPolicy: policy });
      await service.createRun("ws-1", makeRun("run-1"), metadataId);

      const runs = await service.getRuns("ws-1");
      expect(runs).toHaveLength(1);
      expect(runs[0]?.toolPolicy).toEqual(policy);
    });

    it("persists toolPolicy metadata in jsonl replay", async () => {
      const config = createTestConfig({ sessionsDir, enabled: true });
      const service1 = new DevToolsService(config);
      const policy = [{ regex_match: "bash", action: "disable" as const }];
      const metadataId = "metadata-2";

      service1.setPendingRunMetadata("ws-1", metadataId, { toolPolicy: policy });
      await service1.createRun("ws-1", makeRun("run-1"), metadataId);

      const service2 = new DevToolsService(config);
      const runs = await service2.getRuns("ws-1");
      expect(runs).toHaveLength(1);
      expect(runs[0]?.toolPolicy).toEqual(policy);
    });

    it("does not set toolPolicy when no pending metadata exists", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));

      await service.createRun("ws-1", makeRun("run-1"));

      const runs = await service.getRuns("ws-1");
      expect(runs).toHaveLength(1);
      expect(runs[0]?.toolPolicy).toBeUndefined();
    });

    it("consumes pending metadata once", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const policy = [{ regex_match: ".*", action: "enable" as const }];
      const metadataId = "metadata-3";

      service.setPendingRunMetadata("ws-1", metadataId, { toolPolicy: policy });
      await service.createRun("ws-1", makeRun("run-1", "2025-06-01T00:00:00Z"), metadataId);
      await service.createRun("ws-1", makeRun("run-2", "2025-06-01T00:01:00Z"));

      const runs = await service.getRuns("ws-1");
      const run1 = runs.find((run) => run.id === "run-1");
      const run2 = runs.find((run) => run.id === "run-2");

      expect(run1?.toolPolicy).toEqual(policy);
      expect(run2?.toolPolicy).toBeUndefined();
    });

    it("stores pending metadata per metadata id for overlapping requests", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const policyA = [{ regex_match: "propose_plan", action: "require" as const }];
      const policyB = [{ regex_match: "task_.*", action: "disable" as const }];

      service.setPendingRunMetadata("ws-1", "metadata-a", { toolPolicy: policyA });
      service.setPendingRunMetadata("ws-1", "metadata-b", { toolPolicy: policyB });

      await service.createRun("ws-1", makeRun("run-1", "2025-06-01T00:00:00Z"), "metadata-a");
      await service.createRun("ws-1", makeRun("run-2", "2025-06-01T00:01:00Z"), "metadata-b");

      const runs = await service.getRuns("ws-1");
      const run1 = runs.find((run) => run.id === "run-1");
      const run2 = runs.find((run) => run.id === "run-2");

      expect(run1?.toolPolicy).toEqual(policyA);
      expect(run2?.toolPolicy).toEqual(policyB);
    });

    it("retains pending metadata when metadata id does not match", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const policy = [{ regex_match: ".*", action: "disable" as const }];

      service.setPendingRunMetadata("ws-1", "stale-metadata", { toolPolicy: policy });
      await service.createRun("ws-1", makeRun("run-1"), "different-metadata");
      await service.createRun("ws-1", makeRun("run-2", "2025-06-01T00:01:00Z"), "stale-metadata");

      const runs = await service.getRuns("ws-1");
      const run1 = runs.find((run) => run.id === "run-1");
      const run2 = runs.find((run) => run.id === "run-2");
      expect(run1?.toolPolicy).toBeUndefined();
      expect(run2?.toolPolicy).toEqual(policy);
    });

    it("clearPendingRunMetadata only clears matching metadata id", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const policy = [{ regex_match: ".*", action: "require" as const }];

      service.setPendingRunMetadata("ws-1", "metadata-keep", { toolPolicy: policy });
      service.clearPendingRunMetadata("ws-1", "metadata-other");
      await service.createRun("ws-1", makeRun("run-1"), "metadata-keep");

      const runs = await service.getRuns("ws-1");
      expect(runs[0]?.toolPolicy).toEqual(policy);
    });

    it("createStep stores step and getRunWithSteps returns it", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      await service.createRun("ws-1", makeRun("run-1"));

      const step = makeStep({
        id: "step-1",
        runId: "run-1",
        input: {
          prompt: [
            { role: "system", content: "be helpful" },
            {
              role: "user",
              content: [{ type: "text", text: "hello from user prompt" }],
            },
          ],
        },
      });

      await service.createStep("ws-1", step);

      const runWithSteps = await service.getRunWithSteps("ws-1", "run-1");
      expect(runWithSteps).not.toBeNull();
      expect(runWithSteps?.steps).toEqual([step]);
      expect(runWithSteps?.run.firstMessage).toBe("hello from user prompt");
    });

    it("sets isInProgress=true when a step has null duration", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      await service.createRun("ws-1", makeRun("run-1"));

      await service.createStep(
        "ws-1",
        makeStep({
          id: "step-1",
          runId: "run-1",
          durationMs: null,
        })
      );

      const runs = await service.getRuns("ws-1");
      expect(runs).toHaveLength(1);
      expect(runs[0]?.isInProgress).toBe(true);
      expect(runs[0]?.totalDurationMs).toBeNull();
    });

    it("finalizeStaleSteps marks in-progress steps as interrupted", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      await service.createRun("ws-1", makeRun("run-1"));
      await service.createStep("ws-1", makeStep({ id: "s-1", runId: "run-1", durationMs: null }));
      await service.createStep("ws-1", makeStep({ id: "s-2", runId: "run-1", durationMs: 500 }));

      await service.finalizeStaleSteps("ws-1");

      const detail = await service.getRunWithSteps("ws-1", "run-1");
      expect(detail).not.toBeNull();

      const staleStep = detail?.steps.find((step) => step.id === "s-1");
      expect(staleStep).toBeDefined();
      expect(staleStep?.error).toBe("Interrupted (stale)");
      expect(staleStep?.durationMs).not.toBeNull();

      const completeStep = detail?.steps.find((step) => step.id === "s-2");
      expect(completeStep).toBeDefined();
      expect(completeStep?.error).toBeNull();
      expect(completeStep?.durationMs).toBe(500);
    });

    it("updateStep merges fields", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      await service.createRun("ws-1", makeRun("run-1"));
      await service.createStep("ws-1", makeStep({ id: "step-1", runId: "run-1" }));

      await service.updateStep("ws-1", "step-1", {
        durationMs: 250,
        output: { finishReason: "stop" },
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      });

      const runWithSteps = await service.getRunWithSteps("ws-1", "run-1");
      expect(runWithSteps).not.toBeNull();
      expect(runWithSteps?.steps[0]).toMatchObject({
        id: "step-1",
        durationMs: 250,
        output: { finishReason: "stop" },
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      });
    });

    it("updateStep with error marks run summary hasError=true", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      await service.createRun("ws-1", makeRun("run-1"));
      await service.createStep("ws-1", makeStep({ id: "step-1", runId: "run-1" }));

      await service.updateStep("ws-1", "step-1", {
        error: "request failed",
      });

      const runs = await service.getRuns("ws-1");
      expect(runs).toHaveLength(1);
      expect(runs[0]?.hasError).toBe(true);
    });

    it("getRuns returns runs sorted by startedAt descending", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));

      await service.createRun("ws-1", makeRun("run-old", "2025-06-01T00:00:00Z"));
      await service.createRun("ws-1", makeRun("run-new", "2025-06-02T00:00:00Z"));

      const runs = await service.getRuns("ws-1");
      expect(runs.map((run) => run.id)).toEqual(["run-new", "run-old"]);
    });

    it("isolates data per workspace", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));

      await service.createRun("ws-1", makeRun("run-1"));
      await service.createRun("ws-2", { ...makeRun("run-2"), workspaceId: "ws-2" });

      const ws1Runs = await service.getRuns("ws-1");
      const ws2Runs = await service.getRuns("ws-2");

      expect(ws1Runs.map((run) => run.id)).toEqual(["run-1"]);
      expect(ws2Runs.map((run) => run.id)).toEqual(["run-2"]);
    });

    it("clear removes all workspace data", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      await service.createRun("ws-1", makeRun("run-1"));
      await service.createStep("ws-1", makeStep({ id: "step-1", runId: "run-1" }));

      await service.clear("ws-1");

      expect(await service.getRuns("ws-1")).toEqual([]);
      expect(await service.getRunWithSteps("ws-1", "run-1")).toBeNull();
      expect(await fs.readFile(getDevtoolsLogPath(sessionsDir, "ws-1"), "utf-8")).toBe("");
    });

    it("removeWorkspaceData deletes the log file and in-memory state", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      await service.createRun("ws-1", makeRun("run-1"));
      await service.createStep("ws-1", makeStep({ id: "step-1", runId: "run-1" }));

      await service.removeWorkspaceData("ws-1");

      expect(await pathExists(getDevtoolsLogPath(sessionsDir, "ws-1"))).toBe(false);
      expect(await service.getRuns("ws-1")).toEqual([]);
      expect(await service.getRunWithSteps("ws-1", "run-1")).toBeNull();
    });

    it("removeWorkspaceData deletes stale log files even when logging is disabled", async () => {
      // Simulate a file written while logging was enabled, then the user disabling it.
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(logPath, `${JSON.stringify({ type: "run", run: makeRun("run-1") })}\n`);

      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: false }));
      await service.removeWorkspaceData("ws-1");

      expect(await pathExists(logPath)).toBe(false);
    });
  });

  describe("persistence", () => {
    it("loads persisted data after service recreation", async () => {
      const config = createTestConfig({ sessionsDir, enabled: true });

      const service1 = new DevToolsService(config);
      await service1.createRun("ws-1", makeRun("run-1"));
      await service1.createStep(
        "ws-1",
        makeStep({
          id: "step-1",
          runId: "run-1",
          durationMs: null,
        })
      );
      await service1.updateStep("ws-1", "step-1", {
        durationMs: 125,
        output: { finishReason: "stop" },
      });

      const service2 = new DevToolsService(config);
      const runWithSteps = await service2.getRunWithSteps("ws-1", "run-1");

      expect(runWithSteps).not.toBeNull();
      expect(runWithSteps?.steps).toHaveLength(1);
      expect(runWithSteps?.steps[0]).toMatchObject({
        id: "step-1",
        durationMs: 125,
        output: { finishReason: "stop" },
      });
    });

    it("finalizes stale in-progress steps once when persisted data is first loaded", async () => {
      const config = createTestConfig({ sessionsDir, enabled: true });
      const staleStepId = "step-stale";
      const run = makeRun("run-1");
      const staleStep = makeStep({
        id: staleStepId,
        runId: "run-1",
        durationMs: null,
        error: null,
      });
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");

      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(
        logPath,
        `${JSON.stringify({ type: "run", run })}\n${JSON.stringify({ type: "step", step: staleStep })}\n`,
        "utf-8"
      );

      const service = new DevToolsService(config);
      const runWithSteps = await service.getRunWithSteps("ws-1", "run-1");

      expect(runWithSteps).not.toBeNull();
      const finalizedStep = runWithSteps?.steps.find((step) => step.id === staleStepId);
      expect(finalizedStep).toBeDefined();
      expect(finalizedStep?.error).toBe("Interrupted (stale)");
      expect(finalizedStep?.durationMs).not.toBeNull();

      const logAfterFirstLoad = await fs.readFile(logPath, "utf-8");
      expect(countStaleStepUpdates(logAfterFirstLoad, staleStepId)).toBe(1);

      await service.getRuns("ws-1");
      const logAfterSecondLoad = await fs.readFile(logPath, "utf-8");
      expect(countStaleStepUpdates(logAfterSecondLoad, staleStepId)).toBe(1);
    });

    it("serializes concurrent workspace loads so createStep does not stale-finalize sibling requests", async () => {
      const config = createTestConfig({ sessionsDir, enabled: true });
      const run = makeRun("run-1");
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");

      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(logPath, `${JSON.stringify({ type: "run", run })}\n`, "utf-8");

      const service = new DevToolsService(config);

      const originalReadFile = fs.readFile;
      let logReadCount = 0;
      let releaseReadGate!: () => void;
      const readGate = new Promise<void>((resolve) => {
        releaseReadGate = resolve;
      });

      let firstReadStartedResolve!: () => void;
      const firstReadStarted = new Promise<void>((resolve) => {
        firstReadStartedResolve = resolve;
      });

      const mockedReadFile = (async (...args: Parameters<typeof fs.readFile>) => {
        const [filePath] = args;
        if (filePath === logPath) {
          logReadCount += 1;
          firstReadStartedResolve();
          await readGate;
        }
        return originalReadFile(...args);
      }) as typeof fs.readFile;

      const readFileSpy = spyOn(fs, "readFile").mockImplementation(mockedReadFile);

      try {
        const firstCreateStep = service.createStep(
          "ws-1",
          makeStep({ id: "step-1", runId: "run-1", durationMs: null })
        );
        await firstReadStarted;

        const secondCreateStep = service.createStep(
          "ws-1",
          makeStep({ id: "step-2", runId: "run-1", durationMs: null, stepNumber: 2 })
        );

        await Promise.resolve();
        expect(logReadCount).toBe(1);

        releaseReadGate();
        await Promise.all([firstCreateStep, secondCreateStep]);
      } finally {
        readFileSpy.mockRestore();
      }

      const runWithSteps = await service.getRunWithSteps("ws-1", "run-1");
      expect(runWithSteps).not.toBeNull();
      const step1 = runWithSteps?.steps.find((step) => step.id === "step-1");
      const step2 = runWithSteps?.steps.find((step) => step.id === "step-2");
      expect(step1?.error).toBeNull();
      expect(step2?.error).toBeNull();
      expect(step1?.durationMs).toBeNull();
      expect(step2?.durationMs).toBeNull();

      const logAfterCreates = await fs.readFile(logPath, "utf-8");
      expect(countStaleStepUpdates(logAfterCreates, "step-1")).toBe(0);
      expect(countStaleStepUpdates(logAfterCreates, "step-2")).toBe(0);
    });

    it("defaults missing raw fields to null when replaying legacy step entries", async () => {
      const config = createTestConfig({ sessionsDir, enabled: true });
      const run = makeRun("run-1");
      const legacyStep = {
        ...makeStep({ id: "step-1", runId: "run-1" }),
      };
      delete (legacyStep as Record<string, unknown>).rawChunks;
      delete (legacyStep as Record<string, unknown>).requestHeaders;
      delete (legacyStep as Record<string, unknown>).responseHeaders;
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");

      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(
        logPath,
        `${JSON.stringify({ type: "run", run })}\n${JSON.stringify({ type: "step", step: legacyStep })}\n`,
        "utf-8"
      );

      const service = new DevToolsService(config);
      const runWithSteps = await service.getRunWithSteps("ws-1", "run-1");

      expect(runWithSteps).not.toBeNull();
      expect(runWithSteps?.steps[0]?.requestHeaders).toBeNull();
      expect(runWithSteps?.steps[0]?.responseHeaders).toBeNull();
      expect(runWithSteps?.steps[0]?.rawChunks).toBeNull();
    });

    it("skips corrupted lines while replaying persisted logs", async () => {
      const config = createTestConfig({ sessionsDir, enabled: true });
      const run = makeRun("run-1");
      const step = makeStep({ id: "step-1", runId: "run-1" });
      const logPath = getDevtoolsLogPath(sessionsDir, "ws-1");

      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(
        logPath,
        `${JSON.stringify({ type: "run", run })}\n{this-is-not-json}\n${JSON.stringify({ type: "step", step })}\n${JSON.stringify({ type: "step-update", stepId: "step-1", update: { error: "boom" } })}\n`,
        "utf-8"
      );

      const service = new DevToolsService(config);
      const runWithSteps = await service.getRunWithSteps("ws-1", "run-1");

      expect(runWithSteps).not.toBeNull();
      expect(runWithSteps?.steps).toHaveLength(1);
      expect(runWithSteps?.steps[0]?.error).toBe("boom");
    });

    it("clear truncates persisted file", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      await service.createRun("ws-1", makeRun("run-1"));
      await service.clear("ws-1");

      expect(await fs.readFile(getDevtoolsLogPath(sessionsDir, "ws-1"), "utf-8")).toBe("");
    });
  });

  describe("event emission", () => {
    it("emits toolPolicy in run-created summary", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const events: DevToolsEvent[] = [];
      const policy = [{ regex_match: "propose_plan", action: "require" as const }];
      const metadataId = "metadata-4";

      service.on("update:ws-1", (event: DevToolsEvent) => {
        events.push(event);
      });

      service.setPendingRunMetadata("ws-1", metadataId, { toolPolicy: policy });
      await service.createRun("ws-1", makeRun("run-1"), metadataId);

      const runCreated = events.find((event) => event.type === "run-created");
      expect(runCreated).toBeDefined();
      if (runCreated?.type === "run-created") {
        expect(runCreated.run.toolPolicy).toEqual(policy);
      }
    });

    it("emits run-created, updateStep events, and cleared", async () => {
      const service = new DevToolsService(createTestConfig({ sessionsDir, enabled: true }));
      const events: DevToolsEvent[] = [];

      service.on("update:ws-1", (event: DevToolsEvent) => {
        events.push(event);
      });

      await service.createRun("ws-1", makeRun("run-1"));
      await service.createStep("ws-1", makeStep({ id: "step-1", runId: "run-1" }));
      await service.updateStep("ws-1", "step-1", { durationMs: 500 });
      await service.clear("ws-1");

      expect(events.map((event) => event.type)).toEqual([
        "run-created",
        "step-created",
        "run-updated",
        "step-updated",
        "run-updated",
        "cleared",
      ]);

      const runCreated = events[0];
      expect(runCreated?.type).toBe("run-created");
      if (runCreated?.type === "run-created") {
        expect(runCreated.run.id).toBe("run-1");
      }

      const stepUpdated = events[3];
      expect(stepUpdated?.type).toBe("step-updated");
      if (stepUpdated?.type === "step-updated") {
        expect(stepUpdated.step.durationMs).toBe(500);
      }

      expect(events[5]).toEqual({ type: "cleared" });
    });
  });
});
