import * as path from "path";
import { EventEmitter } from "events";
import * as fs from "fs";
import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { isErrnoWithCode } from "@/node/utils/fs";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import { spawn } from "child_process";
import { secretsToRecord } from "@/common/types/secrets";
import { SecretsStore, type Config } from "@/node/config";
import { getXumEnv, getRuntimeType } from "@/node/runtime/initHook";
import type { PTYService } from "@/node/services/ptyService";
import type { TerminalWindowManager } from "@/desktop/terminalWindowManager";
import type {
  TerminalSession,
  TerminalCreateParams,
  TerminalResizeParams,
} from "@/common/types/terminal";
import type { RuntimeConfig } from "@/common/types/runtime";
import { isSSHRuntime, isDockerRuntime, isDevcontainerRuntime } from "@/common/types/runtime";
import {
  createRuntimeForWorkspace,
  resolveWorkspaceExecutionPath,
} from "@/node/runtime/runtimeHelpers";
import { log } from "@/node/services/log";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { isCommandAvailable, findAvailableCommand } from "@/node/utils/commandDiscovery";
import { resolveContainerCli } from "@/node/runtime/containerCli";
import { sanitizeXumChildEnv } from "@/node/runtime/childProcessEnv";
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { NO_OSC_IDLE_FALLBACK_MS } from "@/constants/terminalActivity";
import { getErrorMessage } from "@/common/utils/errors";
import { shellQuote } from "@/common/utils/shell";

function quoteForNativeTerminalCommandArg(value: string): string {
  if (process.platform === "win32") {
    // cmd.exe expands %VAR% even in double quotes, so escape literal % as %%.
    return `"${value.replace(/%/g, "%%").replace(/"/g, '""')}"`;
  }
  return shellQuote(value);
}

/**
 * Configuration for opening a native terminal
 */
type NativeTerminalConfig =
  | { type: "local"; workspacePath: string; command?: string }
  | {
      type: "ssh";
      sshConfig: Extract<RuntimeConfig, { type: "ssh" }>;
      remotePath: string;
      command?: string;
    };

export class TerminalService {
  private readonly config: Config;
  private readonly ptyService: PTYService;
  private terminalWindowManager?: TerminalWindowManager;

  // Event emitters for each session
  private readonly outputEmitters = new Map<string, EventEmitter>();
  private readonly exitEmitters = new Map<string, EventEmitter>();

  // Headless terminals for maintaining parsed terminal state on the backend.
  // On reconnect, we serialize the screen state (~4KB) instead of replaying raw output (~512KB).
  private readonly headlessTerminals = new Map<string, Terminal>();
  private readonly serializeAddons = new Map<string, SerializeAddon>();
  private readonly headlessOnDataDisposables = new Map<string, { dispose: () => void }>();
  private readonly titleChangeDisposables = new Map<string, { dispose: () => void }>();

  private shuttingDown = false;
  // Per-session activity tracking for sidebar indicator.
  // Maps sessionId -> { workspaceId, isRunning (derived from terminal title) }.
  private readonly sessionActivity = new Map<string, { workspaceId: string; isRunning: boolean }>();
  // In-flight create() reservations per workspace (see create): counted before any await so
  // archive admission gates observe startups that have not yet registered a session.
  private readonly pendingSessionCreations = new Map<string, number>();
  // Injected by WorkspaceService: true while an archive admission gate is active for the
  // workspace. Checked synchronously with the startup reservation (see create) so a terminal
  // startup and an archive always observe each other.
  private workspaceArchiveGuard: ((workspaceId: string) => boolean) | undefined;

  /**
   * Workspaces a native terminal was opened for. Native emulators are spawned detached and
   * typically daemonize, so neither spawn success nor closure is observable — entries are
   * recorded at open time (even for failed attempts, failing safe) and never removed.
   * Model-facing snapshot archives consult this because removing a checkout under a user's
   * live native shell/editor is unrecoverable. Detached emulators can also outlive Xum
   * itself, so opens are additionally persisted as a durable per-workspace marker that
   * survives app restarts (see nativeTerminalMarkerPath); this Set doubles as a read cache.
   */
  private readonly nativeTerminalWorkspaces = new Set<string>();

  /**
   * Marker ancestry batches per workspace. A batch begins with a disk probe (did a durable
   * marker exist before this batch wrote one?) and collects one launch-evidence token per
   * admitted open; tokens are removed only by failed launches. When the last token of a
   * batch is removed, every open in the batch failed, so the batch's marker is deleted
   * unless it predated the batch (an earlier session's shell may still be running behind
   * it). Successful opens retain their token forever, pinning the marker. Probing per batch
   * — not per call — prevents a marker written by an earlier in-flight open of the same
   * batch from masquerading as pre-existing evidence when every open in the batch fails.
   */
  private readonly nativeTerminalMarkerBatches = new Map<
    string,
    { markerPreexisted: boolean; tokens: Set<symbol> }
  >();

  /**
   * Serializes marker writes against failed-launch rollbacks per workspace: an unserialized
   * rollback's unlink could interleave with a concurrent open's write and delete the marker
   * protecting that open's live shell.
   */
  private readonly nativeTerminalMarkerLocks = new MutexMap<string>();

  /**
   * openNative calls currently in flight per workspace, counted synchronously at entry
   * (before the archive guard check) and released when the call settles. An in-flight open
   * has already passed the archive guard and will launch after its awaits without
   * rechecking, so hasOpenedNativeTerminal counts these alongside durable evidence — a
   * concurrent failed open's rollback may collapse the shared marker and cache entry, and
   * without this count that collapse would make a still-launching sibling invisible to an
   * archive that then removes the environment beneath its shell.
   */
  private readonly pendingNativeTerminalOpens = new Map<string, number>();

  private nativeTerminalMarkerPath(workspaceId: string): string {
    return path.join(this.config.sessionsDir, workspaceId, "native-terminal-opened");
  }

  /**
   * Disk probe for the durable marker. "unknown" means the probe failed in a way that cannot
   * prove absence (EACCES, EIO, ...).
   */
  private async probeNativeTerminalMarkerOnDisk(
    workspaceId: string
  ): Promise<"present" | "absent" | "unknown"> {
    try {
      await fs.promises.access(this.nativeTerminalMarkerPath(workspaceId));
      return "present";
    } catch (error) {
      return isErrnoWithCode(error, "ENOENT") ? "absent" : "unknown";
    }
  }

  /**
   * Synchronous slice of hasOpenedNativeTerminal: whether an open is still in flight
   * (admitted but its durable marker not yet persisted). The pre-interruption archive hold
   * checks this in its synchronous validation block, where the async marker probe cannot
   * run and is unnecessary — established opens are refused by the caller's earlier
   * untrackable-app gate.
   */
  hasPendingNativeTerminalOpen(workspaceId: string): boolean {
    return (this.pendingNativeTerminalOpens.get(workspaceId) ?? 0) > 0;
  }

