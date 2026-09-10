import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { secretsToRecord } from "@/common/types/secrets";
import { SecretsStore } from "./secretsStore";

describe("SecretsStore", () => {
  let tempDir: string;
  let secretsStore: SecretsStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-secrets-test-"));
    secretsStore = new SecretsStore(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("secrets", () => {
    it("supports global secrets stored under a sentinel key", async () => {
      await secretsStore.updateGlobalSecrets([{ key: "GLOBAL_A", value: "1" }]);

      expect(secretsStore.getGlobalSecrets()).toEqual([{ key: "GLOBAL_A", value: "1" }]);

      const raw = fs.readFileSync(path.join(tempDir, "secrets.json"), "utf-8");
      const parsed = JSON.parse(raw) as { __global__?: unknown };
      expect(parsed.__global__).toEqual([{ key: "GLOBAL_A", value: "1" }]);
    });

    it("preserves unsupported legacy entries on disk when saving unrelated secrets", async () => {
      const secretsFile = path.join(tempDir, "secrets.json");
      const legacyEntry = { key: "LEGACY_OP", value: { op: "op://Vault/Item/field" } };
      fs.writeFileSync(
        secretsFile,
        JSON.stringify({
          __global__: [legacyEntry, { key: "KEEP", value: "kept" }],
          "/other/project": [legacyEntry],
        })
      );

      // Legacy entries are hidden from runtime/UI views...
      expect(secretsStore.getGlobalSecrets()).toEqual([{ key: "KEEP", value: "kept" }]);

      await secretsStore.updateGlobalSecrets([
        { key: "KEEP", value: "kept" },
        { key: "NEW", value: "added" },
      ]);

      // ...but survive on disk so a downgrade can still read them, in both the
      // updated bucket and untouched buckets.
      const parsed = JSON.parse(fs.readFileSync(secretsFile, "utf-8")) as Record<string, unknown>;
      expect(parsed.__global__).toEqual([
        { key: "KEEP", value: "kept" },
        { key: "NEW", value: "added" },
        legacyEntry,
      ]);
      expect(parsed["/other/project"]).toEqual([legacyEntry]);
    });

    it("drops a preserved legacy entry when an update reuses its key", async () => {
      const secretsFile = path.join(tempDir, "secrets.json");
      fs.writeFileSync(
        secretsFile,
        JSON.stringify({
          __global__: [{ key: "TOKEN", value: { op: "op://Vault/Item/field" } }],
        })
      );

      await secretsStore.updateGlobalSecrets([{ key: "TOKEN", value: "replaced" }]);

      const parsed = JSON.parse(fs.readFileSync(secretsFile, "utf-8")) as Record<string, unknown>;
      expect(parsed.__global__).toEqual([{ key: "TOKEN", value: "replaced" }]);
    });

    it("preserves legacy entries from trailing-slash duplicate project buckets", async () => {
      const secretsFile = path.join(tempDir, "secrets.json");
      const legacyEntry = { key: "LEGACY_OP", value: { op: "op://Vault/Item/field" } };
      fs.writeFileSync(secretsFile, JSON.stringify({ "/repo/": [legacyEntry] }));

      await secretsStore.updateProjectSecrets("/repo", [{ key: "NEW", value: "added" }]);

      const parsed = JSON.parse(fs.readFileSync(secretsFile, "utf-8")) as Record<string, unknown>;
      expect(parsed["/repo/"]).toBeUndefined();
      expect(parsed["/repo"]).toEqual([{ key: "NEW", value: "added" }, legacyEntry]);
    });

    it("does not inherit global secrets by default", async () => {
      await secretsStore.updateGlobalSecrets([
        { key: "TOKEN", value: "global" },
        { key: "A", value: "1" },
      ]);

      const projectPath = "/fake/project";
      await secretsStore.updateProjectSecrets(projectPath, [
        { key: "TOKEN", value: "project" },
        { key: "B", value: "2" },
      ]);

      const effective = secretsStore.getEffectiveSecrets(projectPath);
      const record = await secretsToRecord(effective);

      expect(record).toEqual({
        TOKEN: "project",
        B: "2",
      });
    });

    it("injects global secrets with injectAll into any project's effective secrets", async () => {
      await secretsStore.updateGlobalSecrets([
        { key: "INJECTED", value: "everywhere", injectAll: true },
        { key: "STORED_ONLY", value: "shared" },
      ]);

      const record = await secretsToRecord(secretsStore.getEffectiveSecrets("/fake/project"));
      expect(record).toEqual({
        INJECTED: "everywhere",
      });
    });

    it("project secrets override injectAll global secrets", async () => {
      await secretsStore.updateGlobalSecrets([{ key: "TOKEN", value: "global", injectAll: true }]);

      const projectPath = "/fake/project";
      await secretsStore.updateProjectSecrets(projectPath, [{ key: "TOKEN", value: "project" }]);

      const record = await secretsToRecord(secretsStore.getEffectiveSecrets(projectPath));
      expect(record).toEqual({
        TOKEN: "project",
      });
    });

    it("injects injectAll globals alongside project-specific secrets", async () => {
      await secretsStore.updateGlobalSecrets([
        { key: "GLOBAL_TOKEN", value: "global", injectAll: true },
      ]);

      const projectPath = "/fake/project";
      await secretsStore.updateProjectSecrets(projectPath, [
        { key: "LOCAL_TOKEN", value: "local" },
      ]);

      const record = await secretsToRecord(secretsStore.getEffectiveSecrets(projectPath));
      expect(record).toEqual({
        GLOBAL_TOKEN: "global",
        LOCAL_TOKEN: "local",
      });
    });

    it("returns only globally injected secrets for project settings visibility", async () => {
      await secretsStore.updateGlobalSecrets([
        { key: "GLOBAL_VISIBLE", value: "v", injectAll: true },
        { key: "GLOBAL_HIDDEN", value: "h" },
        { key: "SHARED", value: "global", injectAll: true },
      ]);

      const projectPath = "/fake/project";
      await secretsStore.updateProjectSecrets(projectPath, [
        { key: "LOCAL_ONLY", value: "local" },
        { key: "SHARED", value: "project" },
      ]);

      expect(secretsStore.getInjectedGlobalSecrets(projectPath)).toEqual([
        { key: "GLOBAL_VISIBLE", value: "v" },
      ]);
    });

    it("does not inject global secrets unless injectAll is true", async () => {
      await secretsStore.updateGlobalSecrets([
        { key: "A", value: "1", injectAll: false },
        { key: "B", value: "2" },
        { key: "C", value: "3", injectAll: true },
      ]);

      const record = await secretsToRecord(secretsStore.getEffectiveSecrets("/fake/project"));
      expect(record).toEqual({
        C: "3",
      });
    });

    it("uses last global duplicate to decide injectAll behavior", async () => {
      await secretsStore.updateGlobalSecrets([
        { key: "DUP", value: "first", injectAll: true },
        { key: "DUP", value: "second", injectAll: false },
      ]);

      expect(await secretsToRecord(secretsStore.getEffectiveSecrets("/fake/project"))).toEqual({});

      await secretsStore.updateGlobalSecrets([
        { key: "DUP", value: "first", injectAll: false },
        { key: "DUP", value: "second", injectAll: true },
      ]);

      expect(await secretsToRecord(secretsStore.getEffectiveSecrets("/fake/project"))).toEqual({
        DUP: "second",
      });
    });

    it('resolves project secret aliases to global secrets via {secret:"KEY"}', async () => {
      await secretsStore.updateGlobalSecrets([{ key: "GLOBAL_TOKEN", value: "abc" }]);

      const projectPath = "/fake/project";
      await secretsStore.updateProjectSecrets(projectPath, [
        { key: "TOKEN", value: { secret: "GLOBAL_TOKEN" } },
      ]);

      const record = await secretsToRecord(secretsStore.getEffectiveSecrets(projectPath));
      expect(record).toEqual({
        TOKEN: "abc",
      });
    });

    it("resolves same-key project secret references to global values", async () => {
      await secretsStore.updateGlobalSecrets([{ key: "OPENAI_API_KEY", value: "abc" }]);

      const projectPath = "/fake/project";
      await secretsStore.updateProjectSecrets(projectPath, [
        { key: "OPENAI_API_KEY", value: { secret: "OPENAI_API_KEY" } },
      ]);

      const record = await secretsToRecord(secretsStore.getEffectiveSecrets(projectPath));
      expect(record).toEqual({
        OPENAI_API_KEY: "abc",
      });
    });

    it("omits missing referenced secrets when resolving secretsToRecord", async () => {
      const record = await secretsToRecord([
        { key: "GLOBAL", value: "1" },
        { key: "A", value: { secret: "MISSING" } },
      ]);

      expect(record).toEqual({ GLOBAL: "1" });
    });

    it("omits cyclic secret references when resolving secretsToRecord", async () => {
      const record = await secretsToRecord([
        { key: "A", value: { secret: "B" } },
        { key: "B", value: { secret: "A" } },
        { key: "OK", value: "y" },
      ]);

      expect(record).toEqual({ OK: "y" });
    });

    it("resolves mixed literal and { secret } values", async () => {
      const record = await secretsToRecord([
        { key: "LITERAL", value: "raw" },
        { key: "GLOBAL_TOKEN", value: "abc" },
        { key: "ALIAS", value: { secret: "GLOBAL_TOKEN" } },
      ]);

      expect(record).toEqual({
        LITERAL: "raw",
        GLOBAL_TOKEN: "abc",
        ALIAS: "abc",
      });
    });
    it("normalizes project paths so trailing slashes don't split secrets", async () => {
      const projectPath = "/repo";
      const projectPathWithSlash = "/repo/";

      await secretsStore.updateProjectSecrets(projectPathWithSlash, [{ key: "A", value: "1" }]);

      expect(secretsStore.getProjectSecrets(projectPath)).toEqual([{ key: "A", value: "1" }]);
      expect(secretsStore.getProjectSecrets(projectPathWithSlash)).toEqual([
        { key: "A", value: "1" },
      ]);

      const raw = fs.readFileSync(path.join(tempDir, "secrets.json"), "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed[projectPath]).toEqual([{ key: "A", value: "1" }]);
      expect(parsed[projectPathWithSlash]).toBeUndefined();
    });

    it("treats malformed store shapes as empty arrays", () => {
      const secretsFile = path.join(tempDir, "secrets.json");
      fs.writeFileSync(
        secretsFile,
        JSON.stringify({
          __global__: { key: "NOPE", value: "1" },
          "/repo": "not-an-array",
          "/repo/": [{ key: "A", value: "1" }, null, { key: 123, value: "x" }],
        })
      );

      expect(secretsStore.getGlobalSecrets()).toEqual([]);
      expect(secretsStore.getProjectSecrets("/repo")).toEqual([{ key: "A", value: "1" }]);
    });
    it("sanitizes malformed injectAll values without dropping valid secrets", async () => {
      const projectPath = "/repo";
      const secretsFile = path.join(tempDir, "secrets.json");
      fs.writeFileSync(
        secretsFile,
        JSON.stringify({
          __global__: [{ key: "GLOBAL_TOKEN", value: "abc", injectAll: "true" }],
          [projectPath]: [{ key: "TOKEN", value: { secret: "GLOBAL_TOKEN" } }],
        })
      );

      expect(secretsStore.getGlobalSecrets()).toEqual([{ key: "GLOBAL_TOKEN", value: "abc" }]);
      expect(await secretsToRecord(secretsStore.getEffectiveSecrets(projectPath))).toEqual({
        TOKEN: "abc",
      });
    });
  });
});
