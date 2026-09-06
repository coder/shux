import type { TestEnvironment } from "../setup";
import { cleanupTestEnvironment, createTestEnvironment } from "../setup";

describe("config.saveConfig advisor settings", () => {
  let env: TestEnvironment;

  beforeAll(async () => {
    env = await createTestEnvironment();
  });

  afterAll(async () => {
    if (env) {
      await cleanupTestEnvironment(env);
    }
  });

  it("round-trips advisor globals and trims the model string", async () => {
    const initialConfig = await env.orpc.config.getConfig();

    expect(initialConfig.advisorModelString).toBeNull();
    expect(initialConfig.advisorMaxUsesPerTurn).toBeUndefined();

    await env.orpc.config.saveConfig({
      taskSettings: initialConfig.taskSettings,
      advisorModelString: " openai:gpt-4o ",
      advisorMaxUsesPerTurn: 4,
    });

    const loaded = env.config.loadConfigOrDefault();
    expect(loaded.advisorModelString).toBe("openai:gpt-4o");
    expect(loaded.advisorMaxUsesPerTurn).toBe(4);

    const cfg = await env.orpc.config.getConfig();
    expect(cfg.advisorModelString).toBe("openai:gpt-4o");
    expect(cfg.advisorMaxUsesPerTurn).toBe(4);
  });

  it("round-trips advisor reasoning mode and clears it without changing effort", async () => {
    expect((await env.orpc.config.getConfig()).advisorReasoningMode).toBeNull();
    await env.orpc.config.saveConfig({
      advisorThinkingLevel: "high",
      advisorReasoningMode: "pro",
    });
    await env.orpc.config.saveConfig({ advisorMaxUsesPerTurn: 2 });
    expect(await env.orpc.config.getConfig()).toMatchObject({
      advisorThinkingLevel: "high",
      advisorReasoningMode: "pro",
    });
    expect(env.config.loadConfigOrDefault().advisorReasoningMode).toBe("pro");

    await env.orpc.config.saveConfig({ advisorReasoningMode: "standard" });
    expect((await env.orpc.config.getConfig()).advisorReasoningMode).toBe("standard");
    await env.orpc.config.saveConfig({ advisorReasoningMode: null });
    expect(await env.orpc.config.getConfig()).toMatchObject({
      advisorThinkingLevel: "high",
      advisorReasoningMode: null,
    });
    expect(env.config.loadConfigOrDefault().advisorReasoningMode).toBeUndefined();
  });

  it("persists unlimited advisor mode as null", async () => {
    const initialConfig = await env.orpc.config.getConfig();

    await env.orpc.config.saveConfig({
      taskSettings: initialConfig.taskSettings,
      advisorModelString: "openai:gpt-4o",
      advisorMaxUsesPerTurn: 4,
    });

    await env.orpc.config.saveConfig({
      taskSettings: initialConfig.taskSettings,
      advisorModelString: null,
      advisorMaxUsesPerTurn: null,
    });

    const loaded = env.config.loadConfigOrDefault();
    expect(loaded.advisorModelString).toBeUndefined();
    expect(loaded.advisorMaxUsesPerTurn).toBeNull();

    const cfg = await env.orpc.config.getConfig();
    expect(cfg.advisorModelString).toBeNull();
    expect(cfg.advisorMaxUsesPerTurn).toBeNull();
  });
});
