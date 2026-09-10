# @coder/mux-chat-components

Shared chat UI from Xum, published for reuse in mux.md.

**Principle:** this package re-exports Xum’s existing chat renderer implementation (messages, tools, markdown, diff rendering) to avoid a parallel rendering stack.

## Usage

```tsx
import {
  ChatHostContextProvider,
  ThemeProvider,
  MessageRenderer,
  createReadOnlyChatHostContext,
  type DisplayedMessage,
} from "@coder/mux-chat-components";

function ConversationViewer(props: { messages: DisplayedMessage[] }) {
  return (
    <ThemeProvider>
      <ChatHostContextProvider value={createReadOnlyChatHostContext()}>
        {props.messages.map((m) => (
          <MessageRenderer key={m.historyId} message={m} />
        ))}
      </ChatHostContextProvider>
    </ThemeProvider>
  );
}
```

## Read-only host defaults

`createReadOnlyChatHostContext()` sets most `ChatHostContext.uiSupport` flags to `"unsupported"` and enables:

- `jsonRawView`
- `imageAttachments`

You can override individual flags:

```ts
createReadOnlyChatHostContext({ jsonRawView: "supported" });
```

## Styling

Xum uses Tailwind + CSS variables for theming.

This package ships a minimal CSS variable set for 4 themes (dark/light/solarized-dark/solarized-light):

```ts
import "@coder/mux-chat-components/styles";
```

The host app is still responsible for providing Tailwind (or equivalent styles) for layout/typography; the CSS export is primarily for tokens (colors, borders, etc.).

## Development

```bash
cd packages/chat-components
bun install
bun run typecheck
bun run build
```

## License

AGPL-3.0-only
