import { test } from "bun:test";
import { fileURLToPath } from "node:url";

// Exercise the real transport with native globals without contaminating the other suites.
test("transport connects and cancels with React Native's abort signals", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--preload",
      "./src/nativeTestPlatform.ts",
      "--preload",
      "./src/polyfills.native.ts",
      "./src/api.test.ts",
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0)
      throw new Error(`Native transport tests failed (${code}):\n${stdout}\n${stderr}`);
  } finally {
    if (child.exitCode === null) child.kill();
  }
}, 30_000);
