import type { ComponentType } from "react";
import type { RuntimeEnablementId, RuntimeMode } from "@/common/types/runtime";
import type { RuntimeStatus } from "@/browser/stores/RuntimeStatusStore";
import {
  SSHIcon,
  WorktreeIcon,
  LocalIcon,
  DockerIcon,
  DevcontainerIcon,
  CoderIcon,
} from "@/browser/components/icons/RuntimeIcons/RuntimeIcons";

export interface RuntimeIconProps {
  size?: number;
  className?: string;
}

export interface RuntimeOptionFieldSpec {
  readonly field: string;
  readonly label: string;
  readonly placeholder: string;
  readonly summary: string;
}

export const RUNTIME_OPTION_FIELDS = {
  ssh: {
    field: "host",
    label: "Host",
    placeholder: "user@host",
    summary: "Host (user@host)",
  },
  docker: {
    field: "image",
    label: "Image",
    placeholder: "node:20",
    summary: "Image name (e.g. node:20)",
  },
  devcontainer: {
    field: "configPath",
    label: "Config",
    placeholder: ".devcontainer/devcontainer.json",
    summary: "Config path (devcontainer.json)",
  },
} as const satisfies Partial<Record<RuntimeEnablementId, RuntimeOptionFieldSpec>>;

export function getRuntimeOptionField(
  runtimeId: RuntimeEnablementId
): RuntimeOptionFieldSpec | null {
  switch (runtimeId) {
    case "ssh":
      return RUNTIME_OPTION_FIELDS.ssh;
    case "docker":
      return RUNTIME_OPTION_FIELDS.docker;
    case "devcontainer":
      return RUNTIME_OPTION_FIELDS.devcontainer;
    default:
      return null;
  }
}

export interface RuntimeUiSpec {
  label: string;
  description: string;
  /** What user-provided options this runtime requires at creation time. */
  options?: string;
  docsPath: string;
  Icon: ComponentType<RuntimeIconProps>;
  button: {
    activeClass: string;
    idleClass: string;
  };
  iconButton: {
    activeClass: string;
    idleClass: string;
  };
  badge: {
    idleClass: string;
    workingClass: string;
  };
}

export type RuntimeChoice = RuntimeMode | "coder";

export const RUNTIME_UI = {
  local: {
    label: "Local",
    description: "Work directly in project directory (no isolation)",
    docsPath: "/runtime/local",
    Icon: LocalIcon,
    button: {
      activeClass:
        "bg-[var(--color-runtime-local)]/30 text-foreground border-[var(--color-runtime-local)]/60",
      idleClass:
        "bg-transparent text-muted border-transparent hover:border-[var(--color-runtime-local)]/40",
    },
    iconButton: {
      activeClass:
        "bg-[var(--color-runtime-local)]/30 text-foreground border-[var(--color-runtime-local)]/60",
      idleClass:
        "bg-transparent text-muted border-[var(--color-runtime-local)]/30 hover:border-[var(--color-runtime-local)]/50",
    },
    badge: {
      idleClass: "bg-transparent text-muted border-[var(--color-runtime-local)]/50",
      workingClass:
        "bg-[var(--color-runtime-local)]/30 text-[var(--color-runtime-local)] border-[var(--color-runtime-local)]/60 animate-pulse",
    },
  },
  worktree: {
    label: "Worktree",
    description: "Isolated git worktree in ~/.xum/src",
    docsPath: "/runtime/worktree",
    Icon: WorktreeIcon,
    button: {
      activeClass:
        "bg-[var(--color-runtime-worktree)]/20 text-[var(--color-runtime-worktree-text)] border-[var(--color-runtime-worktree)]/60",
      idleClass:
        "bg-transparent text-muted border-transparent hover:border-[var(--color-runtime-worktree)]/40",
    },
    iconButton: {
      activeClass:
        "bg-[var(--color-runtime-worktree)]/20 text-[var(--color-runtime-worktree-text)] border-[var(--color-runtime-worktree)]/60",
      idleClass:
        "bg-transparent text-muted border-[var(--color-runtime-worktree)]/30 hover:border-[var(--color-runtime-worktree)]/50",
    },
    badge: {
      idleClass: "bg-transparent text-muted border-[var(--color-runtime-worktree)]/50",
      workingClass:
        "bg-[var(--color-runtime-worktree)]/20 text-[var(--color-runtime-worktree-text)] border-[var(--color-runtime-worktree)]/60 animate-pulse",
    },
  },
  ssh: {
    label: "SSH",
    description: "Remote clone on SSH host",
    options: RUNTIME_OPTION_FIELDS.ssh.summary,
    docsPath: "/runtime/ssh",
    Icon: SSHIcon,
    button: {
      activeClass:
        "bg-[var(--color-runtime-ssh)]/20 text-[var(--color-runtime-ssh-text)] border-[var(--color-runtime-ssh)]/60",
      idleClass:
        "bg-transparent text-muted border-transparent hover:border-[var(--color-runtime-ssh)]/40",
    },
    iconButton: {
      activeClass:
        "bg-[var(--color-runtime-ssh)]/20 text-[var(--color-runtime-ssh-text)] border-[var(--color-runtime-ssh)]/60",
      idleClass:
        "bg-transparent text-muted border-[var(--color-runtime-ssh)]/30 hover:border-[var(--color-runtime-ssh)]/50",
    },
    badge: {
      idleClass: "bg-transparent text-muted border-[var(--color-runtime-ssh)]/50",
      workingClass:
        "bg-[var(--color-runtime-ssh)]/20 text-[var(--color-runtime-ssh-text)] border-[var(--color-runtime-ssh)]/60 animate-pulse",
    },
  },
  docker: {
    label: "Docker",
    description: "Isolated container per workspace",
    options: RUNTIME_OPTION_FIELDS.docker.summary,
    docsPath: "/runtime/docker",
    Icon: DockerIcon,
    button: {
      activeClass:
        "bg-[var(--color-runtime-docker)]/20 text-[var(--color-runtime-docker-text)] border-[var(--color-runtime-docker)]/60",
      idleClass:
        "bg-transparent text-muted border-transparent hover:border-[var(--color-runtime-docker)]/40",
    },
    iconButton: {
      activeClass:
        "bg-[var(--color-runtime-docker)]/20 text-[var(--color-runtime-docker-text)] border-[var(--color-runtime-docker)]/60",
      idleClass:
        "bg-transparent text-muted border-[var(--color-runtime-docker)]/30 hover:border-[var(--color-runtime-docker)]/50",
    },
    badge: {
      idleClass: "bg-transparent text-muted border-[var(--color-runtime-docker)]/50",
      workingClass:
        "bg-[var(--color-runtime-docker)]/20 text-[var(--color-runtime-docker-text)] border-[var(--color-runtime-docker)]/60 animate-pulse",
    },
  },
  devcontainer: {
    label: "Dev container",
    description: "Uses project's devcontainer.json configuration",
    options: RUNTIME_OPTION_FIELDS.devcontainer.summary,
    docsPath: "/runtime/devcontainer",
    Icon: DevcontainerIcon,
    button: {
      activeClass:
        "bg-[var(--color-runtime-devcontainer)]/20 text-[var(--color-runtime-devcontainer-text)] border-[var(--color-runtime-devcontainer)]/60",
      idleClass:
        "bg-transparent text-muted border-transparent hover:border-[var(--color-runtime-devcontainer)]/40",
    },
    iconButton: {
      activeClass:
        "bg-[var(--color-runtime-devcontainer)]/20 text-[var(--color-runtime-devcontainer-text)] border-[var(--color-runtime-devcontainer)]/60",
      idleClass:
        "bg-transparent text-muted border-[var(--color-runtime-devcontainer)]/30 hover:border-[var(--color-runtime-devcontainer)]/50",
    },
    badge: {
      idleClass: "bg-transparent text-muted border-[var(--color-runtime-devcontainer)]/50",
      workingClass:
        "bg-[var(--color-runtime-devcontainer)]/20 text-[var(--color-runtime-devcontainer-text)] border-[var(--color-runtime-devcontainer)]/60 animate-pulse",
    },
  },
} satisfies Record<RuntimeMode, RuntimeUiSpec>;

