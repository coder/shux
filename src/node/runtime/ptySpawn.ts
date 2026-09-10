import type * as NodePty from "@lydell/node-pty";
import type { IPty } from "@lydell/node-pty";
import { log } from "@/node/services/log";
import { getErrorMessage } from "@/common/utils/errors";
import { sanitizeXumChildEnv, sanitizeXumChildPath } from "./childProcessEnv";

interface PtySpawnRequest {
  runtimeLabel: string;
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  preferElectronBuild: boolean;
  env?: NodeJS.ProcessEnv;
  pathEnv?: string;
  logLocalEnv?: boolean;
}

function loadNodePty(runtimeType: string, preferElectronBuild: boolean): typeof NodePty {
  const first = preferElectronBuild ? "node-pty" : "@lydell/node-pty";
  const second = preferElectronBuild ? "@lydell/node-pty" : "node-pty";

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pty = require(first) as typeof NodePty;
    log.debug(`Using ${first} for ${runtimeType}`);
    return pty;
  } catch {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pty = require(second) as typeof NodePty;
      log.debug(`Using ${second} for ${runtimeType} (fallback)`);
      return pty;
    } catch (err) {
      log.error("Neither @lydell/node-pty nor node-pty available:", err);
      throw new Error(
        process.versions.electron
          ? `${runtimeType} terminals are not available. node-pty failed to load (likely due to Electron ABI version mismatch). Run 'make rebuild-native' to rebuild native modules.`
          : `${runtimeType} terminals are not available. No prebuilt binaries found for your platform. Supported: linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64.`
      );
    }
  }
}

export function resolvePathEnv(
  env: NodeJS.ProcessEnv,
  pathEnvOverride?: string
): string | undefined {
  const basePath =
    pathEnvOverride ??
    env.PATH ??
    env.Path ??
    (process.platform === "win32" ? undefined : "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");

  return sanitizeXumChildPath(basePath, env);
}

export function spawnPtyProcess(request: PtySpawnRequest): IPty {
  const pty = loadNodePty(request.runtimeLabel, request.preferElectronBuild);
  const mergedEnv = sanitizeXumChildEnv({ ...process.env, ...request.env });
  const pathEnv = resolvePathEnv(mergedEnv, request.pathEnv);

  const env: NodeJS.ProcessEnv = {
    ...mergedEnv,
    TERM: "xterm-256color",
    ...(pathEnv ? { PATH: pathEnv } : {}),
  };

  try {
    return pty.spawn(request.command, request.args, {
      name: "xterm-256color",
      cols: request.cols,
      rows: request.rows,
      cwd: request.cwd,
      env,
    });
  } catch (err) {
    log.error(`[PTY] Failed to spawn ${request.runtimeLabel} terminal:`, err);

    const printableArgs = request.args.length > 0 ? ` ${request.args.join(" ")}` : "";
    const cmd = `${request.command}${printableArgs}`;
    const details = `cmd="${cmd}", cwd="${request.cwd}", platform="${process.platform}"`;
    const errMessage = getErrorMessage(err);

    if (request.logLocalEnv) {
      log.error(`Local PTY spawn config: ${cmd} (cwd: ${request.cwd})`);
      log.error(`process.env.SHELL: ${process.env.SHELL ?? "undefined"}`);
      log.error(`process.env.PATH: ${process.env.PATH ?? process.env.Path ?? "undefined"}`);
    }

    throw new Error(`Failed to spawn ${request.runtimeLabel} terminal (${details}): ${errMessage}`);
  }
}
