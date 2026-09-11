import type { MCPServerPluginProvenance } from "@/common/types/mcp";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import {
  AgentPluginInstallEntrySchema,
  type AgentPluginImportedComponents,
} from "@/common/config/schemas/agentPluginInstalls";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { hasErrorCode } from "@/node/services/tools/skillFileUtils";

export const PLUGIN_REGISTRY_FILE_NAME = "plugins.json";

/** Shared lossless document read: lenient views recover, strict mutations refuse corruption. */
export async function readPluginRegistryDocument(
  registryFile: string,
  mode: "lenient" | "strict"
): Promise<{
  envelope: Record<string, unknown>;
  rawEntries: unknown[];
}> {
  const corrupted = (detail: string): never => {
    throw new Error(
      `The plugin registry (${registryFile}) is corrupted: ${detail}. Repair or remove the file, then retry.`
    );
  };

  let raw: string;
  try {
    raw = await fsPromises.readFile(registryFile, "utf8");
  } catch (error) {
    // Only a MISSING file is an empty registry. Any other read failure
    // (e.g. an unreadable mode-000 file in a writable ~/.mux) must block
    // mutations: the atomic write replaces the file wholesale, so treating
    // "unreadable" as "empty" would erase every existing entry.
    if (hasErrorCode(error, "ENOENT")) {
      return { envelope: {}, rawEntries: [] };
    }
    if (mode === "strict") {
      corrupted(`it cannot be read (${getErrorMessage(error)})`);
    }
    log.warn("Ignoring unreadable plugin registry file", {
      file: registryFile,
      error: getErrorMessage(error),
    });
    return { envelope: {}, rawEntries: [] };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    if (mode === "strict") {
      corrupted(`it cannot be parsed (${getErrorMessage(error)})`);
    }
    log.warn("Ignoring unparseable plugin registry file", {
      file: registryFile,
      error: getErrorMessage(error),
    });
    return { envelope: {}, rawEntries: [] };
  }

  if (
    typeof parsedJson !== "object" ||
    parsedJson === null ||
    Array.isArray(parsedJson) ||
    !Array.isArray((parsedJson as { plugins?: unknown }).plugins)
  ) {
    if (mode === "strict") {
      corrupted("expected an object with a 'plugins' array");
    }
    log.warn("Ignoring structurally invalid plugin registry file", {
      file: registryFile,
    });
    return { envelope: {}, rawEntries: [] };
  }

  return {
    envelope: parsedJson as Record<string, unknown>,
    rawEntries: (parsedJson as { plugins: unknown[] }).plugins,
  };
}

/** Read once per managed container scan. Corruption must never become legacy import-all. */
export async function readPluginComponentImports(registryFile: string): Promise<{
  byName: Map<string, AgentPluginImportedComponents | undefined>;
  hasUnidentifiedEntries: boolean;
} | null> {
  try {
    const { rawEntries } = await readPluginRegistryDocument(registryFile, "strict");
    const byName = new Map<string, AgentPluginImportedComponents | undefined>();
    let hasUnidentifiedEntries = false;
    for (const raw of rawEntries) {
      const name = AgentPluginInstallEntrySchema.shape.name.safeParse(
        raw !== null && typeof raw === "object" && "name" in raw ? raw.name : undefined
      );
      if (!name.success) {
        // An unidentified row can own an otherwise unregistered directory, but
        // must not suppress healthy rows whose identity is still known.
        hasUnidentifiedEntries = true;
        continue;
      }
      // Only a complete, valid legacy install may grant import-all. A missing
      // selection on a truncated row is corruption, not legacy consent.
      const parsed = AgentPluginInstallEntrySchema.safeParse(raw);
      if (!parsed.success || byName.has(name.data)) {
        log.warn(
          `Ignoring component imports for invalid or duplicate plugin registry entry '${name.data}'`
        );
        byName.set(name.data, { skills: [], mcpServers: [] });
      } else {
        byName.set(name.data, parsed.data.importedComponents);
      }
    }
    if (hasUnidentifiedEntries) {
      log.warn(
        "Unidentified plugin registry entries; suppressing imports for unmatched directories",
        {
          registryFile,
        }
      );
    }
    return { byName, hasUnidentifiedEntries };
  } catch (error) {
    log.warn("Plugin component imports unavailable; suppressing skills and MCP servers", {
      registryFile,
      error: getErrorMessage(error),
    });
    return null;
  }
}

/** MCP-only content snapshot: skills/metadata changes must not recycle MCP clients. */
export interface PluginMcpPolicy {
  registryPath: string;
  imports: Record<string, string[] | null> | null;
}

export function isPluginMcpServerAllowed(
  plugin: MCPServerPluginProvenance | undefined,
  policy: PluginMcpPolicy | undefined
): boolean {
  if (plugin?.componentPolicy === undefined) return true;
  const owner = plugin.componentPolicy;
  if (
    policy?.registryPath !== owner.registryPath ||
    policy.imports == null ||
    !Object.hasOwn(policy.imports, owner.name)
  )
    return false;
  const selected = policy.imports[owner.name];
  return selected === null || selected.includes(plugin.serverName);
}

export async function readPluginMcpPolicy(registryFile: string): Promise<PluginMcpPolicy> {
  try {
    const home = path.dirname(registryFile);
    const owner = await fsPromises.realpath(home);
    const container = await fsPromises.realpath(path.join(owner, "plugins"));
    const registryPath = path.join(owner, path.basename(registryFile));
    const selection = await readPluginComponentImports(registryPath);
    // The registry belongs to the pinned owner, not to an alias that can move
    // during the read. Recheck both logical and canonical bindings.
    if (
      (await fsPromises.realpath(home)) !== owner ||
      (await fsPromises.realpath(owner)) !== owner ||
      (await fsPromises.realpath(path.join(home, "plugins"))) !== container ||
      (await fsPromises.realpath(path.join(owner, "plugins"))) !== container
    )
      throw new Error("Managed plugin owner changed during policy read");
    return {
      registryPath,
      imports:
        selection === null
          ? null
          : Object.fromEntries(
              [...selection.byName]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([name, components]) => [
                  name,
                  components === undefined ? null : [...new Set(components.mcpServers)].sort(),
                ])
            ),
    };
  } catch {
    // Failure denies managed provenance only; unmanaged plugins do not consult this policy.
    return { registryPath: registryFile, imports: null };
  }
}
