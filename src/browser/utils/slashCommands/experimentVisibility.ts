import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";

export interface SlashCommandExperimentSnapshot {
  workspaceHeartbeats: boolean;
  dynamicWorkflows?: boolean;
  memory?: boolean;
  memoryConsolidation?: boolean;
  rlm?: boolean;
  programmaticToolCalling?: boolean;
}

export function resolveSlashCommandExperimentValue(
  experimentId: ExperimentId,
  snapshot: SlashCommandExperimentSnapshot
): boolean | undefined {
  switch (experimentId) {
    case EXPERIMENT_IDS.WORKSPACE_HEARTBEATS:
      return snapshot.workspaceHeartbeats;
    case EXPERIMENT_IDS.DYNAMIC_WORKFLOWS:
      return snapshot.dynamicWorkflows;
    case EXPERIMENT_IDS.MEMORY_CONSOLIDATION:
      // Sub-experiment of MEMORY: the backend rejects consolidation unless
      // BOTH flags are on, so /dream must not surface on the sub-flag alone.
      return snapshot.memoryConsolidation === true && snapshot.memory === true;
    case EXPERIMENT_IDS.RLM:
      // Sub-experiment of Programmatic Tool Calling: the backend refuses
      // /refine unless RLM AND a PTC parent flag are on, so the sub-flag
      // alone must not surface the command.
      return snapshot.rlm === true && snapshot.programmaticToolCalling === true;
    default:
      return undefined;
  }
}
