/**
 * Shared xum:// deep-link payload types. The legacy mux:// scheme normalizes to
 * this same shape so compatibility stays at the parsing/registration boundary.
 */
export interface DeepLinkPayload {
  type: "new_chat";

  /**
   * Human-friendly project selector. Matches against the final path segment
   * (e.g., /Users/me/repos/mux -> "mux").
   */
  project?: string;

  // Precise selectors (legacy/back-compat): these must match a configured project.
  projectPath?: string;
  projectId?: string;

  prompt?: string;
}
