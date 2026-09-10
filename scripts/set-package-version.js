#!/usr/bin/env node

/**
 * Patch package.json version in CI.
 *
 * Shared by release workflows so nightly/release builds stay in sync without
 * copy-pasting inline Node snippets in multiple jobs.
 */
const fs = require("node:fs");

const nextVersion = process.argv[2];
if (!nextVersion || typeof nextVersion !== "string" || nextVersion.trim().length === 0) {
  console.error("Usage: node ./scripts/set-package-version.js <version>");
  process.exit(1);
}

const packageJsonPath = "package.json";
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const version = nextVersion.trim();
packageJson.version = version;

const legacyCompatPackageJsonPath = "packages/mux-compat/package.json";
const legacyCompatPackageJson = JSON.parse(fs.readFileSync(legacyCompatPackageJsonPath, "utf8"));
legacyCompatPackageJson.version = version;
legacyCompatPackageJson.dependencies = { [packageJson.name]: version };

// When version includes a prerelease suffix like "-nightly.N", tell
// electron-builder to generate channel-specific manifests (e.g. nightly.yml,
// nightly-mac.yml) instead of the default latest.yml. electron-updater on
// the client uses autoUpdater.channel to resolve the matching manifest name.
const prereleaseMatch = version.match(/-([a-z]+)\./);
if (prereleaseMatch && packageJson.build?.publish) {
  const channel = prereleaseMatch[1]; // e.g. "nightly"
  if (Array.isArray(packageJson.build.publish)) {
    for (const pub of packageJson.build.publish) {
      pub.channel = channel;
    }
  } else if (typeof packageJson.build.publish === "object") {
    packageJson.build.publish.channel = channel;
  }
  console.log(`Set publish channel to "${channel}"`);
}

fs.writeFileSync(
  legacyCompatPackageJsonPath,
  `${JSON.stringify(legacyCompatPackageJson, null, 2)}\n`
);
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

console.log(`Set package.json version to ${packageJson.version}`);
