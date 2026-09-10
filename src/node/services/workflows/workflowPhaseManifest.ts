/**
 * Derives the phase manifest hydrated onto outbound workflow payloads.
 *
 * Two sources, in precedence order:
 *  1. `meta.phases` (declared) — validated strictly at run creation
 *     (WorkflowService) and leniently here on read paths.
 *  2. Best-effort static inference from `phase("literal")` callsites for legacy
 *     scripts without a declaration. This is NOT a JavaScript semantic
 *     interpreter: it recognizes a conservative safe subset — a canonical
 *     `{ phase }` binding on an immutable default export, called directly with
 *     string literals from the function's own body — and returns a manifest only
 *     when the whole script stays inside that subset. Anything that could emit
 *     or rebind a phase outside the scanner's view (dynamic names, aliasing,
 *     shadowing, nested scopes, parameter-time evaluation, `eval`/`with`,
 *     `arguments`, routes to the global object, the runner's `__workflow*`/`__mux*`
 *     internals, mutable/reassigned exports) bails to no manifest: observed-only
 *     rendering, exactly as before this feature. A wrong or incomplete inferred
 *     rail is worse than none.
 *
 *     Boundary: the scanner recognizes routes to the global object by NAME
 *     (identifier or string literal). It does not evaluate expressions, so a
 *     route name assembled at runtime (`obj["con" + "structor"]`) is outside the
 *     subset by design — closing that class statically would mean forbidding
 *     computed member access altogether, which real conductors use pervasively
 *     (`results[i]`, `seen[key]`). This is acceptable because the manifest is a
 *     pre-run PREVIEW, not the rail's source of truth: the projection merges
 *     observed phase events, so a phase emitted through any route still renders
 *     in its actual position once the run executes.
 *
 * The manifest is derived data: it is NEVER persisted (see
 * WorkflowRunStore.writeRunFile) and read-path failures never throw — they
 * memoize a negative result so old/hand-edited runs keep loading.
 */
import type ts from "typescript";
import { LRUCache } from "lru-cache";

import type {
  WorkflowDeclaredPhase,
  WorkflowPhaseManifest,
  WorkflowRunRecord,
} from "@/common/types/workflow";
import {
  WorkflowPhaseManifestSchema,
  WORKFLOW_DECLARED_PHASES_MAX,
  WORKFLOW_PHASE_NAME_MAX_LENGTH,
} from "@/common/orpc/schemas";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import { parseDeclaredPhasesFromSource } from "./workflowMetadata";
import { hashSource } from "./WorkflowRunStore";

type TypeScriptModule = typeof ts;
let tsModule: TypeScriptModule | undefined;

/**
 * Lazy-load the TypeScript compiler (~9 MB) the way sharp/QuickJS are: this
 * module sits on the oRPC router's import graph, which the `xum api` CLI bundle
 * carries only to generate commands — it never runs inference. A static import
 * both broke that ESM bundle (typescript.js is CJS-only) and added ~280 ms to
 * every CLI start; the Makefile marks `typescript` external for that bundle.
 */
function loadTypeScript(): TypeScriptModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  tsModule ??= require("typescript") as TypeScriptModule;
  return tsModule;
}

export type WorkflowPhaseManifestOutcome =
  | { kind: "manifest"; manifest: WorkflowPhaseManifest }
  // meta.phases present but invalid; `warning` carries the enumerated issues.
  | { kind: "invalid"; warning: string }
  // No declaration and inference bailed: today's observed-only behavior.
  | { kind: "none" };

// The subscribe stream re-hydrates on every run-changed event and listRuns
// hydrates a workspace's whole history in one pass, so parses are memoized per
// distinct source (keyed by content hash). The bound must comfortably exceed the
// number of distinct workflow sources one workspace accumulates: a history just
// over the limit would otherwise cycle-evict on every bulk read and reparse
// every script with the TypeScript compiler. Entries are tiny (a manifest or a
// warning string), so a generous bound costs little.
const outcomeBySourceHash = new LRUCache<string, WorkflowPhaseManifestOutcome>({ max: 4096 });

