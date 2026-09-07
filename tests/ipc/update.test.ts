import { shouldRunIntegrationTests, createTestEnvironment, cleanupTestEnvironment } from "./setup";
import { resolveOrpcClient } from "./helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Server update IPC", () => {
  test("reports unsupported instead of offering an unsafe restart in the harness", async () => {
    const env = await createTestEnvironment();
    const controller = new AbortController();
    try {
      const client = resolveOrpcClient(env);
      const statuses = await client.update.onStatus(undefined, { signal: controller.signal });
      const first = await statuses.next();
      expect(first.value).toMatchObject({ type: "unsupported", reason: expect.any(String) });
      await client.update.check({ source: "manual" });
      await client.update.download();
      await client.update.install();
      // An unsupported install must not have started the restart path: the server still answers.
      expect(await client.update.getChannel()).toBe("stable");
    } finally {
      controller.abort();
      await cleanupTestEnvironment(env);
    }
  }, 30000);
});
