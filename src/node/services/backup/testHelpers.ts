import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ProjectsConfig } from "@/common/types/project";
import { Config } from "@/node/config";
import { execFileAsync } from "@/node/utils/disposableExec";

export async function runGit(args: string[]): Promise<string> {
  using process = execFileAsync("git", args);
  return (await process.result).stdout.trim();
}

export async function writeFixtureFile(
  root: string,
  relativePath: string,
  content: string
): Promise<void> {
  const filePath = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

export async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject");
}

export async function commitAll(repoDir: string, message: string): Promise<void> {
  await runGit(["-C", repoDir, "add", "-A"]);
  await runGit([
    "-C",
    repoDir,
    "-c",
    "user.email=mux@example.com",
    "-c",
    "user.name=Xum",
    "commit",
    "-m",
    message,
  ]);
}

export class TestBackupConfig extends Config {
  state: ProjectsConfig = { projects: new Map() };
  // Models the serialized disk reread that happens immediately before a real config edit.
  beforeEdit: (() => void) | null = null;

  override loadConfigOrDefault(): ProjectsConfig {
    return this.state;
  }

  override editConfig(edit: (config: ProjectsConfig) => ProjectsConfig): Promise<void> {
    const hook = this.beforeEdit;
    this.beforeEdit = null;
    hook?.();
    this.state = edit(this.state);
    return Promise.resolve();
  }
}
