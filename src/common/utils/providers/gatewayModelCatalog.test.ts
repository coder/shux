import { describe, expect, test } from "bun:test";

import {
  isGatewayModelAccessibleFromAuthoritativeCatalog,
  isProviderModelAccessibleFromAuthoritativeCatalog,
} from "./gatewayModelCatalog";

describe("gatewayModelCatalog", () => {
  test("treats non-Copilot providers as permissive even with custom model lists", () => {
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog(
        "openrouter",
        "openai/gpt-5",
        ["team-only-model"],
        undefined
      )
    ).toBe(true);
  });

  test("treats an empty Copilot catalog as permissive", () => {
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog("github-copilot", "gpt-5.5", [], undefined)
    ).toBe(true);
  });

  test("treats malformed Copilot catalog entries as missing", () => {
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog(
        "github-copilot",
        "gpt-5.5",
        [null as unknown as string],
        undefined
      )
    ).toBe(true);
  });

  test("treats blank Copilot catalog strings as missing", () => {
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog(
        "github-copilot",
        "gpt-5.5",
        ["   "],
        undefined
      )
    ).toBe(true);
  });

  test("matches Copilot Claude ids after dot-vs-dash normalization", () => {
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog(
        "github-copilot",
        "claude-opus-4-6",
        ["claude-opus-4.6"],
        undefined
      )
    ).toBe(true);
  });

  test("does not match unrelated Copilot Claude ids after normalization", () => {
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog(
        "github-copilot",
        "claude-opus-4-6",
        ["claude-sonnet-4.5"],
        undefined
      )
    ).toBe(false);
  });

  test("rejects direct Copilot model ids missing from the authoritative catalog", () => {
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog(
        "github-copilot",
        "gpt-5.5",
        ["gpt-5.4-mini"],
        undefined
      )
    ).toBe(false);
  });

  test("accepts Coder models present in the discovered bridge catalog", () => {
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog(
        "coder",
        "anthropic/claude-sonnet-4-5",
        ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
        ["anthropic/claude-sonnet-4-5", "openai/gpt-5"]
      )
    ).toBe(true);
  });

  test("rejects Coder models absent from the discovered bridge catalog", () => {
    // The AI Bridge only serves models its upstreams expose: an anthropic
    // model missing from coder.models must not be routed through Coder (it
    // should fall back to a configured direct provider instead).
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog(
        "coder",
        "anthropic/claude-opus-4-1",
        ["openai/gpt-5"],
        ["openai/gpt-5"]
      )
    ).toBe(false);
  });

  test("accepts manually added Coder models alongside a discovered catalog", () => {
    // Manual entries are user-managed additions to `models`; they stay
    // routable even though the server catalog does not list them.
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog(
        "coder",
        "anthropic/my-manual-model",
        ["anthropic/my-manual-model", "openai/gpt-5"],
        ["openai/gpt-5"]
      )
    ).toBe(true);
  });

  test("treats an empty Coder catalog as exhaustive (nothing accessible)", () => {
    // Disconnect/discovery always overwrite the catalog — an empty list means
    // the bridge exposed no models (e.g. not entitled), not that discovery is
    // pending.
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog(
        "coder",
        "anthropic/claude-sonnet-4-5",
        [],
        []
      )
    ).toBe(false);
  });

  test("treats a missing Coder catalog as unknown (fail open)", () => {
    // Login deletes the catalog key and discovery only persists conclusive
    // results: a missing catalog means "unknown" (discovery pending or failed
    // transiently), and blocking would strand routing until the next login
    // even after the bridge recovers.
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog(
        "coder",
        "anthropic/claude-sonnet-4-5",
        undefined,
        undefined
      )
    ).toBe(true);
  });

  test("fails open for Coder when only manual entries exist (catalog unknown)", () => {
    // A fresh login leaves manual entries in `models` but deletes the
    // catalog: the manual-only list must NOT read as an exhaustive catalog,
    // or discovered models would be blocked during the discovery window.
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog(
        "coder",
        "anthropic/claude-sonnet-4-5",
        ["anthropic/my-manual-model"],
        undefined
      )
    ).toBe(true);
  });

  test("honors Coder removals even while the catalog is unknown", () => {
    // Regression: a re-login deletes discoveredModels; if discovery then
    // fails transiently, the fail-open branch must still honor the durable
    // removedModels exclusions — otherwise routePriority could route a model
    // the user explicitly removed through Coder instead of the configured
    // direct fallback.
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog(
        "coder",
        "anthropic/claude-sonnet-4-5",
        undefined,
        undefined,
        ["anthropic/claude-sonnet-4-5"]
      )
    ).toBe(false);
    // Manual-only models list (catalog unknown): same exclusion applies.
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog(
        "coder",
        "anthropic/claude-sonnet-4-5",
        ["anthropic/my-manual-model"],
        undefined,
        ["anthropic/claude-sonnet-4-5"]
      )
    ).toBe(false);
    // Non-removed models keep the fail-open behavior.
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog(
        "coder",
        "anthropic/claude-sonnet-4-5",
        undefined,
        undefined,
        ["openai/other-model"]
      )
    ).toBe(true);
    // The gateway-form wrapper passes the exclusions through.
    expect(
      isGatewayModelAccessibleFromAuthoritativeCatalog(
        "coder",
        "anthropic/claude-sonnet-4-5",
        undefined,
        undefined,
        ["anthropic/claude-sonnet-4-5"]
      )
    ).toBe(false);
  });

  test("falls back to the Coder catalog when models is missing but the marker exists", () => {
    // Hand-edited configs may drop `models` while keeping discoveredModels;
    // gate on the catalog itself rather than blanket-blocking every model.
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog("coder", "openai/gpt-5", undefined, [
        "openai/gpt-5",
      ])
    ).toBe(true);
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog(
        "coder",
        "anthropic/claude-sonnet-4-5",
        undefined,
        ["openai/gpt-5"]
      )
    ).toBe(false);
  });

  test("accepts Codex models when the Copilot catalog includes them", () => {
    expect(
      isProviderModelAccessibleFromAuthoritativeCatalog(
        "github-copilot",
        "gpt-5.3-codex",
        ["gpt-5.3-codex"],
        undefined
      )
    ).toBe(true);
  });

  test("keeps the gateway-specific helper behavior aligned", () => {
    expect(
      isGatewayModelAccessibleFromAuthoritativeCatalog(
        "github-copilot",
        "gpt-5.5",
        ["gpt-5.4-mini"],
        undefined
      )
    ).toBe(false);
  });
});
