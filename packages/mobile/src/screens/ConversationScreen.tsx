import { useEffect, useRef, useState } from "react";
import type { SetStateAction } from "react";
import { FlatList, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ClipboardList,
  Settings,
  GitCompareArrows,
  ChevronLeft,
  Square,
} from "lucide-react-native";
import type { MobileClient } from "../api";
import type { FrontendWorkspaceMetadata } from "../../../../src/common/types/workspace";
import type { MuxMessage } from "../../../../src/common/types/message";
import { Button, IconButton, Loading, Notice } from "../components/Controls";
import { KeyboardAvoidingView } from "../components/Keyboard";
import { Message } from "../components/Message";
import { ContextUsage } from "../components/ContextUsage";
import { getContextMeterData } from "../contextUsage";
import { useConversation } from "../useConversation";
import { linkedAbortController } from "../useConnection";
import { getPolicyBlockReason, modelName, resolveSettings } from "../settings";
import type { ChatSettings } from "../settings";
import { ModelSettings } from "./ModelSettings";
import { colors, fontFamily, layout, radii, spacing, typography } from "../theme";
import { THINKING_LEVEL_OFF } from "../../../../src/common/types/thinking";

// RN Web reports scrollHeight, which cannot shrink a fixed-height textarea and
// can expand hidden stack screens. Let the browser size content; native uses its intrinsic measurement.
// Focus belongs on the rounded composer. Browser "auto" outlines can still paint at zero width.
const webInputSizing = {
  fieldSizing: "content",
  height: "auto",
  outlineStyle: "solid",
  outlineWidth: 0,
} as const;

