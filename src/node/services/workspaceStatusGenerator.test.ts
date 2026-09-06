import * as aiSdk from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Err, Ok } from "@/common/types/result";
import type { AIService } from "./aiService";
import type { ModelRoutingSnapshot } from "./modelRoutingSnapshot";
import { buildWorkspaceStatusPrompt, generateWorkspaceStatus } from "./workspaceStatusGenerator";

describe("buildWorkspaceStatusPrompt", () => {
  test("contains the transcript inside delimited markers", () => {
    const prompt = buildWorkspaceStatusPrompt("User: please run tests\nAssistant: running");

    // The transcript block needs explicit delimiters so the model can tell
    // where the transcript ends and the requirements begin. If we ever drop
    // these delimiters, the model is more likely to follow trailing
    // instructions baked into the transcript itself (a real prompt-injection
    // risk for arbitrary chat history).
    expect(prompt).toContain("<transcript>");
    expect(prompt).toContain("</transcript>");
    expect(prompt).toContain("User: please run tests");
    expect(prompt).toContain("Assistant: running");
  });

  test("falls back to a sentinel when transcript is empty", () => {
    const prompt = buildWorkspaceStatusPrompt("");

    // Empty transcripts must still produce a syntactically-valid prompt; the
    // sentinel keeps the small model from inheriting system-prompt context
    // from a previous workspace.
    expect(prompt).toContain("(no recent transcript)");
  });

  test("switches the liveness hint based on the streaming flag", () => {
    // The streaming bit is the highest-signal input for the
    // in-progress-vs-completed distinction the small model historically got
    // wrong. The prompt must visibly switch between "actively streaming" and
    // "finished streaming" guidance so behavior actually differs on each
    // branch — not just receive the option silently.
    const live = buildWorkspaceStatusPrompt("Assistant: Deploying now", { streaming: true });
    const done = buildWorkspaceStatusPrompt("Assistant: Deploying now", { streaming: false });

    expect(live).toContain("actively streaming");
    expect(done).toContain("finished streaming");
    // The streaming branch must rule out past tense; the non-streaming
    // branch must explicitly warn that "finished streaming" ≠ activity
    // complete. Both behaviors are part of the tense-correctness fix and
    // would silently regress if the branches collapsed.
    expect(live).not.toContain("finished streaming");
    expect(done).not.toContain("actively streaming");
  });

  test("documents tool-call lifecycle markers so the model can read them", () => {
    // formatMessageForTranscript emits [tool <name> running|done] markers;
    // the prompt must teach the model what those mean. If this guidance is
    // dropped, the markers become noise and the tense rule falls back to
    // guessing from prose — the exact failure mode this fix addresses.
    const prompt = buildWorkspaceStatusPrompt("Assistant: working\n[tool bash running]");
    expect(prompt).toContain("[tool <name> running]");
    expect(prompt).toContain("[tool <name> done]");
  });
});

