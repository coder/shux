import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";
import { createOrpcServer, type OrpcServer, type OrpcServerOptions } from "@/node/orpc/server";
import { ServerLockfile } from "./serverLockfile";
import type { ORPCContext } from "@/node/orpc/context";
import * as fs from "fs/promises";
import * as path from "path";
import { log } from "./log";
import * as os from "os";
import * as childProcess from "node:child_process";
import { VERSION } from "@/version";
import { buildMuxMdnsServiceOptions, MdnsAdvertiserService } from "./mdnsAdvertiserService";
import type { AppRouter } from "@/node/orpc/router";

export interface ServerInfo {
  /** Base URL that is always connectable from the local machine (loopback for wildcard binds). */
  baseUrl: string;
  /** Auth token required for HTTP/WS API access. */
  token: string;
  /** The host/interface the server is actually bound to (e.g. "127.0.0.1" or "0.0.0.0"). */
  bindHost: string;
  /** The port the server is listening on. */
  port: number;
  /** Additional base URLs that may be reachable from other devices (LAN/VPN). */
  networkBaseUrls: string[];
}

export interface StartServerOptions {
  /** Path to xum home directory (for lockfile) */
  xumHome: string;
  /** oRPC context with services */
  context: ORPCContext;
  /** Host/interface to bind to (default: "127.0.0.1") */
  host?: string;
  /** Auth token for the server */
  authToken: string;
  /** Port to bind to (0 = random) */
  port?: number;
  /** Optional pre-created router (if not provided, creates router(authToken)) */
  router?: AppRouter;
  /** Whether to serve static files */
  serveStatic?: boolean;
  /**
   * Allow HTTPS browser origins when a TLS-terminating proxy forwards
   * X-Forwarded-Proto=http to mux. If omitted, falls back to
   * MUX_SERVER_ALLOW_HTTP_ORIGIN for non-CLI server starts.
   */
  allowHttpOrigin?: boolean;
}

type NetworkInterfaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

export interface TailscaleBindHost {
  interfaceName: string;
  address: string;
  family: "IPv4" | "IPv6";
}

const TAILSCALE_IP_COMMAND_TIMEOUT_MS = 1_000;

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();

  // IPv4 loopback range (RFC 1122): 127.0.0.0/8
  if (normalized.startsWith("127.")) {
    return true;
  }

  return normalized === "localhost" || normalized === "::1";
}

function formatHostForUrl(host: string): string {
  const trimmed = host.trim();

  // IPv6 URLs must be bracketed: http://[::1]:1234
  if (trimmed.includes(":")) {
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      return trimmed;
    }

    return `[${trimmed}]`;
  }

  return trimmed;
}

function buildHttpBaseUrl(host: string, port: number): string {
  return `http://${formatHostForUrl(host)}:${port}`;
}

function resolveAllowHttpOriginEnvFlag(): boolean {
  const raw = resolveXumEnvironmentValue("SERVER_ALLOW_HTTP_ORIGIN", process.env);
  if (!raw) {
    return false;
  }

  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

function getNonInternalInterfaceAddresses(
  networkInterfaces: NetworkInterfaces,
  family: "IPv4" | "IPv6"
): string[] {
  const addresses: string[] = [];
  const emptyInfos: os.NetworkInterfaceInfo[] = [];

  for (const name of Object.keys(networkInterfaces)) {
    const infos: os.NetworkInterfaceInfo[] = networkInterfaces[name] ?? emptyInfos;
    for (const info of infos) {
      const infoFamily = info.family;

      if (infoFamily !== family) {
        continue;
      }

      if (info.internal) {
        continue;
      }

      const address = info.address;

      // Filter out link-local addresses (they are rarely what users want to copy/paste).
      if (family === "IPv4" && address.startsWith("169.254.")) {
        continue;
      }
      if (family === "IPv6" && address.toLowerCase().startsWith("fe80:")) {
        continue;
      }

      addresses.push(address);
    }
  }

  return Array.from(new Set(addresses)).sort();
}

function parseIpv4Octets(address: string): [number, number, number, number] | null {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }

  if (parts.some((part) => !/^\d+$/.test(part))) {
    return null;
  }

  const octets: [number, number, number, number] = [
    Number.parseInt(parts[0] ?? "", 10),
    Number.parseInt(parts[1] ?? "", 10),
    Number.parseInt(parts[2] ?? "", 10),
    Number.parseInt(parts[3] ?? "", 10),
  ];
  if (octets.some((octet) => octet < 0 || octet > 255)) {
    return null;
  }

  return octets;
}

