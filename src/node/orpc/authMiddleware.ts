import { timingSafeEqual } from "crypto";
import { os } from "@orpc/server";
import type { IncomingHttpHeaders, IncomingMessage } from "http";
import { URL } from "url";
import type { ORPCContext } from "@/node/orpc/context";
import { SERVER_AUTH_SESSION_COOKIE_NAME } from "@/node/services/serverAuthService";

// Best-effort time-constant string comparison.
//
// We intentionally use Node's native `timingSafeEqual` (battle-tested + optimized).
// It requires equal-length inputs, so we pad both sides to maxLen first, then fold
// the original length equality into the final result.
//
// Tradeoff: this allocates temporary buffers. That's acceptable here (called once
// per auth check) and avoids tricky timing branches.
export function safeEq(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  const maxLen = Math.max(bufA.length, bufB.length);

  // timingSafeEqual requires equal-length buffers.
  const paddedA = Buffer.alloc(maxLen);
  const paddedB = Buffer.alloc(maxLen);
  bufA.copy(paddedA);
  bufB.copy(paddedB);

  const bytesMatch = timingSafeEqual(paddedA, paddedB);
  return bytesMatch && bufA.length === bufB.length;
}

function extractBearerToken(header: string | string[] | undefined): string | null {
  const h = Array.isArray(header) ? header[0] : header;
  if (!h?.toLowerCase().startsWith("bearer ")) return null;
  return h.slice(7).trim() || null;
}

export function getFirstHeaderValue(
  headers: IncomingHttpHeaders | undefined,
  key: string
): string | undefined {
  const raw = headers?.[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function extractClientIpAddress(
  headers: IncomingHttpHeaders | undefined
): string | undefined {
  const forwardedFor = getFirstHeaderValue(headers, "x-forwarded-for");
  if (!forwardedFor) {
    return undefined;
  }

  const first = forwardedFor.split(",")[0]?.trim();
  return first?.length ? first : undefined;
}

export function extractCookieValues(
  cookieHeader: string | string[] | undefined,
  cookieName: string
): string[] {
  const rawCookieHeaders = Array.isArray(cookieHeader)
    ? cookieHeader.filter((value): value is string => typeof value === "string")
    : typeof cookieHeader === "string"
      ? [cookieHeader]
      : [];

  if (rawCookieHeaders.length === 0) {
    return [];
  }

  const tokens: string[] = [];

  for (const rawCookieHeader of rawCookieHeaders) {
    if (rawCookieHeader.trim().length === 0) {
      continue;
    }

    const cookiePairs = rawCookieHeader.split(";");
    for (const pair of cookiePairs) {
      const separatorIndex = pair.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }

      const key = pair.slice(0, separatorIndex).trim();
      if (key !== cookieName) {
        continue;
      }

      const value = pair.slice(separatorIndex + 1).trim();
      if (value.length === 0) {
        continue;
      }

      try {
        tokens.push(decodeURIComponent(value));
      } catch {
        tokens.push(value);
      }
    }
  }

  return tokens;
}

/** Create auth middleware that validates Authorization header or session cookie from context */
export function createAuthMiddleware(authToken?: string) {
  // oRPC >=1.14 no longer accepts a union of differently-typed middlewares in
  // `.use()`, so the "no token configured" case is folded into a single
  // middleware instead of returning a separately-typed pass-through.
  const expectedToken = authToken?.trim();

  return os
    .$context<ORPCContext>()
    .errors({
      UNAUTHORIZED: {
        message: "Invalid or missing auth token/session",
      },
    })
    .middleware(async ({ context, errors, next }) => {
      if (!expectedToken) {
        return next();
      }

      const presentedToken = extractBearerToken(context.headers?.authorization);

      if (presentedToken && safeEq(presentedToken, expectedToken)) {
        return next();
      }

      const sessionTokens = extractCookieValues(
        context.headers?.cookie,
        SERVER_AUTH_SESSION_COOKIE_NAME
      );
      for (const sessionToken of sessionTokens) {
        const sessionResult = await context.serverAuthService.validateSessionToken(sessionToken, {
          userAgent: getFirstHeaderValue(context.headers, "user-agent"),
          ipAddress: extractClientIpAddress(context.headers),
        });
        if (sessionResult) {
          return next();
        }
      }

      throw errors.UNAUTHORIZED();
    });
}

/** Extract auth token from WS upgrade request and build headers object with synthetic Authorization */
export function extractWsHeaders(req: IncomingMessage): IncomingHttpHeaders {
  // Start with actual headers
  const headers = { ...req.headers };

  // If no Authorization header, try fallback methods
  if (!headers.authorization) {
    // 1) Query param: ?token=...
    try {
      const url = new URL(req.url ?? "", "http://localhost");
      const qp = url.searchParams.get("token");
      if (qp?.trim()) {
        headers.authorization = `Bearer ${qp.trim()}`;
        return headers;
      }
    } catch {
      /* ignore */
    }

    // 2) Sec-WebSocket-Protocol (first value as token)
    const proto = req.headers["sec-websocket-protocol"];
    if (typeof proto === "string") {
      const first = proto
        .split(",")
        .map((s) => s.trim())
        .find((s) => s);
      if (first) {
        headers.authorization = `Bearer ${first}`;
      }
    }
  }

  return headers;
}
