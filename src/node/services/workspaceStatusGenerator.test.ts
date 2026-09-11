import { describe, expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import { Ok } from "@/common/types/result";
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

  test("aborts before the provider request when the transcript went stale during model creation", async () => {
    // The caller re-verifies its transcript before calling, but model
    // construction is an await of its own: the re-verification passed in as
    // beforeDispatch runs after it, and a stale verdict must stop the whole
    // generation — no request, no further candidate with the same text.
    let created = 0;
    const fakeAiService = {
      createModelWithPinnedMetadata: () => {
        created += 1;
        return Promise.resolve(
          Ok({
            model: {
              doStream: () => {
                throw new Error("the stale transcript must not be sent");
              },
            } as unknown as LanguageModel,
            metadataModel: "test:model",
          })
        );
      },
    } as unknown as Parameters<typeof generateWorkspaceStatus>[2];

    const result = await generateWorkspaceStatus(
      "hello",
      ["test:model", "test:other"],
      fakeAiService,
      {
        beforeDispatch: () => Promise.resolve(false),
      }
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.staleTranscript).toBe(true);
      expect(result.error.reachedProvider).toBe(false);
    }
    expect(created).toBe(1);
  });
});
