import { describe, test, expect } from "bun:test";
import { PlatformPaths } from "./paths.main";
import { toPosixPath, toWindowsPath } from "./paths";
import * as os from "os";
import * as path from "path";

describe("PlatformPaths", () => {
  describe("basename", () => {
    test("extracts basename from path using current platform", () => {
      expect(PlatformPaths.basename("/home/user/project")).toBe("project");
      expect(PlatformPaths.basename("/home/user/project/file.txt")).toBe("file.txt");
    });

    test("handles edge cases", () => {
      expect(PlatformPaths.basename("")).toBe("");
      expect(PlatformPaths.basename("project")).toBe("project");
    });
  });

  describe("parse", () => {
    test("parses absolute path on current platform", () => {
      const testPath = path.join("/", "home", "user", "projects", "mux");
      const result = PlatformPaths.parse(testPath);
      expect(result.segments).toContain("home");
      expect(result.segments).toContain("user");
      expect(result.segments).toContain("projects");
      expect(result.basename).toBe("mux");
    });

    test("parses relative path", () => {
      const result = PlatformPaths.parse("src/utils/paths.ts");
      expect(result.root).toBe("");
      expect(result.basename).toBe("paths.ts");
    });

    test("handles edge cases", () => {
      expect(PlatformPaths.parse("")).toEqual({ root: "", segments: [], basename: "" });
      expect(PlatformPaths.parse("file.txt").basename).toBe("file.txt");
    });
  });

  describe("abbreviate", () => {
    test("abbreviates path", () => {
      const testPath = path.join("/", "home", "user", "Projects", "coder", "mux");
      const result = PlatformPaths.abbreviate(testPath);

      // Should end with the full basename
      expect(result.endsWith("mux")).toBe(true);

      // Should be shorter than original (segments abbreviated)
      expect(result.length).toBeLessThan(testPath.length);
    });

    test("handles short paths", () => {
      const testPath = path.join("/", "home");
      const result = PlatformPaths.abbreviate(testPath);
      // Short paths should not be abbreviated much
      expect(result).toContain("home");
    });

    test("handles empty input", () => {
      expect(PlatformPaths.abbreviate("")).toBe("");
    });
  });

  describe("splitAbbreviated", () => {
    test("splits abbreviated path", () => {
      const testPath = path.join("/", "h", "u", "P", "c", "mux");
      const result = PlatformPaths.splitAbbreviated(testPath);
      expect(result.basename).toBe("mux");
      expect(result.dirPath.endsWith(path.sep)).toBe(true);
    });

    test("handles path without directory", () => {
      const result = PlatformPaths.splitAbbreviated("file.txt");
      expect(result.dirPath).toBe("");
      expect(result.basename).toBe("file.txt");
    });
  });

  describe("formatHome", () => {
    test("replaces home directory with tilde", () => {
      const home = os.homedir();
      const testPath = path.join(home, "projects", "mux");
      const result = PlatformPaths.formatHome(testPath);

      const sep = PlatformPaths.separator;
      expect(result).toBe(`~${sep}projects${sep}mux`);
    });

    test("leaves non-home paths unchanged", () => {
      const result = PlatformPaths.formatHome("/tmp/test");
      expect(result).toBe("/tmp/test");
    });
  });

  describe("expandHome", () => {
    test("expands tilde to home directory", () => {
      const home = os.homedir();
      expect(PlatformPaths.expandHome("~")).toBe(home);
    });

    test("expands tilde with path", () => {
      const home = os.homedir();
      const sep = path.sep;
      const result = PlatformPaths.expandHome(`~${sep}projects${sep}mux`);
      expect(result).toBe(path.join(home, "projects", "mux"));
    });

    test("leaves absolute paths unchanged", () => {
      const testPath = path.join("/", "home", "user", "project");
      expect(PlatformPaths.expandHome(testPath)).toBe(testPath);
    });
    test("expands canonical and legacy home paths to XUM_ROOT", () => {
      const originalXumRoot = process.env.XUM_ROOT;
      const originalMuxRoot = process.env.MUX_ROOT;
      const testXumRoot = path.join(os.tmpdir(), "xum-root-test");
      process.env.XUM_ROOT = testXumRoot;
      delete process.env.MUX_ROOT;

      try {
        const sep = path.sep;
        for (const directory of [".xum", ".mux", ".cmux"]) {
          const xumPath = `~${sep}${directory}${sep}src${sep}project`;
          expect(PlatformPaths.expandHome(xumPath)).toBe(path.join(testXumRoot, "src", "project"));
          expect(PlatformPaths.expandHome(`~${sep}${directory}`)).toBe(testXumRoot);
        }

        // Other ~ paths should still resolve to the actual OS home directory.
        const home = os.homedir();
        const homePath = `~${sep}projects${sep}xum`;
        expect(PlatformPaths.expandHome(homePath)).toBe(path.join(home, "projects", "xum"));
      } finally {
        if (originalXumRoot === undefined) delete process.env.XUM_ROOT;
        else process.env.XUM_ROOT = originalXumRoot;
        if (originalMuxRoot === undefined) delete process.env.MUX_ROOT;
        else process.env.MUX_ROOT = originalMuxRoot;
      }
    });

    test("accepts MUX_ROOT when XUM_ROOT is not set", () => {
      const originalXumRoot = process.env.XUM_ROOT;
      const originalMuxRoot = process.env.MUX_ROOT;
      const testLegacyRoot = path.join(os.tmpdir(), "mux-root-test");
      delete process.env.XUM_ROOT;
      process.env.MUX_ROOT = testLegacyRoot;

      try {
        expect(PlatformPaths.expandHome("~/.xum/src/project")).toBe(
          path.join(testLegacyRoot, "src", "project")
        );
        expect(PlatformPaths.expandHome("~/.cmux/src/project")).toBe(
          path.join(testLegacyRoot, "src", "project")
        );
      } finally {
        if (originalXumRoot === undefined) delete process.env.XUM_ROOT;
        else process.env.XUM_ROOT = originalXumRoot;
        if (originalMuxRoot === undefined) delete process.env.MUX_ROOT;
        else process.env.MUX_ROOT = originalMuxRoot;
      }
    });

    test("leaves product-home tilde paths on OS home when no explicit root is set", () => {
      const originalXumRoot = process.env.XUM_ROOT;
      const originalMuxRoot = process.env.MUX_ROOT;
      delete process.env.XUM_ROOT;
      delete process.env.MUX_ROOT;

      try {
        expect(PlatformPaths.expandHome("~/.cmux/src/project")).toBe(
          path.join(os.homedir(), ".cmux", "src", "project")
        );
      } finally {
        if (originalXumRoot === undefined) delete process.env.XUM_ROOT;
        else process.env.XUM_ROOT = originalXumRoot;
        if (originalMuxRoot === undefined) delete process.env.MUX_ROOT;
        else process.env.MUX_ROOT = originalMuxRoot;
      }
    });

    test("handles empty input", () => {
      expect(PlatformPaths.expandHome("")).toBe("");
    });
  });

  describe("getProjectName", () => {
    test("extracts project name from path", () => {
      const testPath = path.join("/", "home", "user", "projects", "mux");
      expect(PlatformPaths.getProjectName(testPath)).toBe("mux");
    });

    test("handles relative paths", () => {
      expect(PlatformPaths.getProjectName("projects/mux")).toBe("mux");
    });

    test("returns 'unknown' for empty path", () => {
      expect(PlatformPaths.getProjectName("")).toBe("unknown");
    });
  });

  describe("separator", () => {
    test("returns correct separator for platform", () => {
      const sep = PlatformPaths.separator;
      // Should match the current platform's separator
      expect(sep).toBe(path.sep);
    });
  });
});

