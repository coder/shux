import { acquireProcessFileLock, type ProcessFileLock } from "@/node/utils/concurrency/fileLock";
import assert from "@/common/utils/assert";
import {
  EXPERIMENT_IDS,
  EXPERIMENTS_WRITE_TIMEOUT_MS,
  EXPERIMENTS,
  isExperimentSupportedOnPlatform,
  LEGACY_PTC_EXCLUSIVE_EXPERIMENT_ID,
  type ExperimentId,
} from "@/common/constants/experiments";
import { getXumHome } from "@/common/constants/paths";
import type { TelemetryService } from "@/node/services/telemetryService";

import * as fs from "fs/promises";
import writeFileAtomic from "write-file-atomic";
import * as path from "path";

interface ExperimentsFile {
  version: 1;
  /**
   * Always written as an empty object. Builds before remote evaluation was removed
   * abort reading this file when `experiments` is absent, which would silently drop
   * the user's overrides on downgrade.
   */
  experiments: Record<string, never>;
  overrides?: Record<string, boolean>;
}

export const EXPERIMENT_OVERRIDES_FILE_NAME = "feature_flags.json";
const OVERRIDES_FILE_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Parse the persisted overrides file contents (shared by the service and CLI reads). */
async function readOverridesFile(filePath: string): Promise<{
  overrides: Map<ExperimentId, boolean>;
  /** True when the persisted file already carries the enabled legacy
   * exclusive mirror (see LEGACY_PTC_EXCLUSIVE_EXPERIMENT_ID). */
  hasLegacyPtcMirror: boolean;
}> {
  const overrides = new Map<ExperimentId, boolean>();
  let hasLegacyPtcMirror = false;
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    if (!isRecord(parsed) || parsed.version !== OVERRIDES_FILE_VERSION) {
      return { overrides, hasLegacyPtcMirror };
    }

    const persisted = parsed.overrides;
    if (!isRecord(persisted)) {
      return { overrides, hasLegacyPtcMirror };
    }

    for (const [key, value] of Object.entries(persisted)) {
      if (!(key in EXPERIMENTS) || typeof value !== "boolean") {
        continue;
      }

      overrides.set(key as ExperimentId, value);
    }

    // Legacy alias (see LEGACY_PTC_EXCLUSIVE_EXPERIMENT_ID): an enabled exclusive toggle
    // must keep PTC on after upgrade — filtering it like an ordinary unknown
    // key would silently turn the user's PTC posture off. `true` wins over an
    // explicit ptc:false because the old build's exclusive flag activated the
    // exclusive posture regardless of the supplement flag.
    if (persisted[LEGACY_PTC_EXCLUSIVE_EXPERIMENT_ID] === true) {
      overrides.set(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING, true);
      hasLegacyPtcMirror = true;
    }
  } catch {
    // Ignore missing/corrupt overrides
  }
  return { overrides, hasLegacyPtcMirror };
}

/**
 * One-shot read of a persisted experiment override for standalone CLIs
 * (debug/workflow) that run without an ExperimentsService instance. Applies
 * the same file format and platform-support semantics as the service.
 */
export async function readPersistedExperimentEnabled(
  experimentId: ExperimentId,
  options?: { xumHome?: string; platform?: NodeJS.Platform }
): Promise<boolean> {
  assert(experimentId in EXPERIMENTS, `Unknown experimentId: ${experimentId}`);

  if (!isExperimentSupportedOnPlatform(experimentId, options?.platform ?? process.platform)) {
    return false;
  }

  const xumHome = options?.xumHome ?? getXumHome();
  const { overrides } = await readOverridesFile(path.join(xumHome, EXPERIMENT_OVERRIDES_FILE_NAME));
  return overrides.get(experimentId) === true;
}

/**
 * Backend experiments service.
 *
 * Experiments are opt-in local toggles: an experiment is enabled only when the user
 * explicitly turns it on in Settings. Overrides are persisted so main-process gates
 * (oRPC routes, AI runtime, tool registration) agree with the renderer on every launch.
 */
export class ExperimentsService {
  private readonly telemetryService: TelemetryService;
  private readonly xumHome: string;
  private readonly overridesFilePath: string;
  private readonly platform: NodeJS.Platform;

  private overrides = new Map<ExperimentId, boolean>();

  private initialized = false;
  private initialization: Promise<void> | undefined;

  constructor(options: {
    telemetryService: TelemetryService;
    xumHome?: string;
    platform?: NodeJS.Platform;
  }) {
    this.telemetryService = options.telemetryService;
    this.xumHome = options.xumHome ?? getXumHome();
    this.overridesFilePath = path.join(this.xumHome, EXPERIMENT_OVERRIDES_FILE_NAME);
    this.platform = options.platform ?? process.platform;
  }

  private isExperimentSupported(experimentId: ExperimentId): boolean {
    return isExperimentSupportedOnPlatform(experimentId, this.platform);
  }

  initialize(): Promise<void> {
    return (this.initialization ??= this.initializeOnce());
  }

