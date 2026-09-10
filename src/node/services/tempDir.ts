import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { log } from "@/node/services/log";

/**
 * Disposable temporary directory that auto-cleans when disposed
 * Use with `using` statement for automatic cleanup
 */
export class DisposableTempDir implements Disposable {
  public readonly path: string;

  constructor(prefix = "xum-temp") {
    // Create unique temp directory
    const id = Math.random().toString(16).substring(2, 10);
    this.path = path.join(os.tmpdir(), `${prefix}-${id}`);
    fs.mkdirSync(this.path, { recursive: true, mode: 0o700 });
  }

  [Symbol.dispose](): void {
    // Clean up temp directory
    if (fs.existsSync(this.path)) {
      try {
        fs.rmSync(this.path, { recursive: true, force: true });
      } catch (error) {
        log.warn(`Failed to cleanup temp dir ${this.path}:`, error);
        // Don't throw - cleanup is best-effort
      }
    }
  }
}
