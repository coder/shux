import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { DisposableTempDir } from "@/node/services/tempDir";
import { readPluginComponentImports } from "./registry";
import { createTestPluginInstallEntry } from "./testFixtures";

const legacy = createTestPluginInstallEntry("demo");
const selective = createTestPluginInstallEntry("demo", { skills: ["selected"], mcpServers: [] });

async function readRows(registryPath: string, plugins: unknown[]) {
  const content = JSON.stringify({ plugins });
  await fs.writeFile(registryPath, content);
  const result = await readPluginComponentImports(registryPath);
  expect(await fs.readFile(registryPath, "utf8")).toBe(content);
  if (result === null) throw new Error("Readable registry rows must be recovered individually");
  return result;
}

describe("readPluginComponentImports", () => {
  test.each([
    { name: "demo" },
    { ...legacy, source: { ...legacy.source, ref: "" } },
    { ...legacy, source: { ...legacy.source, ref: 42 } },
    { ...legacy, source: { ...legacy.source, refType: "invalid" } },
    { ...legacy, scope: "project" },
    { ...legacy, lockedSha: null },
    { ...legacy, installedAt: null },
    { ...legacy, importedComponents: { skills: [] } },
    { ...legacy, source: { type: "unknown" } },
  ])(
    "denies malformed named rows without suppressing healthy sibling mappings: %j",
    async (malformed) => {
      using tmp = new DisposableTempDir("plugin-registry-invalid-row");
      const registryPath = path.join(tmp.path, "plugins.json");
      const result = await readRows(registryPath, [
        malformed,
        createTestPluginInstallEntry("healthy", { skills: [], mcpServers: ["allowed"] }),
        createTestPluginInstallEntry("legacy"),
      ]);
      expect(result.hasUnidentifiedEntries).toBe(false);
      expect(result.byName.get("demo")).toEqual({ skills: [], mcpServers: [] });
      expect(result.byName.get("healthy")).toEqual({ skills: [], mcpServers: ["allowed"] });
      expect(result.byName.has("legacy")).toBe(true);
      expect(result.byName.get("legacy")).toBeUndefined();
      expect(result.byName.has("unregistered")).toBe(false);

      const repaired = await readRows(registryPath, [legacy]);
      expect(repaired.byName.has("demo")).toBe(true);
      expect(repaired.byName.get("demo")).toBeUndefined();
    }
  );

  test.each([
    [legacy, selective],
    [selective, legacy],
    [legacy, { name: "demo" }],
    [{ name: "demo" }, legacy],
    [selective, { name: "demo" }],
    [{ name: "demo" }, selective],
    [legacy, selective, legacy],
  ])("duplicate names stay denied regardless of row order: %j", async (...duplicates) => {
    using tmp = new DisposableTempDir("plugin-registry-duplicates");
    const result = await readRows(path.join(tmp.path, "plugins.json"), duplicates);
    expect(result.hasUnidentifiedEntries).toBe(false);
    expect(result.byName.get("demo")).toEqual({ skills: [], mcpServers: [] });
  });

  test("missing registry allows unmanaged directories; corrupt or unreadable documents deny until repaired", async () => {
    using tmp = new DisposableTempDir("plugin-registry-document-recovery");
    const registryPath = path.join(tmp.path, "plugins.json");
    const missing = await readPluginComponentImports(registryPath);
    expect(missing?.hasUnidentifiedEntries).toBe(false);
    expect(missing?.byName.size).toBe(0);
    for (const corrupt of ["{", "[]", "{}", '{"plugins":null}']) {
      await fs.writeFile(registryPath, corrupt);
      expect(await readPluginComponentImports(registryPath)).toBeNull();
      expect(await fs.readFile(registryPath, "utf8")).toBe(corrupt);
    }
    await fs.unlink(registryPath);
    await fs.mkdir(registryPath);
    expect(await readPluginComponentImports(registryPath)).toBeNull();
    await fs.rmdir(registryPath);
    const recovered = await readRows(registryPath, [selective]);
    expect(recovered.hasUnidentifiedEntries).toBe(false);
    expect(recovered.byName.get("demo")).toEqual(selective.importedComponents);
  });
});
