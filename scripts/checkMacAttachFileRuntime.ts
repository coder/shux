#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { Dirent } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";
import packageJson from "../package.json";
import { resolveMacPackagedAppNames } from "../src/common/compat/macPackagedApp";

const { productFilename: EXECUTABLE_NAME, appBundleName: APP_NAME } = resolveMacPackagedAppNames(
  packageJson.build
);
type MacAppArchitecture = "x64" | "arm64";

const MAC_APP_RUNTIME_PACKAGES: Record<MacAppArchitecture, { binding: string; libvips: string }> = {
  x64: { binding: "sharp-darwin-x64", libvips: "sharp-libvips-darwin-x64" },
  arm64: { binding: "sharp-darwin-arm64", libvips: "sharp-libvips-darwin-arm64" },
};
const RELEASE_DIR = path.join(process.cwd(), "release");
const APP_ASAR_UNPACKED_NODE_MODULES = [
  ["node_modules", "sharp"],
  ["node_modules", "@img"],
] as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function listDirectoryEntries(dirPath: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function findAppBundles(rootDir: string): Promise<{ matches: string[]; seen: string[] }> {
  const matches: string[] = [];
  const seen: string[] = [];

  async function walk(dirPath: string): Promise<void> {
    const entries = await listDirectoryEntries(dirPath);
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory() && entry.name.endsWith(".app")) {
        seen.push(entryPath);
        // Compare the stored readdir name, not a case-folded stat path.
        if (entry.name === APP_NAME) {
          matches.push(entryPath);
        }
        continue;
      }
      if (entry.isDirectory()) {
        await walk(entryPath);
      }
    }
  }

  await walk(rootDir);
  return { matches, seen };
}

async function chooseDefaultAppBundle(): Promise<string> {
  const { matches: appBundles, seen } = await findAppBundles(RELEASE_DIR);
  assert(
    appBundles.length > 0,
    `No ${APP_NAME} found under ${RELEASE_DIR}. Run make dist-mac first. Stored .app names: ${
      seen.length > 0 ? seen.join(", ") : "(none)"
    }`
  );

  const preferredSuffixes =
    process.arch === "arm64"
      ? [
          path.join("release", "mac-arm64", APP_NAME),
          path.join("release", "mac", APP_NAME),
          path.join("release", "mac-universal", APP_NAME),
          path.join("release", "mac-x64", APP_NAME),
        ]
      : [
          path.join("release", "mac-x64", APP_NAME),
          path.join("release", "mac", APP_NAME),
          path.join("release", "mac-universal", APP_NAME),
          path.join("release", "mac-arm64", APP_NAME),
        ];
  for (const suffix of preferredSuffixes) {
    const match = appBundles.find((appBundle) => appBundle.endsWith(suffix));
    if (match != null) {
      return match;
    }
  }

  return appBundles.sort()[0]!;
}

async function findFileMatching(rootDir: string, pattern: RegExp): Promise<string | null> {
  async function walk(dirPath: string): Promise<string | null> {
    const entries = await listDirectoryEntries(dirPath);
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const nestedMatch = await walk(entryPath);
        if (nestedMatch != null) {
          return nestedMatch;
        }
        continue;
      }
      if (pattern.test(entry.name)) {
        return entryPath;
      }
    }
    return null;
  }

  return await walk(rootDir);
}

async function verifyUnpackedSharpAssets(
  appBundlePath: string,
  architectures: readonly MacAppArchitecture[]
): Promise<void> {
  const unpackedRoot = path.join(appBundlePath, "Contents", "Resources", "app.asar.unpacked");
  for (const segments of APP_ASAR_UNPACKED_NODE_MODULES) {
    const requiredPath = path.join(unpackedRoot, ...segments);
    const stat = await fs.stat(requiredPath).catch(() => null);
    assert(stat?.isDirectory(), `Missing unpacked runtime directory: ${requiredPath}`);
  }

  const unpackedImgDir = path.join(unpackedRoot, "node_modules", "@img");
  // Issue #3338: checking for any sharp binary let the x64 app ship with only arm64 assets.
  for (const architecture of architectures) {
    const runtimePackages = MAC_APP_RUNTIME_PACKAGES[architecture];
    const bindingDir = path.join(unpackedImgDir, runtimePackages.binding);
    const bindingStat = await fs.stat(bindingDir).catch(() => null);
    assert(
      bindingStat?.isDirectory(),
      `Missing ${architecture} sharp binding directory: ${bindingDir}`
    );

    const sharpBinaryPath = await findFileMatching(
      bindingDir,
      new RegExp(`${runtimePackages.binding}\\.node$`)
    );
    assert(
      sharpBinaryPath != null,
      `Missing ${architecture} sharp native binary under ${bindingDir}`
    );

    const libvipsDir = path.join(unpackedImgDir, runtimePackages.libvips);
    const libvipsStat = await fs.stat(libvipsDir).catch(() => null);
    assert(libvipsStat?.isDirectory(), `Missing ${architecture} libvips directory: ${libvipsDir}`);

    const libvipsPath = await findFileMatching(libvipsDir, /libvips-cpp\..*\.dylib$/);
    assert(libvipsPath != null, `Missing ${architecture} libvips dylib under ${libvipsDir}`);

    console.log(`[attach-file-smoke] ${architecture} sharp binary: ${sharpBinaryPath}`);
    console.log(`[attach-file-smoke] ${architecture} libvips dylib: ${libvipsPath}`);
  }
}

