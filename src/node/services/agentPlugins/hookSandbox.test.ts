import { describe, expect, test } from "bun:test";
import { LEAST_PRIVILEGE_GRANTS } from "@/common/types/capabilityGrants";
import type { AgentPluginManifest } from "./manifest";
import { parseHookOutput, parseLoadedHookNames, resolvePluginHookGrants } from "./hookSandbox";

function manifestWith(extensions?: Record<string, unknown>): AgentPluginManifest {
  return {
    schemaId: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "test-plugin",
    ...(extensions !== undefined ? { extensions } : {}),
  };
}

describe("resolvePluginHookGrants", () => {
  test("defaults to least privilege without a capability request", () => {
    expect(resolvePluginHookGrants(manifestWith())).toEqual(LEAST_PRIVILEGE_GRANTS);
    expect(resolvePluginHookGrants(manifestWith({ other: { hooks: true } }))).toEqual(
      LEAST_PRIVILEGE_GRANTS
    );
  });

  test("honors extensions.mux.hooks.tools with sorted, deduped names", () => {
    const grants = resolvePluginHookGrants(
      manifestWith({ mux: { hooks: { tools: ["file_read", "bash", "file_read"] } } })
    );
    expect(grants.bridgeTools).toEqual({ allow: ["bash", "file_read"] });
    // v1: tool grants never widen the sandbox capability surface.
    expect(grants.vars).toBe(false);
    expect(grants.hostEvents).toBe(false);
  });

  test("malformed capability requests resolve to least privilege", () => {
    expect(resolvePluginHookGrants(manifestWith({ mux: "nope" }))).toEqual(LEAST_PRIVILEGE_GRANTS);
    expect(resolvePluginHookGrants(manifestWith({ mux: { hooks: "nope" } }))).toEqual(
      LEAST_PRIVILEGE_GRANTS
    );
    expect(
      resolvePluginHookGrants(manifestWith({ mux: { hooks: { tools: "file_read" } } }))
    ).toEqual(LEAST_PRIVILEGE_GRANTS);
    // Non-string entries are dropped, not coerced.
    expect(resolvePluginHookGrants(manifestWith({ mux: { hooks: { tools: [42, ""] } } }))).toEqual(
      LEAST_PRIVILEGE_GRANTS
    );
  });
});

describe("parseHookOutput", () => {
  test("null payload means no-op", () => {
    expect(parseHookOutput(JSON.stringify(null))).toBeNull();
  });

  test("object payloads round-trip", () => {
    expect(parseHookOutput(JSON.stringify({ deny: "no" }))).toEqual({ deny: "no" });
  });

  test("non-object payloads throw (treated as hook failure by the caller)", () => {
    expect(() => parseHookOutput(JSON.stringify([1, 2]))).toThrow();
    expect(() => parseHookOutput(JSON.stringify("text"))).toThrow();
    expect(() => parseHookOutput(undefined)).toThrow();
  });
});

describe("parseLoadedHookNames", () => {
  test("keeps only supported hook points", () => {
    expect(
      parseLoadedHookNames(JSON.stringify(["tool.execute.before", "unknown.hook", 3]))
    ).toEqual(["tool.execute.before"]);
  });

  test("rejects non-array payloads", () => {
    expect(() => parseLoadedHookNames(JSON.stringify({ hooks: [] }))).toThrow();
  });
});
