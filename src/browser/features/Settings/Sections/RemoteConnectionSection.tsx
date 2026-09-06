import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/browser/components/Button/Button";
import { Input } from "@/browser/components/Input/Input";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { isMac } from "@/browser/utils/ui/keybinds";
import { REMOTE_CONNECTION_RETURN_ACCELERATOR } from "@/common/constants/remoteConnection";
import {
  getRemoteConnectionServerUrl,
  parseRemoteConnectionUrl,
  type RemoteConnectionState,
} from "@/common/types/remoteConnection";
import { getErrorMessage } from "@/common/utils/errors";

export const REMOTE_CONNECTION_URL_KEY = "remoteConnectionUrl";

const STATUS_LABELS: Record<RemoteConnectionState["status"], string> = {
  disconnected: "Disconnected",
  connecting: "Connecting…",
  connected: "Connected",
};

export function RemoteConnectionSection() {
  const bridge = window.api?.remoteConnection;
  const [savedUrl, setSavedUrl] = usePersistedState(REMOTE_CONNECTION_URL_KEY, "");
  // Keep pasted tokens transient. Save the server pathname for app-proxy connections.
  const [url, setUrl] = useState(() => {
    try {
      return getRemoteConnectionServerUrl(savedUrl);
    } catch {
      return "";
    }
  });
  const [connection, setConnection] = useState<RemoteConnectionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    let receivedUpdate = false;
    // Subscribe first. A later snapshot must not overwrite a newer bridge event.
    const unsubscribe = bridge.onStateChanged((state) => {
      if (disposed) return;
      receivedUpdate = true;
      setConnection(state);
      setError(state.error ?? null);
    });
    bridge.getState().then(
      (state) => {
        if (disposed || receivedUpdate) return;
        setConnection(state);
        setError(state.error ?? null);
      },
      (cause: unknown) => {
        if (disposed || receivedUpdate) return;
        setError(`Cannot read the remote connection state: ${getErrorMessage(cause)}`);
      }
    );
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [bridge]);

  if (!bridge) return null;

  const isConnecting = connecting || connection?.status === "connecting";
  const canConnect = !isConnecting && !disconnecting && connection?.status !== "connected";
  const canDisconnect =
    connection != null && connection.status !== "disconnected" && !disconnecting;
  const returnShortcut = REMOTE_CONNECTION_RETURN_ACCELERATOR.replace(
    "CommandOrControl",
    isMac() ? "Cmd" : "Ctrl"
  );

  // Keep HTTP available for encrypted tunnels without assuming the tunnel makes a secure browser context.
  let showHttpWarning = false;
  try {
    showHttpWarning = parseRemoteConnectionUrl(url).protocol === "http:";
  } catch {
    // Incomplete addresses use the existing validation when the user connects.
  }

  async function handleConnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!bridge || !canConnect) return;
    setError(null);
    try {
      const serverUrl = getRemoteConnectionServerUrl(url);
      setSavedUrl(serverUrl);
      const enteredUrl = url;
      setUrl(serverUrl);
      setConnecting(true);
      await bridge.connect(enteredUrl);
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    if (!bridge || !canDisconnect) return;
    setError(null);
    setDisconnecting(true);
    try {
      await bridge.disconnect();
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <section aria-label="Remote connection" className="min-w-0 space-y-4">
      <div>
        <h3 className="text-foreground text-sm font-medium">Connect to a remote server</h3>
        <p className="text-muted mt-1 text-xs">
          Open a remote Xum server in a separate window. Your local workspaces and tasks keep
          running.
        </p>
      </div>

      <form
        onSubmit={(event) => {
          handleConnect(event).catch((cause: unknown) => setError(getErrorMessage(cause)));
        }}
        className="space-y-3"
      >
        <div className="space-y-1.5">
          <label htmlFor="remote-connection-url" className="text-foreground text-sm font-medium">
            Server URL
          </label>
          <Input
            id="remote-connection-url"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setError(null);
            }}
            placeholder="https://xum.example.com"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="url"
            aria-describedby={
              showHttpWarning
                ? "remote-connection-help remote-connection-http-warning"
                : "remote-connection-help"
            }
            disabled={isConnecting || disconnecting || connection?.status === "connected"}
          />
          <p id="remote-connection-help" className="text-muted text-xs">
            Enter an HTTP or HTTPS URL. You can include a token link. Sign in through the remote web
            UI. The server address and path are saved without tokens. Xum does not connect
            automatically.
          </p>
        </div>
        {showHttpWarning && (
          <div
            id="remote-connection-http-warning"
            role="note"
            aria-label="HTTP connection warning"
            className="bg-warning/10 border-warning/30 text-warning space-y-2 rounded-md border px-3 py-2 text-xs"
          >
            <p>
              HTTP does not encrypt your authentication token or data. Use HTTPS or a trusted
              encrypted tunnel, such as Tailscale.
            </p>
            <p>
              Voice input and other secure-context features require HTTPS for remote addresses, even
              over Tailscale. Browsers treat localhost and loopback addresses as exceptions.
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={!canConnect || !url.trim()}>
            {isConnecting ? "Connecting…" : "Connect"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              handleDisconnect().catch((cause: unknown) =>
                setError(`Cannot disconnect: ${getErrorMessage(cause)}`)
              );
            }}
            disabled={!canDisconnect}
          >
            {disconnecting ? "Disconnecting…" : "Disconnect"}
          </Button>
        </div>
      </form>

      <div role="status" className="text-muted text-xs [overflow-wrap:anywhere]">
        {connection
          ? STATUS_LABELS[connection.status]
          : error
            ? "Connection state unavailable"
            : "Reading connection state…"}
        {connection?.serverUrl && <span> · {connection.serverUrl}</span>}
      </div>
      {error && (
        <p role="alert" className="text-destructive text-xs [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
      <p className="text-muted text-xs">
        Close the remote window to return here.
        <span className="hidden md:inline"> You can also disconnect with {returnShortcut}.</span>
      </p>
    </section>
  );
}
