/**
 * Test that provider registry structure is correct
 */

import { describe, test, expect } from "bun:test";
import { PROVIDER_REGISTRY, isValidProvider } from "./providers";

describe("Provider Registry", () => {
  test("registry is not empty", () => {
    expect(Object.keys(PROVIDER_REGISTRY).length).toBeGreaterThan(0);
  });

  test("isValidProvider rejects invalid providers", () => {
    expect(isValidProvider("invalid")).toBe(false);
    expect(isValidProvider("")).toBe(false);
    expect(isValidProvider("gpt-4")).toBe(false);
  });
});
