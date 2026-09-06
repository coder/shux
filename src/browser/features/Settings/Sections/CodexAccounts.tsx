import { useEffect, useRef, useState, type Ref } from "react";
import { useSettings, type CodexAccountSettingsIntent } from "@/browser/contexts/SettingsContext";
import { Loader2 } from "lucide-react";
import { formatCodexAccountLabel } from "@/browser/utils/codexAccountDisplay";
import { Button } from "@/browser/components/Button/Button";
import { useAPI, type APIClient } from "@/browser/contexts/API";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import type { ProviderConfigInfo } from "@/common/orpc/types";
import type { Result } from "@/common/types/result";
import { getErrorMessage } from "@/common/utils/errors";
import {
  CODEX_OAUTH_DEFAULT_ACCOUNT_ID,
  CODEX_OAUTH_ACCOUNT_LABEL_MAX_LENGTH,
} from "@/common/constants/codexOauthAccounts";

type LoginInput = Parameters<APIClient["codexOauth"]["startDeviceFlow"]>[0];
type Account = NonNullable<ProviderConfigInfo["codexOauthAccounts"]>[number];
interface LoginFlow {
  flowId: string;
  url: string;
  userCode?: string;
  cancel: () => Promise<void>;
}

const legacyAccounts: Account[] = [{ id: CODEX_OAUTH_DEFAULT_ACCOUNT_ID, label: "Default" }];
const noAccounts: Account[] = [];

const inputClassName =
  "bg-background border-border-light text-foreground w-full min-w-0 rounded border px-2 py-1.5 text-xs";

function accountSelectionLabel(account: Account, accounts: readonly Account[]): string {
  const label = formatCodexAccountLabel(account, accounts);
  return account.reconnectRequired ? label + " (Reconnect required)" : label;
}

