import { test } from "bun:test";
import { fileURLToPath } from "node:url";

// Native-web aliases must be installed before Bun parses RN's native host imports.
// Keep them in a child process so the transport/hook suite sees unmodified modules.
test("native form behavior", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--preload",
      "./src/screens/formTestDom.ts",
      "--preload",
      "./src/screens/formTestPlatform.ts",
      "./src/screens/forms.behavior.tsx",
    ],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
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
    if (code !== 0) throw new Error(`Native form tests failed (${code}):\n${stdout}\n${stderr}`);
  } finally {
    if (child.exitCode === null) child.kill();
  }
}, 30_000);
