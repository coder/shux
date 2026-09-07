/**
 * Shared Storybook meta configuration and wrapper components.
 *
 * All App stories share the same meta config and AppWithMocks wrapper
 * to ensure consistent setup across all story files.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import type { FC, ReactNode } from "react";
import { useRef } from "react";
import { AppLoader } from "../components/AppLoader/AppLoader";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import type { APIClient } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { EXPERIMENT_IDS, getExperimentKey } from "@/common/constants/experiments";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  SELECTED_WORKSPACE_KEY,
  SIDEBAR_AGE_GROUPING_KEY,
  SIDEBAR_FLAT_MODE_KEY,
  TERMINAL_BADGE_CONFIG_KEY,
  UI_THEME_KEY,
} from "@/common/constants/storage";

// ═══════════════════════════════════════════════════════════════════════════════
// META CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Stories snapshot once by default (dark theme, laptop viewport from
 * pixel.jsonc). Use PIXEL_DUAL_THEME on one "Smoke" story per retained file
 * to verify both themes render correctly.
 */
export const PIXEL_DUAL_THEME = { themes: ["dark", "light"] } as const;

export const PIXEL_DISABLED = { exclude: true } as const;

export const appMeta: Meta<typeof AppLoader> = {
  title: "App",
  component: AppLoader,
  parameters: {
    layout: "fullscreen",
    backgrounds: {
      default: "dark",
      values: [
        { name: "dark", value: "#1e1e1e" },
        { name: "light", value: "#f5f6f8" },
      ],
    },
  },
};

export type AppStory = StoryObj<typeof appMeta>;

export const StoryUiShell: FC<{ children: ReactNode }> = (props) => {
  return (
    <ThemeProvider>
      <TooltipProvider>{props.children}</TooltipProvider>
    </ThemeProvider>
  );
};

export const lightweightMeta: Meta = {
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <StoryUiShell>
        <Story />
      </StoryUiShell>
    ),
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// STORY WRAPPER
// ═══════════════════════════════════════════════════════════════════════════════

interface AppWithMocksProps {
  setup: () => APIClient;
}

/** Wrapper that runs setup once and passes the client to AppLoader */

function resetStorybookPersistedStateForStory(): void {
  // Storybook can preserve localStorage across story renders on one origin.
  // Reset persisted state so each story starts from a known route + theme.
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(SELECTED_WORKSPACE_KEY);
    localStorage.setItem(UI_THEME_KEY, JSON.stringify("dark"));
    // Stories that disable sidebar age grouping must not leak the setting
    // into later stories via the shared localStorage origin.
    localStorage.removeItem(SIDEBAR_AGE_GROUPING_KEY);
    // The flat chat list story persists sidebarFlatMode; clear it via the
    // persisted-state helper so a mounted sidebar's subscribed snapshot
    // observes the reset instead of keeping the flat layout.
    updatePersistedState(SIDEBAR_FLAT_MODE_KEY, undefined);
    // Terminal badge stories seed an enabled badge config; clear it so other
    // stories with terminals don't render order-dependent badge overlays.
    localStorage.removeItem(TERMINAL_BADGE_CONFIG_KEY);
    // The timeline dialog story enables the timeline experiment; clear it so
    // other stories' right-sidebar layouts don't gain an order-dependent tab.
    // Cleared via the persisted-state helper so mounted experiment subscribers
    // observe the reset instead of holding a stale snapshot.
    updatePersistedState(getExperimentKey(EXPERIMENT_IDS.TIMELINE), undefined);
    // Context-policy stories must not change subsequent stories' automatic behavior.
    for (const id of [
      EXPERIMENT_IDS.TOKEN_BUDGET,
      EXPERIMENT_IDS.CONTINUOUS_COMPACTION,
      EXPERIMENT_IDS.RLM,
    ]) {
      updatePersistedState(getExperimentKey(id), undefined);
    }
  }
}
function getStorybookRenderKey(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  const storyId = params.get("id") ?? params.get("path");
  const viewportBucket = window.innerWidth <= 768 ? "narrow" : "wide";
  return storyId ? `${storyId}:${viewportBucket}` : viewportBucket;
}

export const AppWithMocks: FC<AppWithMocksProps> = ({ setup }) => {
  const lastRenderKeyRef = useRef<string | null>(null);
  const clientRef = useRef<APIClient | null>(null);

  const renderKey = getStorybookRenderKey();
  const shouldReset = clientRef.current === null || lastRenderKeyRef.current !== renderKey;
  if (shouldReset) {
    resetStorybookPersistedStateForStory();
    lastRenderKeyRef.current = renderKey;
    clientRef.current = null;
  }

  clientRef.current ??= setup();

  // Key by story + viewport bucket so Storybook fully remounts when switching
  // stories or crossing the mobile breakpoint that changes the left sidebar default.
  // Without this, RouterProvider keeps its initial route and APIProvider doesn't
  // re-initialize, causing flaky "loading page vs left screen" states.
  return <AppLoader key={renderKey} client={clientRef.current} />;
};