function AccountSelect(props: {
  label: string;
  value: string;
  accounts: Account[];
  defaultLabel?: string;
  selectRef?: Ref<HTMLSelectElement>;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  // Keep missing selections visible. Selecting another account must require a user action.
  const missing =
    props.value !== "" && !props.accounts.some((account) => account.id === props.value);
  return (
    <label className="text-muted block min-w-0 space-y-1 text-xs">
      <span className="block break-words">{props.label}</span>
      <select
        ref={props.selectRef}
        aria-label={props.label}
        className={inputClassName}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {props.defaultLabel != null && (
          <option value="">Inherit global default ({props.defaultLabel})</option>
        )}
        {missing && <option value={props.value}>Missing account ({props.value})</option>}
        {/* Disabled options preserve stored selections without offering rejected credentials. */}
        {props.accounts.map((account) => (
          <option key={account.id} value={account.id} disabled={account.reconnectRequired}>
            {accountSelectionLabel(account, props.accounts)}
          </option>
        ))}
      </select>
      {missing && (
        <span className="text-warning block">
          The selected account is missing. Select a connected account.
        </span>
      )}
    </label>
  );
}

export function CodexAccounts() {
  const { api } = useAPI();
  const { config, loading, refresh } = useProvidersConfig();
  const { codexAccountAction, setCodexAccountAction } = useSettings();
  const { userProjects, refreshProjects } = useProjectContext();
  const [label, setLabel] = useState("");
  const [rename, setRename] = useState<Account | null>(null);
  const [busy, setBusy] = useState(false);
  const [loginInProgress, setLoginInProgress] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flow, setFlow] = useState<LoginFlow | null>(null);
  const newNameRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const defaultSelectRef = useRef<HTMLSelectElement>(null);
  const projectSelectRefs = useRef(new Map<string, HTMLSelectElement>());
  const consumedActionRef = useRef<CodexAccountSettingsIntent | null>(null);
  const mountedRef = useRef(false);
  const attemptRef = useRef(0);
  const flowRef = useRef<LoginFlow | null>(null);
  const openai = config?.openai;
  const accounts: Account[] =
    openai?.codexOauthAccounts ?? (openai?.codexOauthSet ? legacyAccounts : noAccounts);
  const defaultId = openai?.codexOauthDefaultAccountId ?? CODEX_OAUTH_DEFAULT_ACCOUNT_ID;
  const defaultAccount = accounts.find((account) => account.id === defaultId);
  const defaultLabel = defaultAccount
    ? accountSelectionLabel(defaultAccount, accounts)
    : `Missing account (${defaultId})`;
  const isDesktop = !!window.api;
  const showBrowser =
    isDesktop || ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  const disabled = !api || busy;
  // Keep API-key recovery available after the selected OAuth account disconnects.
  const authEditable = openai?.apiKeySet === true || !!openai?.apiKeySource;

  // StrictMode replays mount effects before a pending login start can return.
  // Keep that start valid. A real unmount cancels its result when it arrives.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (flowRef.current) {
        attemptRef.current += 1;
        flowRef.current.cancel().catch(() => undefined);
      }
    };
  }, []);

  function runAction(operation: Promise<unknown>): void {
    operation.catch((err: unknown) => setError(getErrorMessage(err)));
  }

  /* eslint-disable react-hooks/exhaustive-deps -- React Compiler owns callback memoization. Keep the intent effect dependencies explicit. */
  function startRename(account: Account) {
    if (rename?.id === account.id) {
      renameRef.current?.focus();
      return;
    }
    setRename(account);
  }

  async function saveName() {
    if (!api || !rename) return;
    const input = { accountId: rename.id, label: rename.label.trim() };
    if (await mutate(() => api.codexOauth.renameAccount(input))) setRename(null);
  }

  async function refreshState() {
    await Promise.all([refresh(), refreshProjects()]);
  }

  async function mutate(operation: () => Promise<Result<void, string>>) {
    setBusy(true);
    setError(null);
    try {
      const result = await operation();
      if (!result.success) {
        setError(result.error);
        return false;
      }
      await refreshState();
      return true;
    } catch (err) {
      setError(getErrorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function disconnect(accountId: string) {
    if (!api) return;
    runAction(mutate(() => api.codexOauth.disconnect({ accountId })));
  }

  async function connect(device: boolean, input: LoginInput) {
    if (!api) return;
    const attempt = ++attemptRef.current;
    const isCurrent = () => mountedRef.current && attempt === attemptRef.current;
    setLoginInProgress(true);
    setBusy(true);
    setError(null);
    try {
      let nextFlow: LoginFlow;
      if (device || !showBrowser) {
        const result = await api.codexOauth.startDeviceFlow(input);
        if (!result.success) throw new Error(result.error);
        const { flowId, userCode, verifyUrl } = result.data;
        nextFlow = {
          flowId,
          userCode,
          url: verifyUrl,
          cancel: () => api.codexOauth.cancelDeviceFlow({ flowId }),
        };
      } else {
        const result = await api.codexOauth.startDesktopFlow(input);
        if (!result.success) throw new Error(result.error);
        const { flowId, authorizeUrl } = result.data;
        nextFlow = {
          flowId,
          url: authorizeUrl,
          cancel: () => api.codexOauth.cancelDesktopFlow({ flowId }),
        };
      }
      if (!isCurrent()) {
        await nextFlow.cancel();
        return;
      }
      flowRef.current = nextFlow;
      setFlow(nextFlow);
      const result =
        nextFlow.userCode != null
          ? await api.codexOauth.waitForDeviceFlow({ flowId: nextFlow.flowId })
          : await api.codexOauth.waitForDesktopFlow({ flowId: nextFlow.flowId });
      if (!isCurrent()) return;
      if (!result.success) throw new Error(result.error);
      setLabel("");
      await refreshState();
    } catch (err) {
      if (isCurrent()) setError(getErrorMessage(err));
    } finally {
      if (isCurrent()) {
        flowRef.current = null;
        setFlow(null);
        setLoginInProgress(false);
        setBusy(false);
      }
    }
  }

  /* eslint-enable react-hooks/exhaustive-deps */

  async function cancel() {
    attemptRef.current++;
    try {
      await flowRef.current?.cancel();
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      flowRef.current = null;
      setFlow(null);
      setLoginInProgress(false);
      setBusy(false);
    }
  }

  // Commands must reach the same controls and handlers after Settings mounts.
  // Consume each intent before starting work. Busy commands must not run later.
  useEffect(() => {
    const action = codexAccountAction;
    if (!action || loading || consumedActionRef.current === action) return;
    consumedActionRef.current = action;
    setCodexAccountAction((current) => (current === action ? null : current));
    if (disabled) {
      setError(busy ? "An account operation is in progress. Try again." : "API unavailable.");
      return;
    }
    setError(null);
    switch (action.type) {
      case "add":
        newNameRef.current?.focus();
        break;
      case "default":
        if (accounts.length === 0) {
          setError("No Codex accounts are available. Add an account first.");
          return;
        }
        defaultSelectRef.current?.focus();
        break;
      case "project": {
        const select = projectSelectRefs.current.get(action.projectPath);
        if (!select) {
          setError("The project is no longer available. Select another project.");
          return;
        }
        select.focus();
        break;
      }
      default: {
        const account = accounts.find((item) => item.id === action.accountId);
        if (!account) {
          setError("The account is no longer available. Select another account.");
          return;
        }
        if (action.type === "rename") startRename(account);
        else if (action.type === "reconnect") runAction(connect(false, { accountId: account.id }));
        else disconnect(account.id);
      }
    }
  }, [
    codexAccountAction,
    loading,
    setCodexAccountAction,
    disabled,
    busy,
    accounts,
    startRename,
    connect,
    disconnect,
  ]);

  const loginInput = label.trim() ? { label: label.trim() } : undefined;
  return (
    <section aria-label="ChatGPT (Codex) accounts" className="min-w-0 space-y-3">
      <div>
        <h4 className="text-foreground text-xs font-medium">ChatGPT (Codex) OAuth</h4>
        <p className="text-muted text-xs">
          {accounts.some((account) => account.reconnectRequired)
            ? "Reconnect required"
            : openai?.codexOauthSet
              ? "Connected"
              : "Not connected"}
        </p>
      </div>
      <ul className="space-y-2">
        {accounts.map((account) => (
          <li
            key={account.id}
            aria-label={formatCodexAccountLabel(account, accounts)}
            className="border-border-light min-w-0 space-y-2 rounded border p-2"
          >
            {rename?.id === account.id ? (
              <form
                className="flex flex-wrap gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  runAction(saveName());
                }}
              >
                <input
                  autoFocus
                  ref={renameRef}
                  aria-label="Account name"
                  maxLength={CODEX_OAUTH_ACCOUNT_LABEL_MAX_LENGTH}
                  className={inputClassName}
                  value={rename.label}
                  onChange={(event) => setRename({ ...account, label: event.target.value })}
                />
                <Button type="submit" size="sm" disabled={disabled || !rename.label.trim()}>
                  Save name
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => setRename(null)}
                >
                  Cancel rename
                </Button>
              </form>
            ) : (
              <>
                <p className="text-foreground text-xs font-medium break-words">
                  {formatCodexAccountLabel(account, accounts)}
                  {account.id === defaultId && (
                    <span className="text-muted font-normal"> · Global default</span>
                  )}
                </p>
                {account.reconnectRequired && (
                  <p className="text-warning text-xs">Reconnect required</p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={disabled}
                    onClick={() => runAction(connect(false, { accountId: account.id }))}
                  >
                    Reconnect
                  </Button>
                  {showBrowser && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={disabled}
                      onClick={() => runAction(connect(true, { accountId: account.id }))}
                    >
                      Reconnect (Device)
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => startRename(account)}
                  >
                    Rename
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => disconnect(account.id)}
                  >
                    Disconnect
                  </Button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          runAction(connect(false, loginInput));
        }}
      >
        <label className="text-muted block space-y-1 text-xs">
          <span>Add account</span>
          <input
            ref={newNameRef}
            aria-label="New account name"
            maxLength={CODEX_OAUTH_ACCOUNT_LABEL_MAX_LENGTH}
            className={inputClassName}
            placeholder="Account name"
            value={label}
            disabled={disabled}
            onChange={(event) => setLabel(event.target.value)}
            required={accounts.length > 0}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          {showBrowser && (
            <Button
              type="submit"
              size="sm"
              disabled={disabled || (accounts.length > 0 && !label.trim())}
            >
              Connect (Browser)
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={disabled || (accounts.length > 0 && !label.trim())}
            onClick={() => runAction(connect(true, loginInput))}
          >
            Connect (Device)
          </Button>
        </div>
      </form>
      {busy && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
          <span>
            {flow ? "Waiting for authorization..." : loginInProgress ? "Starting..." : "Saving..."}
          </span>
          {loginInProgress && (
            <Button size="sm" variant="secondary" onClick={() => runAction(cancel())}>
              Cancel
            </Button>
          )}
        </div>
      )}
      {flow && (
        <div className="bg-background-tertiary space-y-2 rounded p-3">
          {flow.userCode && (
            <>
              <p className="text-muted text-xs">Enter this code on the OpenAI verification page:</p>
              <code className="text-foreground text-lg font-bold tracking-widest break-all">
                {flow.userCode}
              </code>
            </>
          )}
          <Button
            size="sm"
            onClick={() => {
              // Device login opens only after this explicit user action.
              window.open(flow.url, "_blank", "noopener");
              runAction(navigator.clipboard.writeText(flow.userCode ?? flow.url));
            }}
          >
            Copy &amp; Open OpenAI
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive text-xs break-words">
          {error}
        </p>
      )}
      <AccountSelect
        label="Global default account"
        selectRef={defaultSelectRef}
        value={defaultId}
        accounts={accounts}
        disabled={disabled || accounts.length === 0}
        onChange={(accountId) =>
          api && runAction(mutate(() => api.codexOauth.setDefaultAccount({ accountId })))
        }
      />
      <div className="border-border-light space-y-2 border-t pt-3">
        <h4 className="text-foreground text-xs font-medium">Project accounts</h4>
        <p className="text-muted text-xs">
          Project selections override the global default. Missing accounts do not use another
          account.
        </p>
        {Array.from(userProjects, ([projectPath, project]) => (
          <AccountSelect
            key={projectPath}
            selectRef={(select) => {
              if (select) projectSelectRefs.current.set(projectPath, select);
              else projectSelectRefs.current.delete(projectPath);
            }}
            label={project.displayName ?? projectPath}
            value={project.codexOauthAccountId ?? ""}
            accounts={accounts}
            defaultLabel={defaultLabel}
            disabled={disabled}
            onChange={(accountId) =>
              api &&
              runAction(
                mutate(() =>
                  api.projects.setCodexOauthAccount({ projectPath, accountId: accountId || null })
                )
              )
            }
          />
        ))}
      </div>
      <label className="text-muted block space-y-1 text-xs">
        <span>Default auth (when both are set)</span>
        <select
          aria-label="Default auth (when both are set)"
          className={inputClassName}
          value={openai?.codexOauthDefaultAuth ?? "oauth"}
          disabled={disabled || !authEditable}
          onChange={(event) => {
            const value = event.target.value;
            return (
              api &&
              runAction(
                mutate(() =>
                  api.providers.setProviderConfig({
                    provider: "openai",
                    keyPath: ["codexOauthDefaultAuth"],
                    value,
                  })
                )
              )
            );
          }}
        >
          <option value="oauth" disabled={!openai?.codexOauthSet}>
            Use ChatGPT OAuth by default
          </option>
          <option value="apiKey">Use OpenAI API key by default</option>
        </select>
      </label>
      <p className="text-muted text-xs">
        ChatGPT OAuth costs use API-equivalent estimates. Your plan may include usage or charge
        credits. API keys use OpenAI platform billing.
      </p>
      {!authEditable && (
        <p className="text-muted text-xs">Set an OpenAI API key to change this setting.</p>
      )}
    </section>
  );
}
