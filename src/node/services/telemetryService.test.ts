import { describe, expect, test } from "bun:test";

import {
  shouldEnableTelemetry,
  TelemetryService,
  type TelemetryEnablementContext,
} from "./telemetryService";

function createContext(overrides: Partial<TelemetryEnablementContext>): TelemetryEnablementContext {
  return {
    env: overrides.env ?? {},
    isElectron: overrides.isElectron ?? false,
    isPackaged: overrides.isPackaged ?? null,
    disabledByConfig: overrides.disabledByConfig,
  };
}

describe("TelemetryService enablement", () => {
  test("setConfigEnabled applies the persisted truth, not the caller's stale intent", async () => {
    // Concurrent toggles can reorder persist vs apply across RPCs; each queued
    // apply must re-read the persisted state. Here the persisted state says
    // ENABLED while a stale disable applies: the live client must survive.
    let disabled = false;
    const service = new TelemetryService(undefined, () => disabled);
    (service as unknown as { client: unknown }).client = {};

    await service.setConfigEnabled(false);

    expect((service as unknown as { client: unknown }).client).not.toBeNull();
    expect(service.isEnabled()).toBe(true);

    // And a genuine persisted disable still tears the client down.
    disabled = true;
    await service.setConfigEnabled(false);
    expect((service as unknown as { client: unknown }).client).toBeNull();
  });

  test("isEnabled reflects the live config gate, not just the client", () => {
    let disabled = false;
    const service = new TelemetryService(undefined, () => disabled);
    // Simulate an initialized client (unit envs gate real initialization);
    // capture() already refuses per event when the config gate flips, and
    // status surfaces must agree with it.
    (service as unknown as { client: unknown }).client = {};
    expect(service.isEnabled()).toBe(true);

    // A peer process opt-out through the shared config must read as disabled
    // even while this process still holds the client.
    disabled = true;
    expect(service.isEnabled()).toBe(false);
  });

  test("disables telemetry when explicitly disabled", () => {
    const enabled = shouldEnableTelemetry(
      createContext({
        env: { XUM_DISABLE_TELEMETRY: "1" },
        isElectron: true,
        isPackaged: true,
      })
    );

    expect(enabled).toBe(false);
  });

  test("treats leftover MUX_DISABLE_TELEMETRY as an explicit opt-out", () => {
    const enabled = shouldEnableTelemetry(
      createContext({
        env: { MUX_DISABLE_TELEMETRY: "1" },
        isElectron: true,
        isPackaged: true,
      })
    );

    expect(enabled).toBe(false);
  });

  test("canonical XUM_DISABLE_TELEMETRY wins over a leftover MUX value", () => {
    const enabled = shouldEnableTelemetry(
      createContext({
        env: { XUM_DISABLE_TELEMETRY: "0", MUX_DISABLE_TELEMETRY: "1" },
        isElectron: true,
        isPackaged: true,
      })
    );

    expect(enabled).toBe(true);
  });

  test("disables telemetry in E2E runs", () => {
    const enabled = shouldEnableTelemetry(
      createContext({
        env: { XUM_E2E: "1" },
        isElectron: true,
        isPackaged: true,
      })
    );

    expect(enabled).toBe(false);
  });

  test("disables telemetry in test environments", () => {
    const enabled = shouldEnableTelemetry(
      createContext({
        env: { NODE_ENV: "test" },
        isElectron: true,
        isPackaged: true,
      })
    );

    expect(enabled).toBe(false);
  });

  test("disables telemetry in CI environments", () => {
    const enabled = shouldEnableTelemetry(
      createContext({
        env: { CI: "true" },
        isElectron: true,
        isPackaged: true,
      })
    );

    expect(enabled).toBe(false);
  });

  test("enables telemetry in unpackaged Electron by default", () => {
    // Telemetry is now enabled by default in dev mode (unpackaged Electron)
    const enabled = shouldEnableTelemetry(
      createContext({
        env: {},
        isElectron: true,
        isPackaged: false,
      })
    );

    expect(enabled).toBe(true);
  });

  test("enables telemetry in packaged Electron by default", () => {
    const enabled = shouldEnableTelemetry(
      createContext({
        env: {},
        isElectron: true,
        isPackaged: true,
      })
    );

    expect(enabled).toBe(true);
  });

  test("disables telemetry when the config opt-out is set", () => {
    const enabled = shouldEnableTelemetry(
      createContext({
        env: {},
        isElectron: true,
        isPackaged: true,
        disabledByConfig: true,
      })
    );

    expect(enabled).toBe(false);
  });

  test("the env var hard-off wins even when config says enabled", () => {
    const enabled = shouldEnableTelemetry(
      createContext({
        env: { MUX_DISABLE_TELEMETRY: "1" },
        isElectron: true,
        isPackaged: true,
        disabledByConfig: false,
      })
    );

    expect(enabled).toBe(false);
  });

  test("enables telemetry in NODE_ENV=development by default", () => {
    // Telemetry is now enabled by default in dev mode
    const enabled = shouldEnableTelemetry(
      createContext({
        env: { NODE_ENV: "development" },
        isElectron: false,
      })
    );

    expect(enabled).toBe(true);
  });

  test("allows opting into telemetry in unpackaged Electron", () => {
    const enabled = shouldEnableTelemetry(
      createContext({
        env: { MUX_ENABLE_TELEMETRY_IN_DEV: "1" },
        isElectron: true,
        isPackaged: false,
      })
    );

    expect(enabled).toBe(true);
  });

  test("isExplicitlyDisabled reflects the config opt-out like the env var", () => {
    // Features gated on explicit opt-out (e.g. link sharing) must treat the
    // Settings toggle the same as MUX_DISABLE_TELEMETRY=1.
    let disabled = false;
    const service = new TelemetryService(undefined, () => disabled);

    expect(service.isExplicitlyDisabled()).toBe(false);
    disabled = true;
    expect(service.isExplicitlyDisabled()).toBe(true);
  });

  test("dev opt-in does not bypass test env disable", () => {
    const enabled = shouldEnableTelemetry(
      createContext({
        env: {
          NODE_ENV: "test",
          MUX_ENABLE_TELEMETRY_IN_DEV: "1",
        },
        isElectron: false,
      })
    );

    expect(enabled).toBe(false);
  });
});
