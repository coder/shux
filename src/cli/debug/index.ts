#!/usr/bin/env bun

import { parseArgs } from "util";
import { listWorkspacesCommand } from "./list-workspaces";
import { costsCommand } from "./costs";
import { sendMessageCommand } from "./send-message";
import { consolidateMemoryCommand } from "./consolidate-memory";
import { replayVerifyCommand } from "./replay-verify";
import { cacheAuditCommand } from "./cache-audit";
import { pluginsCommand } from "./plugins";
import { refinementsCommand } from "./refinements";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    workspace: { type: "string", short: "w" },
    drop: { type: "string", short: "d" },
    limit: { type: "string", short: "l" },
    all: { type: "boolean", short: "a" },
    edit: { type: "string", short: "e" },
    message: { type: "string", short: "m" },
    "dry-run": { type: "boolean" },
    rollback: { type: "string" },
    force: { type: "boolean" },
  },
  allowPositionals: true,
});

const command = positionals[0];

switch (command) {
  case "list-workspaces":
    listWorkspacesCommand();
    break;
  case "costs": {
    const workspaceId = positionals[1];
    if (!workspaceId) {
      console.error("Error: workspace ID required");
      console.log("Usage: bun debug costs <workspace-id>");
      process.exit(1);
    }
    console.profile("costs");
    await costsCommand(workspaceId);
    console.profileEnd("costs");
    break;
  }
  case "send-message": {
    const workspaceId = positionals[1];
    if (!workspaceId) {
      console.error("Error: workspace ID required");
      console.log(
        "Usage: bun debug send-message <workspace-id> [--edit <message-id>] [--message <text>]"
      );
      process.exit(1);
    }
    sendMessageCommand(workspaceId, values.edit, values.message);
    break;
  }
  case "consolidate-memory": {
    const workspaceId = positionals[1];
    if (!workspaceId) {
      console.error("Error: workspace ID required");
      console.log("Usage: bun debug consolidate-memory <workspace-id> [--dry-run]");
      process.exit(1);
    }
    await consolidateMemoryCommand(workspaceId, { dryRun: values["dry-run"] ?? false });
    break;
  }
  case "replay-verify": {
    const workspaceId = positionals[1];
    if (!workspaceId) {
      console.error("Error: workspace ID required");
      console.log("Usage: bun debug replay-verify <workspace-id>");
      process.exit(1);
    }
    await replayVerifyCommand(workspaceId);
    break;
  }
  case "cache-audit": {
    const workspaceId = positionals[1];
    if (!workspaceId) {
      console.error("Error: workspace ID required");
      console.log("Usage: bun debug cache-audit <workspace-id>");
      process.exit(1);
    }
    await cacheAuditCommand(workspaceId);
    break;
  }
  case "plugins": {
    const workspaceId = positionals[1];
    if (!workspaceId) {
      console.error("Error: workspace ID required");
      console.log("Usage: bun debug plugins <workspace-id>");
      process.exit(1);
    }
    await pluginsCommand(workspaceId);
    break;
  }
  case "refinements": {
    const workspaceId = positionals[1];
    if (!workspaceId) {
      console.error("Error: workspace ID required");
      console.log("Usage: bun debug refinements <workspace-id> [--rollback <id>] [--force]");
      process.exit(1);
    }
    await refinementsCommand(workspaceId, { rollback: values.rollback, force: values.force });
    break;
  }
  default:
    console.log("Usage:");
    console.log("  bun debug list-workspaces");
    console.log("  bun debug costs <workspace-id>");
    console.log("  bun debug send-message <workspace-id> [--edit <message-id>] [--message <text>]");
    console.log("  bun debug consolidate-memory <workspace-id> [--dry-run]");
    console.log("  bun debug replay-verify <workspace-id>");
    console.log("  bun debug cache-audit <workspace-id>");
    console.log("  bun debug plugins <workspace-id>");
    console.log("  bun debug refinements <workspace-id> [--rollback <id>] [--force]");
    process.exit(1);
}
