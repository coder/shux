import { describe, expect, test } from "bun:test";

import { shouldEnableTelemetry, type TelemetryEnablementContext } from "./telemetryService";

function createContext(overrides: Partial<TelemetryEnablementContext>): TelemetryEnablementContext {
  return {
    env: overrides.env ?? {},
    isElectron: overrides.isElectron ?? false,
    isPackaged: overrides.isPackaged ?? null,
  };
}

describe("TelemetryService enablement", () => {
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
