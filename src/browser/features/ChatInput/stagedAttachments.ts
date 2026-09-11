import type { ChatAttachment, StagedChatAttachment } from "./ChatAttachments";

const ATTACHED_FILES_OPEN_TAG = "<attached-files>";
const ATTACHED_FILES_CLOSE_TAG = "</attached-files>";
const STAGED_ATTACHMENT_NOTICE_TEXT =
  "The user attached file(s) that were saved into the workspace filesystem. These are not native model attachments; use filesystem tools such as `bash`, `file_read`, or archive tools to inspect them if needed.";
const ATTACHED_FILES_BLOCK_PATTERN = /\n?<attached-files>[\s\S]*?<\/attached-files>/gu;
const ATTACHED_FILE_LINE_PATTERN =
  /^- `(?<filename>[^`]+)` \(`(?<mediaType>[^`]+)`, (?<sizeLabel>[^)]+)\): `(?<stagedPath>[^`]+)`$/u;

export interface DisplayStagedAttachment {
  filename: string;
  mediaType: string;
  sizeLabel: string;
  sizeBytes: number;
  stagedPath: string;
}

export function getStagedAttachments(attachments: ChatAttachment[]): StagedChatAttachment[] {
  return attachments.filter((attachment) => attachment.kind === "staged");
}

export function displayStagedAttachmentsToChatAttachments(
  attachments: DisplayStagedAttachment[],
  idPrefix: string
): StagedChatAttachment[] {
  return attachments.map((attachment, index) => ({
    kind: "staged",
    id: `${idPrefix}-staged-${index}`,
    mediaType: attachment.mediaType,
    filename: attachment.filename,
    sizeBytes: attachment.sizeBytes,
    stagedPath: attachment.stagedPath,
  }));
}

export function appendStagedAttachmentNotice(text: string, attachments: ChatAttachment[]): string {
  const notice = buildStagedAttachmentNotice(getStagedAttachments(attachments));
  if (notice.length === 0) {
    return text;
  }
  return text.trim().length > 0 ? `${text}\n${notice}` : notice.trimStart();
}

/**
 * The raw <attached-files> blocks in a message text, verbatim. For rebuilds
 * that regenerate the surrounding model-facing text (compact-and-retry):
 * staged attachments are deliberately absent from fileParts, so dropping the
 * generated notice would silently lose the file and its workspace path.
 */
export function extractStagedAttachmentNotices(text: string): string[] {
  return (
    text
      .match(ATTACHED_FILES_BLOCK_PATTERN)
      ?.map((block) => block.replace(/^\n/, ""))
      // Only GENERATED notices: a skill argument can itself contain an
      // <attached-files> example (pasted XML, fenced block) that the rebuilt
      // argument text already restores — re-appending it would duplicate
      // user content and change the retried prompt.
      .filter((block) => isGeneratedStagedAttachmentBlock(block)) ?? []
  );
}

export function parseStagedAttachmentNotice(text: string): {
  text: string;
  attachments: DisplayStagedAttachment[];
} {
  const attachments: DisplayStagedAttachment[] = [];
  const visibleText = text.replace(ATTACHED_FILES_BLOCK_PATTERN, (block) => {
    const parsedBlock = parseStagedAttachmentBlock(block);
    if (!isGeneratedStagedAttachmentBlock(block) || parsedBlock.length === 0) {
      return block;
    }
    attachments.push(...parsedBlock);
    return "";
  });

  return { text: visibleText.trimEnd(), attachments };
}

export function stripStagedAttachmentNotice(text: string): string {
  return parseStagedAttachmentNotice(text).text;
}

export function buildStagedAttachmentNotice(attachments: StagedChatAttachment[]): string {
  if (attachments.length === 0) {
    return "";
  }

  const lines = attachments.map(
    (attachment) =>
      `- \`${attachment.filename}\` (\`${attachment.mediaType}\`, ${formatBytes(attachment.sizeBytes)}): \`${attachment.stagedPath}\``
  );

  return `\n${ATTACHED_FILES_OPEN_TAG}\n${STAGED_ATTACHMENT_NOTICE_TEXT}\n\n${lines.join("\n")}\n${ATTACHED_FILES_CLOSE_TAG}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isGeneratedStagedAttachmentBlock(block: string): boolean {
  const normalizedBlock = block.replace(/\r\n/gu, "\n").trimStart();
  return normalizedBlock.startsWith(
    `${ATTACHED_FILES_OPEN_TAG}\n${STAGED_ATTACHMENT_NOTICE_TEXT}\n\n`
  );
}

function parseSizeLabelBytes(sizeLabel: string): number {
  const match = /^(?<amount>\d+(?:\.\d+)?) (?<unit>B|KB|MB)$/u.exec(sizeLabel.trim());
  if (!match?.groups) {
    return 0;
  }

  const amount = Number(match.groups.amount);
  if (!Number.isFinite(amount)) {
    return 0;
  }

  if (match.groups.unit === "B") {
    return Math.round(amount);
  }
  if (match.groups.unit === "KB") {
    return Math.round(amount * 1024);
  }
  return Math.round(amount * 1024 * 1024);
}

function parseStagedAttachmentBlock(block: string): DisplayStagedAttachment[] {
  const parsed: DisplayStagedAttachment[] = [];
  for (const line of block.split(/\r?\n/u)) {
    const match = ATTACHED_FILE_LINE_PATTERN.exec(line.trim());
    if (!match?.groups) {
      continue;
    }
    const sizeLabel = match.groups.sizeLabel;
    parsed.push({
      filename: match.groups.filename,
      mediaType: match.groups.mediaType,
      sizeLabel,
      sizeBytes: parseSizeLabelBytes(sizeLabel),
      stagedPath: match.groups.stagedPath,
    });
  }
  return parsed;
}
