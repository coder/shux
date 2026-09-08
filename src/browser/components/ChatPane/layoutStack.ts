import type { ReactNode } from "react";

export type LayoutStackLaneKind = "transcript-tail" | "composer-decoration";

interface LayoutStackItemInit {
  key: string;
  node: ReactNode;
}

export interface LayoutStackItem<
  Lane extends LayoutStackLaneKind = LayoutStackLaneKind,
> extends LayoutStackItemInit {
  readonly layoutLane: Lane;
}

export type TranscriptTailStackItem = LayoutStackItem<"transcript-tail">;
export type ChatInputDecorationStackItem = LayoutStackItem<"composer-decoration"> & {
  /**
   * Render even before async decoration data is ready, for synchronous chat state
   * that must stay visible during hydration.
   */
  readonly revealBeforeReady?: boolean;
};

function createLayoutStackItem<Lane extends LayoutStackLaneKind>(
  layoutLane: Lane,
  item: LayoutStackItemInit
): LayoutStackItem<Lane> {
  return { ...item, layoutLane };
}

// Choosing a factory is the layout contract: transcript-tail items may move the
// scrollport bottom, while composer decorations live in the stable chrome above
// the textarea. Making that choice explicit keeps persistent warnings from being
// accidentally appended inside the transcript again.
export function createTranscriptTailStackItem(item: LayoutStackItemInit): TranscriptTailStackItem {
  return createLayoutStackItem("transcript-tail", item);
}

export function createChatInputDecorationStackItem(
  item: LayoutStackItemInit & { revealBeforeReady?: boolean }
): ChatInputDecorationStackItem {
  return createLayoutStackItem("composer-decoration", item);
}

export function selectVisibleChatInputDecorations(
  items: readonly ChatInputDecorationStackItem[],
  revealDeferredDecorations: boolean
): readonly ChatInputDecorationStackItem[] {
  return revealDeferredDecorations
    ? items
    : items.filter((item) => item.revealBeforeReady === true);
}
