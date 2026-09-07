/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-call */

import type { ChildProcess } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { describe, expect, test, beforeEach, afterEach } from "@jest/globals";
import { execAsync, execFileAsync, killProcessTree } from "./disposableExec";

/**
 * Tests for DisposableExec - verifies no process leaks under any scenario
 *
 * These tests access internal implementation details (child process) to verify cleanup.
 * The eslint disables are necessary for test verification purposes.
 */

describe("disposableExec", () => {
  const activeProcesses = new Set<ChildProcess>();

  beforeEach(() => {
    activeProcesses.clear();
  });

  afterEach(() => {
    // Verify all processes are cleaned up after each test
    for (const proc of activeProcesses) {
      const hasExited = proc.exitCode !== null || proc.signalCode !== null;
      expect(hasExited || proc.killed).toBe(true);
      if (!hasExited && !proc.killed) {
        proc.kill();
      }
    }
    activeProcesses.clear();
  });

  test("pre-aborted execFileAsync rejects without starting the command", async () => {
    const markerPath = path.join(os.tmpdir(), `mux-execfile-abort-${Date.now()}`);
    const abortController = new AbortController();
    abortController.abort();

    using proc = execFileAsync("bash", ["-c", `touch ${JSON.stringify(markerPath)}`], {
      signal: abortController.signal,
    });

    await expect(proc.result).rejects.toThrow("Command aborted before execution");
    await expect(fs.access(markerPath)).rejects.toThrow();
  });

  test("successful command completes and cleans up automatically", async () => {
    let childProc: ChildProcess;

    {
      using proc = execAsync("echo 'hello world'");
      childProc = (proc as any).child;
      activeProcesses.add(childProc);

      const { stdout } = await proc.result;
      expect(stdout.trim()).toBe("hello world");
    }

    // After scope exit, process should be exited
    expect(childProc.exitCode).toBe(0);
    expect(childProc.killed).toBe(false);
  });

  test("failed command completes and cleans up automatically", async () => {
    using proc = execAsync("exit 1");
    const childProc: ChildProcess = (proc as any).child;
    activeProcesses.add(childProc);

    try {
      await proc.result;
      expect(true).toBe(false); // Should not reach here
    } catch (error: any) {
      expect(error.code).toBe(1);
    }

    // After scope exit, process should be exited
    expect(childProc.exitCode).toBe(1);
    expect(childProc.killed).toBe(false);
  });

  test("disposing before completion kills the process", async () => {
    const proc = execAsync("sleep 2");
    const childProc: ChildProcess = (proc as any).child;
    activeProcesses.add(childProc);

    // Give process time to start
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(childProc.exitCode).toBeNull();
    expect(childProc.signalCode).toBeNull();

    // Explicit disposal - kill the process
    proc[Symbol.dispose]();

    // Wait for process to be killed
    await new Promise((resolve) => {
      if (childProc.killed) {
        resolve(undefined);
      } else {
        childProc.once("exit", () => resolve(undefined));
      }
    });

    // Process should be killed
    expect(childProc.killed).toBe(true);

    // Result promise should reject since we killed it
    await expect(proc.result).rejects.toThrow();
  });

  test("using block disposes and kills long-running process", async () => {
    let childProc: ChildProcess;
    let resultPromise: Promise<{ stdout: string; stderr: string }>;

    {
      using proc = execAsync("sleep 2");
      childProc = (proc as any).child;
      resultPromise = proc.result;
      activeProcesses.add(childProc);

      // Give process time to start
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(childProc.exitCode).toBeNull();
      expect(childProc.signalCode).toBeNull();
      // Exit scope - should trigger disposal
    }

    // Wait for process to be killed
    await new Promise((resolve) => {
      if (childProc.killed || childProc.exitCode !== null) {
        resolve(undefined);
      } else {
        childProc.once("exit", () => resolve(undefined));
      }
    });

    // Process should be killed
    expect(childProc.killed).toBe(true);

    // Result should reject since we killed it
    await expect(resultPromise).rejects.toThrow();
  });

  test("disposing already-exited process is safe", async () => {
    const proc = execAsync("echo 'test'");
    const childProc: ChildProcess = (proc as any).child;
    activeProcesses.add(childProc);

    await proc.result;

    // Process already exited
    expect(childProc.exitCode).toBe(0);

    // Should not throw or cause issues
    proc[Symbol.dispose]();

    // Still exited, not killed
    expect(childProc.exitCode).toBe(0);
    expect(childProc.killed).toBe(false);
  });

  test("cwd option runs the command in the requested directory", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "disposable-exec-cwd-"));
    try {
      using command = execFileAsync("node", ["-p", "process.cwd()"], { cwd });
      expect((await command.result).stdout.trim()).toBe(await fs.realpath(cwd));
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("stdout and stderr are captured correctly", async () => {
    using proc = execAsync("echo 'stdout message' && echo 'stderr message' >&2");
    const childProc = (proc as any).child;
    activeProcesses.add(childProc);

    const { stdout, stderr } = await proc.result;
    expect(stdout.trim()).toBe("stdout message");
    expect(stderr.trim()).toBe("stderr message");
  });

  test("error includes stderr content", async () => {
    try {
      using proc = execAsync("echo 'error details' >&2 && exit 42");
      const childProc = (proc as any).child;
      activeProcesses.add(childProc);

      await proc.result;
      expect(true).toBe(false); // Should not reach
    } catch (error: any) {
      expect(error.code).toBe(42);
      expect(error.stderr.trim()).toBe("error details");
      expect(error.message).toContain("error details");
    }
  });

  test("multiple processes in parallel all clean up", async () => {
    const childProcs: ChildProcess[] = [];

    await Promise.all(
      Array.from({ length: 5 }, async (_, i) => {
        using proc = execAsync(`echo 'process ${i}'`);
        const childProc = (proc as any).child;
        childProcs.push(childProc);
        activeProcesses.add(childProc);

        const { stdout } = await proc.result;
        expect(stdout.trim()).toBe(`process ${i}`);
      })
    );

    // All processes should be exited
    for (const proc of childProcs) {
      expect(proc.exitCode).toBe(0);
    }
  });

  test("exception during process handling still cleans up", async () => {
    let childProc: ChildProcess | undefined;
    let resultPromise: Promise<{ stdout: string; stderr: string }> | undefined;

    try {
      using proc = execAsync("sleep 2");
      childProc = (proc as any).child as ChildProcess;
      resultPromise = proc.result;
      activeProcesses.add(childProc);

      // Give process time to start
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Throw exception before awaiting result - disposal will happen when leaving this block
      throw new Error("Simulated error");
    } catch (error: any) {
      expect(error.message).toBe("Simulated error");
    }

    // Wait for process to be killed
    if (childProc) {
      await new Promise((resolve) => {
        if (childProc.killed || childProc.exitCode !== null) {
          resolve(undefined);
        } else {
          childProc.once("exit", () => resolve(undefined));
        }
      });
    }

    // Process should be killed despite exception
    expect(childProc?.killed).toBe(true);

    // After leaving try block, disposal has occurred
    // Result should reject since we killed it via disposal
    await expect(resultPromise).rejects.toThrow();
  });

  test("process killed by signal is handled correctly", async () => {
    using proc = execAsync("sleep 2");
    const childProc: ChildProcess = (proc as any).child;
    activeProcesses.add(childProc);

    try {
      // Give process time to start
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Manually kill with SIGTERM
      childProc.kill("SIGTERM");

      await proc.result;
      expect(true).toBe(false); // Should not reach
    } catch (error: any) {
      expect(error.signal).toBe("SIGTERM");
      expect(error.message).toContain("SIGTERM");
    }

    // Wait for process to fully exit
    await new Promise((resolve) => {
      if (childProc.exitCode !== null || childProc.signalCode !== null) {
        resolve(undefined);
      } else {
        childProc.once("exit", () => resolve(undefined));
      }
    });

    // Process should be killed
    expect(childProc.killed).toBe(true);
    expect(childProc.signalCode).toBe("SIGTERM");
  });

  test("early disposal prevents result promise from hanging", async () => {
    const proc = execAsync("sleep 2");
    const childProc = (proc as any).child;
    activeProcesses.add(childProc);

    // Give process time to start
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Dispose immediately
    proc[Symbol.dispose]();

    // Wait for process to be killed
    await new Promise((resolve) => {
      if (childProc.killed || childProc.exitCode !== null) {
        resolve(undefined);
      } else {
        childProc.once("exit", () => resolve(undefined));
      }
    });

    // Process should be killed
    expect(childProc.killed).toBe(true);

    // Result should reject, not hang forever
    await expect(proc.result).rejects.toThrow();
  });

  test("dispose is idempotent - calling multiple times is safe", async () => {
    const proc = execAsync("sleep 2");
    const childProc = (proc as any).child;
    activeProcesses.add(childProc);

    // Give process time to start
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Multiple dispose calls should be safe
    proc[Symbol.dispose]();
    proc[Symbol.dispose]();
    proc[Symbol.dispose]();

    // Wait for process to be killed
    await new Promise((resolve) => {
      if (childProc.killed || childProc.exitCode !== null) {
        resolve(undefined);
      } else {
        childProc.once("exit", () => resolve(undefined));
      }
    });

    // Process should be killed once
    expect(childProc.killed).toBe(true);

    // Result should reject since we killed it
    await expect(proc.result).rejects.toThrow();
  });

  test("maxOutputBytes rejects and kills a process when stdout outruns the cap", async () => {
    // The final exec avoids a shell wrapper that could survive and hold the inherited pipes.
    using proc = execFileAsync("sh", ["-c", "yes abcdefghij | head -c 200000; exec sleep 15"], {
      maxOutputBytes: 1024,
    });
    const child = (proc as unknown as { child: ChildProcess }).child;
    activeProcesses.add(child);

    await expect(proc.result).rejects.toThrow(/more than 1024 bytes of output/);
    expect(child.signalCode).toBe("SIGKILL");
  });

  test("maxOutputBytes rejects after an overflowing command exits cleanly", async () => {
    using proc = execFileAsync("sh", ["-c", "printf '%02000d' 0"], {
      maxOutputBytes: 1024,
    });
    const child = (proc as unknown as { child: ChildProcess }).child;

    await expect(proc.result).rejects.toThrow(/more than 1024 bytes of output/);
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
  });

  test("maxOutputBytes rejects when stderr pushes cumulative output over the cap", async () => {
    using proc = execFileAsync(
      "sh",
      ["-c", "printf '%0800d' 0; printf '%0800d' 0 >&2; exec sleep 15"],
      { maxOutputBytes: 1024 }
    );
    const child = (proc as unknown as { child: ChildProcess }).child;
    activeProcesses.add(child);

    await expect(proc.result).rejects.toThrow(/more than 1024 bytes of output/);
    expect(child.signalCode).toBe("SIGKILL");
  });

  test("maxOutputBytes kills descendants of the capped command", async () => {
    if (process.platform === "win32") return;
    const marker = `mux-cap-descendant-${process.pid}-${Date.now()}`;
    using proc = execFileAsync(
      "sh",
      ["-c", `bash -c 'exec -a ${marker} sleep 30' & yes abcdefghij | head -c 200000; wait`],
      { maxOutputBytes: 1024 }
    );
    const child = (proc as unknown as { child: ChildProcess }).child;
    activeProcesses.add(child);

    await expect(proc.result).rejects.toThrow(/more than 1024 bytes of output/);
    expect(child.signalCode).toBe("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 500));

    using survivors = execFileAsync("pgrep", ["-fc", marker]);
    const found = await survivors.result.then(
      (ok) => ok.stdout.trim(),
      () => "0" // pgrep exits non-zero when nothing matches
    );
    expect(found).toBe("0");
  });

  test("timeout kills descendants of a capped command without waiting for inherited pipes", async () => {
    if (process.platform === "win32") return;
    const pidFile = path.join(os.tmpdir(), `mux-timeout-descendant-${process.pid}-${Date.now()}`);
    using proc = execFileAsync("sh", ["-c", 'sleep 30 & echo $! > "$1"; wait', "sh", pidFile], {
      maxOutputBytes: 1024,
      timeoutMs: 100,
    });
    const child = (proc as unknown as { child: ChildProcess }).child;
    activeProcesses.add(child);
    let passed = false;

    try {
      const rejected = await Promise.race([
        proc.result.then(
          () => {
            throw new Error("Expected the timeout to reject");
          },
          (error: unknown) => error
        ),
        new Promise<never>((_, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("timeout result did not settle promptly")),
            2_000
          );
          timeout.unref?.();
        }),
      ]);
      expect((rejected as { signal?: string }).signal).toMatch(/SIGKILL/);

      const descendantPid = Number((await fs.readFile(pidFile, "utf-8")).trim());
      let descendantRunning = true;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          process.kill(descendantPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 25));
        } catch {
          descendantRunning = false;
          break;
        }
      }
      expect(descendantRunning).toBe(false);
      passed = true;
    } finally {
      if (!passed && child.pid !== undefined) killProcessTree(child.pid);
      if (!passed) {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      await fs.rm(pidFile, { force: true });
    }
  });

  test("timeout kills descendants when tree termination is requested without waiting for inherited pipes", async () => {
    if (process.platform === "win32") return;
    const pidFile = path.join(
      os.tmpdir(),
      `mux-tree-timeout-descendant-${process.pid}-${Date.now()}`
    );
    using proc = execFileAsync("sh", ["-c", 'sleep 30 & echo $! > "$1"; wait', "sh", pidFile], {
      killTreeOnTermination: true,
      timeoutMs: 100,
    });
    const child = (proc as unknown as { child: ChildProcess }).child;
    activeProcesses.add(child);
    let descendantPid: number | undefined;
    let passed = false;

    try {
      const rejected = await Promise.race([
        proc.result.then(
          () => {
            throw new Error("Expected the timeout to reject");
          },
          (error: unknown) => error
        ),
        new Promise<never>((_, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("timeout result did not settle promptly")),
            2_000
          );
          timeout.unref?.();
        }),
      ]);
      expect((rejected as { signal?: string }).signal).toMatch(/SIGKILL/);

      descendantPid = Number((await fs.readFile(pidFile, "utf-8")).trim());
      let descendantRunning = true;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          process.kill(descendantPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 25));
        } catch {
          descendantRunning = false;
          break;
        }
      }
      expect(descendantRunning).toBe(false);
      passed = true;
    } finally {
      if (!passed && child.pid !== undefined) killProcessTree(child.pid);
      if (!passed && descendantPid === undefined) {
        descendantPid = await fs
          .readFile(pidFile, "utf-8")
          .then((value) => Number(value.trim()))
          .catch(() => undefined);
      }
      if (!passed && descendantPid !== undefined) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // The descendant may already have exited.
        }
      }
      if (!passed) {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      await fs.rm(pidFile, { force: true });
    }
  });

  test("timeout kills a capped command's group after the leader already exited", async () => {
    if (process.platform === "win32") return;
    const pidFile = path.join(os.tmpdir(), `mux-leader-exited-${process.pid}-${Date.now()}`);
    using proc = execFileAsync("sh", ["-c", 'sleep 30 & echo $! > "$1"', "sh", pidFile], {
      maxOutputBytes: 1024,
      timeoutMs: 100,
    });
    const child = (proc as unknown as { child: ChildProcess }).child;
    activeProcesses.add(child);
    let passed = false;

    try {
      // The exited leader resolves successfully; the timeout prevents delayed settlement.
      await Promise.race([
        proc.result,
        new Promise<never>((_, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("timeout result did not settle promptly")),
            2_000
          );
          timeout.unref?.();
        }),
      ]);
      expect(child.exitCode).toBe(0);

      const descendantPid = Number((await fs.readFile(pidFile, "utf-8")).trim());
      let descendantRunning = true;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          process.kill(descendantPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 25));
        } catch {
          descendantRunning = false;
          break;
        }
      }
      expect(descendantRunning).toBe(false);
      passed = true;
    } finally {
      if (!passed && child.pid !== undefined) killProcessTree(child.pid);
      if (!passed) {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      await fs.rm(pidFile, { force: true });
    }
  });

  test("an uncapped command stays in this process's group", async () => {
    // Reads /proc rather than spawning ps, so the assertion cannot be slower than the process it
    // is inspecting. Linux-only, which is where the unit suite runs.
    if (process.platform !== "linux") return;
    const groupOf = async (pid: number) => {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf-8");
      // Everything after the executable name, whose parens can contain spaces; pgrp is field 5.
      return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[2];
    };

    const proc = execFileAsync("sleep", ["30"]);
    const child: ChildProcess = (proc as any).child;
    activeProcesses.add(child);
    void proc.result.catch(() => undefined);

    try {
      // Detaching would give it its own group, where a signal sent to this process's group (a
      // terminal interrupt) would never reach it. Only the capped path pays that cost, because
      // it is the one that needs a group to kill.
      expect(await groupOf(child.pid!)).toBe(await groupOf(process.pid));
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("maxOutputBytes leaves output under the cap untouched", async () => {
    using proc = execFileAsync("sh", ["-c", "printf 'small output'; printf 'small error' >&2"], {
      maxOutputBytes: 1024,
    });
    activeProcesses.add((proc as unknown as { child: ChildProcess }).child);

    const { stdout, stderr } = await proc.result;

    expect(stdout).toBe("small output");
    expect(stderr).toBe("small error");
  });

  test("close event waits for stdio to flush", async () => {
    // Generate large output to test stdio buffering
    const largeOutput = "x".repeat(100000);
    using proc = execAsync(`echo '${largeOutput}'`);
    const childProc = (proc as any).child;
    activeProcesses.add(childProc);

    const { stdout } = await proc.result;

    // Should receive all output, not truncated
    expect(stdout.trim()).toBe(largeOutput);
    expect(stdout.trim().length).toBe(largeOutput.length);
  });
});
