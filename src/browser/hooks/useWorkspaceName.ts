import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { z } from "zod";
import { useAPI } from "@/browser/contexts/API";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { getWorkspaceNameStateKey } from "@/common/constants/storage";
import { NAME_GEN_PREFERRED_MODELS } from "@/common/constants/nameGeneration";
import type { NameGenerationError } from "@/common/types/errors";
import {
  validateWorkspaceBranchName,
  validateWorkspaceName,
} from "@/common/utils/validation/workspaceValidation";

/** Discriminated error type for workspace name operations */
export type WorkspaceNameUIError =
  | { kind: "generation"; error: NameGenerationError }
  | { kind: "validation"; message: string }
  | { kind: "transport"; message: string };

/**
 * Build ordered candidate list for name generation.
 * Gateway routing is resolved automatically by createModel on the backend,
 * so candidates are sent as canonical model IDs.
 */
function buildNameGenCandidates(userModel: string | undefined): string[] {
  const candidates: string[] = [...NAME_GEN_PREFERRED_MODELS];
  if (userModel && !candidates.includes(userModel)) {
    candidates.push(userModel);
  }
  return candidates;
}

function buildFallbackWorkspaceIdentity(message: string): WorkspaceIdentity {
  const normalized = message
    .trim()
    .replace(/^\/+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  const name = normalized && !validateWorkspaceName(normalized).error ? normalized : "workspace";
  return { name, title: name };
}

export interface UseWorkspaceNameOptions {
  /** The user's message to generate a name for */
  message: string;
  /** Debounce delay in milliseconds (default: 500) */
  debounceMs?: number;
  /** User's selected model to try after preferred models */
  userModel?: string;
  /** Apply the project account before the workspace exists. */
  projectPath?: string;
  /**
   * Optional storage scope for persisting draft name-generation state.
   *
   * When provided (e.g. a draft scopeId), each draft keeps its own auto-naming/manual name state so
   * switching between drafts doesn't share a single generator or manual-edit mode.
   */
  scopeId?: string | null;
}

/** Generated workspace identity (name + title) */
const WorkspaceIdentitySchema = z.object({
  /** Short git-safe name with suffix (e.g., "plan-a1b2") */
  name: z.string(),
  /** Human-readable title (e.g., "Fix plan mode over SSH") */
  title: z.string(),
});

export type WorkspaceIdentity = z.infer<typeof WorkspaceIdentitySchema>;

/** State and actions for workspace name generation, suitable for passing to components */
export interface WorkspaceNameState {
  /** The generated or manually entered name (shown in CreationControls UI) */
  name: string;
  /** The generated title (only available when auto-generation is enabled) */
  title: string | null;
  /** Whether name generation is in progress */
  isGenerating: boolean;
  /** Whether auto-generation is enabled */
  autoGenerate: boolean;
  /** Error state for generation/validation/transport failures */
  error: WorkspaceNameUIError | null;
  /** Set whether auto-generation is enabled */
  setAutoGenerate: (enabled: boolean) => void;
  /** Set manual name (for when auto-generate is off) */
  setName: (name: string) => void;
}

export interface UseWorkspaceNameReturn extends WorkspaceNameState {
  /** Wait for any pending generation to complete, returns both name and title */
  waitForGeneration: () => Promise<WorkspaceIdentity | null>;
}

const WorkspaceNamePersistedStateSchema = z.object({
  generatedIdentity: WorkspaceIdentitySchema.nullable(),
  manualName: z.string(),
  autoGenerate: z.boolean(),
  lastGeneratedFor: z.string(),
});

export type WorkspaceNamePersistedState = z.infer<typeof WorkspaceNamePersistedStateSchema>;

const DEFAULT_PERSISTED_STATE: WorkspaceNamePersistedState = {
  generatedIdentity: null,
  manualName: "",
  autoGenerate: true,
  lastGeneratedFor: "",
};

/**
 * Extract the display title from persisted workspace name state.
 * Used by DraftAgentListItem to show the title in the sidebar without
 * duplicating knowledge of the persisted state structure.
 *
 * For auto-generated identities, prefers title (human-readable) over name (git-safe branch name).
 * This matches how real workspaces display: metadata.title ?? metadata.name.
 */
export function getDisplayTitleFromPersistedState(state: unknown): string {
  const parsed = WorkspaceNamePersistedStateSchema.partial().safeParse(state);
  if (!parsed.success) {
    return "";
  }

  const { autoGenerate, generatedIdentity, manualName } = parsed.data;

  if (autoGenerate !== false) {
    if (!generatedIdentity) {
      return "";
    }
    // Prefer title (e.g., "Fix plan mode over SSH") over name (e.g., "plan-a1b2")
    return generatedIdentity.title.trim() || generatedIdentity.name;
  }

  return manualName ?? "";
}

/**
 * Hook for managing workspace name generation with debouncing.
 *
 * Automatically generates names as the user types their message,
 * but allows manual override. If the user clears the manual name,
 * auto-generation resumes.
 */
export function useWorkspaceName(options: UseWorkspaceNameOptions): UseWorkspaceNameReturn {
  const { message, debounceMs = 500, userModel, scopeId, projectPath } = options;
  const { api } = useAPI();
  const candidates = useMemo(() => buildNameGenCandidates(userModel), [userModel]);

  // Always call usePersistedState, but only *use* it when scopeId is provided.
  // This prevents draft switching from leaking name state across different creation drafts.
  const anonymousScopeIdRef = useRef(`__workspaceNameAnon__${Math.random().toString(36).slice(2)}`);
  const persistedKey = getWorkspaceNameStateKey(scopeId ?? anonymousScopeIdRef.current);

  const [persistedState, setPersistedState] = usePersistedState<WorkspaceNamePersistedState>(
    persistedKey,
    DEFAULT_PERSISTED_STATE,
    { listener: true }
  );
  const [localState, setLocalState] =
    useState<WorkspaceNamePersistedState>(DEFAULT_PERSISTED_STATE);

  const stored = scopeId ? persistedState : localState;
  const setStored = scopeId ? setPersistedState : setLocalState;

  const { generatedIdentity, manualName, autoGenerate, lastGeneratedFor } = stored;

  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<WorkspaceNameUIError | null>(null);

  // Debounce timer
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Message pending in debounce timer (captured at schedule time)
  const pendingMessageRef = useRef<string>("");
  // Generation request counter for cancellation
  const requestIdRef = useRef(0);
  // Current in-flight generation promise and its resolver
  const generationPromiseRef = useRef<{
    promise: Promise<WorkspaceIdentity | null>;
    resolve: (identity: WorkspaceIdentity | null) => void;
    requestId: number;
  } | null>(null);

  // Name shown in CreationControls UI: generated name when auto, manual when not
  const name = autoGenerate ? (generatedIdentity?.name ?? "") : manualName;
  // Title is only shown when auto-generation is enabled (manual mode doesn't have generated title)
  const title = autoGenerate ? (generatedIdentity?.title ?? null) : null;

  // Cancel any pending generation and resolve waiters with null
  const cancelPendingGeneration = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
      pendingMessageRef.current = "";
    }
    // Increment request ID to invalidate any in-flight request
    const oldRequestId = requestIdRef.current;
    requestIdRef.current++;
    // Resolve any waiters so they don't hang forever
    if (generationPromiseRef.current?.requestId === oldRequestId) {
      generationPromiseRef.current.resolve(null);
      generationPromiseRef.current = null;
      setIsGenerating(false);
    }
  }, []);

  // When switching between draft scopes, ensure the "in flight" generation UI doesn't leak.
  useEffect(() => {
    cancelPendingGeneration();
    setIsGenerating(false);
    setError(null);
  }, [persistedKey, cancelPendingGeneration]);

  const generateIdentity = useCallback(
    async (forMessage: string): Promise<WorkspaceIdentity | null> => {
      if (!api || !forMessage.trim()) {
        return null;
      }

      const requestId = ++requestIdRef.current;
      setIsGenerating(true);
      setError(null);

      // Create a promise that external callers can wait on
      let resolvePromise: ((identity: WorkspaceIdentity | null) => void) | undefined;
      const promise = new Promise<WorkspaceIdentity | null>((resolve) => {
        resolvePromise = resolve;
      });
      // TypeScript doesn't understand the Promise executor runs synchronously
      const safeResolve = resolvePromise!;
      generationPromiseRef.current = { promise, resolve: safeResolve, requestId };

      try {
        // Frontend sends canonical candidates; backend createModel resolves gateway routing.
        // Backend tries candidates in order with retry on API errors.
        const result = await api.nameGeneration.generate({
          message: forMessage,
          candidates,
          projectPath,
        });

        // Check if this request is still current (wasn't cancelled)
        if (requestId !== requestIdRef.current) {
          // Don't resolve here - cancellation already resolved the promise
          return null;
        }

        if (result.success) {
          const identity: WorkspaceIdentity = {
            name: result.data.name,
            title: result.data.title,
          };

          setStored((prev) => ({
            ...prev,
            generatedIdentity: identity,
            lastGeneratedFor: forMessage,
          }));

          safeResolve(identity);
          return identity;
        }

        const fallbackIdentity = buildFallbackWorkspaceIdentity(forMessage);
        setStored((prev) => ({
          ...prev,
          generatedIdentity: fallbackIdentity,
          lastGeneratedFor: forMessage,
        }));
        setError(null);
        safeResolve(fallbackIdentity);
        return fallbackIdentity;
      } catch {
        if (requestId !== requestIdRef.current) {
          return null;
        }
        const fallbackIdentity = buildFallbackWorkspaceIdentity(forMessage);
        setStored((prev) => ({
          ...prev,
          generatedIdentity: fallbackIdentity,
          lastGeneratedFor: forMessage,
        }));
        setError(null);
        safeResolve(fallbackIdentity);
        return fallbackIdentity;
      } finally {
        if (requestId === requestIdRef.current) {
          setIsGenerating(false);
          generationPromiseRef.current = null;
        }
      }
    },
    [api, setStored, candidates, projectPath]
  );

  // Debounced generation effect
  useEffect(() => {
    // Don't generate if:
    // - Auto-generation is disabled
    // - Message is empty
    // - Already generated for this message
    if (!autoGenerate || !message.trim() || lastGeneratedFor === message) {
      // Clear any pending timer since conditions changed
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
        pendingMessageRef.current = "";
      }
      return;
    }

    // Cancel any in-flight request since message changed
    cancelPendingGeneration();

    // Capture message for the debounced callback (avoid stale closure)
    pendingMessageRef.current = message;

    // Debounce the generation
    debounceTimerRef.current = setTimeout(() => {
      const msg = pendingMessageRef.current;
      debounceTimerRef.current = null;
      pendingMessageRef.current = "";
      void generateIdentity(msg);
    }, debounceMs);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
        pendingMessageRef.current = "";
      }
    };
  }, [
    message,
    autoGenerate,
    lastGeneratedFor,
    debounceMs,
    generateIdentity,
    cancelPendingGeneration,
  ]);

  // When auto-generate is toggled, handle name preservation
  const handleSetAutoGenerate = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        // Switching to auto: reset so debounced generation will trigger
        setStored((prev) => ({ ...prev, autoGenerate: true, lastGeneratedFor: "" }));
        setError(null);
        return;
      }

      // Switching to manual: copy generated name as starting point for editing
      setStored((prev) => ({
        ...prev,
        autoGenerate: false,
        manualName: prev.generatedIdentity?.name ?? prev.manualName,
      }));
    },
    [setStored]
  );

  const setNameManual = useCallback(
    (newName: string) => {
      setStored((prev) => ({ ...prev, manualName: newName }));
      // Validate in real-time as user types (skip empty - will show on submit)
      if (newName.trim()) {
        const validation = validateWorkspaceBranchName(newName);
        setError(validation.error ? { kind: "validation", message: validation.error } : null);
      } else {
        setError(null);
      }
    },
    [setStored]
  );

  const waitForGeneration = useCallback(async (): Promise<WorkspaceIdentity | null> => {
    // If auto-generate is off, user has provided a manual name
    // Use that name directly with a generated title from the message
    if (!autoGenerate) {
      if (!manualName.trim()) {
        setError({ kind: "validation", message: "Please enter a workspace name" });
        return null;
      }
      // Manual name provided — skip LLM call entirely.
      // The manual name doubles as the display title; users who type a custom
      // name expect to see exactly that in the sidebar.
      return { name: manualName.trim(), title: manualName.trim() };
    }

    // Always wait for generation to complete on the full message.
    // With voice input, the message can go from empty to complete very quickly,
    // so we must ensure the generated identity reflects the total content.

    // If there's a debounced generation pending, trigger it immediately
    // Use the captured message from pendingMessageRef to avoid stale closures
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
      const msg = pendingMessageRef.current;
      pendingMessageRef.current = "";
      if (msg.trim()) {
        return generateIdentity(msg);
      }
    }

    // If generation is in progress, wait for it to complete
    if (generationPromiseRef.current) {
      return generationPromiseRef.current.promise;
    }

    // If we have an identity that was generated for the current message, use it
    if (generatedIdentity && lastGeneratedFor === message) {
      return generatedIdentity;
    }

    // Otherwise generate a fresh identity for the current message
    if (message.trim()) {
      return generateIdentity(message);
    }

    return null;
  }, [autoGenerate, manualName, generatedIdentity, lastGeneratedFor, message, generateIdentity]);

  return useMemo(
    () => ({
      name,
      title,
      isGenerating,
      autoGenerate,
      error,
      setAutoGenerate: handleSetAutoGenerate,
      setName: setNameManual,
      waitForGeneration,
    }),
    [
      name,
      title,
      isGenerating,
      autoGenerate,
      error,
      handleSetAutoGenerate,
      setNameManual,
      waitForGeneration,
    ]
  );
}