  /** Whether a native terminal was ever opened for this workspace (survives app restarts). */
  async hasOpenedNativeTerminal(workspaceId: string): Promise<boolean> {
    // Opens still in flight count as opened: see pendingNativeTerminalOpens.
    if ((this.pendingNativeTerminalOpens.get(workspaceId) ?? 0) > 0) {
      return true;
    }
    if (this.nativeTerminalWorkspaces.has(workspaceId)) {
      return true;
    }
    const probe = await this.probeNativeTerminalMarkerOnDisk(workspaceId);
    if (probe === "present") {
      this.nativeTerminalWorkspaces.add(workspaceId);
      return true;
    }
    // An "unknown" probe (EACCES, EIO, ...) cannot prove the marker is absent, and a false
    // "absent" would let a snapshot archive remove the checkout under a surviving terminal —
    // fail closed without caching (the marker may still prove readable later).
    return probe !== "absent";
  }

  setWorkspaceArchiveGuard(guard: (workspaceId: string) => boolean): void {
    this.workspaceArchiveGuard = guard;
  }

  /** Synchronous persisted-archived check for terminal admission (see create). */
  private isArchivedNow(workspaceId: string): boolean {
    const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId);
    return (
      entry != null && isWorkspaceArchived(entry.workspace.archivedAt, entry.workspace.unarchivedAt)
    );
  }
  // Tracks sessions that have received at least one OSC signal (0, 2, or 133).
  // OSC-driven sessions rely on shell-provided idle/running signals and skip the fallback timer.
  private readonly sessionsWithOscActivity = new Set<string>();
  // Fallback timers for non-OSC sessions: auto-reset to idle after NO_OSC_IDLE_FALLBACK_MS.
  private readonly noOscIdleFallbacks = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly activityChangeEmitter = new EventEmitter();

  constructor(
    config: Config,
    ptyService: PTYService,
    private readonly secretsStore: Pick<SecretsStore, "getEffectiveSecrets"> = new SecretsStore(
      config.rootDir
    )
  ) {
    this.config = config;
    this.ptyService = ptyService;
  }

  setTerminalWindowManager(manager: TerminalWindowManager) {
    this.terminalWindowManager = manager;
  }

  /**
   * Check if we're running in desktop mode (Electron) vs server mode (browser).
   */
  isDesktopMode(): boolean {
    return !!this.terminalWindowManager;
  }

  private getProxyUriEnv(): Record<string, string> {
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty/whitespace-only env vars should be treated as unset
    const vscodeProxyUri = process.env.VSCODE_PROXY_URI?.trim() || undefined;
    const xumProxyUri = resolveXumEnvironmentValue("PROXY_URI", process.env)?.trim();
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty/whitespace-only env vars should be treated as unset
    const muxProxyUri = xumProxyUri || vscodeProxyUri;

    const proxyUriEnv: Record<string, string> = {};
    if (vscodeProxyUri != null) {
      proxyUriEnv.VSCODE_PROXY_URI = vscodeProxyUri;
    }
    if (muxProxyUri != null) {
      proxyUriEnv.XUM_PROXY_URI = muxProxyUri;
      proxyUriEnv.MUX_PROXY_URI = muxProxyUri;
    }

    return proxyUriEnv;
  }

  beginShutdown(): void {
    this.shuttingDown = true;
  }

  async create(params: TerminalCreateParams): Promise<TerminalSession> {
    if (this.shuttingDown) throw new Error("Server is shutting down");
    // Reserve the startup synchronously: a creation that has passed its archived check but is
    // still awaiting metadata/secrets/PTY spawn is not yet in sessionActivity, so without this
    // reservation an archive's live-activity gate could pass and the pending creation would
    // then publish a PTY into the archived workspace. The archive-guard check shares this
    // synchronous block: an archive gate armed first refuses this startup here; a reservation
    // counted first is observed by that gate via hasWorkspaceSessions.
    this.pendingSessionCreations.set(
      params.workspaceId,
      (this.pendingSessionCreations.get(params.workspaceId) ?? 0) + 1
    );
    try {
      if (this.workspaceArchiveGuard?.(params.workspaceId) === true) {
        throw new Error(
          `Workspace is being archived: ${params.workspaceId}. Unarchive it before opening a terminal.`
        );
      }
      return await this.createUnreserved(params);
    } finally {
      const remaining = (this.pendingSessionCreations.get(params.workspaceId) ?? 1) - 1;
      if (remaining <= 0) {
        this.pendingSessionCreations.delete(params.workspaceId);
      } else {
        this.pendingSessionCreations.set(params.workspaceId, remaining);
      }
    }
  }

  private async createUnreserved(params: TerminalCreateParams): Promise<TerminalSession> {
    try {
      // 1. Resolve workspace
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const workspaceMetadata = allMetadata.find((w) => w.id === params.workspaceId);

      if (!workspaceMetadata) {
        throw new Error(`Workspace not found: ${params.workspaceId}`);
      }

      // Archived workspaces must not accrue hidden live activity: archive stops terminal
      // sessions, so admitting a new one afterwards would leave a PTY running in a workspace
      // the UI no longer surfaces. Unarchive first.
      if (isWorkspaceArchived(workspaceMetadata.archivedAt, workspaceMetadata.unarchivedAt)) {
        throw new Error(
          `Workspace is archived: ${params.workspaceId}. Unarchive it before opening a terminal.`
        );
      }

      // Validate required fields before proceeding - projectPath is required for project-dir runtimes
      if (!workspaceMetadata.projectPath) {
        log.error("Workspace metadata missing projectPath", {
          workspaceId: params.workspaceId,
          name: workspaceMetadata.name,
          runtimeConfig: workspaceMetadata.runtimeConfig,
          projectName: workspaceMetadata.projectName,
          metadata: JSON.stringify(workspaceMetadata),
        });
        throw new Error(
          `Workspace "${workspaceMetadata.name}" (${params.workspaceId}) is missing projectPath. ` +
            `This may indicate a corrupted config or a workspace that was not properly associated with a project.`
        );
      }

      // 2. Create runtime (pass workspace info for Docker container name derivation)
      const runtime = createRuntimeForWorkspace(workspaceMetadata);

      // 3. Use the persisted workspace root everywhere users can observe it, except for runtimes
      // like Docker whose executable cwd is intentionally translated inside the runtime.
      const workspacePath = resolveWorkspaceExecutionPath(workspaceMetadata, runtime);

      // Keep integrated terminal context aligned with the bash tool for stable workspace metadata.
      // We intentionally skip dynamic values (like cost/model) because long-lived shells would go stale.
      const runtimeType = getRuntimeType(workspaceMetadata.runtimeConfig);
      const shouldInjectLocalEnv = runtimeType === "local" || runtimeType === "worktree";
      const xumEnv = shouldInjectLocalEnv
        ? getXumEnv(workspaceMetadata.projectPath, runtimeType, workspaceMetadata.name, {
            workspaceId: workspaceMetadata.id,
          })
        : undefined;

      // Secrets are local/worktree only. Remote/docker-style transports would expose env via command args
      // unless we add a dedicated secure propagation path.
      const secrets = shouldInjectLocalEnv
        ? await secretsToRecord(
            this.secretsStore.getEffectiveSecrets(workspaceMetadata.projectPath)
          )
        : {};

      // Any process launched from this terminal inherits these variables.
      // Proxy URI propagation allows terminal tools to construct externally reachable links.
      // MUX_PROXY_URI explicitly overrides VSCODE_PROXY_URI, and falls back to it when unset.
      const terminalEnv = xumEnv ? { ...xumEnv, ...this.getProxyUriEnv(), ...secrets } : undefined;

      // 4. Setup emitters and buffer
      // We don't know the sessionId yet (PTYService generates it), but PTYService uses a callback.
      // We need to capture the sessionId.
      // Actually PTYService returns the session object with ID.
      // But the callbacks are passed IN to createSession.
      // So we need a way to map the callback to the future sessionId.

      // Hack: We'll create a temporary object to hold the emitter/buffer and assign it to the map once we have the ID.
      // But the callback runs *after* creation usually (when data comes).
      // However, it's safer to create the emitter *before* passing callbacks if we can.
      // We can't key it by sessionId yet.

      let tempSessionId: string | null = null;
      const localBuffer: string[] = [];

      const onData = (data: string) => {
        if (tempSessionId) {
          this.emitOutput(tempSessionId, data);
        } else {
          // Buffer data if session ID is not yet available (race condition during creation)
          localBuffer.push(data);
        }
      };

      const onExit = (code: number) => {
        if (tempSessionId) {
          const emitter = this.exitEmitters.get(tempSessionId);
          emitter?.emit("exit", code);
          this.cleanup(tempSessionId);
        }
      };

      // 5. Create session
      const projectsConfig = this.config.loadConfigOrDefault();
      // Recheck archived/archiving state after the awaits above: a user-driven archive (which
      // force-closes rather than refuses) may have completed since the entry check, and a PTY
      // spawned now would run hidden in the archived workspace.
      if (
        this.workspaceArchiveGuard?.(params.workspaceId) === true ||
        this.isArchivedNow(params.workspaceId)
      ) {
        throw new Error(
          `Workspace is archived: ${params.workspaceId}. Unarchive it before opening a terminal.`
        );
      }
      const session = await this.ptyService.createSession(
        params,
        runtime,
        workspacePath,
        onData,
        onExit,
        workspaceMetadata.runtimeConfig,
        { env: terminalEnv, defaultShell: projectsConfig.terminalDefaultShell }
      );

      tempSessionId = session.sessionId;

      // Post-spawn recheck: a user-driven archive (which force-closes rather than refuses) may
      // have run closeWorkspaceSessions while createSession was awaiting — that close only
      // terminates tracked sessions, so an unchecked publish here would leave a hidden PTY in
      // the archived workspace. Kill the just-spawned PTY instead of registering it.
      if (
        this.workspaceArchiveGuard?.(params.workspaceId) === true ||
        this.isArchivedNow(params.workspaceId)
      ) {
        try {
          this.ptyService.closeSession(session.sessionId);
        } finally {
          this.cleanup(session.sessionId);
        }
        throw new Error(
          `Workspace was archived while the terminal was starting: ${params.workspaceId}.`
        );
      }

      // Initialize emitters and headless terminal for state tracking
      this.outputEmitters.set(session.sessionId, new EventEmitter());
      this.exitEmitters.set(session.sessionId, new EventEmitter());

      // Create headless terminal to maintain parsed state for reconnection
      // allowProposedApi is required for SerializeAddon to access the buffer
      const headless = new Terminal({
        cols: params.cols,
        rows: params.rows,
        allowProposedApi: true,
      });

      // Respond to terminal device queries (DA1/DSR) on the backend.
      //
      // Some TUIs (e.g. Yazi) issue terminal probes like `\x1b[0c` during startup and expect
      // the terminal emulator to reply quickly. When the renderer isn't mounted yet (or IPC
      // is slow), relying on the frontend alone can lead to timeouts.
      const disposeHeadlessOnData = headless.onData((data: string) => {
        if (!data) {
          return;
        }

        try {
          this.ptyService.sendInput(session.sessionId, data);
        } catch (error) {
          log.debug("[TerminalService] Failed to forward terminal response", {
            sessionId: session.sessionId,
            error,
          });
        }
      });
      const serializeAddon = new SerializeAddon();
      headless.loadAddon(serializeAddon);
      this.headlessOnDataDisposables.set(session.sessionId, disposeHeadlessOnData);
      this.headlessTerminals.set(session.sessionId, headless);
      this.serializeAddons.set(session.sessionId, serializeAddon);

      // Track session activity and subscribe to title changes for sidebar indicator.
      // Subscribe BEFORE replaying buffered output so early title transitions are not missed.
      this.sessionActivity.set(session.sessionId, {
        workspaceId: params.workspaceId,
        isRunning: false,
      });
      // Use parser.registerOscHandler instead of headless.onTitleChange because
      // xterm v6's internal event forwarding chain (InputHandler.setTitle → onTitleChange)
      // doesn't fire despite the parser correctly processing OSC 0/2 sequences.
      const handleTitleOsc = (data: string): boolean => {
        this.markSessionOscDriven(session.sessionId);
        const isRunning = !this.isIdleTitle(data);
        this.updateSessionActivity(session.sessionId, params.workspaceId, isRunning);
        return false; // don't consume — let xterm's internal handler also process
      };
      const disposeOsc0 = headless.parser.registerOscHandler(0, handleTitleOsc);
      const disposeOsc2 = headless.parser.registerOscHandler(2, handleTitleOsc);
      // OSC 133 (FinalTerm semantic prompt protocol) — fish, zsh with plugins, etc.
      // Marker A = prompt start (idle), C = command start (running).
      const handlePromptOsc = (data: string): boolean => {
        this.markSessionOscDriven(session.sessionId);
        const marker = data.split(";", 1)[0]?.trim();
        if (marker === "A") {
          this.updateSessionActivity(session.sessionId, params.workspaceId, false);
        } else if (marker === "C") {
          this.updateSessionActivity(session.sessionId, params.workspaceId, true);
        }
        return false;
      };
      const disposeOsc133 = headless.parser.registerOscHandler(133, handlePromptOsc);
      const disposeOnTitleChange = {
        dispose: () => {
          disposeOsc0.dispose();
          disposeOsc2.dispose();
          disposeOsc133.dispose();
        },
      };
      this.titleChangeDisposables.set(session.sessionId, disposeOnTitleChange);
      this.activityChangeEmitter.emit("change", params.workspaceId);

      // Replay local buffer that arrived during creation
      for (const data of localBuffer) {
        this.emitOutput(session.sessionId, data);
      }

      // Send initial command if provided
      if (params.initialCommand) {
        this.sendInput(session.sessionId, `${params.initialCommand}\n`);
      }

      return session;
    } catch (err) {
      log.error("Error creating terminal session:", err);
      throw err;
    }
  }

  close(sessionId: string): void {
    try {
      this.terminateTrackedSessions([sessionId]);
    } catch (err) {
      log.error("Error closing terminal session:", err);
      throw err;
    }
  }

  resize(params: TerminalResizeParams): void {
    try {
      this.ptyService.resize(params);

      // Also resize the headless terminal to keep state in sync
      const headless = this.headlessTerminals.get(params.sessionId);
      headless?.resize(params.cols, params.rows);
    } catch (err) {
      log.error("Error resizing terminal:", err);
      throw err;
    }
  }

  sendInput(sessionId: string, data: string): void {
    try {
      this.ptyService.sendInput(sessionId, data);

      // Mark session as running when user submits a command (newline detected).
      // OSC handlers will flip it back when the prompt returns.
      if (data.includes("\r") || data.includes("\n")) {
        const activity = this.sessionActivity.get(sessionId);
        if (activity) {
          this.updateSessionActivity(sessionId, activity.workspaceId, true);
          // Guard against permanent running state in non-OSC shells.
          if (!this.sessionsWithOscActivity.has(sessionId)) {
            this.armNoOscIdleFallback(sessionId, activity.workspaceId);
          }
        }
      }
    } catch (err) {
      log.error(`Error sending input to terminal ${sessionId}:`, err);
      throw err;
    }
  }

  async openWindow(workspaceId: string, sessionId?: string, initialTitle?: string): Promise<void> {
    try {
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const workspace = allMetadata.find((w) => w.id === workspaceId);

      if (!workspace) {
        throw new Error(`Workspace not found: ${workspaceId}`);
      }

      const runtimeConfig = workspace.runtimeConfig;
      const isSSH = isSSHRuntime(runtimeConfig);
      const isDesktop = !!this.terminalWindowManager;

      if (isDesktop) {
        log.info(
          `Opening terminal window for workspace: ${workspaceId}${sessionId ? ` (session: ${sessionId})` : ""}`
        );
        await this.terminalWindowManager!.openTerminalWindow(workspaceId, sessionId, initialTitle);
      } else {
        log.info(
          `Browser mode: terminal UI handled by browser for ${isSSH ? "SSH" : "local"} workspace: ${workspaceId}`
        );
      }
    } catch (err) {
      log.error("Error opening terminal window:", err);
      throw err;
    }
  }

  closeWindow(workspaceId: string): void {
    try {
      if (!this.terminalWindowManager) {
        // Not an error in server mode, just no-op
        return;
      }
      this.terminalWindowManager.closeTerminalWindow(workspaceId);
    } catch (err) {
      log.error("Error closing terminal window:", err);
      throw err;
    }
  }

  /**
   * Open the native system terminal for a workspace.
   * Opens the user's preferred terminal emulator (Ghostty, Terminal.app, etc.)
   * with the working directory set to the workspace path.
   *
   * For SSH workspaces, opens a terminal that SSHs into the remote host.
   */
  async openNative(workspaceId: string): Promise<void> {
    // Pending-open admission pairing (same synchronous block as the archive guard check
    // below, mirroring create()): the count is registered before any await so archive gates
    // observe the intent immediately, and it keeps hasOpenedNativeTerminal true for the
    // whole in-flight window — including the pre-marker awaits, where a concurrent failed
    // open's rollback may collapse the shared marker and cache entry. Failed opens launch
    // no shell (see the catch below), so the count simply releases in the finally; durable
    // recording happens at marker-write time.
    this.pendingNativeTerminalOpens.set(
      workspaceId,
      (this.pendingNativeTerminalOpens.get(workspaceId) ?? 0) + 1
    );
    try {
      // Archive admission pairing: an archive gate armed first refuses this open, while an
      // open counted first is observed by the sink's native-terminal check before snapshot
      // capture. Without this, an open entering after that check could launch a native shell
      // in a checkout the same archive is about to remove.
      if (this.workspaceArchiveGuard?.(workspaceId) === true) {
        throw new Error(
          `Workspace is being archived: ${workspaceId}. Unarchive it before opening a terminal.`
        );
      }
      await this.openNativeAdmitted(workspaceId);
    } finally {
      const remaining = (this.pendingNativeTerminalOpens.get(workspaceId) ?? 1) - 1;
      if (remaining <= 0) {
        this.pendingNativeTerminalOpens.delete(workspaceId);
      } else {
        this.pendingNativeTerminalOpens.set(workspaceId, remaining);
      }
    }
  }

  /** Body of openNative after pending-open admission; see openNative. */
  private async openNativeAdmitted(workspaceId: string): Promise<void> {
    let admissionToken: symbol | null = null;
    try {
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const workspace = allMetadata.find((w) => w.id === workspaceId);

      if (!workspace) {
        throw new Error(`Workspace not found: ${workspaceId}`);
      }

      // Persisted archived state (not just an in-progress archive): a stale renderer can
      // request a terminal for an already-archived workspace whose checkout may already be
      // snapshot and removed. Mirrors create()'s admission — unarchive first. Checked before
      // the durable marker write so a refused open cannot permanently gate future snapshot
      // archives of this workspace.
      if (isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)) {
        throw new Error(
          `Workspace is archived: ${workspaceId}. Unarchive it before opening a terminal.`
        );
      }

      // Durable marker: the detached emulator can outlive Xum, so a restart must not forget
      // the open (the in-memory Set resets, and both archive checks would otherwise let a
      // model-driven snapshot archive remove the checkout under the still-live shell).
      // Persistence failure is fatal to the launch: a terminal opened without the marker
      // would be invisible to archive gating after a restart, so failing the open here is the
      // only fail-closed option (the in-memory Set covers just this app session).
      try {
        admissionToken = await this.nativeTerminalMarkerLocks.withLock(workspaceId, async () => {
          // Batch-scoped ancestry (see nativeTerminalMarkerBatches): the pre-existence probe
          // runs once per batch, before the batch's first write, so a marker written by an
          // earlier in-flight open of this same batch cannot masquerade as evidence of a
          // real prior launch. "unknown" probes count as pre-existing (fail closed).
          let batch = this.nativeTerminalMarkerBatches.get(workspaceId);
          const createdBatch = batch == null;
          if (batch == null) {
            const preexisting = await this.probeNativeTerminalMarkerOnDisk(workspaceId);
            batch = { markerPreexisted: preexisting !== "absent", tokens: new Set() };
            this.nativeTerminalMarkerBatches.set(workspaceId, batch);
          }
          const markerPath = this.nativeTerminalMarkerPath(workspaceId);
          try {
            await fs.promises.mkdir(path.dirname(markerPath), { recursive: true });
            await fs.promises.writeFile(markerPath, new Date().toISOString());
          } catch (error) {
            // A newly created, still-empty batch must not outlive a failed persistence
            // attempt: its probe (possibly a fail-closed "unknown" during the same
            // filesystem hiccup) would become stale ancestry for a later retry, permanently
            // preserving a marker that retry writes even when its launch fails. Discarding
            // it makes the next attempt re-probe the recovered disk. A joined batch keeps
            // its live tokens.
            if (createdBatch && batch.tokens.size === 0) {
              this.nativeTerminalMarkerBatches.delete(workspaceId);
              // The failed write may still have created (or truncated) the marker file —
              // ENOSPC and I/O errors can reject after the open. When this batch's probe
              // proved absence, that artifact is ours and no launch backs it: left behind,
              // it reads as durable launch evidence across restarts and classifies as
              // pre-existing on retry. An "unknown" probe stays fail closed (never unlink
              // what might predate us); unlink failure only over-refuses archives.
              if (!batch.markerPreexisted) {
                try {
                  await fs.promises.unlink(markerPath);
                } catch {
                  // Best-effort (fail closed).
                }
              }
            }
            throw error;
          }
          // The sticky in-memory record is a cache of the just-written marker; before this
          // point the pending-open count already keeps archive gates closed.
          this.nativeTerminalWorkspaces.add(workspaceId);
          // Launch evidence is registered under the same lock as the write so a concurrent
          // failed launch's rollback can never observe the marker without the token.
          const token = Symbol("native-terminal-launch");
          batch.tokens.add(token);
          return token;
        });
      } catch (error) {
        log.error("Failed to persist native terminal marker", { workspaceId, error });
        throw new Error(
          `Cannot open a native terminal for ${workspaceId}: persisting the terminal-open marker failed (${getErrorMessage(error)}), and without it archive safety checks would forget the terminal after a restart.`
        );
      }

      const runtimeConfig = workspace.runtimeConfig;

      if (isSSHRuntime(runtimeConfig)) {
        // SSH workspace - spawn local terminal that SSHs into remote host
        await this.openNativeTerminal({
          type: "ssh",
          sshConfig: runtimeConfig,
          remotePath: workspace.namedWorkspacePath,
        });
      } else if (isDockerRuntime(runtimeConfig)) {
        // Docker workspace - spawn terminal that docker execs into container
        const containerName = runtimeConfig.containerName;
        if (!containerName) {
          throw new Error("Docker container not initialized");
        }
        const containerCli = quoteForNativeTerminalCommandArg(await resolveContainerCli());
        await this.openNativeTerminal({
          type: "local",
          workspacePath: process.cwd(), // cwd doesn't matter, we're running docker exec
          command: `${containerCli} exec -it ${containerName} /bin/sh -c "cd ${workspace.namedWorkspacePath} && exec /bin/sh"`,
        });
      } else if (isDevcontainerRuntime(runtimeConfig)) {
        // These arguments are executed via `sh -c` in terminal launchers, so they
        // must be escaped for the current host shell to prevent path-based injection.
        const quotedPath = quoteForNativeTerminalCommandArg(workspace.namedWorkspacePath);
        const configArg = runtimeConfig.configPath
          ? ` --config ${quoteForNativeTerminalCommandArg(runtimeConfig.configPath)}`
          : "";
        await this.openNativeTerminal({
          type: "local",
          workspacePath: workspace.namedWorkspacePath,
          command: `devcontainer exec --workspace-folder ${quotedPath}${configArg} -- /bin/sh`,
        });
      } else {
        // Local workspace - spawn terminal with cwd set
        await this.openNativeTerminal({
          type: "local",
          workspacePath: workspace.namedWorkspacePath,
        });
      }
    } catch (err) {
      // No failure path in openNative launches a shell: pre-marker failures (unknown/archived
      // workspace, marker persistence) never reach a launcher and recorded nothing durable
      // (the pending-open count covers that window and releases in openNative's finally). A
      // marker this call created is a false positive that would permanently refuse future
      // model-driven snapshot/Coder-stop archives, so it rolls back unless other launch
      // evidence remains; launcher errors propagate only from before their detached spawn
      // (nothing after spawn()/unref() throws).
      if (admissionToken != null) {
        await this.rollbackNativeTerminalMarkerAfterFailedLaunch(workspaceId, admissionToken);
      }
      const message = getErrorMessage(err);
      log.error(`Failed to open native terminal: ${message}`);
      throw err;
    }
  }

  /**
   * Undo a failed openNative's durable marker. The marker is deleted only when its whole
   * ancestry batch failed (no launch-evidence token remains, so no shell launched or can
   * still launch under it) and it did not predate the batch (an earlier session's shell may
   * still be running behind it). Serialized with marker writes so the unlink can never race
   * a concurrent open's write; deletion failure keeps the sticky marker (fail closed).
   */
  private async rollbackNativeTerminalMarkerAfterFailedLaunch(
    workspaceId: string,
    token: symbol
  ): Promise<void> {
    await this.nativeTerminalMarkerLocks.withLock(workspaceId, async () => {
      const batch = this.nativeTerminalMarkerBatches.get(workspaceId);
      if (batch == null) {
        // Unknown batch (cannot happen: batches are only closed here): keep everything.
        return;
      }
      batch.tokens.delete(token);
      if (batch.tokens.size > 0) {
        return;
      }
      // Every open in the batch failed: close it so the next open starts a fresh probe.
      this.nativeTerminalMarkerBatches.delete(workspaceId);
      if (batch.markerPreexisted) {
        return;
      }
      try {
        await fs.promises.unlink(this.nativeTerminalMarkerPath(workspaceId));
      } catch (error) {
        if (!isErrnoWithCode(error, "ENOENT")) {
          // The marker may still exist, so the in-memory cache entry must stay to match it.
          log.error("Failed to roll back native terminal marker after a failed launch", {
            workspaceId,
            error,
          });
          return;
        }
      }
      this.nativeTerminalWorkspaces.delete(workspaceId);
    });
  }

  /**
   * Open a native terminal and run a command.
   * Used for opening $EDITOR in a terminal when editing files.
   * @param command The command to run
   * @param workspacePath Optional directory to run the command in (defaults to cwd)
   */
  async openNativeWithCommand(command: string, workspacePath?: string): Promise<void> {
    await this.openNativeTerminal({
      type: "local",
      workspacePath: workspacePath ?? process.cwd(),
      command,
    });
  }

  /**
   * Open a native terminal (local or SSH) with platform-specific handling.
   * This spawns the user's native terminal emulator, not a web-based terminal.
   */
  private async openNativeTerminal(config: NativeTerminalConfig): Promise<void> {
    const isSSH = config.type === "ssh";

    // Build SSH args if needed
    let sshArgs: string[] | null = null;
    if (isSSH) {
      sshArgs = [];
      // Add port if specified
      if (config.sshConfig.port) {
        sshArgs.push("-p", String(config.sshConfig.port));
      }
      // Add identity file if specified
      if (config.sshConfig.identityFile) {
        sshArgs.push("-i", config.sshConfig.identityFile);
      }
      // Force pseudo-terminal allocation
      sshArgs.push("-t");
      // Add host
      sshArgs.push(config.sshConfig.host);
      // Add remote command to cd into directory and start shell
      // Use single quotes to prevent local shell expansion
      // exec $SHELL replaces the SSH process with the shell, avoiding nested processes
      sshArgs.push(`cd '${config.remotePath.replace(/'/g, "'\\''")}' && exec $SHELL`);
    }

    const logPrefix = isSSH ? "SSH terminal" : "terminal";

    if (process.platform === "darwin") {
      await this.openNativeTerminalMacOS(config, sshArgs, logPrefix);
    } else if (process.platform === "win32") {
      this.openNativeTerminalWindows(config, sshArgs, logPrefix);
    } else {
      await this.openNativeTerminalLinux(config, sshArgs, logPrefix);
    }
  }

  private async openNativeTerminalMacOS(
    config: NativeTerminalConfig,
    sshArgs: string[] | null,
    logPrefix: string
  ): Promise<void> {
    const isSSH = config.type === "ssh";
    const command = config.command;
    const workspacePath = config.type === "local" ? config.workspacePath : config.remotePath;

    // macOS - try Ghostty first, fallback to Terminal.app
    const terminal = await findAvailableCommand(["ghostty", "terminal"]);
    if (terminal === "ghostty") {
      const cmd = "open";
      let args: string[];
      if (isSSH && sshArgs) {
        // Ghostty: Use --command flag to run SSH
        // Build the full SSH command as a single string
        const sshCommand = ["ssh", ...sshArgs].join(" ");
        args = ["-n", "-a", "Ghostty", "--args", `--command=${sshCommand}`];
      } else if (command) {
        // Ghostty: Run command in workspace directory
        // Wrap in sh -c to handle cd and command properly
        const escapedPath = workspacePath.replace(/'/g, "'\\''");
        const escapedCmd = command.replace(/'/g, "'\\''");
        const fullCommand = `sh -c 'cd "${escapedPath}" && ${escapedCmd}'`;
        args = ["-n", "-a", "Ghostty", "--args", `--command=${fullCommand}`];
      } else {
        // Ghostty: Pass workspacePath to 'open -a Ghostty' to avoid regressions
        args = ["-a", "Ghostty", workspacePath];
      }
      log.info(`Opening ${logPrefix}: ${cmd} ${args.join(" ")}`);
      const child = spawn(cmd, args, {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } else {
      // Terminal.app
      const cmd = isSSH || command ? "osascript" : "open";
      let args: string[];
      if (isSSH && sshArgs) {
        // Terminal.app: Use osascript with proper AppleScript structure
        // Properly escape single quotes in args before wrapping in quotes
        const sshCommand = `ssh ${sshArgs
          .map((arg) => {
            if (arg.includes(" ") || arg.includes("'")) {
              // Escape single quotes by ending quote, adding escaped quote, starting quote again
              return `'${arg.replace(/'/g, "'\\''")}'`;
            }
            return arg;
          })
          .join(" ")}`;
        // Escape double quotes for AppleScript string
        const escapedCommand = sshCommand.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const script = `tell application "Terminal"\nactivate\ndo script "${escapedCommand}"\nend tell`;
        args = ["-e", script];
      } else if (command) {
        // Terminal.app: Run command in workspace directory via AppleScript
        const fullCommand = `cd "${workspacePath}" && ${command}`;
        const escapedCommand = fullCommand.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const script = `tell application "Terminal"\nactivate\ndo script "${escapedCommand}"\nend tell`;
        args = ["-e", script];
      } else {
        // Terminal.app opens in the directory when passed as argument
        args = ["-a", "Terminal", workspacePath];
      }
      log.info(`Opening ${logPrefix}: ${cmd} ${args.join(" ")}`);
      const child = spawn(cmd, args, {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    }
  }

  private openNativeTerminalWindows(
    config: NativeTerminalConfig,
    sshArgs: string[] | null,
    logPrefix: string
  ): void {
    const isSSH = config.type === "ssh";
    const command = config.command;
    const workspacePath = config.type === "local" ? config.workspacePath : config.remotePath;

    // Windows
    const cmd = "cmd";
    let args: string[];
    if (isSSH && sshArgs) {
      // Windows - use cmd to start ssh
      args = ["/c", "start", "cmd", "/K", "ssh", ...sshArgs];
    } else if (command) {
      // Windows - cd to directory and run command
      args = ["/c", "start", "cmd", "/K", `cd /D "${workspacePath}" && ${command}`];
    } else {
      // Windows - just cd to directory
      args = ["/c", "start", "cmd", "/K", "cd", "/D", workspacePath];
    }
    log.info(`Opening ${logPrefix}: ${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, {
      detached: true,
      shell: true,
      stdio: "ignore",
    });
    child.unref();
  }

  private async openNativeTerminalLinux(
    config: NativeTerminalConfig,
    sshArgs: string[] | null,
    logPrefix: string
  ): Promise<void> {
    const isSSH = config.type === "ssh";
    const command = config.command;
    const workspacePath = config.type === "local" ? config.workspacePath : config.remotePath;

    // Linux - try terminal emulators in order of preference
    let terminals: Array<{ cmd: string; args: string[]; cwd?: string }>;

    if (isSSH && sshArgs) {
      // x-terminal-emulator is checked first as it respects user's system-wide preference
      terminals = [
        { cmd: "x-terminal-emulator", args: ["-e", "ssh", ...sshArgs] },
        { cmd: "ghostty", args: ["ssh", ...sshArgs] },
        { cmd: "alacritty", args: ["-e", "ssh", ...sshArgs] },
        { cmd: "kitty", args: ["ssh", ...sshArgs] },
        { cmd: "wezterm", args: ["start", "--", "ssh", ...sshArgs] },
        { cmd: "gnome-terminal", args: ["--", "ssh", ...sshArgs] },
        { cmd: "konsole", args: ["-e", "ssh", ...sshArgs] },
        { cmd: "xfce4-terminal", args: ["-e", `ssh ${sshArgs.join(" ")}`] },
        { cmd: "xterm", args: ["-e", "ssh", ...sshArgs] },
      ];
    } else if (command) {
      // Run command in workspace directory
      const fullCommand = `cd "${workspacePath}" && ${command}`;
      terminals = [
        { cmd: "x-terminal-emulator", args: ["-e", "sh", "-c", fullCommand] },
        { cmd: "ghostty", args: ["-e", "sh", "-c", fullCommand] },
        { cmd: "alacritty", args: ["-e", "sh", "-c", fullCommand] },
        { cmd: "kitty", args: ["sh", "-c", fullCommand] },
        { cmd: "wezterm", args: ["start", "--", "sh", "-c", fullCommand] },
        { cmd: "gnome-terminal", args: ["--", "sh", "-c", fullCommand] },
        { cmd: "konsole", args: ["-e", "sh", "-c", fullCommand] },
        { cmd: "xfce4-terminal", args: ["-e", `sh -c '${fullCommand.replace(/'/g, "'\\''")}'`] },
        { cmd: "xterm", args: ["-e", "sh", "-c", fullCommand] },
      ];
    } else {
      // Just open terminal in directory
      terminals = [
        { cmd: "x-terminal-emulator", args: [], cwd: workspacePath },
        { cmd: "ghostty", args: ["--working-directory=" + workspacePath] },
        { cmd: "alacritty", args: ["--working-directory", workspacePath] },
        { cmd: "kitty", args: ["--directory", workspacePath] },
        { cmd: "wezterm", args: ["start", "--cwd", workspacePath] },
        { cmd: "gnome-terminal", args: ["--working-directory", workspacePath] },
        { cmd: "konsole", args: ["--workdir", workspacePath] },
        { cmd: "xfce4-terminal", args: ["--working-directory", workspacePath] },
        { cmd: "xterm", args: [], cwd: workspacePath },
      ];
    }

    const availableTerminal = await this.findAvailableTerminal(terminals);

    if (availableTerminal) {
      const cwdInfo = availableTerminal.cwd ? ` (cwd: ${availableTerminal.cwd})` : "";
      log.info(
        `Opening ${logPrefix}: ${availableTerminal.cmd} ${availableTerminal.args.join(" ")}${cwdInfo}`
      );
      const child = spawn(availableTerminal.cmd, availableTerminal.args, {
        cwd: availableTerminal.cwd,
        detached: true,
        stdio: "ignore",
        // Strip xum-internal vars (e.g. CHROME_DESKTOP, our Linux desktop
        // identity) so apps launched from this shell don't inherit them.
        // sanitizeXumChildEnv copies its input, so pass process.env directly.
        env: sanitizeXumChildEnv(process.env),
      });
      child.unref();
    } else {
      log.error("No terminal emulator found. Tried: " + terminals.map((t) => t.cmd).join(", "));
      throw new Error("No terminal emulator found");
    }
  }

  /**
   * Find the first available terminal emulator from a list
   */
  private async findAvailableTerminal(
    terminals: Array<{ cmd: string; args: string[]; cwd?: string }>
  ): Promise<{ cmd: string; args: string[]; cwd?: string } | null> {
    for (const terminal of terminals) {
      if (await isCommandAvailable(terminal.cmd)) {
        return terminal;
      }
    }
    return null;
  }

  onOutput(sessionId: string, callback: (data: string) => void): () => void {
    const emitter = this.outputEmitters.get(sessionId);
    if (!emitter) {
      // Session might not exist yet or closed.
      // If it doesn't exist, we can't subscribe.
      return () => {
        /* no-op */
      };
    }

    // Note: The attach stream yields screenState first, then live output.
    // This subscription only provides live output from the point of subscription onward.
    //
    // Wrap the user callback in a per-listener try/catch so a single bad subscriber
    // (e.g., a stale orpc stream still wired to a closed terminal window) cannot abort
    // EventEmitter's synchronous dispatch loop and starve healthy subscribers of output.
    // Without this, a crashy listener would also crash the Electron main process via
    // process.uncaughtException (see emitOutput's defense-in-depth notes).
    const handler = (data: string) => {
      try {
        callback(data);
      } catch (err) {
        log.warn(`[TerminalService] output listener threw for session ${sessionId}:`, err);
      }
    };
    emitter.on("data", handler);

    return () => {
      emitter.off("data", handler);
    };
  }

  onExit(sessionId: string, callback: (code: number) => void): () => void {
    const emitter = this.exitEmitters.get(sessionId);
    if (!emitter)
      return () => {
        /* no-op */
      };

    const handler = (code: number) => callback(code);
    emitter.on("exit", handler);

    return () => {
      emitter.off("exit", handler);
    };
  }

  /**
   * Heuristic: classify whether a terminal title indicates an idle shell prompt.
   * Shells typically set title to shell name, cwd, or user@host:path when idle.
   */
  private isIdleTitle(title: string): boolean {
    const trimmed = title.trim();
    if (trimmed.length === 0) return true;

    if (trimmed.startsWith("/") || trimmed.startsWith("~")) return true;
    if (/^[^\s@]+@[^\s:]+:/.test(trimmed)) return true;
    if (/^(bash|zsh|fish|sh|pwsh|powershell)$/i.test(trimmed)) return true;

    return false;
  }

  private markSessionOscDriven(sessionId: string): void {
    this.sessionsWithOscActivity.add(sessionId);
    const fallback = this.noOscIdleFallbacks.get(sessionId);
    if (fallback != null) {
      clearTimeout(fallback);
      this.noOscIdleFallbacks.delete(sessionId);
    }
  }

  private armNoOscIdleFallback(sessionId: string, workspaceId: string): void {
    const existing = this.noOscIdleFallbacks.get(sessionId);
    if (existing != null) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.noOscIdleFallbacks.delete(sessionId);
      // Only reset if session still exists and hasn't gained OSC capability.
      if (this.sessionActivity.has(sessionId) && !this.sessionsWithOscActivity.has(sessionId)) {
        this.updateSessionActivity(sessionId, workspaceId, false);
      }
    }, NO_OSC_IDLE_FALLBACK_MS);

    this.noOscIdleFallbacks.set(sessionId, timer);
  }

  private computeWorkspaceAggregate(workspaceId: string): {
    activeCount: number;
    totalSessions: number;
  } {
    let activeCount = 0;
    let totalSessions = 0;

    for (const entry of this.sessionActivity.values()) {
      if (entry.workspaceId === workspaceId) {
        totalSessions++;
        if (entry.isRunning) {
          activeCount++;
        }
      }
    }

    return { activeCount, totalSessions };
  }

  private updateSessionActivity(sessionId: string, workspaceId: string, isRunning: boolean): void {
    const previousActivity = this.sessionActivity.get(sessionId);
    const previousRunningState = previousActivity?.isRunning ?? false;

    this.sessionActivity.set(sessionId, { workspaceId, isRunning });

    if (!previousActivity || previousRunningState !== isRunning) {
      this.activityChangeEmitter.emit("change", workspaceId);
    }
  }

  private removeSessionActivity(sessionId: string): void {
    const activityEntry = this.sessionActivity.get(sessionId);
    if (!activityEntry) {
      return;
    }

    this.sessionActivity.delete(sessionId);
    this.activityChangeEmitter.emit("change", activityEntry.workspaceId);
  }

  /** Get terminal activity aggregate for a workspace. */
  getWorkspaceActivity(workspaceId: string): { activeCount: number; totalSessions: number } {
    return this.computeWorkspaceAggregate(workspaceId);
  }

  /** Get all workspace activity aggregates (for initial snapshot). */
  getAllWorkspaceActivity(): Record<string, { activeCount: number; totalSessions: number }> {
    const workspaceActivity: Record<string, { activeCount: number; totalSessions: number }> = {};
    const workspaceIds = new Set<string>();

    for (const entry of this.sessionActivity.values()) {
      workspaceIds.add(entry.workspaceId);
    }

    for (const workspaceId of workspaceIds) {
      workspaceActivity[workspaceId] = this.computeWorkspaceAggregate(workspaceId);
    }

    return workspaceActivity;
  }

  /** Subscribe to workspace-level activity changes. Callback receives workspaceId. */
  onActivityChange(callback: (workspaceId: string) => void): () => void {
    this.activityChangeEmitter.on("change", callback);

    return () => {
      this.activityChangeEmitter.off("change", callback);
    };
  }

  /**
   * Get serialized screen state for a session.
   * Called by frontend on reconnect to restore terminal view instantly (~4KB vs 512KB raw replay).
   * Returns VT escape sequences that reconstruct the current screen state.
   *
   * Note: @xterm/addon-serialize v0.14+ automatically includes the alternate buffer switch
   * sequence (\x1b[?1049h) when the terminal is in alternate screen mode (htop, vim, etc.).
   */
  getScreenState(sessionId: string): string {
    const addon = this.serializeAddons.get(sessionId);
    return addon?.serialize() ?? "";
  }

  private emitOutput(sessionId: string, data: string) {
    // Write to headless terminal to maintain parsed state (and generate device-query responses).
    // SAFETY: xterm-headless (like the renderer's xterm WASM build) can throw intermittently on
    // malformed escape sequences. This handler is invoked from a node-pty `onData` callback that
    // runs on the libuv tick, so an uncaught throw here propagates to `process.uncaughtException`
    // in the Electron main process, which turns it into a blocking "Application Error" dialog
    // (see desktop/main.ts). Mirror the renderer-side defense in TerminalView.tsx.
    const headless = this.headlessTerminals.get(sessionId);
    if (headless) {
      try {
        headless.write(data);
      } catch (err) {
        log.warn(`[TerminalService] headless.write threw for session ${sessionId}:`, err);
      }
    }

    // Listener isolation lives inside onOutput's per-callback wrapper so a throwing subscriber
    // does not abort EventEmitter's synchronous dispatch and starve later listeners of output.
    // The try/catch here is defense-in-depth for any future emit-time error path (e.g.,
    // EventEmitter internals): it must never let an exception escape the libuv tick.
    const emitter = this.outputEmitters.get(sessionId);
    if (emitter) {
      try {
        emitter.emit("data", data);
      } catch (err) {
        log.warn(`[TerminalService] output emitter threw for session ${sessionId}:`, err);
      }
    }
  }

  /**
   * Get all session IDs for a workspace.
   * Used by frontend to discover existing sessions to reattach to after reload.
   */
  getWorkspaceSessionIds(workspaceId: string): string[] {
    return this.ptyService.getWorkspaceSessionIds(workspaceId);
  }

  private getTrackedSessionIdsForWorkspace(workspaceId: string): string[] {
    return Array.from(this.sessionActivity.entries())
      .filter(([, entry]) => entry.workspaceId === workspaceId)
      .map(([sessionId]) => sessionId);
  }

  private terminateTrackedSessions(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      try {
        this.ptyService.closeSession(sessionId);
      } finally {
        this.cleanup(sessionId);
      }
    }
  }

  getOpenSessionCount(): number {
    return (
      this.sessionActivity.size +
      Array.from(this.pendingSessionCreations.values()).reduce((sum, count) => sum + count, 0)
    );
  }

  /**
   * Whether any live terminal PTY sessions are tracked for a workspace. Model-facing
   * lifecycle paths consult this to refuse archiving instead of silently killing PTYs.
   */
  hasWorkspaceSessions(workspaceId: string): boolean {
    return (
      this.getTrackedSessionIdsForWorkspace(workspaceId).length > 0 ||
      // Startups reserved in create() but not yet tracked in sessionActivity count as live:
      // archive refusal gates must see them before their PTY publishes.
      (this.pendingSessionCreations.get(workspaceId) ?? 0) > 0
    );
  }

  /**
   * Close all terminal sessions for a workspace.
   * Called when a workspace is archived or removed to prevent resource leaks.
   */
  closeWorkspaceSessions(workspaceId: string): void {
    const sessionIds = this.getTrackedSessionIdsForWorkspace(workspaceId);
    this.terminateTrackedSessions(sessionIds);
  }

  /**
   * Close all terminal sessions.
   * Called during server shutdown to prevent orphan PTY processes.
   */
  closeAllSessions(): void {
    const sessionIds = Array.from(this.sessionActivity.keys());
    this.terminateTrackedSessions(sessionIds);
  }

  private cleanup(sessionId: string) {
    const disposeHeadlessOnData = this.headlessOnDataDisposables.get(sessionId);
    disposeHeadlessOnData?.dispose();
    this.headlessOnDataDisposables.delete(sessionId);

    // Clean up activity tracking
    const disposeTitleChange = this.titleChangeDisposables.get(sessionId);
    disposeTitleChange?.dispose();
    this.titleChangeDisposables.delete(sessionId);
    this.removeSessionActivity(sessionId);
    this.sessionsWithOscActivity.delete(sessionId);
    const fallback = this.noOscIdleFallbacks.get(sessionId);
    if (fallback != null) {
      clearTimeout(fallback);
      this.noOscIdleFallbacks.delete(sessionId);
    }

    this.outputEmitters.delete(sessionId);
    this.exitEmitters.delete(sessionId);

    // Dispose and clean up headless terminal
    const headless = this.headlessTerminals.get(sessionId);
    headless?.dispose();
    this.headlessTerminals.delete(sessionId);
    this.serializeAddons.delete(sessionId);
  }
}
