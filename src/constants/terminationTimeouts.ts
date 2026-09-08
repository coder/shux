export const TASK_TERMINATION_TOOL_TIMEOUT_MS = 5 * 60 * 1000;
export const TASK_TERMINATION_STOP_STREAM_TIMEOUT_MS = 20 * 1000;
export const TASK_TERMINATION_WORKSPACE_REMOVE_TIMEOUT_MS = 2 * 60 * 1000;
export const WORKTREE_DELETE_GIT_TIMEOUT_MS = 60 * 1000;

/**
 * Bounds the best-effort `git fetch origin <trunk>` before a local worktree is added. A Git
 * credential helper (for example Coder's askpass waiting on missing external auth) can block the
 * fetch indefinitely; after this deadline creation continues from the local trunk.
 */
export const WORKTREE_CREATE_FETCH_TIMEOUT_MS = 15 * 1000;

/**
 * Bounds backup Git calls that can hang on a blackholed remote, while leaving room for a
 * slow initial clone.
 */
export const BACKUP_GIT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Bounds the app Effect runtime's scope close, the last step of
 * `ServiceContainer.dispose()`. Must stay well inside the 5 s quit budgets that
 * `desktop/main.ts` and `cli/server.ts` race the whole dispose against.
 */
export const APP_RUNTIME_DISPOSE_TIMEOUT_MS = 2 * 1000;

/**
 * Bounds the early `AppFiberScope` close in `ServiceContainer.dispose()`
 * (interrupt + await of supervised fibers). Together with the runtime dispose
 * bound this fits inside the same 5 s quit budgets.
 */
export const APP_FIBER_SCOPE_CLOSE_TIMEOUT_MS = 2 * 1000;

/**
 * Bounds how long `ServiceContainer.dispose()` waits for in-flight background
 * startup housekeeping (server mode) to reach its cancellation checkpoint before
 * tearing down the services it uses. Sized to leave the two bounds above room
 * inside the same 5 s quit budgets.
 */
export const STARTUP_HOUSEKEEPING_JOIN_TIMEOUT_MS = 500;

/**
 * Outer budget the `xum server` and ACP roots give the whole
 * `ServiceContainer.dispose()` — the SIGTERM cleanup and the dispose after a
 * failed startup; `desktop/main.ts` races its before-quit dispose against the
 * same 5 s. The bounded steps above are sized to fit inside it.
 */
export const SERVICE_TEARDOWN_BUDGET_MS = 5 * 1000;

/**
 * Bounds each hard startup step of `ServiceContainer.initializeCore()` on the app
 * runtime's clock. A step that has not settled by then fails startup with a
 * `StartupStepTimeoutError` through the same exit path as a throwing step
 * (desktop "Startup Failed" dialog, `xum server`/ACP log-and-exit after the
 * bounded `dispose()`), instead of pinning the splash screen or the listener
 * bind forever. Deliberately generous — a false timeout turns a slow-but-fine
 * start into a crash: sandbox cold starts measured ≤ 60 ms for the slowest core
 * step (`taskService.recoverInterruptedTasks`, which scales with the number of
 * active agent tasks, not with deployment size), so this is ≥ 1000× the observed
 * maximum and still above the policy service's own 10 s fetch timeout.
 */
export const STARTUP_STEP_TIMEOUT_MS = 60 * 1000;
