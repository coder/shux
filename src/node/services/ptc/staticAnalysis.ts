/**
 * Static Analysis for PTC Code
 *
 * Analyzes agent-generated JavaScript code before execution to catch:
 * - Syntax errors (via QuickJS parser)
 * - Unavailable constructs (import(), require())
 * - Unavailable globals (process, window, etc.)
 *
 * The runtime also wraps ReferenceErrors with friendlier messages as a backstop.
 */

import ts from "typescript";
import { CODE_EXECUTION_STRING_GUIDANCE } from "@/constants/codeExecution";
import {
  newQuickJSAsyncWASMModuleFromVariant,
  type QuickJSAsyncContext,
} from "quickjs-emscripten-core";
import { QuickJSAsyncFFI } from "@jitl/quickjs-wasmfile-release-asyncify/ffi";
import { validateTypes, WRAPPER_PREFIX } from "./typeValidator";

/**
 * Identifiers that don't exist in QuickJS and will cause ReferenceError.
 * Used by static analysis to block execution, and by runtime for friendly error messages.
 */
export const UNAVAILABLE_IDENTIFIERS = new Set([
  // Node.js globals
  "process",
  "require",
  "module",
  "exports",
  "__dirname",
  "__filename",
  // Browser globals
  "window",
  "document",
  "navigator",
  "fetch",
  "XMLHttpRequest",
]);

const WRAPPER_LINE_OFFSET = WRAPPER_PREFIX.split("\n").length - 1;

// ============================================================================
// Types
// ============================================================================

export interface AnalysisError {
  type: "syntax" | "forbidden_construct" | "unavailable_global" | "type_error";
  message: string;
  line?: number;
  column?: number;
}

export interface AnalysisResult {
  /** Whether the code passed all checks (no errors) */
  valid: boolean;
  /** Errors that prevent execution */
  errors: AnalysisError[];
}

// ============================================================================
// Pattern Definitions
// ============================================================================

// NOTE: We intentionally avoid regex scanning for substrings like "require(" or "import("
// because those can appear inside string literals and cause false positives.
//
// Instead, we use the TypeScript AST in detectUnavailableGlobals() to detect actual
// call expressions (require(), import()) and real global references.

// ============================================================================
// QuickJS Context Management
// ============================================================================

let cachedContext: QuickJSAsyncContext | null = null;

/**
 * Get or create a QuickJS context for syntax validation.
 * We reuse the context to avoid repeated WASM initialization.
 */
async function getValidationContext(): Promise<QuickJSAsyncContext> {
  if (cachedContext) {
    return cachedContext;
  }

  const variant = {
    type: "async" as const,
    importFFI: () => Promise.resolve(QuickJSAsyncFFI),
    // eslint-disable-next-line @typescript-eslint/require-await
    importModuleLoader: async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
      const mod = require("@jitl/quickjs-wasmfile-release-asyncify/emscripten-module");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
      return mod.default ?? mod;
    },
  };

  const QuickJS = await newQuickJSAsyncWASMModuleFromVariant(variant);
  cachedContext = QuickJS.newContext();
  return cachedContext;
}

// ============================================================================
// Analysis Functions
// ============================================================================

/**
 * Find lines containing AwaitExpression nodes in the TypeScript AST.
 *
 * We intentionally do NOT filter by async context. QuickJS wraps agent code
 * in a non-async function, so every `await` is illegal from its perspective.
 * Legal awaits inside user-written `async function` blocks parse fine in
 * QuickJS and never produce "expecting ';'" — so they never reach the
 * rewrite path. The only job here is distinguishing real `await` tokens
 * from `await` text inside strings, comments, or templates.
 *
 * Returns empty set when TS has parse diagnostics (ambiguous — don't guess).
 */
