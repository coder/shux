import React, { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  CircleAlert,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { useAPI } from "@/browser/contexts/API";
import { Button } from "@/browser/components/Button/Button";
import { Checkbox } from "@/browser/components/Checkbox/Checkbox";
import { cn } from "@/common/lib/utils";
import type {
  AgentPluginComponents,
  AgentPluginInstallPreview,
  AgentPluginListItem,
  AgentPluginUpdateCheck,
  AgentPluginUpdateReview,
} from "@/common/orpc/schemas/agentPlugins";
import type { AgentPluginImportedComponents } from "@/common/config/schemas/agentPluginInstalls";
import { getErrorMessage } from "@/common/utils/errors";
import { publishAgentPluginsMutated } from "@/browser/utils/agentPluginMutations";
import {
  consumePendingPluginsSectionIntent,
  subscribePluginsSectionIntents,
  type PluginsSectionIntent,
} from "./pluginsSectionIntents";

/**
 * Settings → Plugins (agent-plugins experiment; global scope only).
 *
 * Managed installs come from the `~/.mux/plugins.json` registry;
 * unmanaged plugin directories found by discovery are listed read-only.
 * Update checks run on section open and on the explicit button only — no
 * background timers, and updates never auto-apply.
 */

/** Compact source display, e.g. "github.com/foo/grill @ main". */
function formatSource(item: AgentPluginListItem): string | null {
  if (!item.source) {
    return null;
  }
  const url = item.source.url
    .replace(/^https:\/\//, "")
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/\.git$/, "");
  const ref = item.source.refType === "commit" ? item.source.ref.slice(0, 12) : item.source.ref;
  return `${url} @ ${ref}`;
}

const Badge: React.FC<{
  tone: "muted" | "accent" | "warning" | "error";
  children: React.ReactNode;
}> = (props) => (
  <span
    className={cn(
      "rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
      props.tone === "muted" && "bg-foreground/10 text-muted",
      props.tone === "accent" && "bg-accent/15 text-accent",
      props.tone === "warning" && "bg-warning/15 text-warning",
      props.tone === "error" && "bg-destructive/15 text-destructive"
    )}
  >
    {props.children}
  </span>
);

/** Only skills/MCP are selective; keep full-package consent below this shared chooser. */
const ComponentChooser: React.FC<{
  inventory: Pick<AgentPluginComponents, "skills" | "mcpServers">;
  selected: AgentPluginImportedComponents;
  imported?: AgentPluginImportedComponents;
  disabled: boolean;
  onChange: (selection: AgentPluginImportedComponents) => void;
}> = (props) => (
  <div className="space-y-3">
    {(["skills", "mcpServers"] as const).map((group) => {
      const label = group === "skills" ? "Skills" : "MCP servers";
      const entries =
        group === "skills"
          ? props.inventory.skills.map((skill) => ({ name: skill.name, detail: skill.description }))
          : props.inventory.mcpServers.map((server) => ({
              name: server.serverName,
              detail: `${server.transport} · ${server.summary}`,
            }));
      const imported = props.imported?.[group] ?? [];
      const selectable = entries.map((entry) => entry.name);
      const count = entries.filter(({ name }) => props.selected[group].includes(name)).length;
      const change = (names: string[]) => props.onChange({ ...props.selected, [group]: names });
      return (
        <fieldset
          key={group}
          aria-label={label}
          className="min-w-0 space-y-1"
          disabled={props.disabled}
        >
          <legend className="text-foreground text-xs font-medium">
            {label}{" "}
            <span className="counter-nums">
              ({count} of {entries.length} selected)
            </span>
          </legend>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={props.disabled || count === entries.length}
              onClick={() => change(selectable)}
            >
              Select all
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={props.disabled || props.selected[group].length === 0}
              onClick={() => change([])}
            >
              Clear
            </Button>
          </div>
          {entries.length === 0 && <p className="text-muted text-xs">None available</p>}
          {entries.map(({ name, detail }) => (
            <label key={name} className="flex items-start gap-2 text-xs">
              <Checkbox
                aria-label={name}
                checked={props.selected[group].includes(name)}
                disabled={props.disabled}
                onCheckedChange={(checked) =>
                  change(
                    checked === true
                      ? [...props.selected[group], name]
                      : props.selected[group].filter((value) => value !== name)
                  )
                }
              />
              <span className="min-w-0 break-words">
                <span className="text-foreground font-mono break-all">{name}</span>
                {imported.includes(name) && <span className="text-muted"> — imported</span>}
                {detail && (
                  <span className="text-muted block break-all whitespace-pre-wrap">{detail}</span>
                )}
              </span>
            </label>
          ))}
        </fieldset>
      );
    })}
    <p className="text-muted text-[11px]">
      {props.imported
        ? "New MCP imports need workspace opt-in. Re-adding a server honors its saved workspace enablement."
        : "Importing MCP servers only makes them available; they stay disabled until enabled per workspace."}
    </p>
    <p className="text-muted hidden text-[11px] md:block">
      Tab to navigate · Space to select · Enter to activate buttons
    </p>
  </div>
);

function effectiveImports(inventory: AgentPluginComponents): AgentPluginImportedComponents {
  return {
    skills: inventory.skills
      .map((skill) => skill.name)
      .filter(
        (name) =>
          !inventory.importedComponents || inventory.importedComponents.skills.includes(name)
      ),
    mcpServers: inventory.mcpServers
      .map((server) => server.serverName)
      .filter(
        (name) =>
          !inventory.importedComponents || inventory.importedComponents.mcpServers.includes(name)
      ),
  };
}

function sameImports(
  a: AgentPluginImportedComponents | null,
  b: AgentPluginImportedComponents | null
): boolean {
  if (a === null || b === null) return a === b;
  return (["skills", "mcpServers"] as const).every(
    (group) =>
      a[group].every((name) => b[group].includes(name)) &&
      b[group].every((name) => a[group].includes(name))
  );
}

const ManageComponentsPanel: React.FC<{
  name: string;
  onSaved: () => Promise<void>;
  onClose: () => void;
}> = (props) => {
  const { api } = useAPI();
  // Keep the raw baseline (including legacy absence) separate from the visible selection.
  const [inventory, setInventory] = useState<AgentPluginComponents | null>(null);
  const [selected, setSelected] = useState<AgentPluginImportedComponents>({
    skills: [],
    mcpServers: [],
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saved, setSaved] = useState(false);
  const name = props.name;

  useEffect(() => {
    let ignore = false;
    if (!api) return;
    api.agentPlugins.getComponents({ name }).then(
      (result) => {
        if (ignore) return;
        if (result.success) {
          setInventory(result.data);
          setSelected(effectiveImports(result.data));
        } else setError(result.error);
        setBusy(false);
      },
      (err: unknown) => {
        if (!ignore) {
          setError(getErrorMessage(err));
          setBusy(false);
        }
      }
    );
    return () => {
      ignore = true;
    };
  }, [api, name, loadAttempt]);

  const imported = inventory ? effectiveImports(inventory) : { skills: [], mcpServers: [] };
  const added = (["skills", "mcpServers"] as const).reduce(
    (count, group) =>
      count + selected[group].filter((name) => !imported[group].includes(name)).length,
    0
  );
  const removed = (["skills", "mcpServers"] as const).reduce(
    (count, group) =>
      count + imported[group].filter((name) => !selected[group].includes(name)).length,
    0
  );
  const handleSave = async () => {
    if (!api || !inventory || busy || added + removed === 0) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    let confirmed = false;
    let responseLost = false;
    let warning: string | undefined;
    try {
      const result = await api.agentPlugins
        .setComponents({
          name,
          expectedLockedSha: inventory.lockedSha,
          expectedContentHash: inventory.contentHash,
          expectedImportedComponents: inventory.importedComponents ?? null,
          importedComponents: selected,
        })
        .catch((err: unknown) => {
          responseLost = true;
          throw err;
        });
      if (!result.success) throw new Error(result.error);
      confirmed = true;
      warning = result.cleanupWarning;
      setSaved(true);
      publishAgentPluginsMutated();
    } catch (err) {
      setError(getErrorMessage(err));
    }
    // Refetch even after a lost response: a transport failure does not mean the write failed.
    try {
      const current = await api.agentPlugins.getComponents({ name });
      if (!current.success) throw new Error(current.error);
      const sameTree =
        current.data.lockedSha === inventory.lockedSha &&
        current.data.contentHash === inventory.contentHash;
      if (
        confirmed ||
        (responseLost && sameTree && sameImports(current.data.importedComponents ?? null, selected))
      ) {
        setInventory(current.data);
        setSelected(effectiveImports(current.data));
        setSaved(true);
        setError(warning ?? null);
        if (!confirmed) publishAgentPluginsMutated();
        await props.onSaved();
      } else if (
        !sameTree ||
        !sameImports(current.data.importedComponents ?? null, inventory.importedComponents ?? null)
      ) {
        setInventory(current.data);
        setSelected(effectiveImports(current.data));
        setError(
          "The installed plugin or selection changed. Inventory refreshed; review your choices and save again."
        );
      }
    } catch (err) {
      setError(
        confirmed
          ? `Components saved, but refreshing failed: ${getErrorMessage(err)}. Reopen to read the saved selection.`
          : `Could not confirm the saved selection: ${getErrorMessage(err)}. Reopen to refresh before retrying.`
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="border-border-medium bg-background-secondary mt-2 space-y-3 rounded-md border p-3">
      <p className="text-foreground text-xs">
        Manage components from the installed version
        {inventory ? ` · ${inventory.lockedSha.slice(0, 12)}` : ""}. No remote fetch.
      </p>
      <p className="text-muted text-xs">
        Removing imports keeps source files, plugin data, and workspace MCP settings. Uninstall is
        separate.
      </p>
      {busy && (
        <p role="status" className="text-muted text-xs">
          {inventory ? "Saving components…" : "Loading components…"}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive text-xs break-words">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="text-accent text-xs">
          Component selection saved.
        </p>
      )}
      {inventory && (
        <>
          <ComponentChooser
            inventory={inventory}
            imported={imported}
            selected={selected}
            disabled={busy}
            onChange={(selection) => {
              setSelected(selection);
              setSaved(false);
            }}
          />
          <p className="text-muted counter-nums text-xs">
            {added} to add · {removed} to remove
          </p>
          {selected.skills.length + selected.mcpServers.length === 0 && (
            <p className="text-muted text-xs">
              No skills or MCP servers will be imported. The plugin stays installed.
            </p>
          )}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        {inventory ? (
          <Button
            size="sm"
            disabled={busy || added + removed === 0}
            onClick={() => void handleSave()}
          >
            Save changes
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setError(null);
              setBusy(true);
              setLoadAttempt((attempt) => attempt + 1);
            }}
          >
            Retry inventory
          </Button>
        )}
        <Button variant="ghost" size="sm" disabled={busy} onClick={props.onClose}>
          {saved ? "Done" : "Cancel"}
        </Button>
      </div>
    </div>
  );
};

/** Two-phase add flow: source input → consent preview → install. */
const AddPluginPanel: React.FC<{
  onInstalled: () => void;
  onClose: () => void;
}> = (props) => {
  const { api } = useAPI();
  const [input, setInput] = useState("");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<AgentPluginInstallPreview | null>(null);
  const [selected, setSelected] = useState<AgentPluginImportedComponents>({
    skills: [],
    mcpServers: [],
  });

  const handlePreview = async () => {
    if (!api || input.trim().length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.agentPlugins.preview({
        input: input.trim(),
        ref: ref.trim().length > 0 ? ref.trim() : null,
      });
      if (result.success) {
        setPreview(result.data);
        // An accepted preview starts a new consent decision; failed attempts retain choices.
        setSelected({
          skills: result.data.skills.map((skill) => skill.name),
          mcpServers: result.data.mcpServers.map((server) => server.serverName),
        });
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleInstall = async () => {
    if (!api || !preview || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.agentPlugins.install({
        source: preview.source,
        expectedSha: preview.lockedSha,
        importedComponents: selected,
      });
      if (result.success) {
        // Mounted composers cache contributed slash-command/skill
        // descriptors; an install adds them without a remount.
        publishAgentPluginsMutated();
        props.onInstalled();
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-border-medium bg-background-secondary space-y-3 rounded-md border p-3">
      {preview === null ? (
        <>
          <div>
            <label htmlFor="plugin-source" className="text-muted mb-1 block text-xs">
              Git URL or owner/repo
            </label>
            <input
              id="plugin-source"
              type="text"
              autoFocus
              placeholder="e.g., owner/repo, owner/repo@v1.2.0, or https://github.com/owner/repo.git"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handlePreview();
              }}
              spellCheck={false}
              className="bg-modal-bg border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 font-mono text-sm focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="plugin-ref" className="text-muted mb-1 block text-xs">
              Branch, tag, or commit SHA (optional — defaults to the default branch)
            </label>
            <input
              id="plugin-ref"
              type="text"
              placeholder="e.g., main, v1.2.0, or a full 40-character SHA"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handlePreview();
              }}
              spellCheck={false}
              className="bg-modal-bg border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 font-mono text-sm focus:outline-none"
            />
          </div>
          {error && (
            <div
              role="alert"
              className="bg-destructive/10 text-destructive flex items-start gap-2 rounded-md px-3 py-2 text-sm"
            >
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="break-words">{error}</span>
            </div>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => void handlePreview()}
              disabled={busy || input.trim().length === 0}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {busy ? "Fetching…" : "Preview"}
            </Button>
            <Button variant="ghost" size="sm" onClick={props.onClose} disabled={busy}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          {/* Consent preview: everything the plugin will contribute, before anything is written. */}
          <div className="space-y-1">
            <div className="flex flex-wrap items-baseline gap-2">
              {/* break-all: a valid 64-char separator-free name has no natural
                  break points and would overflow the card on phone widths. */}
              <span className="text-foreground text-sm font-medium break-all">
                {preview.manifest.name}
              </span>
              {preview.manifest.version && (
                <span className="text-muted text-xs">v{preview.manifest.version}</span>
              )}
              <Badge tone="muted">
                {preview.source.refType} · {preview.lockedSha.slice(0, 12)}
              </Badge>
            </div>
            {preview.manifest.description && (
              <p className="text-muted text-xs">{preview.manifest.description}</p>
            )}
            {/* break-all: URLs and a 64-char separator-free plugin dir name
                have no natural break points and would overflow the card on
                phone widths. */}
            <p className="text-muted text-[11px] break-all">
              {preview.source.url} @ {preview.source.ref} →{" "}
              <code className="text-accent">{preview.targetPath}</code>
              {preview.manifest.authorName ? ` · by ${preview.manifest.authorName}` : ""}
              {preview.manifest.license ? ` · ${preview.manifest.license}` : ""}
            </p>
          </div>

          {preview.warnings.length > 0 && (
            <div className="bg-warning/10 space-y-1 rounded-md px-3 py-2">
              {preview.warnings.map((warning) => (
                <div key={warning} className="text-warning flex items-start gap-2 text-xs">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="break-words">{warning}</span>
                </div>
              ))}
            </div>
          )}

          <ComponentChooser
            inventory={preview}
            selected={selected}
            disabled={busy}
            onChange={setSelected}
          />
          <p className="text-warning text-xs">
            {selected.skills.length + selected.mcpServers.length === 0
              ? "No skills or MCP servers selected. "
              : ""}
            Selection does not affect agents, workflows, slash commands, or hooks below: these
            remain part of the install, even when neither group is selected. Skipped files stay on
            disk; this is not a filesystem sandbox.
          </p>

          {preview.agents.length > 0 && (
            <div>
              <h4 className="text-foreground mb-1 text-xs font-medium">
                Agents ({preview.agents.length})
              </h4>
              {/* Activatable components: consent must name everything that
                  becomes available after install, not just skills/MCP. */}
              <p className="text-xs">
                <span className="text-foreground font-mono break-all">
                  {preview.agents.join(", ")}
                </span>{" "}
                <span className="text-muted">— become selectable agent definitions.</span>
              </p>
            </div>
          )}

          {preview.workflows.length > 0 && (
            <div>
              <h4 className="text-foreground mb-1 text-xs font-medium">
                Workflows ({preview.workflows.length})
              </h4>
              <p className="text-xs">
                <span className="text-foreground font-mono break-all">
                  {preview.workflows.join(", ")}
                </span>{" "}
                <span className="text-muted">
                  — executable workflow scripts, invokable after install.
                </span>
              </p>
            </div>
          )}

          {preview.slashCommands.length > 0 && (
            <div>
              <h4 className="text-foreground mb-1 text-xs font-medium">
                Slash commands ({preview.slashCommands.length})
              </h4>
              <ul className="space-y-1">
                {preview.slashCommands.map((command) => (
                  <li key={command.name} className="text-xs">
                    <span className="text-foreground font-mono">/{command.name}</span>
                    {command.description && (
                      <span className="text-muted"> — {command.description}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {preview.hook && (
            <div>
              <h4 className="text-foreground mb-1 text-xs font-medium">Hooks</h4>
              {/* Executable code that loads automatically: consent must say so. */}
              <p className="text-xs">
                <span className="text-foreground font-mono break-all">{preview.hook.path}</span>{" "}
                <span className="text-muted">
                  — runs sandboxed on every agent request and can observe, rewrite, or block tool
                  calls
                  {preview.hook.toolGrants.length > 0
                    ? ` for: ${preview.hook.toolGrants.join(", ")}`
                    : " (no tool visibility granted)"}
                  .
                </span>
              </p>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="bg-destructive/10 text-destructive flex items-start gap-2 rounded-md px-3 py-2 text-sm"
            >
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="break-words">{error}</span>
            </div>
          )}

          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setPreview(null);
                setError(null);
              }}
              disabled={busy}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back
            </Button>
            <Button size="sm" onClick={() => void handleInstall()} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {busy ? "Installing…" : "Install"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
};

/** Inline uninstall confirmation (conditional rendering keeps this testable without portals). */
const UninstallConfirm: React.FC<{
  item: AgentPluginListItem;
  busy: boolean;
  onConfirm: (deletePluginData: boolean) => void;
  onCancel: () => void;
}> = (props) => {
  const [deletePluginData, setDeletePluginData] = useState(false);

  return (
    <div className="border-border-medium bg-background-secondary mt-2 space-y-2 rounded-md border p-3">
      <p className="text-foreground text-xs">
        Uninstall <span className="font-medium">{props.item.name}</span>? This removes the plugin
        directory and its workspace MCP overrides.
      </p>
      <label className="text-muted flex items-center gap-2 text-xs">
        <Checkbox
          checked={deletePluginData}
          onCheckedChange={(checked) => setDeletePluginData(checked === true)}
          disabled={props.busy}
        />
        Also delete stored plugin data
      </label>
      <div className="flex gap-2">
        <Button
          variant="destructive"
          size="sm"
          onClick={() => props.onConfirm(deletePluginData)}
          disabled={props.busy}
        >
          {props.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {props.busy ? "Uninstalling…" : "Uninstall"}
        </Button>
        <Button variant="ghost" size="sm" onClick={props.onCancel} disabled={props.busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
};

/**
 * In-place re-consent for an update that changes the plugin's capability
 * surface (new/reworded skill advertisements, MCP servers, hooks, agents,
 * …). Shows each change with the consented ("before") and staged ("after")
 * value so the user can judge it, instead of being routed through uninstall
 * + reinstall. Conditional rendering keeps this testable without portals.
 */
const UpdateReviewPanel: React.FC<{
  review: AgentPluginUpdateReview;
  selective: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}> = (props) => (
  <div className="border-border-medium bg-background-secondary mt-2 space-y-2 rounded-md border p-3">
    <p className="text-foreground text-xs">
      This update{props.review.version ? ` (v${props.review.version})` : ""} changes what the plugin
      can do. Review the changes before applying it:
    </p>
    {props.selective && (
      <p className="text-warning text-xs">
        Your imported selection is preserved. Newly disclosed skills and MCP servers stay unimported
        until you add them; this review still covers the full package.
      </p>
    )}
    <ul className="space-y-2">
      {props.review.changes.map((change) => (
        <li key={change.summary} className="text-xs">
          <span className="text-foreground break-words">{change.summary}</span>
          {(change.before !== undefined || change.after !== undefined) && (
            <dl className="mt-1 space-y-1">
              {change.before !== undefined && (
                <div className="flex gap-2">
                  <dt className="text-muted w-10 shrink-0 text-[11px]">Before</dt>
                  <dd className="bg-modal-bg border-border-medium min-w-0 flex-1 rounded border px-2 py-1 font-mono text-[11px] break-words whitespace-pre-wrap">
                    {change.before}
                  </dd>
                </div>
              )}
              {change.after !== undefined && (
                <div className="flex gap-2">
                  <dt className="text-muted w-10 shrink-0 text-[11px]">After</dt>
                  <dd className="bg-modal-bg border-border-medium min-w-0 flex-1 rounded border px-2 py-1 font-mono text-[11px] break-words whitespace-pre-wrap">
                    {change.after}
                  </dd>
                </div>
              )}
            </dl>
          )}
        </li>
      ))}
    </ul>
    {props.review.warnings.length > 0 && (
      <div className="bg-warning/10 space-y-1 rounded-md px-3 py-2">
        {props.review.warnings.map((warning) => (
          <div key={warning} className="text-warning flex items-start gap-2 text-xs">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="break-words">{warning}</span>
          </div>
        ))}
      </div>
    )}
    <p className="text-muted text-[11px] break-all">
      {props.review.fromSha.slice(0, 12)} → {props.review.toSha.slice(0, 12)}
    </p>
    <div className="flex gap-2">
      <Button size="sm" onClick={props.onConfirm} disabled={props.busy}>
        {props.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {props.busy ? "Updating…" : "Apply update"}
      </Button>
      <Button variant="ghost" size="sm" onClick={props.onCancel} disabled={props.busy}>
        Cancel
      </Button>
    </div>
  </div>
);

export const PluginsSettingsSection: React.FC = () => {
  const { api } = useAPI();
  const [items, setItems] = useState<AgentPluginListItem[] | null>(null);
  // List/mutation errors and update-check errors live in separate state: the
  // mount-time list query and update check run concurrently, and a later
  // refresh success must not clear a check failure (an unreachable remote has
  // to stay visibly unknown, never silently "up to date").
  const [error, setError] = useState<string | null>(null);
  const [updateCheckError, setUpdateCheckError] = useState<string | null>(null);
  const [updateChecks, setUpdateChecks] = useState<Map<string, AgentPluginUpdateCheck>>(
    () => new Map()
  );
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  // Backend-provided container path: the root is config-derived (canonically
  // ~/.shux, possibly custom/legacy), so this copy must never hardcode it.
  const [containerLocation, setContainerLocation] = useState<string | null>(null);
  // Palette intents (keyboard rule: install/uninstall/update need keyboard
  // paths). The initializer covers palette → fresh mount; the subscription
  // below covers commands invoked while this section is already on screen
  // (same-route navigation preserves the mounted component, so no re-init
  // happens).
  const [initialIntent] = useState(() => consumePendingPluginsSectionIntent());
  const [addOpen, setAddOpen] = useState(initialIntent?.type === "open-add-panel");
  const [uninstallTarget, setUninstallTarget] = useState<string | null>(
    initialIntent?.type === "confirm-uninstall" ? initialIntent.name : null
  );
  const [componentsTarget, setComponentsTarget] = useState<string | null>(
    initialIntent?.type === "manage-components" ? initialIntent.name : null
  );
  const [installSucceeded, setInstallSucceeded] = useState(false);
  /** Name of the plugin with an update/uninstall in flight. */
  const [busyPlugin, setBusyPlugin] = useState<string | null>(null);
  /** Pending update whose capability changes await the user's confirmation. */
  const [updateReview, setUpdateReview] = useState<AgentPluginUpdateReview | null>(
    initialIntent?.type === "review-update" ? initialIntent.review : null
  );
  /** Monotonic ids of the latest list/update-check requests; stale responses must not commit state. */
  const listGenerationRef = useRef(0);
  const checkGenerationRef = useRef(0);

  const openAddPanel = () => {
    // Feedback belongs to the completed install, not the next attempt from any entry point.
    setInstallSucceeded(false);
    setAddOpen(true);
  };

  const refresh = async () => {
    if (!api) return;
    // Overlapping list requests race the same way update checks do (mount
    // fetch vs a refresh published after a palette mutation): an older
    // response resolving last would resurrect removed rows or old versions.
    const generation = ++listGenerationRef.current;
    try {
      const result = await api.agentPlugins.list();
      if (generation !== listGenerationRef.current) {
        return; // A newer list request superseded this one.
      }
      if (result.success) {
        setItems(result.data);
        setError(null);
      } else {
        setItems([]);
        setError(result.error);
      }
    } catch (err) {
      if (generation === listGenerationRef.current) {
        setItems([]);
        setError(getErrorMessage(err));
      }
    }
  };

  const checkForUpdates = async () => {
    if (!api) return;
    // Overlapping checks race (mount-time check vs a refresh published by a
    // palette update): only the latest request may commit state, or a stale
    // response can resurrect an update badge the update just cleared.
    const generation = ++checkGenerationRef.current;
    setCheckingUpdates(true);
    try {
      const result = await api.agentPlugins.checkUpdates();
      if (generation !== checkGenerationRef.current) {
        return; // A newer check superseded this one.
      }
      if (result.success) {
        setUpdateChecks(new Map(result.data.map((check) => [check.name, check])));
        setUpdateCheckError(null);
      } else {
        setUpdateCheckError(result.error);
      }
    } catch (err) {
      if (generation === checkGenerationRef.current) {
        setUpdateCheckError(getErrorMessage(err));
      }
    } finally {
      if (generation === checkGenerationRef.current) {
        setCheckingUpdates(false);
      }
    }
  };

  // Approved update policy: passive check on section open + explicit button only.
  useEffect(() => {
    void refresh();
    void checkForUpdates();
    void api?.agentPlugins.containerLocation().then(setContainerLocation, () => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on mount / API reconnect only; refresh/checkForUpdates are plain handlers (compiler-memoized), not inputs
  }, [api]);

  // Live palette intents while mounted (see pluginsSectionIntents).
  useEffect(() => {
    return subscribePluginsSectionIntents((intent: PluginsSectionIntent) => {
      switch (intent.type) {
        case "open-add-panel":
          openAddPanel();
          break;
        case "manage-components":
          setComponentsTarget(intent.name);
          break;
        case "confirm-uninstall":
          setUninstallTarget(intent.name);
          break;
        case "review-update":
          setUpdateReview(intent.review);
          break;
        case "refresh":
          void refresh();
          void checkForUpdates();
          break;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resubscribe on API reconnect only; the listener reads the latest handlers via closure per subscription
  }, [api]);

  /**
   * Update click: review first. A capability-neutral update applies right
   * away; one that changes the capability surface opens the inline review,
   * and only its confirmation applies it (with a consent naming the reviewed
   * SHAs — see installService.update).
   */
  const handleUpdate = async (name: string) => {
    if (!api || busyPlugin !== null) return;
    setBusyPlugin(name);
    setError(null);
    setUpdateReview(null);
    try {
      const preview = await api.agentPlugins.previewUpdate({ name });
      if (!preview.success) {
        setError(preview.error);
        return;
      }
      if (preview.data.changes.length > 0) {
        setUpdateReview(preview.data);
        return;
      }
      await applyUpdate(name, undefined);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyPlugin(null);
    }
  };

  const handleConfirmUpdate = async (review: AgentPluginUpdateReview) => {
    if (!api || busyPlugin !== null) return;
    setBusyPlugin(review.name);
    setError(null);
    try {
      await applyUpdate(review.name, { fromSha: review.fromSha, toSha: review.toSha });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyPlugin(null);
    }
  };

  /** Shared tail of both update paths; callers own busy state and error capture. */
  const applyUpdate = async (
    name: string,
    consent: { fromSha: string; toSha: string } | undefined
  ) => {
    if (!api) return;
    const result = await api.agentPlugins.update({ name, consent: consent ?? null });
    if (result.success) {
      // Mounted composers cache contributed slash-command/skill
      // descriptors; an update can change them without a remount.
      publishAgentPluginsMutated();
      setUpdateReview(null);
    }
    // Refresh regardless of outcome (the swap may be partially visible),
    // but re-assert the mutation error AFTER the refresh: refresh's
    // success path clears the error state, which would silently swallow
    // the failure the user needs to see.
    await refresh();
    await checkForUpdates();
    if (!result.success) {
      setError(result.error);
    }
  };

  const handleUninstall = async (name: string, deletePluginData: boolean) => {
    if (!api || busyPlugin !== null) return;
    setBusyPlugin(name);
    setError(null);
    try {
      const result = await api.agentPlugins.uninstall({ name, deletePluginData });
      if (result.success) {
        // Mounted composers cache contributed slash-command/skill
        // descriptors; an uninstall removes them without a remount.
        publishAgentPluginsMutated();
        setUninstallTarget(null);
        await refresh();
      } else {
        // Keep the confirmation open and surface the error after the list
        // refresh (whose success path clears error state).
        await refresh();
        setError(result.error);
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyPlugin(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Mirrors the Backup section's experimental posture: nav flask icon
          (SettingsPage `experimental: true`) + in-section warning banner. */}
      <div className="bg-warning/10 border-warning/30 text-warning flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
        <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p>
          Agent Plugins are experimental. The plugin format and install behavior may change or be
          removed in a future release; use them carefully.
        </p>
      </div>

      <div>
        <p className="text-muted mb-4 text-xs">
          Install Agent Plugins from git repositories into{" "}
          {containerLocation !== null ? (
            <code className="text-accent">{containerLocation}</code>
          ) : (
            "the managed plugins directory"
          )}
          . Plugins contribute skills and default-disabled MCP servers. Installs are global (shared
          by all projects); updates are manual, and updating discards any local edits to the plugin
          directory.
        </p>
      </div>

      <div>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-foreground text-sm font-medium">Installed plugins</h3>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void checkForUpdates()}
              disabled={checkingUpdates}
            >
              {checkingUpdates ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Check for updates
            </Button>
            {!addOpen && (
              <Button size="sm" onClick={openAddPanel}>
                <Plus className="h-3.5 w-3.5" />
                Add plugin
              </Button>
            )}
          </div>
        </div>

        {addOpen && (
          <div className="mb-4">
            <AddPluginPanel
              onInstalled={() => {
                setAddOpen(false);
                setInstallSucceeded(true);
                void refresh();
                void checkForUpdates();
              }}
              onClose={() => setAddOpen(false)}
            />
          </div>
        )}

        {installSucceeded && (
          <p role="status" className="text-accent mb-3 text-xs">
            Plugin installed.
          </p>
        )}
        {error && (
          <div className="bg-destructive/10 text-destructive mb-3 flex items-start gap-2 rounded-md px-3 py-2 text-sm">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}
        {updateCheckError && (
          <div className="bg-warning/10 text-warning mb-3 flex items-start gap-2 rounded-md px-3 py-2 text-sm">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="break-words">Update check failed: {updateCheckError}</span>
          </div>
        )}

        <div className="space-y-2">
          {items === null ? (
            <div className="text-muted flex items-center gap-2 py-4 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading plugins…
            </div>
          ) : items.length === 0 ? (
            <p className="text-muted py-2 text-sm">No plugins installed yet.</p>
          ) : (
            items.map((item) => {
              // Update checks are keyed by MANAGED-registry name: an
              // unmanaged plugin in another container can share the manifest
              // name, and rendering the managed install's check state on its
              // read-only row would mislabel unrelated content ("update
              // available" with no Update action).
              const check = item.managed ? updateChecks.get(item.name) : undefined;
              const updateAvailable =
                item.managed &&
                (check?.status === "update-available" || check?.status === "tag-moved");
              const isBusy = busyPlugin === item.name;

              return (
                <div
                  key={`${item.location}:${item.name}`}
                  className="border-border-medium rounded-md border p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-2">
                        {/* break-all: names can be 64 separator-free chars. */}
                        <span className="text-foreground text-sm font-medium break-all">
                          {item.name}
                        </span>
                        {item.version && (
                          <span className="text-muted text-xs">v{item.version}</span>
                        )}
                        {!item.managed && <Badge tone="muted">unmanaged</Badge>}
                        {item.managed && !item.present && <Badge tone="error">missing</Badge>}
                        {check?.status === "update-available" && (
                          <Badge tone="accent">update available</Badge>
                        )}
                        {check?.status === "tag-moved" && <Badge tone="warning">tag moved</Badge>}
                        {check?.status === "pinned" && <Badge tone="muted">pinned</Badge>}
                        {check?.status === "error" && <Badge tone="warning">check failed</Badge>}
                      </div>
                      {item.description && (
                        <p className="text-muted mt-0.5 text-xs">{item.description}</p>
                      )}
                      {/* break-all: locations/sources can contain unbreakable
                          64-char tokens (max-length plugin names) that would
                          otherwise overflow the card at phone widths. */}
                      <p className="text-muted counter-nums mt-0.5 text-[11px] break-all">
                        {item.importedSkillCount ?? item.skillCount} of {item.skillCount} skills
                        imported · {item.importedMcpServerCount ?? item.mcpServerCount} of{" "}
                        {item.mcpServerCount} MCP servers imported · <code>{item.location}</code>
                      </p>
                      {formatSource(item) && (
                        <p className="text-muted mt-0.5 text-[11px] break-all">
                          {formatSource(item)}
                          {item.lockedSha ? ` · ${item.lockedSha.slice(0, 12)}` : ""}
                        </p>
                      )}
                      {check?.status === "error" && check.message && (
                        <p className="text-warning mt-0.5 flex items-start gap-1 text-[11px]">
                          <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                          <span className="break-words">{check.message}</span>
                        </p>
                      )}
                    </div>

                    {item.managed && (
                      <div className="flex flex-wrap gap-1">
                        {item.present && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            disabled={busyPlugin !== null}
                            onClick={() => setComponentsTarget(item.name)}
                            aria-label={`Manage components for ${item.name}`}
                          >
                            Manage components
                          </Button>
                        )}
                        {updateAvailable && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => void handleUpdate(item.name)}
                            disabled={busyPlugin !== null}
                          >
                            {isBusy ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <ArrowDownToLine className="h-3 w-3" />
                            )}
                            Update
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted hover:text-destructive h-7 px-2 text-xs"
                          onClick={() =>
                            setUninstallTarget(uninstallTarget === item.name ? null : item.name)
                          }
                          disabled={busyPlugin !== null}
                          aria-label={`Uninstall ${item.name}`}
                        >
                          <Trash2 className="h-3 w-3" />
                          Uninstall
                        </Button>
                      </div>
                    )}
                  </div>

                  {/* Managed rows only: an unmanaged plugin in another
                      container can share the manifest name, and rendering the
                      confirmation under its row would visually attach a
                      backend uninstall of the MANAGED install to a read-only
                      unmanaged plugin. The backend uninstall is keyed by
                      managed-registry name, so the managed row is the one
                      identity-correct anchor. */}
                  {item.managed && item.present && componentsTarget === item.name && (
                    <ManageComponentsPanel
                      key={item.name}
                      name={item.name}
                      onSaved={refresh}
                      onClose={() => setComponentsTarget(null)}
                    />
                  )}
                  {item.managed && updateReview?.name === item.name && (
                    <UpdateReviewPanel
                      review={updateReview}
                      selective={item.importedComponents !== undefined}
                      busy={isBusy}
                      onConfirm={() => void handleConfirmUpdate(updateReview)}
                      onCancel={() => setUpdateReview(null)}
                    />
                  )}
                  {item.managed && uninstallTarget === item.name && (
                    <UninstallConfirm
                      item={item}
                      busy={isBusy}
                      onConfirm={(deletePluginData) =>
                        void handleUninstall(item.name, deletePluginData)
                      }
                      onCancel={() => setUninstallTarget(null)}
                    />
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
