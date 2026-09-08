import { afterEach, expect, test } from "bun:test";
import { requestWebSocketTicket, WebSocketTicketError } from "./webSocketTicket";

const originalFetch = globalThis.fetch;
const secret = "long-lived-master-secret";
const ticket = "a".repeat(64);
const response = (value: unknown, status = 200) => Response.json({ json: value }, { status });
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(implementation: (url: string, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = implementation as typeof fetch;
}

test("mints through prefixed HTTP oRPC with Authorization only, then returns a validated ticket", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  mockFetch((url, init) => {
    calls.push({ url, init });
    return Promise.resolve(response({ ticket, expiresAtMs: 1 }));
  });
  const controller = new AbortController();
  // The server owns expiry; an apparently old timestamp must not fail under client clock skew.
  expect(
    await requestWebSocketTicket("https://example.test/@u/ws/apps/xum/", secret, controller.signal)
  ).toEqual({ ticket, expiresAtMs: 1 });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe(
    "https://example.test/@u/ws/apps/xum/orpc/serverAuth/issueWebSocketTicket"
  );
  expect(calls[0].init?.method).toBe("POST");
  expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe(`Bearer ${secret}`);
  expect(calls[0].init).toMatchObject({
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    signal: controller.signal,
  });
  expect(calls[0].url).not.toContain(secret);
  expect(calls[0].init?.body).toBeUndefined();
});

test.each([
  [401, "authentication"],
  [403, "transient"],
  [404, "unsupported"],
  [405, "unsupported"],
  [503, "transient"],
] as const)(
  "classifies HTTP %s without retaining upstream credential-bearing details",
  async (status, reason) => {
    mockFetch(() =>
      Promise.resolve(response({ message: secret, headers: { authorization: secret } }, status))
    );
    let failure: unknown;
    try {
      await requestWebSocketTicket("https://example.test", secret, new AbortController().signal);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(WebSocketTicketError);
    expect(failure).toMatchObject({ reason });
    expect(String(failure)).not.toContain(secret);
    expect(failure).not.toHaveProperty("cause");
    expect(JSON.stringify(failure)).not.toContain(secret);
  }
);

test.each([
  null,
  {},
  { ticket: secret, expiresAtMs: 1 },
  { ticket: "A".repeat(64), expiresAtMs: 1 },
  { ticket: `${ticket}\r\n${secret}`, expiresAtMs: 1 },
  { ticket, expiresAtMs: "123" },
  { ticket, expiresAtMs: null },
])("rejects malformed ticket responses without echoing them: %j", async (value) => {
  mockFetch(() => Promise.resolve(response(value)));
  expect(
    await requestWebSocketTicket(
      "https://example.test",
      secret,
      new AbortController().signal
    ).catch((error: unknown) => error)
  ).toMatchObject({ reason: "transient" });
});

test("pre-cancellation avoids fetch; in-flight cancellation settles even if fetch ignores abort", async () => {
  let calls = 0;
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<Response>();
  mockFetch(() => {
    calls++;
    started.resolve();
    return pending.promise;
  });
  const controller = new AbortController();
  controller.abort(secret);
  expect(
    await requestWebSocketTicket("https://example.test", secret, controller.signal).catch(
      (error: unknown) => error
    )
  ).toMatchObject({ reason: "cancelled" });
  expect(calls).toBe(0);
  const lifetime = new AbortController();
  const request = requestWebSocketTicket("https://example.test", secret, lifetime.signal);
  await started.promise;
  lifetime.abort(secret);
  expect(await request.catch((error: unknown) => error)).toMatchObject({ reason: "cancelled" });
  pending.resolve(response({ ticket, expiresAtMs: 1 }));
  expect(calls).toBe(1);
});

test.each([
  `https://user:${secret}@example.test`,
  `https://example.test/?token=${secret}`,
  `https://example.test/#${secret}`,
  "file:///tmp/server",
])("rejects unsafe base URLs before sending credentials", async (baseUrl) => {
  let calls = 0;
  mockFetch(() => {
    calls++;
    return Promise.resolve(response({ ticket, expiresAtMs: 1 }));
  });
  expect(
    await requestWebSocketTicket(baseUrl, secret, new AbortController().signal).catch(
      (error: unknown) => error
    )
  ).toMatchObject({ reason: "transient" });
  expect(calls).toBe(0);
});

test("network and malformed HTTP body failures are credential-safe and never retried", async () => {
  for (const failure of [
    () => Promise.reject(new Error(secret)),
    () => Promise.resolve(new Response(secret)),
  ]) {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return failure();
    });
    let error: unknown;
    try {
      await requestWebSocketTicket("https://example.test", secret, new AbortController().signal);
    } catch (cause) {
      error = cause;
    }
    expect(error).toMatchObject({ reason: "transient" });
    expect(String(error)).not.toContain(secret);
    expect(error).not.toHaveProperty("cause");
    expect(calls).toBe(1);
  }
});