describe("generateWorkspaceStatus error paths", () => {
  afterEach(() => mock.restore());

  function createRoutingSnapshot(): ModelRoutingSnapshot {
    return {
      providersConfig: { openai: { apiKey: "test-key", codexOauthDefaultAuth: "oauth" } },
      routeConfig: { routePriority: ["direct"], routeOverrides: {} },
      metadata: null,
      codexOauthSelection: { accountId: "work", explicit: true },
    };
  }
  test("preserves workspace account context across candidate failures", async () => {
    const createModelWithPinnedMetadata = mock<AIService["createModelWithPinnedMetadata"]>(() =>
      Promise.resolve(Err({ type: "oauth_not_connected", provider: "openai" }))
    );
    const modelRoutingSnapshot = createRoutingSnapshot();
    const captureModelRoutingSnapshot = mock(() => modelRoutingSnapshot);
    const aiService = {
      createModelWithPinnedMetadata,
      captureModelRoutingSnapshot,
    } as unknown as AIService;
    const result = await generateWorkspaceStatus(
      "Run tests",
      ["openai:gpt-5.5", "openai:gpt-5.3-codex"],
      aiService,
      { workspaceId: "status-workspace" }
    );
    expect(result.success).toBe(false);
    expect(createModelWithPinnedMetadata).toHaveBeenCalledTimes(2);
    for (const call of createModelWithPinnedMetadata.mock.calls) {
      expect(call[1]).toEqual({
        workspaceId: "status-workspace",
        agentInitiated: true,
        modelRoutingSnapshot,
      });
    }
  });

  test.each(["account", "preference"] as const)(
    "pins status routing across a provider failure and %s change",
    async (change) => {
      const settings = createRoutingSnapshot();
      const captureModelRoutingSnapshot = mock<AIService["captureModelRoutingSnapshot"]>(() =>
        structuredClone(settings)
      );
      const createModelWithPinnedMetadata = mock<AIService["createModelWithPinnedMetadata"]>(
        (model) => Promise.resolve(Ok({ model: new MockLanguageModelV3(), metadataModel: model }))
      );
      const aiService = {
        captureModelRoutingSnapshot,
        createModelWithPinnedMetadata,
      } as unknown as AIService;
      const stream = spyOn(aiSdk, "streamText").mockReturnValue({
        toolResults: Promise.resolve([
          {
            dynamic: false,
            toolName: "propose_status",
            output: { emoji: "", message: "Run tests" },
          },
        ]),
      } as unknown as ReturnType<typeof aiSdk.streamText>);
      stream.mockImplementationOnce(() => {
        if (change === "account") settings.codexOauthSelection.accountId = "personal";
        else settings.providersConfig.openai!.codexOauthDefaultAuth = "apiKey";
        throw new Error("First status provider fails");
      });
      const generate = () =>
        generateWorkspaceStatus(
          "Run tests",
          ["openai:gpt-5.5", "openai:gpt-5.3-codex"],
          aiService,
          { workspaceId: "status-workspace" }
        );
      expect((await generate()).success).toBe(true);
      expect(captureModelRoutingSnapshot).toHaveBeenCalledTimes(1);
      expect(captureModelRoutingSnapshot).toHaveBeenCalledWith("status-workspace");
      expect(createModelWithPinnedMetadata).toHaveBeenCalledTimes(2);
      const original = createModelWithPinnedMetadata.mock.calls[0]?.[1]?.modelRoutingSnapshot;
      expect(original?.codexOauthSelection.accountId).toBe("work");
      expect(original?.providersConfig.openai?.codexOauthDefaultAuth).toBe("oauth");
      expect(createModelWithPinnedMetadata.mock.calls[1]?.[1]?.modelRoutingSnapshot).toBe(original);

      expect((await generate()).success).toBe(true);
      expect(captureModelRoutingSnapshot).toHaveBeenCalledTimes(2);
      expect(createModelWithPinnedMetadata).toHaveBeenCalledTimes(3);
      const next = createModelWithPinnedMetadata.mock.calls[2]?.[1]?.modelRoutingSnapshot;
      expect(next).not.toBe(original);
      expect(next?.codexOauthSelection.accountId).toBe(change === "account" ? "personal" : "work");
      expect(next?.providersConfig.openai?.codexOauthDefaultAuth).toBe(
        change === "preference" ? "apiKey" : "oauth"
      );
    }
  );

  test("returns a configuration error when no candidates are provided", async () => {
    const fakeAiService = {
      // Asserting this never gets called is the real point of this test —
      // the empty-candidates short-circuit prevents wasteful provider calls
      // for misconfigured workspaces.
      createModel: () => {
        throw new Error("createModel must not be called when no candidates exist");
      },
    } as unknown as Parameters<typeof generateWorkspaceStatus>[2];

    const result = await generateWorkspaceStatus("hello", [], fakeAiService);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.error.type).toBe("unknown");
      expect(result.error.error.raw).toContain("No model candidates");
      // No candidates means we never even attempted createModel, so the
      // failure has nothing to do with the transcript — caller must keep
      // retrying so a future config change recovers without a new message.
      expect(result.error.reachedProvider).toBe(false);
    }
  });
});
