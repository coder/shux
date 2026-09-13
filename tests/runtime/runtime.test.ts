/**
 * Runtime interface contract tests
 *
 * Tests shared Runtime interface behavior (exec, readFile, writeFile, stat, etc.)
 * using a matrix of local (WorktreeRuntime) and SSH runtimes.
 *
 * SSH tests use a real Docker container (no mocking) for confidence.
 *
 * Note: Workspace management tests (renameWorkspace, deleteWorkspace) are colocated
 * with their runtime implementations:
 * - WorktreeManager: src/node/worktree/WorktreeManager.test.ts
 * - SSHRuntime: src/node/runtime/SSHRuntime.test.ts
 */

// Jest globals are available automatically - no need to import
import * as os from "os";
// shouldRunIntegrationTests checks TEST_INTEGRATION env var
function shouldRunIntegrationTests(): boolean {
  return process.env.TEST_INTEGRATION === "1" || process.env.TEST_INTEGRATION === "true";
}
import {
  isDockerAvailable,
  startSSHServer,
  stopSSHServer,
  type SSHServerConfig,
} from "./test-fixtures/ssh-fixture";
import {
  createTestRuntime,
  TestWorkspace,
  noopInitLogger,
  type RuntimeType,
} from "./test-fixtures/test-helpers";
import { execBuffered, readFileString, writeFileString } from "@/node/utils/runtime/helpers";
import type { Runtime } from "@/node/runtime/Runtime";
import { RuntimeError } from "@/node/runtime/Runtime";
import { computeBaseRepoPath, SSHRuntime } from "@/node/runtime/SSHRuntime";
import {
  buildLegacyRemoteProjectLayout,
  buildRemoteProjectLayout,
  getRemoteWorkspacePath,
} from "@/node/runtime/remoteProjectLayout";
import { createSSHTransport } from "@/node/runtime/transports";
import { runFullInit } from "@/node/runtime/runtimeFactory";
import { sshConnectionPool } from "@/node/runtime/sshConnectionPool";
import { ssh2ConnectionPool } from "@/node/runtime/SSH2ConnectionPool";

const SSH_TEST_CWD = "/home/testuser";
const execSSH = (runtime: Runtime, command: string, timeout = 30) =>
  execBuffered(runtime, command, { cwd: SSH_TEST_CWD, timeout });

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// SSH server config (shared across all tests)
let sshConfig: SSHServerConfig | undefined;

