import { KEYBINDS, matchesKeybind } from "../../../src/browser/utils/ui/keybinds";

/** RN Web forwards a DOM keydown; native TextInput events do not expose these fields. */
export function getWebComposerKeyAction(event: unknown): "send" | "stop" | undefined {
  if (
    typeof window === "undefined" ||
    typeof window.KeyboardEvent !== "function" ||
    !(event instanceof window.KeyboardEvent)
  )
    return;
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.repeat ||
    !(event.target instanceof window.HTMLTextAreaElement) ||
    event.target !== document.activeElement ||
    // RN Web marks modal content before its entrance animation assigns role="dialog".
    document.querySelector('[aria-modal="true"]') !== null
  )
    return;
  if (matchesKeybind(event, KEYBINDS.INTERRUPT_STREAM_NORMAL)) return "stop";
  if (
    matchesKeybind(event, KEYBINDS.SEND_MESSAGE_AFTER_TURN) ||
    (matchesKeybind(event, KEYBINDS.SEND_MESSAGE) &&
      window.matchMedia("(min-width: 769px) and (pointer: fine)").matches)
  )
    return "send";
}
