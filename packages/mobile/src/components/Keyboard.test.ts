import { test } from "bun:test";
import { fileURLToPath } from "node:url";

// Native host mocks must not leak into the mobile transport or form suites.
test("native keyboard geometry", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--preload",
      "./src/components/keyboardTestRuntime.tsx",
      "--preload",
      "./src/components/keyboardTestController.ts",
      "./src/components/keyboard.behavior.tsx",
    ],
    { cwd: fileURLToPath(new URL("../../", import.meta.url)), stdout: "pipe", stderr: "pipe" }
  );
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`Keyboard tests failed (${code}):\n${stdout}\n${stderr}`);
  } finally {
    if (child.exitCode === null) child.kill();
  }
}, 30_000);
