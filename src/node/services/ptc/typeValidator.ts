/**
 * TypeScript Type Validator for PTC
 *
 * Validates agent-generated JavaScript code against generated type definitions.
 * Catches type errors before execution:
 * - Wrong property names
 * - Missing required arguments
 * - Wrong types for arguments
 * - Calling non-existent tools
 */

/* eslint-disable local/no-sync-fs-methods -- TypeScript's CompilerHost API requires synchronous file operations */
import fs from "fs";
import path from "path";
import ts from "typescript";

/**
 * In production builds, lib files are copied to dist/typescript-lib/ with .d.ts.txt extension
 * because electron-builder ignores .d.ts files by default (hardcoded, cannot override):
 * https://github.com/electron-userland/electron-builder/issues/5064
 *
 * These constants are computed once at module load time. The Docker server bundle runs from
 * dist/runtime, while the unbundled Electron/main build runs from dist/node/services/ptc, so
 * probe both relative layouts before falling back to the TypeScript package in development.
 */
const BUNDLED_LIB_DIR = findBundledTypeScriptLibDir(__dirname);
const IS_PRODUCTION = BUNDLED_LIB_DIR != null;
const LIB_DIR = BUNDLED_LIB_DIR ?? path.dirname(require.resolve("typescript/lib/lib.d.ts"));

export const WRAPPER_PREFIX = "function __agent__() {\n";
const XUM_TYPES_FILE = "xum.d.ts";
const ROOT_FILE_NAMES = ["agent.ts", XUM_TYPES_FILE];

// Cache lib and xum type SourceFiles across validations to avoid re-parsing.
const libSourceFileCache = new Map<string, ts.SourceFile>();
const xumSourceFileCache = new Map<string, ts.SourceFile>();

function wrapAgentCode(code: string): string {
  return `${WRAPPER_PREFIX}${code}\n}\n`;
}

const getLibCacheKey = (fileName: string, languageVersion: ts.ScriptTarget): string =>
  `${languageVersion}:${fileName}`;

function getCachedLibSourceFile(
  fileName: string,
  languageVersion: ts.ScriptTarget,
  readFile: () => string | undefined
): ts.SourceFile | undefined {
  const key = getLibCacheKey(fileName, languageVersion);
  const cached = libSourceFileCache.get(key);
  if (cached) return cached;

  const contents = readFile();
  if (!contents) return undefined;

  const sourceFile = ts.createSourceFile(fileName, contents, languageVersion, true);
  libSourceFileCache.set(key, sourceFile);
  return sourceFile;
}

function getCachedXumSourceFile(xumTypes: string, languageVersion: ts.ScriptTarget): ts.SourceFile {
  const key = `${languageVersion}:${xumTypes}`;
  const cached = xumSourceFileCache.get(key);
  if (cached) return cached;

  const sourceFile = ts.createSourceFile(XUM_TYPES_FILE, xumTypes, languageVersion, true);
  xumSourceFileCache.set(key, sourceFile);
  return sourceFile;
}
/** Resolve lib file path, accounting for .d.ts rename in production */
const resolveLibPath = (fileName: string): string => {
  const libFileName = path.basename(fileName);
  const actualName = IS_PRODUCTION ? toProductionLibName(libFileName) : libFileName;
  return path.join(LIB_DIR, actualName);
};

