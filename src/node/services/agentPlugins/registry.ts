import * as fsPromises from "node:fs/promises";
import {
  AgentPluginImportedComponentsSchema,
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
export async function readPluginComponentImports(
  registryFile: string
): Promise<Map<string, AgentPluginImportedComponents | undefined> | null> {
  try {
    const { rawEntries } = await readPluginRegistryDocument(registryFile, "strict");
    const imports = new Map<string, AgentPluginImportedComponents | undefined>();
    for (const raw of rawEntries) {
      if (
        raw === null ||
        typeof raw !== "object" ||
        !("name" in raw) ||
        typeof raw.name !== "string"
      ) {
        throw new Error("Plugin registry entry has no name");
      }
      const selection = "importedComponents" in raw ? raw.importedComponents : undefined;
      const parsed = AgentPluginImportedComponentsSchema.optional().safeParse(selection);
      if (!parsed.success || imports.has(raw.name)) {
        log.warn(
          `Ignoring component imports for invalid or duplicate plugin registry entry '${raw.name}'`
        );
        imports.set(raw.name, { skills: [], mcpServers: [] });
      } else {
        imports.set(raw.name, parsed.data);
      }
    }
    return imports;
  } catch (error) {
    log.warn("Plugin component imports unavailable; suppressing skills and MCP servers", {
      registryFile,
      error: getErrorMessage(error),
    });
    return null;
  }
}
