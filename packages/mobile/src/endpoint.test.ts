import { describe, expect, test } from "bun:test";
import { isInsecureEndpoint, normalizeEndpoint } from "./endpoint";

describe("mobile endpoints", () => {
  test("preserves proxy prefixes and normalizes origin and trailing slash", () => {
    expect(normalizeEndpoint(" HTTPS://Example.COM:443/@user/workspace/apps/xum/// ")).toBe(
      "https://example.com/@user/workspace/apps/xum"
    );
    expect(normalizeEndpoint("https://example.com")).toBe("https://example.com");
  });

  test.each([
    "https://user:secret@example.com",
    "https://user@example.com",
    "https://@example.com",
    "https:////example.com",
    "https://example.com\u0000",
    "https://example.com?token=secret",
    "https://example.com?",
    "https://example.com#",
    "ftp://example.com",
    "ws://localhost",
    "file:///tmp",
    "example.com",
    "https://",
    "https://example.com\\@other.com",
    "https://exa\nmple.com",
    "http://example.com",
    "http://10.0.0.2",
    "http://172.16.0.1",
    "http://172.31.255.254",
    "http://192.168.1.2",
    "http://169.254.1.2",
    "http://[fc00::1]",
    "http://[fd00::1]",
    "http://[fe80::1]",
    "http://[::ffff:127.0.0.1]",
    "http://0x0a000001",
    "http://3232235777",
    "http://0300.0250.1.1",
    "http://server.local",
    "http://localhost.example.com",
    "http://localhost.",
    "http://172.32.0.1",
    "http://192.169.0.1",
    "http://10.0.0.1.example.com",
    "http://0.0.0.0",
    "http://[2001:4860:4860::8888]",
  ])("rejects unsafe endpoint %s without echoing input", (input) => {
    let error: unknown;
    try {
      normalizeEndpoint(input);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(input);
    expect(String(error)).not.toContain("secret");
  });

  test.each(["localhost", "127.0.0.1", "127.23.45.67", "127.255.255.254", "[::1]"])(
    "allows loopback development with a cleartext warning: %s",
    (host) => {
      const endpoint = `http://${host}:3000/proxy`;
      expect(normalizeEndpoint(endpoint)).toBe(endpoint);
      expect(isInsecureEndpoint(endpoint)).toBe(true);
      expect(isInsecureEndpoint(`https://${host}:3000/proxy`)).toBe(false);
    }
  );

  test.each(["127.1", "0x7f000001", "2130706433", "0177.0.0.1"])(
    "classifies noncanonical IPv4 through URL normalization: %s",
    (host) =>
      expect(normalizeEndpoint(`http://${host}:3000/proxy`)).toBe("http://127.0.0.1:3000/proxy")
  );
  test("accepts normalized IPv6 loopback", () => {
    expect(normalizeEndpoint("http://[0:0:0:0:0:0:0:1]:3000/proxy")).toBe(
      "http://[::1]:3000/proxy"
    );
  });
  test.each(["10.0.0.2", "192.168.1.2", "[fd00::1]", "[fe80::1]", "server.local", "example.com"])(
    "allows remote HTTPS with a proxy prefix: %s",
    (host) =>
      expect(normalizeEndpoint(`https://${host}/@user/workspace/apps/xum/`)).toBe(
        `https://${host}/@user/workspace/apps/xum`
      )
  );
});
