import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { execFileAsync } from "@/node/utils/disposableExec";
import {
  SERVER_UPDATE_CLI_INTERPRETER,
  SERVER_UPDATE_CLI_SHEBANG,
  SERVER_UPDATE_INSTALL_TIMEOUT_MS,
  SERVER_UPDATE_SMOKE_TIMEOUT_MS,
  SERVER_UPDATE_STAGE_MARKER,
  SERVER_UPDATE_STAGING_PREFIX,
} from "@/constants/serverUpdate";
import {
  isExactVersion,
  readPackageVersion,
  resolveCliEntry,
  type InstallLayout,
} from "./installLayout";
import { verifyStagedDependencies } from "./lockfile";
import { downloadArtifact, fetchArtifact, type RegistryRequest } from "./registry";

/** Installs an already verified local tarball; only its dependencies come from the registry. */
export function installCommand(
  layout: InstallLayout,
  tarball: string
): { file: string; args: string[] } {
  // CLI flags outrank npmrc files and npm_config_* env, so an inherited strict-ssl=false cannot
  // disable certificate validation for the download, an inherited package-lock=false or
  // lockfile=false cannot suppress the lockfile that dependency verification reads, and npm's
  // include beats any inherited omit of the optional platform packages. bun has no such flags;
  // its TLS and lockfile knobs are env variables runInstall strips (a global bunfig that disables
  // lockfile saving still makes verification fail closed). Neither bun nor pnpm offers a flag
  // that overrides an inherited optional=false. The text lockfile is required, so an older bun
  // that only writes bun.lockb must fail here.
  const flags = {
    bun: ["add", "--ignore-scripts", "--save-text-lockfile"],
    npm: [
      "install",
      "--no-global",
      "--no-audit",
      "--no-fund",
      "--omit=dev",
      "--ignore-scripts",
      "--strict-ssl",
      "--package-lock=true",
      "--include=optional",
    ],
    pnpm: [
      "add",
      "--no-global",
      "--ignore-scripts",
      "--config.strict-ssl=true",
      "--config.lockfile=true",
    ],
  } satisfies Record<InstallLayout["packageManager"], string[]>;
  return {
    file: layout.packageManager,
    args: [...flags[layout.packageManager], tarball, "--registry", layout.registry],
  };
}

export async function verifyStagedPackage(
  dir: string,
  version: string,
  signal?: AbortSignal
): Promise<string> {
  const packageDir = path.join(dir, "node_modules/@coder/xum");
  if (readPackageVersion(packageDir) !== version)
    throw new Error("Staged package version does not match the requested update");
  const entry = path.join(packageDir, "dist/cli/index.js");
  const stat = await fs.stat(entry);
  if (!stat.isFile()) throw new Error("Staged CLI entry is not a file");
  // The supervisor execs the launcher symlink directly, so the entry must be executable and name
  // the interpreter the running install uses; a parseable file with any other first line would
  // fail every relaunch attempt.
  const shebang = `${SERVER_UPDATE_CLI_SHEBANG}\n`;
  const handle = await fs.open(entry);
  try {
    const { buffer, bytesRead } = await handle.read(
      Buffer.alloc(shebang.length),
      0,
      shebang.length,
      0
    );
    if (buffer.subarray(0, bytesRead).toString() !== shebang)
      throw new Error("Staged CLI entry does not start with the expected interpreter line");
  } finally {
    await handle.close();
  }
  if ((stat.mode & 0o111) === 0) throw new Error("Staged CLI entry is not executable");
  // Parse-only: nothing from the registry runs until the operator activates it. The shebang's
  // interpreter is used because process.execPath may be bun, which has no parse-only mode.
  using smoke = execFileAsync(SERVER_UPDATE_CLI_INTERPRETER, ["--check", entry], {
    timeoutMs: SERVER_UPDATE_SMOKE_TIMEOUT_MS,
    signal,
  });
  await smoke.result;
  return entry;
}

async function runInstall(
  file: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal
): Promise<void> {
  using install = execFileAsync(file, args, {
    cwd,
    // The TLS variable disables certificate validation in every manager and the bun variable
    // suppresses the lockfile; neither can be outranked by a flag.
    env: { NODE_TLS_REJECT_UNAUTHORIZED: undefined, BUN_CONFIG_SKIP_SAVE_LOCKFILE: undefined },
    timeoutMs: SERVER_UPDATE_INSTALL_TIMEOUT_MS,
    killTreeOnTermination: true,
    signal,
  });
  await install.result;
}

export interface StageOptions {
  install?: typeof runInstall;
  request?: RegistryRequest;
  signal?: AbortSignal;
}

const markerSchema = z.object({ launcher: z.string() });

/** Only a stage this installation created may be pruned; a name collision is not ownership. */
async function ownsStage(candidate: string, layout: InstallLayout): Promise<boolean> {
  try {
    const raw: unknown = JSON.parse(
      await fs.readFile(path.join(candidate, SERVER_UPDATE_STAGE_MARKER), "utf8")
    );
    const marker = markerSchema.safeParse(raw);
    return marker.success && marker.data.launcher === layout.launcher;
  } catch {
    return false;
  }
}

export async function stageUpdate(
  layout: InstallLayout,
  version: string,
  options: StageOptions = {}
): Promise<string> {
  const { install = runInstall, request, signal } = options;
  if (!isExactVersion(version)) throw new Error("Invalid update version");
  // Pruning must never remove the target of a launcher that was re-pointed behind this process.
  if (resolveCliEntry(layout.launcher) !== layout.entry)
    throw new Error("Server launcher changed since startup");
  const parent = path.dirname(layout.workdir);
  const active = await fs.realpath(layout.workdir);
  for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(SERVER_UPDATE_STAGING_PREFIX)) continue;
    const candidate = path.join(parent, entry.name);
    if ((await fs.realpath(candidate)) !== active && (await ownsStage(candidate, layout)))
      await fs.rm(candidate, { recursive: true });
  }
  // A fresh, uniquely named directory: a foreign directory sharing the version's name can neither
  // block the stage nor be replaced by it (rename would replace an empty one), and the marker
  // lands first so a crash at any later point leaves a directory the next attempt prunes.
  const dir = await fs.mkdtemp(path.join(parent, `${SERVER_UPDATE_STAGING_PREFIX}${version}.`));
  await fs.writeFile(
    path.join(dir, SERVER_UPDATE_STAGE_MARKER),
    JSON.stringify({ launcher: layout.launcher })
  );
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ private: true }));
  // Package managers follow redirects, so the release itself is fetched and digest-checked here;
  // the dependency tree the manager resolves is anchored to the registry afterwards.
  const tarball = path.join(dir, `xum-${version}.tgz`);
  await downloadArtifact(
    await fetchArtifact(layout.registry, version, request, signal),
    tarball,
    request,
    signal
  );
  const command = installCommand(layout, tarball);
  await install(command.file, command.args, dir, signal);
  await verifyStagedDependencies(layout, dir, request, signal);
  return verifyStagedPackage(dir, version, signal);
}
