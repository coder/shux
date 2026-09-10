export interface TerminalBadgeVariables {
  workspace: string;
  project: string;
  tab: string;
  /**
   * Stable 1-based tab position, unlike {tab} which follows the live OSC
   * title (interactive shells typically overwrite it on every prompt).
   * Empty in pop-out windows, where the sidebar tab order is unknown.
   */
  index: string;
}

/**
 * Expand a terminal badge template. Only {workspace}, {project}, {tab}, and
 * {index} are substituted; unknown {tokens} pass through unchanged so typos
 * stay visible instead of silently vanishing.
 */
export function formatTerminalBadge(template: string, vars: TerminalBadgeVariables): string {
  return template
    .replace(
      /\{(workspace|project|tab|index)\}/g,
      (_match, token: keyof TerminalBadgeVariables) => vars[token]
    )
    .trim();
}
