import type { BackupCredentialKind } from "@/common/orpc/schemas/backup";
import { shellQuote } from "@/common/utils/shell";
import { execFileAsync, type ExecFileAsyncOptions } from "@/node/utils/disposableExec";
import { SSH_PROTOCOL_SCHEMES } from "@/constants/git";

const NON_INTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GH_PROMPT_DISABLED: "1",
  GCM_INTERACTIVE: "never",
  // A push rejection is recognized by its wording. git keeps the `[rejected]` status token
  // untranslated today, so this is not load-bearing, but pinning the locale means the match
  // does not depend on that staying true.
  LC_ALL: "C",
  LANGUAGE: "C",
} as const;

/** A leading `NAME=` on an unquoted segment, which makes the word an assignment. */
const SHELL_ASSIGNMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * One shell word, covering the three constructs that can hold one together: single quotes, double
 * quotes, and backslash escapes, which the same word may mix (`FOO=a\ b`, `/opt/"My Tools"/ssh`).
 * Expansions and substitutions are not interpreted, so this is not a general shell parser.
 *
 * `value` is what the program is identified by and `end` is where the flag is inserted, produced
 * together rather than by separate patterns that can disagree about the same word.
 *
 * Returns null on an unterminated quote: the boundary is then unknown, and guessing it would
 * insert an option into the middle of a command that works today.
 */
function readShellWord(
  command: string,
  from: number
): { value: string; start: number; end: number } | null {
  let index = from;
  while (index < command.length && /\s/.test(command[index])) index++;
  const start = index;
  let value = "";
  while (index < command.length && !/\s/.test(command[index])) {
    const char = command[index];
    if (char === "'") {
      const close = command.indexOf("'", index + 1);
      if (close < 0) return null;
      value += command.slice(index + 1, close);
      index = close + 1;
    } else if (char === '"') {
      index++;
      let closed = false;
      while (index < command.length) {
        if (command[index] === '"') {
          closed = true;
          index++;
          break;
        }
        // Inside double quotes a backslash escapes only these two, so every other backslash is
        // literal. That is what keeps `"C:\Program Files\OpenSSH\ssh.exe"` intact.
        if (
          command[index] === "\\" &&
          (command[index + 1] === '"' || command[index + 1] === "\\")
        ) {
          value += command[index + 1];
          index += 2;
          continue;
        }
        value += command[index];
        index++;
      }
      if (!closed) return null;
    } else if (char === "\\" && index + 1 < command.length) {
      // Unquoted, a backslash escapes the next character, but an unquoted Windows path spells its
      // separators this way and is read on any host. Only an escaped whitespace or backslash is
      // decoded, so `/opt/OpenSSH\ Tools/ssh` and `C:\Windows\ssh.exe` both survive.
      const next = command[index + 1];
      value += /[\s\\]/.test(next) ? next : `\\${next}`;
      index += 2;
    } else {
      value += char;
      index++;
    }
  }
  return start === index ? null : { value, start, end: index };
}

/**
 * A shell runs `FOO=bar ssh` with `ssh` as the program, so leading assignments are skipped rather
 * than read as the executable. Naming one the program hides the variant and puts the inserted
 * option before `ssh`, where the shell takes it as another assignment or tries to execute it.
 */
function sshProgram(command: string): { executable: string; end: number } | null {
  let from = 0;
  for (;;) {
    const word = readShellWord(command, from);
    if (word === null) return null;
    // Tested on the raw text, so an escaped `FOO\=bar` is a program name, not an assignment.
    if (!SHELL_ASSIGNMENT_NAME.test(command.slice(word.start, word.end))) {
      return { executable: word.value, end: word.end };
    }
    from = word.end;
  }
}

const DOS_DRIVE_PREFIX = /^[A-Za-z]:/;

/**
 * A prompt for a password, a key passphrase, or host key confirmation is unanswerable behind
 * a UI button, so the ssh client is asked to fail instead of asking. The client's own command
 * line is the only place to say so, and whichever command git would have run is extended
 * rather than replaced, so a custom wrapper, key, or proxy keeps working.
 *
 * git resolves that command from four places and no more, in this precedence order (git(1),
 * confirmed against 2.54): `GIT_SSH_COMMAND`, `core.sshCommand`, `GIT_SSH`, plain `ssh`. Any
 * source left unread is a source silently discarded, so all of them are read here.
 *
 * Returns null when no flag can be added safely, leaving every variable exactly as git found
 * it. Guessing an option a client does not accept would break a working configuration, and
 * `BACKUP_GIT_TIMEOUT_MS` still bounds a client that decides to prompt.
 */