function isTailscaleIpv4Address(address: string): boolean {
  const octets = parseIpv4Octets(address);
  if (!octets) {
    return false;
  }

  // Tailscale IPv4 addresses live in 100.64.0.0/10. This lets macOS utun devices show
  // as a Tailscale choice even when the OS exposes only a generic interface name.
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

function isTailscaleIpv6Address(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === "fd7a:115c:a1e0::" || normalized.startsWith("fd7a:115c:a1e0:");
}

function isTailscaleInterfaceName(interfaceName: string): boolean {
  return interfaceName.toLowerCase().includes("tailscale");
}

function isLinkLocalAddress(address: string, family: "IPv4" | "IPv6"): boolean {
  if (family === "IPv4") {
    return address.startsWith("169.254.");
  }

  return address.toLowerCase().startsWith("fe80:");
}

function getTailscaleCliAddresses(): ReadonlySet<string> {
  try {
    const output = childProcess.execFileSync("tailscale", ["ip"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: TAILSCALE_IP_COMMAND_TIMEOUT_MS,
    });

    return new Set(
      output
        .split(/\s+/)
        .map((address) => address.trim())
        .filter((address) => isTailscaleIpv4Address(address) || isTailscaleIpv6Address(address))
    );
  } catch {
    return new Set();
  }
}

export function getTailscaleBindHosts(
  networkInterfaces: NetworkInterfaces = os.networkInterfaces(),
  tailscaleAddresses: ReadonlySet<string> = getTailscaleCliAddresses()
): TailscaleBindHost[] {
  const hostsByAddress = new Map<string, TailscaleBindHost>();
  const emptyInfos: os.NetworkInterfaceInfo[] = [];

  for (const interfaceName of Object.keys(networkInterfaces)) {
    const infos = networkInterfaces[interfaceName] ?? emptyInfos;
    for (const info of infos) {
      const family = info.family;
      if (family !== "IPv4" && family !== "IPv6") {
        continue;
      }

      const address = info.address.trim();
      if (!address || info.internal || isLinkLocalAddress(address, family)) {
        continue;
      }

      // A 100.64.0.0/10 address alone can be ordinary RFC6598 CGNAT, so only generic
      // interface names become Tailscale choices when the Tailscale CLI proves the address.
      if (!isTailscaleInterfaceName(interfaceName) && !tailscaleAddresses.has(address)) {
        continue;
      }

      hostsByAddress.set(`${family}:${address}`, {
        interfaceName,
        address,
        family,
      });
    }
  }

  return Array.from(hostsByAddress.values()).sort((a, b) => {
    if (a.family !== b.family) {
      return a.family === "IPv4" ? -1 : 1;
    }

    const addressComparison = a.address.localeCompare(b.address, undefined, { numeric: true });
    if (addressComparison !== 0) {
      return addressComparison;
    }

    return a.interfaceName.localeCompare(b.interfaceName, undefined, { numeric: true });
  });
}

/**
 * Compute base URLs that are reachable from other devices (LAN/VPN).
 *
 * NOTE: This is for UI/display and should not be used for lockfile discovery,
 * since lockfiles are local-machine concerns.
 */
export function computeNetworkBaseUrls(options: {
  bindHost: string;
  port: number;
  networkInterfaces?: NetworkInterfaces;
}): string[] {
  const bindHost = options.bindHost.trim();
  if (!bindHost) {
    return [];
  }

  if (isLoopbackHost(bindHost)) {
    return [];
  }

  const networkInterfaces = options.networkInterfaces ?? os.networkInterfaces();

  if (bindHost === "0.0.0.0") {
    return getNonInternalInterfaceAddresses(networkInterfaces, "IPv4").map((address) =>
      buildHttpBaseUrl(address, options.port)
    );
  }

  if (bindHost === "::") {
    return getNonInternalInterfaceAddresses(networkInterfaces, "IPv6").map((address) =>
      buildHttpBaseUrl(address, options.port)
    );
  }

  return [buildHttpBaseUrl(bindHost, options.port)];
}

export class ServerService {
  private launchProjectPath: string | null = null;
  private server: OrpcServer | null = null;
  private lockfile: ServerLockfile | null = null;
  private apiAuthToken: string | null = null;
  private serverInfo: ServerInfo | null = null;
  private readonly mdnsAdvertiser = new MdnsAdvertiserService();
  private sshHost: string | undefined = undefined;
  private shuttingDown = false;

  /**
   * Process teardown has begun. The HTTP/WS server keeps accepting connections until stopServer()
   * runs last, so the RPC layer consults this to refuse new procedure calls in the meantime.
   */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /**
   * Set the launch project path
   */
  setLaunchProject(path: string | null): void {
    this.launchProjectPath = path;
  }

  /**
   * Get the launch project path
   */
  getLaunchProject(): Promise<string | null> {
    return Promise.resolve(this.launchProjectPath);
  }

  /**
   * Set the SSH hostname for editor deep links (browser mode)
   */
  setSshHost(host: string | undefined): void {
    this.sshHost = host;
  }

  /**
   * Get the SSH hostname for editor deep links (browser mode)
   */
  getSshHost(): string | undefined {
    return this.sshHost;
  }

  /**
   * Set the auth token used for the HTTP/WS API server.
   *
   * This is injected by the desktop app on startup so the server can be restarted
   * without needing to plumb the token through every callsite.
   */
  setApiAuthToken(token: string): void {
    this.apiAuthToken = token;
  }

  /** Get the auth token used for the HTTP/WS API server (if initialized). */
  getApiAuthToken(): string | null {
    return this.apiAuthToken;
  }

  /**
   * Start the HTTP/WS API server.
   *
   * @throws Error if a server is already running (check lockfile first)
   */
  async startServer(options: StartServerOptions): Promise<ServerInfo> {
    if (this.server) {
      throw new Error("Server already running in this process");
    }

    // Create lockfile instance for checking - don't store yet
    const lockfile = new ServerLockfile(options.xumHome);

    // Check for existing server (another process)
    const existing = await lockfile.read();
    if (existing) {
      throw new Error(
        `Another xum server is already running at ${existing.baseUrl} (PID: ${existing.pid})`
      );
    }

    const bindHost =
      typeof options.host === "string" && options.host.trim() ? options.host.trim() : "127.0.0.1";

    this.apiAuthToken = options.authToken;

    // Resolve the static assets directory (dist/) that contains index.html.
    // Non-bundled (Electron): __dirname is dist/node/services/, so ../.. reaches dist/.
    // Bundled (Docker):       __dirname is dist/runtime/, so .. reaches dist/.
    const staticDirCandidates = [path.join(__dirname, "../.."), path.join(__dirname, "..")];

    let staticDir: string | undefined;
    if (options.serveStatic) {
      for (const candidate of staticDirCandidates) {
        try {
          await fs.access(path.join(candidate, "index.html"));
          staticDir = candidate;
          break;
        } catch {
          // Try the next candidate.
        }
      }

      if (!staticDir) {
        log.warn(
          `API server static UI requested, but index.html is missing near ${__dirname}. Disabling.`
        );
      }
    }
    const serveStatic = options.serveStatic === true && staticDir !== undefined;

    // Non-CLI starts (desktop/browser mode) do not parse CLI flags, so allow an
    // explicit env override for TLS-terminating proxies that rewrite forwarded proto.
    const allowHttpOrigin = options.allowHttpOrigin ?? resolveAllowHttpOriginEnvFlag();

    const serverOptions: OrpcServerOptions = {
      host: bindHost,
      port: options.port ?? 0,
      context: options.context,
      authToken: options.authToken,
      router: options.router,
      desktopBridgeServer: options.context.desktopBridgeServer,
      serveStatic,
      staticDir,
      allowHttpOrigin,
    };

    const server = await createOrpcServer(serverOptions);
    const networkBaseUrls = computeNetworkBaseUrls({ bindHost, port: server.port });

    // Acquire the lockfile - clean up server if this fails
    try {
      await lockfile.acquire(server.baseUrl, options.authToken, {
        bindHost,
        port: server.port,
        networkBaseUrls,
      });
    } catch (err) {
      await server.close();
      throw err;
    }

    // Only store references after successful acquisition - ensures stopServer
    // won't delete another process's lockfile if we failed before acquiring
    this.lockfile = lockfile;
    this.server = server;
    this.serverInfo = {
      baseUrl: server.baseUrl,
      token: options.authToken,
      bindHost,
      port: server.port,
      networkBaseUrls,
    };

    const mdnsAdvertisementEnabled = options.context.config.getMdnsAdvertisementEnabled();

    // "auto" mode: only advertise when the bind host is reachable from other devices.
    if (mdnsAdvertisementEnabled !== false && !isLoopbackHost(bindHost)) {
      const instanceName = options.context.config.getMdnsServiceName() ?? `xum-${os.hostname()}`;
      const serviceOptions = buildMuxMdnsServiceOptions({
        bindHost,
        port: server.port,
        instanceName,
        version: VERSION.git_describe,
        authRequired: options.authToken.trim().length > 0,
      });

      try {
        await this.mdnsAdvertiser.start(serviceOptions);
      } catch (err) {
        log.warn("Failed to advertise xum API server via mDNS:", err);
      }
    } else if (mdnsAdvertisementEnabled === true && isLoopbackHost(bindHost)) {
      log.warn(
        "mDNS advertisement requested, but the API server is loopback-only. " +
          "Set apiServerBindHost to 0.0.0.0 (or a LAN/Tailscale IP) to enable LAN discovery."
      );
    }

    return this.serverInfo;
  }

  /**
   * Stop the HTTP/WS API server and release the lockfile.
   */
  async stopServer(): Promise<void> {
    try {
      await this.mdnsAdvertiser.stop();
    } catch (err) {
      log.warn("Failed to stop mDNS advertiser:", err);
    }

    if (this.lockfile) {
      await this.lockfile.release();
      this.lockfile = null;
    }
    if (this.server) {
      await this.server.close();
      this.server = null;
    }
    this.serverInfo = null;
  }

  /** Return Tailscale-backed local addresses users can bind the remote-access server to. */
  getTailscaleBindHosts(): TailscaleBindHost[] {
    return getTailscaleBindHosts();
  }

  /**
   * Get information about the running server.
   * Returns null if no server is running in this process.
   */
  getServerInfo(): ServerInfo | null {
    return this.serverInfo;
  }

  /**
   * Check if a server is running in this process.
   */
  isServerRunning(): boolean {
    return this.server !== null;
  }

  /**
   * Get the path to the server lockfile (for displaying to users).
   * Returns null if no server lockfile has been acquired yet.
   */
  getLockfilePath(): string | null {
    return this.lockfile?.getLockPath() ?? null;
  }
}

type ServerSettingsContext = ORPCContext;

function getApiServerStatusSnapshot(context: ServerSettingsContext) {
  const config = context.config.loadConfigOrDefault();
  const info = context.serverService.getServerInfo();
  return {
    running: info !== null,
    baseUrl: info?.baseUrl ?? null,
    bindHost: info?.bindHost ?? null,
    port: info?.port ?? null,
    networkBaseUrls: info?.networkBaseUrls ?? [],
    tailscaleBindHosts: context.serverService.getTailscaleBindHosts(),
    token: info?.token ?? null,
    configuredBindHost: config.apiServerBindHost ?? null,
    configuredPort: config.apiServerPort ?? null,
    configuredServeWebUi: config.apiServerServeWebUi === true,
  };
}

export async function setServerSshHost(
  context: ServerSettingsContext,
  sshHost: string | null | undefined
): Promise<void> {
  context.serverService.setSshHost(sshHost ?? undefined);
  await context.config.editConfig((config) => ({ ...config, serverSshHost: sshHost ?? undefined }));
}

export function getApiServerStatus(context: ServerSettingsContext) {
  return getApiServerStatusSnapshot(context);
}

export async function setApiServerSettings(
  context: ServerSettingsContext,
  input: { bindHost?: string | null; serveWebUi?: boolean | null; port?: number | null }
) {
  const prevConfig = context.config.loadConfigOrDefault();
  const prevBindHost = prevConfig.apiServerBindHost;
  const prevServeWebUi = prevConfig.apiServerServeWebUi;
  const prevPort = prevConfig.apiServerPort;
  const wasRunning = context.serverService.isServerRunning();
  const bindHost = input.bindHost?.trim() ? input.bindHost.trim() : undefined;
  const serveWebUi =
    input.serveWebUi === undefined ? prevServeWebUi : input.serveWebUi === true ? true : undefined;
  const port = input.port === null || input.port === 0 ? undefined : input.port;

  if (wasRunning) await context.serverService.stopServer();
  await context.config.editConfig((config) => {
    config.apiServerServeWebUi = serveWebUi;
    config.apiServerBindHost = bindHost;
    config.apiServerPort = port;
    return config;
  });

  if (resolveXumEnvironmentValue("NO_API_SERVER", process.env) !== "1") {
    const authToken = context.serverService.getApiAuthToken();
    if (!authToken) throw new Error("API server auth token not initialized");
    const envPortRaw = resolveXumEnvironmentValue("SERVER_PORT", process.env);
    const envPort = envPortRaw ? Number.parseInt(envPortRaw, 10) : undefined;
    try {
      await context.serverService.startServer({
        xumHome: context.config.rootDir,
        context,
        authToken,
        serveStatic: serveWebUi === true,
        host: bindHost ?? "127.0.0.1",
        port: envPort ?? port ?? 0,
      });
    } catch (error) {
      await context.config.editConfig((config) => {
        config.apiServerServeWebUi = prevServeWebUi;
        config.apiServerBindHost = prevBindHost;
        config.apiServerPort = prevPort;
        return config;
      });
      if (wasRunning) {
        try {
          await context.serverService.startServer({
            xumHome: context.config.rootDir,
            context,
            serveStatic: prevServeWebUi === true,
            authToken,
            host: prevBindHost ?? "127.0.0.1",
            port: envPort ?? prevPort ?? 0,
          });
        } catch {
          // Best effort: preserve the original settings error.
        }
      }
      throw error;
    }
  }
  return getApiServerStatusSnapshot(context);
}
