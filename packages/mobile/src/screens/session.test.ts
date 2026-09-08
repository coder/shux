import { test } from "bun:test";
import { fileURLToPath } from "node:url";

// Isolate native host aliases from the ordinary hook/transport suites.
test("mobile session and recovery behavior", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--preload",
      "./src/screens/formTestDom.ts",
      "--preload",
      "./src/screens/formTestPlatform.ts",
      "--preload",
      "./src/screens/sessionTestPlatform.tsx",
      "--preload",
      "./src/screens/navigatorTestProfiler.tsx",
      "./src/screens/session.behavior.tsx",
    ],
    { cwd: fileURLToPath(new URL("../../", import.meta.url)), stdout: "pipe", stderr: "pipe" }
  );
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`Session tests failed (${code}):\n${stdout}\n${stderr}`);
  } finally {
    if (child.exitCode === null) child.kill();
  }
}, 30_000);
