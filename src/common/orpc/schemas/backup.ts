import { z } from "zod";
import {
  SettingsBackupInputSchema,
  SettingsBackupSchema,
} from "@/common/config/schemas/settingsBackup";
import { ResultSchema } from "./result";

/**
 * An MCP command a restore would introduce or change. `token` binds the approval to this
 * exact command text, so an approval cannot carry over to a command the repository
 * changed after the user read it.
 */
export const BackupCommandApprovalSchema = z.object({
  path: z.string(),
  command: z.string(),
  token: z.string(),
});

/**
 * A project-bundle entry that is not registered on this machine at exactly its recorded
 * path. Nothing is written for it unless the user approves the import explicitly. `token`
 * binds the approval to the exact entry and memory content it was shown for, so a
 * repository change between preview and restore forces re-approval.
 */
export const BackupProjectImportSchema = z.object({
  sourcePath: z.string(),
  name: z.string(),
  /** Display-only hint; the user clones manually. Never rendered as a link or executed. */
  gitRemote: z.string().nullish(),
  memoryFileCount: z.number(),
  token: z.string(),
});

/** One approved import's outcome; failures are reported per candidate, never thrown. */
export const BackupProjectImportResultSchema = z.object({
  sourcePath: z.string(),
  targetPath: z.string(),
  name: z.string(),
  status: z.enum(["imported", "failed"]),
  message: z.string().nullish(),
  writtenFiles: z.array(z.string()),
  /** Existing target files with different content: kept, reported, never overwritten. */
  skippedFiles: z.array(z.string()),
  /**
   * True when this import registered the target as a new project. The safety snapshot does
   * not cover registrations, so undoing the import means unregistering it — but only then:
   * an import into an already registered project must not tell the user to remove it.
   */
  registered: z.boolean(),
});

export const BackupOperationErrorSchema = z.object({
  code: z.enum([
    "AUTH_FAILED",
    "REMOTE_UNREACHABLE",
    "REPOSITORY_CHANGED",
    "INVALID_BACKUP",
    "SECRET_DETECTED",
    "COMMAND_APPROVAL_REQUIRED",
    "PROJECT_IMPORT_APPROVAL_REQUIRED",
    "IO_ERROR",
    "GIT_ERROR",
  ]),
  message: z.string(),
  files: z.array(z.string()).nullish(),
  /** Echo back on the next push to approve exactly the payload that was blocked. */
  secretApproval: z.string().nullish(),
  /**
   * On COMMAND_APPROVAL_REQUIRED: every command the restore needs approved, so a restore
   * attempted without a preview, or after the backup drifted, can present the current
   * list instead of a stale or empty one.
   */
  commandApprovals: z.array(BackupCommandApprovalSchema).nullish(),
  /**
   * On PROJECT_IMPORT_APPROVAL_REQUIRED: the current import candidates, recomputed from
   * the checked-out payload, so a restore whose approval tokens went stale can present
   * the fresh list instead of failing opaquely.
   */
  projectImports: z.array(BackupProjectImportSchema).nullish(),
  /**
   * Set when a restore fails after its safety snapshot completed: files may already have
   * been overwritten, and the snapshot is the only recovery path, so a failure report
   * that omitted it would hide the copy the user needs.
   */
  snapshotPath: z.string().nullish(),
});

export const BackupFileChangeSchema = z.object({
  path: z.string(),
  status: z.string(),
});

export const BackupCredentialKindSchema = z.enum(["ssh", "gh", "ambient"]);

const BackupResult = <T extends z.ZodTypeAny>(schema: T) =>
  ResultSchema(schema, BackupOperationErrorSchema);

export const backup = {
  getSettings: {
    output: SettingsBackupSchema.nullable(),
  },
  saveSettings: {
    input: SettingsBackupInputSchema,
    output: BackupResult(SettingsBackupSchema),
  },
  validate: {
    input: SettingsBackupInputSchema,
    output: BackupResult(
      z.object({
        reachable: z.literal(true),
        credential: BackupCredentialKindSchema,
        empty: z.boolean(),
      })
    ),
  },
  preview: {
    input: SettingsBackupInputSchema,
    output: BackupResult(
      z.object({
        pushChanges: z.array(BackupFileChangeSchema),
        restoreChanges: z.array(BackupFileChangeSchema),
        localOnlyFiles: z.array(z.string()),
        redactions: z.array(z.string()),
        commandApprovals: z.array(BackupCommandApprovalSchema),
        /** Project-bundle entries a restore would only import with explicit approval. */
        projectImports: z.array(BackupProjectImportSchema),
        /** The backup carries a project bundle but `includeProjects` is off, so it is skipped. */
        projectBundleSkipped: z.boolean(),
        /**
         * Why the push half could not be computed, if it could not. The restore half is
         * still reported so a local export problem never blocks reviewing or approving
         * what a restore would bring in.
         */
        pushError: z.string().nullable(),
      })
    ),
  },
  push: {
    input: SettingsBackupInputSchema.extend({
      approvedSecretDigest: z.string().nullish(),
    }),
    output: BackupResult(
      z.object({
        commit: z.string(),
        changed: z.boolean(),
        credential: BackupCredentialKindSchema,
        redactions: z.array(z.string()),
      })
    ),
  },
  restore: {
    input: SettingsBackupInputSchema.extend({
      approvedCommandTokens: z.array(z.string()).nullish(),
      /**
       * Approved project imports: each token from a previewed candidate plus the local
       * directory to register the project at. Unknown or stale tokens abort the restore
       * with PROJECT_IMPORT_APPROVAL_REQUIRED before anything is written.
       */
      projectImports: z.array(z.object({ token: z.string(), targetPath: z.string() })).nullish(),
    }),
    output: BackupResult(
      z.object({
        commit: z.string(),
        snapshotPath: z.string(),
        changedFiles: z.array(z.string()),
        localOnlyFiles: z.array(z.string()),
        projectImportResults: z.array(BackupProjectImportResultSchema),
        /** The backup carries a project bundle but `includeProjects` is off, so it is skipped. */
        projectBundleSkipped: z.boolean(),
        /**
         * Candidates left unimported for lack of approval (no preview, or unchecked). Fresh
         * tokens, so the UI can offer them for approval right away.
         */
        unapprovedProjectImports: z.array(BackupProjectImportSchema),
      })
    ),
  },
};

export type { SettingsBackupInput } from "@/common/config/schemas/settingsBackup";
export type BackupOperationError = z.infer<typeof BackupOperationErrorSchema>;
export type BackupFileChange = z.infer<typeof BackupFileChangeSchema>;
export type BackupCommandApproval = z.infer<typeof BackupCommandApprovalSchema>;
export type BackupCredentialKind = z.infer<typeof BackupCredentialKindSchema>;
export type BackupProjectImport = z.infer<typeof BackupProjectImportSchema>;
export type BackupProjectImportResult = z.infer<typeof BackupProjectImportResultSchema>;
