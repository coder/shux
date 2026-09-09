import { useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, fn, userEvent, waitFor, within } from "storybook/test";
import { useTranscriptContextMenu } from "./useTranscriptContextMenu";
import { MarkdownRenderer } from "./MarkdownRenderer";

function TranscriptSelection(props: { markdown?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const menu = useTranscriptContextMenu({ transcriptRootRef: root, onQuoteText: () => undefined });
  return (
    <div ref={root} onContextMenu={menu.onContextMenu} className="p-4">
      <div data-transcript-message>
        <div data-transcript-quote-root>
          {props.markdown ? (
            <MarkdownRenderer content={props.markdown} />
          ) : (
            <>
              <p>
                Before <strong data-testid="selection">bold selection</strong> after
              </p>
              <p>
                <a href="https://example.com">Example link</a>
              </p>
            </>
          )}
        </div>
      </div>
      {menu.menu}
    </div>
  );
}

const meta = {
  title: "App/Chat/Transcript Context Menu",
  component: TranscriptSelection,
} satisfies Meta<typeof TranscriptSelection>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SelectedMarkdown: Story = {
  play: async ({ canvasElement }) => {
    const document = canvasElement.ownerDocument;
    const canvas = within(canvasElement);
    const body = within(document.body);
    const selected = await canvas.findByText("bold selection", {
      selector: 'strong, [data-streamdown="strong"]',
    });
    await waitFor(() => expect(selected).toBeVisible());
    const range = document.createRange();
    range.selectNodeContents(selected);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const openMenu = async () => {
      const rect = selected.getBoundingClientRect();
      await fireEvent.contextMenu(selected, { clientX: rect.right, clientY: rect.bottom });
      return body.findByRole("button", { name: /Copy Markdown/ });
    };
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const write = fn<(items: ClipboardItem[]) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });
    try {
      const copy = await openMenu();
      await waitFor(() => expect(copy).toBeVisible());
      await userEvent.click(copy);
      await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      const item = write.mock.calls[0][0][0];
      await expect(await (await item.getType("text/plain")).text()).toBe("**bold selection**");
      await expect(await (await item.getType("text/html")).text()).toBe(
        "<p><strong>bold selection</strong></p>"
      );

      await waitFor(() => expect(copy).not.toBeInTheDocument());
      selection.removeAllRanges();
      selection.addRange(range);
      const keyboardCopy = await openMenu();
      await waitFor(() => expect(keyboardCopy).toBeVisible());
      await userEvent.keyboard("m");
      await waitFor(() => expect(write).toHaveBeenCalledTimes(2));

      selection.removeAllRanges();
      await fireEvent.contextMenu(selected);
      await expect(body.queryByRole("button", { name: /Copy Markdown/ })).not.toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      selection.addRange(range);
      const visibleCopy = await openMenu();
      await waitFor(async () => {
        const rect = visibleCopy.getBoundingClientRect();
        await expect(rect.left).toBeGreaterThanOrEqual(0);
        await expect(rect.right).toBeLessThanOrEqual(document.documentElement.clientWidth);
      });
      if (document.documentElement.clientWidth < 640) {
        await expect(within(visibleCopy).getByText("(M)")).not.toBeVisible();
      }
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  },
};

export const SelectedMarkdownPhone: Story = {
  ...SelectedMarkdown,
  globals: { viewport: { value: "phone390", isRotated: false } },
  parameters: { pixel: { matrix: { viewports: ["phone"] } } },
  play: async (context) => {
    await expect(context.parameters).toMatchObject({ pixel: { matrix: { viewports: ["phone"] } } });
    await expect(context.globals).toMatchObject({ viewport: { value: "phone390" } });
    await SelectedMarkdown.play?.(context);
  },
};

const renderedMarkdown = [
  "Before **bold selection** after",
  "- [x] parent\n  - [ ] child",
  "<details open>\n<summary>Math</summary>\n\n$$x^2$$\n\n</details>",
  "```typescript\nconst x = 1;\n```",
  '<span class="sr-only" style="position:fixed;left:-10000px">Raw HTML cannot conceal this text.</span>',
].join("\n\n");

export const RenderedMarkdown: Story = {
  ...SelectedMarkdown,
  args: { markdown: renderedMarkdown },
  play: async (context) => {
    await SelectedMarkdown.play?.(context);
  },
};

export const RenderedMarkdownPhone: Story = {
  ...SelectedMarkdownPhone,
  args: { markdown: renderedMarkdown },
  play: async (context) => {
    await SelectedMarkdownPhone.play?.(context);
  },
};