async function nonInteractiveSshCommand(
  args: readonly string[],
  options: GitCredentialOptions
): Promise<string | null> {
  const program = ambientValue(options, "GIT_SSH");
  const base =
    ambientValue(options, "GIT_SSH_COMMAND") ??
    (await configuredSshCommand(args, options)) ??
    // Unlike the other two, GIT_SSH names a program git executes directly, so a path with
    // spaces only survives becoming part of a shell command line if it is quoted.
    (program !== null ? shellQuote(program) : "ssh");
  const flag = nonInteractiveFlag(base, options);
  if (flag === null) return null;
  const insertAt = sshFlagInsertion(base);
  return insertAt === null ? null : `${base.slice(0, insertAt)} ${flag}${base.slice(insertAt)}`;
}

/**
 * Where the flag goes, or null when the client cannot be located on the line. The offset is right
 * after the program and before the command's own options, because OpenSSH keeps the first value it
 * obtains for an option (verified with `ssh -G -o BatchMode=no -o BatchMode=yes`, which reports
 * `batchmode no`), so appending would leave a configured `BatchMode=no` in force.
 *
 * An explicit `GIT_SSH_VARIANT` says which option a client accepts, never where that client sits,
 * so it cannot stand in for this. A launcher like `env FOO=bar ssh` would otherwise be handed
 * `-o BatchMode=yes` itself and fail with `invalid option`. Every launcher carries the program it
 * launches as a following word, so refusing an unrecognized program that has one covers them all
 * without naming any, which is why no list of them exists.
 */
function sshFlagInsertion(command: string): number | null {
  const program = sshProgram(command);
  if (program === null) return null;
  // Recognized by name, so this word is the client no matter what follows it. Otherwise only a
  // lone word can be the client, because any following word could be the real program.
  if (NON_INTERACTIVE_FLAGS.has(programName(program.executable))) return program.end;
  return command.slice(program.end).trim() === "" ? program.end : null;
}

/**
 * Git's own variant list (`GIT_SSH_VARIANT`): only OpenSSH takes `-o BatchMode=yes`, while the
 * PuTTY family spells it `-batch`, and git passes no options at all to anything else. Nothing
 * is appended for an unrecognised client for the same reason. A Map rather than an object so an
 * inherited key like `constructor` cannot resolve to a flag.
 */
const NON_INTERACTIVE_FLAGS = new Map([
  ["ssh", "-o BatchMode=yes"],
  ["plink", "-batch"],
  ["putty", "-batch"],
  ["tortoiseplink", "-batch"],
]);

function nonInteractiveFlag(command: string, options: GitCredentialOptions): string | null {
  const variant =
    options.env?.GIT_SSH_VARIANT ?? process.env.GIT_SSH_VARIANT ?? sshVariant(command);
  return NON_INTERACTIVE_FLAGS.get(variant) ?? null;
}

