import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import type { ProjectConfig } from "@/common/types/project";

/**
 * Config entries that are not user projects: the synthetic multi-project and scratch keys and
 * system-kind projects. Settings backup neither exports them nor lets a restore resolve an
 * import target to one — MemoryService keeps no project memory for them, so memory written
 * under their identity would be unreachable.
 */
export function isSystemProjectEntry(projectPath: string, projectConfig: ProjectConfig): boolean {
  return (
    projectPath === MULTI_PROJECT_CONFIG_KEY ||
    projectPath === SCRATCH_PROJECT_CONFIG_KEY ||
    projectConfig.projectKind === "system"
  );
}