function createProgramForCode(
  wrappedCode: string,
  xumTypes: string,
  compilerOptions: ts.CompilerOptions
): {
  program: ts.Program;
  host: ts.CompilerHost;
  getSourceFile: () => ts.SourceFile;
  setSourceFile: (newWrappedCode: string) => void;
} {
  const scriptTarget = compilerOptions.target ?? ts.ScriptTarget.ES2020;
  let sourceFile = ts.createSourceFile("agent.ts", wrappedCode, scriptTarget, true);
  const xumSourceFile = getCachedXumSourceFile(xumTypes, scriptTarget);
  const setSourceFile = (newWrappedCode: string) => {
    sourceFile = ts.createSourceFile("agent.ts", newWrappedCode, scriptTarget, true);
  };
  const host = ts.createCompilerHost(compilerOptions);

  // Override to read lib files from our bundled directory
  host.getDefaultLibLocation = () => LIB_DIR;
  host.getDefaultLibFileName = (options) => path.join(LIB_DIR, ts.getDefaultLibFileName(options));

  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);

  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
    // languageVersionOrOptions can be ScriptTarget or CreateSourceFileOptions
    const target =
      typeof languageVersionOrOptions === "number" ? languageVersionOrOptions : scriptTarget;
    if (fileName === "agent.ts") return sourceFile;
    if (fileName === XUM_TYPES_FILE) return xumSourceFile;

    const isLibFile = fileName.includes("lib.") && fileName.endsWith(".d.ts");
    if (isLibFile) {
      const cached = getCachedLibSourceFile(fileName, target, () => {
        if (IS_PRODUCTION) {
          const libPath = resolveLibPath(fileName);
          return fs.existsSync(libPath) ? fs.readFileSync(libPath, "utf-8") : undefined;
        }
        return originalReadFile(fileName) ?? undefined;
      });
      if (cached) return cached;
    }

    return originalGetSourceFile(
      fileName,
      languageVersionOrOptions,
      onError,
      shouldCreateNewSourceFile
    );
  };
  host.fileExists = (fileName) => {
    if (fileName === "agent.ts" || fileName === XUM_TYPES_FILE) return true;
    // In production, check bundled lib directory for lib files
    if (IS_PRODUCTION && fileName.includes("lib.") && fileName.endsWith(".d.ts")) {
      return fs.existsSync(resolveLibPath(fileName));
    }
    return originalFileExists(fileName);
  };
  host.readFile = (fileName) => {
    if (fileName === XUM_TYPES_FILE) return xumTypes;
    // In production, read lib files from bundled directory
    if (IS_PRODUCTION && fileName.includes("lib.") && fileName.endsWith(".d.ts")) {
      const libPath = resolveLibPath(fileName);
      if (fs.existsSync(libPath)) {
        return fs.readFileSync(libPath, "utf-8");
      }
    }
    return originalReadFile(fileName);
  };

  const program = ts.createProgram(ROOT_FILE_NAMES, compilerOptions, host);
  return { program, host, getSourceFile: () => sourceFile, setSourceFile };
}

function hasBundledTypeScriptLib(dir: string): boolean {
  return fs.existsSync(path.join(dir, toProductionLibName("lib.es2023.d.ts")));
}

export function findBundledTypeScriptLibDir(baseDir: string): string | null {
  const candidates = [
    // Unbundled main/Electron build: dist/node/services/ptc -> dist/typescript-lib.
    path.resolve(baseDir, "../../../typescript-lib"),
    // Docker server bundle: dist/runtime -> dist/typescript-lib.
    path.resolve(baseDir, "../typescript-lib"),
  ];
  return candidates.find(hasBundledTypeScriptLib) ?? null;
}

/** Convert lib filename for production: lib.X.d.ts → lib.X.d.ts.txt */
function toProductionLibName(fileName: string): string {
  return fileName + ".txt";
}

export interface TypeValidationError {
  message: string;
  line?: number;
  column?: number;
}

export interface TypeValidationResult {
  valid: boolean;
  errors: TypeValidationError[];
  sourceFile?: ts.SourceFile;
}

/**
 * Validate JavaScript code against xum type definitions using TypeScript.
 *
 * @param code - JavaScript code to validate
 * @param xumTypes - Generated `.d.ts` content from generateXumTypes()
 * @returns Validation result with errors if any
 */

/** Find the innermost token at a position in the source file */
function findTokenAtPosition(sourceFile: ts.SourceFile, position: number): ts.Node | undefined {
  function find(node: ts.Node): ts.Node | undefined {
    if (position < node.getStart(sourceFile) || position >= node.getEnd()) {
      return undefined;
    }
    // Try to find a more specific child
    const child = ts.forEachChild(node, find);
    return child ?? node;
  }
  return find(sourceFile);
}