function programName(executable: string): string {
  // Split on both separators rather than `path.basename`: a `core.sshCommand` written on Windows
  // is read verbatim wherever the config is used, and basename only knows the host's separator.
  return (executable.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
}

function sshVariant(command: string): string {
  return programName(sshProgram(command)?.executable ?? "");
}

function ambientValue(
  options: GitCredentialOptions,
  name: "GIT_SSH_COMMAND" | "GIT_SSH"
): string | null {
  const value = options.env?.[name] ?? process.env[name];
  return value !== undefined && value.trim() !== "" ? value : null;
}

async function sshEnvOverrides(
  args: readonly string[],
  options: GitCredentialOptions
): Promise<Record<string, string | undefined>> {
  const command = await nonInteractiveSshCommand(args, options);
  return command === null ? {} : { GIT_SSH_COMMAND: command };
}

/** Reads through the caller's own `-C`, so the value git would apply is the one extended. */
async function configuredSshCommand(
  args: readonly string[],
  options: GitCredentialOptions
): Promise<string | null> {
  const repository = args[0] === "-C" && args[1] !== undefined ? ["-C", args[1]] : [];
  try {
    const result = await run("git", [...repository, "config", "--get", "core.sshCommand"], {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      env: { ...options.env, ...NON_INTERACTIVE_ENV, ...GIT_SCOPE_ENV_UNSET },
    });
    return result.stdout.trim() || null;
  } catch {
    // git exits non-zero when the key is unset, which is the common case.
    return null;
  }
}
export type BackupCredential = BackupCredentialKind;

export class BackupRemoteUnreachableError extends Error {
  readonly code = "REMOTE_UNREACHABLE";

  constructor(cause: unknown) {
    super("Could not reach the backup repository. Check the URL and your network connection.", {
      cause,
    });
    this.name = "BackupRemoteUnreachableError";
  }
}

export class BackupAuthFailedError extends Error {
  readonly code = "AUTH_FAILED";

  constructor(cause: unknown) {
    super(
      "Could not authenticate to the backup repository. Check your SSH key or `gh auth login`.",
      { cause }
    );
    this.name = "BackupAuthFailedError";
  }
}

export interface GitCredentialOptions extends Omit<ExecFileAsyncOptions, "killTreeOnTermination"> {
  repoUrl: string;
}

export interface GitCredentialResult {
  credential: BackupCredential;
  stdout: string;
  stderr: string;
}

interface ControlledCredential {
  credential: Exclude<BackupCredential, "ambient">;
  argsPrefix: string[];
  env: Record<string, string | undefined>;
}

function repoHost(repoUrl: string): string | null {
  try {
    return new URL(repoUrl).hostname || null;
  } catch {
    const sshMatch = /^(?:[^@]+@)?([^:/]+):/.exec(repoUrl);
    return sshMatch?.[1] ?? null;
  }
}

function isSshRepoUrl(repoUrl: string): boolean {
  const schemeEnd = repoUrl.indexOf("://");
  if (schemeEnd >= 0) {
    return SSH_PROTOCOL_SCHEMES.has(`${repoUrl.slice(0, schemeEnd).toLowerCase()}:`);
  }
  // Windows only, mirroring git's own `has_dos_drive_prefix`: elsewhere git reads `C:/repo`
  // as scp-like and really does dial host `C`, so excluding a drive prefix on every platform
  // would drop the ssh rung from a remote that needs it.
  if (process.platform === "win32" && DOS_DRIVE_PREFIX.test(repoUrl)) return false;
  return /^(?:[^@]+@)?[^:/]+:/.test(repoUrl);
}

async function run(
  file: string,
  args: string[],
  options: ExecFileAsyncOptions
): Promise<{ stdout: string; stderr: string }> {
  using process = execFileAsync(file, args, {
    ...options,
    killTreeOnTermination: true,
  });
  return await process.result;
}

/**
 * gh reads these before its own stored login (`gh help environment`), so an inherited
 * variable would quietly turn the gh rung back into a token pathway. The rung exists to
 * reuse the CLI's stored login and nothing else; stripping the probe too keeps the rung
 * from being offered on the strength of a token alone. The ambient rung inherits the
 * host environment untouched on purpose: there git runs exactly as the user's own git
 * would, with credential wiring Xum neither adds nor removes.
 */
const GH_TOKEN_ENV_UNSET = {
  GH_TOKEN: undefined,
  GITHUB_TOKEN: undefined,
  GH_ENTERPRISE_TOKEN: undefined,
  GITHUB_ENTERPRISE_TOKEN: undefined,
} as const;

/**
 * Two families git trusts ahead of everything the config rebuild controls, both exported
 * into hook and alias subprocesses, which is where Xum inherits them from. The repository
 * selectors are read ahead of `-C` and discovery (git(1), "The Git Repository"): with
 * `GIT_WORK_TREE` set, `git -C <cache> clean -fdx -- mux` deletes `mux/` under that tree
 * instead of the cache. The config carriers add command-scope runtime configuration
 * (`git -c` exports them to hooks), so an inherited `url.*.pushInsteadOf` would redirect a
 * push while the checked stored url stays intact; git reads the `GIT_CONFIG_KEY_<n>` family
 * only up to `GIT_CONFIG_COUNT`, so unsetting the count disables every pair. Every git the
 * backup feature runs addresses the cache explicitly, so none of these are meaningful here
 * and all are stripped. `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` stay: git does not export
 * them, so a set value is the user's own environment, trusted like the files it names.
 * None of this is credential wiring, so the ambient rung strips it too.
 */
export const GIT_SCOPE_ENV_UNSET = {
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_NAMESPACE: undefined,
  GIT_CONFIG: undefined,
  GIT_CONFIG_COUNT: undefined,
  GIT_CONFIG_PARAMETERS: undefined,
} as const;

async function hasAuthenticatedGh(host: string, options: ExecFileAsyncOptions): Promise<boolean> {
  try {
    await run("gh", ["auth", "status", "--hostname", host], {
      ...options,
      env: { ...options.env, ...NON_INTERACTIVE_ENV, ...GH_TOKEN_ENV_UNSET },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every controlled rung worth trying, in order. There is deliberately no token rung: Xum
 * must never store or accept an OAuth token or PAT for backups, so authentication is only
 * ever delegated to credentials that already live on the host (an SSH agent or key, the
 * GitHub CLI's own login, or whatever ambient helper git falls back to).
 */
async function controlledCredentials(
  args: readonly string[],
  options: GitCredentialOptions
): Promise<ControlledCredential[]> {
  if (isSshRepoUrl(options.repoUrl)) {
    return [
      {
        credential: "ssh",
        argsPrefix: [],
        env: await sshEnvOverrides(args, options),
      },
    ];
  }

  const host = repoHost(options.repoUrl);
  if (!host) return [];
  const rungs: ControlledCredential[] = [];

  if (await hasAuthenticatedGh(host, options)) {
    rungs.push({
      credential: "gh",
      argsPrefix: ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"],
      env: { ...GH_TOKEN_ENV_UNSET },
    });
  }

  return rungs;
}

/**
 * Push denials count, not just fetch denials: `ls-remote` only proves read access, so a
 * read-only credential first shows up as a rejected push. Matching those here also lets
 * the ladder retry with the ambient helper, which may hold a writable credential.
 */
const AUTH_FAILURE_PATTERN =
  /authentication failed|could not read (?:username|password)|permission denied|permission to [^\n]*denied|publickey|access denied|repository not found|terminal prompts disabled|invalid username or (?:password|token)|returned error: 40[13]|authentication is required/i;

/**
 * Local object-store failures also say "Permission denied", so they are excluded first.
 * Without this, a full or read-only disk would be reported as an expired credential and
 * would waste an ambient retry.
 */
const LOCAL_FILESYSTEM_FAILURE_PATTERN =
  /unable to write|insufficient permission for adding an object|no space left on device|read-only file system|cannot open '[^']*(?:FETCH_HEAD|HEAD|index|config|packed-refs)'|unable to (?:create|open)|error: cannot (?:lock|create) ref/i;

/** Remote failures vary across curl, ssh, and Git resolver diagnostics. */
const REMOTE_UNREACHABLE_PATTERN =
  /could not resolve (?:host|hostname|proxy)|name or service not known|temporary failure in name resolution|connection (?:refused|timed out|reset)|network is (?:unreachable|down)|no route to host|failed to connect to|couldn't connect to server|operation timed out|returned error: 5\d\d|service unavailable|bad gateway|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i;

function isAuthenticationFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (LOCAL_FILESYSTEM_FAILURE_PATTERN.test(message)) return false;
  return AUTH_FAILURE_PATTERN.test(message);
}

function isRemoteUnreachable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (LOCAL_FILESYSTEM_FAILURE_PATTERN.test(message)) return false;
  // A blackholed remote may emit no diagnostic before timeout kills Git, so key on `signal`.
  if (isSignalTermination(error)) return true;
  return REMOTE_UNREACHABLE_PATTERN.test(message);
}

function isSignalTermination(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const signal = (error as Error & { signal?: unknown }).signal;
  return typeof signal === "string" && signal !== "";
}

export async function runGitWithCredentialLadder(
  args: string[],
  options: GitCredentialOptions
): Promise<GitCredentialResult> {
  const baseOptions: ExecFileAsyncOptions = {
    maxOutputBytes: options.maxOutputBytes,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    onStderrData: options.onStderrData,
  };

  for (const controlled of await controlledCredentials(args, options)) {
    try {
      const result = await run("git", [...controlled.argsPrefix, ...args], {
        ...baseOptions,
        env: {
          ...options.env,
          ...NON_INTERACTIVE_ENV,
          ...GIT_SCOPE_ENV_UNSET,
          ...controlled.env,
        },
      });
      return { credential: controlled.credential, ...result };
    } catch (error) {
      if (!isAuthenticationFailure(error)) {
        // Thrown from inside the loop on purpose: another credential cannot make an
        // unreachable remote reachable, so trying the rest only delays the error.
        if (isRemoteUnreachable(error)) throw new BackupRemoteUnreachableError(error);
        throw error;
      }
    }
  }

  try {
    const result = await run("git", args, {
      ...baseOptions,
      // The ambient rung deliberately drops the controlled rungs' credential wiring, but it
      // must not drop their non-interactivity: an ssh remote reached here would otherwise
      // prompt for a passphrase and hang the operation.
      env: {
        ...options.env,
        ...NON_INTERACTIVE_ENV,
        ...GIT_SCOPE_ENV_UNSET,
        ...(await sshEnvOverrides(args, options)),
      },
    });
    return { credential: "ambient", ...result };
  } catch (error) {
    // Every rung has now failed. A raw git error carries a numeric exit code, which the
    // service cannot distinguish from a local filesystem failure.
    if (isAuthenticationFailure(error)) throw new BackupAuthFailedError(error);
    if (isRemoteUnreachable(error)) throw new BackupRemoteUnreachableError(error);
    throw error;
  }
}
