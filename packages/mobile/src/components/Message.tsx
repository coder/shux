import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Brain, Check, ChevronDown, ChevronRight, File, Pause, Wrench } from "lucide-react-native";
import type { MuxMessage, MuxToolPart } from "../../../../src/common/types/message";
import type { AskUserQuestionQuestion } from "../../../../src/common/types/tools";
import { AskUserQuestionToolArgsSchema } from "../../../../src/common/utils/tools/toolDefinitions";
import { Button, Field, Notice, Sheet } from "./Controls";
import { Markdown } from "./Markdown";
import { mergeAdjacentParts } from "../../../../src/common/utils/messages/mergeAdjacentParts";
import { colors, layout, mono, radii, spacing, typography } from "../theme";

export function Message(props: {
  message: MuxMessage;
  canAnswer: boolean;
  streaming?: boolean;
  onAnswer: (toolCallId: string, answers: Record<string, string>) => Promise<void>;
}) {
  const user = props.message.role === "user";
  const label = user
    ? "Your message"
    : props.message.role === "assistant"
      ? "Assistant message"
      : "System message";
  return (
    <View role="group" accessibilityLabel={label} style={[styles.message, user && styles.user]}>
      {props.message.role === "system" && <Text style={styles.secondary}>System</Text>}
      {/* Persisted snapshots retain wire chunks; project the same contiguous display runs as desktop. */}
      {mergeAdjacentParts(props.message.parts).map((part, index) => {
        switch (part.type) {
          case "text":
            return <Markdown key={index} text={part.text} />;
          case "reasoning":
            return <Reasoning key={index} text={part.text} streaming={Boolean(props.streaming)} />;
          case "dynamic-tool":
            return (
              <Tool
                key={part.toolCallId}
                part={part}
                streaming={Boolean(props.streaming)}
                interrupted={Boolean(props.message.metadata?.partial)}
                canAnswer={props.canAnswer}
                onAnswer={props.onAnswer}
              />
            );
          case "file":
            return (
              <View key={index} style={layout.row}>
                <File size={16} color={colors.muted} />
                <Text style={styles.secondary}>{part.filename ?? part.mediaType} · attachment</Text>
              </View>
            );
        }
      })}
      {props.message.role === "assistant" &&
        !props.streaming &&
        (props.message.metadata?.error ? (
          <Notice>{props.message.metadata.error}</Notice>
        ) : (
          (props.message.metadata?.partial || props.message.parts.length === 0) && (
            <View style={styles.interrupted}>
              {props.message.metadata?.partial && <Pause size={13} color={colors.muted} />}
              {/* Empty replay rows may lack an interruption marker; don't invent a stop reason. */}
              <Text style={styles.secondary}>
                {props.message.metadata?.partial ? "Interrupted" : "No response received"}
              </Text>
            </View>
          )
        ))}
    </View>
  );
}