/**
 * Hard bound on the cached/wire `warning`. parseDeclaredPhases already caps its
 * enumerated issues (WORKFLOW_PHASE_ISSUES_MAX × bounded messages ≈ 6 KB), so a
 * clip here should never trigger; it exists so an attacker-controlled script
 * discovered from a trusted project can never grow a memoized entry — or the
 * renderer payload that repeats it per script — past a few kilobytes.
 */
const WARNING_MAX_LENGTH = 8192;

function boundWarning(message: string): string {
  return message.length > WARNING_MAX_LENGTH ? `${message.slice(0, WARNING_MAX_LENGTH)}…` : message;
}

/**
 * Resolve the phase manifest for a workflow source. Never throws: invalid
 * declarations are reported as `kind: "invalid"`, everything else degrades to
 * `kind: "none"`. Results (including negative ones) are memoized by sourceHash.
 */
export function resolveWorkflowPhaseManifest(
  source: string,
  sourceHash: string
): WorkflowPhaseManifestOutcome {
  assert(sourceHash.length > 0, "resolveWorkflowPhaseManifest: sourceHash is required");
  const cached = outcomeBySourceHash.get(sourceHash);
  if (cached != null) {
    return cached;
  }
  const outcome = computePhaseManifestOutcome(source);
  outcomeBySourceHash.set(sourceHash, outcome);
  return outcome;
}

function computePhaseManifestOutcome(source: string): WorkflowPhaseManifestOutcome {
  let declared: WorkflowDeclaredPhase[] | undefined;
  try {
    declared = parseDeclaredPhasesFromSource(source);
  } catch (error) {
    // Read-path strictness would brick old runs; run creation is the strict gate.
    log.debug(
      `workflowPhaseManifest: invalid meta.phases ignored on read: ${getErrorMessage(error)}`
    );
    return { kind: "invalid", warning: boundWarning(getErrorMessage(error)) };
  }
  if (declared != null) {
    return {
      kind: "manifest",
      manifest: WorkflowPhaseManifestSchema.parse({ provenance: "declared", phases: declared }),
    };
  }
  try {
    const inferred = inferPhaseManifest(source);
    if (inferred != null) {
      return {
        kind: "manifest",
        manifest: WorkflowPhaseManifestSchema.parse({ provenance: "inferred", phases: inferred }),
      };
    }
  } catch (error) {
    // Inference is purely additive; a scanner failure must never break reads.
    log.debug(`workflowPhaseManifest: inference failed: ${getErrorMessage(error)}`);
  }
  return { kind: "none" };
}

/**
 * Return an outbound copy of the run whose `workflow.phaseManifest` is derived
 * from the snapshotted source — the manifest when one resolves, else `null`
 * ("hydrated, none"). The explicit null lets clients tell a hydrated record
 * apart from a pre-upgrade snapshot that simply lacks the field. The source is
 * the only authority: a `phaseManifest` already present on the incoming record
 * (hand-edited run.json — the store strips it before schema validation, but be
 * defensive) is never passed through. Callers must not feed the hydrated copy
 * back into WorkflowRunStore writes.
 */
export function hydrateWorkflowRunPhaseManifest(run: WorkflowRunRecord): WorkflowRunRecord {
  // Memoize on a hash of the source we were actually handed, not the record's
  // own `sourceHash`: the store recomputes that field from disk on every read,
  // but any other producer of a record could pass a stale one and would
  // otherwise be served a manifest computed for different source text.
  const outcome = resolveWorkflowPhaseManifest(run.source, hashSource(run.source));
  return {
    ...run,
    workflow: {
      ...run.workflow,
      phaseManifest: outcome.kind === "manifest" ? outcome.manifest : null,
    },
  };
}