export function ConversationScreen(props: {
  client: MobileClient;
  serverLabel: string;
  workspace: FrontendWorkspaceMetadata;
  signal: AbortSignal;
  connected: boolean;
  onReconnect: () => Promise<void>;
  onBack: () => void;
  selection: ChatSettings | null;
  onSelectionChange: (value: ChatSettings) => void;
  draft: string;
  onDraftChange: (value: SetStateAction<string>) => void;
  onChanges: () => void;
  onSettings: () => void;
}) {
  const { transcript, settings, error, loadOlder, loadingOlder, historyError } = useConversation(
    props.client,
    props.workspace.id,
    props.signal
  );
  const draft = props.draft;
  const setDraft = props.onDraftChange;
  const [inputFocused, setInputFocused] = useState(false);
  const [inputHeight, setInputHeight] = useState(44);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [resumeMessageId, setResumeMessageId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState<"model" | "agent" | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [composerHeight, setComposerHeight] = useState(100);
  const list = useRef<FlatList<MuxMessage>>(null);
  const controller = useRef(new AbortController());
  const pending = useRef(false);
  // This component is keyed by workspace ID: both subscription and in-flight actions
  // belong to one workspace, and a switch cannot expose the previous draft/history.
  useEffect(() => {
    const abort = linkedAbortController(props.signal);
    controller.current = abort;
    pending.current = false;
    setBusy(false);
    return () => abort.abort();
  }, [props.signal]);
  const latestTranscript = useRef(transcript);
  // Answer RPCs can outlive stream updates from another client. Consult the latest
  // committed transcript before starting recovery, not the pre-answer render.
  useEffect(() => {
    latestTranscript.current = transcript;
  }, [transcript]);
  const agentId = props.workspace.agentId ?? "exec";
  const options = settings
    ? resolveSettings(
        props.workspace,
        settings,
        props.selection?.agentId ?? agentId,
        props.selection
      )
    : null;
  const context = getContextMeterData(
    transcript.messages,
    options,
    settings?.providers,
    transcript.streamingMessageId
  );
  const ready =
    props.connected && !props.signal.aborted && transcript.caughtUp && !error && settings !== null;
  const policyBlockReason =
    settings && options ? getPolicyBlockReason(settings, options.model) : null;
  const canAct = ready && !policyBlockReason;
  const latestSettings = useRef({ options, policyBlockReason });
  useEffect(() => {
    latestSettings.current = { options, policyBlockReason };
  }, [options, policyBlockReason]);
  const running = ready && transcript.streaming;
  const expanded = inputFocused || draft.length > 0 || running || showSettings !== null;

  const lastMessage = transcript.messages.at(-1);
  // Only the active stream or the latest persisted partial can still need input.
  // Historical unanswered tools may have been abandoned by a later user turn.
  const answerMessage = running
    ? transcript.messages.find((message) => message.id === transcript.streamingMessageId)
    : lastMessage?.role === "assistant" && lastMessage.metadata?.partial
      ? lastMessage
      : undefined;
  const canResume =
    canAct && !running && resumeMessageId === lastMessage?.id && lastMessage?.metadata?.partial;

  async function send() {
    if (!canAct || !options?.model || !draft.trim() || pending.current || running) return;
    pending.current = true;
    setBusy(true);
    setActionError(null);
    const message = draft;
    const signal = controller.current.signal;
    try {
      const result = await props.client.workspace.sendMessage(
        {
          workspaceId: props.workspace.id,
          message,
          options,
        },
        { signal }
      );
      if (signal.aborted) return;
      if (!result.success)
        throw new Error(
          typeof result.error === "string" ? result.error : JSON.stringify(result.error)
        );
      setDraft((current) => (current === message ? "" : current));
      setInputHeight(44);
      list.current?.scrollToEnd({ animated: true });
    } catch (cause) {
      if (!signal.aborted)
        setActionError(
          `${cause instanceof Error ? cause.message : "Message could not be sent."} If the connection was lost, reload history before retrying to avoid sending twice.`
        );
    } finally {
      if (controller.current.signal === signal) {
        pending.current = false;
        if (!signal.aborted) setBusy(false);
      }
    }
  }

  async function interrupt() {
    if (!ready || pending.current) return;
    pending.current = true;
    setBusy(true);
    setActionError(null);
    const signal = controller.current.signal;
    try {
      const result = await props.client.workspace.interruptStream(
        { workspaceId: props.workspace.id },
        { signal }
      );
      if (!result.success) throw new Error(result.error);
    } catch (cause) {
      if (!signal.aborted)
        setActionError(cause instanceof Error ? cause.message : "Could not interrupt the agent.");
    } finally {
      if (controller.current.signal === signal) {
        pending.current = false;
        if (!signal.aborted) setBusy(false);
      }
    }
  }

  async function resumeAnsweredQuestion(messageId: string, signal: AbortSignal) {
    const current = latestTranscript.current;
    const latest = current.messages.at(-1);
    if (
      signal.aborted ||
      current.streaming ||
      latest?.id !== messageId ||
      !latest.metadata?.partial
    )
      return;
    const { options, policyBlockReason } = latestSettings.current;
    // The answer is already durable and its form may disappear on tool-call-end.
    // Keep resume failures outside that form, and retry only resume, never the answer.
    setResumeMessageId(messageId);
    // Settings or policy can change while the answer is saved. Preserve recovery
    // while unavailable, but never resume with stale options or a prohibited route.
    if (!options?.model || policyBlockReason) return;
    try {
      const result = await props.client.workspace.resumeStream(
        { workspaceId: props.workspace.id, options },
        { signal }
      );
      if (signal.aborted) return;
      if (!result.success)
        throw new Error(
          typeof result.error === "string" ? result.error : JSON.stringify(result.error)
        );
      if (result.data.started) setResumeMessageId(null);
      else setActionError("Answers saved. The agent is busy; try resuming again.");
    } catch (cause) {
      if (!signal.aborted)
        setActionError(
          `Answers saved, but the agent could not resume: ${cause instanceof Error ? cause.message : "Unknown error"}`
        );
    }
  }

  async function retryResume() {
    if (!canResume || !resumeMessageId || pending.current) return;
    pending.current = true;
    setBusy(true);
    setActionError(null);
    const signal = controller.current.signal;
    try {
      await resumeAnsweredQuestion(resumeMessageId, signal);
    } finally {
      if (controller.current.signal === signal) {
        pending.current = false;
        if (!signal.aborted) setBusy(false);
      }
    }
  }

  async function answer(toolCallId: string, answers: Record<string, string>) {
    if (!ready) throw new Error("Reconnect before answering.");
    if (policyBlockReason) throw new Error(policyBlockReason);
    if (pending.current) throw new Error("Another action is in progress.");
    if (
      !answerMessage ||
      resumeMessageId === answerMessage.id ||
      !answerMessage.parts.some(
        (part) =>
          part.type === "dynamic-tool" &&
          part.toolName === "ask_user_question" &&
          part.toolCallId === toolCallId &&
          part.state === "input-available"
      )
    )
      throw new Error("This question is no longer pending.");
    if (!running && !options?.model) throw new Error("Choose a model before resuming.");
    pending.current = true;
    setBusy(true);
    setActionError(null);
    const signal = controller.current.signal;
    try {
      const result = await props.client.workspace.answerAskUserQuestion(
        { workspaceId: props.workspace.id, toolCallId, answers },
        { signal }
      );
      if (signal.aborted)
        throw new Error("Connection changed. Reload history before answering again.");
      if (!result.success) throw new Error(result.error);
      if (!running) await resumeAnsweredQuestion(answerMessage.id, signal);
    } finally {
      if (controller.current.signal === signal) {
        pending.current = false;
        if (!signal.aborted) setBusy(false);
      }
    }
  }

  return (
    <KeyboardAvoidingView
      style={layout.fill}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <View style={styles.header}>
        <View style={styles.headerActions}>
          <IconButton
            label="Back to workspaces"
            icon={ChevronLeft}
            color={colors.text}
            onPress={props.onBack}
          />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text accessibilityRole="header" style={styles.title} numberOfLines={1}>
            {props.workspace.title ?? props.workspace.name}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {props.workspace.kind === "scratch" ? "Scratch chat" : props.workspace.projectName} ·{" "}
            {props.serverLabel}
          </Text>
        </View>
        <View style={styles.headerActions}>
          <IconButton
            label="View changes"
            icon={GitCompareArrows}
            onPress={props.onChanges}
            disabled={props.workspace.kind === "scratch"}
          />
          <IconButton label="Connection settings" icon={Settings} onPress={props.onSettings} />
        </View>
      </View>
      <FlatList
        ref={list}
        data={transcript.messages}
        keyExtractor={(message) => message.id}
        contentContainerStyle={styles.messages}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListHeaderComponent={
          transcript.hasOlderHistory ? (
            <View style={{ gap: 12 }}>
              {historyError && <Notice>{historyError}</Notice>}
              <Button
                busy={loadingOlder}
                disabled={!ready}
                onPress={() => {
                  setAtBottom(false);
                  return loadOlder();
                }}
              >
                Load older messages
              </Button>
            </View>
          ) : null
        }
        onScroll={(event) => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          setAtBottom(contentSize.height - layoutMeasurement.height - contentOffset.y < 80);
        }}
        scrollEventThrottle={100}
        onContentSizeChange={() => {
          if (atBottom) list.current?.scrollToEnd({ animated: false });
        }}
        renderItem={({ item }) => (
          <Message
            message={item}
            streaming={transcript.streamingMessageId === item.id && running}
            canAnswer={
              canAct && !busy && answerMessage?.id === item.id && resumeMessageId !== item.id
            }
            onAnswer={answer}
          />
        )}
        ListEmptyComponent={
          !ready && !error ? (
            <Loading label="Syncing conversation…" />
          ) : error ? null : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>What’s on your mind?</Text>
              <Text style={[layout.muted, { textAlign: "center" }]}>
                Ask a question, plan a change, or let an agent take it from here.
              </Text>
            </View>
          )
        }
        ListFooterComponent={
          <View style={{ gap: 12 }}>
            {error && <Notice onRetry={props.onReconnect}>{error}</Notice>}
            {transcript.error && <Notice>{transcript.error}</Notice>}
            {canResume && (
              <Button busy={busy} onPress={retryResume}>
                Resume agent
              </Button>
            )}
            {running && (
              <Text style={[layout.muted, { color: colors.accent }]}>Agent is working…</Text>
            )}
          </View>
        }
      />
      {!atBottom && (
        <View style={[styles.latest, { bottom: composerHeight + 12 }]}>
          <IconButton
            icon={ArrowDown}
            label="Jump to latest message"
            onPress={() => list.current?.scrollToEnd({ animated: true })}
          />
        </View>
      )}
      <View
        style={styles.composerWrap}
        onLayout={(event) => setComposerHeight(event.nativeEvent.layout.height)}
      >
        {policyBlockReason && (
          <Notice onRetry={!settings?.policy ? props.onReconnect : undefined}>
            {policyBlockReason}
          </Notice>
        )}
        {actionError && (
          <Notice
            onRetry={() => {
              setActionError(null);
              return props.onReconnect();
            }}
          >
            {actionError}
          </Notice>
        )}
        {/* Keep the input bottommost. Pointer presses retain browser focus until click opens the picker, avoiding blur-driven movement. */}
        <View style={styles.composerToolbar}>
          <View style={styles.pickers}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Choose mode"
              accessibilityState={{ disabled: !settings || !options }}
              disabled={!settings || !options}
              onPointerDown={Platform.OS === "web" ? (event) => event.preventDefault() : undefined}
              onPress={() => setShowSettings("agent")}
              style={({ pressed }) => [
                styles.modelButton,
                { maxWidth: "45%" },
                pressed && { opacity: 0.6 },
              ]}
            >
              {options?.agentId === "plan" ? (
                <ClipboardList size={15} color={colors.plan} />
              ) : (
                <View style={styles.modeDot} />
              )}
              <Text numberOfLines={1} style={styles.modelLabel}>
                {settings?.agents.find((agent) => agent.id === options?.agentId)?.name ?? "Mode"}
              </Text>
              <ChevronDown size={12} color={colors.muted} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Choose model"
              accessibilityState={{ disabled: !settings || !options }}
              disabled={!settings || !options}
              onPointerDown={Platform.OS === "web" ? (event) => event.preventDefault() : undefined}
              onPress={() => setShowSettings("model")}
              style={({ pressed }) => [styles.modelButton, pressed && { opacity: 0.6 }]}
            >
              <Text numberOfLines={1} style={styles.modelLabel}>
                {options?.model ? modelName(options.model) : "Model"}
              </Text>
              {options && (
                <Text style={styles.effortLabel}>
                  {(options.thinkingLevel ?? THINKING_LEVEL_OFF).toUpperCase()}
                </Text>
              )}
              <ChevronDown size={12} color={colors.muted} />
            </Pressable>
          </View>
          <ContextUsage data={context} />
        </View>
        <View
          style={[
            styles.composer,
            expanded && styles.expandedComposer,
            inputFocused && styles.focusedComposer,
          ]}
        >
          <TextInput
            accessibilityLabel="Message"
            placeholder={
              !ready ? "Reconnecting…" : running ? "Write your next message…" : "Message Xum…"
            }
            placeholderTextColor={colors.muted}
            value={draft}
            onChangeText={setDraft}
            multiline
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            editable={!busy}
            onContentSizeChange={
              Platform.OS === "web"
                ? undefined
                : (event) =>
                    setInputHeight(
                      Math.max(44, Math.min(132, event.nativeEvent.contentSize.height))
                    )
            }
            style={[
              styles.input,
              expanded && styles.expandedInput,
              Platform.OS === "web"
                ? webInputSizing
                : { height: expanded ? Math.max(72, inputHeight) : 44 },
            ]}
            selectionColor={colors.accent}
          />
          <View
            style={[
              styles.send,
              (canAct || running) &&
                (running || Boolean(draft.trim())) && {
                  backgroundColor: options?.agentId === "plan" ? colors.plan : colors.accent,
                },
            ]}
          >
            <IconButton
              label={running ? "Interrupt agent" : "Send message"}
              icon={running ? Square : ArrowUp}
              color={
                (canAct || running) && (running || Boolean(draft.trim()))
                  ? colors.bright
                  : colors.muted
              }
              disabled={
                !ready || busy || (!running && (!canAct || !draft.trim() || !options?.model))
              }
              onPress={running ? interrupt : send}
            />
          </View>
        </View>
      </View>
      {showSettings && settings && options && (
        <ModelSettings
          initialPage={showSettings}
          value={options}
          data={settings}
          workspace={props.workspace}
          onClose={() => setShowSettings(null)}
          onChange={props.onSelectionChange}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  header: {
    minHeight: 72,
    paddingHorizontal: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  headerActions: { flexDirection: "row", borderRadius: radii.pill, backgroundColor: colors.panel },
  title: { ...typography.header, color: colors.bright },
  subtitle: { ...typography.footnote, color: colors.muted, marginTop: 2 },
  messages: {
    paddingHorizontal: spacing.xl,
    paddingTop: 20,
    paddingBottom: spacing.xl,
    width: "100%",
    maxWidth: 760,
    alignSelf: "center",
    flexGrow: 1,
  },
  empty: {
    flex: 1,
    paddingVertical: 48,
    paddingHorizontal: spacing.xl,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  emptyTitle: {
    fontFamily,
    color: colors.bright,
    fontSize: 22,
    fontWeight: "600",
    letterSpacing: -0.4,
  },
  composerWrap: {
    paddingHorizontal: spacing.md,
    paddingTop: 8,
    paddingBottom: 8,
    width: "100%",
    maxWidth: 760,
    alignSelf: "center",
    gap: 4,
    backgroundColor: colors.background,
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    borderRadius: radii.pill,
    padding: 6,
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  expandedComposer: { borderRadius: radii.sheet },
  focusedComposer: { borderColor: colors.selection },
  expandedInput: { minHeight: 72 },
  input: {
    flex: 1,
    fontFamily,
    minWidth: 0,
    color: colors.bright,
    fontSize: 16,
    lineHeight: 23,
    minHeight: 44,
    maxHeight: 132,
    textAlignVertical: "top",
    paddingVertical: 10,
    paddingHorizontal: 10,
  },
  composerToolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    gap: 8,
  },
  pickers: { flex: 1, minWidth: 0, flexDirection: "row", gap: 6, alignItems: "center" },
  modelButton: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
    paddingHorizontal: 10,
    backgroundColor: colors.panel,
    borderRadius: radii.pill,
  },
  effortLabel: {
    fontFamily,
    color: colors.muted,
    fontSize: 10,
    fontWeight: "600",
    flexShrink: 0,
    paddingLeft: 6,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.border,
  },
  modeDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent },
  modelLabel: { fontFamily, color: colors.text, fontSize: 13, fontWeight: "500", flexShrink: 1 },
  send: { borderRadius: 22, overflow: "hidden", backgroundColor: colors.elevated },
  latest: {
    position: "absolute",
    right: 20,
    backgroundColor: colors.elevated,
    borderRadius: radii.sheet,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
});
