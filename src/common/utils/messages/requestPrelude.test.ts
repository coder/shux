import { describe, expect, test } from "bun:test";
import { getRequestPreludeMessageIds } from "./requestPrelude";

describe("persisted request prelude IDs", () => {
  test.each([undefined, null, 42, {}, "not-an-array", true])(
    "ignores a damaged collection without throwing",
    (value) => {
      expect(getRequestPreludeMessageIds(value)).toEqual([]);
    }
  );

  test("retains valid references in order while filtering malformed entries", () => {
    expect(
      getRequestPreludeMessageIds(["snapshot", null, 1, {}, "", "payload", "snapshot"])
    ).toEqual(["snapshot", "payload", "snapshot"]);
  });
});
