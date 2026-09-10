import type { ReactElement } from "react";
import { Radar } from "lucide-react";
import type { BashMonitorWakeDisplayRecord, DisplayedMessage } from "@/common/types/message";
import { CollapsibleMachineMessage } from "./CollapsibleMachineMessage";

interface BashMonitorWakeMessageProps {
  message: DisplayedMessage & { type: "user" };
  className?: string;
}

/** A stale terminal (re-armed processId) still summarizes as a settlement, never as a match. */
function settlementOf(
  record: BashMonitorWakeDisplayRecord
): BashMonitorWakeDisplayRecord["terminal"] {
  return record.terminal ?? record.staleTerminal;
}

function summarizeTerminal(record: BashMonitorWakeDisplayRecord): string {
  const terminal = settlementOf(record);
  if (terminal == null) return `${record.displayName} monitor matched`;
  // Attribute a stale settlement to the earlier run so the card cannot read as the live
  // (re-armed) process having settled.
  const suffix = record.terminal == null ? " — earlier run, ID re-armed" : "";
  switch (terminal.status) {
    case "exited":
      return terminal.exitCode != null
        ? `${record.displayName} exited (code ${terminal.exitCode})${suffix}`
        : `${record.displayName} exited${suffix}`;
    case "killed":
      return `${record.displayName} killed${suffix}`;
    case "failed":
      return `${record.displayName} failed${suffix}`;
    case "unknown":
      // Backend read-time degrade of malformed settlement metadata: still a settlement.
      return `${record.displayName} settled${suffix}`;
  }
}

function summarizeRecords(records: BashMonitorWakeDisplayRecord[]): string {
  if (records.length === 1) {
    const record = records[0];
    return record.kind === "monitor-lost"
      ? record.lostReason === "runtime-failure"
        ? `${record.displayName} monitor failed`
        : `${record.displayName} monitor stopped after restart`
      : summarizeTerminal(record);
  }

  const matchRecords = records.filter((record) => record.kind === "match");
  const runtimeFailureRecords = records.filter(
    (record) => record.kind === "monitor-lost" && record.lostReason === "runtime-failure"
  );
  const restartLostRecords = records.filter(
    (record) => record.kind === "monitor-lost" && record.lostReason !== "runtime-failure"
  );
  if (matchRecords.length === records.length) {
    if (matchRecords.every((record) => settlementOf(record) != null)) {
      return `${records.length} background processes finished`;
    }
    if (matchRecords.some((record) => settlementOf(record) != null)) {
      return `${records.length} background monitor updates`;
    }
    return `${records.length} background monitors matched`;
  }
  if (runtimeFailureRecords.length === records.length) {
    return `${records.length} background monitors failed`;
  }
  if (restartLostRecords.length === records.length) {
    return `${records.length} background monitors stopped after restart`;
  }
  return `${records.length} background monitor updates`;
}

/**
 * Monitor wakes are machine-authored events, not user prompts. Keep them visible
 * for transcript continuity without giving them a full user bubble, metadata row,
 * or duplicate status badge. Right-align the compact wake like the user-side event that
 * resumed the turn, while keeping the model-facing prompt available on demand.
 */
export function BashMonitorWakeMessage(props: BashMonitorWakeMessageProps): ReactElement {
  const records = props.message.bashMonitorWake?.records ?? [];

  return (
    <CollapsibleMachineMessage
      content={props.message.content}
      summary={summarizeRecords(records)}
      icon={<Radar aria-hidden="true" className="size-3.5 shrink-0" />}
      marker="bash-monitor-wake"
      className={props.className}
    />
  );
}
