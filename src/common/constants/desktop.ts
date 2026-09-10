/**
 * Default configuration for PortableDesktop sessions.
 */
export const DESKTOP_DEFAULTS = {
  /** Default display width in pixels. */
  WIDTH: 1024,
  /** Default display height in pixels. */
  HEIGHT: 768,
  /** Binary name to look for on PATH or in cache. */
  BINARY_NAME: "portabledesktop",
  /** Subdirectory name inside mux cache for the desktop binary. */
  CACHE_DIR_NAME: "portabledesktop",
  /** Maximum time (ms) to wait for the desktop process to start. */
  STARTUP_TIMEOUT_MS: 30_000,
  /** Maximum time (ms) to wait for a screenshot command. */
  SCREENSHOT_TIMEOUT_MS: 10_000,
  /** Maximum time (ms) a desktop bridge token is valid. */
  TOKEN_TTL_MS: 30_000,
  /** Base delay (ms) before the first reconnect attempt. */
  RECONNECT_BASE_DELAY_MS: 1_000,
  /** Maximum delay (ms) between reconnect attempts (caps exponential backoff). */
  RECONNECT_MAX_DELAY_MS: 30_000,
  /** Maximum time (ms) to wait for another backend's desktop input/admission. */
  INPUT_LOCK_TIMEOUT_MS: 60_000,
  /** Maximum time (ms) to wait for an action command. */
  ACTION_TIMEOUT_MS: 10_000,
} as const;

/** Bounds a failed popout startup; handoff itself uses explicit readiness messages. */
export const DESKTOP_POPOUT_READY_TIMEOUT_MS = 15_000;

export const DESKTOP_POPOUT_CLOSE_EVENT = "xum-desktop-popout-close";
/** Browser windows have no closed event; only sample their authoritative closed flag. */
export const DESKTOP_POPOUT_CLOSE_POLL_MS = 100;

/** Bound a viewer disconnect while still allowing queued input releases to flush. */
export const DESKTOP_VIEWER_DISCONNECT_TIMEOUT_MS = 500;
/** Allow browser viewers to release input and acknowledge over the authenticated transport. */
export const DESKTOP_VIEWER_RELEASE_TIMEOUT_MS = 3_000;

/**
 * How long a workspace's desktop still counts as attached after its last known viewer or VNC
 * bridge detached. Agent-driven archive gates consult this so the transitional windows between
 * two independent client transports (reconnect backoff, viewer re-registration, inline↔popout
 * handoffs) cannot be mistaken for "nobody is watching"; no deterministic signal spans them.
 * Covers one full reconnect backoff plus the cooperative release timeout. Bounded on purpose: a
 * client gone for longer is indistinguishable from a closed pane.
 */
export const DESKTOP_ATTACHMENT_GRACE_MS =
  DESKTOP_DEFAULTS.RECONNECT_MAX_DELAY_MS + DESKTOP_VIEWER_RELEASE_TIMEOUT_MS;
