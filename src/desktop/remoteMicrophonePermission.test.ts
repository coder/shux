import { describe, expect, mock, test } from "bun:test";
import type { BrowserWindow, MessageBoxReturnValue } from "electron";
import { createRemoteMicrophonePermission } from "./remoteMicrophonePermission";

type Dependencies = Parameters<typeof createRemoteMicrophonePermission>[0];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function setup(platform: NodeJS.Platform = "darwin") {
  const state = { destroyed: false, contentsDestroyed: false, focused: true };
  // Keep the Electron boundary local so other tests do not inherit module mocks.
  const window = {
    isDestroyed: () => state.destroyed,
    isFocused: () => state.focused,
    webContents: { isDestroyed: () => state.contentsDestroyed },
  } as unknown as BrowserWindow;
  const abort = new AbortController();
  const deps = {
    platform,
    showMessageBox: mock<Dependencies["showMessageBox"]>(() =>
      Promise.resolve({ response: 1, checkboxChecked: false })
    ),
    getMediaAccessStatus: mock<Dependencies["getMediaAccessStatus"]>(() => "granted"),
    askForMediaAccess: mock<Dependencies["askForMediaAccess"]>(() => Promise.resolve(true)),
  };
  const request = createRemoteMicrophonePermission(deps);
  return {
    state,
    window,
    abort,
    deps,
    request: (serverUrl = "https://example.com/remote") => request(window, serverUrl, abort.signal),
  };
}

