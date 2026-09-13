import type { BackupCredentialKind } from "@/common/orpc/schemas/backup";

export const BACKUP_CREDENTIAL_LABELS: Record<BackupCredentialKind, string> = {
  ssh: "SSH key or agent",
  gh: "GitHub CLI",
  ambient: "system git credentials",
};
