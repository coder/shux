import assert from "@/common/utils/assert";

import { AlertTriangle, Check } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { useAPI } from "@/browser/contexts/API";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { getSendOptionsFromStorage } from "@/browser/utils/messages/sendOptions";
import { applyCompactionOverrides } from "@/browser/utils/messages/compactionOptions";
import { useAutoResizeTextarea } from "@/browser/hooks/useAutoResizeTextarea";
import { Checkbox } from "@/browser/components/Checkbox/Checkbox";
import { cn } from "@/common/lib/utils";
import { Button } from "@/browser/components/Button/Button";
import {
  ErrorBox,
  ExpandIcon,
  StatusIndicator,
  ToolContainer,
  ToolDetails,
  ToolHeader,
  ToolIcon,
  ToolName,
} from "@/browser/features/Tools/Shared/ToolPrimitives";
import {
  getStatusDisplay,
  useToolExpansion,
  type ToolStatus,
} from "@/browser/features/Tools/Shared/toolUtils";
import type {
  AskUserQuestionQuestion,
  AskUserQuestionToolArgs,
  AskUserQuestionToolResult,
  AskUserQuestionUiOnlyPayload,
  ToolErrorResult,
} from "@/common/types/tools";
import { getToolOutputUiOnly } from "@/common/utils/tools/toolOutputUiOnly";
import { parseAskUserQuestionAnswer } from "@/common/utils/tools/parseAskUserQuestionAnswer";
import { getErrorMessage } from "@/common/utils/errors";
import { formatSendMessageError } from "@/common/utils/errors/formatSendError";

const OTHER_VALUE = "__other__";

interface DraftAnswer {
  selected: string[];
  otherText: string;
}

interface CachedState {
  draftAnswers: Record<string, DraftAnswer>;
  activeIndex: number;
}

// Cache draft state by toolCallId so it survives workspace switches
const draftStateCache = new Map<string, CachedState>();

function unwrapJsonContainer(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  if (record.type === "json" && "value" in record) {
    return record.value;
  }

  return value;
}

function isAskUserQuestionPayload(val: unknown): val is AskUserQuestionUiOnlyPayload {
  if (!val || typeof val !== "object") {
    return false;
  }

  const record = val as Record<string, unknown>;
  if (!Array.isArray(record.questions)) {
    return false;
  }

  if (!record.answers || typeof record.answers !== "object") {
    return false;
  }

  for (const [, v] of Object.entries(record.answers as Record<string, unknown>)) {
    if (typeof v !== "string") {
      return false;
    }
  }

  return true;
}

function isToolErrorResult(val: unknown): val is ToolErrorResult {
  if (!val || typeof val !== "object") {
    return false;
  }

  const record = val as Record<string, unknown>;
  return record.success === false && typeof record.error === "string";
}

function parsePrefilledAnswer(question: AskUserQuestionQuestion, answer: string): DraftAnswer {
  const { optionLabels, customText } = parseAskUserQuestionAnswer(question, answer);
  return {
    selected: customText ? [...optionLabels, OTHER_VALUE] : optionLabels,
    otherText: customText,
  };
}

function isQuestionAnswered(_question: AskUserQuestionQuestion, draft: DraftAnswer): boolean {
  if (draft.selected.length === 0) {
    return false;
  }

  if (draft.selected.includes(OTHER_VALUE)) {
    return draft.otherText.trim().length > 0;
  }

  return true;
}

function draftToAnswerString(question: AskUserQuestionQuestion, draft: DraftAnswer): string {
  assert(isQuestionAnswered(question, draft), "draftToAnswerString requires a complete answer");

  const parts: string[] = [];
  for (const label of draft.selected) {
    if (label === OTHER_VALUE) {
      parts.push(draft.otherText.trim());
    } else {
      parts.push(label);
    }
  }

  if (!question.multiSelect) {
    assert(parts.length === 1, "Single-select questions must have exactly one answer");
    return parts[0];
  }

  return parts.join(", ");
}

/**
 * Get descriptions for selected answer labels from a question's options.
 * Filters out "Other" and labels not found in options.
 */
function getDescriptionsForLabels(question: AskUserQuestionQuestion, labels: string[]): string[] {
  return labels
    .filter((label) => label !== OTHER_VALUE)
    .map((label) => question.options.find((o) => o.label === label)?.description)
    .filter((d): d is string => d !== undefined);
}

