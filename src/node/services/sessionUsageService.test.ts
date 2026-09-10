import * as path from "path";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SessionUsageService, type SessionUsageTokenStatsCacheV1 } from "./sessionUsageService";
import type { HistoryService } from "./historyService";
import type { Config } from "@/node/config";
import { createMuxMessage } from "@/common/types/message";
import {
  getTotalCost,
  sumUsageHistory,
  type ChatUsageDisplay,
} from "@/common/utils/tokens/usageAggregator";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { createTestHistoryService } from "./testHistoryService";
import { workspaceRemovalTombstonePath } from "./workspaceRemoval";
import { existsSync } from "fs";
import * as fs from "fs/promises";

function createUsage(input: number, output: number): ChatUsageDisplay {
  return {
    input: { tokens: input },
    output: { tokens: output },
    cached: { tokens: 0 },
    cacheCreate: { tokens: 0 },
    reasoning: { tokens: 0 },
  };
}

function createUsageWithCosts(
  inputTokens: number,
  outputTokens: number,
  inputCostUsd: number,
  outputCostUsd: number
): ChatUsageDisplay {
  return {
    input: { tokens: inputTokens, cost_usd: inputCostUsd },
    output: { tokens: outputTokens, cost_usd: outputCostUsd },
    cached: { tokens: 0 },
    cacheCreate: { tokens: 0 },
    reasoning: { tokens: 0 },
  };
}
describe("SessionUsageService", () => {
  let service: SessionUsageService;
  let config: Config;
  let historyService: HistoryService;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ config, historyService, cleanup } = await createTestHistoryService());
    service = new SessionUsageService(config, historyService);
  });

  afterEach(async () => {
    await cleanup();
  });

  describe("rollUpUsageIntoParent", () => {
    it("should roll up child usage into parent without changing parent's lastRequest", async () => {
      const projectPath = "/tmp/mux-session-usage-test-project";
      const model = "claude-sonnet-4-20250514";

      const parentWorkspaceId = "parent-workspace";
      const childWorkspaceId = "child-workspace";

      await config.addWorkspace(projectPath, {
        id: parentWorkspaceId,
        name: "parent-branch",
        projectName: "test-project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      await config.addWorkspace(projectPath, {
        id: childWorkspaceId,
        name: "child-branch",
        projectName: "test-project",
        projectPath,
        runtimeConfig: { type: "local" },
        parentWorkspaceId: parentWorkspaceId,
      });

      const parentUsage = createUsage(100, 50);
      await service.recordUsage(parentWorkspaceId, model, parentUsage);
      const before = await service.getSessionUsage(parentWorkspaceId);
      expect(before?.lastRequest).toBeDefined();

      const beforeLastRequest = before!.lastRequest!;

      const childUsageByModel = { [model]: createUsage(7, 3) };
      const rollupResult = await service.rollUpUsageIntoParent(
        parentWorkspaceId,
        childWorkspaceId,
        childUsageByModel
      );
      expect(rollupResult.didRollUp).toBe(true);

      const after = await service.getSessionUsage(parentWorkspaceId);
      expect(after).toBeDefined();
      expect(after!.byModel[model].input.tokens).toBe(107);
      expect(after!.byModel[model].output.tokens).toBe(53);

      const entry = after!.rolledUpFrom?.[childWorkspaceId];
      expect(entry).toBeDefined();
      expect(entry).not.toBe(true);
      if (!entry || entry === true) {
        throw new Error("Expected an enriched rolledUpFrom entry");
      }

      expect(entry.inputTokens).toBe(7);
      expect(entry.outputTokens).toBe(3);
      expect(entry.reasoningTokens).toBe(0);
      expect(entry.cachedTokens).toBe(0);
      expect(entry.cacheCreateTokens).toBe(0);

      // lastRequest is preserved
      expect(after!.lastRequest).toEqual(beforeLastRequest);
    });

    it("should preserve per-category token breakdown in rolledUpFrom", async () => {
      const projectPath = "/tmp/mux-session-usage-test-project";
      const model = "claude-sonnet-4-20250514";
      const parentWorkspaceId = "parent-workspace";
      const childWorkspaceId = "child-workspace";

      await config.addWorkspace(projectPath, {
        id: parentWorkspaceId,
        name: "parent-branch",
        projectName: "test-project",
        projectPath,
        runtimeConfig: { type: "local" },
      });

      const childUsageByModel = {
        [model]: {
          input: { tokens: 11 },
          output: { tokens: 7 },
          reasoning: { tokens: 5 },
          cached: { tokens: 3 },
          cacheCreate: { tokens: 2 },
        },
      };

      await service.rollUpUsageIntoParent(parentWorkspaceId, childWorkspaceId, childUsageByModel);

      const result = await service.getSessionUsage(parentWorkspaceId);
      expect(result).toBeDefined();

      const entry = result!.rolledUpFrom?.[childWorkspaceId];
      expect(entry).toBeDefined();
      expect(entry).not.toBe(true);
      if (!entry || entry === true) {
        throw new Error("Expected an enriched rolledUpFrom entry");
      }

      expect(entry.inputTokens).toBe(11);
      expect(entry.outputTokens).toBe(7);
      expect(entry.reasoningTokens).toBe(5);
      expect(entry.cachedTokens).toBe(3);
      expect(entry.cacheCreateTokens).toBe(2);
      expect(entry.totalTokens).toBe(28);
      expect(entry.contextTokens).toBe(16);
    });

    it("should store enriched RolledUpChildEntry when childMeta is provided", async () => {
      const projectPath = "/tmp/mux-session-usage-test-project";
      const model = "claude-sonnet-4-20250514";
      const parentWorkspaceId = "parent-workspace";
      const childWorkspaceId = "child-workspace";

      await config.addWorkspace(projectPath, {
        id: parentWorkspaceId,
        name: "parent-branch",
        projectName: "test-project",
        projectPath,
        runtimeConfig: { type: "local" },
      });

      const childUsageByModel = { [model]: createUsage(10, 5) };
      await service.rollUpUsageIntoParent(parentWorkspaceId, childWorkspaceId, childUsageByModel, {
        agentType: "explore",
        model,
      });

      const result = await service.getSessionUsage(parentWorkspaceId);
      expect(result).toBeDefined();

      const entry = result!.rolledUpFrom?.[childWorkspaceId];
      expect(entry).toBeDefined();
      expect(entry).not.toBe(true);
      if (!entry || entry === true) {
        throw new Error("Expected an enriched rolledUpFrom entry");
      }

      expect(entry.totalTokens).toBe(15);
      expect(entry.contextTokens).toBe(10);
      expect(entry.agentType).toBe("explore");
      expect(entry.model).toBe(model);
      expect(entry.rolledUpAtMs).toBeGreaterThan(0);
    });

    it("should still be idempotent with enriched entries", async () => {
      const projectPath = "/tmp/mux-session-usage-test-project";
      const model = "claude-sonnet-4-20250514";

      const parentWorkspaceId = "parent-workspace";
      const childWorkspaceId = "child-workspace";

      await config.addWorkspace(projectPath, {
        id: parentWorkspaceId,
        name: "parent-branch",
        projectName: "test-project",
        projectPath,
        runtimeConfig: { type: "local" },
      });

      const childUsageByModel = { [model]: createUsage(10, 5) };

      const first = await service.rollUpUsageIntoParent(
        parentWorkspaceId,
        childWorkspaceId,
        childUsageByModel,
        { agentType: "explore", model }
      );
      expect(first.didRollUp).toBe(true);

      const second = await service.rollUpUsageIntoParent(
        parentWorkspaceId,
        childWorkspaceId,
        childUsageByModel,
        { agentType: "explore", model }
      );
      expect(second.didRollUp).toBe(false);

      const result = await service.getSessionUsage(parentWorkspaceId);
      expect(result).toBeDefined();
      expect(result!.byModel[model].input.tokens).toBe(10);
      expect(result!.byModel[model].output.tokens).toBe(5);

      const entry = result!.rolledUpFrom?.[childWorkspaceId];
      expect(entry).toBeDefined();
      expect(entry).not.toBe(true);
      if (!entry || entry === true) {
        throw new Error("Expected an enriched rolledUpFrom entry");
      }
      expect(entry.totalTokens).toBe(15);
      expect(entry.contextTokens).toBe(10);
    });

    it("should include totalCostUsd in enriched entry when usage has costs", async () => {
      const projectPath = "/tmp/mux-session-usage-test-project";
      const parentWorkspaceId = "parent-workspace";
      const childWorkspaceId = "child-workspace";
      const model = "claude-sonnet-4-20250514";

      await config.addWorkspace(projectPath, {
        id: parentWorkspaceId,
        name: "parent-branch",
        projectName: "test-project",
        projectPath,
        runtimeConfig: { type: "local" },
      });

      await service.rollUpUsageIntoParent(
        parentWorkspaceId,
        childWorkspaceId,
        { [model]: createUsageWithCosts(3, 2, 0.25, 0.5) },
        { agentType: "explore", model }
      );

      const result = await service.getSessionUsage(parentWorkspaceId);
      const entry = result?.rolledUpFrom?.[childWorkspaceId];
      expect(entry).toBeDefined();
      expect(entry).not.toBe(true);
      if (!entry || entry === true) {
        throw new Error("Expected an enriched rolledUpFrom entry");
      }

      expect(entry.totalTokens).toBe(5);
      expect(entry.contextTokens).toBe(3);
      expect(entry.totalCostUsd).toBe(0.75);
    });

    it("should omit totalCostUsd when no usage buckets have costs", async () => {
      const projectPath = "/tmp/mux-session-usage-test-project";
      const parentWorkspaceId = "parent-workspace";
      const childWorkspaceId = "child-workspace";
      const model = "claude-sonnet-4-20250514";

      await config.addWorkspace(projectPath, {
        id: parentWorkspaceId,
        name: "parent-branch",
        projectName: "test-project",
        projectPath,
        runtimeConfig: { type: "local" },
      });

      await service.rollUpUsageIntoParent(
        parentWorkspaceId,
        childWorkspaceId,
        { [model]: createUsage(3, 2) },
        { agentType: "explore", model }
      );

      const result = await service.getSessionUsage(parentWorkspaceId);
      const entry = result?.rolledUpFrom?.[childWorkspaceId];
      expect(entry).toBeDefined();
      expect(entry).not.toBe(true);
      if (!entry || entry === true) {
        throw new Error("Expected an enriched rolledUpFrom entry");
      }

      expect(entry.totalTokens).toBe(5);
      expect(entry.contextTokens).toBe(3);
      expect(entry.totalCostUsd).toBeUndefined();
    });

    it("should handle backward-compat: existing true entries coexist with enriched", async () => {
      const projectPath = "/tmp/mux-session-usage-test-project";
      const parentWorkspaceId = "parent-workspace";
      const childWorkspaceId = "new-child-workspace";
      const model = "claude-sonnet-4-20250514";
      const legacyChildWorkspaceId = "legacy-child-workspace";

      await config.addWorkspace(projectPath, {
        id: parentWorkspaceId,
        name: "parent-branch",
        projectName: "test-project",
        projectPath,
        runtimeConfig: { type: "local" },
      });

      const usagePath = path.join(
        path.join(config.sessionsDir, parentWorkspaceId),
        "session-usage.json"
      );
      await fs.mkdir(path.dirname(usagePath), { recursive: true });
      await fs.writeFile(
        usagePath,
        JSON.stringify(
          {
            byModel: {},
            rolledUpFrom: { [legacyChildWorkspaceId]: true },
            version: 1,
          },
          null,
          2
        )
      );

      await service.rollUpUsageIntoParent(
        parentWorkspaceId,
        childWorkspaceId,
        { [model]: createUsage(4, 6) },
        { agentType: "explore", model }
      );

      const result = await service.getSessionUsage(parentWorkspaceId);
      expect(result).toBeDefined();
      expect(result!.rolledUpFrom?.[legacyChildWorkspaceId]).toBe(true);

      const newEntry = result!.rolledUpFrom?.[childWorkspaceId];
      expect(newEntry).toBeDefined();
      expect(newEntry).not.toBe(true);
      if (!newEntry || newEntry === true) {
        throw new Error("Expected an enriched rolledUpFrom entry");
      }

      expect(newEntry.totalTokens).toBe(10);
      expect(newEntry.contextTokens).toBe(4);
      expect(newEntry.agentType).toBe("explore");
      expect(newEntry.model).toBe(model);
    });
  });
  describe("recordUsage", () => {
    it("should accumulate usage for same model (not overwrite)", async () => {
      const workspaceId = "test-workspace";
      const model = "claude-sonnet-4-20250514";
      const usage1 = createUsage(100, 50);
      const usage2 = createUsage(200, 75);

      await service.recordUsage(workspaceId, model, usage1);
      await service.recordUsage(workspaceId, model, usage2);

      const result = await service.getSessionUsage(workspaceId);
      expect(result).toBeDefined();
      expect(result!.byModel[model].input.tokens).toBe(300); // 100 + 200
      expect(result!.byModel[model].output.tokens).toBe(125); // 50 + 75
    });

    it("should track separate usage per model", async () => {
      const workspaceId = "test-workspace";
      const sonnet = createUsage(100, 50);
      const opus = createUsage(500, 200);

      await service.recordUsage(workspaceId, "claude-sonnet-4-20250514", sonnet);
      await service.recordUsage(workspaceId, "claude-opus-4-20250514", opus);

      const result = await service.getSessionUsage(workspaceId);
      expect(result).toBeDefined();
      expect(result!.byModel["claude-sonnet-4-20250514"].input.tokens).toBe(100);
      expect(result!.byModel["claude-opus-4-20250514"].input.tokens).toBe(500);
    });

    it("keeps mixed-model session totals separate while lastRequest follows the latest write", async () => {
      const workspaceId = "test-workspace";
      const parentModel = "openai:gpt-5.2";
      const advisorModel = "anthropic:claude-sonnet-4-20250514";
      const parentUsage = createUsage(100, 50);
      const advisorUsage = createUsage(40, 10);

      await service.recordUsage(workspaceId, parentModel, parentUsage);
      await service.recordUsage(workspaceId, advisorModel, advisorUsage);

      const result = await service.getSessionUsage(workspaceId);
      expect(result).toBeDefined();
      expect(result?.byModel[parentModel]).toEqual(parentUsage);
      expect(result?.byModel[advisorModel]).toEqual(advisorUsage);
      expect(result?.lastRequest?.model).toBe(advisorModel);
      expect(result?.lastRequest?.usage).toEqual(advisorUsage);
    });

    it("should update lastRequest with each recordUsage call", async () => {
      const workspaceId = "test-workspace";
      const usage1 = createUsage(100, 50);
      const usage2 = createUsage(200, 75);

      await service.recordUsage(workspaceId, "claude-sonnet-4-20250514", usage1);
      let result = await service.getSessionUsage(workspaceId);
      expect(result?.lastRequest?.model).toBe("claude-sonnet-4-20250514");
      expect(result?.lastRequest?.usage.input.tokens).toBe(100);

      await service.recordUsage(workspaceId, "claude-opus-4-20250514", usage2);
      result = await service.getSessionUsage(workspaceId);
      expect(result?.lastRequest?.model).toBe("claude-opus-4-20250514");
      expect(result?.lastRequest?.usage.input.tokens).toBe(200);
    });
  });

  describe("recordHeadlessUsage", () => {
    it("refuses writes for a removed workspace (r62)", async () => {
      // A foreign backend's dream/harvest run survives the remover's
      // process-local cancellation; its late usage write must not recreate
      // the deleted session directory.
      const workspaceId = "removed-workspace";
      const tombstonePath = workspaceRemovalTombstonePath(config.rootDir, workspaceId);
      await fs.mkdir(path.dirname(tombstonePath), { recursive: true });
      await fs.writeFile(tombstonePath, JSON.stringify({ workspaceId, removedAt: Date.now() }));

      const recorded = await service.recordHeadlessUsage(
        workspaceId,
        "anthropic:claude-haiku-4-5",
        { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
        undefined,
        { analyticsSource: "memory_consolidation" }
      );
      expect(recorded).toBeUndefined();
      const sessionDir = path.join(config.sessionsDir, workspaceId);
      expect(
        await fs.access(sessionDir).then(
          () => true,
          () => false
        )
      ).toBe(false);
    });

    it("accumulates into byModel without replacing lastRequest", async () => {
      const workspaceId = "test-workspace";
      const agentModel = "anthropic:claude-sonnet-4-20250514";
      const statusModel = "anthropic:claude-haiku-4-5";

      // Normal agent turn establishes lastRequest.
      await service.recordUsage(workspaceId, agentModel, createUsage(100, 50));

      // Background status or memory calls must add spend but keep the user's
      // actual last agent request visible in the Costs tab.
      await service.recordHeadlessUsage(workspaceId, statusModel, {
        inputTokens: 40,
        outputTokens: 10,
        totalTokens: 50,
      });

      const result = await service.getSessionUsage(workspaceId);
      expect(result?.byModel[statusModel]?.input.tokens).toBe(40);
      expect(result?.byModel[statusModel]?.output.tokens).toBe(10);
      expect(result?.lastRequest?.model).toBe(agentModel);
      expect(result?.lastRequest?.usage.input.tokens).toBe(100);
    });

    it("prices costsIncluded (subscription-covered) usage at $0", async () => {
      const workspaceId = "test-workspace";
      const model = "openai:gpt-5.2";

      const recorded = await service.recordHeadlessUsage(
        workspaceId,
        model,
        { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        undefined,
        { costsIncluded: true }
      );

      expect(recorded?.usage.costsIncluded).toBe(true);
      expect(recorded?.usage.input.tokens).toBe(1000);
      expect(getTotalCost(recorded!.usage)).toBe(0);
    });

    it("appends to the headless-usage sidecar only when an analyticsSource is given", async () => {
      const workspaceId = "test-workspace";
      const model = "anthropic:claude-sonnet-4-20250514";
      const sidecarPath = path.join(
        path.join(config.sessionsDir, workspaceId),
        "headless-usage.jsonl"
      );

      // No analytics source means no sidecar entry.
      await service.recordHeadlessUsage(workspaceId, model, {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      });
      expect(existsSync(sidecarPath)).toBe(false);

      await service.recordHeadlessUsage(
        workspaceId,
        model,
        { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
        undefined,
        { analyticsSource: "workspace_status" }
      );
      const lines = (await fs.readFile(sidecarPath, "utf-8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]) as Record<string, unknown>;
      expect(record.source).toBe("workspace_status");
      expect(record.model).toBe(model);
      expect((record.usage as Record<string, unknown>).inputTokens).toBe(40);
    });

    it("still appends the analytics sidecar when the usage ledger is corrupt", async () => {
      const workspaceId = "test-workspace";
      const model = "anthropic:claude-sonnet-4-20250514";
      const sessionDir = path.join(config.sessionsDir, workspaceId);
      await fs.mkdir(sessionDir, { recursive: true });
      // Corrupt ledger: readFile throws on bad JSON (non-ENOENT), which must
      // not block the sidecar — headless spend has no chat-row fallback.
      await fs.writeFile(path.join(sessionDir, "session-usage.json"), "{not json");

      const recorded = await service.recordHeadlessUsage(
        workspaceId,
        model,
        { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
        undefined,
        { analyticsSource: "workspace_status" }
      );

      // Sidecar callers key their analytics-ingest trigger off the return.
      expect(recorded?.model).toBe(model);
      const sidecarPath = path.join(sessionDir, "headless-usage.jsonl");
      const record = JSON.parse((await fs.readFile(sidecarPath, "utf-8")).trim()) as Record<
        string,
        unknown
      >;
      expect(record.source).toBe("workspace_status");

      // Without a sidecar, a failed ledger write must not report success.
      const ledgerOnlyRecorded = await service.recordHeadlessUsage(workspaceId, model, {
        inputTokens: 40,
        outputTokens: 10,
        totalTokens: 50,
      });
      expect(ledgerOnlyRecorded).toBeUndefined();
    });

    it("writes the sidecar before the ledger so a sidecar failure leaves no ledger-only spend", async () => {
      // Ordering contract: the sidecar is the ETL's only replay source, so a
      // crash between the two writes must strand the LEDGER (self-heals via
      // rebuild), never the sidecar. Behavioral proxy: an unwritable sidecar
      // (directory at the path) must abort BEFORE the ledger update.
      const workspaceId = "test-workspace";
      const model = "anthropic:claude-sonnet-4-20250514";
      const sessionDir = path.join(config.sessionsDir, workspaceId);
      await fs.mkdir(path.join(sessionDir, "headless-usage.jsonl"), { recursive: true });

      const recorded = await service.recordHeadlessUsage(
        workspaceId,
        model,
        { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
        undefined,
        { analyticsSource: "workspace_status" }
      );

      expect(recorded).toBeUndefined();
      // Ledger untouched: no session-usage.json was created.
      expect(existsSync(path.join(sessionDir, "session-usage.json"))).toBe(false);
    });

    it("resolves mappedToModel aliases for pricing and stamps metadataModel in the sidecar", async () => {
      const workspaceId = "test-workspace";
      const mappedService = new SessionUsageService(config, historyService, () => ({
        mycustom: {
          apiKeySet: true,
          isEnabled: true,
          isConfigured: true,
          models: [{ id: "my-alias", mappedToModel: "anthropic:claude-sonnet-4-20250514" }],
        },
      }));

      const recorded = await mappedService.recordHeadlessUsage(
        workspaceId,
        "mycustom:my-alias",
        { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        undefined,
        { analyticsSource: "workspace_status" }
      );

      // Priced via the mapped model — the raw custom ID has no pricing entry
      // and would leave cost_usd undefined.
      expect(recorded?.usage.input.cost_usd).toBeGreaterThan(0);

      const sidecarPath = path.join(
        path.join(config.sessionsDir, workspaceId),
        "headless-usage.jsonl"
      );
      const record = JSON.parse((await fs.readFile(sidecarPath, "utf-8")).trim()) as Record<
        string,
        unknown
      >;
      // model keeps the raw ID for attribution; metadataModel carries the
      // resolved alias target for ETL pricing.
      expect(record.model).toBe("mycustom:my-alias");
      expect(record.metadataModel).toBe("anthropic:claude-sonnet-4-20250514");
    });

    it("uses the caller-pinned metadataModel for coder models over live re-resolution", async () => {
      // Dropped-partial sidecar writes happen after the turn's Coder instance
      // may have been removed/retagged by a catalog refresh: the default
      // service config knows nothing about this instance, so live resolution
      // would persist the raw (unpriceable) coder ID.
      const workspaceId = "test-workspace";
      const recorded = await service.recordHeadlessUsage(
        workspaceId,
        "coder:prod-anthropic/claude-sonnet-4-20250514",
        { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        undefined,
        {
          analyticsSource: "aborted_stream",
          skipSessionLedger: true,
          metadataModel: "anthropic:claude-sonnet-4-20250514",
        }
      );

      // Priced via the pinned identity — the raw coder ID has no pricing
      // entry and would leave cost_usd undefined.
      expect(recorded?.model).toBe("anthropic:claude-sonnet-4-20250514");
      expect(recorded?.usage.input.cost_usd).toBeGreaterThan(0);

      const sidecarPath = path.join(
        path.join(config.sessionsDir, workspaceId),
        "headless-usage.jsonl"
      );
      const record = JSON.parse((await fs.readFile(sidecarPath, "utf-8")).trim()) as Record<
        string,
        unknown
      >;
      expect(record.model).toBe("anthropic:claude-sonnet-4-20250514");
      expect(record.metadataModel).toBe("anthropic:claude-sonnet-4-20250514");
    });
  });

  describe("resetSessionUsage", () => {
    it("should replace existing usage with an explicit empty ledger", async () => {
      const workspaceId = "test-workspace";
      const model = "claude-sonnet-4-20250514";

      await service.recordUsage(workspaceId, model, createUsageWithCosts(100, 50, 0.12, 0.08));

      await service.resetSessionUsage(workspaceId);

      const result = await service.getSessionUsage(workspaceId);
      expect(result).toEqual({ byModel: {}, version: 1 });
    });
  });

  describe("setTokenStatsCache", () => {
    it("should persist tokenStatsCache and preserve existing usage fields", async () => {
      const projectPath = "/tmp/mux-session-usage-test-project";
      const model = "claude-sonnet-4-20250514";

      const parentWorkspaceId = "parent-workspace";
      const childWorkspaceId = "child-workspace";

      await config.addWorkspace(projectPath, {
        id: parentWorkspaceId,
        name: "parent-branch",
        projectName: "test-project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      await config.addWorkspace(projectPath, {
        id: childWorkspaceId,
        name: "child-branch",
        projectName: "test-project",
        projectPath,
        runtimeConfig: { type: "local" },
        parentWorkspaceId: parentWorkspaceId,
      });

      // Seed: base usage + rolledUpFrom ledger
      await service.recordUsage(parentWorkspaceId, model, createUsage(100, 50));
      await service.rollUpUsageIntoParent(parentWorkspaceId, childWorkspaceId, {
        [model]: createUsage(7, 3),
      });

      const cache: SessionUsageTokenStatsCacheV1 = {
        version: 1,
        computedAt: 123,
        model: "gpt-4",
        tokenizerName: "cl100k",
        history: { messageCount: 2, maxHistorySequence: 42 },
        consumers: [{ name: "User", tokens: 10, percentage: 100 }],
        totalTokens: 10,
        topFilePaths: [{ path: "/tmp/file.ts", tokens: 10 }],
      };

      await service.setTokenStatsCache(parentWorkspaceId, cache);

      const result = await service.getSessionUsage(parentWorkspaceId);
      expect(result).toBeDefined();
      expect(result!.tokenStatsCache).toEqual(cache);
      expect(result!.rolledUpFrom?.[childWorkspaceId]).toBeDefined();

      // Existing usage fields preserved
      expect(result!.byModel[model].input.tokens).toBe(107);
      expect(result!.byModel[model].output.tokens).toBe(53);
      expect(result!.lastRequest).toBeDefined();
    });
  });

  describe("getSessionUsage", () => {
    it("should rebuild from messages when file missing (ENOENT)", async () => {
      const workspaceId = "test-workspace";
      // Seed messages via real historyService
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("msg1", "assistant", "Hello", {
          model: "claude-sonnet-4-20250514",
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        })
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("msg2", "assistant", "World", {
          model: "claude-sonnet-4-20250514",
          usage: { inputTokens: 200, outputTokens: 75, totalTokens: 275 },
        })
      );

      // Delete session-usage.json but keep session dir (appendToHistory created it)
      const usagePath = path.join(config.sessionsDir, workspaceId, "session-usage.json");
      await fs.rm(usagePath, { force: true });

      const result = await service.getSessionUsage(workspaceId);

      expect(result).toBeDefined();
      // Should have rebuilt and summed the usage
      expect(result!.byModel["claude-sonnet-4-20250514"]).toBeDefined();
    });
  });

  describe("rebuildFromMessages", () => {
    it("should rebuild from messages when file is corrupted JSON", async () => {
      const workspaceId = "test-workspace";
      // Seed messages via real historyService
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("msg1", "assistant", "Hello", {
          model: "claude-sonnet-4-20250514",
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        })
      );

      // Overwrite session-usage.json with corrupted JSON
      const sessionDir = path.join(config.sessionsDir, workspaceId);
      await fs.writeFile(path.join(sessionDir, "session-usage.json"), "{ invalid json");

      const result = await service.getSessionUsage(workspaceId);

      expect(result).toBeDefined();
      // Should have rebuilt from messages
      expect(result!.byModel["claude-sonnet-4-20250514"]).toBeDefined();
      expect(result!.byModel["claude-sonnet-4-20250514"].input.tokens).toBe(100);
    });

    it("should rebuild same-model totals from assistant usage and tool model usages", async () => {
      const workspaceId = "tool-usage-rebuild-workspace";
      const model = "anthropic:claude-sonnet-4-20250514";
      const parentUsage = {
        inputTokens: 140,
        cachedInputTokens: 20,
        outputTokens: 48,
        totalTokens: 188,
      };
      const parentProviderMetadata = {
        anthropic: { cacheCreationInputTokens: 10 },
      };
      const toolUsage = {
        toolName: "advisor",
        toolCallId: "tool-call-1",
        timestamp: Date.now(),
        model,
        usage: {
          inputTokens: 70,
          cachedInputTokens: 8,
          outputTokens: 24,
          totalTokens: 94,
        },
        providerMetadata: {
          anthropic: { cacheCreationInputTokens: 4 },
        },
      };

      const assistantMessage = createMuxMessage("msg-tool-usage", "assistant", "Hello", {
        historySequence: 1,
        timestamp: Date.now(),
        model,
        usage: parentUsage,
        providerMetadata: parentProviderMetadata,
      });
      Object.assign((assistantMessage.metadata ??= {}), {
        toolModelUsages: [toolUsage],
      });

      await service.rebuildFromMessages(workspaceId, [assistantMessage]);

      const result = await service.getSessionUsage(workspaceId);
      expect(result).toBeDefined();
      const canonicalModel = normalizeToCanonical(model);
      expect(Object.keys(result?.byModel ?? {})).toEqual([canonicalModel]);

      const expectedParentUsage = createDisplayUsage(parentUsage, model, parentProviderMetadata);
      const expectedToolUsage = createDisplayUsage(
        toolUsage.usage,
        toolUsage.model,
        toolUsage.providerMetadata
      );
      expect(expectedParentUsage).toBeDefined();
      expect(expectedToolUsage).toBeDefined();
      if (!expectedParentUsage || !expectedToolUsage || !result) {
        throw new Error("Expected tool usage rebuild test to compute display usage and result");
      }
      const expectedMergedUsage = sumUsageHistory([expectedParentUsage, expectedToolUsage]);
      expect(expectedMergedUsage).toBeDefined();
      if (!expectedMergedUsage) {
        throw new Error("Expected merged tool usage to be defined");
      }

      expect(result.byModel[canonicalModel]).toEqual(expectedMergedUsage);
      expect(getTotalCost(result.byModel[canonicalModel])).toBeCloseTo(
        getTotalCost(expectedMergedUsage) ?? 0,
        12
      );
    });

    it("keys recovered Coder usage by the persisted metadata model", async () => {
      // Recovery runs AFTER mutable instance metadata may have changed: here
      // the custom instance is gone from providers config entirely, so
      // re-resolving the raw coder: model would produce an unresolvable raw
      // key that repricing later strips. The persisted record-time
      // metadataModel must key the bucket instead — for the assistant usage
      // AND the tool usage.
      const workspaceId = "coder-metadata-model-rebuild";
      const rawModel = "coder:prod-anthropic/claude-opus-4-5";
      const metadataModel = "anthropic:claude-opus-4-5";
      const toolUsage = {
        toolName: "advisor",
        toolCallId: "tool-call-coder-1",
        timestamp: Date.now(),
        model: rawModel,
        metadataModel,
        usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
      };
      const assistantMessage = createMuxMessage("msg-coder-rebuild", "assistant", "Hello", {
        historySequence: 1,
        timestamp: Date.now(),
        model: rawModel,
        metadataModel,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      });
      Object.assign((assistantMessage.metadata ??= {}), {
        toolModelUsages: [toolUsage],
      });

      await service.rebuildFromMessages(workspaceId, [assistantMessage]);

      const result = await service.getSessionUsage(workspaceId);
      expect(result).toBeDefined();
      expect(Object.keys(result?.byModel ?? {})).toEqual([metadataModel]);
      expect(result?.byModel[metadataModel]?.input.tokens).toBe(130);
      expect(result?.lastRequest?.model).toBe(metadataModel);
    });

    it("skips zero-usage refusal markers but keeps billed refusal usage during rebuild", async () => {
      // Zero-usage model_fallback_refusal entries are analytics-only markers:
      // the live path never records them in the session ledger, so a rebuild
      // must not surface 0-token/$0 Costs rows for models that only refused.
      const workspaceId = "tool-usage-rebuild-skips-zero-refusals";
      const answeringModel = "anthropic:claude-opus-4-5";
      const refusedZeroModel = "anthropic:claude-sonnet-4-20250514";
      const refusedBilledModel = "openai:gpt-5.2";
      const assistantMessage = createMuxMessage("msg-zero-refusal", "assistant", "Hello", {
        historySequence: 1,
        timestamp: Date.now(),
        model: answeringModel,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      });
      Object.assign((assistantMessage.metadata ??= {}), {
        toolModelUsages: [
          {
            toolName: "model_fallback_refusal",
            timestamp: Date.now(),
            model: refusedZeroModel,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          },
          {
            toolName: "model_fallback_refusal",
            timestamp: Date.now(),
            model: refusedBilledModel,
            usage: { inputTokens: 40, outputTokens: 0, totalTokens: 40 },
          },
        ],
      });

      await service.rebuildFromMessages(workspaceId, [assistantMessage]);

      const result = await service.getSessionUsage(workspaceId);
      expect(result).toBeDefined();
      const models = Object.keys(result?.byModel ?? {});
      // Billed refusal usage still merges (live path records it too)…
      expect(models).toContain(normalizeToCanonical(answeringModel));
      expect(models).toContain(normalizeToCanonical(refusedBilledModel));
      // …but the zero-usage marker leaves no ledger entry.
      expect(models).not.toContain(normalizeToCanonical(refusedZeroModel));
    });

    it("should skip malformed tool model usage entries during rebuild", async () => {
      const workspaceId = "tool-usage-rebuild-skips-malformed";
      const sameModel = "openai:gpt-4";
      const otherModel = "anthropic:claude-sonnet-4-20250514";
      const validSameModelToolUsage = {
        toolName: "bash",
        toolCallId: "tool-call-valid-1",
        timestamp: 1_700_000_000_025,
        model: sameModel,
        usage: {
          inputTokens: 36,
          outputTokens: 12,
          totalTokens: 48,
        },
        providerMetadata: {
          openai: { reasoningTokens: 3 },
        },
      };
      const validOtherModelToolUsage = {
        toolName: "advisor",
        toolCallId: "tool-call-valid-2",
        timestamp: 1_700_000_000_050,
        model: otherModel,
        usage: {
          inputTokens: 96,
          cachedInputTokens: 10,
          outputTokens: 18,
          totalTokens: 114,
        },
        providerMetadata: {
          anthropic: { cacheCreationInputTokens: 4 },
        },
      };

      const assistantMessage = createMuxMessage("msg-tool-usage-malformed", "assistant", "Hello", {
        historySequence: 1,
        timestamp: 1_700_000_000_000,
      });
      Object.assign((assistantMessage.metadata ??= {}), {
        toolModelUsages: [
          validSameModelToolUsage,
          null,
          42,
          {},
          { model: "m" },
          { model: "m", usage: null },
          validOtherModelToolUsage,
        ],
      });

      await service.rebuildFromMessages(workspaceId, [assistantMessage]);

      const result = await service.getSessionUsage(workspaceId);
      expect(result).toBeDefined();
      expect(result?.lastRequest).toBeUndefined();

      const canonicalSameModel = normalizeToCanonical(sameModel);
      const canonicalOtherModel = normalizeToCanonical(otherModel);
      expect(Object.keys(result?.byModel ?? {}).sort()).toEqual(
        [canonicalOtherModel, canonicalSameModel].sort()
      );

      const expectedSameModelUsage = createDisplayUsage(
        validSameModelToolUsage.usage,
        validSameModelToolUsage.model,
        validSameModelToolUsage.providerMetadata
      );
      const expectedOtherModelUsage = createDisplayUsage(
        validOtherModelToolUsage.usage,
        validOtherModelToolUsage.model,
        validOtherModelToolUsage.providerMetadata
      );
      expect(expectedSameModelUsage).toBeDefined();
      expect(expectedOtherModelUsage).toBeDefined();
      if (!expectedSameModelUsage || !expectedOtherModelUsage || !result) {
        throw new Error("Expected malformed tool usage rebuild test to compute display usage");
      }

      expect(result.byModel[canonicalSameModel]).toEqual(expectedSameModelUsage);
      expect(result.byModel[canonicalOtherModel]).toEqual(expectedOtherModelUsage);
    });

    it("should include historicalUsage from legacy compaction summaries", async () => {
      const workspaceId = "test-workspace";

      // Create a compaction summary with historicalUsage (legacy format)
      const compactionSummary = createMuxMessage("summary-1", "assistant", "Compacted summary", {
        historySequence: 1,
        compacted: true,
        model: "anthropic:claude-sonnet-4-5",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      });

      // Add historicalUsage - this field was removed from XumMetadata type
      // but may still exist in persisted data from before the change
      (compactionSummary.metadata as Record<string, unknown>).historicalUsage = createUsage(
        5000,
        1000
      );

      // Add a post-compaction message
      const postCompactionMsg = createMuxMessage("msg2", "assistant", "New response", {
        historySequence: 2,
        model: "anthropic:claude-sonnet-4-5",
        usage: { inputTokens: 200, outputTokens: 75, totalTokens: 275 },
      });

      // Seed messages via real historyService
      await historyService.appendToHistory(workspaceId, compactionSummary);
      await historyService.appendToHistory(workspaceId, postCompactionMsg);

      // Delete session-usage.json to trigger rebuild from messages
      const usagePath = path.join(config.sessionsDir, workspaceId, "session-usage.json");
      await fs.rm(usagePath, { force: true });

      const result = await service.getSessionUsage(workspaceId);

      expect(result).toBeDefined();
      // Should include historical usage under "historical" key
      expect(result!.byModel.historical).toBeDefined();
      expect(result!.byModel.historical.input.tokens).toBe(5000);
      expect(result!.byModel.historical.output.tokens).toBe(1000);

      // Should also include current model usage (compaction summary + post-compaction)
      expect(result!.byModel["anthropic:claude-sonnet-4-5"]).toBeDefined();
      expect(result!.byModel["anthropic:claude-sonnet-4-5"].input.tokens).toBe(300); // 100 + 200
    });
  });
});
