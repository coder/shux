import type { AskUserQuestionQuestion } from "@/common/types/tools";

// Return semantic answer parts; each renderer owns its draft state and Other sentinel.
export function parseAskUserQuestionAnswer(
  question: AskUserQuestionQuestion,
  answer: string
): { optionLabels: string[]; customText: string } {
  const trimmed = answer.trim();
  if (trimmed.length === 0) return { optionLabels: [], customText: "" };

  const optionLabels = new Set(question.options.map((option) => option.label));
  if (!question.multiSelect) {
    return optionLabels.has(trimmed)
      ? { optionLabels: [trimmed], customText: "" }
      : { optionLabels: [], customText: trimmed };
  }

  const selected: string[] = [];
  const otherParts: string[] = [];
  for (const token of trimmed
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)) {
    if (optionLabels.has(token)) selected.push(token);
    else otherParts.push(token);
  }
  return { optionLabels: selected, customText: otherParts.join(", ") };
}
