/**
 * Pre-resolved scope for mux-managed resource tools (skills, AGENTS.md, config).
 *
 * Global: tools operate under ~/.xum/.
 * Project: tools operate under the project root (any project workspace).
 *
 * `projectRoot` is a **host-local** filesystem root used by mux tools that call
 * Node `fs/promises`. For remote/container runtime-backed workspaces (ssh, docker),
 * this intentionally differs from the runtime execution cwd (workspacePath).
 */
export type ProjectStorageAuthority = "host-local" | "runtime";

export type XumToolScope =
  | { readonly type: "global"; readonly xumHome: string }
  | {
      readonly type: "project";
      readonly xumHome: string;
      readonly projectRoot: string;
      readonly projectStorageAuthority: ProjectStorageAuthority;
      /**
       * Checkout root in the filesystem selected by projectStorageAuthority.
       * Subprojects execute below this boundary and inherit skills from each
       * ancestor through it. Host-local Agent Plugins also anchor here.
       */
      readonly checkoutRoot?: string;
    };
