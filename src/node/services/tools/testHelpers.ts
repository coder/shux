import * as fs from "fs";
import * as fsPromises from "node:fs/promises";
import * as path from "path";
import * as os from "os";
import type { ToolExecutionOptions } from "ai";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { TestRemoteRuntime } from "@/node/runtime/testRemoteRuntime";
import { InitStateManager } from "@/node/services/initStateManager";
import { Config } from "@/node/config";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import type { XumToolScope } from "@/common/types/toolScope";
import type { Runtime } from "@/node/runtime/Runtime";

export class TestTempDir implements Disposable {
  public readonly path: string;

  constructor(prefix = "test-tool") {
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.path = path.join(os.tmpdir(), `${prefix}-${id}`);
    fs.mkdirSync(this.path, { recursive: true });
  }

  [Symbol.dispose](): void {
    fs.rmSync(this.path, { recursive: true, force: true });
  }
}

export const TEST_GLOBAL_WORKSPACE_ID = "workspace-global";

export const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

interface SkillFixtureOptions {
  description?: string;
  advertise?: boolean;
  /** Writes the ecosystem-standard `disable-model-invocation` frontmatter field. */
  disableModelInvocation?: boolean;
  /** Writes the ecosystem-standard `user-invocable` frontmatter field. */
  userInvocable?: boolean;
  /** Writes the ecosystem-standard `argument-hint` frontmatter field. */
  argumentHint?: string;
  /** Writes the `when_to_use` frontmatter field (underscore spelling). */
  whenToUse?: string;
  /** Writes the `when-to-use` frontmatter field (kebab spelling). */
  whenToUseKebab?: string;
  body?: string;
  files?: Record<string, string>;
}

export function restoreXumRoot(previousXumRoot: string | undefined): void {
  if (previousXumRoot === undefined) {
    delete process.env.XUM_ROOT;
    return;
  }

  process.env.XUM_ROOT = previousXumRoot;
}

export function restoreMuxRoot(previousMuxRoot: string | undefined): void {
  if (previousMuxRoot === undefined) {
    delete process.env.MUX_ROOT;
    return;
  }

  process.env.MUX_ROOT = previousMuxRoot;
}

export async function withMuxRoot(muxRoot: string, callback: () => Promise<void>): Promise<void> {
  const previousMuxRoot = process.env.MUX_ROOT;
  process.env.MUX_ROOT = muxRoot;

  try {
    await callback();
  } finally {
    restoreMuxRoot(previousMuxRoot);
  }
}

export async function createWorkspaceSessionDir(
  xumHome: string,
  workspaceId: string
): Promise<string> {
  const workspaceSessionDir = path.join(xumHome, "sessions", workspaceId);
  await fsPromises.mkdir(workspaceSessionDir, { recursive: true });
  return workspaceSessionDir;
}

