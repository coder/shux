/** Local desktop controls. Remote pages never receive this bridge. */
export interface RemoteConnectionApi {
  getState(): Promise<RemoteConnectionState>;
  connect(url: string): Promise<void>;
  disconnect(): Promise<void>;
  onStateChanged(callback: (state: RemoteConnectionState) => void): () => void;
}

export interface RemoteConnectionState {
  /** The server origin excludes credentials and URL tokens. */
  origin: string | null;
  status: "disconnected" | "connecting" | "connected";
  error?: string;
}

/** Validate a server address before opening remote content. */
export function parseRemoteConnectionUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Enter a valid HTTP or HTTPS server URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Use an HTTP or HTTPS server URL.");
  }
  if (url.username || url.password) {
    throw new Error("Remove the username and password from the server URL.");
  }
  return url;
}
