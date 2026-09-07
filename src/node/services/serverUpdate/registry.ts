import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { EnvHttpProxyAgent, type Dispatcher } from "undici";
import { z } from "zod";
import {
  SERVER_UPDATE_CHECK_TIMEOUT_MS,
  SERVER_UPDATE_INSTALL_TIMEOUT_MS,
} from "@/constants/serverUpdate";
import { isExactVersion } from "./installLayout";

export type RegistryRequest = (url: string, options: RequestInit) => Promise<Response>;

export interface ReleaseArtifact {
  version: string;
  tarball: string;
  integrity: string;
}

// Built on first use: a malformed proxy variable must surface as a check error, not crash startup.
let dispatcher: Dispatcher | undefined;

function requestOptions(signal: AbortSignal): RequestInit & { dispatcher: Dispatcher } {
  // NODE_TLS_REJECT_UNAUTHORIZED=0 in the server's environment would otherwise let an on-path
  // registry rewrite the tags; explicit options win over that process-wide default, for direct
  // (connect) and proxied (requestTls) connections alike. Redirects are refused because a
  // redirect target may leave HTTPS; the configured registry must answer every request itself.
  dispatcher ??= new EnvHttpProxyAgent({
    connect: { rejectUnauthorized: true },
    requestTls: { rejectUnauthorized: true },
  });
  return { dispatcher, redirect: "error", signal };
}

const deadline = (ms: number, signal?: AbortSignal) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

async function fetchJson(
  request: RegistryRequest,
  url: string,
  signal?: AbortSignal
): Promise<unknown> {
  const response = await request(
    url,
    requestOptions(deadline(SERVER_UPDATE_CHECK_TIMEOUT_MS, signal))
  );
  if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`);
  return response.json();
}

export async function fetchDistTags(
  registry: string,
  request: RegistryRequest = fetch
): Promise<{ latest?: string; next?: string }> {
  const tags = await fetchJson(request, `${registry}/-/package/@coder%2Fxum/dist-tags`);
  if (!tags || typeof tags !== "object") throw new Error("Invalid registry dist-tags response");
  return {
    latest: "latest" in tags && isExactVersion(tags.latest) ? tags.latest : undefined,
    next: "next" in tags && isExactVersion(tags.next) ? tags.next : undefined,
  };
}

const manifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  dist: z.object({
    tarball: z.string(),
    integrity: z
      .string()
      .regex(/^sha512-[A-Za-z0-9+/]{86}==$/)
      .optional(),
    shasum: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
  }),
});

async function fetchManifest(
  registry: string,
  name: string,
  version: string,
  request: RegistryRequest,
  signal?: AbortSignal
) {
  if (!isExactVersion(version)) throw new Error("Invalid update version");
  const manifest = manifestSchema.safeParse(
    await fetchJson(request, `${registry}/${name.replace("/", "%2F")}/${version}`, signal)
  );
  if (!manifest.success || manifest.data.name !== name || manifest.data.version !== version)
    throw new Error(`Registry manifest for ${name}@${version} is invalid`);
  return manifest.data.dist;
}

export async function fetchArtifact(
  registry: string,
  version: string,
  request: RegistryRequest = fetch,
  signal?: AbortSignal
): Promise<ReleaseArtifact> {
  const dist = await fetchManifest(registry, "@coder/xum", version, request, signal);
  if (!dist.integrity)
    throw new Error("Registry manifest has no verifiable tarball for the requested version");
  const tarball = new URL(dist.tarball);
  if (tarball.protocol !== "https:" || tarball.username || tarball.password)
    throw new Error("Registry tarball URL is not HTTPS");
  return { version, tarball: tarball.href, integrity: dist.integrity };
}

/** The SRI digests the registry publishes for a release, including the legacy sha1 shasum. */
export async function fetchPublishedDigests(
  registry: string,
  name: string,
  version: string,
  request: RegistryRequest = fetch,
  signal?: AbortSignal
): Promise<string[]> {
  const dist = await fetchManifest(registry, name, version, request, signal);
  const digests = dist.integrity ? [dist.integrity] : [];
  if (dist.shasum) digests.push(`sha1-${Buffer.from(dist.shasum, "hex").toString("base64")}`);
  return digests;
}

/** Streams the tarball to `dest` and keeps it only when it matches the manifest's sha512 digest. */
export async function downloadArtifact(
  artifact: ReleaseArtifact,
  dest: string,
  request: RegistryRequest = fetch,
  signal?: AbortSignal
): Promise<void> {
  const response = await request(
    artifact.tarball,
    requestOptions(deadline(SERVER_UPDATE_INSTALL_TIMEOUT_MS, signal))
  );
  if (!response.ok || !response.body) throw new Error(`Registry returned HTTP ${response.status}`);
  const hash = createHash("sha512");
  const file = await fs.open(dest, "wx");
  try {
    const reader = response.body.getReader();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      hash.update(chunk.value);
      // A write may persist fewer bytes than offered; the digest must cover what reached disk.
      for (let offset = 0; offset < chunk.value.length; )
        offset += (await file.write(chunk.value, offset)).bytesWritten;
    }
  } finally {
    await file.close();
  }
  if (`sha512-${hash.digest("base64")}` !== artifact.integrity) {
    await fs.rm(dest, { force: true });
    throw new Error("Downloaded update does not match the registry digest");
  }
}
