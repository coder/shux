/**
 * Memory route operations (Memory tab + Settings → Memory).
 *
 * Internals are Effect-native: each operation is an `Effect.gen` pipeline
 * (the `*Effect` exports) that the router runs via `handlerGen`; a thin
 * `Effect.runPromise` facade keeps the Promise signatures for pre-Effect
 * callers. Failures the client renders (workspace not found, scope
 * unavailable, path errors) stay in the success channel as the wire
 * `{ success: false }` unions. The Effect error channel carries only typed
 * domain errors a caller can branch on (`MemoryWorkspaceNotFoundError`,
 * `MemoryMetaWriteError`), and every operation handles them before the
 * effect reaches the router, so the exported effects never fail.
 */
import { ORPCError } from "@orpc/server";
import { Effect, Result, Schema } from "effect";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type * as schemas from "@/common/orpc/schemas";
import { getErrorMessage } from "@/common/utils/errors";
import { createRuntimeForWorkspace } from "@/node/runtime/runtimeHelpers";
import type { ORPCContext } from "@/node/orpc/context";
import {
  parseMemoryPath,
  resolveMemoryProjectIdentity,
  type MemoryScopeContext,
} from "./memoryService";
import { memoryLogicalKey } from "./memoryMeta";

type MemoryContext = Pick<
  ORPCContext,
  | "experimentsService"
  | "workspaceService"
  | "memoryService"
  | "memoryMetaService"
  | "memoryConsolidationService"
>;
type Input<T extends { input: unknown }> = T["input"] extends { _input: infer I } ? I : never;

export function assertMemoryEnabled(context: MemoryContext): void {
  if (!context.experimentsService.isExperimentEnabled(EXPERIMENT_IDS.MEMORY)) {
    throw new ORPCError("BAD_REQUEST", { message: "Agent memory is disabled" });
  }
}

/**
 * Typed failure: the request named a workspaceId that no longer resolves to a
 * live workspace. Operations branch on the tag to map it onto their route's
 * `{ success: false }` union (plain string vs MemorySaveError shape).
 */
export class MemoryWorkspaceNotFoundError extends Schema.TaggedError<MemoryWorkspaceNotFoundError>()(
  "MemoryWorkspaceNotFoundError",
  { workspaceId: Schema.NullOr(Schema.String) }
) {}

function workspaceNotFound(workspaceId: string | null | undefined): string {
  return "Workspace not found: " + (workspaceId ?? "<none>");
}

interface ResolvedMemoryScope {
  projectPath: string;
  scopeCtx: MemoryScopeContext;
}

/**
 * Resolve the scope context that maps virtual /memories paths onto physical
 * roots. A null/undefined workspaceId is the Settings → Memory case (global
 * scope only), not an error; an unknown workspaceId is the typed failure.
 */
function resolveMemoryScope(
  context: MemoryContext,
  workspaceId: string | null | undefined
): Effect.Effect<ResolvedMemoryScope, MemoryWorkspaceNotFoundError> {
  return Effect.gen(function* () {
    if (workspaceId == null)
      return {
        projectPath: "",
        scopeCtx: { runtime: null, checkoutCwd: "", workspaceId: "", projectPath: "" },
      };
    const metadata = yield* Effect.promise(() => context.workspaceService.getInfo(workspaceId));
    if (!metadata) return yield* Effect.fail(new MemoryWorkspaceNotFoundError({ workspaceId }));
    const projectPath = resolveMemoryProjectIdentity(metadata);
    return {
      projectPath,
      scopeCtx: {
        runtime: createRuntimeForWorkspace(metadata),
        checkoutCwd: "",
        workspaceId,
        projectPath,
      },
    };
  });
}

/** Map the typed workspace failure onto the routes' plain string error union. */
const workspaceNotFoundAsStringError = (error: MemoryWorkspaceNotFoundError) =>
  Effect.succeed({ success: false as const, error: workspaceNotFound(error.workspaceId) });

