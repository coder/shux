import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentProps, ReactNode } from "react";
import { BackgroundBashProvider } from "@/browser/contexts/BackgroundBashContext";
import { CodeExecutionToolCall } from "@/browser/features/Tools/CodeExecutionToolCall";
import type {
  CodeExecutionResult,
  NestedToolCall,
} from "@/browser/features/Tools/Shared/codeExecutionTypes";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { DISPLAY_DATA_STUB, MEDIA_DATA_STUB } from "@/common/utils/attachments/toolAttachmentParts";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/CodeExecution",
  component: CodeExecutionToolCall,
} satisfies Meta<typeof CodeExecutionToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

const STORYBOOK_WORKSPACE_ID = "storybook-code-execution";
const STABLE_TIMESTAMP = 1_700_000_000_000;

const SAMPLE_CODE = `const content = await mux.file_read({ path: "src/config.ts" });
console.log("Read file with", content.lines_read, "lines");

await mux.file_edit_replace_string({
  path: "src/config.ts",
  old_string: "debug: false",
  new_string: "debug: true"
});

return "Done!";`;

const SYNTAX_HIGHLIGHT_CODE = `type Result = { name: string; score: number };

function analyze(items: Array<{ name: string; value: number }>): Result[] {
  return items
    .filter((item) => item.value > 0)
    .map((item) => ({ name: item.name, score: item.value * 1.5 }));
}

const data = [{ name: "alpha", value: 10 }, { name: "beta", value: 0 }];
const results = analyze(data);
console.log("Processed", results.length, "items");
return results;`;

function StoryShell(props: { children: ReactNode }) {
  return (
    <BackgroundBashProvider workspaceId={STORYBOOK_WORKSPACE_ID}>
      <div className="bg-background p-6">
        <div className="w-full max-w-3xl">{props.children}</div>
      </div>
    </BackgroundBashProvider>
  );
}

const completedResult: CodeExecutionResult = {
  success: true,
  result: "Done!",
  toolCalls: [
    {
      toolName: "file_read",
      args: { path: "src/config.ts" },
      result: { success: true, lines_read: 42 },
      duration_ms: 15,
    },
    {
      toolName: "file_edit_replace_string",
      args: {
        path: "src/config.ts",
        old_string: "debug: false",
        new_string: "debug: true",
      },
      result: { success: true, edits_applied: 1 },
      duration_ms: 23,
    },
  ],
  consoleOutput: [
    {
      level: "log",
      args: ["Read file with", 42, "lines"],
      timestamp: STABLE_TIMESTAMP,
    },
  ],
  duration_ms: 120,
};

const completedNestedCalls: NestedToolCall[] = [
  {
    toolCallId: "nested-1",
    toolName: "file_read",
    input: { path: "src/config.ts" },
    output: { success: true, lines_read: 42, file_size: 1024 },
    state: "output-available",
  },
  {
    toolCallId: "nested-2",
    toolName: "file_edit_replace_string",
    input: {
      path: "src/config.ts",
      old_string: "debug: false",
      new_string: "debug: true",
    },
    output: { success: true, edits_applied: 1 },
    state: "output-available",
  },
];

function GallerySection(props: {
  label: string;
  cardProps: ComponentProps<typeof CodeExecutionToolCall>;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        {props.label}
      </h3>
      <CodeExecutionToolCall {...props.cardProps} />
    </section>
  );
}

/**
 * Gallery of non-interactive CodeExecutionToolCall states stacked vertically in
 * labeled sections. Folds the former Completed, Executing, Failed, and
 * SyntaxHighlighting stories into a single snapshot to conserve the snapshot
 * budget while preserving each distinct visual state.
 */
/** 1x1 red PNG for carrier-attachment preview stories. */
const RED_DOT_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * Stripped nested attach_file output as the PTC bridge records it: bytes are
 * replaced with stub markers because the real attachment rides the carrier.
 * The nested card must suppress these (no broken preview/download beside the
 * working carrier render below).
 */
