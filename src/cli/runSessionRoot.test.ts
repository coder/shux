import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Config, ProvidersConfigStore } from "@/node/config";
import {
  createRunConfig,
  prepareRunSessionRootOverride,
  replacePrivateRunConfigFile,
} from "./runSessionRoot";

describe("prepareRunSessionRootOverride", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-run-session-root-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("creates private roots and credential files under a permissive umask", async () => {
    const realConfigRoot = path.join(tempDir, "real-config");
    const overrideRoot = path.join(tempDir, "run-session");

    // This host's default umask (0077) would make these assertions pass even
    // without the hardening; pin a permissive umask so the modes are proven.
    const previousUmask = process.umask(0o022);
    try {
      await using preparedRoot = await prepareRunSessionRootOverride(
        { XUM_RUN_SESSION_ROOT: overrideRoot },
        realConfigRoot
      );
      expect(preparedRoot?.path).toBe(overrideRoot);
      const providersFile = path.join(overrideRoot, "providers.jsonc");
      await replacePrivateRunConfigFile(providersFile, "{}", preparedRoot);

      expect((await fs.stat(overrideRoot)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(providersFile)).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  test("keeps private config out of a pinned telemetry root", async () => {
    const realConfigRoot = path.join(tempDir, "real-config");
    const telemetryRoot = path.join(tempDir, "telemetry-root");
    const privateConfigRoot = path.join(tempDir, "private-config");
    await fs.mkdir(privateConfigRoot);
    await using preparedRoot = await prepareRunSessionRootOverride(
      { MUX_RUN_SESSION_ROOT: telemetryRoot },
      realConfigRoot
    );
    const config = await createRunConfig(privateConfigRoot, preparedRoot);

    await replacePrivateRunConfigFile(
      path.join(config.rootDir, "providers.jsonc"),
      JSON.stringify({ openai: { apiKey: "provider-key" } })
    );
    await replacePrivateRunConfigFile(
      path.join(config.rootDir, "secrets.json"),
      JSON.stringify({ token: "secret-value" })
    );
    const sessionDir = path.join(config.sessionsDir, "workspace-1");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, "chat.jsonl"), "chat");
    await fs.writeFile(path.join(sessionDir, "session-usage.json"), "usage");

    const telemetryFiles = await fs.readdir(telemetryRoot);
    expect(telemetryFiles).not.toContain("providers.jsonc");
    expect(telemetryFiles).not.toContain("secrets.json");
    expect(await fs.readFile(path.join(privateConfigRoot, "providers.jsonc"), "utf8")).toContain(
      "provider-key"
    );
    expect(await fs.readFile(path.join(privateConfigRoot, "secrets.json"), "utf8")).toContain(
      "secret-value"
    );
    expect(
      await fs.readFile(path.join(telemetryRoot, "sessions/workspace-1/chat.jsonl"), "utf8")
    ).toBe("chat");
    expect(
      await fs.readFile(path.join(telemetryRoot, "sessions/workspace-1/session-usage.json"), "utf8")
    ).toBe("usage");
  });

  test("rejects symlinked credential files without overwriting their targets", async () => {
    const runRoot = path.join(tempDir, "run-session");
    const targetFile = path.join(tempDir, "dataset-readable.json");
    const providersFile = path.join(runRoot, "providers.jsonc");
    await fs.mkdir(runRoot);
    await fs.writeFile(targetFile, "dataset content");
    await fs.symlink(targetFile, providersFile);

    let error: unknown;
    try {
      await replacePrivateRunConfigFile(providersFile, "copied credentials");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(await fs.readFile(targetFile, "utf8")).toBe("dataset content");
    expect((await fs.lstat(providersFile)).isSymbolicLink()).toBe(true);
  });

  test("removes stale credential files when the real configuration is empty", async () => {
    const runRoot = path.join(tempDir, "run-session");
    await fs.mkdir(runRoot);

    for (const fileName of ["providers.jsonc", "secrets.json"]) {
      const credentialFile = path.join(runRoot, fileName);
      await fs.writeFile(credentialFile, "stale credentials");

      await replacePrivateRunConfigFile(credentialFile, undefined);

      const exists = await fs
        .access(credentialFile)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    }
  });

  test.skipIf(process.platform !== "linux")(
    "keeps config reloads pinned when the session root path is replaced",
    async () => {
      const realConfigRoot = path.join(tempDir, "real-config");
      const runRoot = path.join(tempDir, "run-session");
      const movedRoot = path.join(tempDir, "secured-session");
      await fs.mkdir(runRoot);
      await using preparedRoot = await prepareRunSessionRootOverride(
        { XUM_RUN_SESSION_ROOT: runRoot },
        realConfigRoot
      );
      if (preparedRoot === undefined) {
        throw new Error("Expected a prepared run session root");
      }
      const config = new Config(preparedRoot.resolveConfigRootPath());
      const providersFile = path.join(config.rootDir, "providers.jsonc");
      await replacePrivateRunConfigFile(
        providersFile,
        JSON.stringify({ openai: { apiKey: "copied-key", baseUrl: "https://safe.example" } }),
        preparedRoot
      );
      await config.editConfig((current) => {
        current.projects.set("/trusted-project", { workspaces: [], trusted: true });
        return current;
      });

      await fs.rename(runRoot, movedRoot);
      await fs.mkdir(runRoot);
      await fs.writeFile(
        path.join(runRoot, "providers.jsonc"),
        JSON.stringify({ openai: { apiKey: "attacker-key", baseUrl: "https://attacker.example" } })
      );

      expect(new ProvidersConfigStore(config.rootDir).loadProvidersConfig()?.openai?.baseUrl).toBe(
        "https://safe.example"
      );
      expect(config.loadConfigOrDefault().projects.get("/trusted-project")?.trusted).toBe(true);
      const replacementProviders = JSON.parse(
        await fs.readFile(path.join(runRoot, "providers.jsonc"), "utf8")
      ) as { openai: { baseUrl: string } };
      expect(replacementProviders.openai.baseUrl).toBe("https://attacker.example");
      expect(
        JSON.parse(await fs.readFile(path.join(movedRoot, "providers.jsonc"), "utf8"))
      ).toEqual({
        openai: { apiKey: "copied-key", baseUrl: "https://safe.example" },
      });
    }
  );

  test("fails closed for replaced override roots when parent-relative writes are unavailable", async () => {
    const realConfigRoot = path.join(tempDir, "real-config");
    const runRoot = path.join(tempDir, "run-session");
    const movedRoot = path.join(tempDir, "secured-session");
    await fs.mkdir(runRoot);
    await using preparedRoot = await prepareRunSessionRootOverride(
      { XUM_RUN_SESSION_ROOT: runRoot },
      realConfigRoot,
      { platform: "darwin" }
    );
    if (preparedRoot === undefined) {
      throw new Error("Expected a prepared run session root");
    }

    await fs.rename(runRoot, movedRoot);
    await fs.mkdir(runRoot);
    const providersFile = path.join(runRoot, "providers.jsonc");

    let error: unknown;
    try {
      await replacePrivateRunConfigFile(providersFile, "copied credentials", preparedRoot);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const replacementHasCredentials = await fs
      .access(providersFile)
      .then(() => true)
      .catch(() => false);
    expect(replacementHasCredentials).toBe(false);
    const originalHasCredentials = await fs
      .access(path.join(movedRoot, "providers.jsonc"))
      .then(() => true)
      .catch(() => false);
    expect(originalHasCredentials).toBe(false);
  });

  test("rejects foreign-owned roots before changing their permissions", async () => {
    const realConfigRoot = path.join(tempDir, "real-config");
    const overrideRoot = path.join(tempDir, "run-session");
    const peerFile = path.join(tempDir, "peer.txt");
    const previousUmask = process.umask(0o022);
    let error: unknown;
    try {
      await fs.mkdir(overrideRoot, { mode: 0o755 });
      await fs.chmod(overrideRoot, 0o755);
      await fs.writeFile(peerFile, "peer", { mode: 0o644 });
      await fs.chmod(peerFile, 0o644);

      const preparedRoot = await prepareRunSessionRootOverride(
        { XUM_RUN_SESSION_ROOT: overrideRoot },
        realConfigRoot,
        { platform: "linux", effectiveUid: 1000, getOwnerUid: () => 2000 }
      );
      await preparedRoot?.[Symbol.asyncDispose]();
    } catch (caught) {
      error = caught;
    } finally {
      process.umask(previousUmask);
    }

    expect(error).toBeInstanceOf(Error);
    expect((await fs.stat(overrideRoot)).mode & 0o777).toBe(0o755);
    expect((await fs.stat(peerFile)).mode & 0o777).toBe(0o644);
  });

  test("tightens a pre-existing override root", async () => {
    const realConfigRoot = path.join(tempDir, "real-config");
    const overrideRoot = path.join(tempDir, "run-session");
    await fs.mkdir(realConfigRoot);
    await fs.mkdir(overrideRoot, { mode: 0o755 });
    await fs.chmod(overrideRoot, 0o755);

    await using preparedRoot = await prepareRunSessionRootOverride(
      { XUM_RUN_SESSION_ROOT: overrideRoot },
      realConfigRoot
    );

    expect(preparedRoot?.path).toBe(overrideRoot);
    expect((await fs.stat(overrideRoot)).mode & 0o777).toBe(0o700);
  });

  test("rejects a symlinked override without chmodding its target", async () => {
    const realConfigRoot = path.join(tempDir, "real-config");
    const targetRoot = path.join(tempDir, "attacker-target");
    const overrideRoot = path.join(tempDir, "run-session");
    await fs.mkdir(targetRoot, { mode: 0o755 });
    await fs.chmod(targetRoot, 0o755);
    await fs.symlink(targetRoot, overrideRoot, "dir");

    let error: unknown;
    try {
      await prepareRunSessionRootOverride({ XUM_RUN_SESSION_ROOT: overrideRoot }, realConfigRoot);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((await fs.stat(targetRoot)).mode & 0o777).toBe(0o755);
    expect((await fs.lstat(overrideRoot)).isSymbolicLink()).toBe(true);
  });

  test("rejects an override that canonically resolves to the real config root", async () => {
    const realConfigRoot = path.join(tempDir, "real-config");
    await fs.mkdir(realConfigRoot);
    const alias = path.join(realConfigRoot, "..", path.basename(realConfigRoot));

    let error: unknown;
    try {
      await prepareRunSessionRootOverride({ XUM_RUN_SESSION_ROOT: alias }, realConfigRoot);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("must not resolve to the Xum config root");
  });
});