export function skillMarkdown(name: string, options?: SkillFixtureOptions): string {
  const optionalLines = [
    options?.advertise === undefined ? "" : `advertise: ${options.advertise ? "true" : "false"}`,
    options?.disableModelInvocation === undefined
      ? ""
      : `disable-model-invocation: ${options.disableModelInvocation ? "true" : "false"}`,
    options?.userInvocable === undefined
      ? ""
      : `user-invocable: ${options.userInvocable ? "true" : "false"}`,
    options?.argumentHint === undefined ? "" : `argument-hint: "${options.argumentHint}"`,
    options?.whenToUse === undefined ? "" : `when_to_use: ${options.whenToUse}`,
    options?.whenToUseKebab === undefined ? "" : `when-to-use: ${options.whenToUseKebab}`,
  ];

  return [
    "---",
    `name: ${name}`,
    `description: ${options?.description ?? `description for ${name}`}`,
    ...optionalLines,
    "---",
    options?.body ?? "Body",
    "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export async function writeSkill(
  skillsRoot: string,
  name: string,
  options?: SkillFixtureOptions
): Promise<void> {
  const skillDir = path.join(skillsRoot, name);
  await fsPromises.mkdir(skillDir, { recursive: true });
  await fsPromises.writeFile(
    path.join(skillDir, "SKILL.md"),
    skillMarkdown(name, options),
    "utf-8"
  );

  for (const [relativePath, content] of Object.entries(options?.files ?? {})) {
    const targetPath = path.join(skillDir, relativePath);
    await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
    await fsPromises.writeFile(targetPath, content, "utf-8");
  }
}

export async function writeGlobalSkill(
  xumHome: string,
  name: string,
  options?: SkillFixtureOptions
): Promise<void> {
  await writeSkill(path.join(xumHome, "skills"), name, options);
}

export async function writeProjectSkill(
  projectRoot: string,
  name: string,
  options?: SkillFixtureOptions
): Promise<void> {
  await writeSkill(path.join(projectRoot, ".xum", "skills"), name, options);
}

export async function writeSkillWithReference(xumHome: string, name: string): Promise<void> {
  await writeGlobalSkill(xumHome, name, {
    description: "fixture",
    files: { "references/foo.txt": "fixture" },
  });
}

interface RemotePathMappedRuntimeOptions {
  xumHome?: string;
  resolveToRemotePath?: boolean;
}

export class RemotePathMappedRuntime extends LocalRuntime {
  private readonly localBase: string;
  private readonly remoteBase: string;
  private readonly localHomeForTildeRoot: string | null;
  private readonly xumHomeOverride: string | null;
  private readonly resolveToRemotePath: boolean;
  public resolvePathCallCount = 0;

  constructor(localBase: string, remoteBase: string, options?: RemotePathMappedRuntimeOptions) {
    super(localBase);
    this.localBase = path.resolve(localBase);
    this.remoteBase = remoteBase === "/" ? remoteBase : remoteBase.replace(/\/+$/u, "");
    this.xumHomeOverride = options?.xumHome ?? null;
    this.resolveToRemotePath = options?.resolveToRemotePath ?? true;

    if (this.remoteBase === "~") {
      this.localHomeForTildeRoot = this.localBase;
    } else if (this.remoteBase.startsWith("~/")) {
      const homeRelativeSuffix = this.remoteBase.slice(1);
      const normalizedLocalRoot = this.localBase.replaceAll("\\", "/");
      if (normalizedLocalRoot.endsWith(homeRelativeSuffix)) {
        const derivedHome = normalizedLocalRoot.slice(
          0,
          normalizedLocalRoot.length - homeRelativeSuffix.length
        );
        this.localHomeForTildeRoot = derivedHome.length > 0 ? derivedHome : "/";
      } else {
        this.localHomeForTildeRoot = null;
      }
    } else {
      this.localHomeForTildeRoot = null;
    }
  }

  private usesTildeWorkspaceRoot(): boolean {
    return this.remoteBase === "~" || this.remoteBase.startsWith("~/");
  }

  protected toLocalPath(runtimePath: string): string {
    const normalizedRuntimePath = runtimePath.replaceAll("\\", "/");

    if (normalizedRuntimePath === this.remoteBase) {
      return this.localBase;
    }

    if (normalizedRuntimePath.startsWith(`${this.remoteBase}/`)) {
      const suffix = normalizedRuntimePath.slice(this.remoteBase.length + 1);
      return path.join(this.localBase, ...suffix.split("/"));
    }

    return runtimePath;
  }

  private toRemotePath(localPath: string): string {
    const resolvedLocalPath = path.resolve(localPath);

    if (resolvedLocalPath === this.localBase) {
      return this.remoteBase;
    }

    const localPrefix = `${this.localBase}${path.sep}`;
    if (resolvedLocalPath.startsWith(localPrefix)) {
      const suffix = resolvedLocalPath.slice(localPrefix.length).split(path.sep).join("/");
      return `${this.remoteBase}/${suffix}`;
    }

    return localPath.replaceAll("\\", "/");
  }

  private translateCommandToLocal(command: string): string {
    return command.split(this.remoteBase).join(this.localBase.replaceAll("\\", "/"));
  }

  override getWorkspacePath(projectPath: string, workspaceName: string): string {
    return path.posix.join(this.remoteBase, path.basename(projectPath), workspaceName);
  }

  override getXumHome(): string {
    return this.xumHomeOverride ?? super.getXumHome();
  }

  override normalizePath(targetPath: string, basePath: string): string {
    const normalizedBasePath = this.toRemotePath(basePath);
    const normalizedTargetPath = targetPath.replaceAll("\\", "/");

    if (normalizedBasePath === "~" || normalizedBasePath.startsWith("~/")) {
      if (
        normalizedTargetPath === "~" ||
        normalizedTargetPath.startsWith("~/") ||
        normalizedTargetPath.startsWith("/")
      ) {
        return normalizedTargetPath;
      }
      return path.posix.normalize(path.posix.join(normalizedBasePath, normalizedTargetPath));
    }

    return path.posix.resolve(normalizedBasePath, normalizedTargetPath);
  }

  override async resolvePath(filePath: string): Promise<string> {
    this.resolvePathCallCount += 1;
    const resolvedLocalPath = await super.resolvePath(this.toLocalPath(filePath));
    return this.resolveToRemotePath ? this.toRemotePath(resolvedLocalPath) : resolvedLocalPath;
  }

  override exec(
    command: string,
    options: Parameters<LocalRuntime["exec"]>[1]
  ): ReturnType<LocalRuntime["exec"]> {
    const usesTildeRoot = this.usesTildeWorkspaceRoot();
    const localHomeForTildeRoot = this.localHomeForTildeRoot ?? process.env.HOME ?? this.localBase;

    return super.exec(usesTildeRoot ? command : this.translateCommandToLocal(command), {
      ...options,
      cwd: this.toLocalPath(options.cwd),
      env: usesTildeRoot ? { ...(options.env ?? {}), HOME: localHomeForTildeRoot } : options.env,
    });
  }

  override stat(filePath: string, abortSignal?: AbortSignal): ReturnType<LocalRuntime["stat"]> {
    return super.stat(this.toLocalPath(filePath), abortSignal);
  }

  override readFile(
    filePath: string,
    abortSignal?: AbortSignal
  ): ReturnType<LocalRuntime["readFile"]> {
    return super.readFile(this.toLocalPath(filePath), abortSignal);
  }

  override writeFile(
    filePath: string,
    abortSignal?: AbortSignal
  ): ReturnType<LocalRuntime["writeFile"]> {
    return super.writeFile(this.toLocalPath(filePath), abortSignal);
  }

  override ensureDir(dirPath: string): ReturnType<LocalRuntime["ensureDir"]> {
    return super.ensureDir(this.toLocalPath(dirPath));
  }
}

export class TrueRemotePathMappedRuntime extends TestRemoteRuntime {
  private readonly delegate: RemotePathMappedRuntime;
  private readonly remoteBase: string;

  constructor(localBase: string, remoteBase: string) {
    super();
    this.remoteBase = remoteBase === "/" ? remoteBase : remoteBase.replace(/\/+$/u, "");
    this.delegate = new RemotePathMappedRuntime(localBase, remoteBase);
  }

  protected override getBasePath(): string {
    return this.remoteBase;
  }

  override exec(
    command: string,
    options: Parameters<LocalRuntime["exec"]>[1]
  ): ReturnType<LocalRuntime["exec"]> {
    return this.delegate.exec(command, options);
  }

  override normalizePath(targetPath: string, basePath: string): string {
    return this.delegate.normalizePath(targetPath, basePath);
  }

  override resolvePath(filePath: string): Promise<string> {
    return this.delegate.resolvePath(filePath);
  }

  override getWorkspacePath(projectPath: string, workspaceName: string): string {
    return this.delegate.getWorkspacePath(projectPath, workspaceName);
  }

  override stat(filePath: string, abortSignal?: AbortSignal): ReturnType<LocalRuntime["stat"]> {
    return this.delegate.stat(filePath, abortSignal);
  }

  override readFile(
    filePath: string,
    abortSignal?: AbortSignal
  ): ReturnType<LocalRuntime["readFile"]> {
    return this.delegate.readFile(filePath, abortSignal);
  }

  override writeFile(
    filePath: string,
    abortSignal?: AbortSignal
  ): ReturnType<LocalRuntime["writeFile"]> {
    return this.delegate.writeFile(filePath, abortSignal);
  }

  override ensureDir(dirPath: string): ReturnType<LocalRuntime["ensureDir"]> {
    return this.delegate.ensureDir(dirPath);
  }
}

let testConfig: Config | null = null;
let testInitStateManager: InitStateManager | null = null;

function getTestConfig(): Config {
  return (testConfig ??= new Config());
}

function getTestInitStateManager(): InitStateManager {
  return (testInitStateManager ??= new InitStateManager(getTestConfig()));
}

export function createIsolatedAgentSkillsRoots(root: string) {
  // Keep built-in skill tests independent from developer-global skills that may share a name.
  return {
    projectRoot: path.join(root, "isolated-project-skills"),
    globalRoot: path.join(root, "isolated-global-skills"),
  };
}

export function createTestToolConfig(
  tempDir: string,
  options?: {
    workspaceId?: string;
    sessionsDir?: string;
    runtime?: Runtime;
    xumScope?: XumToolScope;
  }
): ToolConfiguration {
  return {
    cwd: tempDir,
    workspaceSessionDir: options?.sessionsDir ?? tempDir,
    runtime: options?.runtime ?? new LocalRuntime(tempDir),
    runtimeTempDir: tempDir,
    workspaceId: options?.workspaceId ?? "test-workspace",
    xumScope: options?.xumScope ?? {
      type: "global",
      xumHome: tempDir,
    },
  };
}

export function getTestDeps() {
  return {
    workspaceId: "test-workspace" as const,
    initStateManager: getTestInitStateManager(),
  };
}