/**
 * Best-effort static inference of the phase alphabet for scripts without
 * meta.phases. Returns the phases in first-occurrence source order, or
 * `undefined` when the scanner bails (see module doc for the bail gate).
 */
export function inferPhaseManifest(source: string): WorkflowDeclaredPhase[] | undefined {
  const ts = loadTypeScript();
  const sourceFile = ts.createSourceFile(
    "workflow.js",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.JS
  );
  // TypeScript recovers from syntax errors and still yields an AST; the runner
  // will refuse to compile such a script, so a rail inferred from it would
  // describe code that never executed.
  if (sourceFileHasParseDiagnostics(sourceFile)) {
    return undefined;
  }
  // A sloppy-mode `with` block resolves `phase` dynamically through its object;
  // anywhere in the file, that voids inference.
  if (containsDynamicScope(ts, sourceFile)) {
    return undefined;
  }
  // The runner's prelude exposes its primitives as `__workflow*` / `__mux*`
  // globals; `__workflowPhase("hidden")` emits a phase the `phase` identifier
  // walk never sees. Any reference into that namespace — by identifier, by a
  // string naming it (`globalThis["__workflowPhase"]`), or via a route to the
  // global object (`globalThis`, `this`, `Function`, direct or indirect `eval`,
  // which can also read or rebind the lexical `phase`, or any `constructor`
  // access, which reaches Function reflectively) — voids inference.
  if (referencesRuntimeInternals(ts, sourceFile)) {
    return undefined;
  }
  const workflowFn = findDefaultExportedFunction(ts, sourceFile);
  if (workflowFn?.body == null) {
    return undefined;
  }
  if (!hasCanonicalPhaseBinding(ts, workflowFn)) {
    return undefined;
  }
  // Parameters evaluate before the body and may already use the destructured
  // `phase` — in a default (`fallback = phase("setup")`), a computed key
  // (`{ [phase("setup")]: x } = {}`), anywhere. Any `phase` identifier in the
  // parameter list other than the canonical binding itself bails rather than
  // modelling parameter-evaluation order.
  const canonicalBinding = findCanonicalPhaseBinding(ts, workflowFn);
  if (canonicalBinding == null) {
    return undefined;
  }
  const allowedParameterMentions = new Set<ts.Node>(
    [canonicalBinding.name, canonicalBinding.propertyName].filter((node) => node != null)
  );
  if (
    workflowFn.parameters.some((parameter) =>
      mentionsIdentifierOutside(ts, parameter, "phase", allowedParameterMentions)
    )
  ) {
    return undefined;
  }
  // `arguments[0]` is the original context object, so `arguments[0].phase(...)`
  // emits a phase the identifier walk classifies as a mere member name — from the
  // body or from a parameter default, so scan the whole function.
  if (mentionsIdentifier(ts, workflowFn, "arguments")) {
    return undefined;
  }

  const names: string[] = [];
  const seen = new Set<string>();
  // Walk the workflow function's own body. Nested function/class scopes are not
  // walked for collection: any `phase` reference inside them bails (source
  // order there does not imply runtime order), and any shadowing declaration
  // of `phase` anywhere bails.
  const visit = (node: ts.Node, insideNestedScope: boolean): boolean => {
    if (ts.isIdentifier(node) && node.text === "phase") {
      const classification = classifyPhaseIdentifier(ts, node);
      if (classification === "ignore") {
        return true;
      }
      if (classification === "shadowing-declaration" || insideNestedScope) {
        return false;
      }
      if (classification !== "direct-call") {
        return false;
      }
      const call = node.parent;
      assert(ts.isCallExpression(call), "inferPhaseManifest: direct-call must be a CallExpression");
      const firstArg = call.arguments[0];
      const name = staticStringArgument(ts, firstArg);
      if (name == null) {
        return false;
      }
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
      return true;
    }
    const nested = insideNestedScope || introducesFunctionOrClassScope(ts, node);
    for (const child of node.getChildren(sourceFile)) {
      if (!visit(child, nested)) {
        return false;
      }
    }
    return true;
  };
  if (!visit(workflowFn.body, false)) {
    return undefined;
  }

  if (names.length === 0 || names.length > WORKFLOW_DECLARED_PHASES_MAX) {
    return undefined;
  }
  if (names.some((name) => name.length === 0 || name.length > WORKFLOW_PHASE_NAME_MAX_LENGTH)) {
    return undefined;
  }
  return names.map((name) => ({ name }));
}