describe("toPosixPath", () => {
  describe("on non-Windows platforms", () => {
    test("returns POSIX paths unchanged", () => {
      if (process.platform !== "win32") {
        expect(toPosixPath("/home/user/project")).toBe("/home/user/project");
        expect(toPosixPath("/tmp/mux-bashes")).toBe("/tmp/mux-bashes");
      }
    });

    test("returns paths with spaces unchanged", () => {
      if (process.platform !== "win32") {
        expect(toPosixPath("/home/user/my project")).toBe("/home/user/my project");
      }
    });

    test("returns relative paths unchanged", () => {
      if (process.platform !== "win32") {
        expect(toPosixPath("relative/path/file.txt")).toBe("relative/path/file.txt");
      }
    });

    test("returns empty string unchanged", () => {
      if (process.platform !== "win32") {
        expect(toPosixPath("")).toBe("");
      }
    });
  });

  describe("path format handling", () => {
    test("handles paths with special characters", () => {
      const input = "/path/with spaces/and-dashes/under_scores";
      const result = toPosixPath(input);
      expect(typeof result).toBe("string");
      if (process.platform !== "win32") {
        expect(result).toBe(input);
      }
    });

    test("handles deeply nested paths", () => {
      const input = "/a/b/c/d/e/f/g/h/i/j/file.txt";
      const result = toPosixPath(input);
      expect(typeof result).toBe("string");
      if (process.platform !== "win32") {
        expect(result).toBe(input);
      }
    });
  });

  // Windows-specific behavior documentation
  // These tests document expected behavior but can only truly verify on Windows CI
  describe("Windows behavior (documented)", () => {
    test("converts Windows drive paths to POSIX format on Windows", () => {
      // On Windows with Git Bash/MSYS2, cygpath converts:
      //   "C:\\Users\\test" → "/c/Users/test"
      //   "C:\\Program Files\\Git" → "/c/Program Files/Git"
      //   "D:\\Projects\\mux" → "/d/Projects/mux"
      //
      // On non-Windows, this is a no-op (returns input unchanged)
      if (process.platform === "win32") {
        // Real Windows test - only runs on Windows CI
        const result = toPosixPath("C:\\Users\\test");
        expect(result).toMatch(/^\/c\/Users\/test$/i);
      }
    });
  });
});

describe("toWindowsPath", () => {
  test("converts MSYS drive-letter path to Windows format", () => {
    expect(toWindowsPath("/c/Users/me/coder.exe")).toBe("C:\\Users\\me\\coder.exe");
  });

  test("uppercases the drive letter", () => {
    expect(toWindowsPath("/d/Program Files/Coder/coder.exe")).toBe(
      "D:\\Program Files\\Coder\\coder.exe"
    );
  });

  test("returns non-MSYS paths unchanged", () => {
    expect(toWindowsPath("/usr/local/bin/coder")).toBe("/usr/local/bin/coder");
    expect(toWindowsPath("C:\\Users\\me\\coder.exe")).toBe("C:\\Users\\me\\coder.exe");
    expect(toWindowsPath("coder")).toBe("coder");
  });

  test("handles root of drive", () => {
    expect(toWindowsPath("/c/coder.exe")).toBe("C:\\coder.exe");
  });
});
