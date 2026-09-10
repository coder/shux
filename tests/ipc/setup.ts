import { createConfigStores } from "@/node/config";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import type { BrowserWindow, WebContents } from "electron";
import type { Config } from "../../src/node/config";
import { ServiceContainer } from "../../src/node/services/serviceContainer";
import { setOpenSSHHostKeyPolicyMode } from "../../src/node/runtime/sshConnectionPool";
import {
  generateBranchName,
  createWorkspace,
  createWorkspaceWithInit,
  resolveOrpcClient,
  createTempGitRepo,
  cleanupTempGitRepo,
} from "./helpers";
import type { OrpcSource } from "./helpers";
import type { ORPCContext } from "../../src/node/orpc/context";
import type { RuntimeConfig } from "../../src/common/types/runtime";
import { createOrpcTestClient, type OrpcTestClient } from "./orpcTestClient";
import { shouldRunIntegrationTests, validateApiKeys, getApiKey } from "../testUtils";

export interface TestEnvironment {
  config: Config;
  services: ServiceContainer;
  mockWindow: BrowserWindow;
  tempDir: string;
  orpc: OrpcTestClient;
}

/**
 * Create a mock BrowserWindow for tests.
 * Note: Events are now consumed via ORPC subscriptions (StreamCollector),
 * not via windowService.send(). This mock just satisfies the window service API.
 */
function createMockBrowserWindow(): BrowserWindow {
  const mockWindow = {
    webContents: {
      send: jest.fn(),
      openDevTools: jest.fn(),
    } as unknown as WebContents,
    isDestroyed: jest.fn(() => false),
    isMinimized: jest.fn(() => false),
    restore: jest.fn(),
    focus: jest.fn(),
    loadURL: jest.fn(),
    on: jest.fn(),
    setTitle: jest.fn(),
  } as unknown as BrowserWindow;

  return mockWindow;
}

/**
 * Create a test environment with temporary config and service container
 */
export async function createTestEnvironment(): Promise<TestEnvironment> {
  // Create temporary directory for test config
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-test-"));

  // Create config with temporary directory
  const stores = createConfigStores(tempDir);
  const config = stores.config;

  // Some UI tests render ProjectPage, which now hard-blocks workspace creation when no providers
  // are configured. For non-integration tests, seed a dummy provider so the UI can render.
  //
  // For integration tests (TEST_INTEGRATION=1), do NOT write dummy keys here (they would override
  // real env-backed credentials used by tests like name generation).
  if (!shouldRunIntegrationTests()) {
    stores.providersConfigStore.saveProvidersConfig({
      anthropic: { apiKey: "test-key-for-ui-tests" },
    });
  }

  // Create mock BrowserWindow
  const mockWindow = createMockBrowserWindow();

  // Create ServiceContainer instance
  const services = new ServiceContainer(stores);
  // IPC tests run SSH against Docker containers with ephemeral host keys and no
  // interactive UI for host-key approval. Reset to headless-fallback so the
  // ServiceContainer's "strict" mode doesn't block Docker SSH connections.
  setOpenSSHHostKeyPolicyMode("headless-fallback");
  await services.initialize();

  // Wire services to the mock BrowserWindow
  // Note: Events are consumed via ORPC subscriptions (StreamCollector), not windowService.send()
  services.windowService.setMainWindow(mockWindow);

  const orpcContext: ORPCContext = services.toORPCContext();
  const orpc = createOrpcTestClient(orpcContext);

  return {
    config,
    services,
    mockWindow,
    tempDir,
    orpc,
  };
}

/**
 * Cleanup test environment (remove temporary directory) with retry logic
 */
export async function cleanupTestEnvironment(env: TestEnvironment): Promise<void> {
  // Best-effort: dispose services to prevent leaked intervals/background processes.
  try {
    await env.services.dispose();
    await env.services.shutdown();
  } catch (error) {
    console.warn("Failed to dispose test services:", error);
  }

  const maxRetries = 3;
  let lastError: unknown;

  for (let i = 0; i < maxRetries; i++) {
    try {
      await fs.rm(env.tempDir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      // Wait before retry (files might be locked temporarily)
      if (i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (i + 1)));
      }
    }
  }
  console.warn(`Failed to cleanup test environment after ${maxRetries} attempts:`, lastError);
}

/**
 * Setup provider configuration via IPC
 */
export async function setupProviders(
  source: OrpcSource,
  providers: Record<string, { apiKey?: string; baseUrl?: string; [key: string]: unknown }>
): Promise<void> {
  const client = resolveOrpcClient(source);
  for (const [providerName, providerConfig] of Object.entries(providers)) {
    for (const [key, value] of Object.entries(providerConfig)) {
      const result = await client.providers.setProviderConfig({
        provider: providerName,
        keyPath: [key],
        value: String(value),
      });

      if (!result.success) {
        throw new Error(
          `Failed to set provider config for ${providerName}.${key}: ${result.error}`
        );
      }
    }
  }
}

// Re-export test utilities for backwards compatibility
export { shouldRunIntegrationTests, validateApiKeys, getApiKey };

/**
 * Preload modules that may be imported dynamically during concurrent tests.
 * Call this in beforeAll hooks to prevent Jest sandbox race conditions.
 */
export async function preloadTestModules(): Promise<void> {
  const [{ loadTokenizerModules }, { preloadAISDKProviders }] = await Promise.all([
    import("../../src/node/utils/main/tokenizer"),
    import("../../src/node/services/providerModelFactory"),
  ]);
  await Promise.all([loadTokenizerModules(), preloadAISDKProviders()]);
}

