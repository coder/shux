import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { CheckCircle2, FileCode, RefreshCw } from "lucide-react-native";
import type { MobileClient } from "../api";
import type { ProjectGitDiffResult } from "../../../../src/common/orpc/schemas/api";
import { Header, IconButton, Loading, Notice } from "../components/Controls";
import { colors, layout, mono, radii, spacing, typography } from "../theme";
import { linkedAbortController } from "../useConnection";

export function ChangesScreen(props: {
  client: MobileClient;
  workspaceId: string;
  signal: AbortSignal;
  onReconnect: () => Promise<void>;
  onBack: () => void;
}) {
  const [projects, setProjects] = useState<ProjectGitDiffResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  function retry() {
    setGeneration((value) => value + 1);
  }
  useEffect(() => {
    const controller = linkedAbortController(props.signal);
    setProjects(null);
    setError(null);
    if (controller.signal.aborted) {
      setError("Reconnect to load changes.");
      return;
    }
    props.client.workspace
      .getProjectDiffs({ workspaceId: props.workspaceId }, { signal: controller.signal })
      .then((results) => {
        if (!controller.signal.aborted) setProjects(results);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Could not load changes.");
      });
    return () => controller.abort();
  }, [props.client, props.workspaceId, props.signal, generation]);
  const clean =
    projects != null &&
    projects.length > 0 &&
    projects.every(
      (project) => project.success && !project.data.truncated && project.data.diff === ""
    );
  return (
    <View style={layout.fill}>
      <Header
        title="Changes"
        subtitle="Working tree"
        onBack={props.onBack}
        trailing={<IconButton label="Refresh changes" icon={RefreshCw} onPress={retry} />}
      />
      <ScrollView contentContainerStyle={styles.content}>
        {error && <Notice onRetry={props.onReconnect}>{error}</Notice>}
        {projects === null && !error && <Loading label="Reading changes…" />}
        {projects?.length === 0 && (
          <Text style={layout.muted}>This workspace has no Git repositories.</Text>
        )}
        {clean && (
          <View style={styles.empty}>
            <CheckCircle2 size={32} color={colors.success} />
            <Text style={layout.title}>No uncommitted changes</Text>
            <Text style={[layout.muted, { textAlign: "center" }]}>
              Tracked files match the latest commit.
            </Text>
          </View>
        )}
        {projects?.map((project) => (
          <View key={project.projectPath} style={{ gap: 12 }}>
            <Text style={[typography.header, { color: colors.text }]}>{project.projectName}</Text>
            {project.success ? (
              <ProjectDiff data={project.data} />
            ) : (
              <Notice>{project.error}</Notice>
            )}
          </View>
        ))}
        {projects !== null && (
          <Text style={styles.footnote}>
            Staged and unstaged tracked files, compared with HEAD. Untracked files and committed
            changes aren’t shown.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

function ProjectDiff(props: { data: Extract<ProjectGitDiffResult, { success: true }>["data"] }) {
  const files = props.data.diff.split(/(?=^diff --git )/m).filter(Boolean);
  return (
    <View style={{ gap: 12 }}>
      {props.data.truncated ? (
        <Notice>
          The server truncated this repository's diff. Review the full changes on desktop.
        </Notice>
      ) : (
        props.data.note && <Notice>{props.data.note}</Notice>
      )}
      {!props.data.truncated && props.data.diff === "" && (
        <Text style={layout.muted}>No tracked changes in this repository.</Text>
      )}
      {files.length > 0 && (
        <Text style={layout.muted}>
          {files.length} changed {files.length === 1 ? "file" : "files"}
        </Text>
      )}
      {files.map((file, index) => {
        const lines = file.trimEnd().split("\n");
        const newPath = lines.find((line) => line.startsWith("+++ "))?.slice(4);
        // Deletions have no new-side path; retain the old filename before hiding diff headers.
        const filename =
          (newPath === "/dev/null"
            ? lines
                .find((line) => line.startsWith("--- "))
                ?.slice(4)
                .replace(/^a\//, "")
            : newPath?.replace(/^b\//, "")) ?? lines[0].replace(/^diff --git /, "");
        const content = lines.filter((line) => !/^(diff --git |index |--- |\+\+\+ )/.test(line));
        const additions = content.filter((line) => line.startsWith("+")).length;
        const deletions = content.filter((line) => line.startsWith("-")).length;
        return (
          <View key={index} style={styles.file}>
            <View style={styles.fileHeader}>
              <FileCode size={17} color={colors.muted} />
              <Text numberOfLines={1} ellipsizeMode="middle" style={styles.filename}>
                {filename}
              </Text>
              <Text style={[styles.count, { color: colors.success }]}>+{additions}</Text>
              <Text style={[styles.count, { color: colors.danger }]}>−{deletions}</Text>
            </View>
            <ScrollView horizontal contentContainerStyle={{ padding: 14 }}>
              <View>
                {content.map((line, lineIndex) => (
                  <Text
                    selectable
                    key={lineIndex}
                    style={[
                      styles.code,
                      {
                        color: line.startsWith("+")
                          ? colors.success
                          : line.startsWith("-")
                            ? colors.danger
                            : line.startsWith("@@")
                              ? colors.plan
                              : colors.text,
                      },
                    ]}
                  >
                    {line || " "}
                  </Text>
                ))}
              </View>
            </ScrollView>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing.xl,
    gap: 16,
    width: "100%",
    maxWidth: 900,
    alignSelf: "center",
    flexGrow: 1,
  },
  empty: { alignItems: "center", justifyContent: "center", gap: 12, paddingVertical: 56 },
  file: {
    borderRadius: radii.card,
    overflow: "hidden",
    backgroundColor: colors.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  fileHeader: {
    minHeight: 52,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  filename: { flex: 1, minWidth: 0, color: colors.bright, fontSize: 15, fontWeight: "500" },
  count: { fontSize: 12, fontVariant: ["tabular-nums"] },
  code: { fontFamily: mono, fontSize: 13, lineHeight: 21 },
  footnote: { ...typography.footnote, color: colors.muted },
});
