import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "@/browser/contexts/RouterContext";

export interface OpenSettingsOptions {
  /** When opening the Providers settings, expand the given provider. */
  expandProvider?: string;
  /** When opening the Providers settings, start the Coder OAuth login. */
  startCoderLogin?: boolean;
  /** When opening the Runtimes settings, pre-select this project scope. */
  runtimesProjectPath?: string;
  /** When opening the Secrets settings, pre-select this project scope. */
  secretsProjectPath?: string;
  /** When opening the Instructions settings, pre-select this project. */
  instructionsProjectPath?: string;
}

interface SettingsContextValue {
  isOpen: boolean;
  activeSection: string;
  open: (section?: string, options?: OpenSettingsOptions) => void;
  close: () => void;
  setActiveSection: (section: string, options?: { replace?: boolean }) => void;

  /** Subscribe to settings close events. Returns an unsubscribe function. */
  registerOnClose: (callback: () => void) => () => void;

  /** One-shot hint for ProvidersSection to expand a provider. */
  providersExpandedProvider: string | null;
  setProvidersExpandedProvider: (provider: string | null) => void;

  /** One-shot hint for ProvidersSection to start the Coder OAuth login. */
  providersStartCoderLogin: boolean;
  setProvidersStartCoderLogin: (start: boolean) => void;

  /** One-shot hint for RuntimesSection to pre-select a project scope. */
  runtimesProjectPath: string | null;
  setRuntimesProjectPath: (path: string | null) => void;

  /** One-shot hint for SecretsSection to pre-select a project scope. */
  secretsProjectPath: string | null;
  setSecretsProjectPath: (path: string | null) => void;

  /** One-shot hint for InstructionsSection to pre-select a project. */
  instructionsProjectPath: string | null;
  setInstructionsProjectPath: (path: string | null) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}

const DEFAULT_SECTION = "general";

export function SettingsProvider(props: { children: ReactNode }) {
  const router = useRouter();
  const [providersExpandedProvider, setProvidersExpandedProvider] = useState<string | null>(null);
  const [providersStartCoderLogin, setProvidersStartCoderLogin] = useState(false);
  const [runtimesProjectPath, setRuntimesProjectPath] = useState<string | null>(null);
  const [secretsProjectPath, setSecretsProjectPath] = useState<string | null>(null);
  const [instructionsProjectPath, setInstructionsProjectPath] = useState<string | null>(null);

  const closeCallbacksRef = useRef(new Set<() => void>());

  const isOpen = router.currentSettingsSection != null;
  const activeSection = router.currentSettingsSection ?? DEFAULT_SECTION;

  const open = useCallback(
    (section?: string, options?: OpenSettingsOptions) => {
      const nextSection = section ?? DEFAULT_SECTION;
      if (nextSection === "providers") {
        setProvidersExpandedProvider(options?.expandProvider ?? null);
        setProvidersStartCoderLogin(options?.startCoderLogin ?? false);
      } else {
        setProvidersExpandedProvider(null);
        setProvidersStartCoderLogin(false);
      }
      if (nextSection === "runtimes") {
        setRuntimesProjectPath(options?.runtimesProjectPath ?? null);
      } else {
        setRuntimesProjectPath(null);
      }
      if (nextSection === "secrets") {
        setSecretsProjectPath(options?.secretsProjectPath ?? null);
      } else {
        setSecretsProjectPath(null);
      }
      if (nextSection === "instructions") {
        setInstructionsProjectPath(options?.instructionsProjectPath ?? null);
      } else {
        setInstructionsProjectPath(null);
      }
      router.navigateToSettings(nextSection);
    },
    [router]
  );

  const registerOnClose = useCallback((callback: () => void) => {
    closeCallbacksRef.current.add(callback);
    return () => {
      closeCallbacksRef.current.delete(callback);
    };
  }, []);

  // Fire close subscribers whenever settings transitions from open → closed,
  // regardless of how the navigation happened (explicit close, back button, etc.).
  const wasOpenRef = useRef(isOpen);
  useEffect(() => {
    if (wasOpenRef.current && !isOpen) {
      setProvidersExpandedProvider(null);
      setProvidersStartCoderLogin(false);
      setRuntimesProjectPath(null);
      setSecretsProjectPath(null);
      setInstructionsProjectPath(null);
      for (const callback of closeCallbacksRef.current) {
        callback();
      }
    }
    wasOpenRef.current = isOpen;
  }, [isOpen]);

  const close = useCallback(() => {
    setProvidersExpandedProvider(null);
    setProvidersStartCoderLogin(false);
    setRuntimesProjectPath(null);
    setSecretsProjectPath(null);
    setInstructionsProjectPath(null);
    router.navigateFromSettings();
  }, [router]);

  const setActiveSection = useCallback(
    (section: string, options?: { replace?: boolean }) => {
      if (section !== "providers") {
        setProvidersExpandedProvider(null);
        setProvidersStartCoderLogin(false);
      }
      if (section !== "runtimes") {
        // Runtime scope hints are one-shot and should not persist across section changes.
        setRuntimesProjectPath(null);
      }
      if (section !== "secrets") {
        setSecretsProjectPath(null);
      }
      if (section !== "instructions") {
        setInstructionsProjectPath(null);
      }
      router.navigateToSettings(section, options);
    },
    [router]
  );

  const value = useMemo<SettingsContextValue>(
    () => ({
      isOpen,
      activeSection,
      open,
      close,
      setActiveSection,
      registerOnClose,
      providersExpandedProvider,
      setProvidersExpandedProvider,
      providersStartCoderLogin,
      setProvidersStartCoderLogin,
      runtimesProjectPath,
      setRuntimesProjectPath,
      secretsProjectPath,
      setSecretsProjectPath,
      instructionsProjectPath,
      setInstructionsProjectPath,
    }),
    [
      isOpen,
      activeSection,
      open,
      close,
      setActiveSection,
      registerOnClose,
      providersExpandedProvider,
      providersStartCoderLogin,
      runtimesProjectPath,
      secretsProjectPath,
      instructionsProjectPath,
    ]
  );

  return <SettingsContext.Provider value={value}>{props.children}</SettingsContext.Provider>;
}
