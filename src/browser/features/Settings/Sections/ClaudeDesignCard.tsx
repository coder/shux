import { useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { Button } from "@/browser/components/Button/Button";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { CLAUDE_DESIGN_SERVER_NAME } from "@/common/constants/claudeDesign";
import type {
  ClaudeDesignSettings,
  ClaudeDesignState,
  ClaudeDesignStatus,
} from "@/common/orpc/schemas/claudeDesign";

const messages: Record<ClaudeDesignState, string> = {
  disabled: "Credential reuse is disabled.",
  not_configured: "Choose a credential source, then connect.",
  credentials_unavailable:
    "Credentials could not be read. Check the selected source and its permissions on the backend host.",
  credentials_invalid: "The selected credentials are malformed or have unknown expiry information.",
  expired:
    "Credentials have expired. Refresh your Design session in Claude Code on the backend host, then retry.",
  missing_scopes:
    "Both user:design:read and user:design:write are required. Complete Design setup in Claude Code, then retry.",
  consent_required:
    "Design requires consent. Resolve it in Claude Code on the backend host, then retry. Mux does not grant consent.",
  authorization_failed:
    "Design rejected these credentials. Complete Design setup in Claude Code, then retry.",
  connection_failed:
    "Design could not connect. Check your connection and Claude Code setup, then retry.",
  connected: "Connection tested successfully.",
};

export function ClaudeDesignCard(props: {
  onChange: () => Promise<void>;
  conflict: boolean;
  remoteDisabled: boolean;
}) {
  const { api } = useAPI();
  const [status, setStatus] = useState<ClaudeDesignStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api?.mcp
      .designStatus()
      .then((value) => {
        if (!cancelled) setStatus(value);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load Claude Design settings.");
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function save(settings: ClaudeDesignSettings, test: boolean) {
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Only announce credential intent: the backend owns server enablement/allowlists,
      // which may have changed elsewhere since this card loaded.
      setStatus(
        await api.mcp.configureDesign({
          reuseEnabled: settings.reuseEnabled,
          ...(settings.reuseEnabled ? { source: settings.source } : {}),
        })
      );
      if (test) {
        const result = await api.mcp.test({ name: CLAUDE_DESIGN_SERVER_NAME });
        if (!result.success) setError(result.error);
        setStatus(await api.mcp.designStatus());
      }
      await props.onChange();
    } catch {
      setError(
        "Could not update Claude Design. Check the backend connection and experiment setting."
      );
    } finally {
      setBusy(false);
    }
  }

  const blocked = busy || props.conflict || props.remoteDisabled;
  return (
    <section
      aria-label="Claude Design"
      className="border-border-medium bg-background-secondary min-w-0 space-y-3 rounded-md border p-3 text-xs"
    >
      <h3 className="text-foreground text-sm font-medium">Claude Design</h3>
      <p className="text-muted">
        Reuse Claude Code credentials read-only. Claude Code owns login, consent, refresh, and
        revocation. Disconnecting here leaves your Claude login intact.
      </p>
      {status && (
        <p className="text-muted break-words">
          Credential host: {status.backendHost} ({status.platform}). HTTP requests run here,
          including for SSH/container workspaces.
        </p>
      )}
      {props.conflict && (
        <p role="alert">
          A server named claude_design already exists. Rename or remove that entry before using this
          integration.
        </p>
      )}
      {props.remoteDisabled && <p role="alert">HTTP MCP is disabled by policy.</p>}
      {status && (
        <ClaudeDesignForm
          key={JSON.stringify(status.settings)}
          status={status}
          blocked={blocked}
          save={save}
        />
      )}
      {error && (
        <p role="alert" className="text-destructive break-words">
          {error}
        </p>
      )}
    </section>
  );
}

function ClaudeDesignForm(props: {
  status: ClaudeDesignStatus;
  blocked: boolean;
  save: (settings: ClaudeDesignSettings, test: boolean) => Promise<void>;
}) {
  const [source, setSource] = useState(
    props.status.settings.source ?? { type: "file" as const, path: "" }
  );
  const inputClass = "bg-modal-bg border-border-medium w-full min-w-0 rounded border px-2 py-1.5";
  const canConnect =
    !props.blocked &&
    (source.type === "file" ? source.path.trim() : source.service.trim() && source.account.trim());
  async function connect() {
    if (canConnect)
      await props.save({ ...props.status.settings, source, reuseEnabled: true }, true);
  }
  return (
    <form
      className="min-w-0 space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        connect().catch(() => undefined);
      }}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          stopKeyboardPropagation(event);
          event.preventDefault();
          connect().catch(() => undefined);
        }
        if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "d") {
          stopKeyboardPropagation(event);
          event.preventDefault();
          if (!props.blocked)
            props
              .save({ ...props.status.settings, reuseEnabled: false, serverEnabled: false }, false)
              .catch(() => undefined);
        }
      }}
    >
      <label className="block space-y-1">
        Credential source
        <select
          className={inputClass}
          value={source.type}
          disabled={props.blocked}
          onChange={(event) =>
            setSource(
              event.target.value === "keychain"
                ? { type: "keychain", service: "Claude Code-credentials", account: "" }
                : { type: "file", path: "" }
            )
          }
        >
          <option value="file">Credential file on backend host</option>
          {props.status.platform === "darwin" && <option value="keychain">macOS Keychain</option>}
        </select>
      </label>
      {source.type === "file" ? (
        <label className="block space-y-1">
          Absolute credential file path
          <input
            className={inputClass}
            value={source.path}
            disabled={props.blocked}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setSource({ ...source, path: event.target.value })}
          />
        </label>
      ) : (
        <>
          <label className="block space-y-1">
            Keychain service
            <input
              className={inputClass}
              value={source.service}
              disabled={props.blocked}
              onChange={(event) => setSource({ ...source, service: event.target.value })}
            />
          </label>
          <label className="block space-y-1">
            Keychain account (OS username)
            <input
              className={inputClass}
              value={source.account}
              disabled={props.blocked}
              autoComplete="off"
              onChange={(event) => setSource({ ...source, account: event.target.value })}
            />
          </label>
          <p className="text-muted">
            Confirm the service/account for your Claude configuration. Access fails without
            prompting if Keychain permission is unavailable.
          </p>
        </>
      )}
      <p role="status" className="break-words">
        {messages[props.status.state]}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={!canConnect}
          className="h-auto py-2 whitespace-normal"
        >
          {props.status.settings.reuseEnabled ? "Retry connection" : "Use Claude Code credentials"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={props.blocked || !props.status.settings.reuseEnabled}
          onClick={() => {
            props
              .save({ ...props.status.settings, reuseEnabled: false, serverEnabled: false }, false)
              .catch(() => undefined);
          }}
        >
          Disconnect
        </Button>
      </div>
      <p className="text-muted hidden sm:block">
        Connect: Ctrl/Cmd+Enter · Disconnect: Ctrl/Cmd+Shift+D
      </p>
      <p className="text-muted">
        After connecting, enable claude_design in MCP Servers or for a workspace to expose its
        tools. No tokens are copied into Mux.
      </p>
    </form>
  );
}