function findAwaitLines(code: string): Set<number> {
  const sourceFile = ts.createSourceFile(
    "analysis.ts",
    code,
    ts.ScriptTarget.ES2020,
    true,
    ts.ScriptKind.JS
  );

  // parseDiagnostics exists at runtime but is not declared on this ts.SourceFile type.
  const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] })
    .parseDiagnostics;
  if (parseDiagnostics && parseDiagnostics.length > 0) {
    return new Set();
  }

  const lines = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node)) {
      lines.add(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lines;
}

/**
 * Validate JavaScript syntax using QuickJS parser.
 * Returns syntax error if code is invalid.
 */
async function validateSyntax(code: string): Promise<AnalysisError | null> {
  const ctx = await getValidationContext();

  // Wrap in function to allow return statements (matches runtime behavior)
  const wrappedCode = `(function() { ${code} })`;

  // Use evalCode with compile-only flag to parse without executing.
  const result = ctx.evalCode(wrappedCode, "analysis.js", {
    compileOnly: true,
  });

  if (result.error) {
    const errorObj = ctx.dump(result.error) as Record<string, unknown>;
    result.error.dispose();

    // QuickJS error object has: { name, message, stack, fileName, lineNumber }
    let message =
      typeof errorObj.message === "string" ? errorObj.message : JSON.stringify(errorObj);

    const rawLine = typeof errorObj.lineNumber === "number" ? errorObj.lineNumber : undefined;

    // QuickJS stops at the first raw newline in a quoted script. Keep rejecting
    // malformed code, but explain how to retry without silently rewriting shell text.
    if (message === "unexpected end of string") {
      message += `. Unterminated JavaScript string. ${CODE_EXECUTION_STRING_GUIDANCE}`;
    }

    // Enhance obtuse "expecting ';'" error when await expression is detected.
    // In non-async context, `await foo()` parses as identifier `await` + stray `foo()`,
    // giving unhelpful "expecting ';'". Use AST-based detection (not raw regex) to avoid
    // false positives when `await` appears inside string literals or template content.
    if (message === "expecting ';'") {
      const awaitLines = findAwaitLines(code);
      const likelyAwaitFailure =
        awaitLines.size > 0 && (rawLine === undefined || awaitLines.has(rawLine));

      if (likelyAwaitFailure) {
        message =
          "`await` is not supported - xum.* functions return results directly (no await needed)";
      }
    }

    // Only report line if it's within agent code bounds.
    // The wrapper is `(function() { ${code} })` - all on one line with code inlined.
    // So QuickJS line N = agent line N for lines within the code.
    // Errors detected at the closing wrapper (missing braces, incomplete expressions)
    // will have line numbers beyond the agent's code - don't report those.
    const codeLines = code.split("\n").length;
    const line =
      rawLine !== undefined && rawLine >= 1 && rawLine <= codeLines ? rawLine : undefined;

    return {
      type: "syntax",
      message,
      line,
      column: undefined, // QuickJS doesn't provide column for syntax errors
    };
  }

  result.value.dispose();
  return null;
}

/**
 * Detect references to unavailable globals (process, window, fetch, etc.)
 * using TypeScript AST to avoid false positives on object keys and string literals.
 */
function detectUnavailableGlobals(code: string, sourceFile?: ts.SourceFile): AnalysisError[] {
  const errors: AnalysisError[] = [];
  const seen = new Set<string>();

  const parsedSourceFile =
    sourceFile ?? ts.createSourceFile("code.ts", code, ts.ScriptTarget.ES2020, true);
  const codeStartOffset = sourceFile ? WRAPPER_PREFIX.length : 0;
  const codeEnd = codeStartOffset + code.length;
  const lineOffset = sourceFile ? WRAPPER_LINE_OFFSET : 0;

  function visit(node: ts.Node): void {
    // If the node isn't within the user-authored code region (e.g., inside the wrapper prefix),
    // keep traversing but don't report errors for it.
    const nodeStart = node.getStart(parsedSourceFile);
    const nodeEnd = node.end;
    if (nodeStart < codeStartOffset || nodeEnd > codeEnd) {
      ts.forEachChild(node, visit);
      return;
    }

    // Detect forbidden constructs via AST (avoids false positives inside string literals).
    //
    // - dynamic import(): ts.CallExpression whose expression is the ImportKeyword
    // - require(): ts.CallExpression whose expression is identifier "require"
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (!seen.has("import()")) {
          seen.add("import()");
          const { line } = parsedSourceFile.getLineAndCharacterOfPosition(
            node.expression.getStart(parsedSourceFile)
          );
          errors.push({
            type: "forbidden_construct",
            message: "Dynamic import() is not available in the sandbox",
            line: line - lineOffset + 1,
          });
        }
        ts.forEachChild(node, visit);
        return;
      }

      if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        if (!seen.has("require()")) {
          seen.add("require()");
          const { line } = parsedSourceFile.getLineAndCharacterOfPosition(
            node.expression.getStart(parsedSourceFile)
          );
          errors.push({
            type: "forbidden_construct",
            message: "require() is not available in the sandbox - use xum.* tools instead",
            line: line - lineOffset + 1,
          });
        }
        ts.forEachChild(node, visit);
        return;
      }
    }

    if (!ts.isIdentifier(node)) {
      ts.forEachChild(node, visit);
      return;
    }

    const start = nodeStart;
    const name = node.text;

    // Skip 'require' identifier references - we only want to error on require() calls.
    // (Keyword substrings inside strings should never trigger any error.)
    if (name === "require") {
      return;
    }

    // Skip if not an unavailable identifier
    if (!UNAVAILABLE_IDENTIFIERS.has(name)) {
      return;
    }

    // Skip if already reported
    if (seen.has(name)) {
      return;
    }

    const parent = node.parent;

    // Skip property access on RHS (e.g., obj.process)
    if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) {
      return;
    }

    // Skip object literal property keys (e.g., { process: ... })
    if (parent && ts.isPropertyAssignment(parent) && parent.name === node) {
      return;
    }

    // Skip shorthand property assignments (e.g., { process } where process is a variable)
    // This is actually a reference, so we don't skip it

    // Skip variable declarations (e.g., const process = ...)
    if (parent && ts.isVariableDeclaration(parent) && parent.name === node) {
      seen.add(name);
      return;
    }

    // Skip function declarations (e.g., function process() {})
    if (parent && ts.isFunctionDeclaration(parent) && parent.name === node) {
      seen.add(name);
      return;
    }

    // Skip parameter declarations
    if (parent && ts.isParameter(parent) && parent.name === node) {
      seen.add(name);
      return;
    }

    // This is a real reference to an unavailable global
    seen.add(name);
    const { line } = parsedSourceFile.getLineAndCharacterOfPosition(start);
    errors.push({
      type: "unavailable_global",
      message: `'${name}' is not available in the sandbox`,
      line: line - lineOffset + 1, // 1-indexed
    });
  }

  visit(parsedSourceFile);
  return errors;
}

