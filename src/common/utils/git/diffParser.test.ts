/**
 * Tests for git diff parsing using a real git repository
 * IMPORTANT: Uses actual git commands, not simulated diffs
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { parseDiff, extractAllHunks, buildGitDiffCommand } from "./diffParser";

describe("git diff parser (real repository)", () => {
  let testRepoPath: string;

  beforeAll(() => {
    // Create a temporary directory for our test repo
    testRepoPath = mkdtempSync(join(tmpdir(), "git-diff-test-"));

    // Initialize git repo
    execSync("git init", { cwd: testRepoPath });
    execSync('git config user.email "test@example.com"', { cwd: testRepoPath });
    // Disable commit signing (some developer machines enforce signing via global config)
    execSync("git config commit.gpgsign false", { cwd: testRepoPath });
    execSync('git config user.name "Test User"', { cwd: testRepoPath });

    // Create initial commit with a file
    writeFileSync(join(testRepoPath, "file1.txt"), "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n");
    writeFileSync(
      join(testRepoPath, "file2.js"),
      'function hello() {\n  console.log("Hello");\n}\n'
    );
    execSync("git add .", { cwd: testRepoPath });
    execSync('git commit -m "Initial commit"', { cwd: testRepoPath });
  });

  afterAll(() => {
    // Clean up test repo
    rmSync(testRepoPath, { recursive: true, force: true });
  });

  it("should parse single file modification", () => {
    // Modify file1.txt
    writeFileSync(
      join(testRepoPath, "file1.txt"),
      "Line 1\nLine 2 modified\nLine 3\nLine 4\nLine 5\n"
    );

    // Get git diff
    const diff = execSync("git diff HEAD", { cwd: testRepoPath, encoding: "utf-8" });

    // Parse diff
    const fileDiffs = parseDiff(diff);

    expect(fileDiffs.length).toBe(1);
    expect(fileDiffs[0].filePath).toBe("file1.txt");
    expect(fileDiffs[0].hunks.length).toBeGreaterThan(0);

    const allHunks = extractAllHunks(fileDiffs);
    expect(allHunks.length).toBeGreaterThan(0);
    expect(allHunks[0].filePath).toBe("file1.txt");
    expect(allHunks[0].content.includes("modified")).toBe(true);
  });

  it("should parse multiple file modifications", () => {
    // Modify both files
    writeFileSync(
      join(testRepoPath, "file1.txt"),
      "Line 1\nNew line\nLine 2\nLine 3\nLine 4\nLine 5\n"
    );
    writeFileSync(
      join(testRepoPath, "file2.js"),
      'function hello() {\n  console.log("Hello World");\n  return true;\n}\n'
    );

    const diff = execSync("git diff HEAD", { cwd: testRepoPath, encoding: "utf-8" });
    const fileDiffs = parseDiff(diff);

    expect(fileDiffs.length).toBe(2);

    const file1Diff = fileDiffs.find((f) => f.filePath === "file1.txt");
    const file2Diff = fileDiffs.find((f) => f.filePath === "file2.js");

    expect(file1Diff).toBeDefined();
    expect(file2Diff).toBeDefined();

    const allHunks = extractAllHunks(fileDiffs);
    expect(allHunks.length).toBeGreaterThan(1);
  });

  it("should parse new file addition", () => {
    // Reset working directory
    execSync("git reset --hard HEAD", { cwd: testRepoPath });

    // Add new file
    writeFileSync(join(testRepoPath, "newfile.md"), "# New File\n\nContent here\n");
    execSync("git add newfile.md", { cwd: testRepoPath });

    const diff = execSync("git diff --cached", { cwd: testRepoPath, encoding: "utf-8" });
    const fileDiffs = parseDiff(diff);

    expect(fileDiffs).toHaveLength(1);
    expect(fileDiffs[0].filePath).toBe("newfile.md");
    expect(fileDiffs[0].changeType).toBe("added");
    expect(fileDiffs[0].hunks.length).toBeGreaterThan(0);

    const hunk = fileDiffs[0].hunks[0];
    expect(hunk.oldStart).toBe(0);
    expect(hunk.oldLines).toBe(0);
    expect(hunk.newStart).toBe(1);
    expect(hunk.header).toMatch(/^@@ -0,0 \+1,\d+ @@/);

    const contentLines = hunk.content.split("\n");

    // Most lines should be additions. We intentionally tolerate a trailing
    // "phantom" context line (" ") because it helps keep the UI stable when the
    // unified diff ends with a newline.
    const nonPhantomLines = contentLines.filter((l) => l !== " ");
    expect(nonPhantomLines.length).toBeGreaterThan(0);
    expect(nonPhantomLines.every((l) => l.startsWith("+"))).toBe(true);
  });

  it("should parse diff headers with non-literal path prefixes", () => {
    const diffOutput = [
      "diff --git c/foo.ts w/foo.ts",
      "index 1111111..2222222 100644",
      "--- c/foo.ts",
      "+++ w/foo.ts",
      "@@ -1 +1 @@",
      "-old line",
      "+new line",
    ].join("\n");

    const fileDiffs = parseDiff(diffOutput);
    const allHunks = extractAllHunks(fileDiffs);

    expect(fileDiffs).toHaveLength(1);
    expect(fileDiffs[0].filePath).toBe("foo.ts");
    expect(fileDiffs[0].oldPath).toBeUndefined();
    expect(allHunks).toHaveLength(1);
    expect(allHunks[0].content).toContain("+new line");
  });

  it("should parse real diffs for paths with spaces", () => {
    execSync("git reset --hard HEAD && git clean -fd", { cwd: testRepoPath });

    const spacedFileName = "file with space.txt";
    writeFileSync(join(testRepoPath, spacedFileName), "before\n");
    execSync("git add . && git commit -m 'Add spaced file'", { cwd: testRepoPath });

    writeFileSync(join(testRepoPath, spacedFileName), "after\n");

    const diff = execSync("git diff HEAD", { cwd: testRepoPath, encoding: "utf-8" });
    const fileDiffs = parseDiff(diff);

    expect(fileDiffs).toHaveLength(1);
    expect(fileDiffs[0].filePath).toBe(spacedFileName);
    expect(fileDiffs[0].oldPath).toBeUndefined();
    expect(fileDiffs[0].hunks).toHaveLength(1);
    expect(fileDiffs[0].hunks[0].filePath).toBe(spacedFileName);
    expect(fileDiffs[0].hunks[0].content).toContain("+after");
  });

  it("should preserve literal trailing spaces in diff path labels", () => {
    execSync("git reset --hard HEAD && git clean -fd", { cwd: testRepoPath });

    const trailingSpaceFileName = "trailing-space.txt ";
    writeFileSync(join(testRepoPath, trailingSpaceFileName), "before\n");
    execSync("git add . && git commit -m 'Add trailing space file'", { cwd: testRepoPath });

    rmSync(join(testRepoPath, trailingSpaceFileName));

    const diff = execSync("git diff HEAD", { cwd: testRepoPath, encoding: "utf-8" });
    const fileDiffs = parseDiff(diff);

    expect(fileDiffs).toHaveLength(1);
    expect(fileDiffs[0].changeType).toBe("deleted");
    expect(fileDiffs[0].filePath).toBe(trailingSpaceFileName);
    expect(fileDiffs[0].oldPath).toBe(trailingSpaceFileName);
    expect(fileDiffs[0].hunks).toHaveLength(1);
    expect(fileDiffs[0].hunks[0].filePath).toBe(trailingSpaceFileName);
    expect(fileDiffs[0].hunks[0].oldPath).toBe(trailingSpaceFileName);
    expect(fileDiffs[0].hunks[0].content).toContain("-before");
  });

  it("should normalize quoted patch labels for escaped file names", () => {
    execSync("git reset --hard HEAD && git clean -fd", { cwd: testRepoPath });

    const escapedFileName = 'tab\tquote"file.txt';
    writeFileSync(join(testRepoPath, escapedFileName), "before\n");
    execSync("git add . && git commit -m 'Add escaped path file'", { cwd: testRepoPath });

    rmSync(join(testRepoPath, escapedFileName));

    const diff = execSync("git diff HEAD", { cwd: testRepoPath, encoding: "utf-8" });
    const fileDiffs = parseDiff(diff);

    expect(fileDiffs).toHaveLength(1);
    expect(fileDiffs[0].changeType).toBe("deleted");
    expect(fileDiffs[0].filePath).toBe(escapedFileName);
    expect(fileDiffs[0].oldPath).toBe(escapedFileName);
    expect(fileDiffs[0].hunks).toHaveLength(1);
    expect(fileDiffs[0].hunks[0].oldPath).toBe(escapedFileName);
    expect(fileDiffs[0].hunks[0].content).toContain("-before");
  });

  it("should preserve nested paths in --no-prefix diffs", () => {
    execSync("git reset --hard HEAD && git clean -fd", { cwd: testRepoPath });
    execSync("mkdir -p src/common", { cwd: testRepoPath });
    writeFileSync(join(testRepoPath, "src", "common", "no-prefix.ts"), "old line\n");
    execSync("git add src/common/no-prefix.ts && git commit -m 'Add nested no-prefix file'", {
      cwd: testRepoPath,
    });

    writeFileSync(join(testRepoPath, "src", "common", "no-prefix.ts"), "new line\n");

    const diff = execSync("git diff --no-prefix HEAD", { cwd: testRepoPath, encoding: "utf-8" });
    const fileDiffs = parseDiff(diff);

    expect(fileDiffs).toHaveLength(1);
    expect(fileDiffs[0].filePath).toBe("src/common/no-prefix.ts");
    expect(fileDiffs[0].oldPath).toBeUndefined();
    expect(fileDiffs[0].hunks).toHaveLength(1);
    expect(fileDiffs[0].hunks[0].content).toContain("+new line");
  });

  it("should parse real mnemonic-prefix diffs", () => {
    execSync("git reset --hard HEAD && git clean -fd", { cwd: testRepoPath });
    execSync("mkdir -p src/mnemonic", { cwd: testRepoPath });
    writeFileSync(join(testRepoPath, "src", "mnemonic", "real.ts"), "before\n");
    execSync("git add src/mnemonic/real.ts && git commit -m 'Add mnemonic test file'", {
      cwd: testRepoPath,
    });

    writeFileSync(join(testRepoPath, "src", "mnemonic", "real.ts"), "after\n");

    const diff = execSync("git -c diff.mnemonicPrefix=true diff HEAD", {
      cwd: testRepoPath,
      encoding: "utf-8",
    });
    const fileDiffs = parseDiff(diff);

    expect(fileDiffs).toHaveLength(1);
    expect(fileDiffs[0].filePath).toBe("src/mnemonic/real.ts");
    expect(fileDiffs[0].oldPath).toBeUndefined();
    expect(fileDiffs[0].hunks[0].content).toContain("+after");
  });

  it("should parse --no-prefix additions that use /dev/null", () => {
    execSync("git reset --hard HEAD && git clean -fd", { cwd: testRepoPath });
    execSync("mkdir -p nested/dir", { cwd: testRepoPath });
    writeFileSync(join(testRepoPath, "nested", "dir", "added-no-prefix.ts"), "added\n");
    execSync("git add nested/dir/added-no-prefix.ts", { cwd: testRepoPath });

    const diff = execSync("git diff --cached --no-prefix", {
      cwd: testRepoPath,
      encoding: "utf-8",
    });
    const fileDiffs = parseDiff(diff);

    expect(fileDiffs).toHaveLength(1);
    expect(fileDiffs[0].changeType).toBe("added");
    expect(fileDiffs[0].filePath).toBe("nested/dir/added-no-prefix.ts");
    expect(fileDiffs[0].oldPath).toBeUndefined();
    expect(fileDiffs[0].hunks[0].header).toMatch(/^@@ -0,0 \+1(?:,1)? @@/);
  });

  it("should parse --no-prefix deletions that use /dev/null", () => {
    execSync("git reset --hard HEAD && git clean -fd", { cwd: testRepoPath });
    execSync("mkdir -p deleted/nested", { cwd: testRepoPath });
    writeFileSync(join(testRepoPath, "deleted", "nested", "gone.ts"), "gone\n");
    execSync("git add deleted/nested/gone.ts && git commit -m 'Add nested deleted file'", {
      cwd: testRepoPath,
    });

    execSync("rm deleted/nested/gone.ts", { cwd: testRepoPath });

    const diff = execSync("git diff --no-prefix HEAD", { cwd: testRepoPath, encoding: "utf-8" });
    const fileDiffs = parseDiff(diff);

    expect(fileDiffs).toHaveLength(1);
    expect(fileDiffs[0].changeType).toBe("deleted");
    expect(fileDiffs[0].filePath).toBe("deleted/nested/gone.ts");
    expect(fileDiffs[0].oldPath).toBe("deleted/nested/gone.ts");
    expect(fileDiffs[0].hunks[0].content).toContain("-gone");
  });

  it("should normalize CRLF diff output (no \\r in hunk content)", () => {
    const diffOutput =
      [
        "diff --git a/crlf.txt b/crlf.txt",
        "new file mode 100644",
        "index 0000000..1111111",
        "--- /dev/null",
        "+++ b/crlf.txt",
        "@@ -0,0 +1,2 @@",
        "+hello",
        "+world",
      ].join("\r\n") + "\r\n";

    const fileDiffs = parseDiff(diffOutput);

    expect(fileDiffs).toHaveLength(1);
    expect(fileDiffs[0].filePath).toBe("crlf.txt");
    expect(fileDiffs[0].changeType).toBe("added");
    expect(fileDiffs[0].hunks).toHaveLength(1);

    const hunk = fileDiffs[0].hunks[0];
    expect(hunk.oldStart).toBe(0);
    expect(hunk.newStart).toBe(1);

    // `parseDiff` should strip CRLF-derived carriage returns.
    expect(hunk.content.includes("\r")).toBe(false);

    // Preserve any trailing phantom context line behavior, but the actual added
    // content should still be present and uncorrupted.
    expect(hunk.content.startsWith("+hello\n+world")).toBe(true);
  });

  it("should parse file deletion", () => {
    execSync("git reset --hard HEAD && git clean -fd", { cwd: testRepoPath });
    writeFileSync(join(testRepoPath, "newfile.md"), "# New File\n\nContent here\n");
    execSync("git add newfile.md && git commit -m 'Add newfile'", { cwd: testRepoPath });

    execSync("rm newfile.md", { cwd: testRepoPath });

    const diff = execSync("git diff HEAD", { cwd: testRepoPath, encoding: "utf-8" });
    const fileDiffs = parseDiff(diff);

    expect(fileDiffs.length).toBe(1);
    expect(fileDiffs[0].filePath).toBe("newfile.md");

    const allHunks = extractAllHunks(fileDiffs);
    // Check that all content lines start with - (deletions)
    const contentLines = allHunks[0].content.split("\n");
    expect(contentLines.some((l) => l.startsWith("-"))).toBe(true);
  });

  it("should parse branch comparison (three-dot diff)", () => {
    // Reset
    execSync("git reset --hard HEAD", { cwd: testRepoPath });

    // Create a feature branch
    execSync("git checkout -b feature", { cwd: testRepoPath });

    // Make changes on feature branch
    writeFileSync(join(testRepoPath, "feature.txt"), "Feature content\n");
    execSync("git add . && git commit -m 'Add feature'", { cwd: testRepoPath });

    // Checkout main and compare
    execSync("git checkout -", { cwd: testRepoPath });
    const baseBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: testRepoPath,
      encoding: "utf-8",
    }).trim();

    const diff = execSync(`git diff ${baseBranch}...feature`, {
      cwd: testRepoPath,
      encoding: "utf-8",
    });

    const fileDiffs = parseDiff(diff);
    expect(fileDiffs.length).toBeGreaterThan(0);

    const featureFile = fileDiffs.find((f) => f.filePath === "feature.txt");
    expect(featureFile).toBeDefined();
  });

  it("should handle empty diff", () => {
    // Reset to clean state
    execSync("git reset --hard HEAD", { cwd: testRepoPath });

    const diff = execSync("git diff HEAD", { cwd: testRepoPath, encoding: "utf-8" });
    const fileDiffs = parseDiff(diff);

    expect(fileDiffs.length).toBe(0);

    const allHunks = extractAllHunks(fileDiffs);
    expect(allHunks.length).toBe(0);
  });

  it("should generate stable hunk IDs for same content", () => {
    // Reset
    execSync("git reset --hard HEAD", { cwd: testRepoPath });

    // Make a specific change
    writeFileSync(
      join(testRepoPath, "file1.txt"),
      "Line 1\nStable change\nLine 3\nLine 4\nLine 5\n"
    );

    const diff1 = execSync("git diff HEAD", { cwd: testRepoPath, encoding: "utf-8" });
    const hunks1 = extractAllHunks(parseDiff(diff1));
    const id1 = hunks1[0]?.id;

    // Reset and make the SAME change again
    execSync("git reset --hard HEAD", { cwd: testRepoPath });
    writeFileSync(
      join(testRepoPath, "file1.txt"),
      "Line 1\nStable change\nLine 3\nLine 4\nLine 5\n"
    );

    const diff2 = execSync("git diff HEAD", { cwd: testRepoPath, encoding: "utf-8" });
    const hunks2 = extractAllHunks(parseDiff(diff2));
    const id2 = hunks2[0]?.id;

    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    expect(id1).toBe(id2);
  });

  it("should handle large diffs with many hunks", () => {
    // Reset
    execSync("git reset --hard HEAD", { cwd: testRepoPath });

    // Create a file with many lines
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
    writeFileSync(join(testRepoPath, "large.txt"), lines.join("\n") + "\n");
    execSync("git add . && git commit -m 'Add large file'", { cwd: testRepoPath });

    // Modify multiple sections
    const modifiedLines = lines.map((line, i) => {
      if (i % 20 === 0) return `Modified ${line}`;
      return line;
    });
    writeFileSync(join(testRepoPath, "large.txt"), modifiedLines.join("\n") + "\n");

    const diff = execSync("git diff HEAD", { cwd: testRepoPath, encoding: "utf-8" });
    const fileDiffs = parseDiff(diff);

    expect(fileDiffs.length).toBe(1);
    expect(fileDiffs[0].hunks.length).toBeGreaterThan(1);

    const allHunks = extractAllHunks(fileDiffs);
    expect(allHunks.length).toBeGreaterThan(1);

    // All hunks should have valid IDs
    expect(allHunks.every((h) => h.id && h.id.length > 0)).toBe(true);
  });

  it("should normalize quoted rename metadata paths", () => {
    execSync("git reset --hard HEAD && git clean -fd", { cwd: testRepoPath });

    const originalFileName = 'tab\tquote"name.txt';
    const renamedFileName = 'tab\tquote"renamed.txt';
    writeFileSync(join(testRepoPath, originalFileName), "before\n");
    execSync("git add . && git commit -m 'Add quoted rename source file'", { cwd: testRepoPath });

    execSync(`git mv '${originalFileName}' '${renamedFileName}'`, {
      cwd: testRepoPath,
    });

    const diff = execSync("git diff --cached -M", { cwd: testRepoPath, encoding: "utf-8" });
    const fileDiffs = parseDiff(diff);

    expect(fileDiffs).toHaveLength(1);
    expect(fileDiffs[0].changeType).toBe("renamed");
    expect(fileDiffs[0].filePath).toBe(renamedFileName);
    expect(fileDiffs[0].oldPath).toBe(originalFileName);
    expect(fileDiffs[0].hunks).toHaveLength(0);
  });

  it("should handle pure file rename (no content changes)", () => {
    // Reset
    execSync("git reset --hard HEAD", { cwd: testRepoPath });

    // Rename a file with git mv (preserves history)
    execSync("git mv file1.txt file1-renamed.txt", { cwd: testRepoPath });

    // Use -M flag to detect renames (though pure renames are detected by default)
    const diff = execSync("git diff --cached -M", { cwd: testRepoPath, encoding: "utf-8" });
    const fileDiffs = parseDiff(diff);

    // A pure rename should be detected
    expect(fileDiffs.length).toBe(1);
    expect(fileDiffs[0].filePath).toBe("file1-renamed.txt");
    expect(fileDiffs[0].oldPath).toBe("file1.txt");
    expect(fileDiffs[0].changeType).toBe("renamed");

    const allHunks = extractAllHunks(fileDiffs);

    // Pure renames with no content changes should have NO hunks
    // because git shows "similarity index 100%" with no diff content
    expect(allHunks.length).toBe(0);
  });

  it("should handle file rename with content changes", () => {
    // Reset
    execSync("git reset --hard HEAD", { cwd: testRepoPath });

    // Create a larger file so a small change maintains high similarity
    writeFileSync(
      join(testRepoPath, "large-file.js"),
      `// Header comment
function hello() {
  console.log("Hello");
}

function goodbye() {
  console.log("Goodbye");
}

function greet(name) {
  console.log(\`Hello \${name}\`);
}

// Footer comment
`
    );
    execSync("git add . && git commit -m 'Add large file'", { cwd: testRepoPath });

    // Rename and make a small modification (maintains >50% similarity)
    execSync("git mv large-file.js renamed-file.js", { cwd: testRepoPath });
    writeFileSync(
      join(testRepoPath, "renamed-file.js"),
      `// Header comment
function hello() {
  console.log("Hello World"); // MODIFIED
}

function goodbye() {
  console.log("Goodbye");
}

function greet(name) {
  console.log(\`Hello \${name}\`);
}

// Footer comment
`
    );
    execSync("git add renamed-file.js", { cwd: testRepoPath });

    // Use -M flag to detect renames
    const diff = execSync("git diff --cached -M", { cwd: testRepoPath, encoding: "utf-8" });
    const fileDiffs = parseDiff(diff);

    expect(fileDiffs.length).toBe(1);
    expect(fileDiffs[0].filePath).toBe("renamed-file.js");
    expect(fileDiffs[0].oldPath).toBe("large-file.js");
    expect(fileDiffs[0].changeType).toBe("renamed");

    const allHunks = extractAllHunks(fileDiffs);
    expect(allHunks.length).toBeGreaterThan(0);

    // Hunks should show the content changes
    expect(allHunks[0].changeType).toBe("renamed");
    expect(allHunks[0].oldPath).toBe("large-file.js");
    expect(allHunks[0].content.includes("World")).toBe(true);
  });

  it("should handle renamed directory with files", () => {
    // Reset and setup
    execSync("git reset --hard HEAD", { cwd: testRepoPath });

    // Create a directory structure
    execSync("mkdir -p old-dir", { cwd: testRepoPath });
    writeFileSync(join(testRepoPath, "old-dir", "nested1.txt"), "Nested file 1\n");
    writeFileSync(join(testRepoPath, "old-dir", "nested2.txt"), "Nested file 2\n");
    execSync("git add . && git commit -m 'Add nested files'", { cwd: testRepoPath });

    // Rename the directory
    execSync("git mv old-dir new-dir", { cwd: testRepoPath });

    // Use -M flag to detect renames
    const diff = execSync("git diff --cached -M", { cwd: testRepoPath, encoding: "utf-8" });
    const fileDiffs = parseDiff(diff);

    // Should detect renames for all files in the directory
    expect(fileDiffs.length).toBeGreaterThanOrEqual(2);

    const nested1 = fileDiffs.find((f) => f.filePath === "new-dir/nested1.txt");
    const nested2 = fileDiffs.find((f) => f.filePath === "new-dir/nested2.txt");

    expect(nested1).toBeDefined();
    expect(nested2).toBeDefined();

    if (nested1) {
      expect(nested1.changeType).toBe("renamed");
      expect(nested1.oldPath).toBe("old-dir/nested1.txt");
    }

    if (nested2) {
      expect(nested2.changeType).toBe("renamed");
      expect(nested2.oldPath).toBe("old-dir/nested2.txt");
    }

    const allHunks = extractAllHunks(fileDiffs);

    // Pure directory renames should have NO hunks (files are identical)
    expect(allHunks.length).toBe(0);
  });

  it("should show unified diff when includeUncommitted is true", () => {
    // Verify includeUncommitted produces single unified diff (not separate committed + uncommitted)
    execSync("git reset --hard HEAD", { cwd: testRepoPath });

    const baseBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: testRepoPath,
      encoding: "utf-8",
    }).trim();

    execSync("git checkout -b unified-test", { cwd: testRepoPath });

    // Commit a change, then make uncommitted change
    writeFileSync(join(testRepoPath, "test-file.txt"), "Line 1\nLine 2\nLine 3\n");
    execSync("git add test-file.txt && git commit -m 'Add test file'", { cwd: testRepoPath });
    writeFileSync(join(testRepoPath, "test-file.txt"), "Line 1\nLine 2\nLine 3 modified\nLine 4\n");

    const gitCommand = buildGitDiffCommand(baseBranch, true, "", "diff");
    const diffOutput = execSync(gitCommand, { cwd: testRepoPath, encoding: "utf-8" });
    const fileDiffs = parseDiff(diffOutput);

    // Single FileDiff with unified changes (no duplicates)
    expect(fileDiffs.length).toBe(1);
    expect(fileDiffs[0].filePath).toBe("test-file.txt");

    const allHunks = extractAllHunks(fileDiffs);
    const allContent = allHunks.map((h) => h.content).join("\n");
    expect(allContent.includes("Line 3 modified") || allContent.includes("Line 4")).toBe(true);

    execSync("git reset --hard HEAD && git checkout -", { cwd: testRepoPath });
  });

  it("should exclude uncommitted changes when includeUncommitted is false", () => {
    // Verify includeUncommitted=false uses three-dot (committed only)
    execSync("git reset --hard HEAD", { cwd: testRepoPath });

    const baseBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: testRepoPath,
      encoding: "utf-8",
    }).trim();

    execSync("git checkout -b committed-only-test", { cwd: testRepoPath });

    // Commit a change
    writeFileSync(join(testRepoPath, "committed-file.txt"), "Line 1\nLine 2\n");
    execSync("git add committed-file.txt && git commit -m 'Add committed file'", {
      cwd: testRepoPath,
    });

    // Make uncommitted change (should NOT appear in diff)
    writeFileSync(join(testRepoPath, "committed-file.txt"), "Line 1\nLine 2\nUncommitted line\n");

    const gitCommand = buildGitDiffCommand(baseBranch, false, "", "diff");
    const diffOutput = execSync(gitCommand, { cwd: testRepoPath, encoding: "utf-8" });
    const fileDiffs = parseDiff(diffOutput);

    // Should get FileDiff showing only committed changes
    expect(fileDiffs.length).toBe(1);
    expect(fileDiffs[0].filePath).toBe("committed-file.txt");

    const allHunks = extractAllHunks(fileDiffs);
    const allContent = allHunks.map((h) => h.content).join("\n");

    // Should NOT include uncommitted "Uncommitted line"
    expect(allContent.includes("Uncommitted line")).toBe(false);
    // Should include committed content
    expect(allContent.includes("Line 1") || allContent.includes("Line 2")).toBe(true);

    execSync("git reset --hard HEAD && git checkout -", { cwd: testRepoPath });
  });

  it("should handle staged + uncommitted when diffBase is --staged", () => {
    // Verify --staged with includeUncommitted produces TWO diffs (staged + unstaged)
    execSync("git reset --hard HEAD", { cwd: testRepoPath });

    writeFileSync(join(testRepoPath, "staged-test.txt"), "Line 1\nLine 2\nLine 3\n");
    execSync("git add staged-test.txt", { cwd: testRepoPath });

    writeFileSync(join(testRepoPath, "staged-test.txt"), "Line 1\nLine 2 staged\nLine 3\n");
    execSync("git add staged-test.txt", { cwd: testRepoPath });

    writeFileSync(
      join(testRepoPath, "staged-test.txt"),
      "Line 1\nLine 2 staged\nLine 3 unstaged\n"
    );

    const gitCommand = buildGitDiffCommand("--staged", true, "", "diff");
    const diffOutput = execSync(gitCommand, { cwd: testRepoPath, encoding: "utf-8" });
    const fileDiffs = parseDiff(diffOutput);

    // Two FileDiff entries (staged + unstaged)
    expect(fileDiffs.length).toBe(2);
    expect(fileDiffs.every((f) => f.filePath === "staged-test.txt")).toBe(true);

    const allHunks = extractAllHunks(fileDiffs);
    expect(allHunks.length).toBe(2);

    const allContent = allHunks.map((h) => h.content).join("\n");
    expect(allContent.includes("staged")).toBe(true);
    expect(allContent.includes("unstaged")).toBe(true);
  });

  it("should not show inverse deltas when branch is behind base ref", () => {
    // Scenario: Branch A is 3 commits behind origin/main
    //
    // Git history:
    //   test-main:  Initial---Y---Z---W (3 commits ahead)
    //                 \
    //   feature:       Feature (committed) + uncommitted changes
    //
    // Problem: Old behavior with includeUncommitted=true used two-dot diff,
    // comparing W to working directory, showing Y, Z, W as inverse deltas.
    //
    // Expected: Should only show feature branch changes (committed + uncommitted),
    // NOT inverse deltas from Y, Z, W commits that landed on test-main.
    execSync("git reset --hard HEAD", { cwd: testRepoPath });

    // Create a "main" branch and add 3 commits
    execSync("git checkout -b test-main", { cwd: testRepoPath });
    writeFileSync(join(testRepoPath, "main-file.txt"), "Initial content\n");
    execSync("git add main-file.txt && git commit -m 'Initial on main'", { cwd: testRepoPath });

    // Branch off from here (this is the merge-base)
    execSync("git checkout -b feature-branch", { cwd: testRepoPath });

    // Add commits on feature branch
    writeFileSync(join(testRepoPath, "feature-file.txt"), "Feature content\n");
    execSync("git add feature-file.txt && git commit -m 'Add feature file'", {
      cwd: testRepoPath,
    });

    // Simulate origin/main moving forward (3 commits ahead)
    execSync("git checkout test-main", { cwd: testRepoPath });
    writeFileSync(join(testRepoPath, "main-file.txt"), "Initial content\nCommit Y\n");
    execSync("git add main-file.txt && git commit -m 'Commit Y on main'", {
      cwd: testRepoPath,
    });

    writeFileSync(join(testRepoPath, "main-file.txt"), "Initial content\nCommit Y\nCommit Z\n");
    execSync("git add main-file.txt && git commit -m 'Commit Z on main'", {
      cwd: testRepoPath,
    });

    writeFileSync(
      join(testRepoPath, "main-file.txt"),
      "Initial content\nCommit Y\nCommit Z\nCommit W\n"
    );
    execSync("git add main-file.txt && git commit -m 'Commit W on main'", {
      cwd: testRepoPath,
    });

    // Back to feature branch
    execSync("git checkout feature-branch", { cwd: testRepoPath });

    // Add uncommitted changes to feature branch
    writeFileSync(join(testRepoPath, "feature-file.txt"), "Feature content\nUncommitted change\n");

    // Test 1: includeUncommitted=false (committed only, uses three-dot)
    const gitCommandCommittedOnly = buildGitDiffCommand("test-main", false, "", "diff");
    const diffOutputCommittedOnly = execSync(gitCommandCommittedOnly, {
      cwd: testRepoPath,
      encoding: "utf-8",
    });
    const fileDiffsCommittedOnly = parseDiff(diffOutputCommittedOnly);

    const featureFileCommittedOnly = fileDiffsCommittedOnly.find(
      (f) => f.filePath === "feature-file.txt"
    );
    const mainFileCommittedOnly = fileDiffsCommittedOnly.find(
      (f) => f.filePath === "main-file.txt"
    );

    expect(featureFileCommittedOnly).toBeDefined();
    expect(mainFileCommittedOnly).toBeUndefined(); // No inverse deltas

    const hunksCommittedOnly = extractAllHunks(fileDiffsCommittedOnly);
    const contentCommittedOnly = hunksCommittedOnly.map((h) => h.content).join("\n");

    // Should show committed feature work
    expect(contentCommittedOnly.includes("Feature content")).toBe(true);
    // Should NOT show uncommitted changes (key difference from includeUncommitted=true)
    expect(contentCommittedOnly.includes("Uncommitted change")).toBe(false);
    // Should NOT show inverse deltas from main
    expect(contentCommittedOnly.includes("Commit Y")).toBe(false);
    expect(contentCommittedOnly.includes("Commit Z")).toBe(false);
    expect(contentCommittedOnly.includes("Commit W")).toBe(false);

    // Test 2: includeUncommitted=true (committed + uncommitted, uses merge-base)
    const gitCommand = buildGitDiffCommand("test-main", true, "", "diff");
    const diffOutput = execSync(gitCommand, { cwd: testRepoPath, encoding: "utf-8" });
    const fileDiffs = parseDiff(diffOutput);

    // Should show only feature-file.txt (the file we added/modified)
    // Should NOT show main-file.txt as deletions (inverse deltas)
    const featureFile = fileDiffs.find((f) => f.filePath === "feature-file.txt");
    const mainFile = fileDiffs.find((f) => f.filePath === "main-file.txt");

    expect(featureFile).toBeDefined();
    expect(mainFile).toBeUndefined(); // Should NOT appear

    // Verify we see both committed and uncommitted changes in feature-file.txt
    const allHunks = extractAllHunks(fileDiffs);
    const allContent = allHunks.map((h) => h.content).join("\n");

    expect(allContent.includes("Feature content")).toBe(true);
    expect(allContent.includes("Uncommitted change")).toBe(true);

    // Critically: should NOT show any deletions from Commit Y, Z, W
    expect(allContent.includes("Commit Y")).toBe(false);
    expect(allContent.includes("Commit Z")).toBe(false);
    expect(allContent.includes("Commit W")).toBe(false);

    // Cleanup
    execSync("git checkout test-main --force", { cwd: testRepoPath });
    execSync("git branch -D feature-branch", { cwd: testRepoPath });
  });

  it("should shell-quote diffBase to prevent command injection", () => {
    const gitCommand = buildGitDiffCommand("main;touch /tmp/pwned", false, "", "diff");

    expect(gitCommand).toContain("git diff 'main;touch /tmp/pwned'...HEAD -M");
    expect(gitCommand).not.toContain("git diff main;touch /tmp/pwned...HEAD -M");
  });
});
