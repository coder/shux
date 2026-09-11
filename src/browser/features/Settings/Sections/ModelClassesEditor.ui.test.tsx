import { cleanup, render, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installDom } from "../../../../../tests/ui/dom";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import type { APIClient } from "@/browser/contexts/API";

let apiMock: {
  config: {
    getConfig: ReturnType<typeof mock>;
    updateModelClass: ReturnType<typeof mock>;
    onConfigChanged: ReturnType<typeof mock>;
  };
} | null = null;

/** Providers map for the availability warning; null = still loading (warning suppressed). */
let providersConfigMock: Record<string, { isConfigured: boolean; isEnabled?: boolean }> | null =
  null;

void mock.module("@/browser/contexts/API", () => ({
  useOptionalAPI: () => (apiMock ? { api: apiMock } : null),
  // useRouting (imported by the editor) reads the API through useAPI.
  useAPI: () => ({ api: apiMock }),
}));

void mock.module("@/browser/hooks/useProvidersConfig", () => ({
  useProvidersConfig: () => ({ config: providersConfigMock, loading: providersConfigMock == null }),
}));

void mock.module("@/browser/hooks/useModelsFromSettings", () => ({
  useModelsFromSettings: () => ({
    models: ["anthropic:claude-haiku-4-5", "anthropic:claude-sonnet-5", "anthropic:claude-fable-5"],
    hiddenModelsForSelector: [],
  }),
}));

// The editor's real useRouting reads the policy context; render it policy-free
// like ProvidersSection.test does. Mocked here, not inherited: bun module mocks
// are process-global and file order differs per runner, so this file must not
// rely on an earlier suite having registered the same stub.
void mock.module("@/browser/contexts/PolicyContext", () => ({
  usePolicy: () => ({
    status: { state: "disabled" as const },
    policy: null,
  }),
}));

import { ModelClassesEditor } from "./ModelClassesEditor";

