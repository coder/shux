import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import type { APIClient } from "@/browser/contexts/API";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { DEFAULT_MODEL_KEY, HIDDEN_MODELS_KEY } from "@/common/constants/storage";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { migrateLocalModelPrefsToBackend } from "./WorkspaceContext";

function createApiMock() {
  const updateModelPreferences = mock(() => Promise.resolve(undefined));

  return {
    api: {
      config: {
        updateModelPreferences,
      },
    } as unknown as APIClient,
    updateModelPreferences,
  };
}

function setLocalDefaultModel(model: string): void {
  globalThis.window.localStorage.setItem(DEFAULT_MODEL_KEY, JSON.stringify(model));
}

function getNonDefaultModel(): string {
  const alternativeModel = Object.values(KNOWN_MODELS).find(
    (model) => model.id !== WORKSPACE_DEFAULTS.model
  );
  if (!alternativeModel) {
    throw new Error("Expected at least one non-default known model");
  }

  return alternativeModel.id;
}

describe("migrateLocalModelPrefsToBackend", () => {
  beforeEach(() => {
    const happyWindow = new GlobalWindow();
    globalThis.window = happyWindow as unknown as Window & typeof globalThis;
    globalThis.document = happyWindow.document as unknown as Document;
    globalThis.localStorage = happyWindow.localStorage;
    globalThis.window.localStorage.clear();
  });

  afterEach(() => {
    globalThis.window.localStorage.clear();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
    globalThis.localStorage = undefined as unknown as Storage;
  });

  test("migrates an explicit local default when it matches the built-in default", () => {
    setLocalDefaultModel(WORKSPACE_DEFAULTS.model);
    const { api, updateModelPreferences } = createApiMock();

    migrateLocalModelPrefsToBackend(api, {});

    expect(updateModelPreferences).toHaveBeenCalledTimes(1);
    expect(updateModelPreferences).toHaveBeenCalledWith({
      defaultModel: WORKSPACE_DEFAULTS.model,
    });
  });

  test("migrates an explicit local default when it differs from the built-in default", () => {
    const nonDefaultModel = getNonDefaultModel();
    setLocalDefaultModel(nonDefaultModel);
    const { api, updateModelPreferences } = createApiMock();

    migrateLocalModelPrefsToBackend(api, {});

    expect(updateModelPreferences).toHaveBeenCalledTimes(1);
    expect(updateModelPreferences).toHaveBeenCalledWith({ defaultModel: nonDefaultModel });
  });

  test("does not overwrite a backend default model", () => {
    setLocalDefaultModel(getNonDefaultModel());
    const { api, updateModelPreferences } = createApiMock();

    migrateLocalModelPrefsToBackend(api, { defaultModel: WORKSPACE_DEFAULTS.model });

    expect(updateModelPreferences).not.toHaveBeenCalled();
  });

  test("does not migrate when no local default model is stored", () => {
    const { api, updateModelPreferences } = createApiMock();

    migrateLocalModelPrefsToBackend(api, {});

    expect(updateModelPreferences).not.toHaveBeenCalled();
  });

  test("does not migrate when the local default model is empty after trimming", () => {
    setLocalDefaultModel("   ");
    const { api, updateModelPreferences } = createApiMock();

    migrateLocalModelPrefsToBackend(api, {});

    expect(updateModelPreferences).not.toHaveBeenCalled();
  });

  test("preserves explicit gateway-scoped local default during migration", () => {
    setLocalDefaultModel("openrouter:openai/gpt-5");
    const { api, updateModelPreferences } = createApiMock();

    migrateLocalModelPrefsToBackend(api, {});

    expect(updateModelPreferences).toHaveBeenCalledTimes(1);
    expect(updateModelPreferences).toHaveBeenCalledWith({
      defaultModel: "openrouter:openai/gpt-5",
    });
  });

  test("merges legacy hides with seeded defaults before hydration", () => {
    const legacyHidden = "openrouter:openai/gpt-5";
    const seeded = ["openai:daybreak-blue-latest", "openai:daybreak-red-latest"];
    updatePersistedState(HIDDEN_MODELS_KEY, [legacyHidden]);
    const { api, updateModelPreferences } = createApiMock();

    const prefs = migrateLocalModelPrefsToBackend(api, {
      hiddenModels: seeded,
      hiddenModelsInitialized: false,
    });
    expect(prefs.hiddenModels).toEqual([...seeded, legacyHidden]);
    expect(updateModelPreferences).toHaveBeenCalledWith({ hiddenModels: prefs.hiddenModels });
  });

  test.each([{ hiddenModels: [] }, { hiddenModels: ["openai:daybreak-red-latest"] }])(
    "keeps initialized backend choices authoritative over stale local hides: %j",
    ({ hiddenModels }) => {
      updatePersistedState(HIDDEN_MODELS_KEY, ["openai:daybreak-blue-latest"]);
      const { api, updateModelPreferences } = createApiMock();
      const prefs = migrateLocalModelPrefsToBackend(api, {
        hiddenModels: [...hiddenModels],
        hiddenModelsInitialized: true,
      });
      expect(prefs.hiddenModels).toEqual([...hiddenModels]);
      expect(updateModelPreferences).not.toHaveBeenCalled();
    }
  );
});
