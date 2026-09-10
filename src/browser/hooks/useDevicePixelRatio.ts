import { useSyncExternalStore } from "react";

function subscribeToDevicePixelRatio(callback: () => void): () => void {
  if (typeof window.matchMedia !== "function") {
    return () => undefined;
  }

  let disposed = false;
  let mediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);

  const handleChange = () => {
    mediaQuery.removeEventListener("change", handleChange);
    if (disposed) {
      return;
    }

    mediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mediaQuery.addEventListener("change", handleChange);
    callback();
  };

  mediaQuery.addEventListener("change", handleChange);
  return () => {
    disposed = true;
    mediaQuery.removeEventListener("change", handleChange);
  };
}

export function useDevicePixelRatio(): number {
  return useSyncExternalStore(
    subscribeToDevicePixelRatio,
    () => window.devicePixelRatio || 1,
    () => 1
  );
}
