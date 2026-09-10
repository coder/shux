import type { IntuitionToolResult } from "@/common/types/tools";

export const INTUITION_CUE =
  "Recall deployment constraints and lessons from earlier database rollouts";

const recallFields = {
  cue: INTUITION_CUE,
  model: "openai:gpt-4.1-mini",
  stats: {
    indexEntriesConsidered: 12,
    indexEntriesOmitted: 0,
    filesRead: 2,
    bytesRead: 1300,
    steps: 3,
    elapsedMs: 900,
    timedOut: false,
  },
};

export const RECOGNIZED_INTUITION = {
  kind: "recognized",
  ...recallFields,
  memories: [
    {
      path: "/memories/project/database-rollouts.md",
      relevance: 0.93,
      why: "The rollout must preserve compatibility with the previous release.",
      excerpt: "Keep schema changes backward compatible.\nVerify rollback before deploying.",
    },
    {
      path: "/memories/global/deployment-preferences.md",
      relevance: 0.76,
      why: "The user prefers small, independently reversible deployments.",
      excerpt: "Deploy one change at a time and verify health before continuing.",
    },
  ],
  candidates: [
    {
      path: "/memories/project/old-migration-notes.md",
      relevance: 0.5,
      description: "Earlier migration notes; applicability to the current database is uncertain.",
    },
  ],
} satisfies IntuitionToolResult;

export const UNCERTAIN_INTUITION = {
  kind: "uncertain",
  ...recallFields,
  candidates: RECOGNIZED_INTUITION.candidates,
  note: "These leads may help, but no memory was confidently recognized.",
} satisfies IntuitionToolResult;

export const EMPTY_INTUITION = {
  ...UNCERTAIN_INTUITION,
  candidates: [],
  note: undefined,
} satisfies IntuitionToolResult;
