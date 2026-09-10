import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Config, ProvidersConfigStore } from "@/node/config";
import { PolicyService } from "./policyService";

const PREFIX = "mux-policy-service-test-";

describe("PolicyService", () => {
  let tempDir: string;
  let policyPath: string;
  let config: Config;
  let prevPolicyFileEnv: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), PREFIX));
    policyPath = path.join(tempDir, "policy.json");
    config = new Config(tempDir);
    prevPolicyFileEnv = process.env.MUX_POLICY_FILE;
  });

  afterEach(async () => {
    if (prevPolicyFileEnv === undefined) {
      delete process.env.MUX_POLICY_FILE;
    } else {
      process.env.MUX_POLICY_FILE = prevPolicyFileEnv;
    }

    await rm(tempDir, { recursive: true, force: true });
  });

  test("disabled when MUX_POLICY_FILE is unset", async () => {
    delete process.env.MUX_POLICY_FILE;

    const service = new PolicyService(config);
    await service.initialize();
    expect(service.getStatus()).toEqual({ state: "disabled" });
    expect(service.getEffectivePolicy()).toBeNull();
    service.dispose();
  });

  test("blocks startup when policy file fails to parse", async () => {
    await writeFile(policyPath, '{"policy_format_version":"0.1",', "utf-8");
    process.env.MUX_POLICY_FILE = policyPath;

    const service = new PolicyService(config);
    await service.initialize();

    const status = service.getStatus();
    expect(status.state).toBe("blocked");
    if (status.state === "blocked") {
      expect(status.reason).toContain("Failed to load policy");
    }

    service.dispose();
  });

  test("blocks startup when minimum_client_version is higher than client", async () => {
    await writeFile(
      policyPath,
      JSON.stringify({
        policy_format_version: "0.1",
        minimum_client_version: "9999.0.0",
      }),
      "utf-8"
    );
    process.env.MUX_POLICY_FILE = policyPath;

    const service = new PolicyService(config);
    await service.initialize();

    const status = service.getStatus();
    expect(status.state).toBe("blocked");
    if (status.state === "blocked") {
      expect(status.reason).toContain("minimum_client_version");
    }

    service.dispose();
  });

  test("enforces provider_access model_access allowlist when non-empty", async () => {
    await writeFile(
      policyPath,
      JSON.stringify({
        policy_format_version: "0.1",
        provider_access: [{ id: "openai", model_access: ["gpt-4"] }],
      }),
      "utf-8"
    );
    process.env.MUX_POLICY_FILE = policyPath;

    const service = new PolicyService(config);
    await service.initialize();

    expect(service.isEnforced()).toBe(true);
    expect(service.isProviderAllowed("openai")).toBe(true);
    expect(service.isProviderAllowed("anthropic")).toBe(false);
    expect(service.isModelAllowed("openai", "gpt-4")).toBe(true);
    expect(service.isModelAllowed("openai", "gpt-3.5")).toBe(false);

    service.dispose();
  });

  test("allows listed custom providers and denies unlisted custom providers", async () => {
    new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
      "local-vllm": {
        providerType: "openai-compatible",
        baseUrl: "http://localhost:8000/v1",
      },
      "another-custom": {
        providerType: "openai-compatible",
        baseUrl: "http://localhost:8001/v1",
      },
    });

    await writeFile(
      policyPath,
      JSON.stringify({
        policy_format_version: "0.1",
        provider_access: [
          { id: "openai" },
          {
            id: "local-vllm",
            base_url: "http://policy.local/v1",
            model_access: ["llama-3"],
          },
        ],
      }),
      "utf-8"
    );
    process.env.MUX_POLICY_FILE = policyPath;

    const service = new PolicyService(config);
    await service.initialize();

    expect(service.isEnforced()).toBe(true);
    expect(service.isProviderAllowed("openai")).toBe(true);
    expect(service.isProviderAllowed("local-vllm")).toBe(true);
    expect(service.isProviderAllowed("another-custom")).toBe(false);
    expect(service.getForcedBaseUrl("local-vllm")).toBe("http://policy.local/v1");
    expect(service.isModelAllowed("local-vllm", "llama-3")).toBe(true);
    expect(service.isModelAllowed("local-vllm", "mistral")).toBe(false);
    expect(service.isModelAllowed("another-custom", "anything")).toBe(false);

    service.dispose();
  });

  test("allows custom providers by default when provider policy is not configured", async () => {
    delete process.env.MUX_POLICY_FILE;
    new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
      "local-vllm": {
        providerType: "openai-compatible",
        baseUrl: "http://localhost:8000/v1",
      },
    });

    const service = new PolicyService(config);
    await service.initialize();

    expect(service.getStatus()).toEqual({ state: "disabled" });
    expect(service.isProviderAllowed("local-vllm")).toBe(true);
    expect(service.isModelAllowed("local-vllm", "llama-3")).toBe(true);

    service.dispose();
  });

  test("treats empty model_access as allow-all for that provider", async () => {
    await writeFile(
      policyPath,
      JSON.stringify({
        policy_format_version: "0.1",
        provider_access: [{ id: "openai", model_access: [] }],
      }),
      "utf-8"
    );
    process.env.MUX_POLICY_FILE = policyPath;

    const service = new PolicyService(config);
    await service.initialize();

    expect(service.isEnforced()).toBe(true);
    expect(service.isModelAllowed("openai", "gpt-4")).toBe(true);
    expect(service.isModelAllowed("openai", "gpt-3.5")).toBe(true);

    service.dispose();
  });

  test("loads policy from a remote URI", async () => {
    const policy = {
      policy_format_version: "0.1",
      provider_access: [{ id: "openai", model_access: ["gpt-4"] }],
    };

    const server = createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify(policy));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to bind test server");
      }

      process.env.MUX_POLICY_FILE = `http://127.0.0.1:${address.port}/policy.json`;

      const service = new PolicyService(config);
      await service.initialize();

      expect(service.isEnforced()).toBe(true);
      expect(service.isProviderAllowed("openai")).toBe(true);
      expect(service.isModelAllowed("openai", "gpt-4")).toBe(true);
      expect(service.isModelAllowed("openai", "gpt-3.5")).toBe(false);

      service.dispose();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("loads policy from Governor when enrolled", async () => {
    delete process.env.MUX_POLICY_FILE;

    const token = "governor-test-token";
    const policy = {
      policy_format_version: "0.1",
      provider_access: [{ id: "openai", model_access: ["gpt-4"] }],
    };

    let receivedAuth: string | undefined;
    let receivedXumAuth: string | undefined;

    const server = createServer((req, res) => {
      // Node lowercases incoming header names. Governor still expects the mux
      // wire token; a Xum-only header would land on a different key and 401.
      receivedAuth = req.headers["mux-governor-session-token"] as string | undefined;
      receivedXumAuth = req.headers["xum-governor-session-token"] as string | undefined;

      if (req.url !== "/api/v1/policy.json") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      if (req.headers["mux-governor-session-token"] !== token) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }

      res.writeHead(200, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify(policy));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to bind test server");
      }

      const governorOrigin = `http://127.0.0.1:${address.port}`;
      await config.editConfig((existing) => ({
        ...existing,
        muxGovernorUrl: governorOrigin,
        muxGovernorToken: token,
      }));

      const service = new PolicyService(config);
      await service.initialize();

      expect(service.getPolicyGetResponse().source).toBe("governor");
      expect(service.isEnforced()).toBe(true);
      expect(service.isProviderAllowed("openai")).toBe(true);
      expect(service.isProviderAllowed("anthropic")).toBe(false);
      expect(receivedAuth).toBe(token);
      expect(receivedXumAuth).toBeUndefined();

      service.dispose();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("MUX_POLICY_FILE takes precedence over Governor enrollment", async () => {
    const token = "governor-test-token";
    const policy = {
      policy_format_version: "0.1",
      provider_access: [{ id: "anthropic", model_access: ["claude-3"] }],
    };

    let requestCount = 0;

    const server = createServer((req, res) => {
      requestCount += 1;

      if (req.url !== "/api/v1/policy.json") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      res.writeHead(200, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify(policy));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to bind test server");
      }

      const governorOrigin = `http://127.0.0.1:${address.port}`;
      await config.editConfig((existing) => ({
        ...existing,
        muxGovernorUrl: governorOrigin,
        muxGovernorToken: token,
      }));

      await writeFile(
        policyPath,
        JSON.stringify({
          policy_format_version: "0.1",
          provider_access: [{ id: "openai", model_access: ["gpt-4"] }],
        }),
        "utf-8"
      );
      process.env.MUX_POLICY_FILE = policyPath;

      const service = new PolicyService(config);
      await service.initialize();

      expect(service.getPolicyGetResponse().source).toBe("env");
      expect(service.isEnforced()).toBe(true);
      expect(service.isProviderAllowed("openai")).toBe(true);
      expect(service.isProviderAllowed("anthropic")).toBe(false);
      expect(requestCount).toBe(0);

      service.dispose();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("refreshNow returns Err on Governor errors and keeps last-known-good", async () => {
    delete process.env.MUX_POLICY_FILE;

    const token = "governor-test-token";
    const policy = {
      policy_format_version: "0.1",
      provider_access: [{ id: "openai", model_access: ["gpt-4"] }],
    };

    let mode: "ok" | "error" = "ok";

    const server = createServer((req, res) => {
      if (req.url !== "/api/v1/policy.json") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      if (mode === "error") {
        res.writeHead(500);
        res.end("boom");
        return;
      }

      res.writeHead(200, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify(policy));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to bind test server");
      }

      const governorOrigin = `http://127.0.0.1:${address.port}`;
      await config.editConfig((existing) => ({
        ...existing,
        muxGovernorUrl: governorOrigin,
        muxGovernorToken: token,
      }));

      const service = new PolicyService(config);
      await service.initialize();

      expect(service.getPolicyGetResponse().source).toBe("governor");
      expect(service.isEnforced()).toBe(true);

      mode = "error";

      const refresh = await service.refreshNow();
      expect(refresh.success).toBe(false);
      if (!refresh.success) {
        expect(refresh.error).toContain("HTTP 500");
      }

      expect(service.isEnforced()).toBe(true);
      expect(service.isProviderAllowed("openai")).toBe(true);
      expect(service.isModelAllowed("openai", "gpt-4")).toBe(true);

      service.dispose();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
