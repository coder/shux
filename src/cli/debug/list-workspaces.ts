import { defaultConfig } from "@/node/config";
import { PlatformPaths } from "@/common/utils/paths";
import * as fs from "fs";
import { getXumSessionsDir } from "@/common/constants/paths";

export function listWorkspacesCommand() {
  const config = defaultConfig.loadConfigOrDefault();

  console.log("\n=== Configuration Debug ===\n");
  console.log("Projects in config:", config.projects.size);

  for (const [projectPath, project] of config.projects) {
    const projectName = PlatformPaths.basename(projectPath);
    console.log(`\nProject: ${projectName}`);
    console.log(`  Path: ${projectPath}`);
    console.log(`  Workspaces: ${project.workspaces.length}`);

    for (const workspace of project.workspaces) {
      const dirName = PlatformPaths.basename(workspace.path);
      console.log(`    - Directory: ${dirName}`);
      if (workspace.id) {
        console.log(`      ID: ${workspace.id}`);
      }
      if (workspace.name) {
        console.log(`      Name: ${workspace.name}`);
      }
      console.log(`      Path: ${workspace.path}`);
      console.log(`      Exists: ${fs.existsSync(workspace.path)}`);
    }
  }

  console.log("\n=== Testing findWorkspace ===\n");

  // Test finding specific workspaces by ID
  const testCases = ["mux-colors", "mux-main", "mux-fix", "mux-markdown"];

  for (const workspaceId of testCases) {
    const result = defaultConfig.findWorkspace(workspaceId);
    console.log(`findWorkspace('${workspaceId}'):`);
    if (result) {
      console.log(`  Found: ${result.workspacePath}`);
      console.log(`  Project: ${result.projectPath}`);
      console.log(`  Exists: ${fs.existsSync(result.workspacePath)}`);
    } else {
      console.log(`  Not found!`);
    }
  }

  console.log("\n=== Sessions Directory ===\n");
  const sessionsDir = getXumSessionsDir();
  if (fs.existsSync(sessionsDir)) {
    const sessions = fs.readdirSync(sessionsDir);
    console.log(`Sessions in ${sessionsDir}:`);
    for (const session of sessions) {
      console.log(`  - ${session}`);
    }
  } else {
    console.log("Sessions directory does not exist");
  }
}