function createApiMock(modelClasses: Record<string, string>) {
  return {
    config: {
      getConfig: mock(() => Promise.resolve({ modelClasses })),
      updateModelClass: mock(() => Promise.resolve(undefined)),
      onConfigChanged: mock((_input: undefined, opts: { signal?: AbortSignal }) =>
        Promise.resolve(
          (async function* (): AsyncGenerator<void> {
            // Stay OPEN like the real stream: an iterator that ends reads as a
            // dead subscription and correctly marks the hook stale/unloaded,
            // which would refuse the writes these tests exercise. Resolve only
            // on abort (cleanup).
            await new Promise<void>((resolve) => {
              if (opts.signal?.aborted) {
                resolve();
                return;
              }
              opts.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            yield* [] as void[];
          })()
        )
      ),
    },
  };
}

describe("ModelClassesEditor", () => {
  let restoreDom: (() => void) | null = null;

  beforeEach(() => {
    restoreDom = installDom();
  });

  afterEach(() => {
    cleanup();
    restoreDom?.();
    restoreDom = null;
    apiMock = null;
    providersConfigMock = null;
    getAppConfigStore().setClient(null);
  });

  test("renders the three canonical class rows; clear button only on configured classes", async () => {
    apiMock = createApiMock({ small: "anthropic:claude-haiku-4-5+0" });
    // Row presence is asserted via the labeled row groups, not the select
    // triggers: other suites in the same process (TasksSection) mock
    // SelectPrimitive with native elements, and bun's mock.module leaks across
    // test files, so select internals are not stable to assert on.
    const { getByRole, queryByLabelText } = render(<ModelClassesEditor />);

    await waitFor(() => {
      expect(apiMock?.config.getConfig).toHaveBeenCalled();
      expect(queryByLabelText("Clear model class small")).not.toBeNull();
    });

    for (const name of ["large", "medium", "small"]) {
      expect(getByRole("group", { name: `Model class ${name}` })).toBeTruthy();
    }
    // Unset classes have nothing to clear.
    expect(queryByLabelText("Clear model class large")).toBeNull();
    expect(queryByLabelText("Clear model class medium")).toBeNull();
  });

  test("clearing a canonical class issues a per-entry delete", async () => {
    // Only the edited entry travels: other classes (concurrent consumers'
    // edits, hand-edited values this build cannot parse) are untouched by
    // construction because the backend merges inside its config transaction.
    apiMock = createApiMock({
      small: "anthropic:claude-haiku-4-5+0",
      "my-custom": "anthropic:claude-fable-5+max",
    });
    const { getByLabelText, queryByLabelText } = render(<ModelClassesEditor />);

    await waitFor(() => expect(queryByLabelText("Clear model class small")).not.toBeNull());
    fireEvent.click(getByLabelText("Clear model class small"));

    await waitFor(() => expect(apiMock?.config.updateModelClass).toHaveBeenCalled());
    expect(apiMock?.config.updateModelClass).toHaveBeenCalledTimes(1);
    expect(apiMock?.config.updateModelClass).toHaveBeenCalledWith({
      className: "small",
      model: null,
    });
  });

  test("a write's ack refetches so concurrent peer edits surface", async () => {
    // A peer consumer's notification-triggered fetch can be fenced by this
    // write's ack (the ack's version bump discards in-flight snapshots), and
    // no further notification is guaranteed: the ack must follow up with an
    // authoritative fetch, or the peer's entry would stay invisible
    // indefinitely and a later local edit could overwrite it.
    let currentMap: Record<string, string> = { small: "anthropic:claude-haiku-4-5+0" };
    apiMock = createApiMock({});
    apiMock.config.getConfig = mock(() => Promise.resolve({ modelClasses: currentMap }));
    apiMock.config.updateModelClass = mock((input: { className: string; model: string | null }) => {
      const merged = { ...currentMap };
      if (input.model == null) {
        delete merged[input.className];
      } else {
        merged[input.className] = input.model;
      }
      // A peer consumer's concurrent edit is already in the backend state the
      // ack's refetch reads back.
      merged.medium = "anthropic:claude-sonnet-5+1";
      currentMap = merged;
      return Promise.resolve(undefined);
    });
    const { getByLabelText, queryByLabelText } = render(<ModelClassesEditor />);

    await waitFor(() => expect(queryByLabelText("Clear model class small")).not.toBeNull());
    fireEvent.click(getByLabelText("Clear model class small"));

    await waitFor(() => expect(queryByLabelText("Clear model class medium")).not.toBeNull());
    expect(queryByLabelText("Clear model class small")).toBeNull();
  });

  test("a failed write surfaces the backend's error and the selection reverts", async () => {
    // config.json read-only or full, or the RPC rejecting: the selection snaps
    // back on the failure's refetch, and the user must be told the change was
    // not saved rather than watching it revert silently.
    apiMock = createApiMock({ small: "anthropic:claude-haiku-4-5+0" });
    let failWrites = true;
    apiMock.config.updateModelClass = mock(() =>
      failWrites
        ? Promise.reject(new Error("EROFS: read-only file system"))
        : Promise.resolve(undefined)
    );
    const { getByLabelText, getByRole, queryByLabelText, queryByRole } = render(
      <ModelClassesEditor />
    );

    await waitFor(() => expect(queryByLabelText("Clear model class small")).not.toBeNull());
    fireEvent.click(getByLabelText("Clear model class small"));
    await waitFor(() => expect(getByRole("alert").textContent).toContain("read-only file system"));
    // Reverted to the backend's value: the class is still configured.
    expect(queryByLabelText("Clear model class small")).not.toBeNull();

    // The next write attempt clears the stale error.
    failWrites = false;
    fireEvent.click(getByLabelText("Clear model class small"));
    await waitFor(() => expect(queryByRole("alert")).toBeNull());
  });

  test("a fetch resolving after the subscription dies cannot enable editing", async () => {
    // Transport death race: the subscription ends (without abort-driven
    // cleanup) while the post-subscribe getConfig is still pending. Letting
    // that late fetch land as fresh would re-enable full-map writes on a map
    // whose peer edits are invisible — the resolved map must stay fenced
    // until the resubscribe's own fetch re-establishes truth.
    // Object property (not a let binding): TS keeps a closure-assigned let
    // narrowed to its null initializer, but property narrowing resets at the
    // waitFor call below.
    const configGate: {
      resolve: ((value: { modelClasses: Record<string, string> }) => void) | null;
    } = { resolve: null };
    apiMock = {
      config: {
        getConfig: mock(
          () =>
            new Promise<{ modelClasses: Record<string, string> }>((resolve) => {
              configGate.resolve = resolve;
            })
        ),
        updateModelClass: mock(() => Promise.resolve(undefined)),
        onConfigChanged: mock((_input: undefined, _opts: { signal?: AbortSignal }) =>
          Promise.resolve(
            (async function* (): AsyncGenerator<void> {
              // Ends immediately: a dead subscription, not cleanup.
              await Promise.resolve();
              yield* [] as void[];
            })()
          )
        ),
      },
    };
    const { queryByLabelText } = render(<ModelClassesEditor />);

    // The hook subscribes, starts the fetch, then observes the stream die.
    await waitFor(() => expect(apiMock?.config.getConfig).toHaveBeenCalled());
    configGate.resolve?.({ modelClasses: { small: "anthropic:claude-haiku-4-5+0" } });
    // Let any (wrongly) accepted state publish before asserting.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Whether the fetch was discarded outright (no row value surfaces) or
    // published display-only (row rendered but disabled), editing must be
    // impossible: a click on a disabled clear button is inert.
    const clearButton = queryByLabelText("Clear model class small");
    if (clearButton) {
      fireEvent.click(clearButton);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(apiMock.config.updateModelClass).not.toHaveBeenCalled();
  });

  test("lists custom classes as config-managed instead of hiding them", async () => {
    apiMock = createApiMock({ "my-custom": "anthropic:claude-fable-5+max" });
    const { findByText } = render(<ModelClassesEditor />);

    expect(await findByText(/my-custom → anthropic:claude-fable-5\+max/)).toBeTruthy();
  });

  test("flags an unparseable configured value instead of silently dropping it", async () => {
    apiMock = createApiMock({ small: "garbage" });
    const { findByText } = render(<ModelClassesEditor />);

    expect(await findByText(/invalid value: garbage/)).toBeTruthy();
  });

  test("warns when no configured route can serve a class model", async () => {
    apiMock = createApiMock({ small: "anthropic:claude-haiku-4-5+0" });
    // The warning gates on useRouting's `loaded`, which reads the shared
    // AppConfigStore singleton — prime it like useRouting.test does.
    getAppConfigStore().setClient(apiMock as unknown as APIClient);
    providersConfigMock = { anthropic: { isConfigured: false } };
    const { findByText } = render(<ModelClassesEditor />);

    expect(await findByText(/no configured route can serve this model/)).toBeTruthy();
  });

  test("does not warn when the class model has a configured route", async () => {
    apiMock = createApiMock({ small: "anthropic:claude-haiku-4-5+0" });
    providersConfigMock = { anthropic: { isConfigured: true, isEnabled: true } };
    const { queryByText, queryByLabelText } = render(<ModelClassesEditor />);

    await waitFor(() => expect(queryByLabelText("Clear model class small")).not.toBeNull());
    expect(queryByText(/no configured route can serve this model/)).toBeNull();
  });

  test("a peer change notification disables edits until its refetch lands", async () => {
    // Between a config-changed notification and the fetch it triggers, the
    // rendered map is stale: an edit composed from it would overwrite the
    // peer's value for that class, and the post-write refetch could not
    // recover it. The row's controls must be inert until the refetch publishes.
    // Object properties (not let bindings): TS keeps a closure-assigned let
    // narrowed to its null initializer.
    const notification: { release: (() => void) | null } = { release: null };
    const configGate: {
      resolve: ((value: { modelClasses: Record<string, string> }) => void) | null;
    } = { resolve: null };
    let fetches = 0;
    apiMock = {
      config: {
        getConfig: mock(() => {
          fetches += 1;
          if (fetches === 1) {
            return Promise.resolve({ modelClasses: { small: "anthropic:claude-haiku-4-5+0" } });
          }
          return new Promise<{ modelClasses: Record<string, string> }>((resolve) => {
            configGate.resolve = resolve;
          });
        }),
        updateModelClass: mock(() => Promise.resolve(undefined)),
        onConfigChanged: mock((_input: undefined, opts: { signal?: AbortSignal }) =>
          Promise.resolve(
            (async function* (): AsyncGenerator<void> {
              // One peer notification, released by the test; then stay open
              // like the real stream until cleanup aborts.
              await new Promise<void>((resolve) => {
                notification.release = resolve;
              });
              yield;
              await new Promise<void>((resolve) => {
                if (opts.signal?.aborted) {
                  resolve();
                  return;
                }
                opts.signal?.addEventListener("abort", () => resolve(), { once: true });
              });
            })()
          )
        ),
      },
    };
    const { getByLabelText, queryByLabelText } = render(<ModelClassesEditor />);
    await waitFor(() => expect(queryByLabelText("Clear model class small")).not.toBeNull());
    expect((getByLabelText("Clear model class small") as HTMLButtonElement).disabled).toBe(false);

    notification.release?.();
    await waitFor(() => expect(fetches).toBe(2));
    // Untrusted while the notification's fetch is outstanding: a click is inert.
    const clearButton = getByLabelText("Clear model class small") as HTMLButtonElement;
    expect(clearButton.disabled).toBe(true);
    fireEvent.click(clearButton);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(apiMock.config.updateModelClass).not.toHaveBeenCalled();

    // The refetch publishes the peer's value and re-enables editing.
    configGate.resolve?.({ modelClasses: { small: "anthropic:claude-sonnet-5+1" } });
    await waitFor(() =>
      expect((getByLabelText("Clear model class small") as HTMLButtonElement).disabled).toBe(false)
    );
  });
});
