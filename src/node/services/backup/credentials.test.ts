import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  BackupAuthFailedError,
  BackupRemoteUnreachableError,
  runGitWithCredentialLadder,
} from "./credentials";

async function withPath<T>(binDir: string, run: () => Promise<T>): Promise<T> {
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  try {
    return await run();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
}

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, "utf-8");
  await fs.chmod(filePath, 0o755);
}

describe("runGitWithCredentialLadder", () => {
  let tempDir: string;
  let binDir: string;
  let logPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-backup-credentials-"));
    binDir = path.join(tempDir, "bin");
    logPath = path.join(tempDir, "git.log");
    await fs.mkdir(binDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("uses an authenticated gh helper before ambient credentials", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(path.join(binDir, "gh"), "#!/bin/sh\nexit 0\n");
    await writeExecutable(
      path.join(binDir, "git"),
      `#!/bin/sh
printf '%s\n' "$@" > "$GIT_LOG"
printf 'prompt=%s,%s,%s\n' "$GIT_TERMINAL_PROMPT" "$GH_PROMPT_DISABLED" "$GCM_INTERACTIVE" >> "$GIT_LOG"
`
    );

    const result = await withPath(binDir, () =>
      runGitWithCredentialLadder(["ls-remote", "https://github.com/example/repo.git"], {
        repoUrl: "https://github.com/example/repo.git",
        env: {
          GIT_LOG: logPath,
          GIT_TERMINAL_PROMPT: "1",
          GH_PROMPT_DISABLED: "0",
          GCM_INTERACTIVE: "always",
        },
      })
    );

    expect(result.credential).toBe("gh");
    const log = await fs.readFile(logPath, "utf-8");
    expect(log).toContain("credential.helper=\n");
    expect(log).toContain("credential.helper=!gh auth git-credential");
    expect(log).toContain("prompt=0,1,never");
  });

  it("forwards the output cap to the git subprocess", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(
      path.join(binDir, "git"),
      "#!/bin/sh\nprintf '%0800d' 0\nprintf '%0800d' 0 >&2\nexec sleep 1\n"
    );

    let thrown: unknown;
    try {
      await withPath(binDir, () =>
        runGitWithCredentialLadder(["ls-remote", tempDir], {
          repoUrl: tempDir,
          maxOutputBytes: 1024,
        })
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BackupRemoteUnreachableError);
    const cause = (thrown as Error & { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toContain("more than 1024 bytes of output");
  });

  it("picks the ssh rung for git's ssh alias schemes even when gh is authenticated", async () => {
    if (process.platform === "win32") return;
    // An authenticated gh makes the gh rung available, so a remote misread as non-SSH would
    // take it and lose BatchMode, leaving ssh free to block on a host-key prompt.
    await writeExecutable(path.join(binDir, "gh"), "#!/bin/sh\nexit 0\n");
    await writeExecutable(
      path.join(binDir, "git"),
      [
        "#!/bin/sh",
        'if [ "$1" = "config" ]; then',
        "  exit 1",
        "fi",
        `printf '%s\\n' "$@" > "$GIT_LOG"`,
        `printf 'ssh=%s\\n' "$GIT_SSH_COMMAND" >> "$GIT_LOG"`,
        "",
      ].join("\n")
    );

    for (const repoUrl of [
      "git+ssh://git@github.com/example/repo.git",
      "ssh+git://git@github.com/example/repo.git",
      "GIT+SSH://git@github.com/example/repo.git",
    ]) {
      const result = await withPath(binDir, () =>
        runGitWithCredentialLadder(["ls-remote", repoUrl], {
          repoUrl,
          env: { GIT_LOG: logPath, GIT_SSH_COMMAND: "ssh" },
        })
      );

      expect(result.credential).toBe("ssh");
      const log = await fs.readFile(logPath, "utf-8");
      expect(log).toContain("ssh=ssh -o BatchMode=yes");
      expect(log).not.toContain("credential.helper");
    }
  });

  it("strips ambient GitHub token variables from the gh rung", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(
      path.join(binDir, "gh"),
      `#!/bin/sh
printf 'gh-tokens=[%s%s%s%s]\n' "$GH_TOKEN" "$GITHUB_TOKEN" "$GH_ENTERPRISE_TOKEN" "$GITHUB_ENTERPRISE_TOKEN" >> "$GIT_LOG"
`
    );
    await writeExecutable(
      path.join(binDir, "git"),
      `#!/bin/sh
printf 'git-tokens=[%s%s%s%s]\n' "$GH_TOKEN" "$GITHUB_TOKEN" "$GH_ENTERPRISE_TOKEN" "$GITHUB_ENTERPRISE_TOKEN" >> "$GIT_LOG"
`
    );

    const result = await withPath(binDir, () =>
      runGitWithCredentialLadder(["ls-remote", "https://github.com/example/repo.git"], {
        repoUrl: "https://github.com/example/repo.git",
        env: {
          GIT_LOG: logPath,
          GH_TOKEN: "env-token",
          GITHUB_TOKEN: "env-token",
          GH_ENTERPRISE_TOKEN: "env-token",
          GITHUB_ENTERPRISE_TOKEN: "env-token",
        },
      })
    );

    // gh consumes these before its stored login, so leaving them inherited would make
    // the "token-free" ladder authenticate with a token after all.
    expect(result.credential).toBe("gh");
    const log = await fs.readFile(logPath, "utf-8");
    expect(log).toContain("gh-tokens=[]");
    expect(log).toContain("git-tokens=[]");
    expect(log).not.toContain("env-token");
  });

  it("retries authentication failures without controlled credential overrides", async () => {
    if (process.platform === "win32") return;
    // A logged-in gh account can still lack access to this one repository, so the ambient
    // helper deserves a turn after the gh rung fails.
    await writeExecutable(path.join(binDir, "gh"), "#!/bin/sh\nexit 0\n");
    await writeExecutable(
      path.join(binDir, "git"),
      // The ambient rung reads core.sshCommand unless GIT_SSH_COMMAND is already set, so this
      // answers that probe the way git does for an unset key: non-zero, and not an attempt.
      `#!/bin/sh
case "$*" in
  *core.sshCommand*) exit 1 ;;
esac
printf '%s\n' '---' >> "$GIT_LOG"
printf '%s\n' "$@" >> "$GIT_LOG"
case "$*" in
  *credential.helper*) echo 'Authentication failed' >&2; exit 1 ;;
esac
`
    );

    const result = await withPath(binDir, () =>
      runGitWithCredentialLadder(["fetch", "origin"], {
        repoUrl: "https://example.com/repo.git",
        env: { GIT_LOG: logPath },
      })
    );

    expect(result.credential).toBe("ambient");
    const attempts = (await fs.readFile(logPath, "utf-8")).split("---\n").filter(Boolean);
    expect(attempts).toHaveLength(2);
    const first = attempts[0];
    const second = attempts[1];
    if (first === undefined || second === undefined) throw new Error("Expected two git attempts");
    expect(first).toContain("credential.helper=");
    expect(second).toBe("fetch\norigin\n");
  });

  it("reports an exhausted credential ladder as an authentication failure", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(path.join(binDir, "gh"), "#!/bin/sh\nexit 1\n");
    await writeExecutable(
      path.join(binDir, "git"),
      `#!/bin/sh
echo 'fatal: Authentication failed for https://example.com/repo.git' >&2
exit 128
`
    );

    let caught: unknown;
    try {
      await withPath(binDir, () =>
        runGitWithCredentialLadder(["fetch", "origin"], {
          repoUrl: "https://example.com/repo.git",
          env: { GIT_LOG: logPath },
        })
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BackupAuthFailedError);
    // The service maps any error it cannot classify to IO_ERROR, which would tell the
    // user their disk failed when their credential is what expired.
    expect((caught as BackupAuthFailedError).code).toBe("AUTH_FAILED");
  });

  it("treats a push denied by write permissions as an authentication failure", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(path.join(binDir, "gh"), "#!/bin/sh\nexit 0\n");
    await writeExecutable(
      path.join(binDir, "git"),
      // The ambient rung reads core.sshCommand unless GIT_SSH_COMMAND is already set, so this
      // answers that probe the way git does for an unset key: non-zero, and not an attempt.
      `#!/bin/sh
case "$*" in
  *core.sshCommand*) exit 1 ;;
esac
printf '%s\\n' '---' >> "$GIT_LOG"
printf '%s\\n' "$@" >> "$GIT_LOG"
echo 'remote: Permission to owner/repo.git denied to someone.' >&2
echo "fatal: unable to access 'https://example.com/repo.git/': The requested URL returned error: 403" >&2
exit 128
`
    );

    let caught: unknown;
    try {
      await withPath(binDir, () =>
        runGitWithCredentialLadder(["push", "origin", "HEAD:refs/heads/main"], {
          repoUrl: "https://example.com/repo.git",
          env: { GIT_LOG: logPath },
        })
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BackupAuthFailedError);
    // A read-only credential passes validate and only fails here, so the ambient helper
    // still deserves a turn in case it is the one with write access.
    const attempts = (await fs.readFile(logPath, "utf-8")).split("---\n").filter(Boolean);
    expect(attempts).toHaveLength(2);
  });

  it("leaves a non-authentication ambient failure unclassified", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(path.join(binDir, "gh"), "#!/bin/sh\nexit 0\n");
    await writeExecutable(
      path.join(binDir, "git"),
      `#!/bin/sh
case "$*" in
  *credential.helper*) echo 'Authentication failed' >&2; exit 1 ;;
esac
echo 'error: unable to write sha1 filename .git/objects/ab/cdef: Permission denied' >&2
exit 128
`
    );

    let caught: unknown;
    try {
      await withPath(binDir, () =>
        runGitWithCredentialLadder(["fetch", "origin"], {
          repoUrl: "https://example.com/repo.git",
          env: { GIT_LOG: logPath },
        })
      );
    } catch (error) {
      caught = error;
    }

    // A local object-store write failure also says "Permission denied", so matching on
    // that phrase alone would blame the credential for a full or read-only disk.
    expect(caught).not.toBeInstanceOf(BackupAuthFailedError);
    expect((caught as Error).message).toContain("unable to write sha1 filename");
  });

  it("reports an unreachable remote instead of a local IO failure, and stops the ladder", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(path.join(binDir, "gh"), "#!/bin/sh\nexit 0\n");
    await writeExecutable(
      path.join(binDir, "git"),
      [
        "#!/bin/sh",
        'printf "attempt\\n" >> "$GIT_LOG"',
        "echo \"fatal: unable to access 'https://nope.invalid/repo.git/': Could not resolve host: nope.invalid\" >&2",
        "exit 128",
        "",
      ].join("\n")
    );

    let caught: unknown;
    try {
      await withPath(binDir, () =>
        runGitWithCredentialLadder(["ls-remote", "https://nope.invalid/repo.git"], {
          repoUrl: "https://nope.invalid/repo.git",
          env: { GIT_LOG: logPath },
        })
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BackupRemoteUnreachableError);
    expect((caught as BackupRemoteUnreachableError).code).toBe("REMOTE_UNREACHABLE");
    expect((await fs.readFile(logPath, "utf-8")).trim().split("\n")).toHaveLength(1);
  });

  it("reports a stalled remote when the timeout kills git without a diagnostic", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(path.join(binDir, "gh"), "#!/bin/sh\nexit 1\n");
    // A blackholed remote emits no diagnostic, so timeout classification must key on `signal`.
    // `exec sleep` prevents an orphaned child from keeping the stdio pipes open after that signal.
    await writeExecutable(path.join(binDir, "git"), "#!/bin/sh\nexec sleep 30\n");

    let caught: unknown;
    try {
      await withPath(binDir, () =>
        runGitWithCredentialLadder(["ls-remote", "https://blackhole.example/repo.git"], {
          repoUrl: "https://blackhole.example/repo.git",
          timeoutMs: 250,
          env: { GIT_LOG: logPath },
        })
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BackupRemoteUnreachableError);
  });

  it("blames the local cache when git cannot write FETCH_HEAD", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(path.join(binDir, "gh"), "#!/bin/sh\nexit 1\n");
    await writeExecutable(
      path.join(binDir, "git"),
      [
        "#!/bin/sh",
        // The ambient rung probes core.sshCommand first; that probe is not an attempt.
        'case "$*" in *core.sshCommand*) exit 1 ;; esac',
        'printf "attempt\\n" >> "$GIT_LOG"',
        "echo \"error: cannot open '.git/FETCH_HEAD': Permission denied\" >&2",
        "exit 128",
        "",
      ].join("\n")
    );

    let caught: unknown;
    try {
      await withPath(binDir, () =>
        runGitWithCredentialLadder(["fetch", "origin"], {
          repoUrl: "https://example.com/repo.git",
          env: { GIT_LOG: logPath },
        })
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).not.toBeInstanceOf(BackupAuthFailedError);
    expect((caught as Error).message).toContain("FETCH_HEAD");
    expect((await fs.readFile(logPath, "utf-8")).trim().split("\n")).toHaveLength(1);
  });

  it("blames a full disk rather than the network when a fetch reports both", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(path.join(binDir, "gh"), "#!/bin/sh\nexit 1\n");
    await writeExecutable(
      path.join(binDir, "git"),
      [
        "#!/bin/sh",
        'echo "fatal: write error: No space left on device" >&2',
        'echo "fatal: connection reset by peer" >&2',
        "exit 128",
        "",
      ].join("\n")
    );

    let caught: unknown;
    try {
      await withPath(binDir, () =>
        runGitWithCredentialLadder(["fetch", "origin"], {
          repoUrl: "https://example.com/repo.git",
          env: { GIT_LOG: logPath },
        })
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).not.toBeInstanceOf(BackupRemoteUnreachableError);
    expect((caught as Error).message).toContain("No space left on device");
  });

  it("keeps the ambient fallback non-interactive too", async () => {
    if (process.platform === "win32") return;
    // The controlled ssh rung fails authentication, so the ladder reaches ambient. Without
    // BatchMode there, ssh can sit waiting on a passphrase prompt nobody can answer.
    await writeExecutable(
      path.join(binDir, "git"),
      [
        "#!/bin/sh",
        'if [ ! -f "$GIT_LOG" ]; then',
        `  printf 'controlled:%s\\n' "$GIT_SSH_COMMAND" > "$GIT_LOG"`,
        "  echo 'Permission denied (publickey).' >&2",
        "  exit 128",
        "fi",
        `printf 'ambient:%s\\n' "$GIT_SSH_COMMAND" >> "$GIT_LOG"`,
        "",
      ].join("\n")
    );

    const result = await withPath(binDir, () =>
      runGitWithCredentialLadder(["ls-remote", "git@example.com:owner/repo.git"], {
        repoUrl: "git@example.com:owner/repo.git",
        env: { GIT_LOG: logPath, GIT_SSH_COMMAND: "ssh" },
      })
    );

    expect(result.credential).toBe("ambient");
    expect((await fs.readFile(logPath, "utf-8")).trim().split("\n")).toEqual([
      "controlled:ssh -o BatchMode=yes",
      "ambient:ssh -o BatchMode=yes",
    ]);
  });

  it("extends a wrapper configured in core.sshCommand rather than replacing it", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(
      path.join(binDir, "git"),
      [
        "#!/bin/sh",
        'if [ "$1" = "config" ]; then',
        "  printf '/opt/wrapper/ssh -i /keys/id\\n'",
        "  exit 0",
        "fi",
        `printf '%s\\n' "$GIT_SSH_COMMAND" > "$GIT_LOG"`,
        "",
      ].join("\n")
    );

    const result = await withPath(binDir, () =>
      runGitWithCredentialLadder(["ls-remote", "git@example.com:owner/repo.git"], {
        repoUrl: "git@example.com:owner/repo.git",
        // Empty rather than absent, so an ambient GIT_SSH_COMMAND cannot win. GIT_SSH is
        // set to prove git config outranks it.
        env: { GIT_LOG: logPath, GIT_SSH_COMMAND: "", GIT_SSH: "/opt/ignored/ssh" },
      })
    );

    expect(result.credential).toBe("ssh");
    expect((await fs.readFile(logPath, "utf-8")).trim()).toBe(
      "/opt/wrapper/ssh -o BatchMode=yes -i /keys/id"
    );
  });

  it("extends a GIT_SSH program, quoting it into the command line", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(
      path.join(binDir, "git"),
      [
        "#!/bin/sh",
        'if [ "$1" = "config" ]; then',
        "  exit 1",
        "fi",
        `printf '%s\n' "$GIT_SSH_COMMAND" > "$GIT_LOG"`,
        "",
      ].join("\n")
    );

    const result = await withPath(binDir, () =>
      runGitWithCredentialLadder(["ls-remote", "git@example.com:owner/repo.git"], {
        repoUrl: "git@example.com:owner/repo.git",
        env: { GIT_LOG: logPath, GIT_SSH_COMMAND: "", GIT_SSH: "/opt/wrap dir/ssh" },
      })
    );

    expect(result.credential).toBe("ssh");
    // git executes GIT_SSH directly, so its path survives becoming a command line only
    // when quoted. Unquoted, a shell would read `dir/ssh` as the first argument.
    expect((await fs.readFile(logPath, "utf-8")).trim()).toBe(
      "'/opt/wrap dir/ssh' -o BatchMode=yes"
    );
  });

  it("uses the flag the configured ssh client accepts, or none at all", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(
      path.join(binDir, "git"),
      [
        "#!/bin/sh",
        'if [ "$1" = "config" ]; then',
        "  exit 1",
        "fi",
        `printf '%s\\n' "$GIT_SSH_COMMAND" > "$GIT_LOG"`,
        "",
      ].join("\n")
    );

    async function commandFor(env: Record<string, string>): Promise<string> {
      await fs.rm(logPath, { force: true });
      await withPath(binDir, () =>
        runGitWithCredentialLadder(["ls-remote", "git@example.com:owner/repo.git"], {
          repoUrl: "git@example.com:owner/repo.git",
          env: { GIT_LOG: logPath, GIT_SSH_COMMAND: "", ...env },
        })
      );
      return (await fs.readFile(logPath, "utf-8")).trim();
    }

    // PuTTY spells the option differently, and appending OpenSSH's would make plink reject
    // its own arguments.
    expect(await commandFor({ GIT_SSH: "/c/PuTTY/plink.exe" })).toBe("'/c/PuTTY/plink.exe' -batch");
    expect(await commandFor({ GIT_SSH_VARIANT: "tortoiseplink", GIT_SSH: "/c/tp" })).toBe(
      "'/c/tp' -batch"
    );
    // An unrecognised client takes no option: git passes it none either, and a wrong one
    // would break a wrapper that works today. The command is left exactly as configured.
    expect(await commandFor({ GIT_SSH_COMMAND: "/opt/coder/coder gitssh --" })).toBe(
      "/opt/coder/coder gitssh --"
    );
  });

  it("makes SSH attempts non-interactive without discarding an ssh wrapper", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(
      path.join(binDir, "git"),
      `#!/bin/sh
printf '%s\n' "$GIT_SSH_COMMAND" > "$GIT_LOG"
`
    );

    const result = await withPath(binDir, () =>
      runGitWithCredentialLadder(["ls-remote", "git@example.com:owner/repo.git"], {
        repoUrl: "git@example.com:owner/repo.git",
        // Hosts such as Coder export their own ssh wrapper, and replacing it outright would
        // break the very key the wrapper exists to supply.
        env: { GIT_LOG: logPath, GIT_SSH_COMMAND: "/opt/wrapper/ssh -i /keys/id" },
      })
    );

    expect(result.credential).toBe("ssh");
    expect((await fs.readFile(logPath, "utf-8")).trim()).toBe(
      "/opt/wrapper/ssh -o BatchMode=yes -i /keys/id"
    );
  });

  it("extends a double-quoted ssh path without writing into it", async () => {
    if (process.platform === "win32") return;
    const wrapper = path.join(binDir, "wrap dir");
    await fs.mkdir(wrapper, { recursive: true });
    await writeExecutable(path.join(wrapper, "ssh"), "#!/bin/sh\nexit 0\n");
    await writeExecutable(
      path.join(binDir, "git"),
      `#!/bin/sh
printf '%s\\n' "$GIT_SSH_COMMAND" > "$GIT_LOG"
`
    );

    const result = await withPath(binDir, () =>
      runGitWithCredentialLadder(["ls-remote", "git@example.com:owner/repo.git"], {
        repoUrl: "git@example.com:owner/repo.git",
        // How a path with spaces is spelled on Windows; the flag must land after the closing
        // quote, not inside the path.
        env: { GIT_LOG: logPath, GIT_SSH_COMMAND: `"${wrapper}/ssh" -i /keys/id` },
      })
    );

    expect(result.credential).toBe("ssh");
    expect((await fs.readFile(logPath, "utf-8")).trim()).toBe(
      `"${wrapper}/ssh" -o BatchMode=yes -i /keys/id`
    );
  });

  const sshCommandRewriteCases: Array<{
    name: string;
    command: string;
    expectedCommand: string;
    variant?: string;
    skipOnWindows?: boolean;
  }> = [
    {
      name: "recognizes a quoted Windows ssh path with its separators intact",
      command: String.raw`"C:\Program Files\OpenSSH\ssh.exe" -i /keys/id`,
      expectedCommand: String.raw`"C:\Program Files\OpenSSH\ssh.exe" -o BatchMode=yes -i /keys/id`,
      skipOnWindows: true,
    },
    {
      name: "recognizes an unquoted ssh path whose spaces are backslash-escaped",
      command: String.raw`/opt/OpenSSH\ Tools/ssh -i /keys/id`,
      expectedCommand: String.raw`/opt/OpenSSH\ Tools/ssh -o BatchMode=yes -i /keys/id`,
    },
    {
      name: "finds the ssh program past a shell assignment prefix",
      command: "SSH_AUTH_SOCK=/tmp/agent.sock ssh -i /keys/id",
      expectedCommand: "SSH_AUTH_SOCK=/tmp/agent.sock ssh -o BatchMode=yes -i /keys/id",
    },
    {
      name: "finds the ssh program past an assignment whose value is escaped or quoted",
      command: String.raw`FOO=a\ b BAR="c d" ssh -i /keys/id`,
      expectedCommand: String.raw`FOO=a\ b BAR="c d" ssh -o BatchMode=yes -i /keys/id`,
    },
    {
      name: "leaves a command with an unterminated quote alone",
      command: `"/opt/unterminated/ssh`,
      expectedCommand: `"/opt/unterminated/ssh`,
    },
    {
      name: "adds no option to a launcher even when the variant is forced",
      command: "env FOO=bar ssh -i /keys/id",
      expectedCommand: "env FOO=bar ssh -i /keys/id",
      variant: "ssh",
    },
    {
      name: "does not prepend an option when a forced variant meets an unparseable command",
      command: `"/opt/unterminated/ssh`,
      expectedCommand: `"/opt/unterminated/ssh`,
      variant: "ssh",
    },
    {
      name: "keeps the separators of an unquoted Windows ssh path",
      command: String.raw`C:\Windows\ssh.exe -i /keys/id`,
      expectedCommand: String.raw`C:\Windows\ssh.exe -o BatchMode=yes -i /keys/id`,
    },
  ];

  for (const testCase of sshCommandRewriteCases) {
    it(testCase.name, async () => {
      if (testCase.skipOnWindows && process.platform === "win32") return;
      await writeExecutable(
        path.join(binDir, "git"),
        `#!/bin/sh
printf '%s\\n' "$GIT_SSH_COMMAND" > "$GIT_LOG"
`
      );

      const result = await withPath(binDir, () =>
        runGitWithCredentialLadder(["ls-remote", "git@example.com:owner/repo.git"], {
          repoUrl: "git@example.com:owner/repo.git",
          env: {
            GIT_LOG: logPath,
            GIT_SSH_COMMAND: testCase.command,
            ...(testCase.variant === undefined ? {} : { GIT_SSH_VARIANT: testCase.variant }),
          },
        })
      );

      expect(result.credential).toBe("ssh");
      expect((await fs.readFile(logPath, "utf-8")).trim()).toBe(testCase.expectedCommand);
    });
  }

  it("reports a Windows drive path as a local repository, not ssh", async () => {
    await writeExecutable(path.join(binDir, "git"), "#!/bin/sh\nexit 0\n");
    const platform = process.platform;
    const asPlatform = (value: string) =>
      Object.defineProperty(process, "platform", { value, configurable: true });

    try {
      asPlatform("win32");
      const windows = await withPath(binDir, () =>
        runGitWithCredentialLadder(["ls-remote", "C:\\backups\\mux.git"], {
          repoUrl: "C:\\backups\\mux.git",
        })
      );
      expect(windows.credential).not.toBe("ssh");

      // Everywhere else git reads the same string as scp-like and dials host `C`, so the ssh
      // rung it needs must stay selected.
      asPlatform("linux");
      const others = await withPath(binDir, () =>
        runGitWithCredentialLadder(["ls-remote", "C:/backups/mux.git"], {
          repoUrl: "C:/backups/mux.git",
        })
      );
      expect(others.credential).toBe("ssh");
    } finally {
      asPlatform(platform);
    }
  });

  it("overrides a configured BatchMode=no instead of being ignored after it", async () => {
    if (process.platform === "win32") return;
    await writeExecutable(
      path.join(binDir, "git"),
      `#!/bin/sh
printf '%s\\n' "$GIT_SSH_COMMAND" > "$GIT_LOG"
`
    );

    const result = await withPath(binDir, () =>
      runGitWithCredentialLadder(["ls-remote", "git@example.com:owner/repo.git"], {
        repoUrl: "git@example.com:owner/repo.git",
        env: { GIT_LOG: logPath, GIT_SSH_COMMAND: "ssh -o BatchMode=no" },
      })
    );

    expect(result.credential).toBe("ssh");
    // OpenSSH keeps the first value for an option, so ours has to precede the configured one.
    const command = (await fs.readFile(logPath, "utf-8")).trim();
    expect(command).toBe("ssh -o BatchMode=yes -o BatchMode=no");
    expect(command.indexOf("BatchMode=yes")).toBeLessThan(command.indexOf("BatchMode=no"));
  });
});
