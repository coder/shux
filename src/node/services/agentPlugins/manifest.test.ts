import { describe, expect, test } from "bun:test";

import { AGENT_PLUGIN_SCHEMA_ID_1_0_0, validatePluginManifest } from "./manifest";

function minimalManifest(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
    name: "hello-plugin",
    ...overrides,
  };
}

describe("validatePluginManifest", () => {
  test("accepts a minimal valid manifest", () => {
    const result = validatePluginManifest(minimalManifest());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.manifest.name).toBe("hello-plugin");
    expect(result.manifest.schemaId).toBe(AGENT_PLUGIN_SCHEMA_ID_1_0_0);
    expect(result.warnings).toEqual([]);
  });

  test("accepts a full manifest and carries fields through", () => {
    const result = validatePluginManifest(
      minimalManifest({
        version: "1.2.3",
        description: "A test plugin",
        author: { name: "Ada", email: "ada@example.com", url: "https://example.com" },
        homepage: "https://example.com",
        repository: "https://github.com/example/hello-plugin",
        license: "MIT",
        keywords: ["testing", "example"],
        extensions: { "com.example.tool": { anything: [1, 2, 3] } },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.manifest).toEqual({
      schemaId: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
      name: "hello-plugin",
      version: "1.2.3",
      description: "A test plugin",
      author: { name: "Ada", email: "ada@example.com", url: "https://example.com" },
      homepage: "https://example.com",
      repository: "https://github.com/example/hello-plugin",
      license: "MIT",
      keywords: ["testing", "example"],
      // Carried through opaquely for Mux namespace consumers (plugin hooks).
      extensions: { "com.example.tool": { anything: [1, 2, 3] } },
    });
    expect(result.warnings).toEqual([]);
  });

  test("accepts names with dots and hyphens", () => {
    for (const name of ["a", "a.b-c", "plugin.v2", "0-day.9"]) {
      const result = validatePluginManifest(minimalManifest({ name }));
      expect(result.ok).toBe(true);
    }
  });

  test("unknown top-level fields load with a warning and are ignored", () => {
    const result = validatePluginManifest(minimalManifest({ hooks: { pre: "x" } }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("hooks");
    expect(result.manifest).not.toHaveProperty("hooks");
  });

  test("non-object extensions loads with a warning and is ignored", () => {
    for (const extensions of ["nope", 5, [1, 2], null]) {
      const result = validatePluginManifest(minimalManifest({ extensions }));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.warnings.some((w) => w.includes("extensions"))).toBe(true);
    }
  });

  test("object extensions are carried through for namespace consumers", () => {
    const extensions = { mux: { hooks: { tools: ["file_read"] } } };
    const result = validatePluginManifest(minimalManifest({ extensions }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.manifest.extensions).toEqual(extensions);
  });

  test("extension namespace member contents are never validated", () => {
    // The canonical JSON Schema types namespace members as objects, but the
    // normative text says clients never validate namespace contents (§8.1).
    const result = validatePluginManifest(
      minimalManifest({ extensions: { "com.example.weird": "not-an-object" } })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.warnings).toEqual([]);
  });

  test("rejects missing or invalid name as invalid-manifest", () => {
    const badNames: unknown[] = [
      undefined,
      42,
      "",
      "-starts-with-hyphen",
      "ends-with-hyphen-",
      "Has-Uppercase",
      "double--hyphen",
      "double..dot",
      ".starts-with-dot",
      "a".repeat(65),
    ];
    for (const name of badNames) {
      const manifest = minimalManifest();
      if (name === undefined) {
        delete manifest.name;
      } else {
        manifest.name = name;
      }
      const result = validatePluginManifest(manifest);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected rejection");
      expect(result.reason).toBe("invalid-manifest");
    }
  });

  test("accepts a 64-char name and rejects a 65-char name", () => {
    const okResult = validatePluginManifest(minimalManifest({ name: "a".repeat(64) }));
    expect(okResult.ok).toBe(true);

    const tooLong = validatePluginManifest(minimalManifest({ name: "a".repeat(65) }));
    expect(tooLong.ok).toBe(false);
  });

  test("rejects unrecognized $schema as unsupported-version", () => {
    for (const schema of [
      "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json",
      "https://example.com/other.schema.json",
      "not-a-url",
    ]) {
      const result = validatePluginManifest(minimalManifest({ $schema: schema }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected rejection");
      expect(result.reason).toBe("unsupported-version");
    }
  });

  test("rejects missing or non-string $schema as invalid-manifest", () => {
    for (const schema of [undefined, 42, null, ["x"]]) {
      const manifest = minimalManifest();
      if (schema === undefined) {
        delete manifest.$schema;
      } else {
        manifest.$schema = schema;
      }
      const result = validatePluginManifest(manifest);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected rejection");
      expect(result.reason).toBe("invalid-manifest");
    }
  });

  test("rejects wrong-typed permitted fields as invalid-manifest", () => {
    const badFields: Array<Record<string, unknown>> = [
      { version: 5 },
      { description: ["x"] },
      { homepage: 1 },
      { repository: {} },
      { license: null },
      { keywords: "not-an-array" },
      { keywords: [1, 2] },
      { author: "string-author" },
      { author: { name: 5 } },
      { author: { name: "x", unknownKey: "y" } },
    ];
    for (const fields of badFields) {
      const result = validatePluginManifest(minimalManifest(fields));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`expected rejection for ${JSON.stringify(fields)}`);
      expect(result.reason).toBe("invalid-manifest");
    }
  });

  test("round-trips a contributes block with every member", () => {
    const contributes = {
      skills: "my-skills",
      mcp: "config/mcp.json",
      agents: "my-agents",
      workflows: "scripts",
      hooks: "lib/hooks.js",
      slashCommands: [
        { name: "greet", description: "Say hello", expansion: "Please greet the user warmly." },
        { name: "review", expansion: "Review the current diff." },
      ],
    };
    const result = validatePluginManifest(minimalManifest({ contributes }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.manifest.contributes).toEqual(contributes);
    expect(result.warnings).toEqual([]);
  });

  test("non-object contributes loads with a warning and is ignored", () => {
    for (const contributes of ["nope", 5, [1], null]) {
      const result = validatePluginManifest(minimalManifest({ contributes }));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.warnings.some((w) => w.includes("contributes"))).toBe(true);
      expect(result.manifest.contributes).toBeUndefined();
    }
  });

  test("unsafe contributes paths warn and fall back to the default location", () => {
    for (const skills of ["/abs/path", "C:\\win", "~/home", "../escape", "a/../../b", "", 42]) {
      const result = validatePluginManifest(minimalManifest({ contributes: { skills } }));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.warnings.some((w) => w.includes("contributes.skills"))).toBe(true);
      expect(result.manifest.contributes?.skills).toBeUndefined();
    }
  });

  test("invalid slash command entries are skipped without breaking valid siblings", () => {
    const result = validatePluginManifest(
      minimalManifest({
        contributes: {
          slashCommands: [
            "not-an-object",
            { name: "Bad Name", expansion: "x" },
            { name: "no-expansion" },
            { name: "blank-expansion", expansion: "   " },
            { name: "bad-description", expansion: "x", description: 5 },
            { name: "ok", expansion: "works" },
            { name: "ok", expansion: "duplicate loses" },
          ],
        },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.manifest.contributes?.slashCommands).toEqual([
      { name: "ok", expansion: "works" },
    ]);
    expect(result.warnings.length).toBeGreaterThanOrEqual(6);
  });

  test("rejects non-object documents as invalid-manifest", () => {
    for (const raw of [null, "string", 42, ["array"], true]) {
      const result = validatePluginManifest(raw);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected rejection");
      expect(result.reason).toBe("invalid-manifest");
    }
  });
});