describeIntegration("Runtime integration tests", () => {
  beforeAll(async () => {
    // Check if Docker is available (required for SSH tests)
    if (!(await isDockerAvailable())) {
      throw new Error(
        "Docker is required for runtime integration tests. Please install Docker or skip tests by unsetting TEST_INTEGRATION."
      );
    }

    // Start SSH server (shared across all tests for speed)
    console.log("Starting SSH server container...");
    sshConfig = await startSSHServer();
    console.log(`SSH server ready on port ${sshConfig.port}`);
  }, 120000); // 120s timeout for Docker build/start operations

  afterAll(async () => {
    if (sshConfig) {
      console.log("Stopping SSH server container...");
      await stopSSHServer(sshConfig);
    }
  }, 30000);

  // Reset SSH connection pool state before each test to prevent backoff from one
  // test affecting subsequent tests.
  beforeEach(() => {
    sshConnectionPool.clearAllHealth();
    ssh2ConnectionPool.clearAllHealth();
  });

  // Test matrix: Run all tests for local, SSH, and Docker runtimes
  describe.each<{ type: RuntimeType }>([{ type: "local" }, { type: "ssh" }, { type: "docker" }])(
    "Runtime: $type",
    ({ type }) => {
      // Helper to create runtime for this test type
      // Use a base working directory - TestWorkspace will create subdirectories as needed
      // For local runtime, use os.tmpdir() which matches where TestWorkspace creates directories
      const getBaseWorkdir = () => {
        if (type === "ssh") {
          return sshConfig!.workdir;
        }
        if (type === "docker") {
          return "/src";
        }
        return os.tmpdir();
      };

      // DockerRuntime is slower than local/ssh, and the integration job has a hard
      // time budget. Keep the Docker coverage focused on the core Runtime contract.
      //
      // NOTE: Avoid assigning `describe.skip` or `test.skip` to variables. Bun's Jest
      // compatibility can lose the skip semantics when these functions are detached.
      function describeIf(shouldRun: boolean) {
        return (...args: Parameters<typeof describe>) => {
          if (shouldRun) {
            describe(...args);
          } else {
            describe.skip(...args);
          }
        };
      }

      // Running these runtime contract tests with test.concurrent can easily overwhelm
      // the docker/ssh fixtures in CI and cause the overall integration job to hit its
      // 10-minute timeout. Keep runtime tests deterministic by running them sequentially
      // for remote runtimes.
      const testForRuntime = type === "local" ? test.concurrent : test;
      function testIf(shouldRun: boolean) {
        return (...args: Parameters<typeof test>) => {
          if (shouldRun) {
            testForRuntime(...args);
          } else {
            test.skip(...args);
          }
        };
      }

      const isRemote = type !== "local";

      const describeLocalOnly = describeIf(type === "local");
      const describeNonDocker = describeIf(type !== "docker");
      const testLocalOnly = testIf(!isRemote);
      const testDockerOnly = testIf(type === "docker");
      const createRuntime = (): Runtime =>
        createTestRuntime(
          type,
          getBaseWorkdir(),
          sshConfig,
          type === "docker"
            ? { image: "mux-ssh-test", containerName: sshConfig!.containerId }
            : undefined
        );

      const execWorkspace = (
        runtime: Runtime,
        workspace: TestWorkspace,
        command: string,
        options: Partial<Parameters<typeof execBuffered>[2]> = {}
      ) => execBuffered(runtime, command, { cwd: workspace.path, timeout: 30, ...options });

      const withRuntimeWorkspace = async <T>(
        run: (runtime: Runtime, workspace: TestWorkspace) => Promise<T>
      ): Promise<T> => {
        const runtime = createRuntime();
        await using workspace = await TestWorkspace.create(runtime, type);
        return await run(runtime, workspace);
      };

      describe("exec() - Command execution", () => {
        testForRuntime("captures stdout and stderr separately", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execWorkspace(
            runtime,
            workspace,
            'echo "output" && echo "error" >&2'
          );

          expect(result.stdout.trim()).toBe("output");
          expect(result.stderr.trim()).toBe("error");
          expect(result.exitCode).toBe(0);
          expect(result.duration).toBeGreaterThan(0);
        });

        testForRuntime("returns correct exit code for failed commands", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execWorkspace(runtime, workspace, "exit 42");

          expect(result.exitCode).toBe(42);
        });

        testLocalOnly("handles stdin input", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execWorkspace(runtime, workspace, "cat", {
            cwd: workspace.path,
            timeout: 30,
            stdin: "hello from stdin",
          });

          expect(result.stdout).toBe("hello from stdin");
          expect(result.exitCode).toBe(0);
        });

        testForRuntime("passes environment variables", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execBuffered(runtime, 'echo "$TEST_VAR"', {
            cwd: workspace.path,
            timeout: 30,
            env: { TEST_VAR: "test-value" },
          });

          expect(result.stdout.trim()).toBe("test-value");
        });

        testForRuntime("sets NON_INTERACTIVE_ENV_VARS to prevent prompts", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Verify GIT_TERMINAL_PROMPT is set to 0 (prevents credential prompts)
          const result = await execBuffered(
            runtime,
            'echo "GIT_TERMINAL_PROMPT=$GIT_TERMINAL_PROMPT GIT_EDITOR=$GIT_EDITOR"',
            { cwd: workspace.path, timeout: 30 }
          );

          expect(result.stdout).toContain("GIT_TERMINAL_PROMPT=0");
          expect(result.stdout).toContain("GIT_EDITOR=true");
        });

        testForRuntime("handles empty output", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execWorkspace(runtime, workspace, "true", {
            cwd: workspace.path,
            timeout: 30,
          });

          expect(result.stdout).toBe("");
          expect(result.stderr).toBe("");
          expect(result.exitCode).toBe(0);
        });

        testLocalOnly("handles commands with quotes and special characters", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execWorkspace(runtime, workspace, 'echo "hello \\"world\\""');

          expect(result.stdout.trim()).toBe('hello "world"');
        });

        testForRuntime("respects working directory", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execWorkspace(runtime, workspace, "pwd", {
            cwd: workspace.path,
            timeout: 30,
          });

          expect(result.stdout.trim()).toContain(workspace.path);
        });
        testLocalOnly(
          "handles timeout correctly",
          async () => {
            const runtime = createRuntime();
            await using workspace = await TestWorkspace.create(runtime, type);

            // Command that sleeps longer than timeout
            const startTime = performance.now();
            const result = await execBuffered(runtime, "sleep 10", {
              cwd: workspace.path,
              timeout: 1, // 1 second timeout
            });
            const duration = performance.now() - startTime;

            // Exit code should be EXIT_CODE_TIMEOUT (-998)
            expect(result.exitCode).toBe(-998);
            // Should complete in around 1 second, not 10 seconds
            // Allow some margin for overhead (especially on SSH)
            expect(duration).toBeLessThan(3000); // 3 seconds max
            expect(duration).toBeGreaterThan(500); // At least 0.5 seconds
          },
          15000
        ); // 15 second timeout for test (includes workspace creation overhead)
      });

      describe("ensureReady() - Runtime readiness", () => {
        testForRuntime("returns ready for running runtime", async () => {
          const runtime = createRuntime();
          const result = await runtime.ensureReady();
          expect(result).toEqual({ ready: true });
        });

        testDockerOnly(
          "starts stopped container and returns ready",
          async () => {
            // Create a dedicated container for this test (not the shared SSH container)
            // so stopping it doesn't affect other tests
            const { execSync } = await import("child_process");
            const { DockerRuntime } = await import("@/node/runtime/DockerRuntime");
            const containerName = `mux-docker-ready-test-${Date.now()}`;

            // Start a fresh container (no --rm so we can stop/start it)
            execSync(`docker run -d --name ${containerName} mux-ssh-test sleep infinity`, {
              timeout: 60000,
            });

            try {
              // Stop the container
              execSync(`docker stop ${containerName}`, { timeout: 30000 });

              // Verify it's stopped
              const stoppedState = execSync(
                `docker inspect --format='{{.State.Running}}' ${containerName}`,
                { encoding: "utf-8", timeout: 10000 }
              );
              expect(stoppedState.trim()).toBe("false");

              // ensureReady() should start it
              const runtime = new DockerRuntime({
                image: "mux-ssh-test",
                containerName,
              });
              const result = await runtime.ensureReady();
              expect(result).toEqual({ ready: true });

              // Verify container is running again
              const inspectOutput = execSync(
                `docker inspect --format='{{.State.Running}}' ${containerName}`,
                { encoding: "utf-8", timeout: 10000 }
              );
              expect(inspectOutput.trim()).toBe("true");
            } finally {
              // Clean up: stop and remove the test container
              try {
                execSync(`docker rm -f ${containerName}`, { timeout: 30000 });
              } catch {
                // Ignore cleanup errors
              }
            }
          },
          90000
        );

        testDockerOnly("returns error for non-existent container", async () => {
          // Create a DockerRuntime pointing to a container that doesn't exist
          const { DockerRuntime } = await import("@/node/runtime/DockerRuntime");
          const runtime = new DockerRuntime({
            image: "ubuntu:22.04",
            containerName: "mux-nonexistent-container-12345",
          });

          const result = await runtime.ensureReady();
          expect(result.ready).toBe(false);
          if (!result.ready) {
            expect(result.error).toBeDefined();
          }
        });
      });

      describe("resolvePath() - Path resolution", () => {
        testForRuntime("expands ~ to the home directory", async () => {
          const runtime = createRuntime();

          const resolved = await runtime.resolvePath("~");

          if (type === "ssh") {
            expect(resolved).toBe("/home/testuser");
          } else if (type === "docker") {
            expect(resolved).toBe("/root");
          } else {
            expect(resolved).toBe(os.homedir());
          }
        });

        testForRuntime("expands ~/path by prefixing the home directory", async () => {
          const runtime = createRuntime();

          const home = await runtime.resolvePath("~");
          const resolved = await runtime.resolvePath("~/mux");

          expect(resolved).toBe(`${home}/mux`);
        });
      });

      describe("readFile() - File reading", () => {
        for (const { name, fileName, content } of [
          {
            name: "reads file contents",
            fileName: "test.txt",
            content: "Hello, World!\nLine 2\nLine 3",
          },
          { name: "reads empty file", fileName: "empty.txt", content: "" },
        ]) {
          testForRuntime(name, async () => {
            await withRuntimeWorkspace(async (runtime, workspace) => {
              const path = `${workspace.path}/${fileName}`;
              await writeFileString(runtime, path, content);
              expect(await readFileString(runtime, path)).toBe(content);
            });
          });
        }

        testLocalOnly("reads binary data correctly", async () => {
          await withRuntimeWorkspace(async (runtime, workspace) => {
            const binaryData = new Uint8Array([0, 1, 2, 255, 254, 253]);
            const writer = runtime.writeFile(`${workspace.path}/binary.dat`).getWriter();
            await writer.write(binaryData);
            await writer.close();

            const reader = runtime.readFile(`${workspace.path}/binary.dat`).getReader();
            const chunks: Uint8Array[] = [];
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
            }

            const readData = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
            let offset = 0;
            for (const chunk of chunks) {
              readData.set(chunk, offset);
              offset += chunk.length;
            }
            expect(readData).toEqual(binaryData);
          });
        });

        for (const { name, setup, path, error } of [
          {
            name: "throws RuntimeError for non-existent file",
            setup: async () => {},
            path: "does-not-exist.txt",
            error: RuntimeError,
          },
          {
            name: "throws RuntimeError when reading a directory",
            setup: (runtime: Runtime, workspace: TestWorkspace) =>
              execWorkspace(runtime, workspace, "mkdir -p subdir"),
            path: "subdir",
            error: Error,
          },
        ]) {
          testForRuntime(name, async () => {
            await withRuntimeWorkspace(async (runtime, workspace) => {
              await setup(runtime, workspace);
              await expect(readFileString(runtime, `${workspace.path}/${path}`)).rejects.toThrow(
                error
              );
            });
          });
        }
      });

      describe("writeFile() - File writing", () => {
        for (const { name, fileName, content, beforeWrite } of [
          { name: "writes file contents", fileName: "output.txt", content: "Test content\nLine 2" },
          {
            name: "overwrites existing file",
            fileName: "overwrite.txt",
            content: "new content",
            beforeWrite: (runtime: Runtime, path: string) =>
              writeFileString(runtime, path, "original"),
          },
          { name: "writes empty file", fileName: "empty.txt", content: "" },
          {
            name: "creates parent directories if needed",
            fileName: "nested/dir/file.txt",
            content: "content",
          },
          {
            name: "handles special characters in content",
            fileName: "special.txt",
            content: 'Special chars: \n\t"quotes"\'\r\n$VAR`cmd`',
          },
        ]) {
          testForRuntime(name, async () => {
            await withRuntimeWorkspace(async (runtime, workspace) => {
              const path = `${workspace.path}/${fileName}`;
              await beforeWrite?.(runtime, path);
              await writeFileString(runtime, path, content);
              expect(await readFileString(runtime, path)).toBe(content);
            });
          });
        }

        testLocalOnly("writes binary data", async () => {
          await withRuntimeWorkspace(async (runtime, workspace) => {
            const binaryData = new Uint8Array([0, 1, 2, 255, 254, 253]);
            const writer = runtime.writeFile(`${workspace.path}/binary.dat`).getWriter();
            await writer.write(binaryData);
            await writer.close();

            const result = await execWorkspace(runtime, workspace, "wc -c < binary.dat");
            expect(result.stdout.trim()).toBe("6");
          });
        });

        testDockerOnly("preserves symlinks when editing target file", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Create a target file
          const targetPath = `${workspace.path}/target.txt`;
          await writeFileString(runtime, targetPath, "original content");

          // Create a symlink to the target
          const linkPath = `${workspace.path}/link.txt`;
          const result = await execWorkspace(runtime, workspace, `ln -s target.txt link.txt`);
          expect(result.exitCode).toBe(0);

          // Verify symlink was created
          const lsResult = await execWorkspace(runtime, workspace, "ls -la link.txt");
          expect(lsResult.stdout).toContain("->");
          expect(lsResult.stdout).toContain("target.txt");

          // Edit the file via the symlink
          await writeFileString(runtime, linkPath, "new content");

          // Verify the symlink is still a symlink (not replaced with a file)
          const lsAfter = await execWorkspace(runtime, workspace, "ls -la link.txt");
          expect(lsAfter.stdout).toContain("->");
          expect(lsAfter.stdout).toContain("target.txt");

          // Verify both the symlink and target have the new content
          const linkContent = await readFileString(runtime, linkPath);
          expect(linkContent).toBe("new content");

          const targetContent = await readFileString(runtime, targetPath);
          expect(targetContent).toBe("new content");
        });

        testDockerOnly("preserves file permissions when editing through symlink", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Create a target file with specific permissions (755)
          const targetPath = `${workspace.path}/target.txt`;
          await writeFileString(runtime, targetPath, "original content");

          // Set permissions to 755
          const chmodResult = await execWorkspace(runtime, workspace, "chmod 755 target.txt");
          expect(chmodResult.exitCode).toBe(0);

          // Verify initial permissions
          const statBefore = await execWorkspace(runtime, workspace, "stat -c '%a' target.txt");
          expect(statBefore.stdout.trim()).toBe("755");

          // Create a symlink to the target
          const linkPath = `${workspace.path}/link.txt`;
          const lnResult = await execWorkspace(runtime, workspace, "ln -s target.txt link.txt");
          expect(lnResult.exitCode).toBe(0);

          // Edit the file via the symlink
          await writeFileString(runtime, linkPath, "new content");

          // Verify permissions are preserved
          const statAfter = await execWorkspace(runtime, workspace, "stat -c '%a' target.txt");
          expect(statAfter.stdout.trim()).toBe("755");

          // Verify content was updated
          const content = await readFileString(runtime, targetPath);
          expect(content).toBe("new content");
        });
      });

      describe("stat() - File metadata", () => {
        testForRuntime("returns file metadata", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const content = "Test content";
          await writeFileString(runtime, `${workspace.path}/test.txt`, content);

          const stat = await runtime.stat(`${workspace.path}/test.txt`);

          expect(stat.size).toBe(content.length);
          expect(stat.isDirectory).toBe(false);
          // Check modifiedTime is a valid date (use getTime() to avoid Jest Date issues)
          expect(typeof stat.modifiedTime.getTime).toBe("function");
          expect(stat.modifiedTime.getTime()).toBeGreaterThan(0);
          expect(stat.modifiedTime.getTime()).toBeLessThanOrEqual(Date.now());
        });

        testForRuntime("returns directory metadata", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          await execWorkspace(runtime, workspace, "mkdir subdir", {
            cwd: workspace.path,
            timeout: 30,
          });

          const stat = await runtime.stat(`${workspace.path}/subdir`);

          expect(stat.isDirectory).toBe(true);
        });

        testForRuntime("throws RuntimeError for non-existent path", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          await expect(runtime.stat(`${workspace.path}/does-not-exist`)).rejects.toThrow(
            RuntimeError
          );
        });

        testForRuntime("returns correct size for empty file", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          await writeFileString(runtime, `${workspace.path}/empty.txt`, "");

          const stat = await runtime.stat(`${workspace.path}/empty.txt`);

          expect(stat.size).toBe(0);
          expect(stat.isDirectory).toBe(false);
        });
      });

      describeLocalOnly("Edge cases", () => {
        testForRuntime(
          "handles large files efficiently",
          async () => {
            const runtime = createRuntime();
            await using workspace = await TestWorkspace.create(runtime, type);

            // Create 1MB file
            const largeContent = "x".repeat(1024 * 1024);
            await writeFileString(runtime, `${workspace.path}/large.txt`, largeContent);

            const content = await readFileString(runtime, `${workspace.path}/large.txt`);

            expect(content.length).toBe(1024 * 1024);
            expect(content).toBe(largeContent);
          },
          30000
        );

        testLocalOnly("handles concurrent operations", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Run multiple file operations concurrently
          const operations = Array.from({ length: 10 }, async (_, i) => {
            const path = `${workspace.path}/concurrent-${i}.txt`;
            await writeFileString(runtime, path, `content-${i}`);
            const content = await readFileString(runtime, path);
            expect(content).toBe(`content-${i}`);
          });

          await Promise.all(operations);
        });

        testForRuntime("handles paths with spaces", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const path = `${workspace.path}/file with spaces.txt`;
          await writeFileString(runtime, path, "content");

          const content = await readFileString(runtime, path);
          expect(content).toBe("content");
        });

        testForRuntime("handles very long file paths", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Create nested directories
          const longPath = `${workspace.path}/a/b/c/d/e/f/g/h/i/j/file.txt`;
          await writeFileString(runtime, longPath, "nested");

          const content = await readFileString(runtime, longPath);
          expect(content).toBe("nested");
        });
      });

      describeNonDocker("Git operations", () => {
        testForRuntime("can initialize a git repository", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Initialize git repo
          const result = await execWorkspace(runtime, workspace, "git init");

          expect(result.exitCode).toBe(0);

          // Verify .git directory exists
          const stat = await runtime.stat(`${workspace.path}/.git`);
          expect(stat.isDirectory).toBe(true);
        });

        testForRuntime("can create commits", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Initialize git and configure user
          await execBuffered(
            runtime,
            `git init && git config user.email "test@example.com" && git config user.name "Test User"`,
            { cwd: workspace.path, timeout: 30 }
          );

          // Create a file and commit
          await writeFileString(runtime, `${workspace.path}/test.txt`, "initial content");
          await execWorkspace(
            runtime,
            workspace,
            `git add test.txt && git commit -m "Initial commit"`
          );

          // Verify commit exists
          const logResult = await execWorkspace(runtime, workspace, "git log --oneline");

          expect(logResult.stdout).toContain("Initial commit");
        });

        testForRuntime("can create and checkout branches", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Setup git repo
          await execBuffered(
            runtime,
            `git init && git config user.email "test@example.com" && git config user.name "Test"`,
            { cwd: workspace.path, timeout: 30 }
          );

          // Create initial commit
          await writeFileString(runtime, `${workspace.path}/file.txt`, "content");
          await execWorkspace(runtime, workspace, `git add file.txt && git commit -m "init"`);

          // Create and checkout new branch
          await execWorkspace(runtime, workspace, "git checkout -b feature-branch");

          // Verify branch
          const branchResult = await execWorkspace(runtime, workspace, "git branch --show-current");

          expect(branchResult.stdout.trim()).toBe("feature-branch");
        });

        testForRuntime("can handle git status in dirty workspace", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Setup git repo with commit
          await execBuffered(
            runtime,
            `git init && git config user.email "test@example.com" && git config user.name "Test"`,
            { cwd: workspace.path, timeout: 30 }
          );
          await writeFileString(runtime, `${workspace.path}/file.txt`, "original");
          await execWorkspace(runtime, workspace, `git add file.txt && git commit -m "init"`);

          // Make changes
          await writeFileString(runtime, `${workspace.path}/file.txt`, "modified");

          // Check status
          const statusResult = await execWorkspace(runtime, workspace, "git status --short");

          expect(statusResult.stdout).toContain("M file.txt");
        });
      });

      describeNonDocker("Environment and shell behavior", () => {
        testForRuntime("preserves multi-line output formatting", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execWorkspace(runtime, workspace, 'echo "line1\nline2\nline3"');

          expect(result.stdout).toContain("line1");
          expect(result.stdout).toContain("line2");
          expect(result.stdout).toContain("line3");
        });

        testForRuntime("handles commands with pipes", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          await writeFileString(runtime, `${workspace.path}/test.txt`, "line1\nline2\nline3");

          const result = await execWorkspace(runtime, workspace, "cat test.txt | grep line2");

          expect(result.stdout.trim()).toBe("line2");
        });

        testForRuntime("handles command substitution", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execWorkspace(
            runtime,
            workspace,
            'echo "Current dir: $(basename $(pwd))"'
          );

          expect(result.stdout).toContain("Current dir:");
        });

        testForRuntime("handles large stdout output", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Generate large output (1000 lines)
          const result = await execWorkspace(runtime, workspace, "seq 1 1000");

          const lines = result.stdout.trim().split("\n");
          expect(lines.length).toBe(1000);
          expect(lines[0]).toBe("1");
          expect(lines[999]).toBe("1000");
        });

        testForRuntime("handles commands that produce no output but take time", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execWorkspace(runtime, workspace, "sleep 0.1");

          expect(result.exitCode).toBe(0);
          expect(result.stdout).toBe("");
          expect(result.duration).toBeGreaterThanOrEqual(100);
        });
      });

      describeLocalOnly("Error handling", () => {
        testForRuntime("handles command not found", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execWorkspace(runtime, workspace, "nonexistentcommand");

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr.toLowerCase()).toContain("not found");
        });

        testForRuntime("handles syntax errors in bash", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          const result = await execWorkspace(runtime, workspace, "if true; then echo 'missing fi'");

          expect(result.exitCode).not.toBe(0);
        });

        testForRuntime("handles permission denied errors", async () => {
          const runtime = createRuntime();
          await using workspace = await TestWorkspace.create(runtime, type);

          // Create file without execute permission and try to execute it
          await writeFileString(runtime, `${workspace.path}/script.sh`, "#!/bin/sh\necho test");
          await execWorkspace(runtime, workspace, "chmod 644 script.sh");

          const result = await execWorkspace(runtime, workspace, "./script.sh");

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr.toLowerCase()).toContain("permission denied");
        });
      });
    }
  );

  /**
   * SSHRuntime-specific workspace operation tests
   * WorktreeRuntime workspace tests are covered by the matrix above
   *
   * Note: SSHRuntime derives workspace paths from the hashed remote project layout
   * when a persisted workspacePath is not available.
   * These tests build the same layout helpers as production code before asserting paths.
   */
  describe("SSHRuntime workspace operations", () => {
    const testForRuntime = test;
    const srcBaseDir = "/home/testuser/workspace";
    const createSSHRuntime = (): Runtime => createTestRuntime("ssh", srcBaseDir, sshConfig);
    const getLayout = (projectPath: string) => buildRemoteProjectLayout(srcBaseDir, projectPath);

    describe("renameWorkspace", () => {
      testForRuntime("successfully renames directory", async () => {
        const runtime = createSSHRuntime();
        // Use unique project name to avoid conflicts with concurrent tests
        const projectName = `rename-test-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        // projectPath is used to extract project name - can be any path ending with projectName
        const projectPath = `/some/path/${projectName}`;

        const layout = getLayout(projectPath);
        const oldWorkspacePath = getRemoteWorkspacePath(layout, "worktree-1");
        const newWorkspacePath = getRemoteWorkspacePath(layout, "worktree-renamed");

        // Create the workspace directory structure where the runtime expects it
        await execSSH(
          runtime,
          `mkdir -p "${oldWorkspacePath}" && echo "test" > "${oldWorkspacePath}/test.txt"`
        );

        // Rename the workspace
        const result = await runtime.renameWorkspace(projectPath, "worktree-1", "worktree-renamed");

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.oldPath).toBe(oldWorkspacePath);
          expect(result.newPath).toBe(newWorkspacePath);

          // Verify old path no longer exists
          const oldCheck = await execSSH(
            runtime,
            `test -d "${result.oldPath}" && echo "exists" || echo "missing"`
          );
          expect(oldCheck.stdout.trim()).toBe("missing");

          // Verify new path exists with content
          const newCheck = await execSSH(
            runtime,
            `test -f "${result.newPath}/test.txt" && echo "exists" || echo "missing"`
          );
          expect(newCheck.stdout.trim()).toBe("exists");
        }

        // Cleanup
        await execSSH(runtime, `rm -rf "${layout.projectRoot}"`);
      });

      testForRuntime("returns error when trying to rename non-existent directory", async () => {
        const runtime = createSSHRuntime();
        const projectName = `nonexist-rename-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const projectPath = `/some/path/${projectName}`;

        // Try to rename a directory that doesn't exist
        const result = await runtime.renameWorkspace(projectPath, "non-existent", "new-name");

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("Failed to rename directory");
        }
      });
    });

    describe("forkWorkspace", () => {
      test("forks from the source workspace's current branch", async () => {
        const runtime = createSSHRuntime();
        const projectName = `fork-test-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const projectPath = `/some/path/${projectName}`;

        const sourceWorkspaceName = "source";
        const newWorkspaceName = "forked";

        const layout = getLayout(projectPath);
        const sourceWorkspacePath = getRemoteWorkspacePath(layout, sourceWorkspaceName);
        const newWorkspacePath = getRemoteWorkspacePath(layout, newWorkspaceName);

        // Create a source workspace repo with a non-trunk branch checked out.
        await execSSH(
          runtime,
          [
            `mkdir -p "${sourceWorkspacePath}"`,
            `cd "${sourceWorkspacePath}"`,
            `git init`,
            `git config user.email "test@example.com"`,
            `git config user.name "Test"`,
            `echo "root" > root.txt`,
            `git add root.txt`,
            `git commit -m "root"`,
            `git checkout -b feature`,
            `echo "feature" > feature.txt`,
            `git add feature.txt`,
            `git commit -m "feature"`,
            `echo "untracked" > untracked.txt`,
            `echo "local-change" >> feature.txt`,
          ].join(" && ")
        );

        // Sanity check the source branch.
        const sourceBranchCheck = await execSSH(
          runtime,
          `git -C "${sourceWorkspacePath}" branch --show-current`
        );
        expect(sourceBranchCheck.stdout.trim()).toBe("feature");

        const initLogger = {
          logStep(_message: string) {},
          logStdout(_line: string) {},
          logStderr(_line: string) {},
          logComplete(_exitCode: number) {},
        };

        const forkResult = await runtime.forkWorkspace({
          projectPath,
          sourceWorkspaceName,
          newWorkspaceName,
          initLogger,
        });

        expect(forkResult.success).toBe(true);
        if (!forkResult.success) return;

        expect(forkResult.workspacePath).toBe(newWorkspacePath);
        expect(forkResult.sourceBranch).toBe("feature");

        const newBranchCheck = await execSSH(
          runtime,
          `git -C "${newWorkspacePath}" branch --show-current`
        );
        expect(newBranchCheck.stdout.trim()).toBe(newWorkspaceName);

        // Verify the new workspace is based on the source branch commit.
        const fileCheck = await execSSH(
          runtime,
          `test -f "${newWorkspacePath}/feature.txt" && echo "exists" || echo "missing"`
        );

        expect(fileCheck.stdout.trim()).toBe("exists");

        // Fork should preserve uncommitted working tree changes from the source workspace.
        const untrackedCheck = await execSSH(
          runtime,
          `test -f "${newWorkspacePath}/untracked.txt" && echo "exists" || echo "missing"`
        );
        expect(untrackedCheck.stdout.trim()).toBe("exists");

        const modifiedCheck = await execSSH(
          runtime,
          `grep -q "local-change" "${newWorkspacePath}/feature.txt" && echo "present" || echo "missing"`
        );
        expect(modifiedCheck.stdout.trim()).toBe("present");

        // runFullInit (and thus initWorkspace) should be able to run on a forked repo
        // without trying to re-sync. (The absence of a .mux/init hook means it will
        // complete immediately.)
        const initResult = await runFullInit(runtime, {
          projectPath,
          branchName: newWorkspaceName,
          trunkBranch: "feature",
          workspacePath: newWorkspacePath,
          initLogger,
        });
        expect(initResult.success).toBe(true);

        // Cleanup
        await execSSH(runtime, `rm -rf "${layout.projectRoot}"`);
      });
    });

    describe("deleteWorkspace", () => {
      testForRuntime("successfully deletes directory", async () => {
        const runtime = createSSHRuntime();
        const projectName = `delete-test-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const projectPath = `/some/path/${projectName}`;
        const layout = getLayout(projectPath);
        const workspacePath = getRemoteWorkspacePath(layout, "worktree-delete-test");

        // Create the workspace directory structure where the runtime expects it
        await execSSH(
          runtime,
          `mkdir -p "${workspacePath}" && echo "test" > "${workspacePath}/test.txt"`
        );

        // Verify workspace exists
        const beforeCheck = await execSSH(
          runtime,
          `test -d "${workspacePath}" && echo "exists" || echo "missing"`
        );
        expect(beforeCheck.stdout.trim()).toBe("exists");

        // Delete the workspace (force=true since it's not a git repo)
        const result = await runtime.deleteWorkspace(projectPath, "worktree-delete-test", true);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.deletedPath).toBe(workspacePath);

          // Verify workspace was deleted
          const afterCheck = await execSSH(
            runtime,
            `test -d "${result.deletedPath}" && echo "exists" || echo "missing"`
          );
          expect(afterCheck.stdout.trim()).toBe("missing");
        }

        // Cleanup
        await execSSH(runtime, `rm -rf "${layout.projectRoot}"`);
      });

      testForRuntime("returns success for non-existent directory (idempotent)", async () => {
        const runtime = createSSHRuntime();
        const projectName = `nonexist-delete-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const projectPath = `/some/path/${projectName}`;

        // Try to delete a workspace that doesn't exist
        const result = await runtime.deleteWorkspace(projectPath, "non-existent", false);

        // Should be idempotent - return success for non-existent workspaces
        expect(result.success).toBe(true);
      });
    });
  });

  /**
   * SSHRuntime worktree-based workspace operations
   *
   * Tests the shared bare base repo + git worktree approach for SSH workspaces.
   * When a base repo (.mux-base.git) exists, fork/init/delete/rename use git worktree
   * commands instead of full directory copies. Legacy workspaces (no base repo) still work.
   */
  describe("SSHRuntime worktree operations", () => {
    const srcBaseDir = "/home/testuser/workspace";
    const createSSHRuntime = (): SSHRuntime =>
      createTestRuntime("ssh", srcBaseDir, sshConfig) as SSHRuntime;
    const getLayout = (projectPath: string) => buildRemoteProjectLayout(srcBaseDir, projectPath);

    test("computeBaseRepoPath returns correct path", async () => {
      const layout = getLayout("/some/path/my-project");
      const result = computeBaseRepoPath(srcBaseDir, "/some/path/my-project");
      expect(result).toBe(layout.baseRepoPath);
    }, 10000);

    test("forkWorkspace uses worktree when base repo exists", async () => {
      const runtime = createSSHRuntime();
      const projectName = `wt-fork-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const projectPath = `/some/path/${projectName}`;
      const layout = getLayout(projectPath);
      const baseRepoPath = layout.baseRepoPath;
      const sourceWorkspacePath = getRemoteWorkspacePath(layout, "source");
      const newWorkspaceName = "forked-wt";
      const newWorkspacePath = getRemoteWorkspacePath(layout, newWorkspaceName);

      try {
        // 1. Create a bare base repo and populate it with a commit.
        await execSSH(
          runtime,
          [
            `mkdir -p "${layout.projectRoot}"`,
            `git init --bare "${baseRepoPath}"`,
            // Create a temp repo, commit, and push to the bare repo.
            `TMPCLONE=$(mktemp -d)`,
            `git clone "${baseRepoPath}" "$TMPCLONE/work"`,
            `cd "$TMPCLONE/work"`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "base content" > base.txt`,
            `git add base.txt`,
            `git commit -m "initial"`,
            `git push origin HEAD:main`,
            `rm -rf "$TMPCLONE"`,
          ].join(" && ")
        );

        // 2. Create the source workspace as a worktree of the base repo.
        await execSSH(
          runtime,
          `git -C "${baseRepoPath}" worktree add "${sourceWorkspacePath}" -b source main`
        );

        // Verify source workspace has the content.
        const sourceCheck = await execSSH(
          runtime,
          `test -f "${sourceWorkspacePath}/base.txt" && echo "exists" || echo "missing"`
        );
        expect(sourceCheck.stdout.trim()).toBe("exists");

        // 3. Fork the workspace — should use the fast worktree path.
        const forkResult = await runtime.forkWorkspace({
          projectPath,
          sourceWorkspaceName: "source",
          newWorkspaceName,
          initLogger: noopInitLogger,
        });

        expect(forkResult.success).toBe(true);
        if (!forkResult.success) return;
        expect(forkResult.workspacePath).toBe(newWorkspacePath);
        expect(forkResult.sourceBranch).toBe("source");

        // 4. Verify the forked workspace is a worktree (.git is a file, not directory).
        const gitTypeCheck = await execSSH(
          runtime,
          `test -f "${newWorkspacePath}/.git" && echo "file" || (test -d "${newWorkspacePath}/.git" && echo "dir" || echo "missing")`
        );
        expect(gitTypeCheck.stdout.trim()).toBe("file");

        // 5. Verify the worktree has the correct branch and files.
        const branchCheck = await execSSH(
          runtime,
          `git -C "${newWorkspacePath}" branch --show-current`
        );
        expect(branchCheck.stdout.trim()).toBe(newWorkspaceName);

        const fileCheck = await execSSH(runtime, `cat "${newWorkspacePath}/base.txt"`);
        expect(fileCheck.stdout.trim()).toBe("base content");

        // 6. Verify the worktree is listed in the base repo.
        const worktreeList = await execSSH(runtime, `git -C "${baseRepoPath}" worktree list`);
        expect(worktreeList.stdout).toContain(newWorkspaceName);
      } finally {
        // Cleanup: remove all worktrees and the project directory.
        await execSSH(runtime, `rm -rf "${layout.projectRoot}"`);
      }
    }, 60000);

    test("forkWorkspace falls back to cp -R -P when no base repo exists (legacy)", async () => {
      const runtime = createSSHRuntime();
      const projectName = `wt-legacy-fork-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const projectPath = `/some/path/${projectName}`;
      const layout = getLayout(projectPath);
      const sourceWorkspacePath = getRemoteWorkspacePath(layout, "legacy-source");
      const newWorkspaceName = "legacy-forked";
      const newWorkspacePath = getRemoteWorkspacePath(layout, newWorkspaceName);

      try {
        // Create a legacy workspace (standalone git clone, no base repo).
        await execSSH(
          runtime,
          [
            `mkdir -p "${sourceWorkspacePath}"`,
            `cd "${sourceWorkspacePath}"`,
            `git init`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "legacy content" > legacy.txt`,
            `git add legacy.txt`,
            `git commit -m "legacy initial"`,
            `git checkout -b legacy-branch`,
          ].join(" && ")
        );

        // Verify no base repo exists.
        const baseCheck = await execSSH(
          runtime,
          `test -d "${layout.baseRepoPath}" && echo "exists" || echo "missing"`
        );
        expect(baseCheck.stdout.trim()).toBe("missing");

        // Fork should use the legacy cp -R -P path.
        const forkResult = await runtime.forkWorkspace({
          projectPath,
          sourceWorkspaceName: "legacy-source",
          newWorkspaceName,
          initLogger: noopInitLogger,
        });

        expect(forkResult.success).toBe(true);
        if (!forkResult.success) return;
        expect(forkResult.sourceBranch).toBe("legacy-branch");

        // Verify the forked workspace is a full clone (.git is a directory, not a file).
        const gitTypeCheck = await execSSH(
          runtime,
          `test -d "${newWorkspacePath}/.git" && echo "dir" || echo "not-dir"`
        );
        expect(gitTypeCheck.stdout.trim()).toBe("dir");

        // Verify content was copied.
        const fileCheck = await execSSH(runtime, `cat "${newWorkspacePath}/legacy.txt"`);
        expect(fileCheck.stdout.trim()).toBe("legacy content");
      } finally {
        await execSSH(runtime, `rm -rf "${layout.projectRoot}"`);
      }
    }, 60000);

    test("forkWorkspace falls back to cp when base repo exists but source branch is missing from it", async () => {
      const runtime = createSSHRuntime();
      const projectName = `wt-mixed-fork-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const projectPath = `/some/path/${projectName}`;
      const layout = getLayout(projectPath);
      const baseRepoPath = layout.baseRepoPath;
      const sourceWorkspacePath = getRemoteWorkspacePath(layout, "legacy-ws");
      const newWorkspaceName = "forked-mixed";
      const newWorkspacePath = getRemoteWorkspacePath(layout, newWorkspaceName);

      try {
        // 1. Create a bare base repo with a commit on 'main' (simulates a previous initWorkspace).
        await execSSH(
          runtime,
          [
            `mkdir -p "${layout.projectRoot}"`,
            `git init --bare "${baseRepoPath}"`,
            `TMPCLONE=$(mktemp -d)`,
            `git clone "${baseRepoPath}" "$TMPCLONE/work"`,
            `cd "$TMPCLONE/work"`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "base" > base.txt`,
            `git add base.txt`,
            `git commit -m "initial"`,
            `git push origin HEAD:main`,
            `rm -rf "$TMPCLONE"`,
          ].join(" && ")
        );

        // 2. Create a legacy workspace (full clone) with a branch that does NOT exist in the base repo.
        await execSSH(
          runtime,
          [
            `mkdir -p "${sourceWorkspacePath}"`,
            `cd "${sourceWorkspacePath}"`,
            `git init`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "legacy content" > legacy.txt`,
            `git add legacy.txt`,
            `git commit -m "legacy commit"`,
            `git checkout -b only-on-legacy`,
          ].join(" && ")
        );

        // Confirm base repo exists (so forkWorkspace will try the worktree path first).
        const baseCheck = await execSSH(
          runtime,
          `test -d "${baseRepoPath}" && echo "exists" || echo "missing"`
        );
        expect(baseCheck.stdout.trim()).toBe("exists");

        // 3. Fork the legacy workspace — should fall back to cp since "only-on-legacy"
        //    doesn't exist in the base repo.
        const forkResult = await runtime.forkWorkspace({
          projectPath,
          sourceWorkspaceName: "legacy-ws",
          newWorkspaceName,
          initLogger: noopInitLogger,
        });

        expect(forkResult.success).toBe(true);
        if (!forkResult.success) return;
        expect(forkResult.sourceBranch).toBe("only-on-legacy");

        // 4. Verify the forked workspace is a full clone (cp -R -P path), not a worktree.
        const gitTypeCheck = await execSSH(
          runtime,
          `test -d "${newWorkspacePath}/.git" && echo "dir" || echo "not-dir"`
        );
        expect(gitTypeCheck.stdout.trim()).toBe("dir");

        // 5. Verify content was copied.
        const fileCheck = await execSSH(runtime, `cat "${newWorkspacePath}/legacy.txt"`);
        expect(fileCheck.stdout.trim()).toBe("legacy content");
      } finally {
        await execSSH(runtime, `rm -rf "${layout.projectRoot}"`);
      }
    }, 60000);

    test("deleteWorkspace removes worktree and cleans up base repo metadata", async () => {
      const runtime = createSSHRuntime();
      const projectName = `wt-delete-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const projectPath = `/some/path/${projectName}`;
      const layout = getLayout(projectPath);
      const baseRepoPath = layout.baseRepoPath;
      const workspaceName = "to-delete";
      const workspacePath = getRemoteWorkspacePath(layout, workspaceName);

      try {
        // Create bare base repo with a commit.
        await execSSH(
          runtime,
          [
            `mkdir -p "${layout.projectRoot}"`,
            `git init --bare "${baseRepoPath}"`,
            `TMPCLONE=$(mktemp -d)`,
            `git clone "${baseRepoPath}" "$TMPCLONE/work"`,
            `cd "$TMPCLONE/work"`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "x" > x.txt && git add x.txt && git commit -m "init"`,
            `git push origin HEAD:main`,
            `rm -rf "$TMPCLONE"`,
          ].join(" && ")
        );

        // Create a worktree workspace.
        await execSSH(
          runtime,
          `git -C "${baseRepoPath}" worktree add "${workspacePath}" -b ${workspaceName} main`
        );

        // Verify it exists as a worktree.
        const beforeCheck = await execSSH(
          runtime,
          `test -f "${workspacePath}/.git" && echo "worktree" || echo "not-worktree"`
        );
        expect(beforeCheck.stdout.trim()).toBe("worktree");

        await execSSH(runtime, `git --git-dir="${baseRepoPath}" symbolic-ref HEAD refs/heads/main`);

        // Delete the workspace.
        const deleteResult = await runtime.deleteWorkspace(
          projectPath,
          workspaceName,
          true // force
        );

        expect(deleteResult.success).toBe(true);

        // Verify directory is gone.
        const afterCheck = await execSSH(
          runtime,
          `test -d "${workspacePath}" && echo "exists" || echo "missing"`
        );
        expect(afterCheck.stdout.trim()).toBe("missing");

        // Verify worktree metadata is cleaned up in the base repo.
        const worktreeList = await execSSH(runtime, `git -C "${baseRepoPath}" worktree list`);
        expect(worktreeList.stdout).not.toContain(workspaceName);

        const deletedBranchRef = await execSSH(
          runtime,
          `git --git-dir="${baseRepoPath}" show-ref --verify --quiet refs/heads/${workspaceName}`
        );
        expect(deletedBranchRef.exitCode).toBe(1);
      } finally {
        await execSSH(runtime, `rm -rf "${layout.projectRoot}"`);
      }
    }, 60000);

    test("deleteWorkspace leaves an unmanaged source checkout's HEAD untouched", async () => {
      const runtime = createSSHRuntime();
      const projectName = `wt-del-unmanaged-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const projectPath = `/some/path/${projectName}`;
      const layout = getLayout(projectPath);
      const sourceCheckoutPath = `${layout.projectRoot}/unmanaged-src`;
      const workspaceName = "doomed-wt";
      const workspacePath = getRemoteWorkspacePath(layout, workspaceName);

      try {
        // A real (non-Mux) checkout whose worktree happens to live at the
        // canonical workspace path. resolveWorktreeBaseRepoPath() resolves the
        // workspace's git-common-dir to this checkout's .git, so deletion
        // cleanup must not rewrite the checkout's HEAD.
        await execSSH(
          runtime,
          [
            `mkdir -p "${sourceCheckoutPath}"`,
            `cd "${sourceCheckoutPath}"`,
            `git init -b main`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "x" > x.txt && git add x.txt && git commit -m "init"`,
            `git worktree add "${workspacePath}" -b ${workspaceName}`,
          ].join(" && ")
        );

        const headCommitBefore = await execSSH(
          runtime,
          `git -C "${sourceCheckoutPath}" rev-parse HEAD`
        );

        const deleteResult = await runtime.deleteWorkspace(projectPath, workspaceName, true);
        expect(deleteResult.success).toBe(true);

        const afterCheck = await execSSH(
          runtime,
          `test -d "${workspacePath}" && echo "exists" || echo "missing"`
        );
        expect(afterCheck.stdout.trim()).toBe("missing");

        // The source checkout must still be on its own branch with a
        // resolvable HEAD — not stranded on Mux's unborn internal branch.
        const headRefAfter = await execSSH(
          runtime,
          `git -C "${sourceCheckoutPath}" symbolic-ref HEAD`
        );
        expect(headRefAfter.stdout.trim()).toBe("refs/heads/main");

        const headCommitAfter = await execSSH(
          runtime,
          `git -C "${sourceCheckoutPath}" rev-parse --verify HEAD`
        );
        expect(headCommitAfter.exitCode).toBe(0);
        expect(headCommitAfter.stdout.trim()).toBe(headCommitBefore.stdout.trim());
      } finally {
        await execSSH(runtime, `rm -rf "${layout.projectRoot}"`);
      }
    }, 60000);

    test("deleteWorkspace still works for legacy full-clone workspaces", async () => {
      const runtime = createSSHRuntime();
      const projectName = `wt-del-legacy-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const projectPath = `/some/path/${projectName}`;
      const layout = getLayout(projectPath);
      const workspacePath = getRemoteWorkspacePath(layout, "legacy-ws");

      try {
        // Create a legacy workspace (standalone git clone, .git is a directory).
        await execSSH(
          runtime,
          [
            `mkdir -p "${workspacePath}"`,
            `cd "${workspacePath}"`,
            `git init`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "x" > x.txt && git add x.txt && git commit -m "init"`,
          ].join(" && ")
        );

        const deleteResult = await runtime.deleteWorkspace(projectPath, "legacy-ws", true);
        expect(deleteResult.success).toBe(true);

        const afterCheck = await execSSH(
          runtime,
          `test -d "${workspacePath}" && echo "exists" || echo "missing"`
        );
        expect(afterCheck.stdout.trim()).toBe("missing");
      } finally {
        await execSSH(runtime, `rm -rf "${layout.projectRoot}"`);
      }
    }, 60000);

    test("renameWorkspace uses git worktree move and deleteWorkspace still cleans up the renamed branch", async () => {
      const runtime = createSSHRuntime();
      const projectName = `wt-rename-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const projectPath = `/some/path/${projectName}`;
      const layout = getLayout(projectPath);
      const baseRepoPath = layout.baseRepoPath;
      const oldWorkspacePath = getRemoteWorkspacePath(layout, "old-name");
      const newWorkspacePath = getRemoteWorkspacePath(layout, "new-name");

      try {
        // Set up bare base repo with a commit.
        await execSSH(
          runtime,
          [
            `mkdir -p "${layout.projectRoot}"`,
            `git init --bare "${baseRepoPath}"`,
            `TMPCLONE=$(mktemp -d)`,
            `git clone "${baseRepoPath}" "$TMPCLONE/work"`,
            `cd "$TMPCLONE/work"`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "x" > x.txt && git add x.txt && git commit -m "init"`,
            `git push origin HEAD:main`,
            `rm -rf "$TMPCLONE"`,
          ].join(" && ")
        );

        // Create a worktree workspace.
        await execSSH(
          runtime,
          `git -C "${baseRepoPath}" worktree add "${oldWorkspacePath}" -b old-name main`
        );

        // Rename the workspace.
        const result = await runtime.renameWorkspace(projectPath, "old-name", "new-name");

        expect(result.success).toBe(true);
        if (!result.success) return;

        // Verify old path doesn't exist and new path does.
        const oldCheck = await execSSH(
          runtime,
          `test -d "${oldWorkspacePath}" && echo "exists" || echo "missing"`
        );
        expect(oldCheck.stdout.trim()).toBe("missing");

        const newCheck = await execSSH(
          runtime,
          `test -f "${newWorkspacePath}/.git" && echo "worktree" || echo "not-worktree"`
        );
        expect(newCheck.stdout.trim()).toBe("worktree");

        // Verify the worktree is tracked at the new path (not the old path).
        // Note: git worktree move changes the path but NOT the branch name, so
        // `git worktree list` shows `/new-name [old-name]`. Check path only.
        const worktreeList = await execSSH(runtime, `git -C "${baseRepoPath}" worktree list`);
        expect(worktreeList.stdout).toContain("/new-name");
        expect(worktreeList.stdout).not.toContain("/old-name");

        const deleteResult = await runtime.deleteWorkspace(projectPath, "new-name", true);
        expect(deleteResult.success).toBe(true);

        const deletedPathCheck = await execSSH(
          runtime,
          `test -d "${newWorkspacePath}" && echo "exists" || echo "missing"`
        );
        expect(deletedPathCheck.stdout.trim()).toBe("missing");

        const branchCheck = await execSSH(
          runtime,
          `git -C "${baseRepoPath}" branch --list old-name`
        );
        expect(branchCheck.stdout.trim()).toBe("");
      } finally {
        await execSSH(runtime, `rm -rf "${layout.projectRoot}"`);
      }
    }, 60000);

    test("renameWorkspace and deleteWorkspace keep using the legacy base repo for upgraded SSH worktrees", async () => {
      if (!sshConfig) {
        throw new Error("SSH config unavailable");
      }

      const config = {
        host: "testuser@localhost",
        srcBaseDir,
        identityFile: sshConfig.privateKeyPath,
        port: sshConfig.port,
      };
      const runtime = new SSHRuntime(config, createSSHTransport(config, false), {
        projectPath: "/unused",
        workspaceName: "unused",
      });
      const projectName = `wt-legacy-rename-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const projectPath = `/some/path/${projectName}`;
      const legacyLayout = buildLegacyRemoteProjectLayout(srcBaseDir, projectPath);
      const baseRepoPath = legacyLayout.baseRepoPath;
      const oldWorkspacePath = getRemoteWorkspacePath(legacyLayout, "old-name");
      const newWorkspacePath = getRemoteWorkspacePath(legacyLayout, "new-name");
      const legacyRuntime = new SSHRuntime(config, createSSHTransport(config, false), {
        projectPath,
        workspaceName: "old-name",
        workspacePath: oldWorkspacePath,
      });

      try {
        await execSSH(
          runtime,
          [
            `mkdir -p "${legacyLayout.projectRoot}"`,
            `git init --bare "${baseRepoPath}"`,
            `TMPCLONE=$(mktemp -d)`,
            `git clone "${baseRepoPath}" "$TMPCLONE/work"`,
            `cd "$TMPCLONE/work"`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "x" > x.txt && git add x.txt && git commit -m "init"`,
            `git push origin HEAD:main`,
            `rm -rf "$TMPCLONE"`,
          ].join(" && ")
        );

        await execSSH(
          runtime,
          `git -C "${baseRepoPath}" worktree add "${oldWorkspacePath}" -b old-name main`
        );

        const renameResult = await legacyRuntime.renameWorkspace(
          projectPath,
          "old-name",
          "new-name"
        );
        expect(renameResult.success).toBe(true);
        if (!renameResult.success) return;

        const legacyWorktreeList = await execSSH(runtime, `git -C "${baseRepoPath}" worktree list`);
        expect(legacyWorktreeList.stdout).toContain("/new-name");
        expect(legacyWorktreeList.stdout).not.toContain("/old-name");

        const renamedLegacyRuntime = new SSHRuntime(config, createSSHTransport(config, false), {
          projectPath,
          workspaceName: "new-name",
          workspacePath: newWorkspacePath,
        });
        const deleteResult = await renamedLegacyRuntime.deleteWorkspace(
          projectPath,
          "new-name",
          true
        );
        expect(deleteResult.success).toBe(true);

        const deletedPathCheck = await execSSH(
          runtime,
          `test -d "${newWorkspacePath}" && echo "exists" || echo "missing"`
        );
        expect(deletedPathCheck.stdout.trim()).toBe("missing");

        const branchCheck = await execSSH(
          runtime,
          `git -C "${baseRepoPath}" branch --list old-name`
        );
        expect(branchCheck.stdout.trim()).toBe("");
      } finally {
        await execSSH(runtime, `rm -rf "${legacyLayout.projectRoot}"`);
      }
    }, 60000);

    test("exec handles a concurrent burst on one SSH host", async () => {
      const runtime = createSSHRuntime();
      const projectName = `ssh-burst-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const tmpDir = await import("os").then((os) => os.tmpdir());
      const localProjectPath = `${tmpDir}/${projectName}`;
      const layout = getLayout(localProjectPath);
      const workspaceName = "burst-ws";
      const workspacePath = getRemoteWorkspacePath(layout, workspaceName);
      const { execSync } = await import("child_process");

      try {
        execSync(
          [
            `mkdir -p "${localProjectPath}"`,
            `cd "${localProjectPath}"`,
            `git init -b main`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "content" > file.txt`,
            `git add file.txt`,
            `git commit -m "initial"`,
          ].join(" && "),
          { stdio: "pipe" }
        );

        const initResult = await runtime.initWorkspace({
          projectPath: localProjectPath,
          branchName: workspaceName,
          trunkBranch: "main",
          workspacePath,
          initLogger: noopInitLogger,
        });
        if (!initResult.success) {
          throw new Error(`initWorkspace failed: ${initResult.error}`);
        }

        const results = await Promise.all(
          Array.from({ length: 12 }, async (_value, index) => {
            const result = await execBuffered(
              runtime,
              `printf '%s' ${JSON.stringify(String(index))} > burst-${index}.txt && cat burst-${index}.txt`,
              { cwd: workspacePath, timeout: 30 }
            );
            expect(result.exitCode).toBe(0);
            expect(result.stdout.trim()).toBe(String(index));
          })
        );
        expect(results).toHaveLength(12);
      } finally {
        execSync(`rm -rf "${localProjectPath}"`);
        await execSSH(runtime, `rm -rf "${layout.projectRoot}"`);
      }
    }, 120000);
  });

  /**
   * Verify that syncProjectToRemote does NOT import stale refs/remotes/origin/*
   * from the local machine's bundle into the shared bare base repo.
   *
   * This is the root cause of the "1.5k commits behind" bug: the local machine's
   * tracking refs (e.g. refs/remotes/origin/main) are included in the bundle
   * and imported into the base repo, giving worktrees a wildly wrong behind count.
   */
  describe("SSHRuntime sync does not import stale remote tracking refs", () => {
    const srcBaseDir = "/home/testuser/workspace";
    const createSSHRuntime = (): SSHRuntime =>
      createTestRuntime("ssh", srcBaseDir, sshConfig) as SSHRuntime;

    const createCapturingInitLogger = (steps: string[]) => ({
      ...noopInitLogger,
      logStep(step: string) {
        steps.push(step);
      },
    });

    test("initWorkspace does not populate refs/remotes/origin in the base repo from the bundle", async () => {
      const runtime = createSSHRuntime();

      const projectName = `sync-no-remotes-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const tmpDir = await import("os").then((os) => os.tmpdir());
      const localProjectPath = `${tmpDir}/${projectName}`;
      const layout = buildRemoteProjectLayout(srcBaseDir, localProjectPath);
      const branchName = "test-ws";
      const workspacePath = getRemoteWorkspacePath(layout, branchName);
      const baseRepoPath = layout.baseRepoPath;

      const { execSync } = await import("child_process");
      try {
        // Create a local git repo with a stale refs/remotes/origin/main.
        // This simulates a developer's local project that hasn't fetched in a while.
        execSync(
          [
            `mkdir -p "${localProjectPath}"`,
            `cd "${localProjectPath}"`,
            `git init -b main`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "content" > file.txt`,
            `git add file.txt`,
            `git commit -m "initial"`,
            // Create a fake stale origin/main tracking ref.
            // In a real project this comes from `git fetch origin`.
            `git update-ref refs/remotes/origin/main HEAD`,
            `git update-ref refs/remotes/origin/stale-branch HEAD`,
          ].join(" && "),
          { stdio: "pipe" }
        );

        // Verify the local repo has remote tracking refs.
        const localRefs = execSync(`git -C "${localProjectPath}" for-each-ref refs/remotes/`, {
          encoding: "utf8",
        });
        expect(localRefs).toContain("refs/remotes/origin/main");
        expect(localRefs).toContain("refs/remotes/origin/stale-branch");

        try {
          // initWorkspace triggers syncProjectToRemote (since workspace doesn't exist yet),
          // which creates the base repo, bundles the local project, and imports refs.
          const initResult = await runtime.initWorkspace({
            projectPath: localProjectPath,
            branchName,
            trunkBranch: "main",
            workspacePath,
            initLogger: noopInitLogger,
          });
          // Show the error message if initWorkspace failed — don't just say true/false.
          if (!initResult.success) {
            throw new Error(`initWorkspace failed: ${initResult.error}`);
          }

          // The base repo should have bundle branches in refs/mux-bundle/* (staging
          // namespace) and NOT in refs/heads/* (which would collide with worktrees)
          // or refs/remotes/origin/* (stale local tracking refs).
          const baseRefs = await execSSH(
            runtime,
            `git -C "${baseRepoPath}" for-each-ref --format='%(refname)' refs/`
          );

          // Bundle branches should be in the staging namespace.
          expect(baseRefs.stdout).toContain("refs/mux-bundle/main");

          // Should NOT have stale remote tracking refs from the bundle.
          expect(baseRefs.stdout).not.toContain("refs/remotes/origin/main");
          expect(baseRefs.stdout).not.toContain("refs/remotes/origin/stale-branch");
        } finally {
          await execSSH(runtime, `rm -rf "${layout.projectRoot}"`);
        }
      } finally {
        execSync(`rm -rf "${localProjectPath}"`);
      }
    }, 120000);

    test("initWorkspace reuses snapshots and preserves remote-only tags across later resyncs", async () => {
      const runtime = createSSHRuntime();

      const projectName = `sync-remote-tags-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const tmpDir = await import("os").then((os) => os.tmpdir());
      const localProjectPath = `${tmpDir}/${projectName}`;
      const layout = buildRemoteProjectLayout(srcBaseDir, localProjectPath);
      const firstWorkspacePath = getRemoteWorkspacePath(layout, "tags-a");
      const secondWorkspacePath = getRemoteWorkspacePath(layout, "tags-b");
      const thirdWorkspacePath = getRemoteWorkspacePath(layout, "tags-c");
      const baseRepoPath = layout.baseRepoPath;

      const { execSync } = await import("child_process");
      try {
        execSync(
          [
            `mkdir -p "${localProjectPath}"`,
            `cd "${localProjectPath}"`,
            `git init -b main`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "version-a" > file.txt`,
            `git add file.txt`,
            `git commit -m "initial"`,
          ].join(" && "),
          { stdio: "pipe" }
        );

        const firstInit = await runtime.initWorkspace({
          projectPath: localProjectPath,
          branchName: "tags-a",
          trunkBranch: "main",
          workspacePath: firstWorkspacePath,
          initLogger: noopInitLogger,
        });
        if (!firstInit.success) {
          throw new Error(`first initWorkspace failed: ${firstInit.error}`);
        }

        const initialBaseHead = await execSSH(
          runtime,
          `git -C "${baseRepoPath}" rev-parse refs/mux-bundle/main`
        );
        const initialBaseHeadOid = initialBaseHead.stdout.trim();
        expect(initialBaseHead.exitCode).toBe(0);
        expect(initialBaseHeadOid).not.toBe("");

        const addRemoteOnlyTag = await execSSH(
          runtime,
          `git -C "${baseRepoPath}" update-ref refs/tags/remote-only ${initialBaseHeadOid}`
        );
        expect(addRemoteOnlyTag.exitCode).toBe(0);

        const reuseSteps: string[] = [];
        const secondInit = await runtime.initWorkspace({
          projectPath: localProjectPath,
          branchName: "tags-b",
          trunkBranch: "main",
          workspacePath: secondWorkspacePath,
          initLogger: createCapturingInitLogger(reuseSteps),
        });
        if (!secondInit.success) {
          throw new Error(`second initWorkspace failed: ${secondInit.error}`);
        }
        expect(reuseSteps).toContain("Reusing existing remote project snapshot");

        const remoteOnlyTagBeforeResync = await execSSH(
          runtime,
          `git -C "${baseRepoPath}" rev-parse refs/tags/remote-only`
        );
        expect(remoteOnlyTagBeforeResync.exitCode).toBe(0);
        expect(remoteOnlyTagBeforeResync.stdout.trim()).toBe(initialBaseHeadOid);

        execSync(
          [
            `cd "${localProjectPath}"`,
            `echo "version-b" > file.txt`,
            `git add file.txt`,
            `git commit -m "second"`,
          ].join(" && "),
          { stdio: "pipe" }
        );
        const secondCommit = execSync(`git -C "${localProjectPath}" rev-parse HEAD`, {
          encoding: "utf8",
        }).trim();

        const thirdInit = await runtime.initWorkspace({
          projectPath: localProjectPath,
          branchName: "tags-c",
          trunkBranch: "main",
          workspacePath: thirdWorkspacePath,
          initLogger: noopInitLogger,
        });
        if (!thirdInit.success) {
          throw new Error(`third initWorkspace failed: ${thirdInit.error}`);
        }

        const updatedBaseHead = await execSSH(
          runtime,
          `git -C "${baseRepoPath}" rev-parse refs/mux-bundle/main`
        );
        expect(updatedBaseHead.exitCode).toBe(0);
        expect(updatedBaseHead.stdout.trim()).toBe(secondCommit);

        const remoteOnlyTagAfterResync = await execSSH(
          runtime,
          `git -C "${baseRepoPath}" rev-parse refs/tags/remote-only`
        );
        expect(remoteOnlyTagAfterResync.exitCode).toBe(0);
        expect(remoteOnlyTagAfterResync.stdout.trim()).toBe(initialBaseHeadOid);
      } finally {
        execSync(`rm -rf "${localProjectPath}"`);
        await execSSH(runtime, `rm -rf "${layout.projectRoot}"`);
      }
    }, 120000);

    test("initWorkspace strips shared core.bare from pre-existing base repos before checkout", async () => {
      const runtime = createSSHRuntime();

      const projectName = `sync-heal-bare-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const tmpDir = await import("os").then((os) => os.tmpdir());
      const localProjectPath = `${tmpDir}/${projectName}`;
      const layout = buildRemoteProjectLayout(srcBaseDir, localProjectPath);
      const branchName = "worktree-heal";
      const workspacePath = getRemoteWorkspacePath(layout, branchName);
      const baseRepoPath = layout.baseRepoPath;

      const { execSync } = await import("child_process");
      try {
        execSync(
          [
            `mkdir -p "${localProjectPath}"`,
            `cd "${localProjectPath}"`,
            `git init -b main`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "content" > file.txt`,
            `git add file.txt`,
            `git commit -m "initial"`,
          ].join(" && "),
          { stdio: "pipe" }
        );

        await execSSH(
          runtime,
          `mkdir -p "${layout.projectRoot}" && git init --bare "${baseRepoPath}"`
        );

        const beforeCheck = await execSSH(
          runtime,
          `git -C "${baseRepoPath}" config --get core.bare`
        );
        expect(beforeCheck.stdout.trim()).toBe("true");

        const initResult = await runtime.initWorkspace({
          projectPath: localProjectPath,
          branchName,
          trunkBranch: "main",
          workspacePath,
          initLogger: noopInitLogger,
        });
        if (!initResult.success) {
          throw new Error(`initWorkspace failed: ${initResult.error}`);
        }

        const baseRepoCoreBareCheck = await execSSH(
          runtime,
          `git -C "${baseRepoPath}" config --get core.bare`
        );
        expect(baseRepoCoreBareCheck.exitCode).toBe(1);

        const insideWorkTreeCheck = await execSSH(
          runtime,
          `git -C "${workspacePath}" rev-parse --is-inside-work-tree`
        );
        expect(insideWorkTreeCheck.stdout.trim()).toBe("true");

        const workspaceCoreBareCheck = await execSSH(
          runtime,
          `git -C "${workspacePath}" config --get core.bare`
        );
        expect(workspaceCoreBareCheck.exitCode).toBe(1);
      } finally {
        execSync(`rm -rf "${localProjectPath}"`);
        await execSSH(runtime, `rm -rf "${layout.projectRoot}"`);
      }
    }, 120000);

    test("initWorkspace strips shared core.worktree from pre-existing base repos before checkout", async () => {
      const runtime = createSSHRuntime();

      const projectName = `sync-heal-worktree-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const tmpDir = await import("os").then((os) => os.tmpdir());
      const localProjectPath = `${tmpDir}/${projectName}`;
      const layout = buildRemoteProjectLayout(srcBaseDir, localProjectPath);
      const branchName = "worktree-heal";
      const workspacePath = getRemoteWorkspacePath(layout, branchName);
      const baseRepoPath = layout.baseRepoPath;
      const bogusWorktreePath = `${layout.projectRoot}/.bogus-worktree`;

      const { execSync } = await import("child_process");
      try {
        execSync(
          [
            `mkdir -p "${localProjectPath}"`,
            `cd "${localProjectPath}"`,
            `git init -b main`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "content" > file.txt`,
            `git add file.txt`,
            `git commit -m "initial"`,
          ].join(" && "),
          { stdio: "pipe" }
        );

        await execSSH(
          runtime,
          [
            `mkdir -p "${layout.projectRoot}"`,
            `git init --bare "${baseRepoPath}"`,
            `git --git-dir="${baseRepoPath}" config --local core.worktree "${bogusWorktreePath}"`,
          ].join(" && ")
        );

        const beforeCheck = await execSSH(
          runtime,
          `git --git-dir="${baseRepoPath}" config --get core.worktree`
        );
        expect(beforeCheck.stdout.trim()).toBe(bogusWorktreePath);

        const initResult = await runtime.initWorkspace({
          projectPath: localProjectPath,
          branchName,
          trunkBranch: "main",
          workspacePath,
          initLogger: noopInitLogger,
        });
        if (!initResult.success) {
          throw new Error(`initWorkspace failed: ${initResult.error}`);
        }

        const baseRepoCoreWorktreeCheck = await execSSH(
          runtime,
          `git --git-dir="${baseRepoPath}" config --get core.worktree`
        );
        expect(baseRepoCoreWorktreeCheck.exitCode).toBe(1);

        const insideWorkTreeCheck = await execSSH(
          runtime,
          `git -C "${workspacePath}" rev-parse --is-inside-work-tree`
        );
        expect(insideWorkTreeCheck.stdout.trim()).toBe("true");

        const workspaceTopLevelCheck = await execSSH(
          runtime,
          `git -C "${workspacePath}" rev-parse --show-toplevel`
        );
        expect(workspaceTopLevelCheck.stdout.trim()).toBe(workspacePath);
      } finally {
        execSync(`rm -rf "${localProjectPath}"`);
        await execSSH(runtime, `rm -rf "${layout.projectRoot}"`);
      }
    }, 120000);

    test("initWorkspace keeps base-repo HEAD detached from user branches", async () => {
      const runtime = createSSHRuntime();

      const projectName = `sync-neutral-head-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const tmpDir = await import("os").then((os) => os.tmpdir());
      const localProjectPath = `${tmpDir}/${projectName}`;
      const layout = buildRemoteProjectLayout(srcBaseDir, localProjectPath);
      const branchName = "neutral-head";
      const workspacePath = getRemoteWorkspacePath(layout, branchName);
      const baseRepoPath = layout.baseRepoPath;

      const { execSync } = await import("child_process");
      try {
        execSync(
          [
            `mkdir -p "${localProjectPath}"`,
            `cd "${localProjectPath}"`,
            `git init -b main`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "content" > file.txt`,
            `git add file.txt`,
            `git commit -m "initial"`,
          ].join(" && "),
          { stdio: "pipe" }
        );

        const initResult = await runtime.initWorkspace({
          projectPath: localProjectPath,
          branchName,
          trunkBranch: "main",
          workspacePath,
          initLogger: noopInitLogger,
        });
        if (!initResult.success) {
          throw new Error(`initWorkspace failed: ${initResult.error}`);
        }

        const baseHeadSymbolicCheck = await execSSH(
          runtime,
          `git --git-dir="${baseRepoPath}" symbolic-ref -q HEAD`
        );
        expect(baseHeadSymbolicCheck.exitCode).toBe(1);

        const baseHeadCommit = await execSSH(
          runtime,
          `git --git-dir="${baseRepoPath}" rev-parse --verify HEAD`
        );
        const workspaceCommit = await execSSH(runtime, `git -C "${workspacePath}" rev-parse HEAD`);
        expect(baseHeadCommit.stdout.trim()).toBe(workspaceCommit.stdout.trim());

        const baseRepoBareCheck = await execSSH(
          runtime,
          `git -C "${baseRepoPath}" rev-parse --is-bare-repository`
        );
        expect(baseRepoBareCheck.stdout.trim()).toBe("true");

        const baseWorktreeEntry = await execSSH(
          runtime,
          `git -C "${baseRepoPath}" worktree list --porcelain | sed -n '1,/^$/p'`
        );
        expect(baseWorktreeEntry.stdout).toContain(`worktree ${baseRepoPath}`);
        expect(baseWorktreeEntry.stdout).toContain("bare");
        expect(baseWorktreeEntry.stdout).not.toContain("branch ");
      } finally {
        execSync(`rm -rf "${localProjectPath}"`);
        await execSSH(runtime, `rm -rf "${layout.projectRoot}"`);
      }
    }, 120000);

    test("warm fast-path heals poisoned base repo before materializing workspace", async () => {
      const runtime = createSSHRuntime();

      const projectName = `sync-warm-heal-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const tmpDir = await import("os").then((os) => os.tmpdir());
      const localProjectPath = `${tmpDir}/${projectName}`;
      const layout = buildRemoteProjectLayout(srcBaseDir, localProjectPath);
      const firstWorkspacePath = getRemoteWorkspacePath(layout, "warm-heal-a");
      const secondWorkspacePath = getRemoteWorkspacePath(layout, "warm-heal-b");
      const baseRepoPath = layout.baseRepoPath;
      const bogusWorktreePath = `${layout.projectRoot}/.mux-base-worktree`;

      const { execSync } = await import("child_process");
      try {
        execSync(
          [
            `mkdir -p "${localProjectPath}"`,
            `cd "${localProjectPath}"`,
            `git init -b main`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "content" > file.txt`,
            `git add file.txt`,
            `git commit -m "initial"`,
          ].join(" && "),
          { stdio: "pipe" }
        );

        const firstInit = await runtime.initWorkspace({
          projectPath: localProjectPath,
          branchName: "warm-heal-a",
          trunkBranch: "main",
          workspacePath: firstWorkspacePath,
          initLogger: noopInitLogger,
        });
        if (!firstInit.success) {
          throw new Error(`first initWorkspace failed: ${firstInit.error}`);
        }

        const poisonResult = await execSSH(
          runtime,
          [
            `git --git-dir="${baseRepoPath}" config --local core.bare true`,
            `git --git-dir="${baseRepoPath}" config --local core.worktree "${bogusWorktreePath}"`,
            `git --git-dir="${baseRepoPath}" symbolic-ref HEAD refs/heads/main`,
            // Simulate what a background `git fetch --filter=blob:none` from a
            // sibling worktree registers in the shared gitdir. A promisor base
            // repo lazy-fetches missing blobs over the network mid-checkout, so
            // the warm path must strip these before `git worktree add`.
            `git --git-dir="${baseRepoPath}" config --local remote.origin.promisor true`,
            `git --git-dir="${baseRepoPath}" config --local remote.origin.partialclonefilter blob:none`,
          ].join(" && ")
        );
        expect(poisonResult.exitCode).toBe(0);

        const reuseSteps: string[] = [];
        const secondInit = await runtime.initWorkspace({
          projectPath: localProjectPath,
          branchName: "warm-heal-b",
          trunkBranch: "main",
          workspacePath: secondWorkspacePath,
          initLogger: createCapturingInitLogger(reuseSteps),
        });
        if (!secondInit.success) {
          throw new Error(`second initWorkspace failed: ${secondInit.error}`);
        }
        expect(
          reuseSteps.some((step) => step.includes("Materialized workspace via warm fast-path"))
        ).toBe(true);

        const insideWorkTreeCheck = await execSSH(
          runtime,
          `git -C "${secondWorkspacePath}" rev-parse --is-inside-work-tree`
        );
        expect(insideWorkTreeCheck.stdout.trim()).toBe("true");

        const baseRepoCoreBareCheck = await execSSH(
          runtime,
          `git --git-dir="${baseRepoPath}" config --get core.bare`
        );
        expect(baseRepoCoreBareCheck.exitCode).toBe(1);

        const baseRepoCoreWorktreeCheck = await execSSH(
          runtime,
          `git --git-dir="${baseRepoPath}" config --get core.worktree`
        );
        expect(baseRepoCoreWorktreeCheck.exitCode).toBe(1);

        // Promisor/partial-clone registration must be stripped so worktree
        // materialization never lazy-fetches blobs over the network.
        const baseRepoPromisorCheck = await execSSH(
          runtime,
          `git --git-dir="${baseRepoPath}" config --get remote.origin.promisor`
        );
        expect(baseRepoPromisorCheck.exitCode).toBe(1);

        const baseRepoFilterCheck = await execSSH(
          runtime,
          `git --git-dir="${baseRepoPath}" config --get remote.origin.partialclonefilter`
        );
        expect(baseRepoFilterCheck.exitCode).toBe(1);

        const baseHeadSymbolicCheck = await execSSH(
          runtime,
          `git --git-dir="${baseRepoPath}" symbolic-ref -q HEAD`
        );
        expect(baseHeadSymbolicCheck.exitCode).toBe(1);

        const baseHeadCommit = await execSSH(
          runtime,
          `git --git-dir="${baseRepoPath}" rev-parse --verify HEAD`
        );
        const secondWorkspaceCommit = await execSSH(
          runtime,
          `git -C "${secondWorkspacePath}" rev-parse HEAD`
        );
        expect(baseHeadCommit.stdout.trim()).toBe(secondWorkspaceCommit.stdout.trim());
      } finally {
        execSync(`rm -rf "${localProjectPath}"`);
        await execSSH(runtime, `rm -rf "${layout.projectRoot}"`);
      }
    }, 120000);

    test("initWorkspace repairs a reusable snapshot whose base repo is missing objects", async () => {
      const runtime = createSSHRuntime();

      const projectName = `sync-heal-missing-objects-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const tmpDir = await import("os").then((os) => os.tmpdir());
      const localProjectPath = `${tmpDir}/${projectName}`;
      const layout = buildRemoteProjectLayout(srcBaseDir, localProjectPath);
      const firstWorkspacePath = getRemoteWorkspacePath(layout, "missing-objects-a");
      const secondWorkspacePath = getRemoteWorkspacePath(layout, "missing-objects-b");
      const baseRepoPath = layout.baseRepoPath;
      const repairSteps: string[] = [];
      const repairLogger = {
        ...noopInitLogger,
        logStep(step: string) {
          repairSteps.push(step);
        },
      };

      const { execSync } = await import("child_process");
      try {
        execSync(
          [
            `mkdir -p "${localProjectPath}"`,
            `cd "${localProjectPath}"`,
            `git init -b main`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "content" > file.txt`,
            `git add file.txt`,
            `git commit -m "initial"`,
          ].join(" && "),
          { stdio: "pipe" }
        );

        const firstInit = await runtime.initWorkspace({
          projectPath: localProjectPath,
          branchName: "missing-objects-a",
          trunkBranch: "main",
          workspacePath: firstWorkspacePath,
          initLogger: noopInitLogger,
        });
        if (!firstInit.success) {
          throw new Error(`first initWorkspace failed: ${firstInit.error}`);
        }

        // Simulate a stale/corrupt managed cache left behind by older SSH path
        // layouts or partial-clone state: refs and the snapshot marker still say
        // the remote snapshot is reusable, but the object database cannot
        // materialize a worktree. Init must repair additively rather than
        // deleting the base repo, because sibling worktrees share this gitdir.
        await execSSH(runtime, `find "${baseRepoPath}/objects" -type f -delete`);

        const secondInit = await runtime.initWorkspace({
          projectPath: localProjectPath,
          branchName: "missing-objects-b",
          trunkBranch: "main",
          workspacePath: secondWorkspacePath,
          initLogger: repairLogger,
        });
        if (!secondInit.success) {
          throw new Error(`second initWorkspace failed: ${secondInit.error}`);
        }

        expect(repairSteps).toContain(
          "Remote snapshot is missing objects; repairing shared base repository..."
        );
        const fileCheck = await execSSH(runtime, `cat "${secondWorkspacePath}/file.txt"`);
        expect(fileCheck.stdout.trim()).toBe("content");
      } finally {
        execSync(`rm -rf "${localProjectPath}"`);
        await execSSH(runtime, `rm -rf "${layout.projectRoot}"`);
      }
    }, 120000);

    test("initWorkspace reimports when the snapshot marker outlives the base repo", async () => {
      const runtime = createSSHRuntime();

      const projectName = `sync-heal-marker-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const tmpDir = await import("os").then((os) => os.tmpdir());
      const localProjectPath = `${tmpDir}/${projectName}`;
      const layout = buildRemoteProjectLayout(srcBaseDir, localProjectPath);
      const firstWorkspaceName = "marker-a";
      const secondWorkspaceName = "marker-b";
      const firstWorkspacePath = getRemoteWorkspacePath(layout, firstWorkspaceName);
      const secondWorkspacePath = getRemoteWorkspacePath(layout, secondWorkspaceName);
      const baseRepoPath = layout.baseRepoPath;

      const { execSync } = await import("child_process");
      try {
        execSync(
          [
            `mkdir -p "${localProjectPath}"`,
            `cd "${localProjectPath}"`,
            `git init -b main`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "content" > file.txt`,
            `git add file.txt`,
            `git commit -m "initial"`,
          ].join(" && "),
          { stdio: "pipe" }
        );

        const firstInit = await runtime.initWorkspace({
          projectPath: localProjectPath,
          branchName: firstWorkspaceName,
          trunkBranch: "main",
          workspacePath: firstWorkspacePath,
          initLogger: noopInitLogger,
        });
        if (!firstInit.success) {
          throw new Error(`first initWorkspace failed: ${firstInit.error}`);
        }

        const snapshotMarkerCheck = await execSSH(
          runtime,
          `test -f "${layout.currentSnapshotPath}" && cat "${layout.currentSnapshotPath}"`
        );
        expect(snapshotMarkerCheck.stdout.trim()).not.toBe("");

        await execSSH(runtime, `rm -rf "${baseRepoPath}" && git init --bare "${baseRepoPath}"`);

        const secondInit = await runtime.initWorkspace({
          projectPath: localProjectPath,
          branchName: secondWorkspaceName,
          trunkBranch: "main",
          workspacePath: secondWorkspacePath,
          initLogger: noopInitLogger,
        });
        if (!secondInit.success) {
          throw new Error(`second initWorkspace failed: ${secondInit.error}`);
        }

        const baseRefs = await execSSH(
          runtime,
          `git -C "${baseRepoPath}" for-each-ref --format='%(refname)' refs/mux-bundle/`
        );
        expect(baseRefs.stdout).toContain("refs/mux-bundle/main");

        const insideWorkTreeCheck = await execSSH(
          runtime,
          `git -C "${secondWorkspacePath}" rev-parse --is-inside-work-tree`
        );
        expect(insideWorkTreeCheck.stdout.trim()).toBe("true");
      } finally {
        execSync(`rm -rf "${localProjectPath}"`);
        await execSSH(runtime, `rm -rf "${layout.projectRoot}"`);
      }
    }, 120000);

    test("initWorkspace reimports when an older snapshot marker exists but bundle refs were advanced", async () => {
      const runtime = createSSHRuntime();

      const projectName = `sync-heal-history-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const tmpDir = await import("os").then((os) => os.tmpdir());
      const localProjectPath = `${tmpDir}/${projectName}`;
      const layout = buildRemoteProjectLayout(srcBaseDir, localProjectPath);
      const firstWorkspacePath = getRemoteWorkspacePath(layout, "history-a");
      const secondWorkspacePath = getRemoteWorkspacePath(layout, "history-b");
      const thirdWorkspacePath = getRemoteWorkspacePath(layout, "history-c");
      const baseRepoPath = layout.baseRepoPath;

      const { execSync } = await import("child_process");
      try {
        execSync(
          [
            `mkdir -p "${localProjectPath}"`,
            `cd "${localProjectPath}"`,
            `git init -b main`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "version-a" > file.txt`,
            `git add file.txt`,
            `git commit -m "initial"`,
          ].join(" && "),
          { stdio: "pipe" }
        );
        const firstCommit = execSync(`git -C "${localProjectPath}" rev-parse HEAD`, {
          encoding: "utf8",
        }).trim();

        const firstInit = await runtime.initWorkspace({
          projectPath: localProjectPath,
          branchName: "history-a",
          trunkBranch: "main",
          workspacePath: firstWorkspacePath,
          initLogger: noopInitLogger,
        });
        if (!firstInit.success) {
          throw new Error(`first initWorkspace failed: ${firstInit.error}`);
        }

        execSync(
          [
            `cd "${localProjectPath}"`,
            `echo "version-b" > file.txt`,
            `git add file.txt`,
            `git commit -m "second"`,
          ].join(" && "),
          { stdio: "pipe" }
        );

        const secondInit = await runtime.initWorkspace({
          projectPath: localProjectPath,
          branchName: "history-b",
          trunkBranch: "main",
          workspacePath: secondWorkspacePath,
          initLogger: noopInitLogger,
        });
        if (!secondInit.success) {
          throw new Error(`second initWorkspace failed: ${secondInit.error}`);
        }

        execSync(`git -C "${localProjectPath}" reset --hard ${firstCommit}`, {
          stdio: "pipe",
        });

        const thirdInit = await runtime.initWorkspace({
          projectPath: localProjectPath,
          branchName: "history-c",
          trunkBranch: "main",
          workspacePath: thirdWorkspacePath,
          initLogger: noopInitLogger,
        });
        if (!thirdInit.success) {
          throw new Error(`third initWorkspace failed: ${thirdInit.error}`);
        }

        const fileCheck = await execSSH(runtime, `cat "${thirdWorkspacePath}/file.txt"`);
        expect(fileCheck.stdout.trim()).toBe("version-a");

        const baseHead = await execSSH(
          runtime,
          `git -C "${baseRepoPath}" rev-parse refs/mux-bundle/main`
        );
        expect(baseHead.stdout.trim()).toBe(firstCommit);
      } finally {
        execSync(`rm -rf "${localProjectPath}"`);
        await execSSH(runtime, `rm -rf "${layout.projectRoot}"`);
      }
    }, 120000);
  });

  /**
   * Regression test: creating a second workspace must not fail when the
   * bundle contains a branch that's already checked out in a worktree.
   *
   * Before the refs/mux-bundle/* staging namespace fix, syncing the bundle
   * on the second initWorkspace would fail with:
   *   "refusing to fetch into branch 'refs/heads/ws-a' checked out at '...'"
   */
  describe("SSHRuntime sync does not collide with checked-out worktree branches", () => {
    const srcBaseDir = "/home/testuser/workspace";
    const createSSHRuntime = (): SSHRuntime =>
      createTestRuntime("ssh", srcBaseDir, sshConfig) as SSHRuntime;

    test("second initWorkspace succeeds when first worktree's branch exists in bundle", async () => {
      const runtime = createSSHRuntime();
      const projectName = `sync-collision-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const tmpDir = await import("os").then((os) => os.tmpdir());
      const localProjectPath = `${tmpDir}/${projectName}`;
      const wsAName = "ws-a";
      const wsBName = "ws-b";
      const layout = buildRemoteProjectLayout(srcBaseDir, localProjectPath);
      const wsAPath = getRemoteWorkspacePath(layout, wsAName);
      const wsBPath = getRemoteWorkspacePath(layout, wsBName);
      const baseRepoPath = layout.baseRepoPath;

      const { execSync } = await import("child_process");

      try {
        // Create a local git repo with two branches — simulates a project
        // where the user already has both workspace branches locally.
        execSync(
          [
            `mkdir -p "${localProjectPath}"`,
            `cd "${localProjectPath}"`,
            `git init -b main`,
            `git config user.email "test@test.com"`,
            `git config user.name "Test"`,
            `echo "content" > file.txt`,
            `git add file.txt`,
            `git commit -m "initial"`,
            `git branch ${wsAName}`,
            `git branch ${wsBName}`,
          ].join(" && "),
          { stdio: "pipe" }
        );

        const expectHealthyWorktree = async (workspacePath: string, branchName: string) => {
          const checkoutCheck = await execSSH(
            runtime,
            `test -f "${workspacePath}/.git" && git -C "${workspacePath}" branch --show-current`
          );
          expect(checkoutCheck.stdout.trim()).toBe(branchName);

          const insideWorkTreeCheck = await execSSH(
            runtime,
            `git -C "${workspacePath}" rev-parse --is-inside-work-tree`
          );
          expect(insideWorkTreeCheck.stdout.trim()).toBe("true");

          const statusCheck = await execSSH(
            runtime,
            `git -C "${workspacePath}" status --porcelain`
          );
          expect(statusCheck.exitCode).toBe(0);

          const coreBareCheck = await execSSH(
            runtime,
            `git -C "${workspacePath}" config --get core.bare`
          );
          expect(coreBareCheck.exitCode).toBe(1);
        };

        // 1. Init workspace A — creates the base repo, syncs bundle, creates worktree.
        const initA = await runtime.initWorkspace({
          projectPath: localProjectPath,
          branchName: wsAName,
          trunkBranch: "main",
          workspacePath: wsAPath,
          initLogger: noopInitLogger,
        });
        if (!initA.success) {
          throw new Error(`initWorkspace A failed: ${initA.error}`);
        }
        await expectHealthyWorktree(wsAPath, wsAName);

        const baseRepoBareCheck = await execSSH(
          runtime,
          `git -C "${baseRepoPath}" rev-parse --is-bare-repository`
        );
        expect(baseRepoBareCheck.stdout.trim()).toBe("true");

        const baseRepoCoreBareConfigCheck = await execSSH(
          runtime,
          `git -C "${baseRepoPath}" config --get core.bare`
        );
        expect(baseRepoCoreBareConfigCheck.exitCode).toBe(1);

        // 2. Init workspace B — re-syncs the bundle (which includes refs/heads/ws-a).
        //    Before the staging namespace fix, this failed with:
        //    "refusing to fetch into branch 'refs/heads/ws-a' checked out at '<wsAPath>'"
        const initB = await runtime.initWorkspace({
          projectPath: localProjectPath,
          branchName: wsBName,
          trunkBranch: "main",
          workspacePath: wsBPath,
          initLogger: noopInitLogger,
        });
        if (!initB.success) {
          throw new Error(`initWorkspace B failed: ${initB.error}`);
        }
        await expectHealthyWorktree(wsBPath, wsBName);

        // Both worktrees should be tracked in the base repo.
        const worktreeList = await execSSH(runtime, `git -C "${baseRepoPath}" worktree list`);
        expect(worktreeList.stdout).toContain(wsAName);
        expect(worktreeList.stdout).toContain(wsBName);
      } finally {
        execSync(`rm -rf "${localProjectPath}"`);
        await execSSH(runtime, `rm -rf "${layout.projectRoot}"`);
      }
    }, 120000);
  });

  /**
   * DockerRuntime-specific workspace operation tests
   *
   * Tests container lifecycle: create, delete, idempotent delete
   */
  describe("DockerRuntime workspace operations", () => {
    const testForDocker = shouldRunIntegrationTests() ? test : test.skip;

    // Helper to run docker commands on host
    const dockerCommand = async (cmd: string): Promise<{ stdout: string; exitCode: number }> => {
      const { spawn } = await import("child_process");
      return new Promise((resolve) => {
        const proc = spawn("bash", ["-c", cmd]);
        let stdout = "";
        proc.stdout.on("data", (data) => (stdout += data.toString()));
        proc.on("close", (code) => resolve({ stdout, exitCode: code ?? 0 }));
      });
    };

    describe("createWorkspace + deleteWorkspace", () => {
      testForDocker(
        "creates container and deletes it",
        async () => {
          const { DockerRuntime, getContainerName } = await import("@/node/runtime/DockerRuntime");
          const projectName = `docker-lifecycle-${Date.now()}-${Math.random().toString(36).substring(7)}`;
          const workspaceName = "test-ws";
          const projectPath = `/tmp/${projectName}`;
          const containerName = getContainerName(projectPath, workspaceName);

          // initWorkspace requires a git repo to bundle - create a minimal one with "main" branch
          await dockerCommand(`mkdir -p ${projectPath}`);
          await dockerCommand(
            `cd ${projectPath} && git init -b main && git config user.email "test@test.com" && git config user.name "Test" && echo "test" > README.md && git add . && git commit -m "init"`
          );

          const runtime = new DockerRuntime({ image: "mux-ssh-test" });

          try {
            // Create workspace
            const createResult = await runtime.createWorkspace({
              projectPath,
              branchName: workspaceName,
              trunkBranch: "main",
              directoryName: workspaceName,
              initLogger: noopInitLogger,
            });

            expect(createResult.success).toBe(true);
            if (!createResult.success) return;

            // createWorkspace only stores container name; runFullInit (postCreateSetup + initWorkspace) creates it
            const initResult = await runFullInit(runtime, {
              projectPath,
              branchName: workspaceName,
              trunkBranch: "main",
              workspacePath: createResult.workspacePath!,
              initLogger: noopInitLogger,
            });
            expect(initResult.success).toBe(true);
            if (!initResult.success) return;

            // Verify container exists and is running
            const inspectResult = await dockerCommand(
              `docker inspect ${containerName} --format='{{.State.Running}}'`
            );
            expect(inspectResult.exitCode).toBe(0);
            expect(inspectResult.stdout.trim()).toBe("true");

            // Delete workspace
            const deleteResult = await runtime.deleteWorkspace(projectPath, workspaceName, true);
            expect(deleteResult.success).toBe(true);

            // Verify container no longer exists
            const afterInspect = await dockerCommand(`docker inspect ${containerName} 2>&1`);
            expect(afterInspect.exitCode).not.toBe(0);
          } finally {
            // Clean up temp git repo and any leftover container
            await dockerCommand(`rm -rf ${projectPath}`);
            await dockerCommand(`docker rm -f ${containerName} 2>/dev/null || true`);
          }
        },
        60000
      );
    });

    describe("deleteWorkspace", () => {
      testForDocker("returns success for non-existent container (idempotent)", async () => {
        const { DockerRuntime } = await import("@/node/runtime/DockerRuntime");
        const projectName = `docker-nonexist-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const projectPath = `/tmp/${projectName}`;

        const runtime = new DockerRuntime({ image: "ubuntu:22.04" });

        // Try to delete a workspace that doesn't exist
        const result = await runtime.deleteWorkspace(projectPath, "non-existent", false);

        // Should be idempotent - return success for non-existent containers
        expect(result.success).toBe(true);
      });
    });

    describe("forkWorkspace", () => {
      testForDocker(
        "forks into a valid container workspace and supports runFullInit on the fork",
        async () => {
          const { DockerRuntime, getContainerName } = await import("@/node/runtime/DockerRuntime");
          const projectName = `docker-fork-${Date.now()}-${Math.random().toString(36).substring(7)}`;
          const projectPath = `/tmp/${projectName}`;
          const sourceWorkspaceName = "source";
          const newWorkspaceName = "forked";
          const sourceContainerName = getContainerName(projectPath, sourceWorkspaceName);
          const forkContainerName = getContainerName(projectPath, newWorkspaceName);

          const runtime = new DockerRuntime({ image: "mux-ssh-test" });

          await dockerCommand(`mkdir -p ${projectPath}`);

          try {
            // Create a running source workspace container with a feature branch checked out.
            await dockerCommand(
              `docker run -d --name ${sourceContainerName} mux-ssh-test sleep infinity`
            );
            await dockerCommand(`docker exec ${sourceContainerName} mkdir -p /src`);
            await dockerCommand(
              `docker exec ${sourceContainerName} bash -c "cd /src && git init -b ${sourceWorkspaceName} && git config user.email test@test.com && git config user.name Test && echo root > root.txt && git add root.txt && git commit -m root && git checkout -b feature && echo feature > feature.txt && git add feature.txt && git commit -m feature"`
            );

            const forkResult = await runtime.forkWorkspace({
              projectPath,
              sourceWorkspaceName,
              newWorkspaceName,
              initLogger: noopInitLogger,
            });

            expect(forkResult.success).toBe(true);
            if (!forkResult.success) return;

            expect(forkResult.workspacePath).toBe("/src");
            expect(forkResult.sourceBranch).toBe("feature");

            if (!forkResult.workspacePath || !forkResult.sourceBranch) {
              throw new Error(
                "Expected successful Docker fork to include workspacePath and sourceBranch"
              );
            }

            expect(runtime.getContainerName()).toBe(forkContainerName);

            const runningCheck = await dockerCommand(
              `docker inspect ${forkContainerName} --format='{{.State.Running}}'`
            );
            expect(runningCheck.exitCode).toBe(0);
            expect(runningCheck.stdout.trim()).toBe("true");

            const gitDirCheck = await dockerCommand(
              `docker exec ${forkContainerName} test -d /src/.git && echo ok`
            );
            expect(gitDirCheck.exitCode).toBe(0);

            const branchCheck = await dockerCommand(
              `docker exec ${forkContainerName} git -C /src rev-parse --abbrev-ref HEAD`
            );
            expect(branchCheck.exitCode).toBe(0);
            expect(branchCheck.stdout.trim()).toBe(newWorkspaceName);

            const featureFileCheck = await dockerCommand(
              `docker exec ${forkContainerName} test -f /src/feature.txt && echo ok`
            );
            expect(featureFileCheck.exitCode).toBe(0);

            const initResult = await runFullInit(runtime, {
              projectPath,
              branchName: newWorkspaceName,
              trunkBranch: forkResult.sourceBranch,
              workspacePath: forkResult.workspacePath,
              initLogger: noopInitLogger,
            });
            expect(initResult.success).toBe(true);
          } finally {
            await dockerCommand(`rm -rf ${projectPath}`);
            await dockerCommand(`docker rm -f ${sourceContainerName} 2>/dev/null || true`);
            await dockerCommand(`docker rm -f ${forkContainerName} 2>/dev/null || true`);
          }
        },
        60000
      );
    });

    describe("initWorkspace skips setup for running containers (fork scenario)", () => {
      testForDocker(
        "skips container creation when container is already running",
        async () => {
          const { DockerRuntime, getContainerName } = await import("@/node/runtime/DockerRuntime");
          const projectName = `docker-skip-${Date.now()}-${Math.random().toString(36).substring(7)}`;
          const workspaceName = "test-skip-ws";
          const projectPath = `/tmp/${projectName}`;
          const containerName = getContainerName(projectPath, workspaceName);

          // Create a minimal git repo for the project
          await dockerCommand(`mkdir -p ${projectPath}`);
          await dockerCommand(
            `cd ${projectPath} && git init -b main && git config user.email "test@test.com" && git config user.name "Test" && echo "test" > README.md && git add . && git commit -m "init"`
          );

          // Instantiate runtime with containerName directly (simulates existing forked workspace)
          const runtime = new DockerRuntime({ image: "mux-ssh-test", containerName });
          const loggedSteps: string[] = [];
          const initLogger = {
            logStep: (msg: string) => loggedSteps.push(msg),
            logStdout: () => {},
            logStderr: () => {},
            logComplete: () => {},
          };

          try {
            // Pre-create a running container (simulating successful fork)
            await dockerCommand(
              `docker run -d --name ${containerName} mux-ssh-test sleep infinity`
            );
            // Also create /src with the git repo inside, on the correct branch
            await dockerCommand(`docker exec ${containerName} mkdir -p /src`);
            await dockerCommand(
              `docker exec ${containerName} bash -c "cd /src && git init -b ${workspaceName} && git config user.email test@test.com && git config user.name Test && echo test > README.md && git add . && git commit -m init"`
            );

            // Call runFullInit - postCreateSetup should detect running container and skip setup
            const initResult = await runFullInit(runtime, {
              projectPath,
              branchName: workspaceName,
              trunkBranch: "main",
              workspacePath: "/src",
              initLogger,
            });

            expect(initResult.success).toBe(true);
            // Should log the skip message, not "Creating container from..."
            expect(loggedSteps).toContain(
              "Container already running (from fork), running init hook..."
            );
            expect(loggedSteps).not.toContain(expect.stringContaining("Creating container from"));
          } finally {
            await dockerCommand(`rm -rf ${projectPath}`);
            await dockerCommand(`docker rm -f ${containerName} 2>/dev/null || true`);
          }
        },
        60000
      );

      testForDocker(
        "does not delete forked container when init hook fails",
        async () => {
          const { DockerRuntime, getContainerName } = await import("@/node/runtime/DockerRuntime");
          const projectName = `docker-nodel-${Date.now()}-${Math.random().toString(36).substring(7)}`;
          const workspaceName = "test-nodel-ws";
          const projectPath = `/tmp/${projectName}`;
          const containerName = getContainerName(projectPath, workspaceName);

          // Create a minimal git repo with a FAILING init hook
          await dockerCommand(`mkdir -p ${projectPath}/.mux`);
          await dockerCommand(
            `cd ${projectPath} && git init -b main && git config user.email "test@test.com" && git config user.name "Test" && echo "test" > README.md`
          );
          await dockerCommand(`echo '#!/bin/bash\nexit 1' > ${projectPath}/.mux/init`);
          await dockerCommand(`chmod +x ${projectPath}/.mux/init`);
          await dockerCommand(
            `cd ${projectPath} && git add . && git commit -m "init with failing hook"`
          );

          // Instantiate runtime with containerName directly (simulates existing forked workspace)
          const runtime = new DockerRuntime({ image: "mux-ssh-test", containerName });

          try {
            // Pre-create a running container (simulating successful fork)
            await dockerCommand(
              `docker run -d --name ${containerName} mux-ssh-test sleep infinity`
            );
            // Create git repo with the failing init hook inside container
            await dockerCommand(`docker exec ${containerName} mkdir -p /src/.mux`);
            await dockerCommand(
              `docker exec ${containerName} bash -c "cd /src && git init -b ${workspaceName} && git config user.email test@test.com && git config user.name Test && echo test > README.md"`
            );
            await dockerCommand(
              `docker exec ${containerName} bash -c "echo '#!/bin/bash\nexit 1' > /src/.mux/init && chmod +x /src/.mux/init"`
            );
            await dockerCommand(
              `docker exec ${containerName} bash -c "cd /src && git add . && git commit -m init"`
            );

            // Call runFullInit - init hook will fail but init should still succeed
            // (hook failures are non-fatal per docs/hooks/init.mdx)
            const initResult = await runFullInit(runtime, {
              projectPath,
              branchName: workspaceName,
              trunkBranch: "main",
              workspacePath: "/src",
              initLogger: noopInitLogger,
            });

            // Init should succeed even though hook failed (non-fatal)
            expect(initResult.success).toBe(true);

            // Container should still exist
            const inspectResult = await dockerCommand(
              `docker inspect ${containerName} --format='{{.State.Running}}'`
            );
            expect(inspectResult.exitCode).toBe(0);
            expect(inspectResult.stdout.trim()).toBe("true");
          } finally {
            await dockerCommand(`rm -rf ${projectPath}`);
            await dockerCommand(`docker rm -f ${containerName} 2>/dev/null || true`);
          }
        },
        60000
      );
    });
  });

  /**
   * CoderSSHRuntime-specific tests
   *
   * Tests Coder-specific behavior like fork config updates.
   * Uses the same SSH fixture since CoderSSHRuntime extends SSHRuntime.
   */
  describe("CoderSSHRuntime workspace operations", () => {
    const srcBaseDir = "/home/testuser/src";
    const getLayout = (projectPath: string) => buildRemoteProjectLayout(srcBaseDir, projectPath);

    // Create a CoderSSHRuntime with mock CoderService
    const createCoderSSHRuntime = async () => {
      const { CoderSSHRuntime } = await import("@/node/runtime/CoderSSHRuntime");
      const { CoderService } = await import("@/node/services/coderService");

      // Mock CoderService with methods that CoderSSHRuntime may call
      const mockCoderService = {
        getWorkspaceStatus: () =>
          Promise.resolve({ kind: "running" as const, status: "running" as const }),
      } as unknown as InstanceType<typeof CoderService>;

      const config = {
        host: "testuser@localhost",
        srcBaseDir,
        identityFile: sshConfig!.privateKeyPath,
        port: sshConfig!.port,
        coder: {
          workspaceName: "test-coder-ws",
          template: "test-template",
          existingWorkspace: false,
        },
      };
      const transport = createSSHTransport(config, false);
      return new CoderSSHRuntime(config, transport, mockCoderService);
    };

    describe("forkWorkspace", () => {
      test("marks both source and fork with existingWorkspace=true", async () => {
        const runtime = await createCoderSSHRuntime();
        const projectName = `coder-fork-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const projectPath = `/some/path/${projectName}`;

        const sourceWorkspaceName = "source";
        const newWorkspaceName = "forked";
        const layout = getLayout(projectPath);
        const sourceWorkspacePath = getRemoteWorkspacePath(layout, sourceWorkspaceName);

        // Create a source workspace repo
        await execSSH(
          runtime,
          [
            `mkdir -p "${sourceWorkspacePath}"`,
            `cd "${sourceWorkspacePath}"`,
            `git init`,
            `git config user.email "test@example.com"`,
            `git config user.name "Test"`,
            `echo "root" > root.txt`,
            `git add root.txt`,
            `git commit -m "root"`,
          ].join(" && ")
        );

        const initLogger = {
          logStep(_message: string) {},
          logStdout(_line: string) {},
          logStderr(_line: string) {},
          logComplete(_exitCode: number) {},
        };

        const forkResult = await runtime.forkWorkspace({
          projectPath,
          sourceWorkspaceName,
          newWorkspaceName,
          initLogger,
        });

        expect(forkResult.success).toBe(true);
        if (!forkResult.success) return;

        // Both configs should have existingWorkspace=true
        expect(forkResult.forkedRuntimeConfig).toBeDefined();
        expect(forkResult.sourceRuntimeConfig).toBeDefined();

        if (
          forkResult.forkedRuntimeConfig?.type === "ssh" &&
          forkResult.sourceRuntimeConfig?.type === "ssh"
        ) {
          expect(forkResult.forkedRuntimeConfig.coder?.existingWorkspace).toBe(true);
          expect(forkResult.sourceRuntimeConfig.coder?.existingWorkspace).toBe(true);
        } else {
          throw new Error("Expected SSH runtime configs with coder field");
        }
      }, 60000);

      test("postCreateSetup after fork does not call coder create", async () => {
        const { CoderSSHRuntime } = await import("@/node/runtime/CoderSSHRuntime");
        const { CoderService } = await import("@/node/services/coderService");

        // Track whether createWorkspace was called
        let createWorkspaceCalled = false;
        const mockCoderService = {
          createWorkspace: async function* () {
            createWorkspaceCalled = true;
            yield "should not happen";
          },
          ensureMuxCoderSSHConfig: async () => {
            // This SHOULD be called - it's safe and idempotent
          },
          getWorkspaceStatus: () =>
            Promise.resolve({ kind: "running" as const, status: "running" as const }),
          waitForStartupScripts: async function* () {
            // Yield nothing - workspace is already running
          },
        } as unknown as InstanceType<typeof CoderService>;

        const config = {
          host: "testuser@localhost",
          srcBaseDir,
          identityFile: sshConfig!.privateKeyPath,
          port: sshConfig!.port,
          coder: {
            workspaceName: "test-coder-ws",
            template: "test-template",
            existingWorkspace: false, // Source was mux-created
          },
        };
        const transport = createSSHTransport(config, false);
        const runtime = new CoderSSHRuntime(config, transport, mockCoderService);

        const projectName = `coder-fork-postcreate-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const projectPath = `/some/path/${projectName}`;
        const sourceWorkspaceName = "source";
        const newWorkspaceName = "forked";
        const layout = getLayout(projectPath);
        const sourceWorkspacePath = getRemoteWorkspacePath(layout, sourceWorkspaceName);
        const forkedWorkspacePath = getRemoteWorkspacePath(layout, newWorkspaceName);

        // Create a source workspace repo
        await execSSH(
          runtime,
          [
            `mkdir -p "${sourceWorkspacePath}"`,
            `cd "${sourceWorkspacePath}"`,
            `git init`,
            `git config user.email "test@example.com"`,
            `git config user.name "Test"`,
            `echo "root" > root.txt`,
            `git add root.txt`,
            `git commit -m "root"`,
          ].join(" && ")
        );

        const initLogger = {
          logStep(_message: string) {},
          logStdout(_line: string) {},
          logStderr(_line: string) {},
          logComplete(_exitCode: number) {},
        };

        // Fork the workspace
        const forkResult = await runtime.forkWorkspace({
          projectPath,
          sourceWorkspaceName,
          newWorkspaceName,
          initLogger,
        });
        expect(forkResult.success).toBe(true);

        // Now run postCreateSetup on the SAME runtime instance (simulating what
        // workspaceService does after fork - it runs init on the forked workspace)
        await runtime.postCreateSetup({
          projectPath,
          branchName: newWorkspaceName,
          trunkBranch: sourceWorkspaceName,
          workspacePath: forkedWorkspacePath,
          initLogger,
        });

        // The key assertion: createWorkspace should NOT have been called
        // because forkWorkspace() should have set existingWorkspace=true
        expect(createWorkspaceCalled).toBe(false);
      }, 60000);
    });
  });
});