/** Auto-resizing textarea for "Other" text input. */
function AutoResizeTextarea(props: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
}): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useAutoResizeTextarea(textareaRef, props.value, 30);

  return (
    <textarea
      ref={textareaRef}
      // Keep the empty natural height at one line (textareas default to rows=2) so
      // useAutoResizeTextarea can leave empty drafts to CSS sizing without measuring.
      rows={1}
      placeholder={props.placeholder}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      onKeyDown={(e) => {
        // Submit on Enter without shift (shift+Enter for newline)
        if (e.key === "Enter" && !e.shiftKey && props.value.trim().length > 0) {
          e.preventDefault();
          props.onSubmit();
        }
      }}
      className={cn(
        "border border-white/10 bg-code-bg text-foreground placeholder:text-muted",
        "w-full rounded-md px-3 py-2 text-sm",
        "transition-colors hover:border-white/20",
        "focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent/50 focus-visible:outline-none",
        "resize-none min-h-[2.5rem] max-h-[30vh] overflow-y-auto"
      )}
    />
  );
}

export function AskUserQuestionToolCall(props: {
  args: AskUserQuestionToolArgs;
  result: AskUserQuestionToolResult | null;
  status: ToolStatus;
  toolCallId: string;
  workspaceId?: string;
}): JSX.Element {
  const { api } = useAPI();

  // A live, blocking question must never be hidden behind a collapsed "tools"
  // preference, so force it open while executing. forceExpanded only overrides the
  // initial seed; once answered the row follows the sticky preference like any tool.
  const { expanded, toggleExpanded } = useToolExpansion(false, {
    forceExpanded: props.status === "executing",
  });
  const statusDisplay = getStatusDisplay(props.status);

  const argsAnswers = props.args.answers ?? {};

  // Restore from cache if available (survives workspace switches)
  const cachedState = draftStateCache.get(props.toolCallId);

  const [activeIndex, setActiveIndex] = useState(() => cachedState?.activeIndex ?? 0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const workspaceStore = useWorkspaceStoreRaw();
  const workspaceState = useSyncExternalStore(
    (listener) => {
      if (!props.workspaceId) {
        return () => undefined;
      }

      return workspaceStore.subscribeKey(props.workspaceId, listener);
    },
    () => {
      if (!props.workspaceId) {
        return null;
      }

      // Some render paths (nested tool rendering) do not have workspace context.
      // Fail-soft so ask_user_question still renders instead of crashing the tree.
      try {
        return workspaceStore.getWorkspaceState(props.workspaceId);
      } catch {
        return null;
      }
    }
  );
  const autoRetryRollbackWorkspaceIdRef = useRef<string | null>(null);
  const autoRetryRollbackPendingRef = useRef(false);
  const autoRetryRollbackArmedRef = useRef(false);
  const autoRetryRollbackBaselineMessageCountRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);
  const apiRef = useRef(api);

  useEffect(() => {
    apiRef.current = api;
  }, [api]);

  const rollbackAutoRetryIfNeeded = useCallback(
    async (options?: { suppressErrors?: boolean }): Promise<void> => {
      if (!autoRetryRollbackPendingRef.current) {
        return;
      }

      const rollbackWorkspaceId = autoRetryRollbackWorkspaceIdRef.current;

      autoRetryRollbackPendingRef.current = false;
      autoRetryRollbackArmedRef.current = false;
      autoRetryRollbackBaselineMessageCountRef.current = null;
      autoRetryRollbackWorkspaceIdRef.current = null;

      const activeApi = apiRef.current;
      if (!activeApi || !rollbackWorkspaceId) {
        return;
      }

      const rollbackResult = await activeApi.workspace.setAutoRetryEnabled?.({
        workspaceId: rollbackWorkspaceId,
        enabled: false,
        persist: false,
      });
      if (rollbackResult && !rollbackResult.success && !options?.suppressErrors) {
        setSubmitError(rollbackResult.error);
      }
    },
    []
  );

  useEffect(() => {
    if (!autoRetryRollbackPendingRef.current) {
      return;
    }

    // If rendering moves away from the workspace that enabled temporary retry,
    // rollback immediately so the prior workspace preference is restored.
    const rollbackWorkspaceId = autoRetryRollbackWorkspaceIdRef.current;
    if (!rollbackWorkspaceId || rollbackWorkspaceId === props.workspaceId) {
      return;
    }

    void rollbackAutoRetryIfNeeded();
  }, [props.workspaceId, rollbackAutoRetryIfNeeded]);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      if (!autoRetryRollbackPendingRef.current) {
        return;
      }

      // Teardown-safe rollback: if the tool component unmounts before stream-state
      // transitions fire (workspace switch/removal/app exit), restore preference now.
      void rollbackAutoRetryIfNeeded({ suppressErrors: true });
    };
  }, [rollbackAutoRetryIfNeeded]);

  useEffect(() => {
    if (!autoRetryRollbackPendingRef.current) {
      return;
    }

    const autoRetryStatusType = workspaceState?.autoRetryStatus?.type;
    const autoRetryActive =
      autoRetryStatusType === "auto-retry-scheduled" ||
      autoRetryStatusType === "auto-retry-starting";
    const streamInFlight =
      workspaceState?.isStreamStarting === true || workspaceState?.canInterrupt === true;

    // Wait until the resumed stream has actually reached an in-flight state before
    // considering rollback. This avoids disabling auto-retry immediately after
    // resumeStream() resolves but before the resumed attempt's outcome is known.
    if (autoRetryActive || streamInFlight) {
      autoRetryRollbackArmedRef.current = true;
      return;
    }

    const baselineMessageCount = autoRetryRollbackBaselineMessageCountRef.current;
    const hasObservedPostResumeMessage =
      baselineMessageCount !== null &&
      (workspaceState?.messages.length ?? 0) > baselineMessageCount;
    if (!autoRetryRollbackArmedRef.current && !hasObservedPostResumeMessage) {
      return;
    }

    void rollbackAutoRetryIfNeeded();
  }, [
    rollbackAutoRetryIfNeeded,
    workspaceState?.autoRetryStatus,
    workspaceState?.isStreamStarting,
    workspaceState?.canInterrupt,
    workspaceState?.messages.length,
  ]);

  const [draftAnswers, setDraftAnswers] = useState<Record<string, DraftAnswer>>(() => {
    if (cachedState) {
      return cachedState.draftAnswers;
    }

    const initial: Record<string, DraftAnswer> = {};
    for (const q of props.args.questions) {
      const prefilled = argsAnswers[q.question];
      if (typeof prefilled === "string") {
        initial[q.question] = parsePrefilledAnswer(q, prefilled);
      } else {
        initial[q.question] = { selected: [], otherText: "" };
      }
    }
    return initial;
  });

  // Sync draft state to cache so it survives workspace switches
  useEffect(() => {
    if (props.status === "executing") {
      draftStateCache.set(props.toolCallId, { draftAnswers, activeIndex });
    } else {
      // Clean up cache when tool completes
      draftStateCache.delete(props.toolCallId);
    }
  }, [props.toolCallId, props.status, draftAnswers, activeIndex]);

  const resultUnwrapped = useMemo(() => {
    if (!props.result) {
      return null;
    }

    return unwrapJsonContainer(props.result);
  }, [props.result]);

  const uiOnlyPayload = getToolOutputUiOnly(resultUnwrapped)?.ask_user_question;

  const successResult =
    uiOnlyPayload ??
    (resultUnwrapped && isAskUserQuestionPayload(resultUnwrapped) ? resultUnwrapped : null);

  const errorResult =
    resultUnwrapped && isToolErrorResult(resultUnwrapped) ? resultUnwrapped : null;

  const isComplete = useMemo(() => {
    return props.args.questions.every((q) => {
      const draft = draftAnswers[q.question];
      return draft ? isQuestionAnswered(q, draft) : false;
    });
  }, [draftAnswers, props.args.questions]);

  const submitButtonRef = useRef<HTMLButtonElement>(null);

  const summaryIndex = props.args.questions.length;
  const isOnSummary = activeIndex === summaryIndex;

  // Focus submit button when reaching summary so Enter submits
  useEffect(() => {
    if (props.status === "executing" && isOnSummary) {
      submitButtonRef.current?.focus();
    }
  }, [isOnSummary, props.status]);

  const currentQuestion = isOnSummary
    ? null
    : props.args.questions[Math.min(activeIndex, props.args.questions.length - 1)];
  const currentDraft = currentQuestion ? draftAnswers[currentQuestion.question] : undefined;

  const unansweredCount = useMemo(() => {
    return props.args.questions.filter((q) => {
      const draft = draftAnswers[q.question];
      return !draft || !isQuestionAnswered(q, draft);
    }).length;
  }, [draftAnswers, props.args.questions]);

  const handleSubmit = (): void => {
    setIsSubmitting(true);
    setSubmitError(null);

    let answers: Record<string, string>;
    let workspaceId: string;

    try {
      answers = {};
      for (const q of props.args.questions) {
        const draft = draftAnswers[q.question];
        if (draft && isQuestionAnswered(q, draft)) {
          answers[q.question] = draftToAnswerString(q, draft);
        } else {
          // Unanswered questions get empty string
          answers[q.question] = "";
        }
      }

      assert(api, "API not connected");
      assert(props.workspaceId, "workspaceId is required");
      workspaceId = props.workspaceId;
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      setSubmitError(errorMessage);
      setIsSubmitting(false);
      return;
    }

    api.workspace
      .answerAskUserQuestion({
        workspaceId,
        toolCallId: props.toolCallId,
        answers,
      })
      .then(async (result) => {
        if (!result.success) {
          setSubmitError(result.error);
          return;
        }

        // If the stream was interrupted (e.g. app restart), explicitly resume using
        // the latest persisted send options for this workspace.
        let sendOptions = getSendOptionsFromStorage(workspaceId);
        const lastUserMessage = [...(workspaceState?.messages ?? [])]
          .reverse()
          .find(
            (message): message is Extract<typeof message, { type: "user" }> =>
              message.type === "user"
          );

        if (lastUserMessage?.compactionRequest) {
          sendOptions = applyCompactionOverrides(
            sendOptions,
            lastUserMessage.compactionRequest.parsed
          );
        }

        const enableResult = await api.workspace.setAutoRetryEnabled?.({
          workspaceId,
          enabled: true,
          persist: false,
        });
        if (enableResult && !enableResult.success) {
          setSubmitError(enableResult.error);
          return;
        }

        if (enableResult?.success && enableResult.data.previousEnabled === false) {
          // Ask-user resume temporarily enables auto-retry for this attempt.
          // Roll back only after the resumed stream reaches a terminal outcome.
          if (!isMountedRef.current) {
            await api.workspace.setAutoRetryEnabled?.({
              workspaceId,
              enabled: false,
              persist: false,
            });
          } else {
            autoRetryRollbackWorkspaceIdRef.current = workspaceId;
            autoRetryRollbackPendingRef.current = true;
            autoRetryRollbackArmedRef.current = false;
            autoRetryRollbackBaselineMessageCountRef.current = workspaceState?.messages.length ?? 0;
          }
        }

        const resumeResult = await api.workspace.resumeStream({
          workspaceId,
          options: sendOptions,
        });
        if (!resumeResult.success) {
          const formatted = formatSendMessageError(resumeResult.error);
          const detail = formatted.resolutionHint
            ? `${formatted.message} ${formatted.resolutionHint}`
            : formatted.message;
          setSubmitError(detail);

          // Keep retry preference consistent when resume fails before stream events.
          await rollbackAutoRetryIfNeeded();
          return;
        }

        if (
          autoRetryRollbackPendingRef.current &&
          !autoRetryRollbackArmedRef.current &&
          resumeResult.data.started === false
        ) {
          await rollbackAutoRetryIfNeeded({ suppressErrors: true });
        }
      })
      .catch(async (error) => {
        const errorMessage = getErrorMessage(error);
        setSubmitError(errorMessage);
        await rollbackAutoRetryIfNeeded();
      })
      .finally(() => {
        setIsSubmitting(false);
      });
  };
  const title = "ask_user_question";
  const totalCount = props.args.questions.length;
  const answeredCount = totalCount - unansweredCount;

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="ask_user_question" />
        <div className="flex min-w-0 flex-1 flex-col">
          <ToolName>{title}</ToolName>
          {props.status === "executing" && (
            <div className="text-secondary text-[10px] leading-tight">
              Answer below, or type a message in chat to cancel.
            </div>
          )}
        </div>
        <StatusIndicator status={props.status}>{statusDisplay}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <div className="flex flex-col gap-3">
            {props.status === "executing" && (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  {props.args.questions.map((q, idx) => {
                    const draft = draftAnswers[q.question];
                    const answered = draft ? isQuestionAnswered(q, draft) : false;
                    const isActive = idx === activeIndex;
                    return (
                      <button
                        key={q.question}
                        type="button"
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                          isActive
                            ? "border-accent bg-accent text-accent-foreground shadow-sm"
                            : answered
                              ? "border-success/40 bg-success/10 text-success hover:bg-success/20"
                              : "border-white/10 bg-white/5 text-secondary hover:border-white/20 hover:text-foreground"
                        )}
                        onClick={() => setActiveIndex(idx)}
                      >
                        {q.header}
                        {answered && !isActive && <Check aria-hidden="true" className="h-3 w-3" />}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                      isOnSummary
                        ? "border-accent bg-accent text-accent-foreground shadow-sm"
                        : isComplete
                          ? "border-success/40 bg-success/10 text-success hover:bg-success/20"
                          : "border-white/10 bg-white/5 text-secondary hover:border-white/20 hover:text-foreground"
                    )}
                    onClick={() => setActiveIndex(summaryIndex)}
                  >
                    Summary
                    {isComplete && !isOnSummary && <Check aria-hidden="true" className="h-3 w-3" />}
                  </button>
                  {totalCount > 0 && (
                    <span className="text-muted counter-nums ml-auto text-[10px]">
                      {answeredCount}/{totalCount} answered
                    </span>
                  )}
                </div>

                {!isOnSummary && currentQuestion && currentDraft && (
                  <>
                    <div className="flex flex-col gap-0.5">
                      <div className="text-foreground text-sm leading-snug font-medium">
                        {currentQuestion.question}
                      </div>
                      <div className="text-secondary text-[10px] tracking-wide uppercase">
                        {currentQuestion.multiSelect ? "Select one or more" : "Select one"}
                      </div>
                    </div>

                    <div className="-mx-2 flex flex-col gap-0.5">
                      {/* Render option checkboxes */}
                      {[
                        ...currentQuestion.options.map((opt) => ({
                          label: opt.label,
                          displayLabel: opt.label,
                          description: opt.description,
                        })),
                        {
                          label: OTHER_VALUE,
                          displayLabel: "Other",
                          description: "Provide a custom answer.",
                        },
                      ].map((opt) => {
                        const checked = currentDraft.selected.includes(opt.label);

                        const toggle = () => {
                          const isSelecting = !checked;

                          setDraftAnswers((prev) => {
                            const draft = prev[currentQuestion.question] ?? {
                              selected: [],
                              otherText: "",
                            };

                            if (currentQuestion.multiSelect) {
                              // Multi-select: toggle this option
                              const selected = new Set(draft.selected);
                              if (selected.has(opt.label)) {
                                selected.delete(opt.label);
                              } else {
                                selected.add(opt.label);
                              }
                              return {
                                ...prev,
                                [currentQuestion.question]: {
                                  ...draft,
                                  selected: Array.from(selected),
                                },
                              };
                            } else {
                              // Single-select: replace selection (clear otherText if not Other)
                              return {
                                ...prev,
                                [currentQuestion.question]: {
                                  selected: checked ? [] : [opt.label],
                                  otherText: opt.label === OTHER_VALUE ? draft.otherText : "",
                                },
                              };
                            }
                          });

                          // For single-select questions, auto-advance *only* when the user selects
                          // a non-Other option (avoid useEffect auto-advance that breaks back-nav).
                          if (
                            !currentQuestion.multiSelect &&
                            isSelecting &&
                            opt.label !== OTHER_VALUE
                          ) {
                            setActiveIndex((idx) => idx + 1);
                          }
                        };

                        return (
                          <div
                            key={opt.label}
                            role="button"
                            tabIndex={0}
                            className={cn(
                              "flex cursor-pointer items-start gap-2.5 rounded px-2 py-1.5 transition-colors select-none",
                              checked ? "bg-accent/10 hover:bg-accent/15" : "hover:bg-white/5"
                            )}
                            onClick={toggle}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                toggle();
                              }
                            }}
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={toggle}
                              onClick={(e) => e.stopPropagation()}
                              className="mt-0.5"
                            />
                            <div className="flex min-w-0 flex-col">
                              <div
                                className={cn(
                                  "text-sm leading-snug",
                                  checked ? "text-foreground font-medium" : "text-foreground"
                                )}
                              >
                                {opt.displayLabel}
                              </div>
                              <div className="text-muted-foreground text-[11px] leading-snug">
                                {opt.description}
                              </div>
                            </div>
                          </div>
                        );
                      })}

                      {currentDraft.selected.includes(OTHER_VALUE) && (
                        <div className="mt-1.5 px-2">
                          <AutoResizeTextarea
                            placeholder="Type your answer"
                            value={currentDraft.otherText}
                            onChange={(value) => {
                              setDraftAnswers((prev) => ({
                                ...prev,
                                [currentQuestion.question]: {
                                  ...(prev[currentQuestion.question] ?? {
                                    selected: [],
                                    otherText: "",
                                  }),
                                  otherText: value,
                                },
                              }));
                            }}
                            onSubmit={() => setActiveIndex(activeIndex + 1)}
                          />
                        </div>
                      )}
                    </div>
                  </>
                )}

                {isOnSummary && (
                  <div className="flex flex-col gap-2">
                    <div className="text-foreground text-sm font-medium">Review your answers</div>
                    {unansweredCount > 0 && (
                      <div className="border-warning/30 bg-warning/10 text-warning flex items-center gap-1.5 rounded border px-2 py-1 text-[11px]">
                        <AlertTriangle aria-hidden="true" className="h-3 w-3 shrink-0" />
                        <span>
                          {unansweredCount} question{unansweredCount > 1 ? "s" : ""} not answered
                        </span>
                      </div>
                    )}
                    <div className="flex flex-col gap-1">
                      {props.args.questions.map((q, idx) => {
                        const draft = draftAnswers[q.question];
                        const answered = draft ? isQuestionAnswered(q, draft) : false;
                        const answerText = answered ? draftToAnswerString(q, draft) : null;
                        const descriptions = answered
                          ? getDescriptionsForLabels(q, draft.selected)
                          : [];
                        return (
                          <div
                            key={q.question}
                            role="button"
                            tabIndex={0}
                            className="bg-code-bg flex cursor-pointer items-start gap-2 rounded border border-white/5 px-2.5 py-1.5 transition-colors hover:border-white/15 hover:bg-white/5"
                            onClick={() => setActiveIndex(idx)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                setActiveIndex(idx);
                              }
                            }}
                          >
                            {answered ? (
                              <Check
                                aria-hidden="true"
                                className="text-success mt-0.5 h-3 w-3 shrink-0"
                              />
                            ) : (
                              <AlertTriangle
                                aria-hidden="true"
                                className="text-warning mt-0.5 h-3 w-3 shrink-0"
                              />
                            )}
                            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                              <div className="text-secondary text-[10px] tracking-wide uppercase">
                                {q.header}
                              </div>
                              <div className="text-sm leading-snug">
                                {answered ? (
                                  <span className="text-foreground">{answerText}</span>
                                ) : (
                                  <span className="text-muted italic">Not answered</span>
                                )}
                              </div>
                              {descriptions.length > 0 && (
                                <div className="text-muted-foreground text-[11px] italic">
                                  {descriptions.join("; ")}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {submitError && <ErrorBox>{submitError}</ErrorBox>}
              </div>
            )}

            {props.status !== "executing" && (
              <div className="flex flex-col gap-2">
                {successResult && (
                  <div className="flex flex-col gap-1.5">
                    <div className="text-secondary text-[10px] tracking-wide uppercase">
                      User answered
                    </div>
                    {Object.entries(successResult.answers).map(([question, answer]) => {
                      const questionDef = successResult.questions.find(
                        (q) => q.question === question
                      );
                      // Parse answer labels (could be comma-separated for multi-select)
                      const answerLabels = answer.split(",").map((s) => s.trim());
                      const descriptions = questionDef
                        ? getDescriptionsForLabels(questionDef, answerLabels)
                        : [];
                      const header = questionDef?.header ?? question;

                      return (
                        <div
                          key={question}
                          className="bg-code-bg flex flex-col gap-0.5 rounded border border-white/5 px-2.5 py-1.5"
                        >
                          <div className="text-secondary text-[10px] tracking-wide uppercase">
                            {header}
                          </div>
                          <div className="text-foreground text-sm leading-snug">{answer}</div>
                          {descriptions.length > 0 && (
                            <div className="text-muted-foreground text-[11px] italic">
                              {descriptions.join("; ")}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {errorResult && <ErrorBox>{errorResult.error}</ErrorBox>}
              </div>
            )}

            {props.status === "executing" && (
              <div className="flex items-center justify-between gap-3 border-t border-white/5 pt-2">
                <div className="text-muted min-w-0 flex-1 text-[10px] italic">
                  Tip: type a message in chat to cancel these questions.
                </div>
                {isOnSummary ? (
                  <Button
                    ref={submitButtonRef}
                    disabled={isSubmitting}
                    onClick={handleSubmit}
                    size="sm"
                  >
                    {isSubmitting ? "Submitting…" : "Submit answers"}
                  </Button>
                ) : (
                  <Button
                    onClick={() => setActiveIndex(activeIndex + 1)}
                    size="sm"
                    variant="outline"
                  >
                    Next
                  </Button>
                )}
              </div>
            )}
          </div>
        </ToolDetails>
      )}
    </ToolContainer>
  );
}
