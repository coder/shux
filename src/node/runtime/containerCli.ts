/**
 * Resolves the Docker-compatible container CLI used by DockerRuntime.
 * Podman supports every command used here, including the case-insensitive "no such object"
 * inspect stderr contract verified with Podman 3.4.4. Successful detection is cached to keep
 * one engine for the process lifetime, while failures remain retryable if an engine starts later.
 */

import { execFileAsync } from "@/node/utils/disposableExec";

export const CONTAINER_CLI_ENV = "XUM_CONTAINER_CLI";

export type ContainerEngineDetection =
  | { available: true; cli: string }
  | { available: false; reason: string };

type ContainerEngineProbe = (cli: string) => Promise<boolean>;

let cachedContainerCli: string | undefined;
let detectionInFlight: Promise<ContainerEngineDetection> | undefined;

function getContainerCliOverride(): string | undefined {
  const override = process.env[CONTAINER_CLI_ENV];
  return override?.trim() ? override : undefined;
}

export async function isEngineResponsive(cli: string): Promise<boolean> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    using proc = execFileAsync(cli, ["info"]);
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error("timeout")), 5000);
    });
    await Promise.race([proc.result, timeout]);
    return true;
  } catch {
    return false;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export async function detectContainerEngine(
  probe: ContainerEngineProbe = isEngineResponsive
): Promise<ContainerEngineDetection> {
  const override = getContainerCliOverride();
  if (override) {
    if (await probe(override)) return { available: true, cli: override };
    return {
      available: false,
      reason: `Container CLI override "${override}" from ${CONTAINER_CLI_ENV} is not running or not installed`,
    };
  }

  for (const cli of ["docker", "podman"]) {
    if (await probe(cli)) return { available: true, cli };
  }

  return {
    available: false,
    reason: "Docker (or Podman) is not running or not installed",
  };
}

export async function resolveContainerCli(
  probe: ContainerEngineProbe = isEngineResponsive
): Promise<string> {
  const override = getContainerCliOverride();
  // Deliberately unprobed: the override is an explicit user choice, so failures
  // should surface from the real commands instead of being masked by a probe.
  if (override) return override;
  if (cachedContainerCli) return cachedContainerCli;

  const detection = detectionInFlight ?? detectContainerEngine(probe);
  detectionInFlight = detection;

  try {
    const result = await detection;
    if (result.available) {
      cachedContainerCli = result.cli;
      return result.cli;
    }
    return "docker";
  } finally {
    if (detectionInFlight === detection) detectionInFlight = undefined;
  }
}

export function resetContainerCliCacheForTests(): void {
  cachedContainerCli = undefined;
  detectionInFlight = undefined;
}
