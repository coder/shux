import { describe, expect, test } from "bun:test";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import {
  normalizeRepoRootFilePath,
  reprojectRepoRootFilePath,
  resolveRepoRootProjectPath,
} from "./executeBash";

const workspaceMetadata: Pick<FrontendWorkspaceMetadata, "projects"> = {
  projects: [
    { projectName: "project-a", projectPath: "/tmp/project-a" },
    { projectName: "project-b", projectPath: "/tmp/project-b" },
  ],
};

const windowsWorkspaceMetadata: Pick<FrontendWorkspaceMetadata, "projects"> = {
  projects: [
    { projectName: "project-a", projectPath: "C:\\tmp\\project-a" },
    { projectName: "project-b", projectPath: "C:\\tmp\\project-b" },
  ],
};

describe("executeBash repo-root helpers", () => {
  test("resolves repo-root project paths from workspace-relative sibling project paths", () => {
    expect(resolveRepoRootProjectPath(workspaceMetadata, "project-b/src/example.ts")).toBe(
      "/tmp/project-b"
    );
  });

  test("normalizes sibling project paths to repo-relative paths for repo-root execution", () => {
    expect(
      normalizeRepoRootFilePath(workspaceMetadata, "project-b/src/example.ts", "/tmp/project-b")
    ).toBe("src/example.ts");
  });

  test("maps project-root selections to the repo root when execution switches into that repo", () => {
    expect(normalizeRepoRootFilePath(workspaceMetadata, "project-b", "/tmp/project-b")).toBe(".");
  });

  test("keeps workspace-relative paths when execution stays on the container root", () => {
    expect(normalizeRepoRootFilePath(workspaceMetadata, "project-b/src/example.ts")).toBe(
      "project-b/src/example.ts"
    );
  });

  test("reprojects repo-root output back to workspace-relative paths for primary repos", () => {
    expect(reprojectRepoRootFilePath(workspaceMetadata, "src/example.ts", "/tmp/project-a")).toBe(
      "project-a/src/example.ts"
    );
  });

  test("reprojects repo-root output back to workspace-relative paths for sibling repos", () => {
    expect(reprojectRepoRootFilePath(workspaceMetadata, "src/example.ts", "/tmp/project-b")).toBe(
      "project-b/src/example.ts"
    );
  });

  test("preserves rename syntax while reprojecting repo-root output", () => {
    expect(
      reprojectRepoRootFilePath(workspaceMetadata, "src/{old.ts => new.ts}", "/tmp/project-b")
    ).toBe("project-b/src/{old.ts => new.ts}");
  });

  test("matches repo-root targets after normalizing Windows-style project paths", () => {
    expect(
      normalizeRepoRootFilePath(
        windowsWorkspaceMetadata,
        "project-b/src/example.ts",
        "C:/tmp/project-b"
      )
    ).toBe("src/example.ts");
    expect(
      reprojectRepoRootFilePath(windowsWorkspaceMetadata, "src/example.ts", "C:/tmp/project-b")
    ).toBe("project-b/src/example.ts");
  });

  test("reprojects repo-root paths whose first segment only matches a sibling project name", () => {
    expect(
      reprojectRepoRootFilePath(workspaceMetadata, "project-b/src/example.ts", "/tmp/project-a")
    ).toBe("project-a/project-b/src/example.ts");
  });

  test("does not double-prefix paths that are already workspace-relative", () => {
    expect(
      reprojectRepoRootFilePath(workspaceMetadata, "project-b/src/example.ts", "/tmp/project-b")
    ).toBe("project-b/src/example.ts");
  });

  test("keeps repo-relative paths when execution never left the shared container root", () => {
    expect(reprojectRepoRootFilePath(workspaceMetadata, "src/example.ts")).toBe("src/example.ts");
  });

  test("keeps primary-repo paths unchanged when no sibling project prefix is present", () => {
    expect(normalizeRepoRootFilePath(workspaceMetadata, "src/example.ts", "/tmp/project-a")).toBe(
      "src/example.ts"
    );
  });

  test("preserves edge whitespace in git file paths through reprojection", () => {
    // A file may literally be named ".env " (trailing space); trimming it here would
    // point downstream reads (copy, overlay) at a different file such as an ignored
    // ".env". Single-project reprojection must return the exact path.
    expect(reprojectRepoRootFilePath(null, ".env ")).toBe(".env ");
    // Multi-project: the repo-relative remainder keeps its edge whitespace too.
    expect(reprojectRepoRootFilePath(workspaceMetadata, ".env ", "/tmp/project-b")).toBe(
      "project-b/.env "
    );
    expect(normalizeRepoRootFilePath(workspaceMetadata, "project-b/.env ", "/tmp/project-b")).toBe(
      ".env "
    );
  });
});
