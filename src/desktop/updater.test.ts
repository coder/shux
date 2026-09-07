import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { EventEmitter } from "events";
import { UpdaterService, type UpdateStatus } from "./updater";

// Create a mock autoUpdater that's an EventEmitter with the required methods
const mockAutoUpdater = Object.assign(new EventEmitter(), {
  autoDownload: false,
  autoInstallOnAppQuit: true,
  channel: "latest",
  allowPrerelease: false,
  checkForUpdates: mock(() => Promise.resolve()),
  downloadUpdate: mock(() => Promise.resolve()),
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  setFeedURL: mock(() => {}),
  quitAndInstall: mock(() => {
    // Mock implementation - does nothing in tests
  }),
});

let mockUpdateInstallInProgress = false;

// Mock electron-updater module
void mock.module("electron-updater", () => ({
  autoUpdater: mockAutoUpdater,
}));

// Mock update install state module
void mock.module("@/desktop/updateInstallState", () => ({
  markUpdateInstallInProgress: mock(() => {
    mockUpdateInstallInProgress = true;
  }),
  clearUpdateInstallInProgress: mock(() => {
    mockUpdateInstallInProgress = false;
  }),
  isUpdateInstallInProgress: () => mockUpdateInstallInProgress,
}));

describe("UpdaterService", () => {
  let service: UpdaterService;
  let statusUpdates: UpdateStatus[];
  let originalDebugUpdater: string | undefined;
  let originalDebugUpdaterFail: string | undefined;

  beforeEach(() => {
    // Reset mocks
    mockAutoUpdater.checkForUpdates.mockClear();
    mockAutoUpdater.downloadUpdate.mockClear();
    mockAutoUpdater.setFeedURL.mockClear();
    mockAutoUpdater.quitAndInstall.mockClear();
    mockAutoUpdater.removeAllListeners();
    mockAutoUpdater.channel = "latest";
    mockAutoUpdater.allowPrerelease = false;

    mockUpdateInstallInProgress = false;

    // Save and clear debug updater env vars to ensure clean test environment
    originalDebugUpdater = process.env.DEBUG_UPDATER;
    originalDebugUpdaterFail = process.env.DEBUG_UPDATER_FAIL;
    delete process.env.DEBUG_UPDATER;
    delete process.env.DEBUG_UPDATER_FAIL;
    service = new UpdaterService();

    // Capture status updates via subscriber pattern (ORPC model)
    statusUpdates = [];
    service.subscribe((status) => statusUpdates.push(status));
  });

  afterEach(() => {
    // Restore debug updater env vars
    if (originalDebugUpdater !== undefined) {
      process.env.DEBUG_UPDATER = originalDebugUpdater;
    } else {
      delete process.env.DEBUG_UPDATER;
    }

    if (originalDebugUpdaterFail !== undefined) {
      process.env.DEBUG_UPDATER_FAIL = originalDebugUpdaterFail;
    } else {
      delete process.env.DEBUG_UPDATER_FAIL;
    }
  });

  describe("debug updater mode", () => {
    it("should expose an available update immediately when fake version is set", () => {
      process.env.DEBUG_UPDATER = "0.0.1";
      const debugService = new UpdaterService();

      const status = debugService.getStatus();
      expect(status.type).toBe("available");
      if (status.type !== "available") {
        throw new Error(`Expected available status, got: ${status.type}`);
      }
      expect(status.info.version).toBe("0.0.1");
    });
  });

  describe("channel management", () => {
    it("defaults to stable channel", () => {
      expect(service.getChannel()).toBe("stable");
      expect(mockAutoUpdater.setFeedURL).toHaveBeenCalledWith({
        provider: "github",
        owner: "coder",
        repo: "xum",
        releaseType: "release",
      });
    });

    it("falls back from a server npm preference and refuses selecting npm on desktop", () => {
      const desktop = new UpdaterService("npm");
      expect(desktop.getChannel()).toBe("stable");
      expect(mockAutoUpdater.channel).toBe("latest");
      desktop.setChannel("nightly");
      expect(() => desktop.setChannel("npm")).toThrow();
      expect(desktop.getChannel()).toBe("nightly");
      expect(mockAutoUpdater.channel).toBe("nightly");
    });

    it("accepts initial channel 'nightly'", () => {
      mockAutoUpdater.setFeedURL.mockClear();

      const nightlyService = new UpdaterService("nightly");

      expect(nightlyService.getChannel()).toBe("nightly");
      expect(mockAutoUpdater.setFeedURL).toHaveBeenCalledWith({
        provider: "github",
        owner: "coder",
        repo: "xum",
        releaseType: "prerelease",
      });
      expect(mockAutoUpdater.allowPrerelease).toBe(true);
      expect(mockAutoUpdater.channel).toBe("nightly");
    });

    it("setChannel switches from stable to nightly", () => {
      mockAutoUpdater.setFeedURL.mockClear();
      const channelService = new UpdaterService();

      mockAutoUpdater.emit("update-available", { version: "2.0.0" });
      expect(channelService.getStatus().type).toBe("available");

      channelService.setChannel("nightly");

      expect(channelService.getChannel()).toBe("nightly");
      expect(mockAutoUpdater.setFeedURL).toHaveBeenLastCalledWith({
        provider: "github",
        owner: "coder",
        repo: "xum",
        releaseType: "prerelease",
      });
      expect(mockAutoUpdater.channel).toBe("nightly");
      expect(channelService.getStatus()).toEqual({ type: "idle" });
    });

    it("setChannel throws when checking", () => {
      mockAutoUpdater.setFeedURL.mockClear();
      const channelService = new UpdaterService();

      channelService.checkForUpdates();

      expect(() => channelService.setChannel("nightly")).toThrow("checking for updates");
    });

    it("setChannel throws when downloading", () => {
      mockAutoUpdater.setFeedURL.mockClear();
      const channelService = new UpdaterService();

      mockAutoUpdater.emit("download-progress", { percent: 50 });

      expect(() => channelService.setChannel("nightly")).toThrow("downloading an update");
    });

    it("setChannel throws when downloaded", () => {
      mockAutoUpdater.setFeedURL.mockClear();
      const channelService = new UpdaterService();

      mockAutoUpdater.emit("update-downloaded", { version: "2.0.0" });

      expect(() => channelService.setChannel("nightly")).toThrow("ready to install");
    });

    it("setChannel notifies subscribers on switch", () => {
      mockAutoUpdater.setFeedURL.mockClear();
      const channelService = new UpdaterService();
      const updates: UpdateStatus[] = [];

      channelService.subscribe((status) => updates.push(status));
      channelService.setChannel("nightly");

      expect(updates).toContainEqual({ type: "idle" });
    });

    it("setChannel is no-op for same channel", () => {
      mockAutoUpdater.setFeedURL.mockClear();
      const channelService = new UpdaterService();

      expect(mockAutoUpdater.setFeedURL).toHaveBeenCalledTimes(1);
      channelService.setChannel("stable");
      expect(mockAutoUpdater.setFeedURL).toHaveBeenCalledTimes(1);
    });
  });

  describe("debug updater fail mode", () => {
    it("should simulate check failure when DEBUG_UPDATER_FAIL=check", async () => {
      process.env.DEBUG_UPDATER = "2.0.0";
      process.env.DEBUG_UPDATER_FAIL = "check";
      const debugService = new UpdaterService();

      // Constructor should not surface available immediately when check is configured to fail.
      expect(debugService.getStatus().type).not.toBe("available");

      debugService.checkForUpdates({ source: "manual" });
      await new Promise((resolve) => setTimeout(resolve, 600));

      const status = debugService.getStatus();
      expect(status.type).toBe("error");
      if (status.type !== "error") {
        throw new Error(`Expected error status, got: ${status.type}`);
      }
      expect(status.phase).toBe("check");
      expect(status.message).toContain("Simulated check failure");
    });

    it("should simulate download failure when DEBUG_UPDATER_FAIL=download", async () => {
      process.env.DEBUG_UPDATER = "2.0.0";
      process.env.DEBUG_UPDATER_FAIL = "download";
      const debugService = new UpdaterService();

      // Download failure should not affect the fake check/available state.
      expect(debugService.getStatus().type).toBe("available");

      await debugService.downloadUpdate();

      const status = debugService.getStatus();
      expect(status.type).toBe("error");
      if (status.type !== "error") {
        throw new Error(`Expected error status, got: ${status.type}`);
      }
      expect(status.phase).toBe("download");
      expect(status.message).toContain("Simulated download failure");
    });

    it("should allow retrying download after DEBUG_UPDATER_FAIL=download", async () => {
      process.env.DEBUG_UPDATER = "2.0.0";
      process.env.DEBUG_UPDATER_FAIL = "download";
      const debugService = new UpdaterService();

      await debugService.downloadUpdate();
      const firstStatus = debugService.getStatus();
      expect(firstStatus.type).toBe("error");
      if (firstStatus.type !== "error") {
        throw new Error(`Expected error status, got: ${firstStatus.type}`);
      }
      expect(firstStatus.phase).toBe("download");
      expect(firstStatus.message).toContain("Simulated download failure");

      await debugService.downloadUpdate();
      const secondStatus = debugService.getStatus();
      expect(secondStatus.type).toBe("error");
      if (secondStatus.type !== "error") {
        throw new Error(`Expected error status, got: ${secondStatus.type}`);
      }
      expect(secondStatus.phase).toBe("download");
      expect(secondStatus.message).toContain("Simulated download failure");
    });

    it("should simulate install failure and surface retry attempts when DEBUG_UPDATER_FAIL=install", async () => {
      process.env.DEBUG_UPDATER = "2.0.0";
      process.env.DEBUG_UPDATER_FAIL = "install";
      const debugService = new UpdaterService();

      // Reach downloaded state first through fake happy-path download.
      await debugService.downloadUpdate();
      expect(debugService.getStatus().type).toBe("downloaded");

      debugService.installUpdate();

      const firstStatus = debugService.getStatus();
      expect(firstStatus.type).toBe("error");
      if (firstStatus.type !== "error") {
        throw new Error(`Expected error status, got: ${firstStatus.type}`);
      }
      expect(firstStatus.phase).toBe("install");
      expect(firstStatus.message).toContain("Simulated install failure");
      expect(firstStatus.message).not.toContain("attempt 2");

      debugService.installUpdate();
      const secondStatus = debugService.getStatus();
      expect(secondStatus.type).toBe("error");
      if (secondStatus.type !== "error") {
        throw new Error(`Expected error status, got: ${secondStatus.type}`);
      }
      expect(secondStatus.phase).toBe("install");
      expect(secondStatus.message).toContain("Simulated install failure");
      expect(secondStatus.message).toContain("attempt 2");
    });

    it("should ignore DEBUG_UPDATER_FAIL without a fake DEBUG_UPDATER version", () => {
      process.env.DEBUG_UPDATER = "1";
      process.env.DEBUG_UPDATER_FAIL = "download";
      const debugService = new UpdaterService();

      expect(debugService.getStatus()).toEqual({ type: "idle" });
    });
  });

  describe("checkForUpdates", () => {
    it("should set status to 'checking' immediately and notify subscribers", () => {
      // Setup
      mockAutoUpdater.checkForUpdates.mockReturnValue(Promise.resolve());

      // Act
      service.checkForUpdates();

      // Assert - should immediately notify with 'checking' status
      expect(statusUpdates).toContainEqual({ type: "checking" });
    });

    it("should transition to 'up-to-date' when no update found", async () => {
      // Setup
      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        // Simulate electron-updater behavior: emit event, return unresolved promise
        setImmediate(() => {
          mockAutoUpdater.emit("update-not-available");
        });
        return new Promise(() => {
          // Intentionally never resolves to simulate hanging promise
        });
      });

      // Act
      service.checkForUpdates();

      // Wait for event to be processed
      await new Promise((resolve) => setImmediate(resolve));

      // Assert - should notify with 'up-to-date' status
      expect(statusUpdates).toContainEqual({ type: "checking" });
      expect(statusUpdates).toContainEqual({ type: "up-to-date" });
    });

    it("should transition to 'available' when update found", async () => {
      // Setup
      const updateInfo = {
        version: "1.0.0",
        files: [],
        path: "test-path",
        sha512: "test-sha",
        releaseDate: "2025-01-01",
      };

      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        setImmediate(() => {
          mockAutoUpdater.emit("update-available", updateInfo);
        });
        return new Promise(() => {
          // Intentionally never resolves to simulate hanging promise
        });
      });

      // Act
      service.checkForUpdates();

      // Wait for event to be processed
      await new Promise((resolve) => setImmediate(resolve));

      // Assert
      expect(statusUpdates).toContainEqual({ type: "checking" });
      expect(statusUpdates).toContainEqual({ type: "available", info: updateInfo });
    });

    it("should handle non-transient errors from checkForUpdates", async () => {
      // Use a non-transient error (transient errors like "Network error" now
      // silently back off to idle — see "transient error backoff" tests)
      const error = new Error("Code signing verification failed");

      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        return Promise.reject(error);
      });

      // Act
      service.checkForUpdates();

      // Wait a bit for error to be caught
      await new Promise((resolve) => setImmediate(resolve));

      // Assert
      expect(statusUpdates).toContainEqual({ type: "checking" });

      // Should eventually get error status
      const errorStatus = statusUpdates.find((s) => s.type === "error");
      expect(errorStatus).toBeDefined();
      expect(errorStatus).toEqual({
        type: "error",
        phase: "check",
        message: "Code signing verification failed",
      });
    });

    it("should timeout if no events fire within 30 seconds", () => {
      // Use shorter timeout for testing (100ms instead of 30s)
      // We'll verify the timeout logic works, not the exact timing
      const originalSetTimeout = global.setTimeout;
      let timeoutCallback: (() => void) | null = null;

      // Mock setTimeout to capture the timeout callback
      const globalObj = global as { setTimeout: typeof setTimeout };
      globalObj.setTimeout = ((cb: () => void, _delay: number) => {
        timeoutCallback = cb;
        return 123 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout;

      // Setup - checkForUpdates returns promise that never resolves and emits no events
      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        return new Promise(() => {
          // Intentionally never resolves to simulate hanging promise
        });
      });

      // Act
      service.checkForUpdates();

      // Should be in checking state
      expect(statusUpdates).toContainEqual({ type: "checking" });

      // Manually trigger the timeout callback
      expect(timeoutCallback).toBeTruthy();
      timeoutCallback!();

      // Should have timed out and returned to idle
      const lastStatus = statusUpdates[statusUpdates.length - 1];
      expect(lastStatus).toEqual({ type: "idle" });

      // Restore original setTimeout
      global.setTimeout = originalSetTimeout;
    });
  });

  describe("transient error backoff", () => {
    const missingNightlyManifestError =
      'Cannot find latest-mac.yml in the latest release artifacts (https://github.com/coder/mux/releases/download/v0.18.1-nightly.16/latest-mac.yml): HttpError: 404 "method: GET url: https://github.com/coder/mux/releases/download/v0.18.1-nightly.16/latest-mac.yml\n\nPlease double check that your authentication token is correct.\n" Headers: { ... }\n    at createHttpError (/path/httpExecutor.ts:31:10)';
    const nightlyManifestPendingMessage =
      "Update metadata isn't available yet. The latest release may still be publishing; please try again in a few minutes.";

    it("should silently back off on 404 (latest.yml missing) for auto checks", async () => {
      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        setImmediate(() => {
          mockAutoUpdater.emit("error", new Error("HttpError: 404 Not Found"));
        });
        return new Promise(() => {
          // Never resolves — events drive state
        });
      });

      service.checkForUpdates({ source: "auto" });
      await new Promise((resolve) => setImmediate(resolve));

      const lastStatus = statusUpdates[statusUpdates.length - 1];
      expect(lastStatus).toEqual({ type: "idle" });
      expect(statusUpdates.find((s) => s.type === "error")).toBeUndefined();
    });

    it("should surface transient errors for manual checks", async () => {
      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        setImmediate(() => {
          mockAutoUpdater.emit("error", new Error("HttpError: 404 Not Found"));
        });
        return new Promise(() => {
          // Never resolves — events drive state
        });
      });

      service.checkForUpdates({ source: "manual" });
      await new Promise((resolve) => setImmediate(resolve));

      expect(statusUpdates[statusUpdates.length - 1]).toEqual({
        type: "error",
        phase: "check",
        message: "HttpError: 404 Not Found",
      });
    });

    it("should show a friendly message for missing nightly update metadata", async () => {
      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        setImmediate(() => {
          mockAutoUpdater.emit("error", new Error(missingNightlyManifestError));
        });
        return new Promise(() => {
          // Never resolves — events drive state
        });
      });

      service.checkForUpdates({ source: "manual" });
      await new Promise((resolve) => setImmediate(resolve));

      expect(statusUpdates[statusUpdates.length - 1]).toEqual({
        type: "error",
        phase: "check",
        message: nightlyManifestPendingMessage,
      });
    });

    it("should silently back off on network errors", async () => {
      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        setImmediate(() => {
          mockAutoUpdater.emit("error", new Error("getaddrinfo ENOTFOUND github.com"));
        });
        return new Promise(() => {
          // Never resolves — events drive state
        });
      });

      service.checkForUpdates();
      await new Promise((resolve) => setImmediate(resolve));

      expect(statusUpdates[statusUpdates.length - 1]).toEqual({ type: "idle" });
    });

    it("should silently back off on rate limit errors", async () => {
      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        setImmediate(() => {
          mockAutoUpdater.emit("error", new Error("HttpError: 403 rate limit exceeded"));
        });
        return new Promise(() => {
          // Never resolves — events drive state
        });
      });

      service.checkForUpdates();
      await new Promise((resolve) => setImmediate(resolve));

      expect(statusUpdates[statusUpdates.length - 1]).toEqual({ type: "idle" });
    });

    it("should surface non-transient errors to the user", async () => {
      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        setImmediate(() => {
          mockAutoUpdater.emit("error", new Error("Code signing verification failed"));
        });
        return new Promise(() => {
          // Never resolves — events drive state
        });
      });

      service.checkForUpdates();
      await new Promise((resolve) => setImmediate(resolve));

      expect(statusUpdates.find((s) => s.type === "error")).toEqual({
        type: "error",
        phase: "check",
        message: "Code signing verification failed",
      });
    });

    it("should surface bare 403 errors (not rate-limit specific)", async () => {
      // A bare 403 without "rate limit" wording may indicate a persistent
      // auth/config issue — should NOT be silently swallowed.
      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        setImmediate(() => {
          mockAutoUpdater.emit("error", new Error("HttpError: 403 Forbidden"));
        });
        return new Promise(() => {
          // Never resolves — events drive state
        });
      });

      service.checkForUpdates();
      await new Promise((resolve) => setImmediate(resolve));

      expect(statusUpdates.find((s) => s.type === "error")).toEqual({
        type: "error",
        phase: "check",
        message: "HttpError: 403 Forbidden",
      });
    });

    it("should surface transient-looking errors during download phase", async () => {
      // A network error during download should NOT be silently dropped to idle.
      // Transient backoff only applies during the "checking" phase.
      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        setImmediate(() => mockAutoUpdater.emit("update-available", { version: "2.0.0" }));
        return new Promise(() => {
          // Never resolves — events drive state
        });
      });
      service.checkForUpdates();
      await new Promise((r) => setImmediate(r));

      // Simulate starting download then hitting a network error
      mockAutoUpdater.emit("download-progress", { percent: 30 });
      mockAutoUpdater.emit("error", new Error("getaddrinfo ENOTFOUND github.com"));

      expect(statusUpdates.find((s) => s.type === "error")).toEqual({
        type: "error",
        phase: "download",
        message: "getaddrinfo ENOTFOUND github.com",
      });
    });

    it("should map errors during downloaded state to install phase", () => {
      mockAutoUpdater.emit("update-available", { version: "2.0.0" });
      mockAutoUpdater.emit("update-downloaded", { version: "2.0.0" });

      mockAutoUpdater.emit("error", new Error("Install failed while preparing restart"));

      expect(statusUpdates[statusUpdates.length - 1]).toEqual({
        type: "error",
        phase: "install",
        message: "Install failed while preparing restart",
      });
    });

    it("should preserve existing error phase on follow-up updater errors", () => {
      mockAutoUpdater.emit("update-available", { version: "2.0.0" });
      mockAutoUpdater.emit("download-progress", { percent: 30 });

      mockAutoUpdater.emit("error", new Error("First download failure"));
      expect(statusUpdates[statusUpdates.length - 1]).toEqual({
        type: "error",
        phase: "download",
        message: "First download failure",
      });

      mockAutoUpdater.emit("error", new Error("Follow-up updater error"));
      expect(statusUpdates[statusUpdates.length - 1]).toEqual({
        type: "error",
        phase: "download",
        message: "Follow-up updater error",
      });
    });

    it("should silently back off when promise rejects with transient error", async () => {
      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        return Promise.reject(new Error("HttpError: 404 Not Found"));
      });

      service.checkForUpdates();
      await new Promise((resolve) => setImmediate(resolve));

      const lastStatus = statusUpdates[statusUpdates.length - 1];
      expect(lastStatus).toEqual({ type: "idle" });
      expect(statusUpdates.find((s) => s.type === "error")).toBeUndefined();
    });

    it("should show a friendly message when promise rejects for missing nightly metadata", async () => {
      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        return Promise.reject(new Error(missingNightlyManifestError));
      });

      service.checkForUpdates({ source: "manual" });
      await new Promise((resolve) => setImmediate(resolve));

      expect(statusUpdates[statusUpdates.length - 1]).toEqual({
        type: "error",
        phase: "check",
        message: nightlyManifestPendingMessage,
      });
    });
  });

  describe("downloadUpdate", () => {
    it("should emit phase-aware error when download fails", async () => {
      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        setImmediate(() => {
          mockAutoUpdater.emit("update-available", { version: "2.0.0" });
        });
        return new Promise(() => {
          // Never resolves — events drive state
        });
      });
      service.checkForUpdates();
      await new Promise((resolve) => setImmediate(resolve));

      mockAutoUpdater.downloadUpdate.mockImplementationOnce(() =>
        Promise.reject(new Error("Download failed due to network interruption"))
      );

      await service.downloadUpdate();

      expect(statusUpdates[statusUpdates.length - 1]).toEqual({
        type: "error",
        phase: "download",
        message: "Download failed due to network interruption",
      });
    });

    it("should allow download retry after download failure", async () => {
      const downloadedInfo = { version: "2.0.0" };
      mockAutoUpdater.emit("update-available", downloadedInfo);

      mockAutoUpdater.downloadUpdate
        .mockImplementationOnce(() =>
          Promise.reject(new Error("Download failed due to network interruption"))
        )
        .mockImplementationOnce(() => {
          setImmediate(() => {
            mockAutoUpdater.emit("update-downloaded", downloadedInfo);
          });
          return Promise.resolve();
        });

      await service.downloadUpdate();
      expect(service.getStatus()).toEqual({
        type: "error",
        phase: "download",
        message: "Download failed due to network interruption",
      });

      await service.downloadUpdate();
      await new Promise((resolve) => setImmediate(resolve));

      const retryStatus = service.getStatus();
      expect(retryStatus.type).toBe("downloaded");
      if (retryStatus.type !== "downloaded") {
        throw new Error(`Expected downloaded status, got ${retryStatus.type}`);
      }
      expect(retryStatus.info.version).toBe(downloadedInfo.version);
    });
  });

  describe("installUpdate", () => {
    it("should emit phase-aware error when install fails", () => {
      mockAutoUpdater.emit("update-downloaded", { version: "2.0.0" });

      mockAutoUpdater.quitAndInstall.mockImplementationOnce(() => {
        throw new Error("Install failed due to permission error");
      });

      service.installUpdate();

      expect(statusUpdates[statusUpdates.length - 1]).toEqual({
        type: "error",
        phase: "install",
        message: "Install failed due to permission error",
      });
    });

    it("should allow install retry after install failure", () => {
      mockAutoUpdater.emit("update-downloaded", { version: "2.0.0" });

      mockAutoUpdater.quitAndInstall
        .mockImplementationOnce(() => {
          throw new Error("Install failed due to permission error");
        })
        .mockImplementationOnce(() => {
          // second attempt succeeds
        });

      service.installUpdate();
      expect(service.getStatus()).toEqual({
        type: "error",
        phase: "install",
        message: "Install failed due to permission error",
      });

      expect(() => service.installUpdate()).not.toThrow();
      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(2);
    });

    it("should mark update install in progress before quitAndInstall", () => {
      mockAutoUpdater.emit("update-downloaded", { version: "2.0.0" });

      service.installUpdate();

      expect(mockUpdateInstallInProgress).toBe(true);
    });

    it("should clear update install flag when quitAndInstall throws", () => {
      mockAutoUpdater.emit("update-downloaded", { version: "2.0.0" });

      mockAutoUpdater.quitAndInstall.mockImplementationOnce(() => {
        throw new Error("Install failed due to permission error");
      });

      service.installUpdate();

      expect(mockUpdateInstallInProgress).toBe(false);
    });
  });

  describe("state guards", () => {
    it("should skip check when already checking", () => {
      mockAutoUpdater.checkForUpdates.mockReturnValue(
        new Promise(() => {
          // Never resolves
        })
      );
      service.checkForUpdates();
      service.checkForUpdates(); // should be skipped
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("should upgrade check source to manual when check is already in-flight", () => {
      mockAutoUpdater.checkForUpdates.mockReturnValue(
        new Promise(() => {
          // Never resolves
        })
      );

      service.checkForUpdates({ source: "auto" });
      service.checkForUpdates({ source: "manual" }); // skipped, but should upgrade source

      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

      mockAutoUpdater.emit("error", new Error("HttpError: 404 Not Found"));

      expect(statusUpdates[statusUpdates.length - 1]).toEqual({
        type: "error",
        phase: "check",
        message: "HttpError: 404 Not Found",
      });
    });

    it("should skip check when downloading", async () => {
      // Get to downloading state via update-available → download-progress
      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        setImmediate(() => mockAutoUpdater.emit("update-available", { version: "2.0.0" }));
        return new Promise(() => {
          // Never resolves — events drive state
        });
      });
      service.checkForUpdates();
      await new Promise((r) => setImmediate(r));
      // Simulate download-progress event to enter downloading state
      mockAutoUpdater.emit("download-progress", { percent: 50 });

      mockAutoUpdater.checkForUpdates.mockClear();
      service.checkForUpdates(); // should be skipped
      expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
      expect(statusUpdates[statusUpdates.length - 1]).toEqual({ type: "downloading", percent: 50 });
    });

    it("should skip check when update already downloaded", async () => {
      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        setImmediate(() => mockAutoUpdater.emit("update-downloaded", { version: "2.0.0" }));
        return new Promise(() => {
          // Never resolves — events drive state
        });
      });
      service.checkForUpdates();
      await new Promise((r) => setImmediate(r));

      mockAutoUpdater.checkForUpdates.mockClear();
      service.checkForUpdates(); // should be skipped — don't throw away the download
      expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    });
  });

  describe("getStatus", () => {
    it("should return initial status as idle", () => {
      const status = service.getStatus();
      expect(status).toEqual({ type: "idle" });
    });

    it("should return current status after check starts", () => {
      mockAutoUpdater.checkForUpdates.mockReturnValue(Promise.resolve());

      service.checkForUpdates();

      const status = service.getStatus();
      expect(status.type).toBe("checking");
    });
  });
});