const strippedNestedAttachFile = [
  {
    toolCallId: "nested-attach-1",
    toolName: "attach_file",
    input: { path: "board.png" },
    output: {
      type: "content",
      value: [
        { type: "text", text: "Attached board.png" },
        { type: "media", data: MEDIA_DATA_STUB, mediaType: "image/png", filename: "board.png" },
        {
          type: "media",
          data: MEDIA_DATA_STUB,
          mediaType: "application/pdf",
          filename: "report.pdf",
        },
        {
          type: "display_file",
          data: DISPLAY_DATA_STUB,
          mediaType: "text/markdown",
          filename: "notes.md",
          providerOptions: { mux: { displayOnly: true, size: 38 } },
        },
      ],
    },
    state: "output-available" as const,
  },
];

export const Gallery: Story = {
  render: () => (
    <StoryShell>
      <div className="flex flex-col gap-8">
        <GallerySection
          label="Completed (nested tool calls)"
          cardProps={{
            args: { code: SAMPLE_CODE },
            result: completedResult,
            status: "completed",
            nestedCalls: completedNestedCalls,
          }}
        />
        <GallerySection
          label="Completed (carrier attachments: image, PDF, display-only file; nested stub cards suppressed)"
          cardProps={{
            args: { code: `await mux.attach_file({ path: "board.png" });` },
            nestedCalls: strippedNestedAttachFile,
            result: {
              success: true,
              result: { attached: true },
              toolCalls: [
                { toolName: "attach_file", args: { path: "board.png" }, duration_ms: 12 },
              ],
              consoleOutput: [],
              duration_ms: 30,
              attachments: [
                { type: "media", data: RED_DOT_PNG, mediaType: "image/png", filename: "board.png" },
                // PDF: the image gallery refuses it, so it must render as a
                // download card instead of disappearing.
                {
                  type: "media",
                  data: "JVBERi0xLjQK",
                  mediaType: "application/pdf",
                  filename: "report.pdf",
                },
                {
                  type: "display_file",
                  data: "IyBOb3RlcwoKQ2FycmllZCBkaXNwbGF5LW9ubHkgbWFya2Rvd24u",
                  mediaType: "text/markdown",
                  filename: "notes.md",
                  providerOptions: { mux: { displayOnly: true, size: 38 } },
                },
              ],
            },
            status: "completed",
          }}
        />
        <GallerySection
          label="Executing (one done, one in-progress)"
          cardProps={{
            args: { code: SAMPLE_CODE },
            status: "executing",
            nestedCalls: [
              {
                toolCallId: "nested-1",
                toolName: "file_read",
                input: { path: "src/config.ts" },
                output: { success: true, lines_read: 42, file_size: 1024 },
                state: "output-available",
              },
              {
                toolCallId: "nested-2",
                toolName: "file_edit_replace_string",
                input: {
                  path: "src/config.ts",
                  old_string: "debug: false",
                  new_string: "debug: true",
                },
                state: "input-available",
              },
            ],
          }}
        />
        <GallerySection
          label="Failed (error result)"
          cardProps={{
            args: { code: `await mux.file_read({ path: "missing.ts" });` },
            result: {
              success: false,
              error: "Tool execution failed: ENOENT: no such file or directory, open 'missing.ts'",
              toolCalls: [
                {
                  toolName: "file_read",
                  args: { path: "missing.ts" },
                  error: "ENOENT: no such file or directory",
                  duration_ms: 8,
                },
              ],
              consoleOutput: [],
              duration_ms: 20,
            },
            status: "failed",
            nestedCalls: [
              {
                toolCallId: "nested-1",
                toolName: "file_read",
                input: { path: "missing.ts" },
                output: { error: "ENOENT: no such file or directory" },
                state: "output-available",
              },
            ],
          }}
        />
        <GallerySection
          label="Syntax highlighting (no tool calls)"
          cardProps={{
            args: { code: SYNTAX_HIGHLIGHT_CODE },
            result: {
              success: true,
              result: [{ name: "alpha", score: 15 }],
              toolCalls: [],
              consoleOutput: [
                {
                  level: "log",
                  args: ["Processed", 1, "items"],
                  timestamp: STABLE_TIMESTAMP,
                },
              ],
              duration_ms: 45,
            },
            status: "completed",
            nestedCalls: [],
          }}
        />
      </div>
    </StoryShell>
  ),
};
