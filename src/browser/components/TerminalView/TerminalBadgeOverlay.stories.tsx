import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { lightweightMeta } from "@/browser/stories/meta.js";
import {
  DEFAULT_TERMINAL_BADGE_CONFIG,
  TERMINAL_BADGE_CONFIG_KEY,
  type TerminalBadgeConfig,
} from "@/common/constants/storage";
import { TerminalBadgeOverlay } from "./TerminalBadgeOverlay";

const FAKE_OUTPUT = Array.from(
  { length: 14 },
  (_, i) => `$ build step ${i + 1} … ok (${(i + 1) * 137}ms)`
).join("\n");

interface BadgeStoryProps {
  config: Partial<TerminalBadgeConfig>;
  workspaceName?: string;
  tabName?: string;
  width?: number;
}

/** Fake terminal surface: badge config is persisted state, so seed it before the overlay's first read. */
const BadgeStory = (props: BadgeStoryProps) => {
  useState(() =>
    updatePersistedState<TerminalBadgeConfig>(TERMINAL_BADGE_CONFIG_KEY, {
      ...DEFAULT_TERMINAL_BADGE_CONFIG,
      enabled: true,
      ...props.config,
    })
  );
  // Storybook reuses one browser origin across stories; restore the disabled
  // default on unmount so later stories with terminals don't inherit the badge.
  useEffect(() => {
    return () => {
      updatePersistedState<TerminalBadgeConfig>(
        TERMINAL_BADGE_CONFIG_KEY,
        DEFAULT_TERMINAL_BADGE_CONFIG
      );
    };
  }, []);

  return (
    <div className="p-4" style={{ width: props.width, maxWidth: "100%" }}>
      <div
        className="border-border-medium relative h-64 overflow-hidden rounded border"
        style={{ backgroundColor: "var(--color-terminal-bg)" }}
      >
        <pre className="p-2 text-xs" style={{ color: "var(--color-terminal-fg)" }}>
          {FAKE_OUTPUT}
        </pre>
        <TerminalBadgeOverlay
          workspaceName={props.workspaceName ?? "fix-3607-terminal-badge"}
          projectName="xum"
          tabName={props.tabName ?? "Terminal"}
          tabIndex={0}
        />
      </div>
    </div>
  );
};

const meta = {
  ...lightweightMeta,
  title: "App/Terminal/TerminalBadgeOverlay",
  component: BadgeStory,
} satisfies Meta<typeof BadgeStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const TopRightDefault: Story = {
  args: { config: {} },
};

export const BottomLeft: Story = {
  args: { config: { position: "bottom-left" } },
};

export const HighOpacityLargeFont: Story = {
  args: { config: { opacity: 0.9, fontSize: 28, template: "{project}/{workspace} · {tab}" } },
};

export const LongNamesTruncatePhone: Story = {
  args: {
    config: {},
    workspaceName: "extremely-long-workspace-branch-name-that-should-truncate",
    tabName: "very-long-osc-title-from-a-build-process",
  },
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: {
    pixel: { matrix: { viewports: ["phone"] } },
    docs: {
      description: {
        story:
          "Pins the phone-width contract: long workspace + tab names truncate with an ellipsis instead of overflowing the terminal surface.",
      },
    },
  },
};
