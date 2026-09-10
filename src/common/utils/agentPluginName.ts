/**
 * Agent Plugins 1.0.0 plugin-name grammar (§5, canonical plugin.schema.json).
 *
 * Lives in src/common so both the node-side manifest validator and the shared
 * registry schema (src/common/config/schemas/agentPluginInstalls.ts) enforce
 * the same rule. Registry names double as directory names under
 * `~/.mux/plugins`, so this validation is also a filesystem-safety gate:
 * the pattern excludes path separators, `.`/`..`, and `..` runs.
 */

// Canonical name pattern from plugin.schema.json (JS supports the lookahead).
export const AGENT_PLUGIN_NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
export const AGENT_PLUGIN_NAME_MAX_LENGTH = 64;

// Windows reserves device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) as
// file/directory names — with or without an extension (`con.plugin` is also
// reserved). Such a name would pass consent yet fail at promotion into the
// plugins container on Windows. Rejected on every platform so a plugin
// installable on one OS is installable on all. Names are lowercase by
// grammar, so a lowercase pattern suffices.
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/;

/** True when `name` satisfies the §5 plugin-name grammar and is usable as a directory name on every supported OS. */
export function isValidAgentPluginName(name: string): boolean {
  return (
    name.length <= AGENT_PLUGIN_NAME_MAX_LENGTH &&
    AGENT_PLUGIN_NAME_PATTERN.test(name) &&
    !WINDOWS_RESERVED_NAME_PATTERN.test(name)
  );
}
