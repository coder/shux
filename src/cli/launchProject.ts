import type { ProjectConfig } from "@/common/types/project";

export function shouldExposeLaunchProject(
  projects: Array<[string, ProjectConfig]> | null | undefined
): boolean {
  if (!Array.isArray(projects)) {
    return false;
  }

  // Keep first-user-project detection in a side-effect-free helper so xum server
  // still starts when index.ts dispatches via require("./server") while tests can
  // exercise the backend gating logic without importing the server entrypoint.
  return !projects.some(([, config]) => config.projectKind !== "system");
}
