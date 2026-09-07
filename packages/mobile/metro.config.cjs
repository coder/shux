const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const repositoryRoot = path.resolve(__dirname, "../..");
// Share protocol contracts, not the desktop React runtime or its DOM components.
config.watchFolders = [repositoryRoot];
// Pin shared schema runtimes in mobile dependencies so Expo's transitive versions cannot shadow them.
config.resolver.nodeModulesPaths = [
  path.join(__dirname, "node_modules"),
  path.join(repositoryRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;
config.resolver.blockList = [/\/\.git\//];
module.exports = config;