const CODER_RUNTIME_UI: RuntimeUiSpec = {
  ...RUNTIME_UI.ssh,
  label: "Coder",
  description: "Coder workspace via the Coder CLI",
  options: "Coder workspace template",
  docsPath: "/runtime/coder",
  Icon: CoderIcon,
};

export const RUNTIME_CHOICE_UI = {
  ...RUNTIME_UI,
  coder: CODER_RUNTIME_UI,
} satisfies Record<RuntimeChoice, RuntimeUiSpec>;

export const RUNTIME_BADGE_UI = {
  ssh: {
    Icon: RUNTIME_UI.ssh.Icon,
    badge: RUNTIME_UI.ssh.badge,
  },
  coder: {
    Icon: CODER_RUNTIME_UI.Icon,
    badge: CODER_RUNTIME_UI.badge,
  },
  worktree: {
    Icon: RUNTIME_UI.worktree.Icon,
    badge: RUNTIME_UI.worktree.badge,
  },
  local: {
    Icon: RUNTIME_UI.local.Icon,
    badge: RUNTIME_UI.local.badge,
  },
  docker: {
    Icon: RUNTIME_UI.docker.Icon,
    badge: RUNTIME_UI.docker.badge,
  },
  devcontainer: {
    Icon: RUNTIME_UI.devcontainer.Icon,
    badge: RUNTIME_UI.devcontainer.badge,
  },
} satisfies Record<RuntimeChoice, Pick<RuntimeUiSpec, "Icon" | "badge">>;

export interface DevcontainerStatusChip {
  label: string;
  className: string;
}

/**
 * Returns the titlebar chip presentation for a devcontainer runtime status,
 * or null when the status is indeterminate and no chip should be shown.
 * Only `running` and `stopped` produce a chip; `unknown`, `unsupported`,
 * and null (not yet loaded) suppress the chip to avoid misreporting.
 */
export function getDevcontainerStatusChip(
  status: RuntimeStatus | null
): DevcontainerStatusChip | null {
  switch (status) {
    case "running":
      return {
        label: "Devcontainer Running",
        className: "bg-emerald-500/15 text-emerald-400",
      };
    case "stopped":
      return {
        label: "Devcontainer Stopped",
        className: "bg-muted/50 text-muted-foreground",
      };
    default:
      return null;
  }
}
