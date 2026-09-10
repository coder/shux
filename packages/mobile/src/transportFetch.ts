/** Browsers stream `Response.body`, so the platform fetch serves oRPC event iterators as-is. */
export const transportFetch = (url: string, init: RequestInit): Promise<Response> =>
  fetch(url, init);
