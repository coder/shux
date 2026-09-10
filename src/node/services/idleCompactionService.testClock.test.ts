import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Duration } from "effect";
import type { ProjectsConfig } from "@/common/types/project";
import type { Config } from "@/node/config";
import { makeTestEffectRunner, type TestEffectRunner } from "./di/testEffectRunner";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { HistoryService } from "./historyService";
import {
  CHECK_INTERVAL_MS,
  IdleCompactionService,
  INITIAL_CHECK_DELAY_MS,
} from "./idleCompactionService";

/**
 * Checker cadence on virtual time. The default-runner smoke in
 * `idleCompactionService.test.ts` ("start/stop on the default runner") keeps
 * the real-clock production path covered.
 */
describe("IdleCompactionService on a TestClock", () => {
  let clock: TestEffectRunner;
  let service: IdleCompactionService;
  // checkAllWorkspaces() reads the config synchronously first, so with no
  // projects configured its call count is the check count.
  let loadConfigMock: ReturnType<typeof mock<() => ProjectsConfig>>;

  beforeEach(() => {
    clock = makeTestEffectRunner();
    loadConfigMock = mock((): ProjectsConfig => ({ projects: new Map() }));
    service = new IdleCompactionService(
      { loadConfigOrDefault: loadConfigMock } as unknown as Config,
      {} as HistoryService,
      {} as ExtensionMetadataService,
      () => Promise.resolve(),
      clock.runner
    );
  });

  afterEach(async () => {
    service.stop();
    await clock.dispose();
  });

  test("first check after the initial delay, then one per interval, none after stop()", async () => {
    service.start();
    expect(loadConfigMock).toHaveBeenCalledTimes(0);

    await clock.adjust(Duration.millis(INITIAL_CHECK_DELAY_MS - 1));
    expect(loadConfigMock).toHaveBeenCalledTimes(0);
    await clock.adjust(Duration.millis(1));
    expect(loadConfigMock).toHaveBeenCalledTimes(1);

    await clock.adjust(Duration.millis(CHECK_INTERVAL_MS));
    expect(loadConfigMock).toHaveBeenCalledTimes(2);
    // Sweeps are fire-and-forget, so an adjust spanning two slots fires both.
    await clock.adjust(Duration.millis(CHECK_INTERVAL_MS * 2));
    expect(loadConfigMock).toHaveBeenCalledTimes(4);

    service.stop();
    await clock.adjust(Duration.millis(CHECK_INTERVAL_MS * 3));
    expect(loadConfigMock).toHaveBeenCalledTimes(4);
  });

  test("stop() during the initial delay cancels the first check", async () => {
    service.start();
    await clock.adjust(Duration.millis(INITIAL_CHECK_DELAY_MS / 2));

    service.stop();

    await clock.adjust(Duration.millis(INITIAL_CHECK_DELAY_MS + CHECK_INTERVAL_MS));
    expect(loadConfigMock).toHaveBeenCalledTimes(0);
  });
});
