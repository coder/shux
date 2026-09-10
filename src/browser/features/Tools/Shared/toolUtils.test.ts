import { describe, expect, test } from "bun:test";

import { getNestedToolStatus } from "./toolUtils";

describe("getNestedToolStatus", () => {
  test("explicit failed flag wins for output-available calls", () => {
    // Reload-time reconstruction persists no output to sniff; failure arrives
    // out-of-band via the failed flag.
    expect(getNestedToolStatus("output-available", undefined, false, true)).toBe("failed");
    expect(getNestedToolStatus("output-available", undefined, false)).toBe("completed");
  });

  test("real outputs matching the old synthetic summary shape get normal detection", () => {
    // {suppressed, ok, bytes} from an actual tool is ordinary output: its ok
    // bit must not override shape-based error detection.
    expect(
      getNestedToolStatus("output-available", { suppressed: true, ok: false, bytes: 0 }, false)
    ).toBe("completed");
    expect(
      getNestedToolStatus(
        "output-available",
        { suppressed: true, ok: true, bytes: 9, success: false },
        false
      )
    ).toBe("failed");
  });
});