async function createFixtureImages(
  tempDir: string
): Promise<{ pngPath: string; jpegPath: string }> {
  const pngPath = path.join(tempDir, "oversized.png");
  const jpegPath = path.join(tempDir, "rotated.jpg");

  await sharp({
    create: {
      width: 9001,
      height: 10,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .png()
    .toFile(pngPath);

  await sharp({
    create: {
      width: 10,
      height: 9001,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toFile(jpegPath);

  return { pngPath, jpegPath };
}

async function resolvePackagedMacExecutable(appBundlePath: string): Promise<string> {
  const macOsDir = path.join(appBundlePath, "Contents", "MacOS");
  const entries = await listDirectoryEntries(macOsDir);
  const names = entries.map((entry) => entry.name);
  const match = entries.find((entry) => entry.name === EXECUTABLE_NAME);
  assert(
    match != null,
    `Expected Contents/MacOS/${EXECUTABLE_NAME} in ${appBundlePath}, found: ${
      names.length > 0 ? names.join(", ") : "(empty)"
    }`
  );
  return path.join(macOsDir, match.name);
}

async function getPackagedAppArchitectures(appBundlePath: string): Promise<MacAppArchitecture[]> {
  const executablePath = await resolvePackagedMacExecutable(appBundlePath);
  const result = spawnSync("lipo", ["-archs", executablePath], {
    encoding: "utf8",
    timeout: 10_000,
  });

  if (result.error != null) {
    throw result.error;
  }
  if (result.signal != null) {
    throw new Error(`lipo was terminated by signal ${result.signal} for ${executablePath}`);
  }
  assert(
    result.status === 0,
    `lipo failed for ${executablePath} with exit code ${result.status}: ${result.stderr.trim()}`
  );

  const architectures = result.stdout
    .trim()
    .split(/\s+/)
    .map((architecture): MacAppArchitecture | null => {
      if (architecture === "x86_64") {
        return "x64";
      }
      if (architecture === "arm64") {
        return "arm64";
      }
      return null;
    })
    .filter((architecture): architecture is MacAppArchitecture => architecture != null);
  const uniqueArchitectures = [...new Set(architectures)];
  assert(
    uniqueArchitectures.length > 0,
    `No supported macOS architecture found in ${executablePath}. lipo reported: ${result.stdout.trim()}`
  );
  return uniqueArchitectures;
}

async function runPackagedSmokeApp(
  appBundlePath: string,
  fixturePaths: { pngPath: string; jpegPath: string }
): Promise<void> {
  const executablePath = await resolvePackagedMacExecutable(appBundlePath);
  const tempMuxRoot = path.join(path.dirname(fixturePaths.pngPath), "mux-root");
  const result = spawnSync(executablePath, [], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      CI: process.env.CI ?? "true",
      CMUX_ALLOW_MULTIPLE_INSTANCES: "1",
      MUX_ROOT: tempMuxRoot,
      MUX_ATTACH_FILE_SMOKE_TEST_PNG_PATH: fixturePaths.pngPath,
      MUX_ATTACH_FILE_SMOKE_TEST_JPEG_PATH: fixturePaths.jpegPath,
    },
  });

  if ((result.stdout?.trim().length ?? 0) > 0) {
    console.log(result.stdout.trim());
  }
  if ((result.stderr?.trim().length ?? 0) > 0) {
    console.error(result.stderr.trim());
  }

  if (result.error != null) {
    throw result.error;
  }
  if (result.signal != null) {
    throw new Error(`Packaged attach-file smoke test was terminated by signal ${result.signal}`);
  }
  assert(
    result.status === 0,
    `Packaged attach-file smoke test failed with exit code ${result.status}`
  );
}

async function main(): Promise<void> {
  assert(process.platform === "darwin", "checkMacAttachFileRuntime.ts only runs on macOS");

  const requestedAppBundle = process.argv[2];
  let appBundles: string[];
  let smokeAppBundle: string;
  if (requestedAppBundle != null) {
    appBundles = [requestedAppBundle];
    smokeAppBundle = requestedAppBundle;
  } else {
    const { matches, seen } = await findAppBundles(RELEASE_DIR);
    assert(
      matches.length > 0,
      `No ${APP_NAME} found under ${RELEASE_DIR}. Run make dist-mac first. Stored .app names: ${
        seen.length > 0 ? seen.join(", ") : "(none)"
      }`
    );
    appBundles = matches;
    smokeAppBundle = await chooseDefaultAppBundle();
  }

  const verifiedArchitectures = new Set<MacAppArchitecture>();
  for (const appBundlePath of appBundles) {
    const appStat = await fs.stat(appBundlePath).catch(() => null);
    assert(appStat?.isDirectory(), `macOS app bundle not found: ${appBundlePath}`);

    const architectures = await getPackagedAppArchitectures(appBundlePath);
    console.log(
      `[attach-file-smoke] verifying app bundle ${appBundlePath} (${architectures.join(", ")})`
    );
    await verifyUnpackedSharpAssets(appBundlePath, architectures);
    for (const architecture of architectures) {
      verifiedArchitectures.add(architecture);
    }
  }

  if (requestedAppBundle == null) {
    for (const requiredArchitecture of ["x64", "arm64"] as const) {
      assert(
        verifiedArchitectures.has(requiredArchitecture),
        `Missing ${requiredArchitecture} macOS app bundle under ${RELEASE_DIR}. Verified architectures: ${
          verifiedArchitectures.size > 0 ? [...verifiedArchitectures].join(", ") : "(none)"
        }`
      );
    }
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-attach-file-smoke-"));
  try {
    const fixturePaths = await createFixtureImages(tempDir);
    await runPackagedSmokeApp(smokeAppBundle, fixturePaths);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error("[attach-file-smoke] failed:", error);
  process.exitCode = 1;
});
