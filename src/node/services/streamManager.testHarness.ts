import type { StreamManager, TurnEngineEvent, TurnEngineEventSink } from "./streamManager";

type TurnEngineEventOfType<T extends TurnEngineEvent["type"]> = Extract<
  TurnEngineEvent,
  { type: T }
>;

// Chains a listener onto StreamManager's private event sink so tests can
// observe engine events without wiring an AIService.
export function onTurnEngineEvent<T extends TurnEngineEvent["type"]>(
  streamManager: StreamManager,
  type: T,
  listener: (event: TurnEngineEventOfType<T>) => void
): void {
  const internals = streamManager as unknown as { eventSink: TurnEngineEventSink };
  const previous = internals.eventSink;
  internals.eventSink = (event) => {
    const result = previous(event);
    if (event.type === type) {
      listener(event as TurnEngineEventOfType<T>);
    }
    return result;
  };
}
