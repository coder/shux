import * as path from "path";
import { getXumHome } from "@/common/constants/paths";

export class WorkspaceSessionLocator {
  readonly rootDir: string;
  readonly srcDir: string;
  readonly sessionsDir: string;

  constructor(rootDir = getXumHome()) {
    this.rootDir = rootDir;
    this.srcDir = path.join(rootDir, "src");
    this.sessionsDir = path.join(rootDir, "sessions");
  }

  getSessionDir(workspaceId: string): string {
    return path.join(this.sessionsDir, workspaceId);
  }
}
