import { mock } from "bun:test";
import { Profiler } from "react";
import type { ComponentProps } from "react";
import { Markdown } from "../components/Markdown";

// Profile the real parser/render tree; no production counters or mocked Markdown.
export const markdownUpdates = { count: 0 };
const RealMarkdown = Markdown;
mock.module("../components/Markdown", () => ({
  Markdown: (props: ComponentProps<typeof RealMarkdown>) => (
    <Profiler id="markdown" onRender={() => markdownUpdates.count++}>
      <RealMarkdown {...props} />
    </Profiler>
  ),
}));
