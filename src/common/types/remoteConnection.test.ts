import { describe, expect, test } from "bun:test";
import { getRemoteConnectionServerUrl, parseRemoteConnectionUrl } from "./remoteConnection";

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

describe("getRemoteConnectionServerUrl", () => {
  test.each([
    ["HTTPS://Example.COM:443/?token=secret#session", "https://example.com"],
    ["http://localhost:3000/", "http://localhost:3000"],
    ["https://example.com/mounted/xum/?token=secret#session", "https://example.com/mounted/xum"],
    ["https://example.com/mounted/xum?token=other", "https://example.com/mounted/xum"],
    ["https://example.com/other/xum/", "https://example.com/other/xum"],
    [
      "https://example.com/@alice/workspace/apps/xum/workspaces/one?token=secret#chat",
      "https://example.com/@alice/workspace/apps/xum",
    ],
    [
      "https://example.com/@alice/workspace/agent/apps/xum/settings/providers",
      "https://example.com/@alice/workspace/agent/apps/xum",
    ],
    ["https://example.com/team%20one/xum/", "https://example.com/team%20one/xum"],
  ])("preserves the server path without credentials or tokens: %s", (input, serverUrl) => {
    expect(getRemoteConnectionServerUrl(input)).toBe(serverUrl);
  });

  test("keeps different path-mounted servers separate", () => {
    const first = getRemoteConnectionServerUrl("https://example.com/first/?token=one");
    const second = getRemoteConnectionServerUrl("https://example.com/second/?token=two");
    expect(first).not.toBe(second);
    expect(first).toBe(getRemoteConnectionServerUrl("https://example.com/first?token=new#session"));
  });

  test.each(["https://user:password@example.com/path", "file:///path", "invalid"])(
    "rejects invalid server identities: %s",
    (input) => {
      expect(() => getRemoteConnectionServerUrl(input)).toThrow();
    }
  );
});
