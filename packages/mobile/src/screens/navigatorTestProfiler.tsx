import { mock } from "bun:test";
import { Profiler } from "react";
import type { ComponentProps } from "react";
import { Navigator } from "./Navigator";

// Profile the real navigator tree, including the retained Workspaces route.
export const navigatorUpdates = { count: 0 };
const RealNavigator = Navigator;
mock.module("./Navigator", () => ({
  Navigator: (props: ComponentProps<typeof RealNavigator>) => (
    <Profiler id="navigator" onRender={() => navigatorUpdates.count++}>
      <RealNavigator {...props} />
    </Profiler>
  ),
}));
