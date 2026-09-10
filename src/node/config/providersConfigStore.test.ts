import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ProvidersConfigStore } from "./providersConfigStore";

describe("ProvidersConfigStore", () => {
  let tempDir: string;
  let store: ProvidersConfigStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-providers-config-test-"));
    store = new ProvidersConfigStore(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null when providers.jsonc does not exist", () => {
    expect(store.loadProvidersConfig()).toBeNull();
    expect(store.getProvidersFileFingerprint()).toBeNull();
  });

  it("saves and loads providers config with comments", () => {
    store.saveProvidersConfig({
      openai: { apiKey: "sk-test-key" },
    });

    const loaded = store.loadProvidersConfig();
    expect(loaded?.openai?.apiKey).toBe("sk-test-key");

    const content = fs.readFileSync(store.providersFile, "utf-8");
    expect(content).toContain("// Providers configuration for xum");
    expect(content).toContain('"apiKey": "sk-test-key"');

    const fingerprint = store.getProvidersFileFingerprint();
    expect(fingerprint).not.toBeNull();
    expect(typeof fingerprint).toBe("string");
  });

  it("watches providers file for external changes", async () => {
    let triggered = false;
    const cleanup = store.watchProvidersFile(() => {
      triggered = true;
    });

    try {
      fs.writeFileSync(
        store.providersFile,
        JSON.stringify({ anthropic: { apiKey: "sk-ant-test" } })
      );
      for (let i = 0; i < 20; i++) {
        if (triggered) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(triggered).toBe(true);
    } finally {
      cleanup();
    }
  });
});
