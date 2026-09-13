import type {
  BrowserWindow,
  MessageBoxOptions,
  MessageBoxReturnValue,
  SystemPreferences,
} from "electron";
import { getRemoteConnectionServerUrl } from "@/common/types/remoteConnection";
import { log } from "@/node/services/log";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";

interface RemoteMicrophonePermissionDependencies {
  platform: NodeJS.Platform;
  showMessageBox(window: BrowserWindow, options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
  getMediaAccessStatus(
    mediaType: "microphone"
  ): ReturnType<SystemPreferences["getMediaAccessStatus"]>;
  askForMediaAccess(mediaType: "microphone"): Promise<boolean>;
}

/** Require native consent before remote content can request OS microphone access. */
export function createRemoteMicrophonePermission(deps: RemoteMicrophonePermissionDependencies) {
  return async (
    window: BrowserWindow,
    serverUrl: string,
    signal: AbortSignal
  ): Promise<boolean> => {
    // Native and OS dialogs can own focus. Recheck identity and liveness, not focus, after consent.
    const isRequestCurrent = () =>
      !signal.aborted && !window.isDestroyed() && !window.webContents.isDestroyed();

    try {
      if (!isRequestCurrent() || !window.isFocused()) return false;
      // A remote page cannot prove a user gesture. Require consent in trusted native UI.
      const consent = await raceWithAbortAndTimeout(
        deps.showMessageBox(window, {
          type: "question",
          title: "Remote microphone access",
          message: "Allow this remote server to use your microphone?",
          detail: getRemoteConnectionServerUrl(serverUrl),
          buttons: ["Deny", "Allow"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          signal,
        }),
        { signal }
      );
      if (consent.kind !== "ok" || consent.value.response !== 1 || !isRequestCurrent())
        return false;

      // Recheck OS settings on every request so a previous denial does not block retries.
      switch (deps.platform) {
        case "darwin": {
          const status = deps.getMediaAccessStatus("microphone");
          if (status === "granted") return isRequestCurrent();
          if (status !== "not-determined") return false;
          const access = await raceWithAbortAndTimeout(deps.askForMediaAccess("microphone"), {
            signal,
          });
          return access.kind === "ok" && access.value && isRequestCurrent();
        }
        case "win32": {
          const status = deps.getMediaAccessStatus("microphone");
          return status !== "denied" && status !== "restricted" && isRequestCurrent();
        }
        case "linux":
          return isRequestCurrent();
        default:
          return false;
      }
    } catch {
      if (!signal.aborted) log.warn("Cannot approve remote microphone access.");
      return false;
    }
  };
}
