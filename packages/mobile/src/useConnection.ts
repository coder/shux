import { useEffect, useRef, useState } from "react";
import type { Connection } from "./screens/ConnectScreen";

export function useConnection(initial: Connection) {
  const [session, setSession] = useState(() => ({
    connection: initial,
    controller: new AbortController(),
  }));
  const [status, setStatus] = useState<"connected" | "reconnecting" | "disconnected">("connected");
  const [error, setError] = useState<string | null>(null);
  const current = useRef(session);
  const attempt = useRef<AbortController | null>(null);
  const ended = useRef(false);

  useEffect(() => {
    return () => {
      ended.current = true;
      attempt.current?.abort();
      current.current.controller.abort();
      current.current.connection.close();
    };
  }, []);

  function cancel() {
    ended.current = true;
    attempt.current?.abort();
    attempt.current = null;
    current.current.controller.abort();
    current.current.connection.close();
    setStatus("disconnected");
  }

  async function reconnect() {
    if (ended.current || attempt.current) return;
    const controller = new AbortController();
    attempt.current = controller;
    current.current.controller.abort();
    current.current.connection.close();
    setStatus("reconnecting");
    setError(null);
    try {
      const replacement = await current.current.connection.reconnect({ signal: controller.signal });
      // Cancellation wins even if the transport resolves after disconnect/unmount.
      if (controller.signal.aborted) {
        replacement.close();
        return;
      }
      current.current = { connection: replacement, controller: new AbortController() };
      setSession(current.current);
      setStatus("connected");
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "Could not reconnect to the server.");
        setStatus("disconnected");
      }
    } finally {
      if (attempt.current === controller) attempt.current = null;
    }
  }

  return {
    connection: session.connection,
    signal: session.controller.signal,
    ready: status === "connected",
    reconnecting: status === "reconnecting",
    error,
    reconnect,
    cancel,
  };
}

export function linkedAbortController(parent: AbortSignal): AbortController {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent.aborted) controller.abort();
  else {
    parent.addEventListener("abort", abort, { once: true });
    controller.signal.addEventListener("abort", () => parent.removeEventListener("abort", abort), {
      once: true,
    });
  }
  return controller;
}
