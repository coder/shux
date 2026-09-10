import { useEffect, useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { within } from "@storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { RosettaBanner } from "./RosettaBanner.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Components/RosettaBanner",
  component: RosettaBanner,
  decorators: [
    (Story) => {
      const originalApiRef = useRef(window.api);
      window.api = {
        platform: "darwin",
        versions: {
          node: "20.0.0",
          chrome: "120.0.0",
          electron: "28.0.0",
        },
        isRosetta: true,
      };

      useEffect(() => {
        const savedApi = originalApiRef.current;
        return () => {
          window.api = savedApi;
        };
      }, []);

      return <Story />;
    },
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

export const BannerVisible: Story = {
  render: () => {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem("rosettaBannerDismissedAt");
    }

    return (
      <div className="bg-background p-6">
        <RosettaBanner />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(/Xum is running under Rosetta/i);
    await canvas.findByRole("button", { name: /dismiss rosetta warning/i });
  },
};
