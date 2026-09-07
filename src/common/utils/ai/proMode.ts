/**
 * Route-aware pro-mode availability for UI surfaces (PRO toggle, palette command).
 *
 * Mirrors the send path's provider-option gating so the UI never offers a toggle that
 * cannot affect the request:
 * - model must be pro-capable (see openaiSupportsProMode);
 * - pro mode is a Responses API field, so `wireFormat: "chatCompletions"` disables it;
 * - direct OpenAI and Coder's OpenAI Responses instances deliver the mode.
 *   Other gateways hide it: non-passthrough ones use another provider schema, and mux-gateway currently
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

import { resolveCoderWireCanonicalModel } from "@/common/constants/coderOAuth";
import { openaiSupportsProMode } from "@/common/types/thinking";
import { isCustomProviderConfig } from "@/common/utils/providers/customProviders";
import { resolveCoderGatewayMetadataModel } from "@/common/utils/providers/coderGatewayMetadata";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import {
  openaiDirectProviderOptionsAvailable,
  resolveProviderOptionsRoute,
  type OpenAIDirectProviderOptionsAvailability,
} from "@/common/utils/ai/openaiProviderOptionsAvailability";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";

export type ProModeAvailabilityOptions = OpenAIDirectProviderOptionsAvailability;

export function openaiProModeAvailable(
  modelString: string,
  options?: ProModeAvailabilityOptions
): boolean {
  const route = resolveProviderOptionsRoute(modelString, options);
  if (route === "coder") {
    if (isCustomProviderConfig(options?.providersConfig?.coder)) {
      return false;
    }
    // Coder forwards native Responses bodies, unlike mux-gateway's SDK proxy.
    // Resolve the actual instance type before name-based canonicalization; the
    // direct OpenAI wire format and Codex credentials do not govern this route.
    const gatewayModelId = modelString.startsWith("coder:")
      ? modelString.slice("coder:".length)
      : normalizeToCanonical(modelString).replace(":", "/");
    const wire = resolveCoderWireCanonicalModel(gatewayModelId, options?.providersConfig?.coder);
    return (
      wire?.providerType === "openai" &&
      openaiSupportsProMode(
        resolveModelForMetadata(`openai:${wire.modelId}`, options?.providersConfig ?? null)
      )
    );
  }

  const wireFormat =
    options?.openaiWireFormat ?? options?.providersConfig?.openai?.wireFormat ?? "responses";
  if (wireFormat === "chatCompletions") {
    return false;
  }
  // An unavailable custom-named Coder instance can fall back to its real upstream.
  // Keep unknown/compatible instances scoped rather than guessing from their name.
  const normalized = modelString.startsWith("coder:")
    ? (resolveCoderGatewayMetadataModel(modelString, options?.providersConfig) ?? modelString)
    : normalizeToCanonical(modelString);
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

  return openaiDirectProviderOptionsAvailable(normalized, {
    ...options,
    resolvedRouteProvider: route,
  });
}