export function listMemoryEffect(context: MemoryContext, input: Input<typeof schemas.memory.list>) {
  return Effect.gen(function* () {
    assertMemoryEnabled(context);
    const resolved = yield* resolveMemoryScope(context, input.workspaceId);
    const entries = yield* Effect.promise(() =>
      context.memoryService.listIndexEntries(resolved.scopeCtx)
    );
    const meta = yield* context.memoryMetaService.effects.getEntries();
    const ids = { projectPath: resolved.projectPath, workspaceId: input.workspaceId ?? "" };
    return {
      success: true as const,
      data: {
        files: entries.map((entry) => {
          const stats = meta.get(memoryLogicalKey(entry.scope, entry.relPath, ids));
          return {
            path: entry.path,
            scope: entry.scope,
            description: entry.description,
            pinned: stats?.pinned ?? false,
            accessCount: stats?.accessCount ?? 0,
            lastAccessedAt: stats?.lastAccessedAt ?? null,
          };
        }),
      },
    };
  }).pipe(Effect.catchTag("MemoryWorkspaceNotFoundError", workspaceNotFoundAsStringError));
}

/** Promise facade over {@link listMemoryEffect} for pre-Effect callers. */
export async function listMemory(context: MemoryContext, input: Input<typeof schemas.memory.list>) {
  return Effect.runPromise(listMemoryEffect(context, input));
}

export function readMemoryEffect(context: MemoryContext, input: Input<typeof schemas.memory.read>) {
  return Effect.gen(function* () {
    assertMemoryEnabled(context);
    const resolved = yield* resolveMemoryScope(context, input.workspaceId);
    return yield* Effect.promise(() =>
      context.memoryService.readFileWithSha(resolved.scopeCtx, input.path)
    );
  }).pipe(Effect.catchTag("MemoryWorkspaceNotFoundError", workspaceNotFoundAsStringError));
}

/** Promise facade over {@link readMemoryEffect} for pre-Effect callers. */
export async function readMemory(context: MemoryContext, input: Input<typeof schemas.memory.read>) {
  return Effect.runPromise(readMemoryEffect(context, input));
}

export function saveMemoryEffect(context: MemoryContext, input: Input<typeof schemas.memory.save>) {
  return Effect.gen(function* () {
    assertMemoryEnabled(context);
    const resolved = yield* resolveMemoryScope(context, input.workspaceId);
    return yield* Effect.promise(() =>
      context.memoryService.saveFile(
        resolved.scopeCtx,
        input.path,
        input.content,
        input.expectedSha256,
        "user"
      )
    );
  }).pipe(
    // save's wire error is MemorySaveError, not a plain string.
    Effect.catchTag("MemoryWorkspaceNotFoundError", (error) =>
      Effect.succeed({
        success: false as const,
        error: { kind: "error" as const, message: workspaceNotFound(error.workspaceId) },
      })
    )
  );
}

/** Promise facade over {@link saveMemoryEffect} for pre-Effect callers. */
export async function saveMemory(context: MemoryContext, input: Input<typeof schemas.memory.save>) {
  return Effect.runPromise(saveMemoryEffect(context, input));
}

export function deleteMemoryEffect(
  context: MemoryContext,
  input: Input<typeof schemas.memory.delete>
) {
  return Effect.gen(function* () {
    assertMemoryEnabled(context);
    const resolved = yield* resolveMemoryScope(context, input.workspaceId);
    const result = yield* Effect.promise(() =>
      context.memoryService.deletePath(resolved.scopeCtx, input.path, "user")
    );
    return result.success
      ? { success: true as const, data: undefined }
      : { success: false as const, error: result.error };
  }).pipe(Effect.catchTag("MemoryWorkspaceNotFoundError", workspaceNotFoundAsStringError));
}

/** Promise facade over {@link deleteMemoryEffect} for pre-Effect callers. */
export async function deleteMemory(
  context: MemoryContext,
  input: Input<typeof schemas.memory.delete>
) {
  return Effect.runPromise(deleteMemoryEffect(context, input));
}

