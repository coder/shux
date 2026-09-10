import { describe, expect, test } from "bun:test";
import { resolveViteDevServerEnv } from "./devServerEnv";

describe("resolveViteDevServerEnv", () => {
  test("prefers canonical XUM values when legacy aliases are also set", () => {
    const env = resolveViteDevServerEnv({
      XUM_VITE_HOST: "10.0.0.8",
      MUX_VITE_HOST: "10.0.0.9",
      XUM_VITE_PORT: "5180",
      MUX_VITE_PORT: "5181",
      XUM_BACKEND_HOST: "10.1.0.8",
      MUX_BACKEND_HOST: "10.1.0.9",
      XUM_BACKEND_PORT: "3100",
      MUX_BACKEND_PORT: "3101",
      XUM_ENABLE_TUTORIALS_IN_SANDBOX: "1",
      MUX_ENABLE_TUTORIALS_IN_SANDBOX: "0",
    });

    expect(env.host).toBe("10.0.0.8");
    expect(env.port).toBe(5180);
    expect(env.backendHost).toBe("10.1.0.8");
    expect(env.backendPort).toBe(3100);
    expect(env.enableTutorialsInSandbox).toBe("1");
  });

  test("falls back to leftover MUX values when XUM is unset", () => {
    const env = resolveViteDevServerEnv({
      MUX_VITE_HOST: "10.0.0.9",
      MUX_VITE_PORT: "5181",
      MUX_VITE_ALLOWED_HOSTS: "example.test",
      MUX_BACKEND_PORT: "3101",
    });

    expect(env.host).toBe("10.0.0.9");
    expect(env.port).toBe(5181);
    expect(env.allowedHosts).toEqual(["example.test"]);
    expect(env.backendPort).toBe(3101);
  });
});
