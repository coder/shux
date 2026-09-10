import fsPromises from "fs/promises";
import path from "path";
import type { DemoProjectConfig } from "./demoProject";
import { createMuxMessage, type MuxMessage } from "../../../src/common/types/message";
import { FILE_EDIT_DIFF_OMITTED_MESSAGE } from "../../../src/common/types/tools";
import { HistoryService } from "../../../src/node/services/historyService";

const BASE_TIMESTAMP_MS = 1_700_000_000_000;

type HistoryProfileDefinition = {
  messagePairs: number;
  userChars: number;
  assistantChars: number;
  reasoningChars: number;
  toolOutputChars: number;
  largeDiffLinePairs?: number;
};

const HISTORY_PROFILE_NAMES = [
  "small",
  "medium",
  "large",
  "tool-heavy",
  "reasoning-heavy",
  "large-diff",
] as const;

export type HistoryProfileName = (typeof HISTORY_PROFILE_NAMES)[number];

export interface SeededHistoryProfileSummary {
  profile: HistoryProfileName;
  messageCount: number;
  assistantMessageCount: number;
  estimatedCharacterCount: number;
  hasToolParts: boolean;
  hasReasoningParts: boolean;
  largeDiffLineCount?: number;
}

const HISTORY_PROFILES: Record<HistoryProfileName, HistoryProfileDefinition> = {
  small: {
    messagePairs: 12,
    userChars: 200,
    assistantChars: 2_000,
    reasoningChars: 0,
    toolOutputChars: 0,
  },
  medium: {
    messagePairs: 40,
    userChars: 260,
    assistantChars: 4_500,
    reasoningChars: 0,
    toolOutputChars: 0,
  },
  large: {
    messagePairs: 90,
    userChars: 320,
    assistantChars: 9_500,
    reasoningChars: 0,
    toolOutputChars: 0,
  },
  "tool-heavy": {
    messagePairs: 36,
    userChars: 220,
    assistantChars: 2_800,
    reasoningChars: 0,
    toolOutputChars: 5_200,
  },
  "reasoning-heavy": {
    messagePairs: 34,
    userChars: 220,
    assistantChars: 2_600,
    reasoningChars: 4_400,
    toolOutputChars: 0,
  },
  "large-diff": {
    messagePairs: 1,
    userChars: 220,
    assistantChars: 300,
    reasoningChars: 0,
    toolOutputChars: 0,
    largeDiffLinePairs: 2_500,
  },
};

function buildDeterministicText(label: string, targetLength: number): string {
  const sentence = `${label}: deterministic payload for workspace replay performance profiling. `;
  if (sentence.length >= targetLength) {
    return sentence.slice(0, targetLength);
  }

  let content = "";
  while (content.length < targetLength) {
    content += sentence;
  }
  return content.slice(0, targetLength);
}

function buildLargeFileEditDiff(linePairs: number): string {
  const normalizedLinePairs = Math.max(1, Math.trunc(linePairs));
  const lines = [
    "diff --git a/src/perf-large-diff.ts b/src/perf-large-diff.ts",
    "index 1111111..2222222 100644",
    "--- a/src/perf-large-diff.ts",
    "+++ b/src/perf-large-diff.ts",
    `@@ -1,${normalizedLinePairs} +1,${normalizedLinePairs} @@`,
  ];

  for (let lineIndex = 0; lineIndex < normalizedLinePairs; lineIndex++) {
    const id = String(lineIndex + 1).padStart(4, "0");
    lines.push(
      `-export const perfProbe${id} = "before-${id}";`,
      `+export const perfProbe${id} = "after-${id}";`
    );
  }

  return `${lines.join("\n")}\n`;
}

function createAssistantParts(args: {
  profile: HistoryProfileName;
  index: number;
  toolOutputChars: number;
  reasoningChars: number;
  largeDiffLinePairs?: number;
}): MuxMessage["parts"] {
  const parts: MuxMessage["parts"] = [];

  if (args.toolOutputChars > 0) {
    const toolName = args.index % 2 === 0 ? "file_read" : "bash";
    const outputKey = toolName === "file_read" ? "content" : "output";
    const toolPayload = buildDeterministicText(
      `${args.profile}-tool-${args.index}`,
      args.toolOutputChars
    );

    parts.push({
      type: "dynamic-tool",
      state: "output-available",
      toolCallId: `${args.profile}-tool-call-${args.index}`,
      toolName,
      input:
        toolName === "file_read"
          ? { path: `src/example-${args.index}.ts` }
          : { script: `echo profile-${args.index}` },
      output: {
        success: true,
        [outputKey]: toolPayload,
      },
      timestamp: BASE_TIMESTAMP_MS + args.index,
    });
  }

  if (args.largeDiffLinePairs && args.largeDiffLinePairs > 0) {
    const diff = buildLargeFileEditDiff(args.largeDiffLinePairs);
    parts.push({
      type: "dynamic-tool",
      state: "output-available",
      toolCallId: `${args.profile}-large-diff-tool-call-${args.index}`,
      toolName: "file_edit_replace_string",
      input: {
        path: "src/perf-large-diff.ts",
        old_string: "before",
        new_string: "after",
      },
      output: {
        success: true,
        diff: FILE_EDIT_DIFF_OMITTED_MESSAGE,
        edits_applied: args.largeDiffLinePairs,
        ui_only: { file_edit: { diff } },
      },
      timestamp: BASE_TIMESTAMP_MS + args.index,
    });
  }

  if (args.reasoningChars > 0) {
    parts.push({
      type: "reasoning",
      text: buildDeterministicText(`${args.profile}-reasoning-${args.index}`, args.reasoningChars),
      timestamp: BASE_TIMESTAMP_MS + args.index,
    });
  }

  return parts;
}

