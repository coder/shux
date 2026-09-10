/**
 * Envelope for intra-tree agent peer messages (sibling/cousin and descendant→ancestor sends via
 * task_send_message). Unlike parent→descendant guidance, these messages cross a trust boundary:
 * the recipient must be able to attribute the text to a specific sender without letting the
 * sender's raw text forge or terminate the envelope structure.
 */

/** The sender's relationship to the recipient (what the receiving model reads). */
export type AgentMessageRelationship = "sibling" | "descendant";

export interface AgentMessageEnvelope {
  /** Sender's tree target id — doubles as the reply address for task_send_message. */
  from: string;
  fromTitle?: string;
  relationship: AgentMessageRelationship;
  message: string;
}

const ROOT_OPEN = "<mux_agent_message>";
const ROOT_CLOSE = "</mux_agent_message>";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRelationship(value: unknown): value is AgentMessageRelationship {
  return value === "sibling" || value === "descendant";
}

/**
 * JSON framing keeps arbitrary sender text out of the tag structure, but JSON alone does not stop
 * a literal `</mux_agent_message>` inside a string value from terminating a tag-based scan.
 * Escape every `</` as `<\/` (a legal JSON string escape), so the payload can never spoof or
 * truncate the envelope while JSON.parse round-trips the text losslessly.
 */
export function formatAgentMessageEnvelope(envelope: AgentMessageEnvelope): string {
  if (!isNonEmptyString(envelope.from) || !isNonEmptyString(envelope.message)) {
    throw new Error("Agent message envelope requires a sender id and a non-empty message");
  }
  const json = JSON.stringify(envelope, null, 2).replaceAll("</", "<\\/");
  return `${ROOT_OPEN}\n${json}\n${ROOT_CLOSE}`;
}

/** Validated shape of the persisted `agent-peer-message` metadata variant. */
export interface AgentPeerMessageMeta {
  fromWorkspaceId: string;
  fromTitle?: string;
  relationship: AgentMessageRelationship;
}

/**
 * Validate persisted `agent-peer-message` metadata. muxMetadata crosses the history/oRPC boundary
 * as a black box, so a corrupted row can carry the discriminator with malformed fields; consumers
 * must fall back to ordinary user-message handling when this returns null (self-healing rule).
 */
export function getValidAgentPeerMessageMeta(muxMeta: unknown): AgentPeerMessageMeta | null {
  if (typeof muxMeta !== "object" || muxMeta === null) return null;
  const record = muxMeta as Record<string, unknown>;
  if (record.type !== "agent-peer-message") return null;
  return getValidAgentPeerTriggerMeta(muxMeta);
}

/**
 * Validates bare peer attribution without the metadata discriminator — the shape carried by
 * `agentPeerMessageTrigger` on a workspace-turn correlated trigger row, whose carrier `type` is
 * "workspace-turn-task". Corrupted or legacy values (for example the earlier boolean flag) fail
 * closed to null so the row falls back to ordinary user rendering.
 */
export function getValidAgentPeerTriggerMeta(value: unknown): AgentPeerMessageMeta | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!isNonEmptyString(record.fromWorkspaceId)) return null;
  if (!isRelationship(record.relationship)) return null;
  if (record.fromTitle != null && typeof record.fromTitle !== "string") return null;
  return {
    fromWorkspaceId: record.fromWorkspaceId,
    ...(typeof record.fromTitle === "string" ? { fromTitle: record.fromTitle } : {}),
    relationship: record.relationship,
  };
}

/**
 * Anti-spoof provenance for the model request: user-typed text is the only way a non-server
 * author can place the exact envelope tags into a user-role message, so request building rewrites
 * lookalike tags in rows that were NOT authored by the peer-message send path. The exact wrapper a
 * provider sees is therefore server provenance, and a pasted envelope keeps user authority instead
 * of being reclassified as untrusted peer input. Renamed rather than stripped so the model still
 * sees what the user pasted.
 */
export function neutralizeAgentEnvelopeLookalikes(text: string): string {
  if (!text.includes("mux_agent_message")) return text;
  return text
    .replaceAll(ROOT_OPEN, "<user_pasted_mux_agent_message>")
    .replaceAll(ROOT_CLOSE, "</user_pasted_mux_agent_message>");
}

export function parseAgentMessageEnvelope(content: string): AgentMessageEnvelope | null {
  const root = /^<mux_agent_message>\n([\s\S]*)\n<\/mux_agent_message>$/.exec(content);
  if (!root) return null;

  let value: unknown;
  try {
    value = JSON.parse(root[1]);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  if (
    !isNonEmptyString(record.from) ||
    !isRelationship(record.relationship) ||
    !isNonEmptyString(record.message)
  ) {
    return null;
  }

  return {
    from: record.from,
    relationship: record.relationship,
    message: record.message,
    // Title is display metadata: tolerate absent or malformed values so a bad producer can
    // never invalidate an otherwise well-formed message.
    ...(isNonEmptyString(record.fromTitle) ? { fromTitle: record.fromTitle } : {}),
  };
}