/**
 * Setup a complete workspace with provider
 * Encapsulates: env creation, provider setup, workspace creation, event clearing
 */
export async function setupWorkspace(
  provider: string,
  branchPrefix?: string,
  options?: {
    runtimeConfig?: RuntimeConfig;
    waitForInit?: boolean;
    isSSH?: boolean;
  }
): Promise<{
  env: TestEnvironment;
  workspaceId: string;
  workspacePath: string;
  branchName: string;
  tempGitRepo: string;
  cleanup: () => Promise<void>;
}> {
  // Create dedicated temp git repo for this test
  const tempGitRepo = await createTempGitRepo();

  const env = await createTestEnvironment();

  // Ollama doesn't require API keys - it's a local service
  if (provider === "ollama") {
    await setupProviders(env, {
      [provider]: {
        baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434/api",
      },
    });
  } else {
    await setupProviders(env, {
      [provider]: {
        apiKey: getApiKey(`${provider.toUpperCase()}_API_KEY`),
      },
    });
  }

  const branchName = generateBranchName(branchPrefix || provider);
  const runtimeConfig = options?.runtimeConfig;
  const waitForInit = options?.waitForInit ?? false;
  const isSSH = options?.isSSH ?? false;

  let workspaceId: string;
  let workspacePath: string;

  try {
    if (waitForInit) {
      const initResult = await createWorkspaceWithInit(
        env,
        tempGitRepo,
        branchName,
        runtimeConfig,
        true,
        isSSH
      );
      workspaceId = initResult.workspaceId;
      workspacePath = initResult.workspacePath;
    } else {
      const createResult = await createWorkspace(
        env,
        tempGitRepo,
        branchName,
        undefined,
        runtimeConfig
      );

      if (!createResult.success) {
        throw new Error(`Workspace creation failed: ${createResult.error}`);
      }

      if (!createResult.metadata.id) {
        throw new Error("Workspace ID not returned from creation");
      }

      if (!createResult.metadata.namedWorkspacePath) {
        throw new Error("Workspace path not returned from creation");
      }

      workspaceId = createResult.metadata.id;
      workspacePath = createResult.metadata.namedWorkspacePath;
    }
  } catch (error) {
    await cleanupTestEnvironment(env);
    await cleanupTempGitRepo(tempGitRepo);
    throw error;
  }

  const cleanup = async () => {
    // Best-effort: remove workspace to stop MCP servers and clean up worktrees/sessions.
    try {
      const removeResult = await env.orpc.workspace.remove({
        workspaceId,
        options: { force: true },
      });
      if (!removeResult.success) {
        console.warn("Failed to remove workspace during cleanup:", removeResult.error);
      }
    } catch (error) {
      console.warn("Failed to remove workspace during cleanup:", error);
    }

    await cleanupTestEnvironment(env);
    await cleanupTempGitRepo(tempGitRepo);
  };

  return {
    env,
    workspaceId,
    workspacePath,
    branchName,
    tempGitRepo,
    cleanup,
  };
}

/**
 * Setup workspace without provider (for API key error tests).
 * Also clears Anthropic env vars to ensure the error check works.
 */
export async function setupWorkspaceWithoutProvider(branchPrefix?: string): Promise<{
  env: TestEnvironment;
  workspaceId: string;
  workspacePath: string;
  branchName: string;
  tempGitRepo: string;
  cleanup: () => Promise<void>;
}> {
  // Clear Anthropic env vars to ensure api_key_not_found error is triggered.
  // Save original values for restoration in cleanup.
  const savedEnvVars = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_BASE_URL;

  // Create dedicated temp git repo for this test
  const tempGitRepo = await createTempGitRepo();

  const env = await createTestEnvironment();

  const branchName = generateBranchName(branchPrefix || "noapi");
  const createResult = await createWorkspace(env, tempGitRepo, branchName);

  if (!createResult.success) {
    // Restore env vars before throwing
    Object.assign(process.env, savedEnvVars);
    await cleanupTestEnvironment(env);
    await cleanupTempGitRepo(tempGitRepo);
    throw new Error(`Workspace creation failed: ${createResult.error}`);
  }

  if (!createResult.metadata.id) {
    Object.assign(process.env, savedEnvVars);
    await cleanupTestEnvironment(env);
    await cleanupTempGitRepo(tempGitRepo);
    throw new Error("Workspace ID not returned from creation");
  }

  if (!createResult.metadata.namedWorkspacePath) {
    Object.assign(process.env, savedEnvVars);
    await cleanupTestEnvironment(env);
    await cleanupTempGitRepo(tempGitRepo);
    throw new Error("Workspace path not returned from creation");
  }

  const workspaceId = createResult.metadata.id;
  const workspacePath = createResult.metadata.namedWorkspacePath;

  const cleanup = async () => {
    // Restore env vars
    for (const [key, value] of Object.entries(savedEnvVars)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }

    // Best-effort: remove workspace to stop MCP servers and clean up worktrees/sessions.
    try {
      const removeResult = await env.orpc.workspace.remove({
        workspaceId,
        options: { force: true },
      });
      if (!removeResult.success) {
        console.warn("Failed to remove workspace during cleanup:", removeResult.error);
      }
    } catch (error) {
      console.warn("Failed to remove workspace during cleanup:", error);
    }

    await cleanupTestEnvironment(env);
    await cleanupTempGitRepo(tempGitRepo);
  };

  return {
    env,
    workspaceId,
    workspacePath,
    branchName,
    tempGitRepo,
    cleanup,
  };
}
