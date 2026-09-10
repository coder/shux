import type { ORPCClient } from "../../src/node/acp/serverConnection";
import { resolveAgentAiSettings } from "../../src/node/acp/resolveAgentAiSettings";

function createClient(overrides: {
  agentAiDefaults: Record<
    string,
    { modelString?: string; thinkingLevel?: "off" | "low" | "medium" | "high" | "xhigh" | "max" }
  >;
  agents: Array<{
    id: string;
    base?: string;
    aiDefaults?: {
      model?: string;
      thinkingLevel?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
    };
  }>;
}): ORPCClient {
  return {
    config: {
      getConfig: async () => ({
        agentAiDefaults: overrides.agentAiDefaults,
      }),
    },
    agents: {
      list: async () => overrides.agents,
    },
  } as unknown as ORPCClient;
}

describe("resolveAgentAiSettings", () => {
  it("inherits missing thinking level from base config defaults when direct override is partial", async () => {
    const client = createClient({
      agentAiDefaults: {
        exec: {
          modelString: "anthropic:claude-opus-4-6",
          thinkingLevel: "high",
        },
        review: {
          modelString: "openai:gpt-5",
        },
      },
      agents: [
        {
          id: "review",
          base: "exec",
          // Configured model beats the definition model; no definition
          // thinkingLevel so the base CONFIG chain supplies it.
          aiDefaults: {
            model: "google:gemini-2.5-pro",
          },
        },
        {
          id: "exec",
        },
      ],
    });

    const resolved = await resolveAgentAiSettings(client, "review", "ws-1");

    expect(resolved).toEqual({
      model: "openai:gpt-5",
      thinkingLevel: "high",
    });
  });

  it("inherits missing model from base config defaults when direct override only sets thinking", async () => {
    const client = createClient({
      agentAiDefaults: {
        exec: {
          modelString: "anthropic:claude-opus-4-6",
          thinkingLevel: "high",
        },
        review: {
          thinkingLevel: "low",
        },
      },
      agents: [
        {
          id: "review",
          base: "exec",
          // Configured thinking beats the definition thinking; no definition
          // model so the base CONFIG chain supplies it.
          aiDefaults: {
            thinkingLevel: "off",
          },
        },
        {
          id: "exec",
        },
      ],
    });

    const resolved = await resolveAgentAiSettings(client, "review", "ws-1");

    expect(resolved).toEqual({
      model: "anthropic:claude-opus-4-6",
      thinkingLevel: "low",
    });
  });

  it("traverses multiple base levels to fill missing inherited fields", async () => {
    const client = createClient({
      agentAiDefaults: {
        review: {
          modelString: "openai:gpt-5",
        },
        exec: {
          thinkingLevel: "high",
        },
      },
      agents: [
        {
          id: "audit",
          base: "review",
        },
        {
          id: "review",
          base: "exec",
        },
        {
          id: "exec",
        },
      ],
    });

    const resolved = await resolveAgentAiSettings(client, "audit", "ws-1");

    expect(resolved).toEqual({
      model: "openai:gpt-5",
      thinkingLevel: "high",
    });
  });
});