/**
 * Walk up from a token to find the enclosing PropertyAccessExpression and its receiver.
 * Returns undefined if no PropertyAccessExpression is found.
 */
function findPropertyAccessContext(
  token: ts.Node
): { propAccess: ts.PropertyAccessExpression; receiver: ts.Expression } | undefined {
  let node: ts.Node = token;
  while (node.parent) {
    if (ts.isPropertyAccessExpression(node.parent)) {
      return { propAccess: node.parent, receiver: node.parent.expression };
    }
    node = node.parent;
  }
  return undefined;
}

/**
 * Check if a TS2339 diagnostic is for a property WRITE on an empty object literal.
 * Returns true only for patterns like `results.foo = x` where `results` is typed as `{}`.
 * Returns false for reads like `return results.foo` or `fn(results.foo)`.
 */
function isEmptyObjectWriteError(d: ts.Diagnostic, sourceFile: ts.SourceFile): boolean {
  if (d.code !== 2339 || d.start === undefined) return false;
  const message = ts.flattenDiagnosticMessageText(d.messageText, "");
  if (!message.includes("on type '{}'")) return false;

  const token = findTokenAtPosition(sourceFile, d.start);
  if (!token) return false;

  const ctx = findPropertyAccessContext(token);
  if (!ctx) return false;

  // Check if this PropertyAccessExpression is on the left side of an assignment
  const parent = ctx.propAccess.parent;
  return (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.left === ctx.propAccess
  );
}

type DynamicBagFirstWritePosByContainer = ReadonlyMap<ts.Symbol, ReadonlyMap<ts.Node, number>>;

function getEnclosingFunctionLikeContainer(node: ts.Node, sourceFile: ts.SourceFile): ts.Node {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return sourceFile;
}

/**
 * Find "dynamic empty-object bags": declared as `const x = {}` (empty literal) and
 * written to via element access (`x[key] = val`).
 *
 * Returns a map of bag Symbol → (function-like container → earliest bracket-write position).
 *
 * We track by Symbol (not identifier text) so shadowed variables don't leak
 * bag-ness across scopes.
 *
 * Excludes `xum`/`mux` to preserve shadowing detection.
 */
function isScriptingNamespaceName(name: string): boolean {
  return name === "xum" || name === "mux";
}

function findDynamicEmptyObjectBagFirstWritePosByContainer(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker
): Map<ts.Symbol, Map<ts.Node, number>> {
  const emptyLiteralSymbols = new Set<ts.Symbol>();

  function maybeAddEmptyLiteralSymbol(ident: ts.Identifier, decl: ts.VariableDeclaration): void {
    if (isScriptingNamespaceName(ident.text)) return;
    const sym = checker.getSymbolAtLocation(ident);
    if (!sym) return;

    // Only treat immutable bindings as bags — `let` / `var` can be reassigned, which
    // would make dot-notation reads unsafe to suppress.
    const declList = decl.parent;
    const isConst =
      ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0;
    if (!isConst) return;

    emptyLiteralSymbols.add(sym);
  }

  function collectCandidates(node: ts.Node): void {
    // Detect `const x = {}`
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer) &&
      node.initializer.properties.length === 0
    ) {
      maybeAddEmptyLiteralSymbol(node.name, node);
    }
    ts.forEachChild(node, collectCandidates);
  }

  collectCandidates(sourceFile);

  const firstWritePosByContainer = new Map<ts.Symbol, Map<ts.Node, number>>();

  function maybeRecordWrite(sym: ts.Symbol, container: ts.Node, writePos: number): void {
    let containerMap = firstWritePosByContainer.get(sym);
    if (!containerMap) {
      containerMap = new Map<ts.Node, number>();
      firstWritePosByContainer.set(sym, containerMap);
    }

    const prev = containerMap.get(container);
    if (prev === undefined || writePos < prev) {
      containerMap.set(container, writePos);
    }
  }

  function collectWrites(node: ts.Node): void {
    // Detect `x[key] = val`
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression)
    ) {
      const receiverIdent = node.left.expression;
      if (!isScriptingNamespaceName(receiverIdent.text)) {
        const receiverSymbol = checker.getSymbolAtLocation(receiverIdent);
        if (receiverSymbol && emptyLiteralSymbols.has(receiverSymbol)) {
          const writeContainer = getEnclosingFunctionLikeContainer(node, sourceFile);

          // Record the "write" position *after* the assignment has evaluated. JS evaluates the
          // element-access base + index + RHS before applying the assignment, so using the node's
          // start would incorrectly treat reads inside the assignment expression as "after" the
          // write (e.g. `r["a"] = r.typo`).
          maybeRecordWrite(receiverSymbol, writeContainer, node.right.getEnd());
        }
      }
    }

    ts.forEachChild(node, collectWrites);
  }

  collectWrites(sourceFile);
  return firstWritePosByContainer;
}

