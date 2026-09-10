import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { AppInfo as ElectronBuilderAppInfo } from "app-builder-lib/out/appInfo";
import { expandMacro } from "app-builder-lib/out/util/macroExpander";
import packageJson from "../../../package.json";
import legacyPackageJson from "../../../packages/mux-compat/package.json";
import vscodePackageJson from "../../../vscode/package.json";
import { resolveMacPackagedAppNames } from "./macPackagedApp";

interface PackagedAppInfo {
  productFilename: string;
  productName: string;
}

// Runtime AppInfo only needs metadata+config; the published types require Packager.
const AppInfo = ElectronBuilderAppInfo as unknown as new (
  info: {
    metadata: { name: string; version: string; description?: string };
    config: { productName?: string; executableName?: string | null };
  },
  buildVersion: null
) => PackagedAppInfo;

const LEGACY_MUX_BIN_PATH = fileURLToPath(
  new URL("../../../packages/mux-compat/bin/mux.js", import.meta.url)
);
// `${os}` keeps an OS token ("mac"/"win"/"linux") in every published filename.
// electron-builder includes it by default; dropping it makes release assets
// invisible to installers that match assets by OS (mise/ubi, Homebrew, asdf).
const LOWERCASE_ARTIFACT_TEMPLATE = "xum-${version}-${arch}-${os}.${ext}";

// Expand through electron-builder's own macro expander rather than a local copy
// of the substitution rules, so this exercises the builder's real behaviour: it
// throws ERR_ELECTRON_BUILDER_MACRO_NOT_DEFINED on any macro it cannot resolve,
// which is what makes `${os}` support an assertion instead of a restatement.
function expandArtifactName(arch: string, ext: string, os: string): string {
  const appInfo = new AppInfo(
    {
      metadata: {
        name: packageJson.name,
        version: packageJson.version,
        description: packageJson.description,
      },
      config: {
        productName: packageJson.build.productName,
        executableName: packageJson.build.executableName,
      },
    },
    null
  );
  // `os` and `ext` are supplied by the packager as extras; `version` resolves
  // off AppInfo, mirroring how electron-builder expands artifactName at build time.
  return expandMacro(LOWERCASE_ARTIFACT_TEMPLATE, arch, appInfo as never, { os, ext });
}

describe("xum package transition contract", () => {
  test("ships one canonical CLI implementation through both command names", () => {
    expect(packageJson.name).toBe("@coder/xum");
    expect(packageJson.publishConfig.access).toBe("public");
    expect(packageJson.bin).toEqual({
      xum: "dist/cli/index.js",
      mux: "dist/cli/index.js",
    });
  });

  test("retains install identity and the legacy deep-link scheme", () => {
    expect(packageJson.build.appId).toBe("com.mux.app");
    expect(packageJson.build.productName).toBe("Xum");
    expect(packageJson.build.executableName).toBe("xum");
    expect(packageJson.build.protocols[0]?.schemes).toEqual(["xum", "mux"]);
  });

  test("names the macOS bundle from executableName via electron-builder productFilename", () => {
    const names = resolveMacPackagedAppNames(packageJson.build);
    const appInfo = new AppInfo(
      {
        metadata: {
          name: packageJson.name,
          version: packageJson.version,
          description: packageJson.description,
        },
        config: packageJson.build,
      },
      null
    );

    expect(names.productFilename).toBe(packageJson.build.executableName);
    expect(names.appBundleName).toBe(`${packageJson.build.executableName}.app`);
    expect(names.productFilename).not.toBe(packageJson.build.productName);
    expect(appInfo.productFilename).toBe(names.productFilename);
    expect(appInfo.productName).toBe(packageJson.build.productName);

    const withoutExecutableName = new AppInfo(
      {
        metadata: {
          name: packageJson.name,
          version: packageJson.version,
          description: packageJson.description,
        },
        config: { productName: packageJson.build.productName },
      },
      null
    );
    expect(withoutExecutableName.productFilename).toBe(packageJson.build.productName);
    expect(
      resolveMacPackagedAppNames({ productName: packageJson.build.productName }).productFilename
    ).toBe(withoutExecutableName.productFilename);
  });

  test("publishes lowercase slug artifacts instead of productName filenames", () => {
    expect(packageJson.build.mac.artifactName).toBe(LOWERCASE_ARTIFACT_TEMPLATE);
    expect(packageJson.build.linux.artifactName).toBe(LOWERCASE_ARTIFACT_TEMPLATE);
    expect(packageJson.build.win.artifactName).toBe(LOWERCASE_ARTIFACT_TEMPLATE);

    const expanded = expandArtifactName("arm64", "dmg", "mac");
    expect(expanded).toBe(`xum-${packageJson.version}-arm64-mac.dmg`);
    expect(expanded.startsWith(`${packageJson.name}-`)).toBe(false);
    expect(expanded.startsWith(`${packageJson.build.productName}-`)).toBe(false);
  });

  test("keeps the Linux desktop name visible while WM class follows the slug", () => {
    expect(packageJson.build.linux.desktop?.StartupWMClass).toBe(packageJson.build.executableName);
    expect(packageJson.build.linux.desktop).not.toHaveProperty("Name");
  });

  test("keeps the published mux forwarding package version-locked to @coder/xum", () => {
    expect(legacyPackageJson.name).toBe("mux");
    expect(legacyPackageJson.version).toBe(packageJson.version);
    expect(legacyPackageJson.dependencies).toEqual({
      "@coder/xum": packageJson.version,
    });
  });

  test("executes the legacy mux package through the scoped canonical dependency", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "xum-mux-compat-"));
    const canonicalCliDir = path.join(tempDir, "node_modules", "@coder", "xum", "dist", "cli");

    try {
      mkdirSync(canonicalCliDir, { recursive: true });
      writeFileSync(
        path.join(canonicalCliDir, "index.js"),
        'process.stdout.write("forwarded-to-@coder/xum");\n'
      );

      const result = spawnSync("node", [LEGACY_MUX_BIN_PATH], {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_PATH: path.join(tempDir, "node_modules"),
        },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("forwarded-to-@coder/xum");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("keeps the VS Code Marketplace identity on mux while showing Xum", () => {
    expect(vscodePackageJson.name).toBe("mux");
    expect(vscodePackageJson.publisher).toBe("coder");
    expect(vscodePackageJson.displayName).toBe(packageJson.build.productName);
  });
});
