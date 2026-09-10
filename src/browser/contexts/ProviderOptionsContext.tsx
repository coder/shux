import React, { createContext, useContext, useRef } from "react";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import {
  PROVIDER_OPTIONS_ANTHROPIC_KEY,
  PROVIDER_OPTIONS_GOOGLE_KEY,
} from "@/common/constants/storage";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { supports1MContext } from "@/common/utils/ai/models";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { KNOWN_MODELS } from "@/common/constants/knownModels";

interface ProviderOptionsContextType {
  options: MuxProviderOptions;
  setAnthropicOptions: (options: MuxProviderOptions["anthropic"]) => void;
  setGoogleOptions: (options: MuxProviderOptions["google"]) => void;
  /** Check if a specific model has 1M context enabled */
  has1MContext: (modelId: string) => boolean;
  /** Toggle 1M context for a specific model */
  toggle1MContext: (modelId: string) => void;
}

const ProviderOptionsContext = createContext<ProviderOptionsContextType | undefined>(undefined);

/**
 * Migrate legacy `use1MContext: true` (global toggle) to `use1MContextModels` (per-model set).
 * When the old global boolean is true and no per-model list exists, populate with built-in
 * models that still require Anthropic's 1M beta header.
 *
 * Newer Anthropic releases can make every built-in model native-1M, which would leave no valid
 * migration targets. In that case, keep the legacy boolean untouched so we don't silently erase
 * a user's old beta preference for custom Sonnet 4 / 4.5 entries.
 */
function migrateGlobalToPerModel(
  options: MuxProviderOptions["anthropic"]
): MuxProviderOptions["anthropic"] {
  if (
    !options?.use1MContext ||
    (options.use1MContextModels && options.use1MContextModels.length > 0)
  ) {
    return options;
  }

  const supported = Object.values(KNOWN_MODELS)
    .filter((m) => supports1MContext(m.id))
    .map((m) => m.id);
  if (supported.length === 0) {
    return options;
  }

  return {
    ...options,
    use1MContext: false,
    use1MContextModels: supported,
  };
}

export function ProviderOptionsProvider({ children }: { children: React.ReactNode }) {
  const { config: providersConfig } = useProvidersConfig();
  const [anthropicOptions, setAnthropicOptions] = usePersistedState<
    MuxProviderOptions["anthropic"]
  >(PROVIDER_OPTIONS_ANTHROPIC_KEY, {}, { listener: true });

  // One-time migration from global boolean to per-model set
  const didMigrate = useRef(false);
  if (!didMigrate.current) {
    didMigrate.current = true;
    const migrated = migrateGlobalToPerModel(anthropicOptions);
    if (migrated !== anthropicOptions) {
      setAnthropicOptions(migrated);
    }
  }

  const [googleOptions, setGoogleOptions] = usePersistedState<MuxProviderOptions["google"]>(
    PROVIDER_OPTIONS_GOOGLE_KEY,
    {},
    { listener: true }
  );

  const models1M = anthropicOptions?.use1MContextModels ?? [];

  const has1MContext = (modelId: string): boolean => {
    if (models1M.includes(modelId)) {
      return true;
    }

    return supports1MContext(modelId, providersConfig) && anthropicOptions?.use1MContext === true;
  };

  const toggle1MContext = (modelId: string): void => {
    const next = has1MContext(modelId)
      ? models1M.filter((id) => id !== modelId)
      : [...models1M, modelId];
    setAnthropicOptions({
      ...anthropicOptions,
      // Once a user interacts with a per-model toggle, prefer the explicit list over the
      // deprecated global boolean so native-1M models never inherit stale beta state.
      use1MContext: false,
      use1MContextModels: next,
    });
  };

  const value = {
    options: {
      anthropic: anthropicOptions,
      google: googleOptions,
    },
    setAnthropicOptions,
    setGoogleOptions,
    has1MContext,
    toggle1MContext,
  };

  return (
    <ProviderOptionsContext.Provider value={value}>{children}</ProviderOptionsContext.Provider>
  );
}

export function useProviderOptionsContext() {
  const context = useContext(ProviderOptionsContext);
  if (!context) {
    throw new Error("useProviderOptionsContext must be used within a ProviderOptionsProvider");
  }
  return context;
}
