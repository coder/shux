import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, it } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import * as jsonc from "jsonc-parser";

const GLOBAL_WORKSPACE_ID = "workspace-global";
import type { XumToolScope } from "@/common/types/toolScope";

import { projectRegistrationLockFilePath } from "@/node/config/projectRegistrationLock";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";

import { createXumConfigWriteTool } from "./xum_config_write";
import { TestTempDir, createTestToolConfig } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

interface XumConfigWriteValidationIssue {
  path: Array<string | number>;
  message: string;
}

interface XumConfigWriteSuccess {
  success: true;
  file: "providers" | "config";
  appliedOps: number;
  summary: string;
}

interface XumConfigWriteError {
  success: false;
  error: string;
  validationIssues?: XumConfigWriteValidationIssue[];
}

type XumConfigWriteResult = XumConfigWriteSuccess | XumConfigWriteError;

async function createWriteTool(
  xumHomeDir: string,
  workspaceId: string,
  onConfigChanged?: () => void,
  xumScope: XumToolScope = { type: "global", xumHome: xumHomeDir }
) {
  const workspaceSessionDir = path.join(xumHomeDir, "sessions", workspaceId);
  await fs.mkdir(workspaceSessionDir, { recursive: true });

  const config = createTestToolConfig(xumHomeDir, {
    workspaceId,
    sessionsDir: workspaceSessionDir,
    xumScope,
  });
  config.onConfigChanged = onConfigChanged;

  return createXumConfigWriteTool(config);
}

