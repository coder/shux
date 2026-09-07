import { lstatSync, realpathSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolveCliEntry, type InstallLayout } from "./installLayout";

export function activateUpdate(layout: InstallLayout, stagedEntry: string): void {
  if (
    !lstatSync(layout.launcher).isSymbolicLink() ||
    resolveCliEntry(layout.launcher) !== layout.entry
  ) {
    throw new Error("Server launcher changed since startup");
  }
  // A dangling launcher would brick the next start, so refuse a missing target before the swap.
  realpathSync(stagedEntry);
  const temporary = `${layout.launcher}.${randomUUID()}.tmp`;
  symlinkSync(stagedEntry, temporary);
  try {
    renameSync(temporary, layout.launcher);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Report the failed swap, not the cleanup of its temporary link.
    }
    throw error;
  }
}