type WorkflowFunctionNode = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

function findDefaultExportedFunction(
  ts: TypeScriptModule,
  sourceFile: ts.SourceFile
): WorkflowFunctionNode | undefined {
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
      hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
    ) {
      // `export default function run` is a live binding: any later mention of
      // `run` could rebind what the default export executes.
      if (
        statement.name != null &&
        hasOtherReferences(ts, sourceFile, statement.name.text, new Set([statement.name]))
      ) {
        return undefined;
      }
      return statement;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      return resolveFunctionExpression(ts, sourceFile, statement.expression);
    }
  }
  return undefined;
}

function resolveFunctionExpression(
  ts: TypeScriptModule,
  sourceFile: ts.SourceFile,
  expression: ts.Expression
): WorkflowFunctionNode | undefined {
  if (ts.isFunctionExpression(expression) || ts.isArrowFunction(expression)) {
    return expression;
  }
  if (!ts.isIdentifier(expression)) {
    return undefined;
  }
  // `export default run;` referencing a top-level function or const initializer.
  // The binding must be immutable AND mentioned nowhere else: `let run = a; run = b;`
  // would make the initializer describe a function the runtime never executes.
  const resolved = findImmutableFunctionBinding(ts, sourceFile, expression.text);
  if (resolved == null) {
    return undefined;
  }
  if (hasOtherReferences(ts, sourceFile, expression.text, new Set([resolved.name, expression]))) {
    return undefined;
  }
  return resolved.fn;
}

function findImmutableFunctionBinding(
  ts: TypeScriptModule,
  sourceFile: ts.SourceFile,
  name: string
): { name: ts.Identifier; fn: WorkflowFunctionNode } | undefined {
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      return { name: statement.name, fn: statement };
    }
    if (
      ts.isVariableStatement(statement) &&
      (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
    ) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === name &&
          declaration.initializer != null &&
          (ts.isFunctionExpression(declaration.initializer) ||
            ts.isArrowFunction(declaration.initializer))
        ) {
          return { name: declaration.name, fn: declaration.initializer };
        }
      }
    }
  }
  return undefined;
}

/** Whether an identifier named `name` appears within `root` outside the `allowed` nodes. */
function mentionsIdentifierOutside(
  ts: TypeScriptModule,
  root: ts.Node,
  name: string,
  allowed: ReadonlySet<ts.Node>
): boolean {
  const check = (node: ts.Node): boolean =>
    (ts.isIdentifier(node) && node.text === name && !allowed.has(node)) ||
    ts.forEachChild(node, check) === true;
  return check(root);
}

/** The `{ phase }` / `{ phase: phase }` element of the first parameter, once validated. */
function findCanonicalPhaseBinding(
  ts: TypeScriptModule,
  fn: WorkflowFunctionNode
): ts.BindingElement | undefined {
  const firstParam = fn.parameters[0];
  if (firstParam == null || !ts.isObjectBindingPattern(firstParam.name)) {
    return undefined;
  }
  return firstParam.name.elements.find(
    (element) => ts.isIdentifier(element.name) && element.name.text === "phase"
  );
}

/** Whether any identifier named `name` appears within `root` (including as a member name). */
function mentionsIdentifier(ts: TypeScriptModule, root: ts.Node, name: string): boolean {
  const check = (node: ts.Node): boolean =>
    (ts.isIdentifier(node) && node.text === name) || ts.forEachChild(node, check) === true;
  return check(root);
}

