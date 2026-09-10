import { describe, expect, test } from "bun:test";
import { parseXumDeepLink, resolveProjectPathFromProjectQuery } from "./deepLink";

describe("parseXumDeepLink", () => {
  test("parses canonical xum://chat/new", () => {
    const payload = parseXumDeepLink(
      "xum://chat/new/?project=xum&projectPath=%2Ftmp%2Frepo&projectId=proj_123&prompt=hello%20world"
    );

    expect(payload).toEqual({
      type: "new_chat",
      project: "xum",
      projectPath: "/tmp/repo",
      projectId: "proj_123",
      prompt: "hello world",
    });
  });

  test("normalizes the legacy mux:// scheme to the same payload", () => {
    expect(parseXumDeepLink("mux://chat/new?prompt=hello")).toEqual(
      parseXumDeepLink("xum://chat/new?prompt=hello")
    );
  });

  test("returns null for invalid scheme", () => {
    expect(parseXumDeepLink("http://chat/new?prompt=hi")).toBeNull();
  });

  test("returns null for unknown route", () => {
    expect(parseXumDeepLink("xum://chat/old?prompt=hi")).toBeNull();
  });

  test("resolves deep-link project query by final path segment", () => {
    const resolved = resolveProjectPathFromProjectQuery(
      ["/Users/mike/repos/mux", "/Users/mike/repos/cmux"],
      "mux"
    );

    expect(resolved).toBe("/Users/mike/repos/mux");
  });

  test("falls back to substring match when no exact match exists", () => {
    const resolved = resolveProjectPathFromProjectQuery(
      ["/Users/mike/repos/coder", "/Users/mike/repos/cmux"],
      "mux"
    );

    expect(resolved).toBe("/Users/mike/repos/cmux");
  });

  test("returns null when no project matches", () => {
    expect(resolveProjectPathFromProjectQuery(["/Users/mike/repos/coder"], "mux")).toBeNull();
  });
});
