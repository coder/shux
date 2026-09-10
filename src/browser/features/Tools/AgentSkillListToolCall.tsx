import React from "react";
import { ChevronRight, EyeOff } from "lucide-react";
import { z } from "zod";
import { cn } from "@/common/lib/utils";
import { AgentSkillDescriptorSchema } from "@/common/orpc/schemas";
import type { AgentSkillDescriptor, AgentSkillScope } from "@/common/types/agentSkill";
import type { AgentSkillListToolArgs } from "@/common/types/tools";
import {
  ErrorBox,
  ExpandIcon,
  LoadingDots,
  StatusIndicator,
  ToolContainer,
  ToolDetails,
  ToolHeader,
  ToolIcon,
} from "./Shared/ToolPrimitives";
import {
  getStatusDisplay,
  isToolErrorResult,
  unwrapResult,
  useToolExpansion,
  type ToolStatus,
} from "./Shared/toolUtils";

/**
 * Transcript card for the `agent_skill_list` tool — the call the agent makes to
 * discover which skills it can invoke. Collapsed it reads as a glanceable count
 * ("Listed skills · N skills"); expanded it groups skills by scope (project /
 * global / built-in) and lets you open any row to read the full description and
 * how to invoke it.
 *
 * Binds to the real backend shape (AgentSkillListToolResult): a success carries
 * `skills: AgentSkillDescriptor[]`, a failure carries `error`. The source mockup
 * also sketched a "skills that failed to load" panel, but the tool result never
 * carries load diagnostics — the backend logs and skips invalid skills, and that
 * surface lives in the session-level SkillIndicator — so it is intentionally
 * omitted here rather than wired to data that can never arrive.
 */

// Scope → label + dot/label color. Project and global reuse the Xum mode hues
// (teal / indigo); built-in is neutral. Colors come from globals.css theme tokens
// (`--color-task-mode` etc.) via utilities — never hardcoded — so they track the
// active theme. Record keyed by scope so a new AgentSkillScope is a compile error.
const SCOPE_META: Record<AgentSkillScope, { label: string; dotClass: string; labelClass: string }> =
  {
    project: { label: "Project", dotClass: "bg-task-mode", labelClass: "text-task-mode" },
    global: { label: "Global", dotClass: "bg-ask-mode", labelClass: "text-ask-mode" },
    "built-in": {
      label: "Built-in",
      dotClass: "bg-muted-foreground",
      labelClass: "text-muted-foreground",
    },
  };

// Render order: project first (most local), then global, then shipped built-ins —
// mirrors the backend listing order and the SkillIndicator popover.
const SCOPE_ORDER: AgentSkillScope[] = ["project", "global", "built-in"];

export interface SkillScopeGroup {
  scope: AgentSkillScope;
  label: string;
  dotClass: string;
  labelClass: string;
  skills: AgentSkillDescriptor[];
}

/** Group skills by scope in a stable scope order, dropping empty groups. */
export function groupSkillsByScope(skills: AgentSkillDescriptor[]): SkillScopeGroup[] {
  const byScope = new Map<AgentSkillScope, AgentSkillDescriptor[]>();
  for (const skill of skills) {
    const existing = byScope.get(skill.scope) ?? [];
    existing.push(skill);
    byScope.set(skill.scope, existing);
  }
  return SCOPE_ORDER.filter((scope) => (byScope.get(scope)?.length ?? 0) > 0).map((scope) => ({
    scope,
    ...SCOPE_META[scope],
    skills: byScope.get(scope) ?? [],
  }));
}

// Loosely shaped success container; individual skills are validated per-row below
// so one malformed descriptor can't blank the whole list (self-healing).
const SkillListSuccessSchema = z.object({
  success: z.literal(true),
  skills: z.array(z.unknown()),
});

export type SkillListView =
  | { kind: "skills"; skills: AgentSkillDescriptor[] }
  | { kind: "error"; error: string }
  | { kind: "none" };

/**
 * Normalize a persisted tool result into a render view. Unwraps the SDK JSON
 * container first, then detects both the thrown `{ success: false, error }` shape
 * and the nested `{ error }` shape that code_execution/PTC reconstructs (no
 * `success` flag), then validates the success payload — filtering any malformed
 * skill rows. Returns `none` for pending / unrecognized output so the card
 * degrades gracefully instead of throwing.
 */
export function toSkillListView(result: unknown): SkillListView {
  const unwrapped = unwrapResult(result);
  if (unwrapped == null || typeof unwrapped !== "object") return { kind: "none" };

  if (isToolErrorResult(unwrapped)) return { kind: "error", error: unwrapped.error };
  if (
    !("success" in unwrapped) &&
    "error" in unwrapped &&
    typeof (unwrapped as { error: unknown }).error === "string"
  ) {
    return { kind: "error", error: (unwrapped as { error: string }).error };
  }

  const parsed = SkillListSuccessSchema.safeParse(unwrapped);
  if (!parsed.success) return { kind: "none" };

  const skills = parsed.data.skills.flatMap((entry) => {
    const skill = AgentSkillDescriptorSchema.safeParse(entry);
    return skill.success ? [skill.data] : [];
  });
  return { kind: "skills", skills };
}

const InlineCode: React.FC<React.PropsWithChildren> = (props) => (
  <span className="text-foreground rounded-sm bg-white/10 px-1 py-0.5 font-mono break-all">
    {props.children}
  </span>
);

