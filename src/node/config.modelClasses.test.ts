import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Config } from "@/node/config";

describe("Config model classes persistence", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-model-classes-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("updateModelClass fails loudly when the write cannot be verified", async () => {
    const config = new Config(tempDir);
    await config.updateModelClass("small", "haiku+0");
    expect(config.loadConfigOrDefault().modelClasses).toEqual({ small: "haiku+0" });

    // saveConfig swallows write errors; the strict read-back must reject
    // instead of letting the editor publish an unpersisted value as truth.
    const original = config.loadConfigOrDefault.bind(config);
    let threwOnce = false;
    const loadSpy = spyOn(config, "loadConfigOrDefault").mockImplementation(((options?: {
      throwOnError?: boolean;
    }) => {
      if (options?.throwOnError && !threwOnce) {
        threwOnce = true;
        throw new Error("transient read failure");
      }
      return original(options);
    }) as typeof config.loadConfigOrDefault);
    try {
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun's expect(...).rejects returns a thenable the rule cannot see
      await expect(config.updateModelClass("small", "sonnet+1")).rejects.toThrow(
        /verify the model class/
      );
    } finally {
      loadSpy.mockRestore();
    }
  });

  it("merges per entry: other classes survive edits and deletes", async () => {
    const config = new Config(tempDir);
    // "my-local-llm" has no provider prefix (unparseable to this build) —
    // it must survive verbatim because the backend only touches the edited
    // key, never re-serializing the map from a client snapshot.
    await config.editConfig((cfg) => ({
      ...cfg,
      modelClasses: { small: "haiku+0", tiny: "my-local-llm" },
    }));

    await config.updateModelClass("large", "anthropic:claude-fable-5+max");
    expect(config.loadConfigOrDefault().modelClasses).toEqual({
      small: "haiku+0",
      tiny: "my-local-llm",
      large: "anthropic:claude-fable-5+max",
    });

    await config.updateModelClass("small", null);
    expect(config.loadConfigOrDefault().modelClasses).toEqual({
      tiny: "my-local-llm",
      large: "anthropic:claude-fable-5+max",
    });

    // Clearing the last entries drops the map entirely (no empty object
    // left behind in config.json).
    await config.updateModelClass("tiny", null);
    await config.updateModelClass("large", null);
    expect(config.loadConfigOrDefault().modelClasses).toBeUndefined();
  });

  it("concurrent edits of different classes both persist", async () => {
    // The review scenario behind the per-entry RPC: two live Settings
    // consumers dispatch simultaneously. Full-map replacement snapshots
    // would let the later serialized write delete the earlier consumer's
    // entry; the transactional merge must keep both.
    const config = new Config(tempDir);
    await Promise.all([
      config.updateModelClass("small", "haiku+0"),
      config.updateModelClass("large", "anthropic:claude-fable-5+max"),
    ]);
    expect(config.loadConfigOrDefault().modelClasses).toEqual({
      small: "haiku+0",
      large: "anthropic:claude-fable-5+max",
    });
  });

  it("round-trips modelClasses and skillModelClasses through editConfig saves", async () => {
    const config = new Config(tempDir);
    await config.editConfig((cfg) => ({
      ...cfg,
      modelClasses: { small: "haiku+0", large: "anthropic:claude-fable-5+max" },
      skillModelClasses: { done: "small" },
    }));

    // A fresh instance re-reads from disk: the fields must survive the
    // whitelist-based saveConfig serialization.
    const reloaded = new Config(tempDir).loadConfigOrDefault();
    expect(reloaded.modelClasses).toEqual({
      small: "haiku+0",
      large: "anthropic:claude-fable-5+max",
    });
    expect(reloaded.skillModelClasses).toEqual({ done: "small" });

    // An unrelated edit (another full save cycle) must not strip them.
    const second = new Config(tempDir);
    await second.editConfig((cfg) => ({ ...cfg, defaultModel: "anthropic:claude-opus-5" }));
    const reloadedAgain = new Config(tempDir).loadConfigOrDefault();
    expect(reloadedAgain.modelClasses?.small).toBe("haiku+0");
    expect(reloadedAgain.skillModelClasses?.done).toBe("small");
  });

  it("drops non-string entries on load instead of failing (self-healing)", async () => {
    await fs.writeFile(
      path.join(tempDir, "config.json"),
      JSON.stringify({
        projects: [],
        modelClasses: { small: "haiku+0", bad: 42 },
        skillModelClasses: 7,
      })
    );

    const loaded = new Config(tempDir).loadConfigOrDefault();
    expect(loaded.modelClasses).toEqual({ small: "haiku+0" });
    expect(loaded.skillModelClasses).toBeUndefined();
  });
});
