import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  CONTAINER_CLI_ENV,
  detectContainerEngine,
  resetContainerCliCacheForTests,
  resolveContainerCli,
} from "./containerCli";

const originalOverride = process.env[CONTAINER_CLI_ENV];

beforeEach(() => {
  delete process.env[CONTAINER_CLI_ENV];
  resetContainerCliCacheForTests();
});

afterEach(() => {
  if (originalOverride === undefined) delete process.env[CONTAINER_CLI_ENV];
  else process.env[CONTAINER_CLI_ENV] = originalOverride;
  resetContainerCliCacheForTests();
});

describe("container CLI detection", () => {
  it("prefers docker when both engines respond", async () => {
    const probes: string[] = [];
    const result = await detectContainerEngine((cli) => {
      probes.push(cli);
      return Promise.resolve(true);
    });

    expect(result).toEqual({ available: true, cli: "docker" });
    expect(probes).toEqual(["docker"]);
  });

  it("falls back to podman when docker is unresponsive", async () => {
    const probes: string[] = [];
    const result = await detectContainerEngine((cli) => {
      probes.push(cli);
      return Promise.resolve(cli === "podman");
    });

    expect(result).toEqual({ available: true, cli: "podman" });
    expect(probes).toEqual(["docker", "podman"]);
  });

  it("reports both engines when neither responds", async () => {
    const result = await detectContainerEngine(() => Promise.resolve(false));

    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason.toLowerCase()).toContain("docker");
      expect(result.reason.toLowerCase()).toContain("podman");
    }
  });

  it("probes only the configured override and resolves it without probing", async () => {
    process.env[CONTAINER_CLI_ENV] = "/usr/local/bin/custom-engine";
    const probes: string[] = [];
    const detection = await detectContainerEngine((cli) => {
      probes.push(cli);
      return Promise.resolve(false);
    });

    expect(probes).toEqual(["/usr/local/bin/custom-engine"]);
    expect(detection.available).toBe(false);
    if (!detection.available) {
      expect(detection.reason).toContain(CONTAINER_CLI_ENV);
      expect(detection.reason).toContain("/usr/local/bin/custom-engine");
    }

    let resolveProbeCalls = 0;
    const cli = await resolveContainerCli(() => {
      resolveProbeCalls += 1;
      return Promise.resolve(false);
    });
    expect(cli).toBe("/usr/local/bin/custom-engine");
    expect(resolveProbeCalls).toBe(0);
  });

  it("caches successful resolution", async () => {
    let probeCalls = 0;
    const probe = () => {
      probeCalls += 1;
      return Promise.resolve(true);
    };

    expect(await resolveContainerCli(probe)).toBe("docker");
    expect(await resolveContainerCli(probe)).toBe("docker");
    expect(probeCalls).toBe(1);
  });

  it("does not cache failed resolution", async () => {
    let podmanAvailable = false;
    let probeCalls = 0;
    const probe = (cli: string) => {
      probeCalls += 1;
      return Promise.resolve(cli === "podman" && podmanAvailable);
    };

    expect(await resolveContainerCli(probe)).toBe("docker");
    podmanAvailable = true;
    expect(await resolveContainerCli(probe)).toBe("podman");
    expect(probeCalls).toBe(4);
  });
});
