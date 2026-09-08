function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  // Ticket minting still sends the master bearer: private networks are not a
  // confidentiality boundary. Classify URL-normalized literals without DNS lookups.
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  return octets[0] === 127;
}

/** The endpoint is a server base URL, including any reverse-proxy path prefix. */
export function normalizeEndpoint(input: string): string {
  const value = input.trim();
  // Reject even empty ?/#, and URL-parser repairs that could hide credentials or
  // silently change the host/path. Errors must never echo user input or tokens.
  if (!/^https?:\/\/[^/]/i.test(value) || /[\s\p{Cc}\\?#]/u.test(value)) {
    throw new Error("Enter an HTTP(S) server URL without credentials, query, or fragment.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid server URL.");
  }
  if (url.username || url.password || value.split("/")[2].includes("@")) {
    throw new Error("Enter the server token separately, not in the URL.");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error("Remote servers require HTTPS. HTTP is only allowed for loopback addresses.");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Loopback HTTP development still sends the token without TLS. */
export function isInsecureEndpoint(endpoint: string): boolean {
  return normalizeEndpoint(endpoint).startsWith("http:");
}
