import type {
  AgentPluginImportedComponents,
  AgentPluginInstallEntry,
} from "@/common/config/schemas/agentPluginInstalls";

/** Valid managed registry row; tests override individual fields to exercise corruption. */
export function createTestPluginInstallEntry(
  name: string,
  importedComponents?: AgentPluginImportedComponents
): AgentPluginInstallEntry {
  return {
    name,
    scope: "global",
    source: {
      type: "git",
      url: "https://example.test/plugins.git",
      ref: "main",
      refType: "branch",
    },
    lockedSha: "a".repeat(40),
    installedAt: "2026-01-01T00:00:00.000Z",
    importedComponents,
  };
}