/**
 * Check if a TS2339 diagnostic is for a property READ on a dynamic empty-object bag.
 * Only suppresses when:
 * 1. The receiver resolves to a symbol in `dynamicBagFirstWritePosByContainer`
 * 2. The diagnostic message indicates `on type '{}'`
 * 3. The access is a read (not a write target like `=`, `+=`, `++`)
 * 4. There's a preceding bracket write in the same function-like container
 */
function isDynamicBagReadError(
  d: ts.Diagnostic,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  dynamicBagFirstWritePosByContainer: DynamicBagFirstWritePosByContainer
): boolean {
  if (d.code !== 2339 || d.start === undefined || dynamicBagFirstWritePosByContainer.size === 0) {
    return false;
  }
  const message = ts.flattenDiagnosticMessageText(d.messageText, "");
  if (!message.includes("on type '{}'")) return false;

  const token = findTokenAtPosition(sourceFile, d.start);
  if (!token) return false;

  const ctx = findPropertyAccessContext(token);
  if (!ctx) return false;

  if (!ts.isIdentifier(ctx.receiver)) return false;

  const receiverSymbol = checker.getSymbolAtLocation(ctx.receiver);
  if (!receiverSymbol) return false;

  const readContainer = getEnclosingFunctionLikeContainer(ctx.propAccess, sourceFile);
  const firstWritePos = dynamicBagFirstWritePosByContainer.get(receiverSymbol)?.get(readContainer);
  if (firstWritePos === undefined) return false;

  // Don't suppress write targets — compound assignments (`+=`) and increment/decrement
  // on unknown properties are real bugs, not dynamic-bag reads.
  const parent = ctx.propAccess.parent;
  if (ts.isBinaryExpression(parent) && parent.left === ctx.propAccess) {
    // Simple assignment `x.foo = val` is already handled by isEmptyObjectWriteError.
    // Compound assignments like `x.foo += 1` read first — don't suppress.
    return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  }
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return false;
  }

  const readPos = ctx.propAccess.getStart(sourceFile);
  return firstWritePos < readPos;
}

/** Returns true if the type resolves to a non-tuple never[] (including unions). */
function isNeverArrayType(type: ts.Type, checker: ts.TypeChecker): boolean {
  const nonNullable = checker.getNonNullableType(type);

  if (nonNullable.isUnion()) {
    return nonNullable.types.every((member) => isNeverArrayType(member, checker));
  }

  if (checker.isTupleType(nonNullable)) {
    return false;
  }

  if (!checker.isArrayType(nonNullable)) {
    return false;
  }

  const elementType = checker.getIndexTypeOfType(nonNullable, ts.IndexKind.Number);
  return elementType !== undefined && (elementType.flags & ts.TypeFlags.Never) !== 0;
}
/**
 * Check if an empty array literal is in a position where adding `as any[]` would be invalid.
 * If true, we should NOT add `as any[]`.
 *
 * Note: We only check valid JavaScript patterns here. TypeScript-specific syntax
 * (type annotations, `as` expressions, etc.) cannot reach QuickJS execution, so
 * handling them here would be dead code.
 */
