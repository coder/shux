import { RemoteRuntime, type SpawnResult } from "./RemoteRuntime";

/**
 * Minimal concrete RemoteRuntime for tests: identity path resolution, throwing
 * spawn, and stubbed lifecycle. Subclasses override only what they exercise.
 */
export class TestRemoteRuntime extends RemoteRuntime {
  protected readonly commandPrefix: string = "TestRemote";

  protected getBasePath(): string {
    return "/workspace";
  }

  protected quoteForRemote(filePath: string): string {
    return `'${filePath.replaceAll("'", "'\\''")}'`;
  }

  protected cdCommand(cwd: string): string {
    return `cd ${this.quoteForRemote(cwd)}`;
  }

  protected spawnRemoteProcess(): Promise<SpawnResult> {
    throw new Error("spawn should not be called");
  }

  resolvePath(filePath: string): Promise<string> {
    return Promise.resolve(filePath);
  }

  getWorkspacePath(_projectPath: string, _workspaceName: string): string {
    return "/workspace";
  }

  createWorkspace() {
    return Promise.resolve({ success: false as const, error: "not implemented" });
  }

  initWorkspace() {
    return Promise.resolve({ success: true });
  }

  deleteWorkspace() {
    return Promise.resolve({ success: true as const, deletedPath: "/workspace" });
  }

  renameWorkspace() {
    return Promise.resolve({
      success: true as const,
      oldPath: "/workspace",
      newPath: "/workspace",
    });
  }

  forkWorkspace() {
    return Promise.resolve({ success: false as const, error: "not implemented" });
  }

  ensureReady() {
    return Promise.resolve({ ready: true as const });
  }
}