describe("remote microphone approval", () => {
  test("requires native consent with Deny as the default and cancel action", async () => {
    const { request, deps, window, abort } = setup();
    deps.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false });
    expect(await request("https://example.com/remote?token=secret#secret")).toBe(false);
    const [parent, options] = deps.showMessageBox.mock.calls[0];
    expect(parent).toBe(window);
    expect(options.signal).toBe(abort.signal);
    expect(options.detail).toBe("https://example.com/remote");
    expect(options.defaultId).toBe(0);
    expect(options.cancelId).toBe(0);
    expect(deps.getMediaAccessStatus).not.toHaveBeenCalled();
    expect(deps.askForMediaAccess).not.toHaveBeenCalled();
  });

  test.each(["https://user:password@example.com", "invalid", "file:///tmp/app"])(
    "does not display an invalid or credential-bearing server URL: %s",
    async (serverUrl) => {
      const { request, deps } = setup();
      expect(await request(serverUrl)).toBe(false);
      expect(deps.showMessageBox).not.toHaveBeenCalled();
      expect(deps.getMediaAccessStatus).not.toHaveBeenCalled();
    }
  );

  test("waits for native consent before checking OS access", async () => {
    const { request, deps } = setup();
    const consent = deferred<MessageBoxReturnValue>();
    deps.showMessageBox.mockReturnValue(consent.promise);
    const result = request();
    expect(deps.getMediaAccessStatus).not.toHaveBeenCalled();
    expect(deps.askForMediaAccess).not.toHaveBeenCalled();
    consent.resolve({ response: 1, checkboxChecked: false });
    expect(await result).toBe(true);
    expect(deps.getMediaAccessStatus).toHaveBeenCalledWith("microphone");
  });

  test.each(["destroyed", "contentsDestroyed", "focused"] as const)(
    "rejects an inactive window before consent: %s",
    async (field) => {
      const { request, deps, state } = setup();
      state[field] = field !== "focused";
      expect(await request()).toBe(false);
      expect(deps.showMessageBox).not.toHaveBeenCalled();
    }
  );

  test.each(["destroyed", "contentsDestroyed"] as const)(
    "rechecks the window after consent before OS access: %s",
    async (field) => {
      const { request, deps, state } = setup();
      deps.showMessageBox.mockImplementation(() => {
        state[field] = true;
        return Promise.resolve({ response: 1, checkboxChecked: false });
      });
      expect(await request()).toBe(false);
      expect(deps.getMediaAccessStatus).not.toHaveBeenCalled();
      expect(deps.askForMediaAccess).not.toHaveBeenCalled();
    }
  );

  test.each(["consent", "OS"])(
    "accepts explicit approval when the %s dialog takes focus",
    async (stage) => {
      const { request, deps, state } = setup();
      deps.getMediaAccessStatus.mockReturnValue("not-determined");
      deps.showMessageBox.mockImplementation(() => {
        if (stage === "consent") state.focused = false;
        return Promise.resolve({ response: 1, checkboxChecked: false });
      });
      deps.askForMediaAccess.mockImplementation(() => {
        if (stage === "OS") state.focused = false;
        return Promise.resolve(true);
      });
      expect(await request()).toBe(true);
      expect(state.focused).toBe(false);
    }
  );

  test("does not prompt for an aborted request", async () => {
    const { request, deps, abort } = setup();
    abort.abort();
    expect(await request()).toBe(false);
    expect(deps.showMessageBox).not.toHaveBeenCalled();
  });

  test("aborts pending native consent and ignores a late Allow response", async () => {
    const { request, deps, abort } = setup();
    const consent = deferred<MessageBoxReturnValue>();
    deps.showMessageBox.mockReturnValue(consent.promise);
    const result = request();
    abort.abort();
    expect(await result).toBe(false);
    consent.resolve({ response: 1, checkboxChecked: false });
    await consent.promise;
    expect(deps.getMediaAccessStatus).not.toHaveBeenCalled();
    expect(deps.askForMediaAccess).not.toHaveBeenCalled();
  });

  test("denies access when the native dialog fails", async () => {
    const { request, deps } = setup();
    deps.showMessageBox.mockRejectedValue(new Error("Dialog unavailable"));
    expect(await request()).toBe(false);
    expect(deps.getMediaAccessStatus).not.toHaveBeenCalled();
  });

  test.each(["denied", "restricted", "unknown"] as const)(
    "denies macOS access without an OS prompt for status %s",
    async (status) => {
      const { request, deps } = setup();
      deps.getMediaAccessStatus.mockReturnValue(status);
      expect(await request()).toBe(false);
      expect(deps.askForMediaAccess).not.toHaveBeenCalled();
    }
  );

  test("accepts granted macOS access without another OS prompt", async () => {
    const { request, deps } = setup();
    expect(await request()).toBe(true);
    expect(deps.askForMediaAccess).not.toHaveBeenCalled();
  });

  test.each([true, false])("uses the macOS microphone prompt result: %s", async (allowed) => {
    const { request, deps } = setup();
    deps.getMediaAccessStatus.mockReturnValue("not-determined");
    deps.askForMediaAccess.mockResolvedValue(allowed);
    expect(await request()).toBe(allowed);
    expect(deps.askForMediaAccess).toHaveBeenCalledWith("microphone");
  });

  test("checks macOS settings again after a denial", async () => {
    const { request, deps } = setup();
    deps.getMediaAccessStatus.mockReturnValueOnce("denied").mockReturnValue("granted");
    expect(await request()).toBe(false);
    expect(await request()).toBe(true);
    expect(deps.showMessageBox).toHaveBeenCalledTimes(2);
    expect(deps.getMediaAccessStatus).toHaveBeenCalledTimes(2);
  });

  test("checks macOS settings again after an OS prompt denial", async () => {
    const { request, deps } = setup();
    deps.getMediaAccessStatus.mockReturnValueOnce("not-determined").mockReturnValue("granted");
    deps.askForMediaAccess.mockResolvedValue(false);
    expect(await request()).toBe(false);
    expect(await request()).toBe(true);
    expect(deps.askForMediaAccess).toHaveBeenCalledTimes(1);
  });

  test.each(["darwin", "win32"] as const)(
    "denies access when %s status lookup fails",
    async (platform) => {
      const { request, deps } = setup(platform);
      deps.getMediaAccessStatus.mockImplementation(() => {
        throw new Error("Status unavailable");
      });
      expect(await request()).toBe(false);
      expect(deps.askForMediaAccess).not.toHaveBeenCalled();
    }
  );

  test("denies access when the macOS prompt fails", async () => {
    const { request, deps } = setup();
    deps.getMediaAccessStatus.mockReturnValue("not-determined");
    deps.askForMediaAccess.mockRejectedValue(new Error("Access unavailable"));
    expect(await request()).toBe(false);
  });

  test("aborts pending OS access and ignores a late grant", async () => {
    const { request, deps, abort } = setup();
    const access = deferred<boolean>();
    const started = deferred<void>();
    deps.getMediaAccessStatus.mockReturnValue("not-determined");
    deps.askForMediaAccess.mockImplementation(() => {
      started.resolve();
      return access.promise;
    });
    const result = request();
    await started.promise;
    abort.abort();
    expect(await result).toBe(false);
    access.resolve(true);
    await access.promise;
  });

  test.each(["destroyed", "contentsDestroyed"] as const)(
    "rejects a stale OS grant after the window changes: %s",
    async (field) => {
      const { request, deps, state } = setup();
      deps.getMediaAccessStatus.mockReturnValue("not-determined");
      deps.askForMediaAccess.mockImplementation(() => {
        state[field] = true;
        return Promise.resolve(true);
      });
      expect(await request()).toBe(false);
    }
  );

  test.each(["denied", "restricted", "granted", "not-determined", "unknown"] as const)(
    "uses Windows OS status without a macOS prompt: %s",
    async (status) => {
      const { request, deps } = setup("win32");
      deps.getMediaAccessStatus.mockReturnValue(status);
      expect(await request()).toBe(status !== "denied" && status !== "restricted");
      expect(deps.getMediaAccessStatus).toHaveBeenCalledWith("microphone");
      expect(deps.askForMediaAccess).not.toHaveBeenCalled();
    }
  );

  test("allows Linux access after native consent without OS APIs", async () => {
    const { request, deps } = setup("linux");
    expect(await request()).toBe(true);
    expect(deps.showMessageBox).toHaveBeenCalledTimes(1);
    expect(deps.getMediaAccessStatus).not.toHaveBeenCalled();
    expect(deps.askForMediaAccess).not.toHaveBeenCalled();
  });
});
