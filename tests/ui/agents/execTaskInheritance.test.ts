import "../dom";

import { waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { formatModelDisplayName } from "@/common/utils/ai/modelDisplay";
import { Err, Ok } from "@/common/types/result";
import { ProviderModelFactory } from "@/node/services/providerModelFactory";
import { shouldRunIntegrationTests } from "../../testUtils";
import { setupProviders } from "../../ipc/setup";
import { createAppHarness } from "../harness";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;
const MODEL_A = KNOWN_MODELS.OPUS.id;
const MODEL_B = KNOWN_MODELS.SONNET.id;
const FALLBACK_MODEL = KNOWN_MODELS.HAIKU.id;

async function selectAgent(container: HTMLElement, agentId: string): Promise<void> {
  const user = userEvent.setup({ document: container.ownerDocument });
  await user.click(within(container).getByRole("button", { name: "Select agent" }));
  const option = await waitFor(() => {
    const row = container.querySelector<HTMLElement>(`[data-agent-id="${agentId}"]`);
    if (!row) throw new Error(`Agent ${agentId} not found`);
    return row;
  });
  await user.click(option);
}

async function selectModel(container: HTMLElement, model: string): Promise<void> {
  const user = userEvent.setup({ document: container.ownerDocument });
  const group = container.querySelector<HTMLElement>('[data-component="ModelSelectorGroup"]');
  if (!group) throw new Error("Model picker not found");
  await user.click(within(group).getByRole("combobox"));
  const input = await within(container).findByPlaceholderText("Search [provider:model-name]");
  await user.clear(input);
  await user.type(input, model);
  const displayName = formatModelDisplayName(model.split(":")[1]);
  await user.click(await within(container).findByText(displayName));
  await waitFor(() => expect(group.textContent).toContain(displayName));
}

async function sendMessage(container: HTMLElement, text: string): Promise<void> {
  const user = userEvent.setup({ document: container.ownerDocument });
  const textarea = await within(container).findByRole("textbox", { name: "Message Claude" });
  await user.type(textarea, text);
  await user.click(within(container).getByRole("button", { name: "Send message" }));
}

function finish(reason: "stop" | "tool-calls"): LanguageModelV3StreamPart {
  return {
    type: "finish",
    finishReason: { unified: reason, raw: reason },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
  };
}

describeIntegration("Calling-chat Exec inheritance", () => {
  test("routes new children through the picked Exec model without changing existing children", async () => {
    const requests = new Map<string, string>();
    const delegated = new Set<string>();
    // MockAiRouter emits canned tool results without executing them. Mock only the
    // provider instead so picker -> send -> task -> child runs the real backend.
    const app = await createAppHarness({
      branchPrefix: "exec-inheritance",
      aiMode: "none",
      beforeRenderEnvironment: async (env) => {
        await setupProviders(env, { anthropic: { apiKey: "provider-free-test-key" } });
        await env.orpc.config.updateAgentAiDefaults({
          agentAiDefaults: {
            exec: { modelString: FALLBACK_MODEL },
          },
        });
        // Background status/summary generation is unrelated to task inheritance.
        jest
          .spyOn(ProviderModelFactory.prototype, "createModel")
          .mockResolvedValue(
            Err({ type: "unknown", raw: "Side-channel generation disabled in provider-free test" })
          );
        jest
          .spyOn(ProviderModelFactory.prototype, "resolveAndCreateModel")
          .mockImplementation((modelString, _thinkingLevel, _providerOptions, options) =>
            Promise.resolve(
              Ok({
                effectiveModelString: modelString,
                canonicalModelString: modelString,
                canonicalProviderName: "anthropic",
                canonicalModelId: modelString.split(":")[1],
                wireProviderName: "anthropic",
                routedThroughGateway: false,
                model: new MockLanguageModelV3({
                  provider: "anthropic",
                  modelId: modelString.split(":")[1],
                  doStream: (request) => {
                    const workspaceId = options?.workspaceId;
                    if (!workspaceId)
                      throw new Error("Expected a workspace-scoped provider request");
                    requests.set(workspaceId, modelString);
                    const lastUser = request.prompt.findLast((message) => message.role === "user");
                    const text = lastUser?.content
                      .filter((part) => part.type === "text")
                      .map((part) => part.text)
                      .join("");
                    const chunks: LanguageModelV3StreamPart[] = [];
                    if (text?.startsWith("Delegate ") && !delegated.has(text)) {
                      delegated.add(text);
                      chunks.push(
                        {
                          type: "tool-call",
                          toolCallId: `delegate-${delegated.size}`,
                          toolName: "task",
                          input: JSON.stringify({
                            agentId: "exec",
                            title: `Reviewer ${delegated.size}`,
                            prompt: "Return a brief report without changing files.",
                            run_in_background: false,
                          }),
                        },
                        finish("tool-calls")
                      );
                    } else {
                      chunks.push(
                        { type: "text-start", id: "answer" },
                        { type: "text-delta", id: "answer", delta: "Finished reviewing." },
                        { type: "text-end", id: "answer" },
                        finish("stop")
                      );
                    }
                    return Promise.resolve({ stream: simulateReadableStream({ chunks }) });
                  },
                }),
              })
            )
          );
      },
    });

    try {
      await selectAgent(app.view.container, "exec");
      await selectModel(app.view.container, MODEL_A);
      // Do not pre-seed workspace AI settings or wait for their persistence: the
      // very first send must save the selected Exec model before task execution.
      await sendMessage(app.view.container, "Delegate the first review.");
      await app.chat.expectTranscriptContains("Finished reviewing.");
      await app.chat.expectStreamComplete();

      const firstChildren = (await app.env.orpc.workspace.list()).filter(
        (workspace) => workspace.parentWorkspaceId === app.workspaceId
      );
      expect(firstChildren).toHaveLength(1);
      const firstId = firstChildren[0].id;

      await selectModel(app.view.container, MODEL_B);
      await sendMessage(app.view.container, "Delegate the second review.");
      await waitFor(
        () => expect([...requests.keys()].filter((id) => id !== app.workspaceId)).toHaveLength(2),
        { timeout: 30_000 }
      );
      await app.chat.expectStreamComplete();

      const children = (await app.env.orpc.workspace.list()).filter(
        (workspace) => workspace.parentWorkspaceId === app.workspaceId
      );
      expect(children).toHaveLength(2);
      const second = children.find((workspace) => workspace.id !== firstId);
      if (!second) throw new Error("Second child was not created");

      // Inspect the actual child provider requests, not just picker display state.
      expect(requests.get(app.workspaceId)).toBe(MODEL_B);
      expect([requests.get(firstId), requests.get(second.id)]).toEqual([MODEL_A, MODEL_B]);
      const first = await app.env.orpc.workspace.getInfo({ workspaceId: firstId });
      const secondInfo = await app.env.orpc.workspace.getInfo({ workspaceId: second.id });
      expect(first?.aiSettingsByAgent?.exec?.model).toBe(MODEL_A);
      expect(secondInfo?.aiSettingsByAgent?.exec?.model).toBe(MODEL_B);
    } finally {
      await app.dispose();
      jest.restoreAllMocks();
    }
  }, 120_000);
});