const RUNTIME_INTERNAL_PREFIXES = ["__workflow", "__mux"];
// `eval` in ANY position: direct eval sees the lexical `phase` binding, and
// indirect eval (`(0, eval)("this")`) returns the global object. `constructor`
// reaches the Function constructor reflectively (`[].filter.constructor(src)`).
const GLOBAL_OBJECT_ROUTES = new Set(["globalThis", "Function", "eval", "constructor"]);

function referencesRuntimeInternals(ts: TypeScriptModule, sourceFile: ts.SourceFile): boolean {
  const namesInternal = (text: string): boolean =>
    RUNTIME_INTERNAL_PREFIXES.some((prefix) => text.startsWith(prefix));
  // Identifiers AND string/template literals are checked against both lists:
  // `obj["constructor"]` or `g["__workflowPhase"]` name the route in a string.
  const namesRoute = (text: string): boolean =>
    namesInternal(text) || GLOBAL_OBJECT_ROUTES.has(text);
  const check = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node) && namesRoute(node.text)) {
      return true;
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      return true;
    }
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      namesRoute(node.text)
    ) {
      return true;
    }
    return ts.forEachChild(node, check) === true;
  };
  return check(sourceFile);
}

/**
 * `parseDiagnostics` is populated by createSourceFile but is not on the public
 * SourceFile type (the public route would need a full Program). Read it through
 * a structural type guard rather than an assertion so a future TypeScript that
 * renames the field degrades to "no diagnostics" instead of a type lie.
 */
function sourceFileHasParseDiagnostics(sourceFile: ts.SourceFile): boolean {
  const hasParseDiagnostics = (
    value: ts.SourceFile
  ): value is ts.SourceFile & { parseDiagnostics: readonly unknown[] } =>
    "parseDiagnostics" in value && Array.isArray(value.parseDiagnostics);
  return hasParseDiagnostics(sourceFile) && sourceFile.parseDiagnostics.length > 0;
}

function containsDynamicScope(ts: TypeScriptModule, sourceFile: ts.SourceFile): boolean {
  // `with` resolves identifiers through an object at runtime. (`eval` — direct or
  // indirect — is covered by referencesRuntimeInternals as a global-object route.)
  const check = (node: ts.Node): boolean =>
    ts.isWithStatement(node) || ts.forEachChild(node, check) === true;
  return check(sourceFile);
}

/**
 * True when the identifier `name` is referenced anywhere other than the nodes in
 * `allowed` (its declaration and the `export default name` expression). Any other
 * mention — `name = f`, `({ name } = o)`, `for (name of xs)`, `helper(name)` — could
 * rebind or observe the live export, so inference gives up rather than enumerate
 * assignment forms. Property names (`obj.name`, `{ name: 1 }`) also bail: harmless
 * over-caution for the all-or-nothing gate.
 */
function hasOtherReferences(
  ts: TypeScriptModule,
  sourceFile: ts.SourceFile,
  name: string,
  allowed: ReadonlySet<ts.Node>
): boolean {
  return mentionsIdentifierOutside(ts, sourceFile, name, allowed);
}

function hasModifier(node: ts.FunctionDeclaration, kind: ts.SyntaxKind): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === kind) === true;
}

/**
 * The only accepted binding is the canonical `{ phase }` shorthand (or the
 * equivalent explicit `{ phase: phase }`) at the top level of the first
 * parameter. Renames (`{ phase: p }`), bindings of the NAME `phase` from other
 * properties, or `phase` bindings anywhere else in the parameter list bail.
 */
