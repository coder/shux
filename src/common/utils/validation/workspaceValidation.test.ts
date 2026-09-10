import {
  getBranchWorkspaceNameConflict,
  sanitizeBranchNameForWorkspace,
  validateWorkspaceBranchName,
  validateWorkspaceName,
} from "./workspaceValidation";

describe("validateWorkspaceName", () => {
  describe("valid names", () => {
    test("accepts lowercase letters", () => {
      expect(validateWorkspaceName("main").valid).toBe(true);
      expect(validateWorkspaceName("feature").valid).toBe(true);
    });

    test("accepts digits", () => {
      expect(validateWorkspaceName("branch123").valid).toBe(true);
      expect(validateWorkspaceName("123").valid).toBe(true);
    });

    test("accepts underscores", () => {
      expect(validateWorkspaceName("my_branch").valid).toBe(true);
      expect(validateWorkspaceName("feature_test_123").valid).toBe(true);
    });

    test("accepts hyphens", () => {
      expect(validateWorkspaceName("my-branch").valid).toBe(true);
      expect(validateWorkspaceName("feature-test-123").valid).toBe(true);
    });

    test("accepts combinations", () => {
      expect(validateWorkspaceName("feature-branch_123").valid).toBe(true);
      expect(validateWorkspaceName("a1-b2_c3").valid).toBe(true);
    });

    test("accepts single character", () => {
      expect(validateWorkspaceName("a").valid).toBe(true);
      expect(validateWorkspaceName("1").valid).toBe(true);
      expect(validateWorkspaceName("_").valid).toBe(true);
      expect(validateWorkspaceName("-").valid).toBe(true);
    });

    test("accepts 64 characters", () => {
      const name = "a".repeat(64);
      expect(validateWorkspaceName(name).valid).toBe(true);
    });
  });

  describe("invalid names", () => {
    test("rejects empty string", () => {
      const result = validateWorkspaceName("");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("empty");
    });

    test("rejects names over 64 characters", () => {
      const name = "a".repeat(65);
      const result = validateWorkspaceName(name);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("64 characters");
    });

    test("rejects uppercase letters", () => {
      const result = validateWorkspaceName("MyBranch");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("lowercase");
    });

    test("rejects spaces", () => {
      const result = validateWorkspaceName("my branch");
      expect(result.valid).toBe(false);
    });

    test("rejects special characters", () => {
      expect(validateWorkspaceName("branch@123").valid).toBe(false);
      expect(validateWorkspaceName("branch#123").valid).toBe(false);
      expect(validateWorkspaceName("branch$123").valid).toBe(false);
      expect(validateWorkspaceName("branch%123").valid).toBe(false);
      expect(validateWorkspaceName("branch!123").valid).toBe(false);
      expect(validateWorkspaceName("branch.123").valid).toBe(false);
      expect(validateWorkspaceName("branch/123").valid).toBe(false);
      expect(validateWorkspaceName("branch\\123").valid).toBe(false);
    });

    test("rejects names with slashes", () => {
      expect(validateWorkspaceName("feature/branch").valid).toBe(false);
      expect(validateWorkspaceName("path\\to\\branch").valid).toBe(false);
    });
  });
});

describe("validateWorkspaceBranchName", () => {
  test.each(["feature/foo", "a/b/c", "plain-name", "branch_123"])("accepts %s", (name) => {
    expect(validateWorkspaceBranchName(name).valid).toBe(true);
  });

  test.each(["", "/foo", "foo/", "a//b", "Feature/foo", "feature name"])("rejects %s", (name) => {
    expect(validateWorkspaceBranchName(name).valid).toBe(false);
  });

  test("rejects names over 64 characters", () => {
    expect(validateWorkspaceBranchName(`feature/${"a".repeat(57)}`).valid).toBe(false);
  });
});

describe("sanitizeBranchNameForWorkspace", () => {
  test.each([
    ["feature/foo", "feature-foo"],
    ["a/b/c", "a-b-c"],
    ["plain-name", "plain-name"],
  ])("maps %s to %s", (branchName, workspaceName) => {
    expect(sanitizeBranchNameForWorkspace(branchName)).toBe(workspaceName);
  });

  test.each(["feature/foo", "a/b/c", "plain-name", "branch_123"])(
    "produces a valid workspace name for %s",
    (branchName) => {
      expect(validateWorkspaceBranchName(branchName).valid).toBe(true);
      expect(validateWorkspaceName(sanitizeBranchNameForWorkspace(branchName)).valid).toBe(true);
    }
  );
});

describe("getBranchWorkspaceNameConflict", () => {
  test("reports the sanitized collision for slash branches", () => {
    const conflict = getBranchWorkspaceNameConflict("feature/foo", ["other", "feature-foo"]);

    expect(conflict).toContain('Branch "feature/foo"');
    expect(conflict).toContain('workspace name "feature-foo"');
  });

  test("allows slash branches whose sanitized workspace name is unused", () => {
    expect(getBranchWorkspaceNameConflict("feature/foo", ["feature-bar"])).toBeUndefined();
  });

  test("leaves slash-free collisions to the existing suffix policy", () => {
    expect(getBranchWorkspaceNameConflict("feature-foo", ["feature-foo"])).toBeUndefined();
  });
});
