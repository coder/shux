import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { TelemetryService } from "./telemetryService";
import type { TelemetryEventPayload } from "@/common/telemetry/payload";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

describe("TelemetryService feature flag properties", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-telemetry-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("capture includes $feature/<flagKey> properties when set", () => {
    // The capture method checks isTelemetryDisabledByEnv which checks NODE_ENV=test,
    // JEST_WORKER_ID, VITEST, CI, etc. We need to temporarily clear these for the test.
    const savedEnv = {
      NODE_ENV: process.env.NODE_ENV,
      JEST_WORKER_ID: process.env.JEST_WORKER_ID,
      VITEST: process.env.VITEST,
      CI: process.env.CI,
      GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
      XUM_DISABLE_TELEMETRY: process.env.XUM_DISABLE_TELEMETRY,
      MUX_DISABLE_TELEMETRY: process.env.MUX_DISABLE_TELEMETRY,
      XUM_E2E: process.env.XUM_E2E,
      MUX_E2E: process.env.MUX_E2E,
      TEST_INTEGRATION: process.env.TEST_INTEGRATION,
    };

    // Clear all telemetry-disabling env vars
    process.env.NODE_ENV = "production";
    delete process.env.JEST_WORKER_ID;
    delete process.env.VITEST;
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.XUM_DISABLE_TELEMETRY;
    delete process.env.MUX_DISABLE_TELEMETRY;
    delete process.env.XUM_E2E;
    delete process.env.MUX_E2E;
    delete process.env.TEST_INTEGRATION;

    try {
      const telemetry = new TelemetryService(tempDir);

      const capture = mock((_args: unknown) => undefined);

      // NOTE: TelemetryService only checks that client + distinctId are set.
      // We set them directly to avoid any real network calls.
      // @ts-expect-error - Accessing private property for test
      telemetry.client = { capture };
      // @ts-expect-error - Accessing private property for test
      telemetry.distinctId = "distinct-id";

      telemetry.setFeatureFlagVariant("programmatic-tool-calling", "test");

      const payload: TelemetryEventPayload = {
        event: "message_sent",
        properties: {
          workspaceId: "workspace-id",
          model: "test-model",
          agentId: "exec",
          message_length_b2: 128,
          runtimeType: "local",
          frontendPlatform: {
            userAgent: "ua",
            platform: "platform",
          },
          thinkingLevel: "off",
        },
      };

      telemetry.capture(payload);

      expect(capture).toHaveBeenCalled();

      const call = capture.mock.calls[0]?.[0] as
        | { properties?: Record<string, unknown> }
        | undefined;
      expect(call?.properties).toBeDefined();
      expect(call?.properties?.["$feature/programmatic-tool-calling"]).toBe("test");
    } finally {
      // Restore all env vars
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
