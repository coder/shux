import * as path from "path";
import * as fs from "fs";
import { defaultConfig } from "@/node/config";
import type { MuxMessage } from "@/common/types/message";
import type { SendMessageOptions } from "@/common/orpc/types";
import { defaultModel } from "@/common/utils/ai/models";
import { getXumSessionsDir } from "@/common/constants/paths";

/**
 * Debug command to send a message to a workspace, optionally editing an existing message
 * Usage: bun debug send-message <workspace-id> [--edit <message-id>] [--message <text>]
 */
export function sendMessageCommand(
  workspaceId: string,
  editMessageId?: string,
  messageText?: string
) {
  console.log(`\n=== Send Message Debug Tool ===\n`);
  console.log(`Workspace: ${workspaceId}`);
  if (editMessageId) {
    console.log(`Edit Mode: Editing message ${editMessageId}`);
  }
  console.log();

  // Load chat history to verify message exists if editing
  const sessionDir = path.join(defaultConfig.sessionsDir, workspaceId);
  const chatHistoryPath = path.join(sessionDir, "chat.jsonl");

  if (!fs.existsSync(chatHistoryPath)) {
    console.error(`❌ No chat history found at: ${chatHistoryPath}`);
    console.log("\nAvailable workspaces:");
    const sessionsDir = getXumSessionsDir();
    if (fs.existsSync(sessionsDir)) {
      const sessions = fs.readdirSync(sessionsDir);
      sessions.forEach((session) => console.log(`  - ${session}`));
    }
    return;
  }

  // Read and parse messages
  // Note: We use a more flexible type here because the on-disk format includes workspaceId
  // which is not part of the XumMessage type (it's metadata that gets stripped)
  const data = fs.readFileSync(chatHistoryPath, "utf-8");
  const messages: Array<MuxMessage & { workspaceId?: string }> = data
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as MuxMessage & { workspaceId?: string });

  if (messages.length === 0) {
    console.log("❌ No messages in chat history");
    return;
  }

  // Check for workspace ID mismatches
  const workspaceIds = new Set(messages.map((m) => m.workspaceId));
  if (workspaceIds.size > 1) {
    console.log(`ℹ️  INFO: Multiple workspace IDs found in message history`);
    console.log(`  Current workspace: ${workspaceId}`);
    console.log(`  Message workspace IDs: ${Array.from(workspaceIds).join(", ")}`);
    console.log(`  This can occur after workspace renames. Messages are migrated during rename.\n`);
  } else if (workspaceIds.size === 1 && !workspaceIds.has(workspaceId)) {
    console.log(`ℹ️  INFO: Workspace ID mismatch detected`);
    console.log(`  Current workspace: ${workspaceId}`);
    console.log(`  Message workspace IDs: ${Array.from(workspaceIds)[0] ?? "unknown"}`);
    console.log(`  This workspace may have been renamed. Workspace IDs in messages are cosmetic`);
    console.log(`  and get updated automatically during history operations.\n`);
  }

  console.log(`📝 Chat History (${messages.length} messages):\n`);

  // Display all messages with their IDs
  for (const msg of messages) {
    const preview =
      msg.role === "user"
        ? (msg.parts.find((p) => p.type === "text")?.text?.substring(0, 60) ?? "")
        : `[${msg.parts.length} parts]`;
    const indicator = msg.id === editMessageId ? "👉" : "  ";
    const mismatchIndicator = msg.workspaceId && msg.workspaceId !== workspaceId ? " ℹ️" : "";
    const sequence = msg.metadata?.historySequence ?? "?";
    console.log(
      `${indicator} [${sequence}] ${msg.role.padEnd(9)} ${msg.id}  ${preview}${mismatchIndicator}`
    );
  }

  // If editing, verify the message exists
  if (editMessageId) {
    const messageToEdit = messages.find((m) => m.id === editMessageId);
    if (!messageToEdit) {
      console.error(`\n❌ Message ${editMessageId} not found in history`);
      return;
    }

    console.log(`\n✓ Found message to edit:`);
    console.log(`  Role: ${messageToEdit.role}`);
    console.log(`  Sequence: ${messageToEdit.metadata?.historySequence ?? "?"}`);
    console.log(
      `  Content: ${messageToEdit.parts.find((p) => p.type === "text")?.text?.substring(0, 100) ?? "(no text)"}`
    );
  }

  // Prepare the message text
  const textToSend = messageText ?? `[Debug edit test at ${new Date().toISOString()}]`;
  console.log(`\n📤 Message to send: "${textToSend}"`);

  // Prepare options
  const options: SendMessageOptions = {
    model: defaultModel,
    agentId: "exec",
  };

  if (editMessageId) {
    options.editMessageId = editMessageId;
  }

  console.log(`\n⚠️  This command currently only displays information.`);
  console.log(`To actually send a message with edit, you would invoke:`);
  console.log(
    `  window.api.workspace.sendMessage("${workspaceId}", "${textToSend}", ${JSON.stringify(options)})`
  );
  console.log(
    `\nThis would truncate history after message ${editMessageId ?? "unknown"} and send the new message.`
  );

  console.log(`\nTo test in the app:`);
  console.log(`1. Open the workspace "${workspaceId}"`);
  console.log(`2. Click edit on message ${editMessageId ?? "unknown"}`);
  console.log(`3. Make changes and send`);
  console.log();
}
