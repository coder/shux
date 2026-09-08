import { test } from "bun:test";
import { fileURLToPath } from "node:url";

test("streaming display performance and control boundaries", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--preload",
      "./src/screens/formTestDom.ts",
      "--preload",
      "./src/screens/formTestPlatform.ts",
      "--preload",
      "./src/screens/streamingTestProfiler.tsx",
      "./src/screens/streaming.behavior.tsx",
    ],
    { cwd: fileURLToPath(new URL("../../", import.meta.url)), stdout: "pipe", stderr: "pipe" }
  );
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0)
      throw new Error(`Streaming display tests failed (${code}):\n${stdout}\n${stderr}`);
  } finally {
    if (child.exitCode === null) child.kill();
  }
}, 30_000);