function Reasoning(props: { text: string; streaming: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Reasoning"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={styles.actionRow}
      >
        <Brain size={16} color={colors.muted} />
        <Text style={[styles.secondary, { flex: 1 }]}>Reasoning</Text>
        {expanded ? (
          <ChevronDown size={16} color={colors.muted} />
        ) : (
          <ChevronRight size={16} color={colors.muted} />
        )}
      </Pressable>
      {expanded && (
        <View style={styles.reasoningBody}>
          {props.text ? (
            <Markdown text={props.text} />
          ) : (
            <Text style={styles.secondary}>
              {props.streaming ? "Thinking…" : "No reasoning text available."}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toolHint(input: unknown): string | undefined {
  if (!record(input)) return;
  for (const key of ["path", "file_path", "filePath", "command", "script"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim())
      return value.replace(/\s+/g, " ").trim().slice(0, 160);
  }
}

function toolStatus(part: MuxToolPart, streaming: boolean, interrupted: boolean): string {
  if (part.state === "output-redacted") return part.failed ? "Failed" : "Redacted";
  if (part.state === "output-available") {
    return record(part.output) && (part.output.success === false || part.output.error)
      ? "Failed"
      : "Done";
  }
  if (!streaming) return interrupted ? "Interrupted" : "No result";
  if (part.toolName === "ask_user_question") return "Needs input";
  return part.executionStartedAt != null ? "Running" : "Pending";
}

const MAX_TOOL_CHARACTERS = 24_000;

function ToolValue(props: { label: string; value: unknown }) {
  const text =
    typeof props.value === "string"
      ? props.value
      : (JSON.stringify(props.value, null, 2) ?? "No output");
  return (
    <View style={{ gap: spacing.sm }}>
      <Text style={layout.label}>{props.label}</Text>
      <ScrollView
        horizontal
        style={styles.outputSurface}
        contentContainerStyle={{ padding: spacing.lg }}
      >
        <Text selectable style={styles.output}>
          {text.slice(0, MAX_TOOL_CHARACTERS)}
        </Text>
      </ScrollView>
      {text.length > MAX_TOOL_CHARACTERS && (
        <Text style={styles.secondary}>
          Showing the first {MAX_TOOL_CHARACTERS.toLocaleString()} characters.
        </Text>
      )}
    </View>
  );
}

function Tool(props: {
  part: MuxToolPart;
  streaming: boolean;
  interrupted: boolean;
  canAnswer: boolean;
  onAnswer: (toolCallId: string, answers: Record<string, string>) => Promise<void>;
}) {
  const [inspecting, setInspecting] = useState(false);
  const questions =
    props.part.toolName === "ask_user_question" && props.part.state === "input-available"
      ? (AskUserQuestionToolArgsSchema.safeParse(props.part.input).data?.questions ?? [])
      : [];
  const name = props.part.toolName
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
  const hint = toolHint(props.part.input);
  const status = toolStatus(props.part, props.streaming, props.interrupted);
  return (
    <View style={{ gap: spacing.sm }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${name}: ${status}${hint ? `. ${hint}` : ""}`}
        accessibilityState={{ expanded: inspecting }}
        onPress={() => setInspecting(true)}
        style={styles.actionRow}
      >
        <Wrench size={16} color={colors.muted} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={styles.toolName}>
            {name}
            {hint && <Text style={styles.toolHint}> {hint}</Text>}
          </Text>
        </View>
        <Text style={[styles.secondary, status === "Failed" && { color: colors.danger }]}>
          {status}
        </Text>
        <ChevronRight size={16} color={colors.muted} />
      </Pressable>
      {inspecting && (
        <Sheet title={name} onClose={() => setInspecting(false)}>
          <Text style={[styles.secondary, status === "Failed" && { color: colors.danger }]}>
            {status}
          </Text>
          <ToolValue label="Input" value={props.part.input} />
          {props.part.state === "output-available" ? (
            <ToolValue label="Output" value={props.part.output} />
          ) : props.part.state === "output-redacted" ? (
            <Notice severity="info">The tool output is redacted.</Notice>
          ) : (
            <Text style={styles.secondary}>
              {props.streaming ? "Waiting for tool output…" : "No tool output was recorded."}
            </Text>
          )}
        </Sheet>
      )}
      {questions.length > 0 && (
        <QuestionForm
          questions={questions}
          disabled={!props.canAnswer}
          onSubmit={(answers) => props.onAnswer(props.part.toolCallId, answers)}
        />
      )}
    </View>
  );
}

interface QuestionDraft {
  selected: Array<string | null>;
  otherText: string;
}

function QuestionForm(props: {
  questions: AskUserQuestionQuestion[];
  disabled: boolean;
  onSubmit: (answers: Record<string, string>) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState(() => new Map<string, QuestionDraft>());
  // Match desktop answer serialization: selection order, comma-separated labels,
  // and trimmed Other text. Null keeps the implicit choice distinct from tool labels.
  const answers = Object.fromEntries(
    props.questions.map((question) => {
      const draft = drafts.get(question.question);
      const complete =
        draft &&
        draft.selected.length > 0 &&
        (!draft.selected.includes(null) || draft.otherText.trim().length > 0);
      return [
        question.question,
        complete ? draft.selected.map((label) => label ?? draft.otherText.trim()).join(", ") : "",
      ];
    })
  );
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = props.disabled || busy || submitted;
  const complete = props.questions.every((question) => Boolean(answers[question.question]));
  async function submit() {
    if (disabled || !complete) return;
    setBusy(true);
    setError(null);
    try {
      await props.onSubmit(answers);
      setSubmitted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send answers.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={styles.question}>
      <Text style={layout.label}>Your input is needed</Text>
      {props.questions.map((question) => {
        const draft = drafts.get(question.question) ?? { selected: [], otherText: "" };
        return (
          <View
            key={question.question}
            role={question.multiSelect ? "group" : "radiogroup"}
            accessibilityLabel={question.question}
            style={{ gap: spacing.sm }}
          >
            <Text style={layout.label}>{question.header}</Text>
            <Text style={layout.text}>{question.question}</Text>
            {[...question.options, { label: null, description: "Provide a custom answer." }].map(
              (option) => {
                const checked = draft.selected.includes(option.label);
                return (
                  <Pressable
                    key={option.label ?? "other"}
                    accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
                    accessibilityLabel={option.label ?? "Other"}
                    accessibilityState={{ checked, disabled }}
                    aria-checked={checked}
                    disabled={disabled}
                    onPress={() =>
                      setDrafts((current) =>
                        new Map(current).set(question.question, {
                          selected: checked
                            ? draft.selected.filter((label) => label !== option.label)
                            : question.multiSelect
                              ? [...draft.selected, option.label]
                              : [option.label],
                          otherText:
                            !question.multiSelect && option.label !== null ? "" : draft.otherText,
                        })
                      )
                    }
                    style={[styles.option, checked && { backgroundColor: colors.elevated }]}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={layout.text}>{option.label ?? "Other"}</Text>
                      <Text style={styles.secondary}>{option.description}</Text>
                    </View>
                    <View style={{ width: 18 }}>
                      {checked && <Check size={18} color={colors.selection} />}
                    </View>
                  </Pressable>
                );
              }
            )}
            {draft.selected.includes(null) && (
              <Field
                label={`Other: ${question.question}`}
                value={draft.otherText}
                onChangeText={(otherText) =>
                  setDrafts((current) =>
                    new Map(current).set(question.question, { ...draft, otherText })
                  )
                }
                placeholder="Your answer…"
                multiline
                editable={!disabled}
              />
            )}
          </View>
        );
      })}
      {error && <Notice>{error}</Notice>}
      <Button busy={busy} disabled={disabled || !complete} onPress={submit}>
        {submitted ? "Answers sent" : "Send answers"}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  message: { gap: spacing.md, paddingVertical: spacing.lg, alignSelf: "stretch" },
  secondary: { ...typography.footnote, color: colors.muted },
  user: {
    backgroundColor: colors.user,
    borderRadius: radii.card,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    alignSelf: "flex-end",
    maxWidth: "94%",
  },
  interrupted: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  actionRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 44 },
  reasoningBody: {
    marginLeft: spacing.sm,
    paddingLeft: spacing.lg,
    paddingVertical: spacing.sm,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.border,
  },
  toolName: { ...typography.footnote, color: colors.muted },
  toolHint: { color: colors.text },
  outputSurface: { backgroundColor: colors.panel, borderRadius: radii.control },
  output: { ...typography.footnote, color: colors.text, fontFamily: mono, lineHeight: 21 },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 44,
    padding: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radii.control,
  },
  question: {
    gap: spacing.lg,
    borderRadius: radii.card,
    backgroundColor: colors.panel,
    padding: spacing.lg,
  },
});
