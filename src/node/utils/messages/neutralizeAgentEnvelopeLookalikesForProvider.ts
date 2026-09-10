import {
  getValidAgentPeerMessageMeta,
  neutralizeAgentEnvelopeLookalikes,
  parseAgentMessageEnvelope,
} from "@/common/utils/agentMessageEnvelope";
import type { MuxMessage } from "@/common/types/message";

/**
 * Rewrite `<mux_agent_message>` lookalike tags before the provider request.
 *
 * Why: the system prompt classifies transcript rows wrapped in that tag as untrusted agent peer
 * messages. Authentic envelopes are authored exclusively by the peer-message send path as
 * assistant-role synthetic pre-turn rows carrying valid `agent-peer-message` metadata; any other
 * occurrence is user-pasted text (which must keep user authority) or model-emitted text (which
 * must not be able to forge a peer message into its own later context). Rewriting every
 * non-authentic row makes the exact wrapper server-controlled provenance.
 *
 * Notes:
 * - Request-only: does not mutate persisted history/UI.
 * - Scope: text parts of user and assistant rows that are not authentic payload rows, plus
 *   string-bearing tool parts (input/output/errorText). Tool results carry attacker-controlled
 *   repository content (file_read, bash, ...), so a wrapper inside them must be neutralized too
 *   or repository text could masquerade as the peer-message protocol in provider tool content.
 */
export function neutralizeAgentEnvelopeLookalikesForProvider(messages: MuxMessage[]): MuxMessage[] {
  let didChange = false;

  const result = messages.map((msg) => {
    if (msg.role !== "user" && msg.role !== "assistant") {
      return msg;
    }
    // Exempt only rows the peer send path could have authored: assistant role, SYNTHETIC
    // provenance (the send path persists payload rows exclusively as synthetic pre-turn rows —
    // ordinary model output can carry corrupted-but-valid-looking metadata, never this marker),
    // VALID peer metadata, AND text that is exactly a well-formed envelope whose sender fields
    // MATCH the metadata (the send path writes both from the same values). A corrupted row
    // carrying just the discriminator, lookalike text, or an inconsistent metadata/envelope pair
    // — where the UI would attribute one sender while the provider reads another — must not
    // smuggle the exact wrapper past neutralization. The exemption covers TEXT parts only; tool
    // parts are never authentic envelopes.
    const meta = getValidAgentPeerMessageMeta(msg.metadata?.muxMetadata);
    const isAuthenticPeerRow =
      msg.role === "assistant" &&
      msg.metadata?.synthetic === true &&
      meta != null &&
      msg.parts.every((part) => {
        if (part.type !== "text") return true;
        const parsed = parseAgentMessageEnvelope(part.text);
        return (
          parsed != null &&
          parsed.from === meta.fromWorkspaceId &&
          parsed.relationship === meta.relationship &&
          parsed.fromTitle === meta.fromTitle
        );
      });

    let msgChanged = false;
    const nextParts = msg.parts.map((part) => {
      if (part.type === "text") {
        if (isAuthenticPeerRow || !part.text.includes("mux_agent_message")) {
          return part;
        }
        msgChanged = true;
        return { ...part, text: neutralizeAgentEnvelopeLookalikes(part.text) };
      }
      if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
        // Tool parts are treated as an opaque record here: the string-bearing payload fields are
        // provider-bound JSON whose precise shape varies per tool state, so read them through an
        // unknown-first boundary instead of asserting across unrelated part shapes.
        const record: Record<string, unknown> = toRecord(part);
        let partChanged = false;
        const overrides: Record<string, unknown> = {};
        for (const key of ["input", "output", "errorText"] as const) {
          const neutralized = neutralizeStringsDeep(record[key]);
          if (neutralized !== record[key]) {
            overrides[key] = neutralized;
            partChanged = true;
          }
        }
        if (!partChanged) {
          return part;
        }
        msgChanged = true;
        // Merge in record space, then narrow back through the same unknown-first boundary the
        // reads used: only string contents changed, so the part keeps its runtime shape.
        const merged: Record<string, unknown> = { ...record, ...overrides };
        return merged as typeof part;
      }
      return part;
    });

    if (!msgChanged) {
      return msg;
    }
    didChange = true;
    return { ...msg, parts: nextParts };
  });

  return didChange ? result : messages;
}

/** Unknown-first widening so tool-part payload fields can be read without cross-shape casts. */
function toRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/**
 * Shape-preserving deep neutralization for JSON-serializable tool payloads. Returns the SAME
 * reference when nothing contains the lookalike tag so unchanged parts/messages keep identity.
 */
function neutralizeStringsDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return value.includes("mux_agent_message") ? neutralizeAgentEnvelopeLookalikes(value) : value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const out = neutralizeStringsDeep(item);
      if (out !== item) changed = true;
      return out;
    });
    return changed ? next : value;
  }
  if (typeof value === "object" && value !== null) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const out = neutralizeStringsDeep(item);
      if (out !== item) changed = true;
      next[key] = out;
    }
    return changed ? next : value;
  }
  return value;
}
