import type { UpdateChannel } from "@/common/types/project";

export const UPDATE_CHANNEL_LABELS: Record<UpdateChannel, string> = {
  stable: "Stable",
  nightly: "Nightly",
  npm: "Newest npm",
};
