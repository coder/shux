import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getXumHome } from "@/common/constants/paths";
import { createAskpassSession, parseHostKeyPrompt } from "./sshAskpass";

describe("sshAskpass", () => {
  describe("createAskpassSession", () => {
    async function simulateAskpassInvocation(
      askpassDir: string,
      promptText: string,
      requestId: string,
      cleanupResponseFiles = true
    ): Promise<string> {
      const promptFile = path.join(askpassDir, `prompt.${requestId}.txt`);
      const responseFile = path.join(askpassDir, `response.${requestId}.txt`);

      // Simulate askpass writing prompt content for this invocation.
      await fs.promises.writeFile(promptFile, promptText, "utf-8");

      // Poll for the response file written by createAskpassSession().
      for (let i = 0; i < 100; i += 1) {
        try {
          const response = await fs.promises.readFile(responseFile, "utf-8");

          if (cleanupResponseFiles) {
            // Simulate askpass script cleanup.
            await fs.promises.unlink(promptFile).catch(() => undefined);
            await fs.promises.unlink(responseFile).catch(() => undefined);
          }

          return response.trim();
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      throw new Error(`Timeout waiting for response for request '${requestId}'`);
    }

    async function listAskpassTempDirs(): Promise<string[]> {
      return (await fs.promises.readdir(os.tmpdir()))
        .filter((entry) => entry.startsWith("mux-askpass-"))
        .sort();
    }

    test("does not leak temp dir when script bootstrap fails", async () => {
      const tmpBefore = await listAskpassTempDirs();
      const missingScriptError = new Error("ENOENT: script missing");
      const permissionDeniedError = new Error("EACCES: permission denied");
      const accessSpy = spyOn(fs.promises, "access").mockImplementationOnce(() => {
        throw missingScriptError;
      });
      const writeFileSpy = spyOn(fs.promises, "writeFile").mockImplementationOnce(() => {
        throw permissionDeniedError;
      });

      let leakedDirs: string[] = [];

      try {
        let error: unknown;
        try {
          await createAskpassSession(() => Promise.resolve("ok"));
        } catch (thrown) {
          error = thrown;
        }

        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error)) {
          throw new Error("Expected createAskpassSession to throw an Error");
        }
        expect(error.message).toContain("EACCES");

        const tmpAfter = await listAskpassTempDirs();
        const beforeSet = new Set(tmpBefore);
        leakedDirs = tmpAfter.filter((entry) => !beforeSet.has(entry));
        expect(leakedDirs).toHaveLength(0);
      } finally {
        accessSpy.mockRestore();
        writeFileSpy.mockRestore();
        for (const dir of leakedDirs) {
          await fs.promises
            .rm(path.join(os.tmpdir(), dir), { recursive: true, force: true })
            .catch(() => undefined);
        }
      }
    });

    test("handles a single prompt and returns response", async () => {
      const prompts: string[] = [];
      const session = await createAskpassSession((prompt) => {
        prompts.push(prompt);
        return Promise.resolve("yes");
      });

      try {
        const result = await simulateAskpassInvocation(
          session.env.MUX_ASKPASS_DIR,
          "Are you sure you want to continue connecting (yes/no)?",
          "req1"
        );

        expect(result).toBe("yes");
        expect(prompts).toEqual(["Are you sure you want to continue connecting (yes/no)?"]);
      } finally {
        session.cleanup();
      }
    });

    test("handles two sequential prompts without ignoring the second", async () => {
      const prompts: string[] = [];
      const session = await createAskpassSession((prompt) => {
        prompts.push(prompt);
        return Promise.resolve(prompt.includes("continue connecting") ? "yes" : "denied");
      });

      try {
        const askpassDir = session.env.MUX_ASKPASS_DIR;

        const first = await simulateAskpassInvocation(
          askpassDir,
          "Are you sure you want to continue connecting (yes/no)?",
          "1001.1234",
          false
        );
        expect(first).toBe("yes");

        const second = await simulateAskpassInvocation(
          askpassDir,
          "Enter passphrase for key '/home/user/.ssh/id_ed25519':",
          "1001.5678"
        );
        expect(second).toBe("denied");

        expect(prompts).toHaveLength(2);
      } finally {
        session.cleanup();
      }
    });

    test("cleanup is idempotent", async () => {
      const session = await createAskpassSession(() => Promise.resolve("ok"));

      session.cleanup();
      expect(() => session.cleanup()).not.toThrow();
    });

    test("ignores duplicate request IDs", async () => {
      let callCount = 0;
      const session = await createAskpassSession(() => {
        callCount += 1;
        return Promise.resolve("yes");
      });

      try {
        const askpassDir = session.env.MUX_ASKPASS_DIR;
        const requestId = "dup-test";
        const promptFile = path.join(askpassDir, `prompt.${requestId}.txt`);
        const responseFile = path.join(askpassDir, `response.${requestId}.txt`);

        // Simulate duplicate writes for the same askpass request id.
        await fs.promises.writeFile(promptFile, "test prompt", "utf-8");
        await fs.promises.writeFile(promptFile, "test prompt", "utf-8");

        for (let i = 0; i < 100; i += 1) {
          try {
            await fs.promises.access(responseFile);
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(callCount).toBe(1);
      } finally {
        session.cleanup();
      }
    });

    test("session env includes required SSH variables", async () => {
      const session = await createAskpassSession(() => Promise.resolve("ok"));

      try {
        expect(session.env.SSH_ASKPASS).toBeDefined();
        expect(session.env.SSH_ASKPASS_REQUIRE).toBe("force");
        expect(session.env.DISPLAY).toBeDefined();
        expect(session.env.MUX_ASKPASS_DIR).toBeDefined();

        const stat = await fs.promises.stat(session.env.MUX_ASKPASS_DIR);
        expect(stat.isDirectory()).toBe(true);
      } finally {
        session.cleanup();
      }
    });

    test("writes mux-askpass under getXumHome() instead of creating ~/.mux", async () => {
      const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "xum-askpass-home-"));
      const previousRoot = process.env.XUM_ROOT;
      process.env.XUM_ROOT = isolatedHome;
      // Force rewrite if an earlier test cached a helper from a different home.
      const accessSpy = spyOn(fs.promises, "access").mockRejectedValueOnce(new Error("missing"));

      try {
        const session = await createAskpassSession(() => Promise.resolve("ok"));
        try {
          const expectedPath = path.join(getXumHome(), "bin", "mux-askpass");
          expect(session.env.SSH_ASKPASS).toBe(expectedPath);
          expect((await fs.promises.stat(expectedPath)).isFile()).toBe(true);
          expect(expectedPath.startsWith(path.join(os.homedir(), ".mux"))).toBe(false);
        } finally {
          session.cleanup();
        }
      } finally {
        accessSpy.mockRestore();
        if (previousRoot === undefined) {
          delete process.env.XUM_ROOT;
        } else {
          process.env.XUM_ROOT = previousRoot;
        }
        fs.rmSync(isolatedHome, { recursive: true, force: true });
      }
    });
  });

  describe("parseHostKeyPrompt", () => {
    test("parses standard host-key prompt", () => {
      const text =
        "The authenticity of host 'example.com (1.2.3.4)' can't be established.\n" +
        "ED25519 key fingerprint is SHA256:abcdef123456\n" +
        "Are you sure you want to continue connecting (yes/no/[fingerprint])?";

      const result = parseHostKeyPrompt(text);

      expect(result.host).toBe("example.com (1.2.3.4)");
      expect(result.keyType).toBe("ED25519");
      expect(result.fingerprint).toBe("SHA256:abcdef123456");
    });

    test("returns unknown for non-host-key text", () => {
      const result = parseHostKeyPrompt("Enter passphrase for key '/home/user/.ssh/id_ed25519':");

      expect(result.host).toBe("unknown");
      expect(result.keyType).toBe("unknown");
      expect(result.fingerprint).toBe("unknown");
    });
  });
});
