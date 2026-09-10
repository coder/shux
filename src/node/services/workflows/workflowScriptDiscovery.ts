import * as fsPromises from "node:fs/promises";

import type { AgentSkillDescriptor, SkillName } from "@/common/types/agentSkill";
import type { AvailableWorkflow } from "@/common/types/workflow";
import { getErrorMessage } from "@/common/utils/errors";
import type { Runtime } from "@/node/runtime/Runtime";
import { discoverAgentSkills } from "@/node/services/agentSkills/agentSkillsService";
import { getBuiltInSkillDescriptors } from "@/node/services/agentSkills/builtInSkillDefinitions";
import type { SkillStorageContext } from "@/node/services/agentSkills/skillStorageContext";
import { log } from "@/node/services/log";

import { buildWorkflowScriptDescriptor } from "./WorkflowService";
import { parseWorkflowMetadata, summarizeWorkflowArgs } from "./workflowMetadata";
import { resolveWorkflowPhaseManifest } from "./workflowPhaseManifest";
import { discoverWorkflowPlugins, resolveWorkflowScript } from "./workflowScriptResolver";

/** Conventional entry file for a workflow-bearing skill (e.g. deep-research). */
const WORKFLOW_SKILL_ENTRY = "workflow.js";

export interface DiscoverWorkflowScriptsInput {
  runtime: Runtime;
  workspacePath: string;
  /** Inclusive checkout/repository boundary for inherited project skills. */
  projectSearchRoot?: string;
  projectTrusted: boolean;
  /** agent-plugins experiment: also enumerate plugin skills and plugin workflows/ scripts. */
  includeAgentPlugins?: boolean;
  skillStorageContext?: SkillStorageContext;
}

/**
 * Enumerate the workflow scripts a workspace can run, for the Workflows tab's
 * empty-state launcher. There is no first-class workflow registry, so we probe
 * every known skill (built-in + project + global) for a `workflow.js` entry by
 * attempting to resolve it — a skill that resolves is a workflow; anything that
 * throws (no entry, or project trust missing) is skipped.
 *
 * Standalone `.xum/workflows/*.js` files are intentionally not enumerated here:
 * they're an advanced, trust-gated path still launchable from chat. Skill-based
 * workflows cover the common case.
 */
export async function discoverWorkflowScripts(
  input: DiscoverWorkflowScriptsInput
): Promise<AvailableWorkflow[]> {
  const skillNames: SkillName[] = [];
  const seen = new Set<string>();
  const addSkill = (descriptor: AgentSkillDescriptor) => {
    // The Workflows tab launcher is a user-facing invocation surface, so honor
    // user-invocable: false the same way slash/palette/ACP surfaces do.
    if (descriptor.userInvocable === false) {
      return;
    }
    if (!seen.has(descriptor.name)) {
      seen.add(descriptor.name);
      skillNames.push(descriptor.name);
    }
  };

  // Built-ins aren't part of discoverAgentSkills' project/global scan, so seed them first;
  // readAgentSkill resolves by precedence (project > global > built-in) when names collide.
  getBuiltInSkillDescriptors().forEach(addSkill);
  try {
    const skillCtx = input.skillStorageContext;
    (
      await discoverAgentSkills(
        skillCtx?.runtime ?? input.runtime,
        skillCtx?.workspacePath ?? input.workspacePath,
        skillCtx != null
          ? { roots: skillCtx.roots, containment: skillCtx.containment }
          : {
              projectSearchRoot: input.projectSearchRoot,
              containment: {
                kind: "runtime",
                root: input.projectSearchRoot ?? input.workspacePath,
              },
              includeAgentPlugins: input.includeAgentPlugins,
            }
      )
    ).forEach(addSkill);
  } catch (error) {
    log.warn(`Workflow script discovery: failed to enumerate skills: ${getErrorMessage(error)}`);
  }

  const tryPush = async (available: AvailableWorkflow[], scriptPath: string): Promise<void> => {
    try {
      const resolved = await resolveWorkflowScript({
        scriptPath,
        runtime: input.runtime,
        workspacePath: input.workspacePath,
        projectSearchRoot: input.projectSearchRoot,
        projectTrusted: input.projectTrusted,
        includeAgentPlugins: input.includeAgentPlugins,
        skillStorageContext: input.skillStorageContext,
      });
      const descriptor = buildWorkflowScriptDescriptor(resolved);
      // Pre-run phase preview. An invalid meta.phases declaration must not hide
      // the script from the launcher: surface a warning instead (run creation
      // rejects with the same enumerated issues).
      const manifestOutcome = resolveWorkflowPhaseManifest(resolved.source, resolved.sourceHash);
      if (manifestOutcome.kind === "manifest") {
        descriptor.phaseManifest = manifestOutcome.manifest;
      }
      available.push({
        descriptor,
        scriptPath: resolved.canonicalScriptPath,
        args: summarizeWorkflowArgs(parseWorkflowMetadata(resolved.source)) ?? [],
        ...(manifestOutcome.kind === "invalid"
          ? { phaseManifestWarning: manifestOutcome.warning }
          : {}),
      });
    } catch {
      // Skip non-workflow skills (no workflow.js), untrusted project skills, AND scripts whose
      // arg metadata fails to parse/summarize — keeping the whole body in the per-skill catch so
      // one malformed workflow can't abort discovery and hide every other workflow.
    }
  };

  const available: AvailableWorkflow[] = [];
  for (const skillName of skillNames) {
    await tryPush(available, `skill://${skillName}/${WORKFLOW_SKILL_ENTRY}`);
  }

  // Agent Plugins: standalone workflows/ contributions, addressed as
  // plugin://<name>/<file>.js. Same per-script failure isolation as skills.
  if (input.includeAgentPlugins === true) {
    try {
      const plugins = await discoverWorkflowPlugins(input);
      const seenPluginNames = new Set<string>();
      for (const plugin of plugins) {
        if (plugin.workflowsDir == null) continue;
        // The resolver picks the first plugin matching a name, so duplicate
        // names in lower-precedence containers cannot contribute here either.
        if (seenPluginNames.has(plugin.name)) continue;
        seenPluginNames.add(plugin.name);

        for (const fileName of await listWorkflowScriptFiles(plugin.workflowsDir)) {
          await tryPush(available, `plugin://${plugin.name}/${fileName}`);
        }
      }
    } catch (error) {
      log.warn(`Workflow script discovery: failed to enumerate plugins: ${getErrorMessage(error)}`);
    }
  }

  available.sort((a, b) => a.descriptor.name.localeCompare(b.descriptor.name));
  return available;
}

/** Top-level *.js entries of a plugin workflows/ dir (host-local, sorted). */
async function listWorkflowScriptFiles(workflowsDir: string): Promise<string[]> {
  try {
    const entries = await fsPromises.readdir(workflowsDir, { withFileTypes: true });
    return entries
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".js"))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}