export function setMemoryPinnedEffect(
  context: MemoryContext,
  input: Input<typeof schemas.memory.setPinned>
): Effect.Effect<{ success: true; data: undefined } | { success: false; error: string }> {
  return Effect.gen(function* () {
    // Sync ORPCError throw stays a runtime defect and reaches the client as
    // the same BAD_REQUEST it does today from async handlers.
    assertMemoryEnabled(context);
    const resolved = yield* resolveMemoryScope(context, input.workspaceId);
    const parsedResult = yield* Effect.result(
      Effect.try({
        try: () => parseMemoryPath(input.path),
        catch: (error) => getErrorMessage(error),
      })
    );
    if (Result.isFailure(parsedResult))
      return { success: false as const, error: parsedResult.failure };
    const { scope, relPath } = parsedResult.success;
    if (scope === null || relPath === "")
      return { success: false as const, error: "Cannot pin a directory: " + input.path };
    if (input.workspaceId == null && scope !== "global")
      return {
        success: false as const,
        error:
          (scope === "project" ? "Project" : "Workspace") +
          " memory is unavailable: no workspace is associated with this request",
      };
    if (scope === "project" && resolved.projectPath === "")
      return {
        success: false as const,
        error: "Project memory is unavailable: no project is associated with this session",
      };
    return yield* context.memoryMetaService.effects
      .setPinned(
        memoryLogicalKey(scope, relPath, {
          projectPath: resolved.projectPath,
          workspaceId: input.workspaceId ?? "",
        }),
        input.pinned
      )
      .pipe(
        Effect.map(() => ({ success: true as const, data: undefined })),
        // Sidecar write failures (disk full, permissions) arrive as the typed
        // MemoryMetaWriteError and map onto the legacy string error channel
        // instead of escaping as an untyped INTERNAL_SERVER_ERROR rejection.
        Effect.catchTag("MemoryMetaWriteError", (error) =>
          Effect.succeed({
            success: false as const,
            error: `Failed to persist pin state: ${error.reason}`,
          })
        )
      );
  }).pipe(Effect.catchTag("MemoryWorkspaceNotFoundError", workspaceNotFoundAsStringError));
}

/** Promise facade over {@link setMemoryPinnedEffect} for pre-Effect callers. */
export async function setMemoryPinned(
  context: MemoryContext,
  input: Input<typeof schemas.memory.setPinned>
) {
  return Effect.runPromise(setMemoryPinnedEffect(context, input));
}

export function getMemoryConsolidationStatusEffect(
  context: MemoryContext,
  input: Input<typeof schemas.memory.consolidationStatus>
) {
  return Effect.gen(function* () {
    assertMemoryEnabled(context);
    const data = yield* Effect.promise(() =>
      context.memoryConsolidationService.getStatus(input.workspaceId)
    );
    return { success: true as const, data };
  });
}

/** Promise facade over {@link getMemoryConsolidationStatusEffect} for pre-Effect callers. */
export async function getMemoryConsolidationStatus(
  context: MemoryContext,
  input: Input<typeof schemas.memory.consolidationStatus>
) {
  return Effect.runPromise(getMemoryConsolidationStatusEffect(context, input));
}

export function consolidateMemoryEffect(
  context: MemoryContext,
  input: Input<typeof schemas.memory.consolidate>
) {
  return Effect.gen(function* () {
    assertMemoryEnabled(context);
    const result = yield* Effect.promise(() =>
      context.memoryConsolidationService.maybeRun(input.workspaceId, "manual")
    );
    return result.success
      ? { success: true as const, data: result.data }
      : { success: false as const, error: result.error };
  });
}

/** Promise facade over {@link consolidateMemoryEffect} for pre-Effect callers. */
export async function consolidateMemory(
  context: MemoryContext,
  input: Input<typeof schemas.memory.consolidate>
) {
  return Effect.runPromise(consolidateMemoryEffect(context, input));
}
