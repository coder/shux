import { beforeEach, describe, expect, test, spyOn } from "bun:test";
import { TokenizerService } from "./tokenizerService";
import type { SessionUsageService } from "./sessionUsageService";
import * as tokenizerUtils from "@/node/utils/main/tokenizer";
import * as statsUtils from "@/common/utils/tokens/tokenStatsCalculator";
import { CONTEXT_BOUNDARY_KINDS } from "@/common/constants/contextBoundary";
import { createMuxMessage } from "@/common/types/message";
const GLOBAL_WORKSPACE_ID = "workspace-global";

describe("TokenizerService", () => {
  let sessionUsageService: SessionUsageService;
  let service: TokenizerService;

  beforeEach(() => {
    sessionUsageService = {
      setTokenStatsCache: () => Promise.resolve(),
    } as unknown as SessionUsageService;
    service = new TokenizerService(
      sessionUsageService,
      { getWorkspaceMetadata: () => Promise.resolve({ success: false, error: "not found" }) },
      { getConfig: () => ({}) }
    );
  });

  describe("countTokens", () => {
    test("delegates to underlying function", async () => {
      const spy = spyOn(tokenizerUtils, "countTokens").mockResolvedValue(42);

      const result = await service.countTokens("gpt-4", "hello world");
      expect(result).toBe(42);
      expect(spy).toHaveBeenCalledWith("gpt-4", "hello world");
      spy.mockRestore();
    });

    test("throws on empty model", () => {
      expect(service.countTokens("", "text")).rejects.toThrow("requires model name");
    });

    test("throws on invalid text", () => {
      // @ts-expect-error testing runtime validation
      expect(service.countTokens("gpt-4", null)).rejects.toThrow("requires text");
    });
  });

  describe("countTokensBatch", () => {
    test("delegates to underlying function", async () => {
      const spy = spyOn(tokenizerUtils, "countTokensBatch").mockResolvedValue([10, 20]);

      const result = await service.countTokensBatch("gpt-4", ["a", "b"]);
      expect(result).toEqual([10, 20]);
      expect(spy).toHaveBeenCalledWith("gpt-4", ["a", "b"]);
      spy.mockRestore();
    });

    test("throws on non-array input", () => {
      // @ts-expect-error testing runtime validation
      expect(service.countTokensBatch("gpt-4", "not-array")).rejects.toThrow("requires an array");
    });
  });

  describe("calculateStats", () => {
    test("delegates to underlying function and persists token stats cache", async () => {
      const messages = [
        createMuxMessage("msg1", "user", "Hello", { historySequence: 1 }),
        createMuxMessage("msg2", "assistant", "World", { historySequence: 2 }),
      ];

      const mockResult = {
        consumers: [{ name: "User", tokens: 100, percentage: 100 }],
        totalTokens: 100,
        model: "gpt-4",
        tokenizerName: "cl100k",
        usageHistory: [],
      };
      const statsSpy = spyOn(statsUtils, "calculateTokenStats").mockResolvedValue(mockResult);
      const persistSpy = spyOn(sessionUsageService, "setTokenStatsCache").mockResolvedValue(
        undefined
      );
      const nowSpy = spyOn(Date, "now").mockReturnValue(1234);

      // try/finally: a leaked Date.now spy freezes time process-wide and breaks
      // downstream suites (e.g. WorkflowService crash-recovery retries).
      try {
        const result = await service.calculateStats("test-workspace", messages, "gpt-4");
        expect(result).toBe(mockResult);
        expect(statsSpy).toHaveBeenCalledWith(messages, "gpt-4", null, {
          enableAgentReport: false,
          enableReviewPane: true,
        });
        expect(persistSpy).toHaveBeenCalledWith(
          "test-workspace",
          expect.objectContaining({
            version: 1,
            computedAt: 1234,
            model: "gpt-4",
            tokenizerName: "cl100k",
            totalTokens: 100,
            consumers: mockResult.consumers,
            history: { messageCount: 2, maxHistorySequence: 2 },
          })
        );
      } finally {
        nowSpy.mockRestore();
        statsSpy.mockRestore();
        persistSpy.mockRestore();
      }
    });

    test("excludes a leading reset boundary from token stats", async () => {
      const resetBoundary = createMuxMessage("reset", "assistant", "", {
        historySequence: 2,
        contextBoundaryKind: CONTEXT_BOUNDARY_KINDS.RESET,
      });
      const messages = [
        resetBoundary,
        createMuxMessage("msg1", "user", "Hello", { historySequence: 3 }),
      ];
      const mockResult = {
        consumers: [{ name: "User", tokens: 1, percentage: 100 }],
        totalTokens: 1,
        model: "gpt-4",
        tokenizerName: "cl100k",
        usageHistory: [],
      };
      const statsSpy = spyOn(statsUtils, "calculateTokenStats").mockResolvedValue(mockResult);
      const persistSpy = spyOn(sessionUsageService, "setTokenStatsCache").mockResolvedValue(
        undefined
      );

      await service.calculateStats("test-workspace", messages, "gpt-4");

      expect(statsSpy).toHaveBeenCalledWith([messages[1]], "gpt-4", null, {
        enableAgentReport: false,
        enableReviewPane: true,
      });
      expect(persistSpy).toHaveBeenCalledWith(
        "test-workspace",
        expect.objectContaining({ history: { messageCount: 1, maxHistorySequence: 3 } })
      );

      statsSpy.mockRestore();
      persistSpy.mockRestore();
    });

    test("passes tool availability options to calculateTokenStats", async () => {
      const messages = [createMuxMessage("msg1", "user", "Hello")];
      const mockResult = {
        consumers: [{ name: "User", tokens: 1, percentage: 100 }],
        totalTokens: 1,
        model: "gpt-4",
        tokenizerName: "cl100k",
        usageHistory: [],
      };

      const statsSpy = spyOn(statsUtils, "calculateTokenStats").mockResolvedValue(mockResult);
      const persistSpy = spyOn(sessionUsageService, "setTokenStatsCache").mockResolvedValue(
        undefined
      );

      await service.calculateStats(GLOBAL_WORKSPACE_ID, messages, "gpt-4");
      await service.calculateStats("another-workspace", messages, "gpt-4");

      expect(statsSpy).toHaveBeenNthCalledWith(1, messages, "gpt-4", null, {
        enableAgentReport: false,
        enableReviewPane: true,
      });
      expect(statsSpy).toHaveBeenNthCalledWith(2, messages, "gpt-4", null, {
        enableAgentReport: false,
        enableReviewPane: true,
      });

      statsSpy.mockRestore();
      persistSpy.mockRestore();
    });

    test("passes enableAgentReport true when parentWorkspaceId is provided", async () => {
      const messages = [createMuxMessage("msg1", "user", "Hello")];
      const mockResult = {
        consumers: [{ name: "User", tokens: 1, percentage: 100 }],
        totalTokens: 1,
        model: "gpt-4",
        tokenizerName: "cl100k",
        usageHistory: [],
      };

      const statsSpy = spyOn(statsUtils, "calculateTokenStats").mockResolvedValue(mockResult);

      await service.calculateStats("child-workspace", messages, "gpt-4", null, "parent-workspace");

      expect(statsSpy).toHaveBeenCalledWith(messages, "gpt-4", null, {
        enableAgentReport: true,
        enableReviewPane: false,
      });

      statsSpy.mockRestore();
    });

    test("skips persisting stale token stats cache when calculations overlap", async () => {
      const messagesV1 = [
        createMuxMessage("msg1", "user", "Hello", { historySequence: 1 }),
        createMuxMessage("msg2", "assistant", "World", { historySequence: 2 }),
      ];

      const messagesV2 = [
        ...messagesV1,
        createMuxMessage("msg3", "assistant", "!!!", { historySequence: 3 }),
      ];

      const deferred = <T>() => {
        let resolve!: (value: T) => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<T>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        return { promise, resolve, reject };
      };

      const statsV1 = {
        consumers: [{ name: "User", tokens: 1, percentage: 100 }],
        totalTokens: 1,
        model: "gpt-4",
        tokenizerName: "cl100k",
        usageHistory: [],
      };
      const statsV2 = {
        consumers: [{ name: "User", tokens: 2, percentage: 100 }],
        totalTokens: 2,
        model: "gpt-4",
        tokenizerName: "cl100k",
        usageHistory: [],
      };

      const d1 = deferred<typeof statsV1>();
      const d2 = deferred<typeof statsV2>();

      const statsSpy = spyOn(statsUtils, "calculateTokenStats")
        .mockImplementationOnce(() => d1.promise)
        .mockImplementationOnce(() => d2.promise);
      const persistSpy = spyOn(sessionUsageService, "setTokenStatsCache").mockResolvedValue(
        undefined
      );

      const p1 = service.calculateStats("test-workspace", messagesV1, "gpt-4");
      const p2 = service.calculateStats("test-workspace", messagesV2, "gpt-4");

      // Resolve second (newer) request first
      d2.resolve(statsV2);
      expect(await p2).toBe(statsV2);

      // Resolve first (older) request last
      d1.resolve(statsV1);
      expect(await p1).toBe(statsV1);

      // Only the newer request should persist the cache.
      expect(persistSpy).toHaveBeenCalledTimes(1);
      expect(persistSpy).toHaveBeenCalledWith(
        "test-workspace",
        expect.objectContaining({
          history: { messageCount: messagesV2.length, maxHistorySequence: 3 },
        })
      );

      statsSpy.mockRestore();
      persistSpy.mockRestore();
    });

    test("throws on invalid messages", () => {
      // @ts-expect-error testing runtime validation
      expect(service.calculateStats("test-workspace", null, "gpt-4")).rejects.toThrow(
        "requires an array"
      );
    });

    test("throws on empty workspaceId", () => {
      expect(service.calculateStats("", [], "gpt-4")).rejects.toThrow("requires workspaceId");
    });
  });
});