function hasCanonicalPhaseBinding(ts: TypeScriptModule, fn: WorkflowFunctionNode): boolean {
  const firstParam = fn.parameters[0];
  if (firstParam == null || !ts.isObjectBindingPattern(firstParam.name)) {
    return false;
  }
  let canonical = false;
  for (const element of firstParam.name.elements) {
    if (element.dotDotDotToken != null && containsPhaseBinding(ts, element.name)) {
      return false; // { ...phase } binds the leftover context object, not the primitive
    }
    const propertyName = bindingPropertyNameText(ts, element);
    if (propertyName === COMPUTED_BINDING_KEY) {
      return false; // { [key]: phase } — the bound capability cannot be proven statically
    }
    const boundName = ts.isIdentifier(element.name) ? element.name.text : null;
    if (propertyName === "phase" || (propertyName == null && boundName === "phase")) {
      if (boundName !== "phase") {
        return false; // rename: { phase: p }
      }
      canonical = true;
    } else if (boundName === "phase") {
      return false; // { other: phase } binds a misleading local named phase
    } else if (containsPhaseBinding(ts, element.name)) {
      return false; // nested pattern binding a `phase` local
    }
  }
  if (!canonical) {
    return false;
  }
  // Any OTHER parameter binding a `phase` local would shadow ambiguously.
  return fn.parameters.slice(1).every((parameter) => !containsPhaseBinding(ts, parameter.name));
}

/** Sentinel for `{ [computed]: local }` keys, which have no static identity. */
const COMPUTED_BINDING_KEY = Symbol("computed-binding-key");

function bindingPropertyNameText(
  ts: TypeScriptModule,
  element: ts.BindingElement
): string | typeof COMPUTED_BINDING_KEY | null {
  const propertyName = element.propertyName;
  if (propertyName == null) {
    return null;
  }
  return ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName)
    ? propertyName.text
    : COMPUTED_BINDING_KEY;
}

function containsPhaseBinding(ts: TypeScriptModule, name: ts.BindingName): boolean {
  if (ts.isIdentifier(name)) {
    return name.text === "phase";
  }
  return name.elements.some((element) => {
    if (ts.isOmittedExpression(element)) {
      return false;
    }
    return containsPhaseBinding(ts, element.name);
  });
}

function introducesFunctionOrClassScope(ts: TypeScriptModule, node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  );
}

type PhaseIdentifierClassification =
  // Not a reference to the binding (member name, object key, label, …).
  | "ignore"
  // A declaration introducing a different `phase` binding → bail.
  | "shadowing-declaration"
  // `phase("...")` with the identifier as the callee and no optional chaining.
  | "direct-call"
  // Any other reference (argument, return, alias, member base, `phase?.()`) → bail.
  | "other-reference";

function classifyPhaseIdentifier(
  ts: TypeScriptModule,
  node: ts.Identifier
): PhaseIdentifierClassification {
  const parent = node.parent;
  // Non-reference name positions.
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return "ignore"; // ctx.phase — member of another object
  }
  if (ts.isPropertyAssignment(parent) && parent.name === node) {
    return "ignore"; // { phase: x } — object literal key
  }
  if (
    (ts.isMethodDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.name === node
  ) {
    return "ignore"; // method/property named phase on a class or object
  }
  if (ts.isLabeledStatement(parent) && parent.label === node) {
    return "ignore";
  }
  if (ts.isBindingElement(parent) && parent.propertyName === node) {
    return "ignore"; // destructuring key ({ phase: p }); the rename itself is caught as a declaration below
  }

  // Declarations introducing a new `phase` binding (shadowing).
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent)) &&
    parent.name === node
  ) {
    return "shadowing-declaration";
  }

  if (ts.isCallExpression(parent) && parent.expression === node) {
    // `phase?.(...)` is a non-direct use per the bail gate.
    return parent.questionDotToken == null ? "direct-call" : "other-reference";
  }
  return "other-reference";
}

function staticStringArgument(
  ts: TypeScriptModule,
  argument: ts.Expression | undefined
): string | null {
  if (argument == null) {
    return null;
  }
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
    return argument.text;
  }
  return null;
}
