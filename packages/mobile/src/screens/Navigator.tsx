import { useState } from "react";
import {
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  MessageSquare,
  Plus,
  Search,
  Settings,
  SquarePen,
  X,
} from "lucide-react-native";
import type { FrontendWorkspaceMetadata } from "../../../../src/common/types/workspace";
import type { Projects } from "../useProjects";
import { excludeSubAgentRows } from "../../../../src/browser/utils/ui/workspaceFiltering";
import { Button, IconButton, Loading, Notice } from "../components/Controls";
import { KeyboardAvoidingView } from "../components/Keyboard";
import {
  colors,
  fontFamily,
  layout,
  radii,
  spacing,
  typography,
  WIDE_LAYOUT_MIN_WIDTH,
} from "../theme";

export function Navigator(props: {
  projects: Projects;
  workspaces: FrontendWorkspaceMetadata[];
  selectedId?: string;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onSelect: (workspace: FrontendWorkspaceMetadata) => void;
  onCreate: () => void;
  onSettings: () => void;
  compact?: boolean;
}) {
  const { width } = useWindowDimensions();
  const bottomDock = !props.compact && width < WIDE_LAYOUT_MIN_WIDTH;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const groups = new Map<string, { name: string; workspaces: FrontendWorkspaceMetadata[] }>();
  for (const [path, config] of props.projects)
    groups.set(path, {
      name: config.displayName ?? path.split(/[\\/]/).filter(Boolean).at(-1) ?? path,
      workspaces: [],
    });
  // Match desktop's root list before searching/counting; keep orphaned agents accessible.
  for (const workspace of excludeSubAgentRows(props.workspaces)) {
    const key = workspace.kind === "scratch" ? "scratch" : workspace.projectPath;
    const group = groups.get(key) ?? {
      name: workspace.kind === "scratch" ? "Scratch chats" : workspace.projectName,
      workspaces: [],
    };
    if (
      `${workspace.title ?? ""} ${workspace.name} ${group.name}`
        .toLowerCase()
        .includes(query.trim().toLowerCase())
    )
      group.workspaces.push(workspace);
    groups.set(key, group);
  }
  const visibleGroups = [...groups].filter(
    ([, group]) => !query.trim() || group.workspaces.length > 0
  );
  return (
    <KeyboardAvoidingView
      style={[layout.fill, props.compact && styles.sidebar]}
      enabled={bottomDock}
      behavior={bottomDock ? (Platform.OS === "ios" ? "padding" : "height") : undefined}
    >
      <View style={styles.toolbar}>
        <Text accessibilityRole="header" style={styles.title}>
          {props.compact ? "Xum" : "Workspaces"}
        </Text>
        <View style={layout.row}>
          <IconButton label="Settings" icon={Settings} onPress={props.onSettings} />
          {!bottomDock && (
            <IconButton
              label="New workspace"
              icon={Plus}
              color={colors.accent}
              onPress={props.onCreate}
            />
          )}
        </View>
      </View>
      {/* Keep one search input mounted across breakpoints; on phones it belongs in thumb reach. */}
      <View style={[styles.browser, bottomDock && styles.phoneBrowser]}>
        <View style={styles.searchDock}>
          <View style={styles.search}>
            <Search size={18} color={colors.muted} />
            <TextInput
              accessibilityLabel="Search workspaces"
              placeholder="Search workspaces"
              placeholderTextColor={colors.muted}
              value={query}
              onChangeText={setQuery}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
              style={styles.searchInput}
            />
            {query.length > 0 && (
              <IconButton label="Clear search" icon={X} onPress={() => setQuery("")} />
            )}
          </View>
          {bottomDock && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="New workspace"
              onPress={props.onCreate}
              style={({ pressed }) => [styles.createButton, pressed && { opacity: 0.7 }]}
            >
              <SquarePen size={20} color={colors.background} />
              <Text style={styles.createLabel}>New</Text>
            </Pressable>
          )}
        </View>
        <ScrollView
          testID="workspace-list"
          style={styles.workspaceList}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={props.loading && props.workspaces.length > 0}
              onRefresh={props.onRetry}
              tintColor={colors.accent}
            />
          }
        >
          {props.error && <Notice onRetry={props.onRetry}>{props.error}</Notice>}
          {props.loading && props.workspaces.length === 0 && (
            <Loading label="Loading workspaces…" />
          )}
          {!props.loading && props.workspaces.length === 0 && !props.error && (
            <View style={styles.empty}>
              <MessageSquare size={28} color={colors.accent} />
              <Text style={layout.title}>Start a conversation</Text>
              <Text style={[layout.muted, { textAlign: "center" }]}>
                Create a workspace in a project, or a scratch chat for a quick question.
              </Text>
              <Button onPress={props.onCreate}>New workspace</Button>
            </View>
          )}
          {query.trim() && visibleGroups.length === 0 ? (
            <View style={styles.empty}>
              <Text style={layout.title}>No matching workspaces</Text>
              <Text style={layout.muted}>Try a project name, branch, or conversation title.</Text>
            </View>
          ) : null}
          {visibleGroups.map(([key, group]) => (
            <View key={key} style={{ gap: 8 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${group.name}, ${group.workspaces.length} workspaces`}
                accessibilityState={{ expanded: Boolean(query.trim()) || !collapsed.has(key) }}
                onPress={() =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
                style={styles.groupHeader}
              >
                {key === "scratch" ? (
                  <MessageSquare size={15} color={colors.muted} />
                ) : (
                  <Folder size={15} color={colors.muted} />
                )}
                <Text numberOfLines={1} style={[styles.sectionTitle, { flex: 1 }]}>
                  {group.name}
                </Text>
                <Text style={layout.muted}>{group.workspaces.length}</Text>
                {collapsed.has(key) && !query.trim() ? (
                  <ChevronRight size={15} color={colors.muted} />
                ) : (
                  <ChevronDown size={15} color={colors.muted} />
                )}
              </Pressable>
              {(!collapsed.has(key) || Boolean(query.trim())) && (
                <View style={styles.section}>
                  {group.workspaces.length === 0 ? (
                    <Text style={[layout.muted, { padding: 16 }]}>No conversations yet</Text>
                  ) : (
                    group.workspaces
                      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
                      .map((workspace) => (
                        <Pressable
                          key={workspace.id}
                          accessibilityRole="button"
                          accessibilityLabel={workspace.title ?? workspace.name}
                          accessibilityState={{ selected: workspace.id === props.selectedId }}
                          onPress={() => props.onSelect(workspace)}
                          style={({ pressed }) => [
                            styles.workspace,
                            (workspace.id === props.selectedId || pressed) && {
                              backgroundColor: colors.elevated,
                            },
                          ]}
                        >
                          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                            <Text numberOfLines={2} style={styles.workspaceTitle}>
                              {workspace.title ?? workspace.name}
                            </Text>
                            <Text numberOfLines={1} style={[layout.muted, typography.footnote]}>
                              {workspace.kind === "scratch" ? "Scratch chat" : workspace.name}
                            </Text>
                          </View>
                        </Pressable>
                      ))
                  )}
                </View>
              )}
            </View>
          ))}
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  sidebar: { backgroundColor: colors.background },
  browser: { flex: 1, minHeight: 0 },
  phoneBrowser: { flexDirection: "column-reverse" },
  workspaceList: { flex: 1 },
  searchDock: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    width: "100%",
    maxWidth: 760,
    alignSelf: "center",
  },
  createButton: {
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  createLabel: { ...typography.body, color: colors.background, fontWeight: "600" },
  toolbar: {
    minHeight: 60,
    paddingHorizontal: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: 8,
    paddingBottom: 32,
    gap: 16,
    maxWidth: 760,
    width: "100%",
    alignSelf: "center",
  },
  title: { ...typography.header, color: colors.bright, fontSize: 20, letterSpacing: -0.4 },
  search: {
    flex: 1,
    minWidth: 0,
    backgroundColor: colors.panel,
    borderRadius: radii.pill,
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 14,
    paddingRight: 4,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    ...typography.body,
    color: colors.bright,
    paddingVertical: 10,
  },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 4,
  },
  sectionTitle: { ...typography.footnote, color: colors.muted, fontWeight: "500" },
  section: { gap: 2 },
  workspace: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 60,
    borderRadius: radii.control,
  },
  workspaceTitle: {
    fontFamily,
    color: colors.bright,
    fontSize: 16,
    fontWeight: "500",
    lineHeight: 22,
  },
  empty: { paddingVertical: 24, gap: 14, alignItems: "center" },
});
