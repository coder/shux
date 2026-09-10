import { SUPPORTED_XUM_PROTOCOL_SCHEMES } from "@/common/compat/legacyMux";
import type { DeepLinkPayload } from "@/common/types/deepLink";

const SUPPORTED_PROTOCOLS = new Set(SUPPORTED_XUM_PROTOCOL_SCHEMES.map((scheme) => `${scheme}:`));

function getNonEmptySearchParam(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  if (!value) return undefined;
  return value;
}

/**
 * Parse the canonical xum:// scheme or legacy mux:// alias into one typed payload.
 * Currently supported route: xum://chat/new
 */
export function parseXumDeepLink(raw: string): DeepLinkPayload | null {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
    return null;
  }

  // Be forgiving: some callers may include a trailing slash.
  const normalizedPathname = url.pathname.replace(/\/+$/, "");

  if (url.hostname !== "chat" || normalizedPathname !== "/new") {
    return null;
  }

  const project = getNonEmptySearchParam(url, "project");
  const projectPath = getNonEmptySearchParam(url, "projectPath");
  const projectId = getNonEmptySearchParam(url, "projectId");
  const prompt = getNonEmptySearchParam(url, "prompt");
  return {
    type: "new_chat",
    ...(project ? { project } : {}),
    ...(projectPath ? { projectPath } : {}),
    ...(projectId ? { projectId } : {}),
    ...(prompt ? { prompt } : {}),
  };
}

/**
 * Normalize project paths for cross-source comparison (deep-link payloads, route params, config keys).
 *
 * We trim whitespace/trailing separators everywhere and only fold case on Windows.
 */
export function normalizeProjectPathForComparison(projectPath: string, platform?: string): string {
  let normalized = projectPath.trim();

  // Be forgiving: xum:// and legacy mux:// links may include trailing path separators.
  normalized = normalized.replace(/[\\/]+$/, "");

  if (platform === "win32") {
    normalized = normalized.toLowerCase();
  }

  return normalized;
}

function getLastPathSegment(projectPath: string): string {
  const normalized = projectPath.trim().replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? normalized;
}

/**
 * Resolve a configured project path from a human-friendly deep-link `project` query.
 *
 * Matching rules:
 * - Compare against the final path segment (e.g. /Users/me/repos/mux -> "mux")
 * - Prefer exact matches (case-insensitive)
 * - Otherwise, prefer substring matches (case-insensitive), picking the shortest
 *   name as the "closest" match.
 */
export function resolveProjectPathFromProjectQuery(
  projectPaths: Iterable<string>,
  projectQuery: string
): string | null {
  const query = getLastPathSegment(projectQuery).trim().toLowerCase();
  if (query.length === 0) return null;

  for (const projectPath of projectPaths) {
    const candidate = getLastPathSegment(projectPath).toLowerCase();
    if (candidate === query) {
      return projectPath;
    }
  }

  let bestProjectPath: string | null = null;
  let bestCandidateLength = Number.POSITIVE_INFINITY;

  for (const projectPath of projectPaths) {
    const candidate = getLastPathSegment(projectPath).toLowerCase();
    if (!candidate.includes(query)) continue;

    if (
      bestProjectPath === null ||
      candidate.length < bestCandidateLength ||
      (candidate.length === bestCandidateLength && projectPath < bestProjectPath)
    ) {
      bestProjectPath = projectPath;
      bestCandidateLength = candidate.length;
    }
  }

  return bestProjectPath;
}