  private async initializeOnce(): Promise<void> {
    try {
      await this.withOverridesLock(async (lease) => {
        const needsLegacyPtcMirrorRewrite = await this.loadOverridesFromDisk();
        if (needsLegacyPtcMirrorRewrite) {
          await lease.assertStillOwned();
          await this.writeOverridesToDisk();
        }
      });
    } catch {
      // Startup is best effort; explicit mutations below must report failed persistence.
    }
    this.initialized = true;
  }

  /**
   * Overrides persisted for this machine. Renderers read these so a client whose
   * origin-scoped localStorage is empty still shows the state its backend gates use.
   */
  async getOverrides(): Promise<Partial<Record<ExperimentId, boolean>>> {
    await this.ensureInitialized();
    await this.withOverridesLock(() => this.loadOverridesFromDisk());

    const result: Partial<Record<ExperimentId, boolean>> = {};
    for (const [experimentId, enabled] of this.overrides) {
      if (this.isExperimentSupported(experimentId)) {
        result[experimentId] = enabled;
      }
    }

    return result;
  }

  /**
   * Update a single override. Writes are per-experiment so a client cannot clear
   * overrides it never knew about: localStorage is origin-scoped, and a second
   * renderer starting empty must not wipe state persisted for this machine.
   */
  async setOverride(
    experimentId: ExperimentId,
    enabled: boolean | null | undefined
  ): Promise<void> {
    await this.ensureInitialized();
    assert(experimentId in EXPERIMENTS, `Unknown experimentId: ${experimentId}`);

    await this.withOverridesLock(async (lease) => {
      // Merge the individual mutation into current disk state. A stale sibling
      // changing an unrelated flag must never restore withdrawn Design consent.
      const { overrides: next } = await readOverridesFile(this.overridesFilePath);
      const value = this.isExperimentSupported(experimentId) ? enabled : null;
      if (value == null) next.delete(experimentId);
      else next.set(experimentId, value);
      await lease.assertStillOwned();
      await this.writeOverridesToDisk(next);
      // A successful acknowledgement means the change survives a restart.
      this.adoptOverrides(next);
    });
  }

  private async withOverridesLock<T>(
    operation: (lease: ProcessFileLock) => Promise<T>
  ): Promise<T> {
    await using lease = await acquireProcessFileLock({
      lockPath: `${this.overridesFilePath}.lock`,
      timeoutMs: EXPERIMENTS_WRITE_TIMEOUT_MS,
      label: "experiment overrides",
    });
    return await operation(lease);
  }

  /**
   * True only when the user has explicitly enabled the experiment in Settings.
   * Nothing else can enable an experiment, so security-sensitive gates (e.g. skill
   * dynamic context injection, which executes repo-controlled shell commands) can
   * rely on this meaning deliberate local consent.
   */
  isExperimentEnabled(experimentId: ExperimentId): boolean {
    assert(experimentId in EXPERIMENTS, `Unknown experimentId: ${experimentId}`);

    if (!this.isExperimentSupported(experimentId)) {
      return false;
    }

    return this.overrides.get(experimentId) === true;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.initialize();
    assert(this.initialized, "ExperimentsService failed to initialize");
  }

  /** Returns true when the persisted file enables PTC without the legacy
   * downgrade mirror and needs a rewrite (see initialize). */
  private async loadOverridesFromDisk(): Promise<boolean> {
    const { overrides, hasLegacyPtcMirror } = await readOverridesFile(this.overridesFilePath);
    this.adoptOverrides(overrides);
    return overrides.get(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING) === true && !hasLegacyPtcMirror;
  }

  private adoptOverrides(next: Map<ExperimentId, boolean>): void {
    // Disk reconciliation also changes telemetry, including removed overrides.
    for (const id of new Set([...this.overrides.keys(), ...next.keys()])) {
      if (this.overrides.get(id) !== next.get(id)) {
        this.telemetryService.setFeatureFlagVariant(
          id,
          this.isExperimentSupported(id) ? (next.get(id) ?? null) : null
        );
      }
    }
    this.overrides = next;
  }

  private async writeOverridesToDisk(state = this.overrides): Promise<void> {
    const overrides: NonNullable<ExperimentsFile["overrides"]> = {};
    for (const [experimentId, enabled] of state) {
      overrides[experimentId] = enabled;
    }
    // Downgrade sync (see LEGACY_PTC_EXCLUSIVE_EXPERIMENT_ID): mirror an enabled PTC
    // onto the pre-merge exclusive key so an older build keeps the exclusive
    // posture instead of interpreting a bare ptc:true as supplement mode.
    if (overrides[EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING] === true) {
      overrides[LEGACY_PTC_EXCLUSIVE_EXPERIMENT_ID] = true;
    }

    const payload: ExperimentsFile = {
      version: OVERRIDES_FILE_VERSION,
      experiments: {},
      overrides,
    };

    await fs.mkdir(this.xumHome, { recursive: true });
    await writeFileAtomic(this.overridesFilePath, JSON.stringify(payload, null, 2), "utf-8");
  }
}
