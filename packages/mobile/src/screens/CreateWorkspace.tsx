import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { TextInput } from "react-native";
import { Check, ChevronDown, Folder, MessageSquare } from "lucide-react-native";
import type { MobileClient } from "../api";
import type { Projects } from "../useProjects";
import type { FrontendWorkspaceMetadata } from "../../../../src/common/types/workspace";
import { Button, Field, Loading, Notice, Sheet } from "../components/Controls";
import { colors, layout, radii, spacing, typography } from "../theme";
import { linkedAbortController } from "../useConnection";

export function CreateWorkspace(props: {
  client: MobileClient;
  signal: AbortSignal;
  connected: boolean;
  onReconnect: () => Promise<void>;
  projects: Projects;
  onCreated: (workspace: FrontendWorkspaceMetadata) => void;
  onClose: () => void;
}) {
  const [project, setProject] = useState<string | null>(null);
  const [choosingProject, setChoosingProject] = useState(false);
  const [title, setTitle] = useState("");
  const [branch, setBranch] = useState("");
  const [trunk, setTrunk] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const controller = useRef(new AbortController());
  const branchInput = useRef<TextInput>(null);
  const trunkInput = useRef<TextInput>(null);

  useEffect(() => {
    const abort = linkedAbortController(props.signal);
    controller.current = abort;
    pending.current = false;
    setBusy(false);
    if (abort.signal.aborted || !project) {
      setLoading(false);
      return () => abort.abort();
    }
    setLoading(true);
    props.client.projects
      .listBranches({ projectPath: project }, { signal: abort.signal })
      .then((result) => {
        if (abort.signal.aborted) return;
        setBranches(result.branches);
        setTrunk(result.recommendedTrunk ?? "");
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Could not load branches.");
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [props.client, project, props.signal]);

  function selectProject(path: string | null) {
    if (pending.current) return;
    setProject(path);
    setChoosingProject(false);
    setBranch("");
    setTrunk("");
    setBranches([]);
    setError(null);
  }

  const selectedProject = props.projects.find(([path]) => path === project);
  // Catalog refreshes must block a removed selection without discarding its drafts.
  const projectUnavailable = project !== null && !selectedProject;

  async function create() {
    if (
      pending.current ||
      !props.connected ||
      props.signal.aborted ||
      projectUnavailable ||
      loading ||
      (project && !trunk.trim())
    )
      return;
    pending.current = true;
    setBusy(true);
    setError(null);
    const signal = controller.current.signal;
    try {
      // Omitting runtimeConfig selects the server-owned worktree directory.
      const result = project
        ? await props.client.workspace.create(
            {
              projectPath: project,
              branchName: branch.trim() || undefined,
              trunkBranch: trunk.trim(),
              title: title.trim() || undefined,
            },
            { signal }
          )
        : await props.client.workspace.createScratch(
            { title: title.trim() || undefined },
            { signal }
          );
      if (signal.aborted) return;
      if (!result.success) throw new Error(result.error);
      props.onCreated(result.metadata);
    } catch (cause) {
      if (!signal.aborted)
        setError(
          `${cause instanceof Error ? cause.message : "Could not create workspace."} If the connection dropped, refresh the workspace list before trying again.`
        );
    } finally {
      if (controller.current.signal === signal) {
        pending.current = false;
        if (!signal.aborted) setBusy(false);
      }
    }
  }

  const projectName =
    selectedProject?.[1].displayName ??
    project?.split(/[\\/]/).filter(Boolean).at(-1) ??
    "Scratch chat";
  return (
    <Sheet
      title="New workspace"
      onClose={() => {
        if (!pending.current) props.onClose();
      }}
      dismissDisabled={busy}
      footer={
        <>
          <Button
            busy={busy}
            disabled={
              !props.connected ||
              props.signal.aborted ||
              projectUnavailable ||
              loading ||
              (project !== null && !trunk.trim())
            }
            onPress={create}
          >
            {project ? "Create worktree" : "Create scratch chat"}
          </Button>
          {busy && (
            <Text style={styles.footnote}>Creating on your server. Keep this sheet open.</Text>
          )}
        </>
      }
    >
      <View style={{ gap: spacing.sm }}>
        <Text style={layout.label}>Project</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Choose project"
          accessibilityState={{ expanded: choosingProject, disabled: busy }}
          disabled={busy}
          onPress={() => setChoosingProject(!choosingProject)}
          style={[styles.row, layout.group]}
        >
          {project ? (
            <Folder size={20} color={colors.accent} />
          ) : (
            <MessageSquare size={20} color={colors.accent} />
          )}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={layout.text}>
              {projectName}
            </Text>
            <Text style={styles.footnote}>
              {project ? "Isolated Git worktree" : "Conversation without a project"}
            </Text>
          </View>
          <ChevronDown size={18} color={colors.muted} />
        </Pressable>
        {choosingProject && (
          <View style={layout.group}>
            <ProjectRow
              name="Scratch chat"
              selected={project === null}
              disabled={busy}
              onPress={() => selectProject(null)}
            />
            {props.projects.map(([path, config]) => (
              <ProjectRow
                key={path}
                name={config.displayName ?? path.split(/[\\/]/).filter(Boolean).at(-1) ?? path}
                selected={project === path}
                disabled={busy}
                onPress={() => selectProject(path)}
              />
            ))}
            {props.projects.length === 0 && (
              <Text style={[styles.footnote, { padding: spacing.lg }]}>
                Add a project from Xum desktop to create worktrees.
              </Text>
            )}
          </View>
        )}
      </View>
      {projectUnavailable && (
        <Notice severity="warning">
          The selected project is no longer available. Choose another project to continue.
        </Notice>
      )}
      <View style={[layout.group, styles.form]}>
        <Field
          label="Title (optional)"
          value={title}
          onChangeText={setTitle}
          placeholder="What are you working on?"
          editable={!busy}
          autoCapitalize="sentences"
          returnKeyType={project ? "next" : "done"}
          onSubmitEditing={project ? () => branchInput.current?.focus() : create}
        />
        {project && (
          <>
            <View style={layout.divider} />
            <Field
              ref={branchInput}
              label="Branch name (optional)"
              value={branch}
              onChangeText={setBranch}
              placeholder="Generated by the server"
              editable={!busy}
              returnKeyType="next"
              onSubmitEditing={() => trunkInput.current?.focus()}
            />
            <Field
              ref={trunkInput}
              label="Base branch"
              value={trunk}
              onChangeText={setTrunk}
              placeholder="Select or enter a branch"
              editable={!busy && !loading}
              returnKeyType="done"
              onSubmitEditing={create}
            />
            {branches.length > 0 && (
              <View style={styles.branches}>
                {branches.slice(0, 6).map((name) => (
                  <Pressable
                    key={name}
                    accessibilityRole="button"
                    accessibilityState={{ selected: trunk === name }}
                    disabled={busy}
                    onPress={() => setTrunk(name)}
                    style={[styles.branch, trunk === name && styles.selectedBranch]}
                  >
                    <Text
                      numberOfLines={1}
                      style={[
                        typography.footnote,
                        { color: trunk === name ? colors.accent : colors.muted },
                      ]}
                    >
                      {name}
                    </Text>
                    {trunk === name && <Check size={14} color={colors.accent} />}
                  </Pressable>
                ))}
              </View>
            )}
          </>
        )}
      </View>
      {loading && <Loading label="Loading base branches…" />}
      {error && <Notice onRetry={props.onReconnect}>{error}</Notice>}
      <Text style={styles.footnote}>
        {project
          ? "Changes stay in a separate worktree on your server. Your project’s existing files are not modified."
          : "Start a conversation now. Scratch chats run on your server without a project checkout."}
      </Text>
    </Sheet>
  );
}

function ProjectRow(props: {
  name: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[
        styles.row,
        { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
      ]}
    >
      <Text numberOfLines={1} style={[layout.text, { flex: 1 }]}>
        {props.name}
      </Text>
      {props.selected && <Check size={20} color={colors.accent} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
  },
  form: { padding: spacing.lg, gap: spacing.xl },
  footnote: { ...typography.footnote, color: colors.muted },
  branches: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  branch: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    maxWidth: "100%",
    paddingHorizontal: spacing.md,
    borderRadius: radii.control,
    backgroundColor: colors.elevated,
  },
  selectedBranch: { backgroundColor: colors.accentSurface },
});