const UnadvertisedChip: React.FC = () => (
  <span className="text-warning bg-warning-overlay border-warning/40 inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] leading-none">
    <EyeOff aria-hidden="true" className="h-2.5 w-2.5" />
    unadvertised
  </span>
);

const SkillGroupHeader: React.FC<{ group: SkillScopeGroup }> = (props) => (
  <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-1">
    <span className={cn("h-1.5 w-1.5 shrink-0 rounded-[2px]", props.group.dotClass)} />
    <span
      className={cn("text-[10px] font-semibold tracking-wider uppercase", props.group.labelClass)}
    >
      {props.group.label}
    </span>
    <span className="text-muted text-[10px]">{props.group.skills.length}</span>
  </div>
);

// A single skill row. Collapsed it shows the name + a 2-line clamped description
// (descriptions can run to 1024 chars); clicking expands it in place to the full
// text plus how to invoke it. Rendered as a button so the disclosure is reachable
// by keyboard, not just pointer.
const SkillRow: React.FC<{ skill: AgentSkillDescriptor; first: boolean }> = (props) => {
  const [open, setOpen] = React.useState(false);
  const unadvertised = props.skill.advertise === false;
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
      className={cn(
        "block w-full rounded px-2 py-1.5 text-left transition-colors hover:bg-white/5",
        !props.first && "border-t border-white/5"
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-foreground text-[12.5px] font-medium break-words">
              {props.skill.name}
            </span>
            {unadvertised && <UnadvertisedChip />}
          </div>
          <div
            className={cn(
              "text-secondary mt-0.5 text-[11.5px] leading-snug break-words",
              !open && "line-clamp-2"
            )}
          >
            {props.skill.description}
          </div>
          {open && (
            <div className="text-muted mt-1.5 text-[11px] leading-snug">
              {unadvertised && (
                <span className="text-warning">
                  Hidden from the skill index — call it explicitly.{" "}
                </span>
              )}
              Invoke with <InlineCode>${props.skill.name}</InlineCode> or read it in full via{" "}
              <InlineCode>agent_skill_read</InlineCode>.
            </div>
          )}
        </div>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "text-muted mt-0.5 h-3 w-3 shrink-0 transition-transform duration-200",
            open && "rotate-90"
          )}
        />
      </div>
    </button>
  );
};

interface AgentSkillListToolCallProps {
  args: AgentSkillListToolArgs;
  result?: unknown;
  status?: ToolStatus;
  /** Initial expansion fallback (until the user toggles this tool in the workspace). */
  defaultExpanded?: boolean;
}

export const AgentSkillListToolCall: React.FC<AgentSkillListToolCallProps> = (props) => {
  const status = props.status ?? "pending";
  const { expanded, toggleExpanded } = useToolExpansion(props.defaultExpanded ?? false);

  const view = toSkillListView(props.result);
  const skills = view.kind === "skills" ? view.skills : [];
  const groups = groupSkillsByScope(skills);
  const unadvertisedCount = skills.filter((skill) => skill.advertise === false).length;
  // `includeUnadvertised` only narrows the empty-state copy: did the agent ask for the
  // full set and still find nothing, or just the advertised set?
  const includedUnadvertised = props.args.includeUnadvertised === true;

  const verb =
    status === "executing"
      ? "Listing skills"
      : view.kind === "skills"
        ? "Listed skills"
        : "List skills";

  return (
    <ToolContainer expanded={expanded} className="@container">
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="agent_skill_list" />
        <span className="text-secondary font-medium whitespace-nowrap">{verb}</span>
        {view.kind === "skills" && (
          <span className="text-muted whitespace-nowrap">
            {skills.length} {skills.length === 1 ? "skill" : "skills"}
          </span>
        )}
        {unadvertisedCount > 0 && (
          <span className="text-muted hidden whitespace-nowrap @sm:inline">
            · {unadvertisedCount} unadvertised
          </span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          {view.kind === "error" && <ErrorBox>{view.error}</ErrorBox>}

          {status === "executing" && view.kind !== "error" && (
            <div className="text-muted px-1 py-1 text-[11px] italic">
              Scanning available skills
              <LoadingDots />
            </div>
          )}

          {view.kind === "skills" && skills.length === 0 && status !== "executing" && (
            <div className="text-muted px-1 py-1 text-[11px] italic">
              {includedUnadvertised
                ? "No skills are available in this workspace."
                : "No advertised skills are available in this workspace."}
            </div>
          )}

          {groups.length > 0 && (
            <div className="bg-code-bg overflow-hidden rounded">
              {groups.map((group, index) => (
                <div key={group.scope} className={cn(index > 0 && "border-t border-white/10")}>
                  <SkillGroupHeader group={group} />
                  <div className="px-1.5 pb-1.5">
                    {group.skills.map((skill, skillIndex) => (
                      <SkillRow
                        key={`${group.scope}:${skill.name}`}
                        skill={skill}
                        first={skillIndex === 0}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {skills.length > 0 && (
            <div className="text-muted mt-2 px-1 text-[10.5px] leading-relaxed">
              Skills are project-local, global, or built-in — invoke any of them inline with{" "}
              <InlineCode>$name</InlineCode>
              {unadvertisedCount > 0
                ? "; unadvertised skills stay out of the index but remain callable by name."
                : "."}
            </div>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
