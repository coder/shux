import { describe, expect, test } from "bun:test";
import { parseRemoteConnectionUrl } from "./remoteConnection";

describe("parseRemoteConnectionUrl", () => {
  test.each([
    [
      "  HTTPS://Example.COM:443/path?token=secret#session  ",
      "https://example.com/path?token=secret#session",
    ],
    ["http://localhost:3000/", "http://localhost:3000/"],
    ["http://[::1]:8080/path", "http://[::1]:8080/path"],
  ])("normalizes a server URL without removing its path or token: %s", (input, expected) => {
    const url = parseRemoteConnectionUrl(input);
    expect(url.href).toBe(expected);
    expect(url.origin).not.toContain("secret");
    expect(url.origin).not.toContain("session");
  });

  test.each([
    "",
    "   ",
    "not a URL",
    "/relative/path",
    "//example.com",
    "http://",
    "https://example.com:99999",
    "https://[invalid]",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,hello",
    "about:blank",
    "ftp://example.com",
    "xum://open",
  ])("rejects malformed URLs and non-HTTP schemes: %s", (input) => {
    expect(() => parseRemoteConnectionUrl(input)).toThrow();
  });

  test.each([
    "https://username@example.com/",
    "https://:password@example.com/",
    "https://username:password@example.com/",
    "https://%75ser:%70assword@example.com/",
  ])("rejects URL credentials: %s", (input) => {
    expect(() => parseRemoteConnectionUrl(input)).toThrow();
  });

  test("accepts token links without credentials in the origin", () => {
    const url = parseRemoteConnectionUrl(
      "https://example.com/base?token=private-token#private-session"
    );
    expect(url.searchParams.get("token")).toBe("private-token");
    expect(url.hash).toBe("#private-session");
    expect(url.origin).toBe("https://example.com");
  });
});