describe("mux_config_write", () => {
  it("enforces explicit confirm gate", async () => {
    using xumHome = new TestTempDir("mux-config-write");

    const tool = await createWriteTool(xumHome.path, GLOBAL_WORKSPACE_ID);
    const result = (await tool.execute!(
      {
        file: "providers",
        operations: [{ op: "set", path: ["anthropic", "apiKey"], value: "sk-ant-123" }],
        confirm: false,
      },
      mockToolCallOptions
    )) as XumConfigWriteResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("confirm");
    }
  });

  it("writes valid providers mutations (anthropic, openrouter, bedrock)", async () => {
    using xumHome = new TestTempDir("mux-config-write");

    let onConfigChangedCalls = 0;
    const tool = await createWriteTool(xumHome.path, GLOBAL_WORKSPACE_ID, () => {
      onConfigChangedCalls += 1;
    });

    const result = (await tool.execute!(
      {
        file: "providers",
        operations: [
          { op: "set", path: ["anthropic", "apiKey"], value: "sk-ant-123" },
          { op: "set", path: ["anthropic", "cacheTtl"], value: "5m" },
          { op: "set", path: ["openrouter", "apiKey"], value: "or-123" },
          { op: "set", path: ["openrouter", "order"], value: "quality" },
          { op: "set", path: ["openrouter", "allow_fallbacks"], value: true },
          { op: "set", path: ["bedrock", "region"], value: "us-east-1" },
          { op: "set", path: ["bedrock", "accessKeyId"], value: "AKIA..." },
        ],
        confirm: true,
      },
      mockToolCallOptions
    )) as XumConfigWriteResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.appliedOps).toBe(7);
    }
    expect(onConfigChangedCalls).toBe(1);

    const rawProviders = await fs.readFile(path.join(xumHome.path, "providers.jsonc"), "utf-8");
    const providersDocument: unknown = jsonc.parse(rawProviders);

    expect(providersDocument).toMatchObject({
      anthropic: {
        apiKey: "sk-ant-123",
        cacheTtl: "5m",
      },
      openrouter: {
        apiKey: "or-123",
        order: "quality",
        allow_fallbacks: true,
      },
      bedrock: {
        region: "us-east-1",
        accessKeyId: "AKIA...",
      },
    });
  });

  it("writes valid app config mutations (defaultModel, hiddenModels, taskSettings)", async () => {
    using xumHome = new TestTempDir("mux-config-write");

    const tool = await createWriteTool(xumHome.path, GLOBAL_WORKSPACE_ID);
    const result = (await tool.execute!(
      {
        file: "config",
        operations: [
          { op: "set", path: ["defaultModel"], value: "anthropic:claude-sonnet-4-20250514" },
          { op: "set", path: ["hiddenModels"], value: ["openai:gpt-4o", "google:gemini-pro"] },
          { op: "set", path: ["taskSettings", "maxParallelAgentTasks"], value: 5 },
          { op: "set", path: ["taskSettings", "maxTaskNestingDepth"], value: 3 },
        ],
        confirm: true,
      },
      mockToolCallOptions
    )) as XumConfigWriteResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.appliedOps).toBe(4);
    }

    const configDocument = JSON.parse(
      await fs.readFile(path.join(xumHome.path, "config.json"), "utf-8")
    ) as {
      defaultModel?: string;
      hiddenModels?: string[];
      taskSettings?: { maxParallelAgentTasks?: number; maxTaskNestingDepth?: number };
    };

    expect(configDocument.defaultModel).toBe("anthropic:claude-sonnet-4-20250514");
    expect(configDocument.hiddenModels).toEqual(["openai:gpt-4o", "google:gemini-pro"]);
    expect(configDocument.taskSettings).toEqual({
      maxParallelAgentTasks: 5,
      maxTaskNestingDepth: 3,
    });
  });

  it("preserves unknown nested fields when mutating unrelated key", async () => {
    using xumHome = new TestTempDir("mux-config-write");

    const configPath = path.join(xumHome.path, "config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          projects: [
            [
              "/test/proj",
              {
                workspaces: [],
                futureProjectSetting: { nested: true },
              },
            ],
          ],
          taskSettings: {
            maxParallelAgentTasks: 4,
            futureTaskField: "preserve-me",
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const tool = await createWriteTool(xumHome.path, GLOBAL_WORKSPACE_ID);
    const result = (await tool.execute!(
      {
        file: "config",
        operations: [{ op: "set", path: ["taskSettings", "maxParallelAgentTasks"], value: 8 }],
        confirm: true,
      },
      mockToolCallOptions
    )) as XumConfigWriteResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.appliedOps).toBe(1);
    }

    const configDocument = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      projects?: Array<
        [
          string,
          {
            workspaces: unknown[];
            futureProjectSetting?: { nested: boolean };
          },
        ]
      >;
      taskSettings?: {
        maxParallelAgentTasks?: number;
        futureTaskField?: string;
      };
    };

    expect(configDocument.taskSettings).toEqual({
      maxParallelAgentTasks: 8,
      futureTaskField: "preserve-me",
    });
    expect(configDocument.projects).toEqual([
      [
        "/test/proj",
        {
          workspaces: [],
          futureProjectSetting: { nested: true },
        },
      ],
    ]);
  });

  it("returns validation issues and does not write when schema validation fails", async () => {
    using xumHome = new TestTempDir("mux-config-write");

    const configPath = path.join(xumHome.path, "config.json");
    const initialDocument = JSON.stringify({ defaultModel: "openai:gpt-4o" }, null, 2);
    await fs.writeFile(configPath, initialDocument, "utf-8");

    const tool = await createWriteTool(xumHome.path, GLOBAL_WORKSPACE_ID);
    const result = (await tool.execute!(
      {
        file: "config",
        operations: [{ op: "set", path: ["taskSettings", "maxParallelAgentTasks"], value: 999 }],
        confirm: true,
      },
      mockToolCallOptions
    )) as XumConfigWriteResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Schema validation failed");
      expect(result.validationIssues).toBeDefined();
      expect(result.validationIssues?.length).toBeGreaterThan(0);
      expect(
        result.validationIssues?.some((issue) => issue.path.includes("maxParallelAgentTasks"))
      ).toBe(true);
    }

    const afterDocument = await fs.readFile(configPath, "utf-8");
    expect(afterDocument).toBe(initialDocument);
  });

  it("rejects prototype pollution paths", async () => {
    using xumHome = new TestTempDir("mux-config-write");

    const providersPath = path.join(xumHome.path, "providers.jsonc");
    const tool = await createWriteTool(xumHome.path, GLOBAL_WORKSPACE_ID);
    const result = (await tool.execute!(
      {
        file: "providers",
        operations: [{ op: "set", path: ["__proto__", "polluted"], value: true }],
        confirm: true,
      },
      mockToolCallOptions
    )) as XumConfigWriteResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("__proto__");
    }

    let statError: NodeJS.ErrnoException | null = null;
    try {
      await fs.stat(providersPath);
    } catch (error) {
      statError = error as NodeJS.ErrnoException;
    }

    expect(statError?.code).toBe("ENOENT");
  });

  it("rejects operations containing redaction sentinel values", async () => {
    using xumHome = new TestTempDir("mux-config-write");

    const providersPath = path.join(xumHome.path, "providers.jsonc");
    const initialProviders = JSON.stringify({ anthropic: { apiKey: "sk-real-key" } }, null, 2);
    await fs.writeFile(providersPath, initialProviders, "utf-8");

    const tool = await createWriteTool(xumHome.path, GLOBAL_WORKSPACE_ID);
    const result = (await tool.execute!(
      {
        file: "providers",
        operations: [{ op: "set", path: ["anthropic", "apiKey"], value: "[REDACTED]" }],
        confirm: true,
      },
      mockToolCallOptions
    )) as XumConfigWriteResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("REDACTED");
    }

    // Verify original file is unchanged
    const afterContent = await fs.readFile(providersPath, "utf-8");
    expect(afterContent).toBe(initialProviders);
  });

  it("rejects nested redaction sentinel values in object payloads", async () => {
    using xumHome = new TestTempDir("mux-config-write");

    const tool = await createWriteTool(xumHome.path, GLOBAL_WORKSPACE_ID);
    const result = (await tool.execute!(
      {
        file: "providers",
        operations: [
          {
            op: "set",
            path: ["openai"],
            value: { apiKey: "[REDACTED]", baseUrl: "https://api.openai.com" },
          },
        ],
        confirm: true,
      },
      mockToolCallOptions
    )) as XumConfigWriteResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("REDACTED");
    }
  });

  it("can repair a pre-existing invalid config field", async () => {
    using xumHome = new TestTempDir("mux-config-write");

    // Seed config with an out-of-range value that would fail schema validation on read
    const configPath = path.join(xumHome.path, "config.json");
    await fs.writeFile(
      configPath,
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

    const tool = await createWriteTool(xumHome.path, GLOBAL_WORKSPACE_ID);
    const result = (await tool.execute!(
      {
        file: "config",
        operations: [{ op: "set", path: ["taskSettings", "maxParallelAgentTasks"], value: 4 }],
        confirm: true,
      },
      mockToolCallOptions
    )) as XumConfigWriteResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.appliedOps).toBe(1);
    }

    // Verify the repaired value was persisted
    const configDocument = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      taskSettings?: { maxParallelAgentTasks?: number };
      defaultModel?: string;
    };
    expect(configDocument.taskSettings?.maxParallelAgentTasks).toBe(4);
    expect(configDocument.defaultModel).toBe("anthropic:claude-sonnet-4-20250514");
  });

  it("repairs primitive config.json root during write", async () => {
    using xumHome = new TestTempDir("mux-config-write");

    const configPath = path.join(xumHome.path, "config.json");
    await fs.writeFile(configPath, JSON.stringify("oops"), "utf-8");

    const tool = await createWriteTool(xumHome.path, GLOBAL_WORKSPACE_ID);
    const result = (await tool.execute!(
      {
        file: "config",
        operations: [{ op: "set", path: ["defaultModel"], value: "openai:gpt-4o" }],
        confirm: true,
      },
      mockToolCallOptions
    )) as XumConfigWriteResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.appliedOps).toBe(1);
    }

    const configDocument = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      defaultModel?: string;
      writeId?: string;
    };
    // Repaired to an object carrying the mutation and the per-save write stamp, nothing else.
    expect(configDocument).toEqual({
      defaultModel: "openai:gpt-4o",
      writeId: expect.any(String) as string,
    });
  });

  it("repairs primitive providers.jsonc root during write", async () => {
    using xumHome = new TestTempDir("mux-config-write");

    const providersPath = path.join(xumHome.path, "providers.jsonc");
    await fs.writeFile(providersPath, "42", "utf-8");

    const tool = await createWriteTool(xumHome.path, GLOBAL_WORKSPACE_ID);
    const result = (await tool.execute!(
      {
        file: "providers",
        operations: [{ op: "set", path: ["anthropic", "apiKey"], value: "sk-ant-fixed" }],
        confirm: true,
      },
      mockToolCallOptions
    )) as XumConfigWriteResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.appliedOps).toBe(1);
    }

    const providersDocument = jsonc.parse(await fs.readFile(providersPath, "utf-8")) as {
      anthropic?: { apiKey?: string };
    };
    expect(providersDocument).toEqual({ anthropic: { apiKey: "sk-ant-fixed" } });
  });

  it("repairs array config.json root during write", async () => {
    using xumHome = new TestTempDir("mux-config-write");

    const configPath = path.join(xumHome.path, "config.json");
    await fs.writeFile(configPath, JSON.stringify([]), "utf-8");

    const tool = await createWriteTool(xumHome.path, GLOBAL_WORKSPACE_ID);
    const result = (await tool.execute!(
      {
        file: "config",
        operations: [{ op: "set", path: ["defaultModel"], value: "openai:gpt-4o" }],
        confirm: true,
      },
      mockToolCallOptions
    )) as XumConfigWriteResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.appliedOps).toBe(1);
    }

    const configDocument = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      defaultModel?: string;
      writeId?: string;
    };
    // Repaired to an object carrying the mutation and the per-save write stamp, nothing else.
    expect(configDocument).toEqual({
      defaultModel: "openai:gpt-4o",
      writeId: expect.any(String) as string,
    });
  });

  it("repairs array providers.jsonc root during write", async () => {
    using xumHome = new TestTempDir("mux-config-write");

    const providersPath = path.join(xumHome.path, "providers.jsonc");
    await fs.writeFile(providersPath, JSON.stringify([]), "utf-8");

    const tool = await createWriteTool(xumHome.path, GLOBAL_WORKSPACE_ID);
    const result = (await tool.execute!(
      {
        file: "providers",
        operations: [{ op: "set", path: ["anthropic", "apiKey"], value: "sk-ant-fixed" }],
        confirm: true,
      },
      mockToolCallOptions
    )) as XumConfigWriteResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.appliedOps).toBe(1);
    }

    const providersDocument = jsonc.parse(await fs.readFile(providersPath, "utf-8")) as {
      anthropic?: { apiKey?: string };
    };
    expect(providersDocument).toEqual({ anthropic: { apiKey: "sk-ant-fixed" } });
  });

  it("rejects writes to symlinked config.json target", async () => {
    using xumHome = new TestTempDir("mux-config-write");

    // Create an external file that should NOT be modified
    const externalTarget = path.join(xumHome.path, "external-config.json");
    const originalContent = JSON.stringify({ untouched: true }, null, 2);
    await fs.writeFile(externalTarget, originalContent, "utf-8");

    // Symlink config.json → external target
    await fs.symlink(externalTarget, path.join(xumHome.path, "config.json"));

    const tool = await createWriteTool(xumHome.path, GLOBAL_WORKSPACE_ID);
    const result = (await tool.execute!(
      {
        file: "config",
        operations: [{ op: "set", path: ["defaultModel"], value: "openai:gpt-4o" }],
        confirm: true,
      },
      mockToolCallOptions
    )) as XumConfigWriteResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/symlink/i);
    }

    // External target must remain unchanged
    expect(await fs.readFile(externalTarget, "utf-8")).toBe(originalContent);
  });

  it("rewrites config.json only under the project registration lock, from the bytes under it", async () => {
    using xumHome = new TestTempDir("mux-config-write");
    const configPath = path.join(xumHome.path, "config.json");
    await fs.writeFile(configPath, JSON.stringify({ projects: [] }), "utf-8");
    // A settings-backup import in another process holds the lock while it registers a
    // project; a value-only rewrite from bytes read before that would drop the project.
    const otherProcess = await acquireProcessFileLock({
      lockPath: projectRegistrationLockFilePath(xumHome.path),
      timeoutMs: 5_000,
      label: "test holder",
    });
    const tool = await createWriteTool(xumHome.path, GLOBAL_WORKSPACE_ID);
    const writing = tool.execute!(
      {
        file: "config",
        operations: [{ op: "set", path: ["defaultModel"], value: "openai:gpt-4o" }],
        confirm: true,
      },
      mockToolCallOptions
    ) as Promise<XumConfigWriteResult>;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(JSON.parse(await fs.readFile(configPath, "utf-8"))).toEqual({ projects: [] });

    await fs.writeFile(
      configPath,
      JSON.stringify({ projects: [["/imported", { workspaces: [] }]] }),
      "utf-8"
    );
    await otherProcess[Symbol.asyncDispose]();
    expect((await writing).success).toBe(true);
    const written = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      projects: Array<[string, unknown]>;
      defaultModel: string;
    };
    expect(written.defaultModel).toBe("openai:gpt-4o");
    expect(written.projects.map(([projectPath]) => projectPath)).toEqual(["/imported"]);
  });

  it("refreshes the write stamp on every config.json rewrite", async () => {
    using xumHome = new TestTempDir("mux-config-write");
    const configPath = path.join(xumHome.path, "config.json");
    const tool = await createWriteTool(xumHome.path, GLOBAL_WORKSPACE_ID);
    const stampAfter = async (): Promise<unknown> => {
      const result = (await tool.execute!(
        {
          file: "config",
          operations: [{ op: "set", path: ["defaultModel"], value: "openai:gpt-4o" }],
          confirm: true,
        },
        mockToolCallOptions
      )) as XumConfigWriteResult;
      expect(result.success).toBe(true);
      return (JSON.parse(await fs.readFile(configPath, "utf-8")) as { writeId?: unknown }).writeId;
    };
    // The same operation twice writes the same content; a reader comparing the file's write
    // generation around the second write (a settings-backup export deciding whether remote
    // hints still apply) must still see a write.
    const first = await stampAfter();
    const second = await stampAfter();
    expect(typeof first).toBe("string");
    expect(typeof second).toBe("string");
    expect(second).not.toBe(first);
  });

  it("rejects writes to symlinked providers.jsonc target", async () => {
    using xumHome = new TestTempDir("mux-config-write");

    const externalTarget = path.join(xumHome.path, "external-providers.jsonc");
    const originalContent = JSON.stringify({}, null, 2);
    await fs.writeFile(externalTarget, originalContent, "utf-8");

    await fs.symlink(externalTarget, path.join(xumHome.path, "providers.jsonc"));

    const tool = await createWriteTool(xumHome.path, GLOBAL_WORKSPACE_ID);
    const result = (await tool.execute!(
      {
        file: "providers",
        operations: [{ op: "set", path: ["anthropic", "apiKey"], value: "sk-ant-123" }],
        confirm: true,
      },
      mockToolCallOptions
    )) as XumConfigWriteResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/symlink/i);
    }

    expect(await fs.readFile(externalTarget, "utf-8")).toBe(originalContent);
  });
});
