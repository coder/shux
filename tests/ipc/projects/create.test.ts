/**
 * Integration tests for PROJECT_CREATE IPC handler
 *
 * Tests:
 * - Bare project names resolve to ~/.mux/projects/<name>
 * - Tilde expansion in project paths (home + ~/.mux)
 * - Auto-creation for non-existent paths
 * - Path validation (directory check, duplicates, empty paths)
 */

import * as fs from "fs/promises";
import * as path from "path";
import { getXumHome, getXumProjectsDir } from "../../../src/common/constants/paths";
import * as os from "os";
import { shouldRunIntegrationTests, createTestEnvironment, cleanupTestEnvironment } from "../setup";
import { resolveOrpcClient } from "../helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("PROJECT_CREATE IPC Handler", () => {
  test.concurrent("should resolve bare project name to mux projects dir", async () => {
    const env = await createTestEnvironment();
    const bareName = `mux-test-bare-${Date.now()}`;
    const expectedPath = path.join(getXumProjectsDir(), bareName);
    const client = resolveOrpcClient(env);

    try {
      const result = await client.projects.create({ projectPath: bareName });

      if (!result.success) {
        throw new Error(`Expected success but got: ${result.error}`);
      }

      expect(result.data.normalizedPath).toBe(expectedPath);

      const stats = await fs.stat(expectedPath);
      expect(stats.isDirectory()).toBe(true);
    } finally {
      await fs.rm(expectedPath, { recursive: true, force: true });
      await cleanupTestEnvironment(env);
    }
  });

  test.concurrent("should expand ~/.mux paths to mux home", async () => {
    const env = await createTestEnvironment();
    const tildeSubpath = `mux-test-tilde-${Date.now()}`;
    const tildeProjectPath = `~/.mux/test-projects/${tildeSubpath}`;
    const expectedPath = path.join(getXumHome(), "test-projects", tildeSubpath);
    const client = resolveOrpcClient(env);

    try {
      const result = await client.projects.create({ projectPath: tildeProjectPath });

      if (!result.success) {
        throw new Error(`Expected success but got: ${result.error}`);
      }

      expect(result.data.normalizedPath).toBe(expectedPath);

      const stats = await fs.stat(expectedPath);
      expect(stats.isDirectory()).toBe(true);
    } finally {
      await fs.rm(expectedPath, { recursive: true, force: true });
      await cleanupTestEnvironment(env);
    }
  });

  test.concurrent("should expand windows-style mux tilde paths", async () => {
    const env = await createTestEnvironment();
    const tildeSubpath = `mux-test-tilde-win-${Date.now()}`;
    const tildeProjectPath = `~\\.mux\\test-projects\\${tildeSubpath}`;
    const expectedPath = path.join(getXumHome(), "test-projects", tildeSubpath);
    const client = resolveOrpcClient(env);

    try {
      const result = await client.projects.create({ projectPath: tildeProjectPath });

      if (!result.success) {
        throw new Error(`Expected success but got: ${result.error}`);
      }

      expect(result.data.normalizedPath).toBe(expectedPath);

      const stats = await fs.stat(expectedPath);
      expect(stats.isDirectory()).toBe(true);
    } finally {
      await fs.rm(expectedPath, { recursive: true, force: true });
      await cleanupTestEnvironment(env);
    }
  });

  test.concurrent("should reject duplicate bare project name", async () => {
    const env = await createTestEnvironment();
    const bareName = `mux-test-dup-${Date.now()}`;
    const expectedPath = path.join(getXumProjectsDir(), bareName);
    const client = resolveOrpcClient(env);

    try {
      const result1 = await client.projects.create({ projectPath: bareName });
      if (!result1.success) {
        throw new Error(`Expected success but got: ${result1.error}`);
      }

      const result2 = await client.projects.create({ projectPath: bareName });
      if (result2.success) {
        throw new Error("Expected failure but got success");
      }

      expect(result2.error).toBe("Project already exists");
    } finally {
      await fs.rm(expectedPath, { recursive: true, force: true });
      await cleanupTestEnvironment(env);
    }
  });

  test.concurrent("should reject empty project path", async () => {
    const env = await createTestEnvironment();
    const client = resolveOrpcClient(env);

    try {
      const result = await client.projects.create({ projectPath: "" });

      if (result.success) {
        throw new Error("Expected failure but got success");
      }

      expect(result.error).toBe("Project path cannot be empty");
    } finally {
      await cleanupTestEnvironment(env);
    }
  });

  test.concurrent("should expand tilde in project path and create project", async () => {
    const env = await createTestEnvironment();
    const tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-project-test-"));
    // Create a test directory in home directory
    const testDirName = `mux-test-tilde-${Date.now()}`;
    const homeProjectPath = path.join(os.homedir(), testDirName);
    await fs.mkdir(homeProjectPath, { recursive: true });
    // Create .git directory to make it a valid git repo
    await fs.mkdir(path.join(homeProjectPath, ".git"));

    try {
      // Try to create project with tilde path
      const tildeProjectPath = `~/${testDirName}`;
      const client = resolveOrpcClient(env);
      const result = await client.projects.create({ projectPath: tildeProjectPath });

      // Should succeed
      if (!result.success) {
        throw new Error(`Expected success but got: ${result.error}`);
      }
      expect(result.data.normalizedPath).toBe(homeProjectPath);

      // Verify the project was added with expanded path (not tilde path)
      const projectsList = await client.projects.list();
      const projectPaths = projectsList.map((p: [string, unknown]) => p[0]);

      // Should contain the expanded path
      expect(projectPaths).toContain(homeProjectPath);
      // Should NOT contain the tilde path
      expect(projectPaths).not.toContain(tildeProjectPath);
    } finally {
      // Clean up test directory
      await fs.rm(homeProjectPath, { recursive: true, force: true });
      await cleanupTestEnvironment(env);
      await fs.rm(tempProjectDir, { recursive: true, force: true });
    }
  });

  test.concurrent("should create non-existent project path", async () => {
    const env = await createTestEnvironment();
    const tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-project-test-"));
    const newProjectPath = path.join(tempProjectDir, `mux-created-${Date.now()}`);
    const client = resolveOrpcClient(env);
    const result = await client.projects.create({ projectPath: newProjectPath });

    if (!result.success) {
      throw new Error(`Expected success but got: ${result.error}`);
    }
    expect(result.data.normalizedPath).toBe(newProjectPath);

    const stats = await fs.stat(newProjectPath);
    expect(stats.isDirectory()).toBe(true);

    await cleanupTestEnvironment(env);
    await fs.rm(tempProjectDir, { recursive: true, force: true });
  });

  test.concurrent("should return a friendly error when folder creation is denied", async () => {
    // This scenario relies on POSIX permission bits and a non-root user.
    if (
      process.platform === "win32" ||
      (typeof process.getuid === "function" && process.getuid() === 0)
    ) {
      return;
    }

    const env = await createTestEnvironment();
    const tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-project-test-"));
    const readOnlyDir = path.join(tempProjectDir, "readonly");
    await fs.mkdir(readOnlyDir, { mode: 0o555 });
    const client = resolveOrpcClient(env);

    try {
      const result = await client.projects.create({
        projectPath: path.join(readOnlyDir, "child"),
      });

      if (result.success) {
        throw new Error("Expected failure but got success");
      }
      expect(result.error).toContain("permission denied");
      expect(result.error).not.toContain("EACCES");
    } finally {
      await fs.chmod(readOnlyDir, 0o755);
      await cleanupTestEnvironment(env);
      await fs.rm(tempProjectDir, { recursive: true, force: true });
    }
  });

  test.concurrent("should return a friendly error when the path runs through a file", async () => {
    const env = await createTestEnvironment();
    const tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-project-test-"));
    const occupiedFile = path.join(tempProjectDir, "occupied.txt");
    await fs.writeFile(occupiedFile, "content");
    const client = resolveOrpcClient(env);

    try {
      const result = await client.projects.create({
        projectPath: path.join(occupiedFile, "child"),
      });

      if (result.success) {
        throw new Error("Expected failure but got success");
      }
      expect(result.error).toContain("not a folder");
      expect(result.error).not.toContain("ENOTDIR");
    } finally {
      await cleanupTestEnvironment(env);
      await fs.rm(tempProjectDir, { recursive: true, force: true });
    }
  });

  test.concurrent("should create non-existent tilde path", async () => {
    const env = await createTestEnvironment();
    const tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-project-test-"));
    const testDirName = `mux-tilde-create-${Date.now()}`;
    const tildeProjectPath = `~/${testDirName}`;
    const expectedPath = path.join(os.homedir(), testDirName);
    const client = resolveOrpcClient(env);
    const result = await client.projects.create({ projectPath: tildeProjectPath });

    if (!result.success) {
      throw new Error(`Expected success but got: ${result.error}`);
    }
    expect(result.data.normalizedPath).toBe(expectedPath);

    const stats = await fs.stat(expectedPath);
    expect(stats.isDirectory()).toBe(true);

    await fs.rm(expectedPath, { recursive: true, force: true });
    await cleanupTestEnvironment(env);
    await fs.rm(tempProjectDir, { recursive: true, force: true });
  });

  test.concurrent("should reject file path (not a directory)", async () => {
    const env = await createTestEnvironment();
    const tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-project-test-"));
    const testFile = path.join(tempProjectDir, "test-file.txt");
    await fs.writeFile(testFile, "test content");

    const client = resolveOrpcClient(env);
    const result = await client.projects.create({ projectPath: testFile });

    if (result.success) {
      throw new Error("Expected failure but got success");
    }
    expect(result.error).toContain("not a directory");

    await cleanupTestEnvironment(env);
    await fs.rm(tempProjectDir, { recursive: true, force: true });
  });

  test.concurrent(
    "should accept directory without .git (non-git repos use local runtime only)",
    async () => {
      const env = await createTestEnvironment();
      const tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-project-test-"));

      const client = resolveOrpcClient(env);
      const result = await client.projects.create({ projectPath: tempProjectDir });

      // Non-git directories are now valid - they just can only use local runtime
      if (!result.success) {
        throw new Error(`Expected success but got: ${result.error}`);
      }
      expect(result.data.normalizedPath).toBe(tempProjectDir);

      // listBranches should return empty for non-git repo
      const branchResult = await client.projects.listBranches({ projectPath: tempProjectDir });
      expect(branchResult.branches).toEqual([]);
      expect(branchResult.recommendedTrunk).toBeNull();

      await cleanupTestEnvironment(env);
      await fs.rm(tempProjectDir, { recursive: true, force: true });
    }
  );

  test.concurrent("should accept valid absolute path", async () => {
    const env = await createTestEnvironment();
    const tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-project-test-"));
    // Create .git directory to make it a valid git repo
    await fs.mkdir(path.join(tempProjectDir, ".git"));

    const client = resolveOrpcClient(env);
    const result = await client.projects.create({ projectPath: tempProjectDir });

    if (!result.success) {
      throw new Error(`Expected success but got: ${result.error}`);
    }
    expect(result.data.normalizedPath).toBe(tempProjectDir);

    // Verify project was added
    const projectsList = await client.projects.list();
    const projectPaths = projectsList.map((p: [string, unknown]) => p[0]);
    expect(projectPaths).toContain(tempProjectDir);

    await cleanupTestEnvironment(env);
    await fs.rm(tempProjectDir, { recursive: true, force: true });
  });

  test.concurrent("should normalize paths with .. in them", async () => {
    const env = await createTestEnvironment();
    const tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-project-test-"));
    // Create .git directory to make it a valid git repo
    await fs.mkdir(path.join(tempProjectDir, ".git"));

    // Create a path with .. that resolves to tempProjectDir
    const pathWithDots = path.join(tempProjectDir, "..", path.basename(tempProjectDir));
    const client = resolveOrpcClient(env);
    const result = await client.projects.create({ projectPath: pathWithDots });

    if (!result.success) {
      throw new Error(`Expected success but got: ${result.error}`);
    }
    expect(result.data.normalizedPath).toBe(tempProjectDir);

    // Verify project was added with normalized path
    const projectsList = await client.projects.list();
    const projectPaths = projectsList.map((p: [string, unknown]) => p[0]);
    expect(projectPaths).toContain(tempProjectDir);

    await cleanupTestEnvironment(env);
    await fs.rm(tempProjectDir, { recursive: true, force: true });
  });

  test.concurrent("should reject duplicate projects (same expanded path)", async () => {
    const env = await createTestEnvironment();
    const tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-project-test-"));
    // Create .git directory to make it a valid git repo
    await fs.mkdir(path.join(tempProjectDir, ".git"));

    // Create first project
    const client = resolveOrpcClient(env);
    const result1 = await client.projects.create({ projectPath: tempProjectDir });
    expect(result1.success).toBe(true);

    // Try to create the same project with a path that has ..
    const pathWithDots = path.join(tempProjectDir, "..", path.basename(tempProjectDir));
    const result2 = await client.projects.create({ projectPath: pathWithDots });

    if (result2.success) {
      throw new Error("Expected failure but got success");
    }
    expect(result2.error).toContain("already exists");

    await cleanupTestEnvironment(env);
    await fs.rm(tempProjectDir, { recursive: true, force: true });
  });
});
