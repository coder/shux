import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

interface TerminalSubscribeCallbacks {
  onOutput: (data: string) => void;
  onScreenState: (state: string) => void;
  onExit: (code: number) => void;
}

interface MockTerminalOptions {
  fontSize: number;
  fontFamily: string;
  cursorBlink: boolean;
  theme: {
    background: string;
    foreground: string;
  };
}

interface MockRouter {
  subscribe: ReturnType<
    typeof mock<(sessionId: string, callbacks: TerminalSubscribeCallbacks) => () => void>
  >;
  resize: ReturnType<typeof mock<(sessionId: string, cols: number, rows: number) => Promise<void>>>;
  sendInput: ReturnType<typeof mock<(sessionId: string, data: string) => void>>;
}

let cleanupDom: (() => void) | null = null;
let mockRouter: MockRouter;
let subscribeCallbacks: TerminalSubscribeCallbacks[] = [];
let terminalInstances: MockTerminal[] = [];
let unsubscribeMock: ReturnType<typeof mock<() => void>>;

const initMock = mock(() => Promise.resolve());
const terminalOnExitMock = mock(
  (_input: { sessionId: string }, _options?: { signal?: AbortSignal }) =>
    Promise.resolve(
      (async function* (): AsyncGenerator<number, void, unknown> {
        await Promise.resolve();
        yield* [];
      })()
    )
);

class MockTerminal {
  cols = 80;
  rows = 24;
  options: MockTerminalOptions;
  clear = mock(() => undefined);
  write = mock((_data: string) => undefined);
  resize = mock((cols: number, rows: number) => {
    this.cols = cols;
    this.rows = rows;
  });
  blur = mock(() => undefined);
  focus = mock(() => undefined);
  dispose = mock(() => undefined);

  constructor(options: MockTerminalOptions) {
    this.options = options;
    terminalInstances.push(this);
  }

  loadAddon = mock((_addon: unknown) => undefined);

  open(container: HTMLElement): void {
    container.append(document.createElement("textarea"));
  }

  attachCustomKeyEventHandler = mock((_handler: (ev: KeyboardEvent) => boolean) => undefined);

  paste = mock((_text: string) => undefined);

  hasSelection(): boolean {
    return false;
  }

  getSelection(): string {
    return "";
  }

  onData(_callback: (data: string) => void): { dispose: () => void } {
    return { dispose: mock(() => undefined) };
  }

  onTitleChange(_callback: (title: string) => void): { dispose: () => void } {
    return { dispose: mock(() => undefined) };
  }
}

class MockFitAddon {
  fit = mock(() => undefined);
  proposeDimensions = mock(() => ({ cols: 80, rows: 24 }));
}

void mock.module("ghostty-web", () => ({
  init: initMock,
  Terminal: MockTerminal,
  FitAddon: MockFitAddon,
}));

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: {
      terminal: {
        onExit: terminalOnExitMock,
      },
    },
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

void mock.module("@/browser/terminal/TerminalRouterContext", () => ({
  useTerminalRouter: () => mockRouter,
}));

import { TerminalView } from "./TerminalView";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  DEFAULT_TERMINAL_BADGE_CONFIG,
  TERMINAL_BADGE_CONFIG_KEY,
  type TerminalBadgeConfig,
} from "@/common/constants/storage";

function createRouter(): MockRouter {
  unsubscribeMock = mock(() => undefined);
  return {
    subscribe: mock((sessionId: string, callbacks: TerminalSubscribeCallbacks) => {
      expect(sessionId).toBe("terminal-1");
      subscribeCallbacks.push(callbacks);
      callbacks.onScreenState("initial screen");
      return unsubscribeMock;
    }),
    resize: mock((_sessionId: string, _cols: number, _rows: number) => Promise.resolve()),
    sendInput: mock((_sessionId: string, _data: string) => undefined),
  };
}

function renderTerminal(onExit: (exitCode: number) => void) {
  return render(
    <TerminalView
      workspaceId="workspace-1"
      sessionId="terminal-1"
      visible
      setDocumentTitle={false}
      autoFocus={false}
      onExit={onExit}
    />
  );
}

describe("TerminalView", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    mockRouter = createRouter();
    subscribeCallbacks = [];
    terminalInstances = [];
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
    mock.restore();
  });

  test("keeps the router subscription stable when onExit changes", async () => {
    const firstOnExit = mock((_exitCode: number) => undefined);
    const secondOnExit = mock((_exitCode: number) => undefined);

    const view = renderTerminal(firstOnExit);

    await waitFor(() => {
      expect(mockRouter.subscribe).toHaveBeenCalledTimes(1);
    });

    const firstSubscription = subscribeCallbacks[0];
    const terminal = terminalInstances[0];
    expect(firstSubscription).toBeDefined();
    expect(terminal).toBeDefined();
    expect(terminal.clear).toHaveBeenCalledTimes(1);

    await act(async () => {
      view.rerender(
        <TerminalView
          workspaceId="workspace-1"
          sessionId="terminal-1"
          visible
          setDocumentTitle={false}
          autoFocus={false}
          onExit={secondOnExit}
        />
      );
      await Promise.resolve();
    });

    expect(mockRouter.subscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribeMock).toHaveBeenCalledTimes(0);
    expect(terminal.clear).toHaveBeenCalledTimes(1);

    firstSubscription.onExit(7);

    expect(firstOnExit).toHaveBeenCalledTimes(0);
    expect(secondOnExit).toHaveBeenCalledTimes(1);
    expect(secondOnExit.mock.calls[0]?.[0]).toBe(7);
  });

  test("renders the badge overlay with substituted template when enabled", async () => {
    updatePersistedState<TerminalBadgeConfig>(TERMINAL_BADGE_CONFIG_KEY, {
      ...DEFAULT_TERMINAL_BADGE_CONFIG,
      enabled: true,
    });

    const view = render(
      <TerminalView
        workspaceId="workspace-1"
        sessionId="terminal-1"
        visible
        setDocumentTitle={false}
        autoFocus={false}
        workspaceName="my-feature"
        projectName="xum"
        tabName="Terminal 2"
      />
    );

    await waitFor(() => {
      expect(view.container.textContent).toContain("my-feature · Terminal 2");
    });
  });

  test("renders no badge overlay by default", async () => {
    const view = render(
      <TerminalView
        workspaceId="workspace-1"
        sessionId="terminal-1"
        visible
        setDocumentTitle={false}
        autoFocus={false}
        workspaceName="my-feature"
        projectName="xum"
        tabName="Terminal 2"
      />
    );

    await waitFor(() => {
      expect(mockRouter.subscribe).toHaveBeenCalledTimes(1);
    });
    expect(view.container.textContent).not.toContain("my-feature");
  });
});
