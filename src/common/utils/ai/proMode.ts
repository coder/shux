/**
 * Route-aware pro-mode availability for UI surfaces (PRO toggle, palette command).
 *
 * Mirrors the send path's provider-option gating so the UI never offers a toggle that
 * cannot affect the request:
 * - model must be pro-capable (see openaiSupportsProMode);
 * - pro mode is a Responses API field, so `wireFormat: "chatCompletions"` disables it;
 * - only the direct `openai:` route delivers the mode. Gateways hide it:
 *   non-passthrough ones use another provider schema, and mux-gateway currently
 *   drops `providerOptions.openai.reasoningMode` server-side (verified empirically —
 *   the Responses API echoed `mode: "standard"`), so it fails closed until the
 *   gateway forwards the field;
 * - Codex OAuth routes strip `reasoning.mode` before calling the stricter ChatGPT
 *   backend, so when OAuth is the effective auth path, pro mode is unavailable too.
 *
 * Lives in its own module because the Codex OAuth mirror imports the codexOAuth
 * constants, which sit above models.ts in the import graph (codexOAuth →
 * modelEntries → models); adding it to models.ts would create a cycle.
 */

import { openaiSupportsProMode } from "@/common/types/thinking";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import {
  openaiDirectProviderOptionsAvailable,
  type OpenAIDirectProviderOptionsAvailability,
} from "@/common/utils/ai/openaiProviderOptionsAvailability";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";

export type ProModeAvailabilityOptions = OpenAIDirectProviderOptionsAvailability;

export function openaiProModeAvailable(
  modelString: string,
  options?: ProModeAvailabilityOptions
): boolean {
  const wireFormat =
    options?.openaiWireFormat ?? options?.providersConfig?.openai?.wireFormat ?? "responses";
  if (wireFormat === "chatCompletions") {
    return false;
  }
  const normalized = normalizeToCanonical(modelString);
  const [origin] = normalized.split(":", 2);
  if (origin !== "openai") {
    return false;
  }

  // Mapped aliases (models: [{ id, mappedToModel }]) inherit capabilities from
  // their target, mirroring buildProviderOptions' capabilityModel resolution.
  const capabilityModel = resolveModelForMetadata(normalized, options?.providersConfig ?? null);
  if (!openaiSupportsProMode(capabilityModel)) {
    return false;
  }

  return openaiDirectProviderOptionsAvailable(modelString, options);
}
