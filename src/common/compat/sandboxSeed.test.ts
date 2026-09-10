import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { chooseSeedSources, listSandboxSeedCandidateRoots } from "../../../scripts/sandboxUtils";

const tempDirs: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("sandbox seed selection", () => {
  test("lists explicit XUM_ROOT before leftover MUX_ROOT and home fallbacks", () => {
    const homeDir = "/tmp/fake-home";
    const roots = listSandboxSeedCandidateRoots({
      env: { XUM_ROOT: "/canonical", MUX_ROOT: "/legacy" },
      homeDir,
    });

    expect(roots.slice(0, 2)).toEqual(["/canonical", "/legacy"]);
    expect(roots).toContain(path.join(homeDir, ".xum-dev"));
    expect(roots).toContain(path.join(homeDir, ".xum"));
    expect(roots).toContain(path.join(homeDir, ".mux-dev"));
    expect(roots).toContain(path.join(homeDir, ".mux"));
    expect(roots).toContain(path.join(homeDir, ".cmux"));
  });

  test("SEED_XUM_ROOT wins over leftover SEED_MUX_ROOT and only looks there", async () => {
    const canonical = await makeTempRoot("xum-seed-canonical-");
    const leftover = await makeTempRoot("xum-seed-legacy-");
    await fs.writeFile(path.join(canonical, "config.json"), "{}");
    await fs.writeFile(path.join(leftover, "config.json"), "{}");
    await fs.writeFile(path.join(leftover, "providers.jsonc"), "{}");

    const sources = chooseSeedSources({
      env: { SEED_XUM_ROOT: canonical, SEED_MUX_ROOT: leftover },
      homeDir: await makeTempRoot("xum-seed-home-"),
    });

    expect(sources.configPath).toBe(path.join(canonical, "config.json"));
    expect(sources.providersPath).toBeNull();
  });

  test("falls back to leftover MUX_ROOT when XUM_ROOT has no seed files", async () => {
    const xumRoot = await makeTempRoot("xum-root-empty-");
    const muxRoot = await makeTempRoot("mux-root-seed-");
    await fs.writeFile(path.join(muxRoot, "providers.jsonc"), "{}");

    const sources = chooseSeedSources({
      env: { XUM_ROOT: xumRoot, MUX_ROOT: muxRoot },
      homeDir: await makeTempRoot("xum-seed-home-"),
    });

    expect(sources.providersPath).toBe(path.join(muxRoot, "providers.jsonc"));
  });
});
