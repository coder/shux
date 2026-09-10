/**
 * Platform-aware path utilities for main process (Node) only.
 * Safe to use Node globals like process and environment variables.
 *
 * NOTE: Renderer should import from './paths' (renderer-safe subset)
 * and use IPC for any operations that require environment access.
 */

import {
  getLocalProductHomeTildeSuffix,
  resolveXumEnvironmentValue,
} from "@/common/compat/legacyMux";
import { platform, env } from "node:process";

export interface PathComponents {
  root: string; // "/" on Unix, "C:\\" on Windows, "" for relative paths
  segments: string[]; // Directory segments (excluding basename)
  basename: string; // Final path component
}

/**
 * Determine if current platform is Windows (main process)
 */
function isWindowsPlatform(): boolean {
  return platform === "win32";
}

function getSeparator(): string {
  return isWindowsPlatform() ? "\\" : "/";
}

function getHomeDir(): string {
  if (isWindowsPlatform()) {
    return env.USERPROFILE ?? "";
  }

  return env.HOME ?? "";
}

/**
 * OS-aware path utilities that handle Windows and Unix paths correctly.
 * Main-process version includes environment-aware helpers.
 */
export class PlatformPaths {
  /**
   * Get the appropriate path separator for the current platform
   */
  static get separator(): string {
    return getSeparator();
  }

  /**
   * Extract basename from path (OS-aware)
   */
  static basename(filePath: string): string {
    if (!filePath || typeof filePath !== "string") {
      return filePath;
    }

    const lastSlash = isWindowsPlatform()
      ? Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"))
      : filePath.lastIndexOf("/");
    if (lastSlash === -1) {
      return filePath;
    }
    return filePath.slice(lastSlash + 1);
  }

  /**
   * Split path into components (OS-aware)
   */
  static parse(filePath: string): PathComponents {
    if (!filePath || typeof filePath !== "string") {
      return { root: "", segments: [], basename: filePath };
    }

    const original = filePath;
    let root = "";
    let dir = "";
    let base = "";

    // Determine basename and directory
    const lastSlash = isWindowsPlatform()
      ? Math.max(original.lastIndexOf("/"), original.lastIndexOf("\\"))
      : original.lastIndexOf("/");
    if (lastSlash === -1) {
      base = original;
      dir = "";
    } else {
      base = original.slice(lastSlash + 1);
      dir = original.slice(0, lastSlash);
    }

    // Determine root
    if (isWindowsPlatform()) {
      const driveMatch = /^[A-Za-z]:[\\/]/.exec(original);
      if (driveMatch) {
        root = driveMatch[0];
        // Ensure dir does not include root
        if (dir.startsWith(root)) {
          dir = dir.slice(root.length);
        }
      } else if (original.startsWith("\\\\")) {
        // UNC paths - treat leading double-backslash as root
        root = "\\\\";
        if (dir.startsWith(root)) {
          dir = dir.slice(root.length);
        }
      }
      // Also treat Unix-style absolute paths as absolute even on Windows
      if (!root && original.startsWith("/")) {
        root = "/";
        if (dir.startsWith(root)) {
          dir = dir.slice(root.length);
        }
      }
    } else if (original.startsWith("/")) {
      root = "/";
      if (dir.startsWith(root)) {
        dir = dir.slice(root.length);
      }
    }

    const separatorRegex = isWindowsPlatform() ? /[\\/]+/ : /\/+/;
    const segments = dir ? dir.split(separatorRegex).filter(Boolean) : [];

    return {
      root,
      segments,
      basename: base,
    };
  }

  /**
   * Format path for display with fish-style abbreviation (OS-aware)
   * Abbreviates all directory components except the last one to their first letter
   */
  static abbreviate(filePath: string): string {
    if (!filePath || typeof filePath !== "string") {
      return filePath;
    }

    const { root, segments, basename } = this.parse(filePath);

    // Abbreviate all segments to first character
    const abbreviated = segments.map((seg) => (seg.length > 0 ? seg[0] : seg));

    // Reconstruct path - handle root separately to avoid double separator
    if (!root && abbreviated.length === 0) {
      return basename;
    }

    const sep = isWindowsPlatform() ? (filePath.includes("\\") ? "\\" : "/") : "/";
    const joined = [...abbreviated, basename].filter(Boolean).join(sep);
    if (!root) {
      return joined;
    }
    const rootEndsWithSep = root.endsWith("\\") || root.endsWith("/");
    return rootEndsWithSep ? root + joined : root + sep + joined;
  }

  /**
   * Split an abbreviated path into directory path and basename
   */
  static splitAbbreviated(filePath: string): { dirPath: string; basename: string } {
    if (!filePath || typeof filePath !== "string") {
      return { dirPath: "", basename: filePath };
    }

    const sep = isWindowsPlatform() ? (filePath.includes("\\") ? "\\" : "/") : "/";
    const lastSlash = filePath.lastIndexOf(sep);
    if (lastSlash === -1) {
      return { dirPath: "", basename: filePath };
    }
    return {
      dirPath: filePath.slice(0, lastSlash + 1),
      basename: filePath.slice(lastSlash + 1),
    };
  }

  /**
   * Format home directory path for display (shows ~ on Unix, full path on Windows)
   */
  static formatHome(filePath: string): string {
    if (!filePath || typeof filePath !== "string") {
      return filePath;
    }

    const home = getHomeDir();
    if (!home) {
      return filePath;
    }

    // Replace home with tilde on all platforms for display purposes
    if (filePath.startsWith(home)) {
      return filePath.replace(home, "~");
    }

    return filePath;
  }

  /**
   * Expand user home in path (cross-platform)
   * Handles ~ on Unix and %USERPROFILE% on Windows
   */
  static expandHome(filePath: string): string {
    if (!filePath || typeof filePath !== "string") {
      return filePath;
    }

    // Isolated environments can place all state under XUM_ROOT. Legacy MUX_ROOT and
    // ~/.mux / ~/.cmux paths resolve through the same boundary so older configs remain portable.
    const xumRoot = resolveXumEnvironmentValue("ROOT", env);
    if (xumRoot) {
      const productHomeSuffix = getLocalProductHomeTildeSuffix(filePath);
      if (productHomeSuffix !== undefined) {
        const normalizedXumRoot = xumRoot.replace(/[\\/]+$/g, "");
        const sep = getSeparator();
        const normalizedRest = productHomeSuffix.replace(/[\\/]+/g, sep);
        return normalizedXumRoot + (normalizedRest ? sep + normalizedRest : "");
      }
    }

    if (filePath === "~") {
      return getHomeDir() || filePath;
    }

    // Handle Unix-style ~/path
    if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
      const home = getHomeDir();
      if (!home) return filePath;
      const sep = getSeparator();
      const rest = filePath.slice(2);
      return home + (rest ? sep + rest.replace(/[\\/]+/g, sep) : "");
    }

    // Handle Windows %USERPROFILE% environment variable
    if (isWindowsPlatform() && filePath.includes("%USERPROFILE%")) {
      const home = getHomeDir();
      if (!home) return filePath;
      return filePath.replace(/%USERPROFILE%/g, home);
    }

    return filePath;
  }

  /**
   * Get project name from path (OS-aware)
   * Extracts the final directory name from a project path
   */
  static getProjectName(projectPath: string): string {
    return this.basename(projectPath) || "unknown";
  }
}