// ============================================================================
// Main Analysis Function
// ============================================================================

/**
 * Analyze JavaScript code before execution.
 *
 * Performs:
 * 1. Syntax validation via QuickJS parser
 * 2. Forbidden construct + unavailable global detection via TypeScript AST (require(), import(), process, window, etc.)
 * 3. TypeScript type validation (if xumTypes provided)
 *
 * @param code - JavaScript code to analyze
 * @param xumTypes - Optional .d.ts content for type validation
 * @returns Analysis result with errors
 */
export async function analyzeCode(code: string, xumTypes?: string): Promise<AnalysisResult> {
  const errors: AnalysisError[] = [];

  // 1. Syntax validation
  const syntaxError = await validateSyntax(code);
  if (syntaxError) {
    errors.push(syntaxError);
    // If syntax is invalid, skip other checks (they'd give false positives)
    return { valid: false, errors };
  }

  let typeResult: ReturnType<typeof validateTypes> | undefined;
  if (xumTypes) {
    typeResult = validateTypes(code, xumTypes);
  }

  // 2. Forbidden construct + unavailable global detection (process, window, require(), import(), etc.)
  errors.push(...detectUnavailableGlobals(code, typeResult?.sourceFile));

  // 3. TypeScript type validation (if xumTypes provided)
  if (typeResult) {
    for (const typeError of typeResult.errors) {
      errors.push({
        type: "type_error",
        message: typeError.message,
        line: typeError.line,
        column: typeError.column,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Clean up the cached validation context.
 * Call this when shutting down to free resources.
 *
 * TODO: Wire into app/workspace shutdown to free QuickJS context (Phase 6)
 */
export function disposeAnalysisContext(): void {
  if (cachedContext) {
    cachedContext.dispose();
    cachedContext = null;
  }
}