async function appendOrThrow(args: {
  historyService: HistoryService;
  workspaceId: string;
  message: MuxMessage;
  profile: HistoryProfileName;
  role: "user" | "assistant";
}): Promise<void> {
  const appendResult = await args.historyService.appendToHistory(args.workspaceId, args.message);
  if (appendResult.success) {
    return;
  }

  throw new Error(
    `Failed to append ${args.role} message for profile ${args.profile}: ${appendResult.error}`
  );
}

export async function seedWorkspaceHistoryProfile(args: {
  demoProject: DemoProjectConfig;
  profile: HistoryProfileName;
}): Promise<SeededHistoryProfileSummary> {
  const { demoProject, profile } = args;
  const profileConfig = HISTORY_PROFILES[profile];

  const historyService = new HistoryService({
    sessionsDir: demoProject.sessionsDir,
    rootDir: path.dirname(demoProject.sessionsDir),
  });

  await fsPromises.writeFile(demoProject.historyPath, "", "utf-8");

  for (let pairIndex = 0; pairIndex < profileConfig.messagePairs; pairIndex++) {
    const userText = buildDeterministicText(
      `${profile}-user-${pairIndex}`,
      profileConfig.userChars
    );
    const userMessage = createMuxMessage(`${profile}-user-msg-${pairIndex}`, "user", userText, {
      timestamp: BASE_TIMESTAMP_MS + pairIndex * 2,
    });
    await appendOrThrow({
      historyService,
      workspaceId: demoProject.workspaceId,
      message: userMessage,
      profile,
      role: "user",
    });

    const assistantText = buildDeterministicText(
      `${profile}-assistant-${pairIndex}`,
      profileConfig.assistantChars
    );
    const assistantParts = createAssistantParts({
      profile,
      index: pairIndex,
      toolOutputChars: profileConfig.toolOutputChars,
      reasoningChars: profileConfig.reasoningChars,
      largeDiffLinePairs: profileConfig.largeDiffLinePairs,
    });

    const assistantMessage = createMuxMessage(
      `${profile}-assistant-msg-${pairIndex}`,
      "assistant",
      assistantText,
      {
        model: "anthropic:claude-sonnet-4-5",
        timestamp: BASE_TIMESTAMP_MS + pairIndex * 2 + 1,
      },
      assistantParts
    );
    await appendOrThrow({
      historyService,
      workspaceId: demoProject.workspaceId,
      message: assistantMessage,
      profile,
      role: "assistant",
    });
  }

  const largeDiffCharacterCount = profileConfig.largeDiffLinePairs
    ? buildLargeFileEditDiff(profileConfig.largeDiffLinePairs).length
    : 0;

  return {
    profile,
    messageCount: profileConfig.messagePairs * 2,
    assistantMessageCount: profileConfig.messagePairs,
    estimatedCharacterCount:
      profileConfig.messagePairs *
        (profileConfig.userChars +
          profileConfig.assistantChars +
          profileConfig.toolOutputChars +
          profileConfig.reasoningChars) +
      largeDiffCharacterCount,
    hasToolParts: profileConfig.toolOutputChars > 0 || largeDiffCharacterCount > 0,
    hasReasoningParts: profileConfig.reasoningChars > 0,
    largeDiffLineCount: profileConfig.largeDiffLinePairs
      ? profileConfig.largeDiffLinePairs * 2 + 5
      : undefined,
  };
}

export function parseHistoryProfilesFromEnv(rawProfiles: string | undefined): HistoryProfileName[] {
  if (!rawProfiles) {
    return [...HISTORY_PROFILE_NAMES];
  }

  const requestedProfiles = rawProfiles
    .split(",")
    .map((profile) => profile.trim())
    .filter((profile) => profile.length > 0);

  const invalidProfile = requestedProfiles.find(
    (profile) => !HISTORY_PROFILE_NAMES.includes(profile as HistoryProfileName)
  );
  if (invalidProfile) {
    throw new Error(
      `Invalid XUM_E2E_PERF_PROFILES entry "${invalidProfile}". Expected one of: ${HISTORY_PROFILE_NAMES.join(", ")}.`
    );
  }

  return requestedProfiles as HistoryProfileName[];
}
