import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, readdirSync } from "node:fs";

const SCRIPT_PATH = resolve(
  import.meta.dir,
  "../../../scripts/create-legacy-mux-artifact-aliases.sh"
);

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "legacy-mux-artifact-aliases-"));
  tempDirs.push(dir);
  return dir;
}

function runAliasScript(
  releaseDir: string,
  env: NodeJS.ProcessEnv = process.env
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", [SCRIPT_PATH, releaseDir], {
    encoding: "utf8",
    env,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function releaseNames(releaseDir: string): string[] {
  return readdirSync(releaseDir).sort();
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("create-legacy-mux-artifact-aliases", () => {
  test("aliases lowercase xum artifacts to matching mux names", async () => {
    const releaseDir = await createTempDir();
    const canonicalName = "xum-0.28.2-arm64-mac.dmg";
    await writeFile(join(releaseDir, canonicalName), "canonical-bytes");

    const result = runAliasScript(releaseDir);
    expect(result.status).toBe(0);

    const legacyPath = join(releaseDir, "mux-0.28.2-arm64-mac.dmg");
    const legacyStat = lstatSync(legacyPath);
    expect(legacyStat.isSymbolicLink()).toBe(true);
    expect(releaseNames(releaseDir)).toEqual(["mux-0.28.2-arm64-mac.dmg", canonicalName]);
    expect(releaseNames(releaseDir).some((name) => name.startsWith("mux-Xum-"))).toBe(false);
  });

  test("maps capitalized Xum leftovers to mux-* instead of mux-Xum-*", async () => {
    const releaseDir = await createTempDir();
    await writeFile(join(releaseDir, "Xum-0.28.2-x64-linux.AppImage"), "leaked-product-name");

    const result = runAliasScript(releaseDir);
    expect(result.status).toBe(0);
    expect(releaseNames(releaseDir)).toEqual([
      "Xum-0.28.2-x64-linux.AppImage",
      "mux-0.28.2-x64-linux.AppImage",
    ]);
    expect(releaseNames(releaseDir).some((name) => /mux-[Xx]um-/.test(name))).toBe(false);

    const legacyStat = lstatSync(join(releaseDir, "mux-0.28.2-x64-linux.AppImage"));
    expect(legacyStat.isSymbolicLink()).toBe(true);
  });

  test("leaves preexisting aliases in place and falls back to a byte-identical copy", async () => {
    const releaseDir = await createTempDir();
    await writeFile(join(releaseDir, "xum-1.0.0-x64-win.exe"), "installer");
    await symlink("already-present", join(releaseDir, "mux-1.0.0-x64-win.exe"));

    const first = runAliasScript(releaseDir);
    expect(first.status).toBe(0);
    expect(releaseNames(releaseDir)).toEqual(["mux-1.0.0-x64-win.exe", "xum-1.0.0-x64-win.exe"]);

    const blockedBin = join(await createTempDir(), "blocked-bin");
    await mkdir(blockedBin);
    await writeFile(join(blockedBin, "ln"), "#!/bin/sh\nexit 1\n");
    await chmod(join(blockedBin, "ln"), 0o755);

    const copyDir = await createTempDir();
    const canonicalName = "xum-1.0.0-arm64-mac.zip";
    await writeFile(join(copyDir, canonicalName), "zip-bytes");
    const copyResult = runAliasScript(copyDir, {
      ...process.env,
      PATH: `${blockedBin}:${process.env.PATH ?? ""}`,
    });
    expect(copyResult.status).toBe(0);

    const copiedPath = join(copyDir, "mux-1.0.0-arm64-mac.zip");
    expect(lstatSync(copiedPath).isSymbolicLink()).toBe(false);
    expect(await readFile(copiedPath, "utf8")).toBe("zip-bytes");
  });
});
