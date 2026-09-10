import type { AgentPluginUpdateReview } from "@/common/orpc/schemas/agentPlugins";

/**
 * Intents for the Settings → Plugins section, published by command-palette
 * actions that run outside the section's React tree.
 *
 * Two delivery paths cover both palette contexts:
 * - section not mounted yet: the intent is buffered and consumed by the
 *   section's mount effect after palette navigation;
 * - section already mounted: same-route navigation preserves the component,
 *   so the mounted section's subscription receives the intent directly.
 *
 * Module-level (not persisted) on purpose: intents are meaningful only for
 * the palette invocation that just happened.
 */

export type PluginsSectionIntent =
  /** Expand the Add Plugin form. */
  | { type: "open-add-panel" }
  /** Review additional skills/MCP from a managed installed tree. */
  | { type: "add-components"; name: string }
  /** Open the uninstall confirmation for a managed plugin. */
  | { type: "confirm-uninstall"; name: string }
  /** Show the in-place update review for a capability-changing update the palette previewed. */
  | { type: "review-update"; review: AgentPluginUpdateReview }
  /** Backend plugin state changed outside the section (e.g. palette Update All); re-query. */
  | { type: "refresh" };

let pendingIntent: PluginsSectionIntent | null = null;
const listeners = new Set<(intent: PluginsSectionIntent) => void>();

export function publishPluginsSectionIntent(intent: PluginsSectionIntent): void {
  if (listeners.size > 0) {
    for (const listener of listeners) {
      listener(intent);
    }
    return;
  }
  // No mounted section: buffer the latest intent for the upcoming mount.
  pendingIntent = intent;
}

/** Consume the buffered intent (mount path); returns null when none is pending. */
export function consumePendingPluginsSectionIntent(): PluginsSectionIntent | null {
  const intent = pendingIntent;
  pendingIntent = null;
  return intent;
}

/** Subscribe a mounted section; returns an unsubscribe. */
export function subscribePluginsSectionIntents(
  listener: (intent: PluginsSectionIntent) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
