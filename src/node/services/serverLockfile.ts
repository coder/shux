import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";

export const ServerLockDataSchema = z.object({
  pid: z.number(),
  /** Base URL for HTTP API (e.g., "http://localhost:3000" or "https://my.box.com/mux") */
  baseUrl: z.url(),
  token: z.string(),
  startedAt: z.string(),
  /** Bind host/interface the server is listening on (e.g. "127.0.0.1" or "0.0.0.0") */
  bindHost: z.string().optional(),
  /** The port the server is listening on */
  port: z.number().int().min(0).max(65535).optional(),
  /** Additional base URLs that are reachable from other devices (LAN/VPN) */
  networkBaseUrls: z.array(z.url()).optional(),
});

export type ServerLockData = z.infer<typeof ServerLockDataSchema>;

/**
 * Manages the server lockfile at ~/.xum/server.lock
 *
 * The lockfile enables CLI tools to discover a running xum server
 * (either Electron app or standalone xum server) and connect to it.
 */
export class ServerLockfile {
  private readonly lockPath: string;

  constructor(xumHome: string) {
    this.lockPath = path.join(xumHome, "server.lock");
  }

  /**
   * Acquire the lockfile with the given baseUrl and token.
   * Writes atomically with 0600 permissions (owner read/write only).
   */
  async acquire(
    baseUrl: string,
    token: string,
    extra?: {
      bindHost?: string;
      port?: number;
      networkBaseUrls?: string[];
    }
  ): Promise<void> {
    const bindHost = extra?.bindHost?.trim() ? extra.bindHost.trim() : undefined;
    const port =
      typeof extra?.port === "number" &&
      Number.isInteger(extra.port) &&
      extra.port >= 0 &&
      extra.port <= 65535
        ? extra.port
        : undefined;

    const data: ServerLockData = {
      pid: process.pid,
      baseUrl,
      token,
      startedAt: new Date().toISOString(),
      bindHost,
      port,
      networkBaseUrls: extra?.networkBaseUrls?.length ? extra.networkBaseUrls : undefined,
    };

    // Ensure directory exists
    const dir = path.dirname(this.lockPath);
    try {
      await fs.access(dir);
    } catch {
      await fs.mkdir(dir, { recursive: true });
    }

    // Write atomically by writing to temp file then renaming
    const tempPath = `${this.lockPath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), {
      mode: 0o600, // Owner read/write only
    });
    await fs.rename(tempPath, this.lockPath);
  }

  /**
   * Read the lockfile and validate it.
   * Returns null if the lockfile doesn't exist or is stale (dead PID).
   */
  async read(): Promise<ServerLockData | null> {
    try {
      await fs.access(this.lockPath);
      const content = await fs.readFile(this.lockPath, "utf-8");
      const data = ServerLockDataSchema.parse(JSON.parse(content));

      // Validate PID is still alive
      if (!this.isProcessAlive(data.pid)) {
        // Clean up stale lockfile
        await this.release();
        return null;
      }

      return data;
    } catch {
      return null;
    }
  }

  /**
   * Release the lockfile by deleting it.
   */
  async release(): Promise<void> {
    try {
      await fs.unlink(this.lockPath);
    } catch {
      // Ignore cleanup errors (file may not exist)
    }
  }

  /**
   * Check if a process with the given PID is still running.
   * Uses signal 0 which tests existence without actually sending a signal.
   */
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the path to the lockfile (for testing/debugging).
   */
  getLockPath(): string {
    return this.lockPath;
  }
}
