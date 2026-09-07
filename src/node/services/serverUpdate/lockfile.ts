import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as jsonc from "jsonc-parser";
import YAML from "yaml";
import { z } from "zod";
import {
  SERVER_UPDATE_LOCKFILES,
  SERVER_UPDATE_VERIFY_CONCURRENCY,
} from "@/constants/serverUpdate";
import { isExactVersion, type InstallLayout } from "./installLayout";
import { fetchPublishedDigests, type RegistryRequest } from "./registry";

/**
 * One package a manager's lockfile records, before any trust decision. `name` is the name the
 * dependent requested, never one the served metadata supplied: redirected metadata can call a
 * dependency anything and point it at any published tarball, so a manifest-supplied name would let
 * the attacker choose which registry digest the entry is compared against. Parsers therefore
 * reject aliases (a package installed under another name) outright; the release has none.
 */
interface LockedPackage {
  name: string;
  version: string;
  integrity?: string;
  /** Explicit location (URL or local path); absent when derived from the configured registry. */
  resolved?: string;
  /** The top-level install of the release tarball, identified by its lockfile key. */
  root: boolean;
}

/** Splits `name@resolution`; a scoped name keeps its leading `@`. */
function splitSpec(spec: string): [name: string, resolution: string] {
  const at = spec.lastIndexOf("@");
  return at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, ""];
}

const bunMeta = z.object({});
const bunLock = z.object({
  packages: z.record(
    z.string(),
    z.union([
      // Registry releases: spec, tarball URL ("" when derived from the registry), meta, sri.
      z
        .tuple([z.string(), z.string(), bunMeta, z.string().optional()])
        .transform(([spec, registry, , integrity]) => ({ spec, registry, integrity })),
      // Every other resolution kind names its location in the spec.
      z.tuple([z.string(), bunMeta]).transform(([spec]) => ({ spec })),
    ])
  ),
});
const npmLock = z.object({
  packages: z.record(
    z.string(),
    z.object({
      // Present only when the installed package's name differs from its folder.
      name: z.string().optional(),
      version: z.string().optional(),
      resolved: z.string().optional(),
      integrity: z.string().optional(),
    })
  ),
});
// Dependency edges: `requested-name: version(peers)` when the package resolved under its own
// name, `requested-name: name@version` (v9) or `/name@version` (v6) when it did not.
const pnpmEdges = z.record(z.string(), z.string()).optional();
const pnpmLock = z.object({
  packages: z.record(
    z.string(),
    z.object({
      version: z.string().optional(),
      resolution: z.object({ integrity: z.string().optional(), tarball: z.string().optional() }),
      dependencies: pnpmEdges,
      optionalDependencies: pnpmEdges,
    })
  ),
  snapshots: z
    .record(z.string(), z.object({ dependencies: pnpmEdges, optionalDependencies: pnpmEdges }))
    .optional(),
});

const lockfileParsers: Record<InstallLayout["packageManager"], (raw: string) => LockedPackage[]> = {
  // A bun spec names the package bun asked the registry for (the alias target for an alias),
  // never the name the served metadata supplied.
  bun: (raw) =>
    Object.entries(bunLock.parse(jsonc.parse(raw)).packages).map(([key, entry]): LockedPackage => {
      const [name, resolution] = splitSpec(entry.spec);
      const root = key === "@coder/xum";
      if (!("registry" in entry)) return { name, version: "", resolved: resolution, root };
      return {
        name,
        version: resolution,
        integrity: entry.integrity,
        resolved: entry.registry || undefined,
        root,
      };
    }),
  npm: (raw) =>
    Object.entries(npmLock.parse(JSON.parse(raw)).packages).flatMap(([key, pkg]) => {
      if (key === "") return [];
      const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
      if (pkg.name !== undefined && pkg.name !== name)
        throw new Error(`Dependency ${name} was installed under another package's name`);
      return [
        {
          name,
          version: pkg.version ?? "",
          integrity: pkg.integrity,
          resolved: pkg.resolved,
          root: key === "node_modules/@coder/xum",
        },
      ];
    }),
  pnpm: (raw) => {
    const lock = pnpmLock.parse(YAML.parse(raw));
    // Package keys carry the name the metadata supplied, so the edges must prove it is also the
    // requested one: only a plain version may appear on the right-hand side.
    for (const entry of [...Object.values(lock.packages), ...Object.values(lock.snapshots ?? {})])
      for (const [requested, ref] of Object.entries({
        ...entry.dependencies,
        ...entry.optionalDependencies,
      }))
        if (!isExactVersion(ref.replace(/\(.*$/, "")))
          throw new Error(`Dependency ${requested} was installed under another package's name`);
    return Object.entries(lock.packages).map(([key, pkg]) => {
      // v6 keys are `/name@version(peer@x)`; v9 drops the slash. A local tarball entry carries its
      // real version separately.
      const [name, resolution] = splitSpec(key.replace(/^\//, "").replace(/\(.*$/, ""));
      return {
        name,
        version: pkg.version ?? resolution,
        integrity: pkg.resolution.integrity,
        resolved: pkg.resolution.tarball,
        root: name === "@coder/xum" && resolution.startsWith("file:"),
      };
    });
  },
};

const isLocal = (resolved: string) =>
  /^(file:|\.\.?\/)/.test(resolved) || path.isAbsolute(resolved);

/**
 * Anchors the staged dependency tree to the configured registry. Managers follow redirects (also
 * to plaintext) while resolving dependencies and record whatever digest they were served, so the
 * lockfile alone proves nothing; every recorded digest must be one the registry publishes over
 * verified HTTPS without redirects. Managers do verify every tarball against its recorded digest,
 * which makes that digest the only link that needs anchoring. Returns the verified count.
 */
export async function verifyStagedDependencies(
  layout: InstallLayout,
  dir: string,
  request: RegistryRequest = fetch,
  signal?: AbortSignal
): Promise<number> {
  const lockfile = path.join(dir, SERVER_UPDATE_LOCKFILES[layout.packageManager]);
  const queue: Array<{ name: string; version: string; integrity: string }> = [];
  for (const pkg of lockfileParsers[layout.packageManager](await fs.readFile(lockfile, "utf8"))) {
    if (pkg.resolved !== undefined && isLocal(pkg.resolved)) {
      // The release tarball itself was digest-checked before the install.
      if (pkg.root) continue;
      throw new Error(`Dependency ${pkg.name} was installed from a local path`);
    }
    if (pkg.resolved !== undefined && !pkg.resolved.startsWith("https://"))
      throw new Error(`Dependency ${pkg.name} was not resolved over HTTPS`);
    if (!isExactVersion(pkg.version) || !pkg.integrity)
      throw new Error(`Dependency ${pkg.name} is not a digest-pinned registry release`);
    queue.push({ name: pkg.name, version: pkg.version, integrity: pkg.integrity });
  }
  const total = queue.length;
  const worker = async () => {
    for (let pkg = queue.shift(); pkg; pkg = queue.shift()) {
      try {
        const published = await fetchPublishedDigests(
          layout.registry,
          pkg.name,
          pkg.version,
          request,
          signal
        );
        // A manager accepts a tarball matching any recorded digest of its strongest algorithm, so
        // one published digest cannot vouch for a foreign one listed beside it.
        const recorded = pkg.integrity.trim().split(/\s+/);
        if (!recorded.every((sri) => published.includes(sri)))
          throw new Error(
            `Registry digest for ${pkg.name}@${pkg.version} differs from the staged lockfile`
          );
      } catch (error) {
        queue.length = 0;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: SERVER_UPDATE_VERIFY_CONCURRENCY }, worker));
  return total;
}