function hasInvalidAssertionContext(node: ts.ArrayLiteralExpression): boolean {
  const parent = node.parent;

  // Skip: `const [] = x` (destructuring pattern - array is on LHS)
  if (ts.isArrayBindingPattern(parent)) return true;

  // Skip: `([] = foo)` (destructuring assignment - array on LHS of =)
  // Adding `as any[]` here would produce invalid syntax: `([] as any[] = foo)`
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.left === node
  ) {
    return true;
  }

  // Skip: `for ([] of items)` / `for ([] in obj)` (array literal as loop LHS)
  // Adding `as any[]` here would produce invalid syntax in the loop header.
  if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === node) {
    return true;
  }

  return false;
}

function getNeverArrayLiteralStarts(
  code: string,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker
): Set<number> {
  const codeStart = WRAPPER_PREFIX.length;
  const codeEnd = codeStart + code.length;
  const starts = new Set<number>();

  function visit(node: ts.Node) {
    if (ts.isArrayLiteralExpression(node) && node.elements.length === 0) {
      const start = node.getStart(sourceFile);
      if (start >= codeStart && node.end <= codeEnd) {
        const contextualType = checker.getContextualType(node);
        const type = contextualType ?? checker.getTypeAtLocation(node);
        if (isNeverArrayType(type, checker)) {
          starts.add(start - codeStart);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return starts;
}

/**
 * Preprocess agent code to add type assertions to empty array literals.
 *
 * TypeScript infers `[]` as `never[]` when `strictNullChecks: true` and `noImplicitAny: false`.
 * This is documented behavior (GitHub issues #36987, #13140, #50505, #51979).
 * The TypeScript team recommends using type assertions: `[] as any[]`.
 *
 * This function transforms `[]` → `[] as any[]` for untyped empty arrays, enabling
 * all array operations (push, map, forEach, etc.) to work without type errors.
 */
function preprocessEmptyArrays(code: string, neverArrayStarts: Set<number>): string {
  if (neverArrayStarts.size === 0) {
    return code;
  }

  const sourceFile = ts.createSourceFile("temp.ts", code, ts.ScriptTarget.Latest, true);
  const edits: Array<{ pos: number; text: string }> = [];

  function visit(node: ts.Node) {
    if (ts.isArrayLiteralExpression(node) && node.elements.length === 0) {
      const start = node.getStart(sourceFile);
      if (neverArrayStarts.has(start) && !hasInvalidAssertionContext(node)) {
        const parent = node.parent;
        // `as` binds looser than unary operators, so wrap to keep the assertion on the literal.
        const needsParens =
          ts.isPropertyAccessExpression(parent) ||
          ts.isPropertyAccessChain(parent) ||
          ts.isElementAccessExpression(parent) ||
          ts.isElementAccessChain(parent) ||
          (ts.isCallExpression(parent) && parent.expression === node) ||
          (ts.isCallChain(parent) && parent.expression === node) ||
          ts.isPrefixUnaryExpression(parent) ||
          ts.isPostfixUnaryExpression(parent) ||
          ts.isTypeOfExpression(parent) ||
          ts.isVoidExpression(parent) ||
          ts.isDeleteExpression(parent) ||
          ts.isAwaitExpression(parent) ||
          ts.isYieldExpression(parent);

        if (needsParens) {
          edits.push({ pos: node.getStart(sourceFile), text: "(" });
          edits.push({ pos: node.end, text: " as any[])" });
        } else {
          edits.push({ pos: node.end, text: " as any[]" });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  // Apply edits in reverse order to preserve positions
  let result = code;
  for (const edit of edits.sort((a, b) => b.pos - a.pos)) {
    result = result.slice(0, edit.pos) + edit.text + result.slice(edit.pos);
  }
  return result;
}

export function validateTypes(code: string, xumTypes: string): TypeValidationResult {
  const compilerOptions: ts.CompilerOptions = {
    noEmit: true,
    strict: false, // Don't require explicit types on everything
    strictNullChecks: true, // Enable discriminated union narrowing (e.g., `if (!result.success) { result.error }`)
    noImplicitAny: false, // Allow any types
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    // ES2023 needed for Array.at(), findLast(), toSorted(), Object.hasOwn(), String.replaceAll()
    // QuickJS 0.31+ supports these features at runtime
    lib: ["lib.es2023.d.ts"],
  };

  // Preprocess empty arrays to avoid never[] inference without overriding contextual typing.
  const originalWrappedCode = wrapAgentCode(code);
  const {
    program: originalProgram,
    host,
    getSourceFile,
    setSourceFile,
  } = createProgramForCode(originalWrappedCode, xumTypes, compilerOptions);
  const originalSourceFile = getSourceFile();
  const neverArrayStarts = getNeverArrayLiteralStarts(
    code,
    originalSourceFile,
    originalProgram.getTypeChecker()
  );
  const preprocessedCode = preprocessEmptyArrays(code, neverArrayStarts);

  // Wrap code in function to allow return statements (matches runtime behavior)
  // Note: We don't use async because Asyncify makes xum.* calls appear synchronous
  // Types live in a separate virtual file so error line numbers match agent code directly.
  const wrappedCode = wrapAgentCode(preprocessedCode);

  let program = originalProgram;
  if (wrappedCode !== originalWrappedCode) {
    setSourceFile(wrappedCode);
    program = ts.createProgram(ROOT_FILE_NAMES, compilerOptions, host, originalProgram);
  }

  const sourceFile = program.getSourceFile("agent.ts") ?? getSourceFile();
  const checker = program.getTypeChecker();
  const diagnostics = ts.getPreEmitDiagnostics(program);

  // Identify variables used as dynamic "bag" objects (empty literal + bracket writes).
  // Dot-notation reads on these are suppressed since TS can't track dynamic properties.
  // We track by Symbol so shadowed names don't leak bag-ness across scopes.
  //
  // Note: suppression is order-sensitive (write-before-read) and function-scope-sensitive:
  // bracket writes only suppress dot reads in the same function-like container.
  const dynamicBagFirstWritePosByContainer = findDynamicEmptyObjectBagFirstWritePosByContainer(
    sourceFile,
    checker
  );

  // Filter to errors in our code only (not lib files)
  // Also filter console redeclaration warning (our minimal console conflicts with lib.dom)
  const errors: TypeValidationError[] = diagnostics
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .filter((d) => !d.file || d.file.fileName === "agent.ts")
    .filter((d) => !ts.flattenDiagnosticMessageText(d.messageText, "").includes("console"))
    // Allow dynamic property WRITES on empty object literals - Claude frequently uses
    // `const results = {}; results.foo = xum.file_read(...)` to collate parallel reads.
    // Only suppress when the property access is on the LEFT side of an assignment.
    .filter((d) => !isEmptyObjectWriteError(d, sourceFile))
    // Allow dot-notation READS on variables that are "dynamic bags" (empty literal + bracket
    // writes). These are valid JS patterns like `r[key] = val; return r.key` that TS can't
    // track. Does NOT suppress reads on plain `{}` without bracket writes (catches typos),
    // union types containing `{}`, or `xum`/`mux` shadowing.
    .filter(
      (d) => !isDynamicBagReadError(d, sourceFile, checker, dynamicBagFirstWritePosByContainer)
    )
    .map((d) => {
      const message = ts.flattenDiagnosticMessageText(d.messageText, " ");
      // Extract line number if available
      if (d.file && d.start !== undefined) {
        const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
        // TS line is 0-indexed. Wrapper adds 1 line before agent code, so:
        // TS line 0 = wrapper, TS line 1 = agent line 1, TS line 2 = agent line 2, etc.
        // This means TS 0-indexed line number equals agent 1-indexed line number.
        // Only report if within agent code bounds (filter out wrapper and xumTypes)
        const agentCodeLines = code.split("\n").length;
        if (line >= 1 && line <= agentCodeLines) {
          return { message, line, column: character + 1 };
        }
      }
      return { message };
    });

  return { valid: errors.length === 0, errors, sourceFile: originalSourceFile };
}
