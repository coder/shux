// Tool semantics are shared by the desktop and native icon registries, without
// importing either renderer's React or SVG implementation.
export const TOOL_ICON_NAMES = {
  bash: "Wrench",
  bash_output: "Wrench",
  bash_background_terminate: "Square",
  bash_background_list: "List",
  workflow_run: "Sparkles",
  workflow_resume: "RotateCcw",
  agent_report: "FileText",
  agent_skill_read: "GraduationCap",
  agent_skill_read_file: "GraduationCap",
  // LayoutGrid (a 2×2 catalog of tiles) reads as "the index of skills you can pick
  // from" — distinct from the GraduationCap used when reading a single skill.
  agent_skill_list: "LayoutGrid",
  advisor: "Lightbulb",
  ask_user_question: "MessageCircleQuestion",
  file_read: "BookOpen",
  session_history: "History",
  memory: "Brain",
  intuition: "BrainCircuit",
  attach_file: "Paperclip",
  desktop_screenshot: "Monitor",
  desktop_move_mouse: "Move",
  desktop_click: "MousePointerClick",
  desktop_double_click: "MousePointerClick",
  desktop_drag: "Hand",
  desktop_scroll: "ArrowDownUp",
  desktop_type: "Keyboard",
  desktop_key_press: "Keyboard",
  file_edit_insert: "Pencil",
  file_edit_replace_string: "Pencil",
  file_edit_replace_lines: "Pencil",
  todo_write: "List",
  web_fetch: "Globe",
  web_search: "Globe",
  "server:GOOGLE_SEARCH_WEB": "Globe",
  notify: "Bell",
  tool_catalog_search: "Search",
  tool_search: "Search",
  review_pane_update: "Sparkles",
  review_pane_get: "ScanEye",
  analytics_query: "Database",
  task_retitle: "Pencil",
  task_stop: "Square",
  task_remove: "Trash2",
  task_send_message: "MessageSquareMore",
  task_apply_git_patch: "GitCommit",
  // Layers (stacked planes) reads as "manage the stack of child workspaces" — matches the
  // WorkspaceLifecycleToolCall card's glyph.
  task_workspace_lifecycle: "Layers",
  set_goal: "Target",
  get_goal: "Target",
  complete_goal: "CircleCheck",
  // Activity (ECG line) rather than HeartPulse: it matches the scanning pulse-trace
  // motif inside the HeartbeatToolCall card. The config menu uses HeartPulse.
  heartbeat: "Activity",
  // Sparkles matches the icon the Timeline tab feed renders on agent.event rows, which is
  // exactly where a timeline_event call lands.
  timeline_event: "Sparkles",
} as const;

export type ToolIconName = (typeof TOOL_ICON_NAMES)[keyof typeof TOOL_ICON_NAMES];

export function getToolIconName(toolName: string): ToolIconName {
  // Persisted names such as "constructor" must not resolve to inherited Object members.
  return Object.hasOwn(TOOL_ICON_NAMES, toolName)
    ? TOOL_ICON_NAMES[toolName as keyof typeof TOOL_ICON_NAMES]
    : "Sparkles";
}
