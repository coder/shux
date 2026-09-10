export const REMOTE_CONNECTION_LOAD_TIMEOUT_MS = 30_000;
// Keep gesture checks outside the page world and Electron's reserved preload world.
export const REMOTE_CONNECTION_GESTURE_WORLD_ID = 1001;
export const REMOTE_CONNECTION_RETURN_KEY = "L";
export const REMOTE_CONNECTION_RETURN_ACCELERATOR = `CommandOrControl+Shift+${REMOTE_CONNECTION_RETURN_KEY}`;

// Remote wrappers reject editor placeholders before the renderer records an editor open.
export const REMOTE_CONNECTION_EDITOR_FRAME_NAME_PREFIX = "xum-editor-launch-";

export const REMOTE_CONNECTION_CHANNELS = {
  getState: "xum:remote-connection:get-state",
  connect: "xum:remote-connection:connect",
  disconnect: "xum:remote-connection:disconnect",
  stateChanged: "xum:remote-connection:state-changed",
} as const;
