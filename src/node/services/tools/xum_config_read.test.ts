import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, it } from "bun:test";
import type { ToolExecutionOptions } from "ai";

const GLOBAL_WORKSPACE_ID = "workspace-global";
import type { XumToolScope } from "@/common/types/toolScope";
import { REDACTED_SECRET_VALUE } from "@/node/services/tools/shared/configRedaction";

import { createXumConfigReadTool } from "./xum_config_read";
import { TestTempDir, createTestToolConfig } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

interface XumConfigReadSuccess {
  success: true;
  file: "providers" | "config";
  data: unknown;
}

interface XumConfigReadError {
  success: false;
  error: string;
}

type XumConfigReadResult = XumConfigReadSuccess | XumConfigReadError;

async function createReadTool(
  xumHomeDir: string,
  workspaceId: string,
  xumScope: XumToolScope = { type: "global", xumHome: xumHomeDir }
) {
  const workspaceSessionDir = path.join(xumHomeDir, "sessions", workspaceId);
  await fs.mkdir(workspaceSessionDir, { recursive: true });

  const config = createTestToolConfig(xumHomeDir, {
    workspaceId,
    sessionsDir: workspaceSessionDir,
    xumScope,
  });

  return createXumConfigReadTool(config);
}

describe("mux_config_read", () => {
  it("returns redacted providers data for full and path reads", async () => {
    using xumHome = new TestTempDir("mux-config-read");

    await fs.writeFile(
      path.join(xumHome.path, "providers.jsonc"),
      JSON.stringify(
        {
          anthropic: {
            apiKey: "sk-ant-secret",
            headers: {
              Authorization: "Bearer super-secret",
              "x-trace-id": "safe-value",
            },
          },
          openrouter: {
            apiKey: "or-secret",
            order: "quality",
          },
          "custom-llm": {
            token: "top-secret-token",
            clientSecret: "client-secret-value",
            nested: { authToken: "nested-secret" },
            tokenizer: "cl100k_base",
            baseUrl: "https://custom.example.com",
            privateKey: "pk-super-secret",
            clientKey: "ck-hidden-value",
          },
          "custom-auth": {
            serviceKey: "svc-key-secret",
            nested: { signingKey: "sign-key-value" },
            displayName: "Custom Auth Provider",
          },
          "custom-plural": {
            apiKeys: ["key-1", "key-2"],
            accessTokens: "plural-token-secret",
            clientSecrets: "plural-client-secret",
            nested: { signingKeys: "nested-plural-signing" },
            displayName: "Plural Provider",
          },
          "custom-http": {
            httpHeaders: {
              Authorization: "Bearer http-header-secret",
              "x-trace-id": "safe-trace",
            },
            baseUrl: "https://custom-http.example.com",
          },
          "custom-caps": {
            Headers: {
              "x-api-key": "caps-api-key-secret",
              Accept: "application/json",
            },
            baseUrl: "https://custom-caps.example.com",
          },
          "custom-request": {
            requestHeaders: {
              Authorization: "Bearer request-header-secret",
              "x-request-id": "safe-request-id",
            },
            baseUrl: "https://custom-request.example.com",
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const tool = await createReadTool(xumHome.path, GLOBAL_WORKSPACE_ID);

    const fullResult = (await tool.execute!(
      { file: "providers" },
      mockToolCallOptions
    )) as XumConfigReadResult;

    expect(fullResult.success).toBe(true);
    if (fullResult.success) {
      expect(fullResult.data).toMatchObject({
        anthropic: {
          apiKey: REDACTED_SECRET_VALUE,
          headers: {
            Authorization: REDACTED_SECRET_VALUE,
            "x-trace-id": "safe-value",
          },
        },
        openrouter: {
          apiKey: REDACTED_SECRET_VALUE,
          order: "quality",
        },
      });

      // Generic secret-like keys in custom providers are redacted.
      const customData = (fullResult.data as Record<string, unknown>)["custom-llm"] as Record<
        string,
        unknown
      >;
      expect(customData.token).toBe(REDACTED_SECRET_VALUE);
      expect(customData.clientSecret).toBe(REDACTED_SECRET_VALUE);
      expect((customData.nested as Record<string, unknown>).authToken).toBe(REDACTED_SECRET_VALUE);
      expect(customData.privateKey).toBe(REDACTED_SECRET_VALUE);
      expect(customData.clientKey).toBe(REDACTED_SECRET_VALUE);
      // Non-secret keys are preserved.
      expect(customData.tokenizer).toBe("cl100k_base");
      expect(customData.baseUrl).toBe("https://custom.example.com");

      const customAuthData = (fullResult.data as Record<string, unknown>)["custom-auth"] as Record<
        string,
        unknown
      >;
      expect(customAuthData.serviceKey).toBe(REDACTED_SECRET_VALUE);
      expect((customAuthData.nested as Record<string, unknown>).signingKey).toBe(
        REDACTED_SECRET_VALUE
      );
      // Non-secret keys are preserved.
      expect(customAuthData.displayName).toBe("Custom Auth Provider");

      const customPluralData = (fullResult.data as Record<string, unknown>)[
        "custom-plural"
      ] as Record<string, unknown>;
      expect(customPluralData.apiKeys).toBe(REDACTED_SECRET_VALUE);
      expect(customPluralData.accessTokens).toBe(REDACTED_SECRET_VALUE);
      expect(customPluralData.clientSecrets).toBe(REDACTED_SECRET_VALUE);
      expect((customPluralData.nested as Record<string, unknown>).signingKeys).toBe(
        REDACTED_SECRET_VALUE
      );
      // Non-secret keys are preserved.
      expect(customPluralData.displayName).toBe("Plural Provider");

      // Header aliases are redacted.
      const customHttpData = (fullResult.data as Record<string, unknown>)["custom-http"] as Record<
        string,
        unknown
      >;
      expect(customHttpData.httpHeaders).toEqual({
        Authorization: REDACTED_SECRET_VALUE,
        "x-trace-id": "safe-trace",
      });
      expect(customHttpData.baseUrl).toBe("https://custom-http.example.com");

      const customCapsData = (fullResult.data as Record<string, unknown>)["custom-caps"] as Record<
        string,
        unknown
      >;
      expect(customCapsData.Headers).toEqual({
        "x-api-key": REDACTED_SECRET_VALUE,
        Accept: "application/json",
      });

      const customRequestData = (fullResult.data as Record<string, unknown>)[
        "custom-request"
      ] as Record<string, unknown>;
      expect(customRequestData.requestHeaders).toEqual({
        Authorization: REDACTED_SECRET_VALUE,
        "x-request-id": "safe-request-id",
      });

      const serialized = JSON.stringify(fullResult.data);
      expect(serialized).not.toContain("sk-ant-secret");
      expect(serialized).not.toContain("or-secret");
      expect(serialized).not.toContain("super-secret");
      expect(serialized).not.toContain("top-secret-token");
      expect(serialized).not.toContain("client-secret-value");
      expect(serialized).not.toContain("nested-secret");
      expect(serialized).not.toContain("pk-super-secret");
      expect(serialized).not.toContain("ck-hidden-value");
      expect(serialized).not.toContain("svc-key-secret");
      expect(serialized).not.toContain("sign-key-value");
      expect(serialized).not.toContain("key-1");
      expect(serialized).not.toContain("plural-token-secret");
      expect(serialized).not.toContain("plural-client-secret");
      expect(serialized).not.toContain("nested-plural-signing");
      expect(serialized).not.toContain("http-header-secret");
      expect(serialized).not.toContain("caps-api-key-secret");
      expect(serialized).not.toContain("request-header-secret");
    }

    const pathResult = (await tool.execute!(
      { file: "providers", path: ["anthropic", "apiKey"] },
      mockToolCallOptions
    )) as XumConfigReadResult;

    expect(pathResult.success).toBe(true);
    if (pathResult.success) {
      expect(pathResult.data).toBe(REDACTED_SECRET_VALUE);
    }

    const tokenPathResult = (await tool.execute!(
      { file: "providers", path: ["custom-llm", "token"] },
      mockToolCallOptions
    )) as XumConfigReadResult;

    expect(tokenPathResult.success).toBe(true);
    if (tokenPathResult.success) {
      expect(tokenPathResult.data).toBe(REDACTED_SECRET_VALUE);
    }

    const pluralTokenPathResult = (await tool.execute!(
      { file: "providers", path: ["custom-plural", "accessTokens"] },
      mockToolCallOptions
    )) as XumConfigReadResult;

    expect(pluralTokenPathResult.success).toBe(true);
    if (pluralTokenPathResult.success) {
      expect(pluralTokenPathResult.data).toBe(REDACTED_SECRET_VALUE);
    }

    const privateKeyPathResult = (await tool.execute!(
      { file: "providers", path: ["custom-llm", "privateKey"] },
      mockToolCallOptions
    )) as XumConfigReadResult;

    expect(privateKeyPathResult.success).toBe(true);
    if (privateKeyPathResult.success) {
      expect(privateKeyPathResult.data).toBe(REDACTED_SECRET_VALUE);
    }

    const httpHeaderPathResult = (await tool.execute!(
      { file: "providers", path: ["custom-http", "httpHeaders", "Authorization"] },
      mockToolCallOptions
    )) as XumConfigReadResult;

    expect(httpHeaderPathResult.success).toBe(true);
    if (httpHeaderPathResult.success) {
      expect(httpHeaderPathResult.data).toBe(REDACTED_SECRET_VALUE);
    }
  });

  it("redacts config token fields", async () => {
    using xumHome = new TestTempDir("mux-config-read");

    await fs.writeFile(
      path.join(xumHome.path, "config.json"),
      JSON.stringify(
        {
          muxGovernorToken: "token-123",
          defaultModel: "anthropic:claude-sonnet-4-20250514",
        },
        null,
        2
      ),
      "utf-8"
    );

    const tool = await createReadTool(xumHome.path, GLOBAL_WORKSPACE_ID);

    const result = (await tool.execute!(
      { file: "config" },
      mockToolCallOptions
    )) as XumConfigReadResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        muxGovernorToken: REDACTED_SECRET_VALUE,
        defaultModel: "anthropic:claude-sonnet-4-20250514",
      });

      expect(JSON.stringify(result.data)).not.toContain("token-123");
    }
  });

  it("returns null for inherited prototype property names in path", async () => {
    using xumHome = new TestTempDir("mux-config-read");

    await fs.writeFile(
      path.join(xumHome.path, "config.json"),
      JSON.stringify({ defaultModel: "anthropic:claude-sonnet-4-20250514" }, null, 2),
      "utf-8"
    );

    const tool = await createReadTool(xumHome.path, GLOBAL_WORKSPACE_ID);

    // "constructor" is inherited from Object.prototype — must not be traversable
    const constructorResult = (await tool.execute!(
      { file: "config", path: ["constructor"] },
      mockToolCallOptions
    )) as XumConfigReadResult;
    expect(constructorResult.success).toBe(true);
    if (constructorResult.success) {
      expect(constructorResult.data).toBeNull();
    }

    // Nested prototype traversal: ["constructor", "name"] would yield "Object" without fix
    const nestedResult = (await tool.execute!(
      { file: "config", path: ["constructor", "name"] },
      mockToolCallOptions
    )) as XumConfigReadResult;
    expect(nestedResult.success).toBe(true);
    if (nestedResult.success) {
      expect(nestedResult.data).toBeNull();
    }
  });

  it("reads parseable but schema-invalid config data for recovery", async () => {
    using xumHome = new TestTempDir("mux-config-read");

    // Seed a config with an out-of-range value that fails schema validation
    await fs.writeFile(
      path.join(xumHome.path, "config.json"),
      JSON.stringify(
        {
          taskSettings: { maxParallelAgentTasks: 999 },
          defaultModel: "anthropic:claude-sonnet-4-20250514",
        },
        null,
        2
      ),
      "utf-8"
    );

    const tool = await createReadTool(xumHome.path, GLOBAL_WORKSPACE_ID);
    const result = (await tool.execute!(
      { file: "config" },
      mockToolCallOptions
    )) as XumConfigReadResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        taskSettings: { maxParallelAgentTasks: 999 },
        defaultModel: "anthropic:claude-sonnet-4-20250514",
      });
    }
  });

  it("fails when config file contains malformed JSON", async () => {
    using xumHome = new TestTempDir("mux-config-read");

    await fs.writeFile(path.join(xumHome.path, "config.json"), "{ not valid json !!!", "utf-8");

    const tool = await createReadTool(xumHome.path, GLOBAL_WORKSPACE_ID);
    const result = (await tool.execute!(
      { file: "config" },
      mockToolCallOptions
    )) as XumConfigReadResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Failed to read mux config");
    }
  });
});
