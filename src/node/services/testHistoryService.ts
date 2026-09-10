/**
 * Shared test helper: creates a real HistoryService backed by a temp directory.
 *
 * HistoryService is pure filesystem I/O with a single dependency (getSessionDir).
 * Prefer this over mocks in tests — it's fast (sub-millisecond on temp dirs),
 * requires no initialization, and exercises real read/write paths.
 *
 * For error injection, use the real instance + spyOn:
 *   spyOn(historyService, "appendToHistory").mockRejectedValueOnce(...)
 */
import { HistoryService } from "@/node/services/historyService";
import { Config } from "@/node/config";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

export async function createTestHistoryService(): Promise<{
  historyService: HistoryService;
  config: Config;
  tempDir: string;
  cleanup: () => Promise<void>;
}> {
  const tempDir = path.join(
    os.tmpdir(),
    `xum-test-history-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await fs.mkdir(tempDir, { recursive: true });
  const config = new Config(tempDir);
  const historyService = new HistoryService(config);
  return {
    historyService,
    config,
    tempDir,
    cleanup: () => fs.rm(tempDir, { recursive: true, force: true }),
  };
}
