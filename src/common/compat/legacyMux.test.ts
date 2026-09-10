import { describe, expect, test } from "bun:test";
import { XUM_HOME_DIR_NAME } from "@/common/constants/product";
import {
  getCanonicalProjectMetadataRelativePath,
  getLocalProductHomeTildeSuffix,
  getXumHomeLegacyFallbackMarkerPath,
  installLegacyMuxEnvironmentAliases,
  LEGACY_CMUX_HOME_DIR_NAME,
  LEGACY_MUX_HOME_DIR_NAME,
  listBackupManagedPathSpellings,
  listProjectMetadataRelativePaths,
  normalizeProjectMetadataIdentityPath,
  parseXumHomeLegacyFallbackDirName,
  resolveLegacyMuxBuiltInSkillName,
  resolveXumEnvironmentValue,
  withLegacyMuxEnvironmentAliases,
} from "./legacyMux";

describe("legacy mux environment compatibility", () => {
  test("promotes legacy values to canonical XUM names", () => {
    const env = withLegacyMuxEnvironmentAliases({ MUX_SERVER_URL: "http://legacy" });

    expect(env.XUM_SERVER_URL).toBe("http://legacy");
    expect(env.MUX_SERVER_URL).toBe("http://legacy");
  });

  test("canonical values win when both names are provided", () => {
    const env = withLegacyMuxEnvironmentAliases({
      XUM_ROOT: "/canonical",
      MUX_ROOT: "/legacy",
    });

    expect(env.XUM_ROOT).toBe("/canonical");
    expect(env.MUX_ROOT).toBe("/canonical");
    expect(resolveXumEnvironmentValue("ROOT", env)).toBe("/canonical");
  });

  test("keeps the pre-mux multiple-instance spelling synchronized", () => {
    const env: Record<string, string | undefined> = { CMUX_ALLOW_MULTIPLE_INSTANCES: "1" };

    installLegacyMuxEnvironmentAliases(env);

    expect(env.XUM_ALLOW_MULTIPLE_INSTANCES).toBe("1");
    expect(env.MUX_ALLOW_MULTIPLE_INSTANCES).toBe("1");
  });
});

describe("project metadata compatibility", () => {
  test("keeps one canonical path ahead of the legacy read fallback", () => {
    expect(listProjectMetadataRelativePaths("skills/demo")).toEqual([
      ".xum/skills/demo",
      ".mux/skills/demo",
    ]);
    expect(normalizeProjectMetadataIdentityPath(".xum/plugins/demo")).toBe(".mux/plugins/demo");
    expect(normalizeProjectMetadataIdentityPath(".xum\\plugins\\demo")).toBe(".mux\\plugins\\demo");
    expect(getCanonicalProjectMetadataRelativePath("skills/demo")).toBe(".xum/skills/demo");
  });
});

describe("backup managed path compatibility", () => {
  test("falls back from xum segments to the legacy mux spelling", () => {
    expect(listBackupManagedPathSpellings("xum/")).toEqual(["xum/", "mux/"]);
    expect(listBackupManagedPathSpellings("dotfiles/xum")).toEqual([
      "dotfiles/xum",
      "dotfiles/mux",
    ]);
  });

  test("keeps paths without a xum segment as the only spelling", () => {
    expect(listBackupManagedPathSpellings("mux/")).toEqual(["mux/"]);
    expect(listBackupManagedPathSpellings("backups")).toEqual(["backups"]);
    // Only whole segments alias; substrings must not be rewritten.
    expect(listBackupManagedPathSpellings("xum-settings")).toEqual(["xum-settings"]);
  });
});

describe("built-in skill compatibility", () => {
  test("maps old mux skill names to their canonical xum definitions", () => {
    expect(resolveLegacyMuxBuiltInSkillName("mux-docs")).toBe("xum-docs");
    expect(resolveLegacyMuxBuiltInSkillName("mux-diagram")).toBe("xum-diagram");
    expect(resolveLegacyMuxBuiltInSkillName("loop")).toBe("loop");
  });
});

describe("default-home leftover fallback markers", () => {
  test("accepts only leftover names for the same production or dev suffix", () => {
    expect(parseXumHomeLegacyFallbackDirName(".mux\n")).toBe(".mux");
    expect(parseXumHomeLegacyFallbackDirName(" .cmux ")).toBe(".cmux");
    expect(parseXumHomeLegacyFallbackDirName(".mux-dev", "-dev")).toBe(".mux-dev");
    expect(parseXumHomeLegacyFallbackDirName(".mux", "-dev")).toBeUndefined();
    expect(parseXumHomeLegacyFallbackDirName(".cmux", "-dev")).toBeUndefined();
    expect(parseXumHomeLegacyFallbackDirName("../.mux")).toBeUndefined();
    expect(parseXumHomeLegacyFallbackDirName("/tmp/evil")).toBeUndefined();
    expect(getXumHomeLegacyFallbackMarkerPath("/home/user", "-dev")).toBe(
      "/home/user/.xum-dev.legacy-fallback"
    );
  });

  test("does not import Node builtins so the VS Code webview can bundle it", async () => {
    const source = await Bun.file(new URL("./legacyMux.ts", import.meta.url)).text();
    expect(source).not.toMatch(/from ["']node:/);
  });
});

describe("local product-home tilde prefixes", () => {
  test("treats canonical and legacy local homes as the same prefix family", () => {
    for (const dirName of [
      XUM_HOME_DIR_NAME,
      LEGACY_MUX_HOME_DIR_NAME,
      LEGACY_CMUX_HOME_DIR_NAME,
    ]) {
      expect(getLocalProductHomeTildeSuffix(`~/${dirName}`)).toBe("");
      expect(getLocalProductHomeTildeSuffix(`~/${dirName}/src/project`)).toBe("src/project");
      expect(getLocalProductHomeTildeSuffix(`~\\${dirName}\\src\\project`)).toBe("src\\project");
    }
  });

  test("does not treat lookalike or unrelated tilde paths as the product home", () => {
    expect(getLocalProductHomeTildeSuffix(`~/${XUM_HOME_DIR_NAME}-dev`)).toBeUndefined();
    expect(getLocalProductHomeTildeSuffix(`~/${LEGACY_MUX_HOME_DIR_NAME}rc`)).toBeUndefined();
    expect(getLocalProductHomeTildeSuffix("~/projects")).toBeUndefined();
  });
});
