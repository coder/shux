import { useEffect, useRef, useState } from "react";
import { ArchiveRestore, CheckCircle2, CloudUpload, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { Checkbox } from "@/browser/components/Checkbox/Checkbox";
import { ConfirmationModal } from "@/browser/components/ConfirmationModal/ConfirmationModal";
import { Input } from "@/browser/components/Input/Input";
import { useAPI, type APIClient } from "@/browser/contexts/API";
import {
  formatKeybind,
  isDialogOpen,
  isEditableElement,
  KEYBINDS,
  matchesKeybind,
} from "@/browser/utils/ui/keybinds";
import { getErrorMessage } from "@/common/utils/errors";
import type { SettingsBackupInput } from "@/common/orpc/schemas/backup";

type BackupRoute = keyof APIClient["backup"];
type BackupRouteOutput<Route extends BackupRoute> = Awaited<ReturnType<APIClient["backup"][Route]>>;
type BackupSuccessData<Route extends Exclude<BackupRoute, "getSettings">> = Extract<
  BackupRouteOutput<Route>,
  { success: true }
>["data"];
type BackupValidation = BackupSuccessData<"validate">;
type BackupPreview = BackupSuccessData<"preview">;
type BackupCommandApproval = BackupPreview["commandApprovals"][number];
type BackupProjectImport = BackupPreview["projectImports"][number];
type BackupProjectImportResult = BackupSuccessData<"restore">["projectImportResults"][number];
type BackupOperationError = Extract<BackupRouteOutput<"push">, { success: false }>["error"];

/** Per-candidate approval state, keyed by the candidate's content-bound token. */
interface ProjectImportSelection {
  approved: boolean;
  targetPath: string;
}

const BACKUP_SHORTCUTS = [
  ["save", KEYBINDS.SETTINGS_BACKUP_SAVE],
  ["validate", KEYBINDS.SETTINGS_BACKUP_VALIDATE],
  ["preview", KEYBINDS.SETTINGS_BACKUP_PREVIEW],
  ["push", KEYBINDS.SETTINGS_BACKUP_PUSH],
  ["restore", KEYBINDS.SETTINGS_BACKUP_RESTORE],
  ["toggleOverride", KEYBINDS.SETTINGS_BACKUP_OVERRIDE_SECRET_SCAN],
  ["toggleApproveCommands", KEYBINDS.SETTINGS_BACKUP_APPROVE_COMMANDS],
  ["toggleProjects", KEYBINDS.SETTINGS_BACKUP_TOGGLE_PROJECTS],
] as const;

type BackupShortcutAction = (typeof BACKUP_SHORTCUTS)[number][0];
type BackupShortcutHandlers = Record<BackupShortcutAction, () => void | Promise<void>>;

const INCLUDED_SETTINGS = [
  "Global instructions",
  "Agent definitions",
  "Agent skills",
  "Global memory",
  "MCP server configuration",
  "Portable preferences",
] as const;

type BackupDraft = SettingsBackupInput;

const DEFAULT_DRAFT: BackupDraft = {
  repoUrl: "",
  branch: "main",
  path: "xum/",
  includeProjects: false,
};

function toDraft(settings: SettingsBackupInput): BackupDraft {
  return {
    repoUrl: settings.repoUrl,
    branch: settings.branch,
    path: settings.path,
    includeProjects: settings.includeProjects === true,
  };
}

function draftsEqual(left: BackupDraft, right: BackupDraft): boolean {
  return (
    left.repoUrl === right.repoUrl &&
    left.branch === right.branch &&
    left.path === right.path &&
    (left.includeProjects === true) === (right.includeProjects === true)
  );
}

function getOperationErrorMessage(error: BackupOperationError): string {
  if (!error.files?.length) return error.message;
  return `${error.message}: ${error.files.join(", ")}`;
}

function getCredentialLabel(credential: BackupValidation["credential"]): string {
  switch (credential) {
    case "ssh":
      return "SSH key or agent";
    case "gh":
      return "GitHub CLI";
    case "ambient":
      return "system git credentials";
  }
}

/**
 * Preferences restore through config rather than a file, so a run that only changed
 * preferences reports zero files. Saying "no files changed" avoids reading as a no-op.
 */
/**
 * An import that skipped conflicting files is not a success: no origin was recorded for it and
 * the candidate is offered again, so the same screen must not call it imported in green while
 * asking for another approval.
 */
function importResultLabel(result: BackupProjectImportResult): string {
  if (result.status === "failed") return "Failed";
  return result.skippedFiles.length > 0 ? "Partially imported" : "Imported";
}

function importResultTone(result: BackupProjectImportResult): string {
  if (result.status === "failed") return "text-error";
  return result.skippedFiles.length > 0 ? "text-warning" : "text-success";
}

/**
 * Results of a later restore run merged over the earlier ones, per import. The files an
 * earlier attempt added stay listed — a retry finds them in place and reports only what it
 * added itself — and a registration the earlier attempt made stays marked, since neither is
 * covered by the safety snapshot and both are what undoing the import means removing.
 */
function mergeImportResults(
  previous: readonly BackupProjectImportResult[],
  next: readonly BackupProjectImportResult[]
): BackupProjectImportResult[] {
  const key = (result: BackupProjectImportResult) => `${result.sourcePath}\0${result.targetPath}`;
  const merged = new Map(previous.map((result) => [key(result), result]));
  for (const result of next) {
    const earlier = merged.get(key(result));
    merged.set(
      key(result),
      earlier === undefined
        ? result
        : {
            ...result,
            writtenFiles: [...new Set([...earlier.writtenFiles, ...result.writtenFiles])],
            registered: earlier.registered || result.registered,
          }
    );
  }
  return [...merged.values()];
}

function describeRestoredFiles(count: number): string {
  if (count === 0) return "settings; no files changed";
  return `${count} file${count === 1 ? "" : "s"}`;
}

function ChangeList(props: {
  title: string;
  emptyLabel: string;
  changes: BackupPreview["pushChanges"];
  /** Replaces the list when this half of the preview could not be computed. */
  error?: string | null;
}) {
  return (
    <div className="border-border-light min-w-0 rounded-md border p-3">
      <h4 className="text-foreground text-xs font-medium">{props.title}</h4>
      {props.error != null ? (
        <p className="text-error mt-2 text-xs break-words">{props.error}</p>
      ) : props.changes.length === 0 ? (
        <p className="text-muted mt-2 text-xs">{props.emptyLabel}</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {props.changes.map((change) => (
            <li key={`${change.status}:${change.path}`} className="flex min-w-0 gap-2 text-xs">
              <span className="text-accent w-5 shrink-0 font-mono">{change.status}</span>
              <span className="text-muted min-w-0 break-all">{change.path}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function BackupSection() {
  const { api } = useAPI();
  const [draft, setDraft] = useState<BackupDraft>(DEFAULT_DRAFT);
  const [savedDraft, setSavedDraft] = useState<BackupDraft>(DEFAULT_DRAFT);
  const [loading, setLoading] = useState(true);
  const [settingsFresh, setSettingsFresh] = useState(false);
  const [activeAction, setActiveAction] = useState<
    "save" | "validate" | "preview" | "push" | "restore" | null
  >(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [validation, setValidation] = useState<BackupValidation | null>(null);
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [overrideSecretScan, setOverrideSecretScan] = useState(false);
  const [secretScanBlocked, setSecretScanBlocked] = useState(false);
  const [secretScanApproval, setSecretScanApproval] = useState<string | null>(null);
  const [commandApprovals, setCommandApprovals] = useState<BackupCommandApproval[]>([]);
  const [approveCommands, setApproveCommands] = useState(false);
  const [projectImports, setProjectImports] = useState<BackupProjectImport[]>([]);
  const [projectImportSelections, setProjectImportSelections] = useState<
    Record<string, ProjectImportSelection>
  >({});
  const [projectImportResults, setProjectImportResults] = useState<BackupProjectImportResult[]>([]);
  const [projectBundleSkipped, setProjectBundleSkipped] = useState(false);
  const [restoreConfirmationOpen, setRestoreConfirmationOpen] = useState(false);
  const refreshGenerationRef = useRef(0);
  const draftRef = useRef(draft);
  const savedDraftRef = useRef(savedDraft);
  const refreshRef = useRef<((options?: { markFresh?: boolean }) => Promise<void>) | null>(null);
  draftRef.current = draft;
  savedDraftRef.current = savedDraft;

  const isDirty = !draftsEqual(draft, savedDraft);
  const configured = settingsFresh && savedDraft.repoUrl.trim() !== "";
  const saving = activeAction === "save";
  const busy = activeAction !== null;

  useEffect(() => {
    if (!api) {
      setLoading(false);
      setSettingsFresh(false);
      setSaveError("Backup settings are unavailable while disconnected.");
      return;
    }

    const abortController = new AbortController();
    const { signal } = abortController;
    let iterator: AsyncIterator<unknown> | null = null;
    // Liveness belongs to this API subscription. An older effect can finish after its
    // replacement starts, so sharing this flag across generations creates stale writes.
    let streamLive = false;
    setLoading(true);
    setSettingsFresh(false);
    setSaveError(null);

    const refresh = async (options?: { markFresh?: boolean }) => {
      const version = (refreshGenerationRef.current += 1);
      setSettingsFresh(false);

      try {
        const settings = await api.backup.getSettings();
        if (signal.aborted || version !== refreshGenerationRef.current) return;

        const nextDraft = settings ? toDraft(settings) : DEFAULT_DRAFT;
        const previousSavedDraft = savedDraftRef.current;
        if (draftsEqual(draftRef.current, previousSavedDraft)) {
          draftRef.current = nextDraft;
          setDraft(nextDraft);
        }
        savedDraftRef.current = nextDraft;
        setSavedDraft(nextDraft);
        if (options?.markFresh !== false && streamLive) setSettingsFresh(true);
        setSaveError(null);

        if (!draftsEqual(previousSavedDraft, nextDraft)) {
          setValidation(null);
          setPreview(null);
          setOverrideSecretScan(false);
          setSecretScanBlocked(false);
          setSecretScanApproval(null);
          setCommandApprovals([]);
          setApproveCommands(false);
          setProjectImports([]);
          setProjectImportSelections({});
          setProjectBundleSkipped(false);
          setRestoreConfirmationOpen(false);
          setActionError(null);
          setStatusMessage(null);
        }
      } catch (error) {
        if (!signal.aborted && version === refreshGenerationRef.current) {
          setSaveError(getErrorMessage(error));
        }
      } finally {
        if (!signal.aborted && version === refreshGenerationRef.current) {
          setLoading(false);
        }
      }
    };

    refreshRef.current = refresh;

    void (async () => {
      // Show the initial snapshot, but keep actions stale until a post-arm refresh covers
      // config changes made while the subscription was starting.
      const initialRefresh = refresh({ markFresh: false });
      let subscribed: AsyncIterator<unknown>;
      let nextEvent: Promise<IteratorResult<unknown>>;
      try {
        subscribed = await api.config.onConfigChanged(undefined, { signal });
        if (signal.aborted) {
          await subscribed.return?.();
          return;
        }
        iterator = subscribed;
        nextEvent = subscribed.next();
        streamLive = true;
      } catch {
        // Without a listener, future changes go unseen, so show the snapshot but keep
        // destructive actions stale.
        await initialRefresh;
        if (signal.aborted) return;
        await refresh();
        return;
      }

      // Refresh again to cover changes made while the subscription was starting.
      await refresh();
      try {
        while (!signal.aborted) {
          const event = await nextEvent;
          if (event.done || signal.aborted) break;
          nextEvent = subscribed.next();
          await refresh();
        }
        streamLive = false;
        if (!signal.aborted) setSettingsFresh(false);
      } catch {
        // A dead stream can no longer report another window's changes, so the loaded
        // settings stay visible but are no longer fresh enough for destructive actions.
        streamLive = false;
        if (!signal.aborted) setSettingsFresh(false);
      }
    })();

    return () => {
      refreshRef.current = null;
      abortController.abort();
      void iterator?.return?.();
    };
  }, [api]);

  async function handleSave() {
    if (!api || activeAction !== null) return;
    if (draft.repoUrl.trim() === "") {
      setSaveError("Repository URL is required.");
      return;
    }
    if (draft.branch.trim() === "") {
      setSaveError("Branch is required.");
      return;
    }
    if (draft.path.trim() === "") {
      setSaveError("Subdirectory is required.");
      return;
    }

    setActiveAction("save");
    setSaveError(null);
    setActionError(null);
    setStatusMessage(null);

    try {
      const result = await api.backup.saveSettings({
        repoUrl: draft.repoUrl.trim(),
        branch: draft.branch.trim(),
        path: draft.path.trim(),
        includeProjects: draft.includeProjects === true,
      });
      if (!result.success) {
        setSaveError(getOperationErrorMessage(result.error));
        return;
      }

      const nextDraft = toDraft(result.data);
      draftRef.current = nextDraft;
      savedDraftRef.current = nextDraft;
      setDraft(nextDraft);
      setSavedDraft(nextDraft);
      setValidation(null);
      setPreview(null);
      // With the preview: they describe the repository that was previewed, and carrying
      // them past a save would show, and resend on restore, another repository's approvals.
      // Import results are not among them: they describe files added and projects
      // registered on this machine, which changing a setting does not undo, and are the only
      // record of what undoing an import means removing.
      setCommandApprovals([]);
      setApproveCommands(false);
      setProjectImports([]);
      setProjectImportSelections({});
      setProjectBundleSkipped(false);
      setOverrideSecretScan(false);
      setSecretScanBlocked(false);
      setStatusMessage("Backup settings saved.");
      // The save response may already be stale, and no config event is guaranteed to follow.
      // Re-read configuration before granting freshness.
      await refreshRef.current?.();
    } catch (error) {
      setSaveError(getErrorMessage(error));
    } finally {
      setActiveAction(null);
    }
  }

  function requireSavedSettings(): boolean {
    if (!settingsFresh) {
      setActionError("Backup settings changed; wait for them to refresh.");
      return false;
    }
    if (!configured) {
      setActionError("Save a repository before using backup actions.");
      return false;
    }
    if (isDirty) {
      setActionError("Save your changes before using backup actions.");
      return false;
    }
    return true;
  }

  async function handleValidate() {
    if (!api || busy || !requireSavedSettings()) return;
    setActiveAction("validate");
    setActionError(null);
    setStatusMessage(null);
    setValidation(null);

    try {
      const result = await api.backup.validate(savedDraft);
      if (!result.success) {
        setActionError(getOperationErrorMessage(result.error));
        return;
      }
      setValidation(result.data);
      setStatusMessage(
        result.data.empty ? "Repository is reachable and empty." : "Repository is reachable."
      );
    } catch (error) {
      setActionError(getErrorMessage(error));
    } finally {
      setActiveAction(null);
    }
  }

  async function handlePreview() {
    if (!api || busy || !requireSavedSettings()) return;
    setActiveAction("preview");
    setActionError(null);
    setStatusMessage(null);
    setPreview(null);
    setOverrideSecretScan(false);
    // The project half of the preview is cleared with the rest of it: left standing through
    // a failed preview, the old cards would offer a plan the repository no longer describes.
    // Import results are not part of the preview and stay: they list what earlier restores
    // wrote and registered, which the user needs to undo an import and a preview does not
    // change.
    setProjectImports([]);
    setProjectBundleSkipped(false);

    try {
      const result = await api.backup.preview(savedDraft);
      if (!result.success) {
        setActionError(getOperationErrorMessage(result.error));
        return;
      }
      setPreview(result.data);
      setSecretScanBlocked(false);
      const nextApprovals = result.data.commandApprovals;
      // An approval only covers the exact command text the user read, so a changed list
      // has to be read again.
      const sameCommands =
        nextApprovals.length === commandApprovals.length &&
        nextApprovals.every((approval, index) => commandApprovals[index]?.token === approval.token);
      setCommandApprovals(nextApprovals);
      if (!sameCommands) setApproveCommands(false);
      const nextImports = result.data.projectImports;
      setProjectImports(nextImports);
      // Tokens are content-bound, so a selection carried over by token still describes the
      // exact entry the user approved; anything else starts unapproved.
      setProjectImportSelections((current) => {
        const next: Record<string, ProjectImportSelection> = {};
        for (const candidate of nextImports) {
          next[candidate.token] = current[candidate.token] ?? {
            approved: false,
            targetPath: "",
          };
        }
        return next;
      });
      setProjectBundleSkipped(result.data.projectBundleSkipped);
      setStatusMessage("Preview refreshed.");
    } catch (error) {
      setActionError(getErrorMessage(error));
    } finally {
      setActiveAction(null);
    }
  }

  async function handlePush() {
    if (!api || busy || !requireSavedSettings()) return;
    setActiveAction("push");
    setActionError(null);
    setStatusMessage(null);

    try {
      const result = await api.backup.push({
        ...savedDraft,
        // The digest from the block the user is looking at, so approval cannot carry over to
        // a payload another window changed in between. Sent only while the control is visible.
        approvedSecretDigest:
          overrideSecretScan && secretScanBlocked ? (secretScanApproval ?? undefined) : undefined,
      });
      if (!result.success) {
        setActionError(getOperationErrorMessage(result.error));
        const blocked = result.error.code === "SECRET_DETECTED";
        setSecretScanBlocked(blocked);
        // A new digest means new bytes, so a previous approval no longer describes them.
        const nextApproval = blocked ? (result.error.secretApproval ?? null) : null;
        if (nextApproval !== secretScanApproval) setOverrideSecretScan(false);
        setSecretScanApproval(nextApproval);
        if (!blocked) setOverrideSecretScan(false);
        return;
      }
      setPreview(null);
      setOverrideSecretScan(false);
      setSecretScanBlocked(false);
      setSecretScanApproval(null);
      // The push replaced the remote bundle the candidates and the skipped flag described;
      // their tokens no longer match anything, so a restore would only be refused.
      setProjectImports([]);
      setProjectImportSelections({});
      setProjectBundleSkipped(false);
      setStatusMessage(
        `Backed up settings at ${result.data.commit} using ${getCredentialLabel(result.data.credential)}.`
      );
    } catch (error) {
      setActionError(getErrorMessage(error));
    } finally {
      setActiveAction(null);
    }
  }

  async function handleRestore() {
    if (!api || busy || !requireSavedSettings()) return;
    setActiveAction("restore");
    setActionError(null);
    setStatusMessage(null);

    try {
      const result = await api.backup.restore({
        ...savedDraft,
        approvedCommandTokens: approveCommands ? commandApprovals.map((item) => item.token) : [],
        // Only candidates the user explicitly checked; the backend re-verifies each token
        // against the checked-out payload and validates the target path.
        projectImports: projectImports
          .filter((candidate) => projectImportSelections[candidate.token]?.approved === true)
          .map((candidate) => ({
            token: candidate.token,
            targetPath: projectImportSelections[candidate.token]?.targetPath.trim() ?? "",
          })),
      });
      if (!result.success) {
        // A failure after the snapshot completed may have overwritten files already; the
        // snapshot is the only recovery path, so its location belongs in the error.
        setActionError(
          result.error.snapshotPath != null
            ? `${getOperationErrorMessage(result.error)} Your settings from before the restore are saved at: ${result.error.snapshotPath}`
            : getOperationErrorMessage(result.error)
        );
        setRestoreConfirmationOpen(false);
        // The commands the restore would write are not the ones on screen, either because
        // the backup changed since the preview or because there was no preview at all.
        // The error carries the current list, so show it and require a fresh approval.
        if (result.error.code === "COMMAND_APPROVAL_REQUIRED") {
          setCommandApprovals(result.error.commandApprovals ?? []);
          setApproveCommands(false);
        }
        // Same round trip for project imports: stale tokens come back with the current
        // candidate list, which needs fresh approvals.
        if (result.error.code === "PROJECT_IMPORT_APPROVAL_REQUIRED") {
          const nextImports = result.error.projectImports ?? [];
          setProjectImports(nextImports);
          setProjectImportSelections(
            Object.fromEntries(
              nextImports.map((candidate) => [candidate.token, { approved: false, targetPath: "" }])
            )
          );
        }
        return;
      }
      setPreview(null);
      setOverrideSecretScan(false);
      setSecretScanBlocked(false);
      setCommandApprovals([]);
      setApproveCommands(false);
      // Candidates the restore left out for lack of approval stay on offer with their fresh
      // tokens, so a restore run without a preview never hides backed-up projects.
      const unapproved = result.data.unapprovedProjectImports;
      setProjectImports(unapproved);
      setProjectImportSelections(
        Object.fromEntries(
          unapproved.map((candidate) => [candidate.token, { approved: false, targetPath: "" }])
        )
      );
      setProjectImportResults((previous) =>
        mergeImportResults(previous, result.data.projectImportResults)
      );
      setProjectBundleSkipped(result.data.projectBundleSkipped);
      setStatusMessage(
        `Restored ${describeRestoredFiles(result.data.changedFiles.length)}. Safety snapshot: ${result.data.snapshotPath}${
          unapproved.length === 0
            ? ""
            : ` ${unapproved.length} backed-up ${unapproved.length === 1 ? "project was" : "projects were"} not imported; approve them below to import.`
        }`
      );
      setRestoreConfirmationOpen(false);
    } catch (error) {
      setActionError(getErrorMessage(error));
      setRestoreConfirmationOpen(false);
    } finally {
      setActiveAction(null);
    }
  }

  function openRestoreConfirmation() {
    if (busy || !requireSavedSettings()) return;
    setRestoreConfirmationOpen(true);
  }

  const actionsRef = useRef<BackupShortcutHandlers | null>(null);
  actionsRef.current = {
    save: handleSave,
    validate: handleValidate,
    preview: handlePreview,
    push: handlePush,
    restore: openRestoreConfirmation,
    toggleOverride: () => {
      // Mirrors the checkbox's own render condition so the shortcut is never advertised
      // while the control is hidden, and never inert while it is visible.
      if (!busy && secretScanBlocked) {
        setOverrideSecretScan((current) => !current);
      }
    },
    toggleApproveCommands: () => {
      if (!busy && commandApprovals.length > 0) {
        setApproveCommands((current) => !current);
      }
    },
    toggleProjects: () => {
      if (!busy) {
        setDraft((current) => ({ ...current, includeProjects: current.includeProjects !== true }));
      }
    },
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isDialogOpen() || isEditableElement(event.target)) return;

      const shortcut = BACKUP_SHORTCUTS.find(([, keybind]) => matchesKeybind(event, keybind));
      const action = shortcut && actionsRef.current?.[shortcut[0]];
      if (!action) return;

      event.preventDefault();
      event.stopPropagation();
      void action();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (loading) {
    return <div className="text-muted text-sm">Loading backup settings...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="bg-warning/10 border-warning/30 text-warning flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
        <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p>
          Settings backup is experimental. It may change or be removed in a future release; use it
          carefully.
        </p>
      </div>

      <div>
        <h3 className="text-foreground text-sm font-medium">Settings backup</h3>
        <p className="text-muted mt-1 text-xs">
          Back up portable Xum settings to a git repository using credentials already available on
          this machine.
        </p>
      </div>

      <section className="border-border-light space-y-4 rounded-md border p-4">
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <label className="min-w-0 space-y-1.5 sm:col-span-2">
            <span className="text-foreground text-xs font-medium">Repository URL</span>
            <Input
              value={draft.repoUrl}
              onChange={(event) =>
                setDraft((current) => ({ ...current, repoUrl: event.target.value }))
              }
              placeholder="git@github.com:you/dotfiles.git"
              disabled={busy}
            />
          </label>
          <label className="min-w-0 space-y-1.5">
            <span className="text-foreground text-xs font-medium">Branch</span>
            <Input
              value={draft.branch}
              onChange={(event) =>
                setDraft((current) => ({ ...current, branch: event.target.value }))
              }
              placeholder="main"
              disabled={busy}
            />
          </label>
          <label className="min-w-0 space-y-1.5">
            <span className="text-foreground text-xs font-medium">Subdirectory</span>
            <Input
              value={draft.path}
              onChange={(event) =>
                setDraft((current) => ({ ...current, path: event.target.value }))
              }
              placeholder="xum/"
              disabled={busy}
            />
          </label>
        </div>

        <label className="flex items-start gap-2">
          <Checkbox
            checked={draft.includeProjects === true}
            onCheckedChange={(checked) =>
              setDraft((current) => ({ ...current, includeProjects: checked === true }))
            }
            disabled={busy}
            aria-label="Include project list and project memories"
          />
          <span className="min-w-0">
            <span className="text-foreground block text-xs font-medium">
              Include project list &amp; project memories
              {/* Shortcut hint only; the shortcut itself stays bound on every viewport. */}
              <span className="text-muted ml-1 hidden font-normal sm:inline">
                ({formatKeybind(KEYBINDS.SETTINGS_BACKUP_TOGGLE_PROJECTS)})
              </span>
            </span>
            <span className="text-muted mt-0.5 block text-xs">
              Adds your project list and per-project memories to the backup, and lets a restore
              reimport them on another machine. Previously pushed backups keep project data in the
              repository&apos;s git history even after disabling.
            </span>
          </span>
        </label>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button
            size="sm"
            onClick={() => void handleSave()}
            disabled={busy || !isDirty}
            tooltip={`Save settings (${formatKeybind(KEYBINDS.SETTINGS_BACKUP_SAVE)})`}
            className="w-full sm:w-auto"
          >
            {saving ? "Saving..." : "Save settings"}
          </Button>
          {isDirty ? <span className="text-warning text-xs">Unsaved changes</span> : null}
        </div>
        {saveError ? <p className="text-error text-xs">{saveError}</p> : null}
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-foreground text-sm font-medium">Included</h3>
          <p className="text-muted mt-1 text-xs">Only portable, allowlisted settings are copied.</p>
        </div>
        <ul className="grid gap-2 sm:grid-cols-2">
          {[
            ...INCLUDED_SETTINGS,
            ...(savedDraft.includeProjects === true
              ? (["Project list & project memories"] as const)
              : []),
          ].map((item) => (
            <li key={item} className="text-muted flex items-center gap-2 text-xs">
              <CheckCircle2 className="text-success h-3.5 w-3.5 shrink-0" />
              {item}
            </li>
          ))}
        </ul>
        <p className="text-foreground text-xs font-medium">
          Provider key files and dedicated secret files have no export path. MCP commands and URLs
          are included verbatim; credential-like URL components require review, while literal MCP
          header values are redacted. Inside skills and memory, only documentation is published
          automatically; any other file waits for you to review it.
        </p>
      </section>

      <section className="border-border-light space-y-3 rounded-md border p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-foreground text-sm font-medium">Repository access</h3>
            <p className="text-muted mt-1 text-xs">
              Xum tries SSH, GitHub CLI credentials, then system git credentials.
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleValidate()}
            disabled={busy || isDirty || !configured}
            tooltip={`Validate repository (${formatKeybind(KEYBINDS.SETTINGS_BACKUP_VALIDATE)})`}
            className="w-full shrink-0 sm:w-auto"
          >
            <RefreshCw className={activeAction === "validate" ? "animate-spin" : ""} />
            Validate
          </Button>
        </div>
        {validation ? (
          <div className="bg-background-secondary rounded-md px-3 py-2 text-xs">
            <div className="text-foreground">
              Credential used: {getCredentialLabel(validation.credential)}
            </div>
            <div className="text-muted mt-1">
              {validation.empty
                ? "Empty repository, ready for the first backup."
                : "Repository is reachable."}
            </div>
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-foreground text-sm font-medium">Preview</h3>
            <p className="text-muted mt-1 text-xs">
              Review what a backup would write and what a restore would change locally.
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handlePreview()}
            disabled={busy || isDirty || !configured}
            tooltip={`Preview changes (${formatKeybind(KEYBINDS.SETTINGS_BACKUP_PREVIEW)})`}
            className="w-full shrink-0 sm:w-auto"
          >
            Preview changes
          </Button>
        </div>

        {preview ? (
          <div className="space-y-3">
            <div className="grid min-w-0 gap-3 lg:grid-cols-2">
              <ChangeList
                title="Backup to repository"
                emptyLabel="No repository changes."
                changes={preview.pushChanges}
                error={preview.pushError}
              />
              <ChangeList
                title="Restore to this device"
                emptyLabel="No local changes."
                changes={preview.restoreChanges}
              />
            </div>

            {preview.localOnlyFiles.length > 0 ? (
              <div className="border-border-light rounded-md border p-3">
                <h4 className="text-foreground text-xs font-medium">Kept local-only files</h4>
                <ul className="text-muted mt-2 space-y-1 text-xs">
                  {preview.localOnlyFiles.map((file) => (
                    <li key={file} className="break-all">
                      {file}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="border-border-light rounded-md border p-3">
              <h4 className="text-foreground text-xs font-medium">
                Redacted from repository backup
              </h4>
              {preview.redactions.length === 0 ? (
                <p className="text-muted mt-2 text-xs">No MCP values were redacted.</p>
              ) : (
                <ul className="text-muted mt-2 space-y-1 text-xs">
                  {preview.redactions.map((redaction) => (
                    <li key={redaction} className="break-all">
                      {redaction}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : (
          <div className="border-border-light text-muted rounded-md border border-dashed p-4 text-xs">
            Run a preview to compare both directions and inspect redactions.
          </div>
        )}
      </section>

      {secretScanBlocked ? (
        <div className="border-border-light rounded-md border p-3">
          <label className="flex items-start gap-2">
            <Checkbox
              checked={overrideSecretScan}
              onCheckedChange={(checked) => setOverrideSecretScan(checked === true)}
              disabled={busy}
              aria-label="Override secret scan"
            />
            <span className="min-w-0">
              <span className="text-foreground block text-xs font-medium">
                Override secret scan
              </span>
              <span className="text-muted mt-0.5 block text-xs">
                Publish the exact files listed in the error above. If they change before you back
                up, this resets so you can read the new list.
              </span>
            </span>
          </label>
          <p className="text-muted mt-2 text-xs">
            Leave this off unless you have read the listed files and intend to publish them.
          </p>
        </div>
      ) : null}

      {actionError ? <div className="text-error text-xs">{actionError}</div> : null}
      {statusMessage ? <div className="text-success text-xs">{statusMessage}</div> : null}

      <section className="border-border-light flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center">
        <Button
          onClick={() => void handlePush()}
          disabled={busy || isDirty || !configured}
          tooltip={`Back up settings (${formatKeybind(KEYBINDS.SETTINGS_BACKUP_PUSH)})`}
          className="w-full sm:w-auto"
        >
          <CloudUpload />
          {activeAction === "push" ? "Backing up..." : "Back up now"}
        </Button>
        <Button
          variant="destructive"
          onClick={openRestoreConfirmation}
          disabled={busy || isDirty || !configured}
          tooltip={`Restore settings (${formatKeybind(KEYBINDS.SETTINGS_BACKUP_RESTORE)})`}
          className="w-full sm:w-auto"
        >
          <ArchiveRestore />
          Restore
        </Button>
      </section>

      {commandApprovals.length > 0 ? (
        <div className="border-border-light rounded-md border p-3">
          <label className="flex items-start gap-2">
            <Checkbox
              checked={approveCommands}
              onCheckedChange={(checked) => setApproveCommands(checked === true)}
              disabled={busy}
              aria-label="Approve MCP command changes"
            />
            <span className="min-w-0">
              <span className="text-foreground block text-xs font-medium">
                Approve the listed executable MCP command changes
              </span>
              <span className="text-muted mt-0.5 block text-xs">
                Restoring writes these commands, and Xum runs them when the server starts. Restore
                is blocked until you approve them.
              </span>
              <ul className="mt-2 space-y-1.5">
                {commandApprovals.map((approval) => (
                  <li key={approval.token} className="min-w-0 text-xs">
                    <span className="text-muted block break-all">{approval.path}</span>
                    <code className="text-foreground block break-all">{approval.command}</code>
                  </li>
                ))}
              </ul>
            </span>
          </label>
        </div>
      ) : null}

      {projectBundleSkipped ? (
        <div className="border-border-light text-muted rounded-md border p-3 text-xs">
          This backup carries a project bundle, but project backup is disabled here, so it was
          skipped. Enable “Include project list &amp; project memories” and save to restore it.
        </div>
      ) : null}

      {projectImports.length > 0 ? (
        <div className="border-border-light space-y-3 rounded-md border p-3">
          <div>
            <h4 className="text-foreground text-xs font-medium">Projects to reimport</h4>
            <p className="text-muted mt-1 text-xs">
              These backed-up projects are not registered here at their recorded paths. Nothing is
              written for them unless you approve an import: clone or locate the project directory
              yourself, enter its local path, and check the project. Approving registers the project
              and adds its memories without overwriting existing files.
            </p>
          </div>
          <ul className="space-y-3">
            {projectImports.map((candidate) => {
              const selection = projectImportSelections[candidate.token] ?? {
                approved: false,
                targetPath: "",
              };
              return (
                <li key={candidate.token} className="border-border-light rounded-md border p-3">
                  <label className="flex items-start gap-2">
                    <Checkbox
                      checked={selection.approved}
                      onCheckedChange={(checked) =>
                        setProjectImportSelections((current) => ({
                          ...current,
                          [candidate.token]: { ...selection, approved: checked === true },
                        }))
                      }
                      disabled={busy}
                      aria-label={`Import project ${candidate.name}`}
                    />
                    <span className="min-w-0 flex-1">
                      {/* break-all: the name is repository-controlled and may be one long token. */}
                      <span className="text-foreground block text-xs font-medium break-all">
                        {candidate.name}
                        <span className="text-muted ml-1 font-normal">
                          ({candidate.memoryFileCount} memory{" "}
                          {candidate.memoryFileCount === 1 ? "file" : "files"})
                        </span>
                      </span>
                      <span className="text-muted mt-0.5 block text-xs break-all">
                        Backed up from: {candidate.sourcePath}
                      </span>
                      {/* Inert text on purpose: the remote is repository-controlled data,
                          never a link and never executed. */}
                      {candidate.gitRemote != null ? (
                        <span className="text-muted mt-0.5 block text-xs break-all">
                          Remote: {candidate.gitRemote}
                        </span>
                      ) : null}
                    </span>
                  </label>
                  <label className="mt-2 block space-y-1.5">
                    <span className="text-foreground text-xs font-medium">
                      Local project directory
                    </span>
                    <Input
                      value={selection.targetPath}
                      onChange={(event) =>
                        setProjectImportSelections((current) => ({
                          ...current,
                          [candidate.token]: { ...selection, targetPath: event.target.value },
                        }))
                      }
                      // Never prefilled from the backup: the recorded path is repository-
                      // controlled, and on Windows a UNC path merely probed by the restore
                      // would start SMB authentication. The user names a local directory.
                      placeholder="Absolute path of the local checkout"
                      disabled={busy}
                    />
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {projectImportResults.length > 0 ? (
        <div className="border-border-light space-y-2 rounded-md border p-3">
          <h4 className="text-foreground text-xs font-medium">Project import results</h4>
          <ul className="space-y-2">
            {projectImportResults.map((importResult) => (
              <li
                key={`${importResult.sourcePath}:${importResult.targetPath}`}
                className="min-w-0 text-xs"
              >
                <span className={`${importResultTone(importResult)} block break-all`}>
                  {importResultLabel(importResult)}: {importResult.name} → {importResult.targetPath}
                </span>
                {importResult.message != null ? (
                  <span className="text-muted block break-all">{importResult.message}</span>
                ) : null}
                {importResult.writtenFiles.length > 0 ? (
                  <span className="text-muted block break-all">
                    Added memory {importResult.writtenFiles.length === 1 ? "file" : "files"}:{" "}
                    {importResult.writtenFiles.join(", ")}
                  </span>
                ) : null}
                {importResult.registered ? (
                  <span className="text-muted block break-all">Newly registered project</span>
                ) : null}
                {importResult.skippedFiles.length > 0 ? (
                  <span className="text-warning block break-all">
                    Kept existing files with different content:{" "}
                    {importResult.skippedFiles.join(", ")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="text-muted text-xs">
            The safety snapshot does not cover imported memory files or project registrations. To
            undo an import, delete the added files
            {projectImportResults.some((importResult) => importResult.registered)
              ? " and remove the projects marked as newly registered"
              : ""}
            .
          </p>
        </div>
      ) : null}

      <ConfirmationModal
        isOpen={restoreConfirmationOpen}
        title="Restore settings backup?"
        description="This overwrites local files and portable preferences that are present in the backup. Local-only files are kept."
        warning="Xum will create a safety snapshot first, but restoring can immediately change settings in open windows."
        confirmLabel={activeAction === "restore" ? "Restoring..." : "Restore settings"}
        confirmVariant="destructive"
        onConfirm={handleRestore}
        onCancel={() => setRestoreConfirmationOpen(false)}
      />
    </div>
  );
}
