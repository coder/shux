import { getPlanFilePath, getLegacyPlanFilePath } from "./planStorage";

describe("planStorage", () => {
  // Plan paths use tilde prefix for portability across local/remote runtimes
  const expectedXumHome = "~/.xum";

  describe("getPlanFilePath", () => {
    it("should return path with project name and workspace name", () => {
      const result = getPlanFilePath("fix-plan-a1b2", "xum");
      expect(result).toBe(`${expectedXumHome}/plans/xum/fix-plan-a1b2.md`);
    });

    it("should produce same path for same inputs", () => {
      const result1 = getPlanFilePath("fix-bug-x1y2", "myproject");
      const result2 = getPlanFilePath("fix-bug-x1y2", "myproject");
      expect(result1).toBe(result2);
    });

    it("should organize plans by project folder", () => {
      const result1 = getPlanFilePath("sidebar-a1b2", "xum");
      const result2 = getPlanFilePath("auth-c3d4", "other-project");
      expect(result1).toBe(`${expectedXumHome}/plans/xum/sidebar-a1b2.md`);
      expect(result2).toBe(`${expectedXumHome}/plans/other-project/auth-c3d4.md`);
    });

    it("should use custom xumHome when provided (Docker uses /var/mux)", () => {
      const result = getPlanFilePath("fix-plan-a1b2", "xum", "/var/mux");
      expect(result).toBe("/var/mux/plans/xum/fix-plan-a1b2.md");
    });

    it("should default to ~/.xum when xumHome not provided", () => {
      const withDefault = getPlanFilePath("workspace", "project");
      const withExplicit = getPlanFilePath("workspace", "project", "~/.xum");
      expect(withDefault).toBe(withExplicit);
    });
  });

  describe("getLegacyPlanFilePath", () => {
    it("should return local canonical path rooted in ~/.xum", () => {
      const result = getLegacyPlanFilePath("a1b2c3d4e5", expectedXumHome);
      expect(result).toBe(`${expectedXumHome}/plans/a1b2c3d4e5.md`);
    });

    it("should handle legacy format IDs under the local canonical home", () => {
      const result = getLegacyPlanFilePath("mux-main", expectedXumHome);
      expect(result).toBe(`${expectedXumHome}/plans/mux-main.md`);
    });

    it("should root SSH legacy lookup in ~/.mux, not ~/.xum", () => {
      const result = getLegacyPlanFilePath("a1b2c3d4e5", "~/.mux");
      expect(result).toBe("~/.mux/plans/a1b2c3d4e5.md");
      expect(result).not.toContain("~/.xum");
    });

    it("should root Docker legacy lookup in /var/mux, not ~/.xum", () => {
      const result = getLegacyPlanFilePath("a1b2c3d4e5", "/var/mux");
      expect(result).toBe("/var/mux/plans/a1b2c3d4e5.md");
      expect(result).not.toContain("~/.xum");
    });
  });
});
