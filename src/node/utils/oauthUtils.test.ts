import http from "node:http";
import { describe, it, expect, afterEach } from "bun:test";
import { createDeferred, closeServer, escapeHtml, renderOAuthCallbackHtml } from "./oauthUtils";

// ---------------------------------------------------------------------------
// createDeferred
// ---------------------------------------------------------------------------

describe("createDeferred", () => {
  it("resolves with the value passed to resolve()", async () => {
    const d = createDeferred<string>();
    d.resolve("hello");
    expect(await d.promise).toBe("hello");
  });

  it("works with numeric types", async () => {
    const d = createDeferred<number>();
    d.resolve(42);
    expect(await d.promise).toBe(42);
  });

  it("works with object types", async () => {
    const d = createDeferred<{ ok: boolean }>();
    d.resolve({ ok: true });
    expect(await d.promise).toEqual({ ok: true });
  });

  it("can be resolved asynchronously", async () => {
    const d = createDeferred<string>();
    setTimeout(() => d.resolve("async"), 5);
    expect(await d.promise).toBe("async");
  });
});

// ---------------------------------------------------------------------------
// closeServer
// ---------------------------------------------------------------------------

describe("closeServer", () => {
  let server: http.Server | undefined;

  afterEach(() => {
    // Safety net in case a test fails before closing.
    if (server?.listening) {
      server.close();
    }
    server = undefined;
  });

  it("closes a listening HTTP server", async () => {
    server = http.createServer();
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    expect(server.listening).toBe(true);

    await closeServer(server);
    expect(server.listening).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe("escapeHtml", () => {
  it("escapes ampersand", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  it("escapes less-than", () => {
    expect(escapeHtml("a<b")).toBe("a&lt;b");
  });

  it("escapes greater-than", () => {
    expect(escapeHtml("a>b")).toBe("a&gt;b");
  });

  it("escapes double quote", () => {
    expect(escapeHtml('a"b')).toBe("a&quot;b");
  });

  it("escapes single quote", () => {
    expect(escapeHtml("a'b")).toBe("a&#39;b");
  });

  it("escapes all special chars together", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("returns plain strings unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

// ---------------------------------------------------------------------------
// renderOAuthCallbackHtml
// ---------------------------------------------------------------------------

describe("renderOAuthCallbackHtml", () => {
  it("renders a valid HTML page with the given title and message", () => {
    const html = renderOAuthCallbackHtml({
      title: "Test Title",
      message: "Test message",
      success: true,
    });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>Test Title</title>");
    expect(html).toContain("<h1>Test Title</h1>");
    expect(html).toContain("<p>Test message</p>");
  });

  it("includes an auto-close script when success is true", () => {
    const html = renderOAuthCallbackHtml({
      title: "Done",
      message: "All good",
      success: true,
    });
    expect(html).toContain("window.close()");
    expect(html).toContain("const ok = true;");
  });

  it("does NOT auto-close when success is false", () => {
    const html = renderOAuthCallbackHtml({
      title: "Failed",
      message: "Something went wrong",
      success: false,
    });
    expect(html).toContain("const ok = false;");
    // The script tag is present but guarded by `if (!ok) return;`
    expect(html).toContain("if (!ok) return;");
  });

  it("escapes title to prevent XSS", () => {
    const html = renderOAuthCallbackHtml({
      title: '<script>alert("xss")</script>',
      message: "ok",
      success: true,
    });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert");
  });

  it("escapes message when success is true", () => {
    const html = renderOAuthCallbackHtml({
      title: "Done",
      message: '<img onerror="hack">',
      success: true,
    });
    expect(html).toContain("&lt;img onerror=&quot;hack&quot;&gt;");
  });

  it("escapes message when success is false", () => {
    const html = renderOAuthCallbackHtml({
      title: "Failed",
      message: "<b>Error detail</b>",
      success: false,
    });
    expect(html).toContain("<p>&lt;b&gt;Error detail&lt;/b&gt;</p>");
  });

  it("includes extraHead when provided", () => {
    const html = renderOAuthCallbackHtml({
      title: "Test",
      message: "msg",
      success: true,
      extraHead: '<link rel="stylesheet" href="/style.css">',
    });
    expect(html).toContain('<link rel="stylesheet" href="/style.css">');
  });

  it("omits extraHead when not provided", () => {
    const html = renderOAuthCallbackHtml({
      title: "Test",
      message: "msg",
      success: true,
    });
    // No extra link tag should be present
    expect(html).not.toContain('<link rel="stylesheet"');
  });

  it("shows different muted text for success vs failure", () => {
    const successHtml = renderOAuthCallbackHtml({
      title: "T",
      message: "M",
      success: true,
    });
    const failureHtml = renderOAuthCallbackHtml({
      title: "T",
      message: "M",
      success: false,
    });
    expect(successHtml).toContain("Xum should now be in the foreground");
    expect(failureHtml).not.toContain("Xum should now be in the foreground");
    expect(failureHtml).toContain("You can close this tab.");
  });
});
