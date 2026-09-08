import { fetch as expoFetch } from "expo/fetch";
import type { FetchRequestInit } from "expo/fetch";

// React Native's built-in fetch (whatwg-fetch over XHR) buffers whole responses and
// has no `Response.body` stream, so oRPC event iterators would never yield until the
// server closed them. Expo's fetch streams native response bodies incrementally.
export const transportFetch = (url: string, init: RequestInit): Promise<Response> =>
  expoFetch(url, init as FetchRequestInit) as unknown as Promise<Response>;
