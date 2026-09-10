/**
 * Frontend signal for completed Agent Plugin mutations (install / update /
 * uninstall), published by the Settings section and command-palette flows.
 *
 * A mounted workspace composer caches plugin-contributed slash-command and
 * skill descriptors; mutations do not remount it (palette flows do not even
 * navigate), so without this signal an updated command would keep inserting
 * its old expansion until the workspace remounts. Module-level and
 * unbuffered on purpose: only currently-mounted subscribers need to
 * re-query, and a later mount re-queries anyway.
 */

const listeners = new Set<() => void>();

export function publishAgentPluginsMutated(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Subscribe a mounted consumer; returns an unsubscribe. */
export function subscribeAgentPluginsMutated(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
