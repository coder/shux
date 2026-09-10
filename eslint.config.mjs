// For more info, see https://github.com/storybookjs/eslint-plugin-storybook#configuration-flat-config-format
import storybook from "eslint-plugin-storybook";

import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import tailwindcss from "eslint-plugin-tailwindcss";
import tseslint from "typescript-eslint";

/**
 * Shared helpers for the rules ported from anti-slop
 * (https://github.com/dmmulroy/anti-slop). The common theme: values whose
 * types are syntactically evident (literals, typed bindings) must not flow
 * into explicitly broad types (`unknown`, `object`, `Record<string, ...>`)
 * that discard that evidence — push type information into the compiler
 * instead of re-deriving it at runtime or re-asserting it later.
 *
 * Differences from upstream (which targets oxlint's ESTree): typescript-eslint
 * does not emit ParenthesizedExpression/TSParenthesizedType nodes, and the
 * module-level type-alias/interface environment resolution is omitted — it
 * only adds catches (alias-of-Record etc.), so skipping it cannot introduce
 * false positives. An AST census (2026-08) showed the omission has zero
 * effect here: only 4 broad aliases existed repo-wide (UnknownRecord,
 * LogFields, JsonRecord, MetaRecord), every assertion through them sat on
 * un-evident values (JSON.parse/fetch results) where the rules stay silent
 * by design, and upstream's resolution is file-local anyway so cross-file
 * aliases would remain invisible even with the full port. Revisit only if
 * broad local aliases become common.
 */

/**
 * Unwrap only the transparent wrappers (non-null, satisfies) while keeping
 * assertions intact — for walks that must see assertion nodes themselves.
 */
function unwrapPassthroughWrappers(expression) {
  let current = expression;
  while (current.type === "TSNonNullExpression" || current.type === "TSSatisfiesExpression") {
    current = current.expression;
  }
  return current;
}

/** Unwrap assertion-like wrappers to reach the underlying value expression. */
function unwrapAssertions(expression) {
  let current = expression;
  while (
    current.type === "TSAsExpression" ||
    current.type === "TSTypeAssertion" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSSatisfiesExpression"
  ) {
    current = current.expression;
  }
  return current;
}

/** Expressions whose type is syntactically established at the use site. */
function isKnownEvidenceExpression(expression) {
  const current = unwrapAssertions(expression);
  return (
    current.type === "ObjectExpression" ||
    current.type === "ArrayExpression" ||
    current.type === "ArrowFunctionExpression" ||
    current.type === "ClassExpression" ||
    current.type === "FunctionExpression" ||
    current.type === "NewExpression" ||
    current.type === "Literal" ||
    current.type === "TemplateLiteral" ||
    current.type === "UnaryExpression"
  );
}

function isEmptyObjectExpression(expression) {
  const current = unwrapAssertions(expression);
  return current.type === "ObjectExpression" && current.properties.length === 0;
}

function resolveVariable(sourceCode, identifier) {
  let scope = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) {
      return variable;
    }
    scope = scope.upper;
  }
  return null;
}

function variableDeclarator(variable) {
  if (variable.defs.length !== 1) {
    return null;
  }
  const definition = variable.defs[0];
  return definition.type === "Variable" && definition.node.type === "VariableDeclarator"
    ? definition.node
    : null;
}

/** A `const` binding that is never reassigned after initialization. */
function isStableConstVariable(variable, declarator) {
  return (
    declarator.parent.type === "VariableDeclaration" &&
    declarator.parent.kind === "const" &&
    variable.references.every((reference) => reference.init || !reference.isWrite())
  );
}

/** True when the expression's type is syntactically known, tracing through stable consts. */
function hasKnownEvidence(sourceCode, expression, visitedVariables = new Set()) {
  if (isKnownEvidenceExpression(expression)) {
    return true;
  }
  const unwrapped = unwrapAssertions(expression);
  if (unwrapped.type !== "Identifier") {
    return false;
  }
  const variable = resolveVariable(sourceCode, unwrapped);
  if (variable === null || visitedVariables.has(variable)) {
    return false;
  }
  const declarator = variableDeclarator(variable);
  if (
    declarator === null ||
    declarator.init === null ||
    !isStableConstVariable(variable, declarator)
  ) {
    return false;
  }
  visitedVariables.add(variable);
  return hasKnownEvidence(sourceCode, declarator.init, visitedVariables);
}

const TRANSPARENT_TYPE_WRAPPERS = new Set(["Readonly", "Partial", "Required", "NonNullable"]);

function typeReferenceName(type) {
  return type.type === "TSTypeReference" && type.typeName.type === "Identifier"
    ? type.typeName.name
    : null;
}

function typeArgumentsOf(typeReference) {
  // typescript-eslint v8 uses typeArguments; older versions used typeParameters.
  return (typeReference.typeArguments ?? typeReference.typeParameters)?.params ?? [];
}

function unwrapReadonlyOperator(type) {
  let current = type;
  while (current.type === "TSTypeOperator" && current.operator === "readonly") {
    current = current.typeAnnotation;
  }
  return current;
}

/**
 * Classify explicitly broad target types that discard evidence when a known
 * value flows into them. Returns a human-readable kind or null.
 */
function classifyWideningTarget(type) {
  const unwrapped = unwrapReadonlyOperator(type);
  if (unwrapped.type === "TSUnknownKeyword") {
    return "unknown";
  }
  if (unwrapped.type === "TSObjectKeyword") {
    return "object";
  }
  if (unwrapped.type === "TSTypeLiteral") {
    // Upstream also classifies non-empty literals without an index signature
    // ("anonymous object"), but inline object annotations are idiomatic here
    // (296 prod sites) and the assertion case is already restricted by
    // @typescript-eslint/consistent-type-assertions, so we treat them as safe.
    return unwrapped.members.some((member) => member.type === "TSIndexSignature")
      ? "open dictionary"
      : null;
  }
  if (unwrapped.type === "TSMappedType") {
    return "open dictionary";
  }
  const name = typeReferenceName(unwrapped);
  if (name === null) {
    return null;
  }
  if (TRANSPARENT_TYPE_WRAPPERS.has(name)) {
    const [inner] = typeArgumentsOf(unwrapped);
    return inner === undefined ? null : classifyWideningTarget(inner);
  }
  return name === "Record" ? "open dictionary" : null;
}

function isBroadRecordKeyType(type) {
  if (
    type.type === "TSStringKeyword" ||
    type.type === "TSNumberKeyword" ||
    type.type === "TSSymbolKeyword"
  ) {
    return true;
  }
  if (type.type === "TSUnionType") {
    return type.types.every(isBroadRecordKeyType);
  }
  return typeReferenceName(type) === "PropertyKey";
}

function isUnknownOrAnyType(type) {
  return type.type === "TSUnknownKeyword" || type.type === "TSAnyKeyword";
}

/** `Record<broad-key, unknown|any>` or an index-signature-only literal of the same shape. */
function isBroadRecordType(type) {
  const unwrapped = unwrapReadonlyOperator(type);
  const name = typeReferenceName(unwrapped);
  if (name === "Readonly") {
    const [inner] = typeArgumentsOf(unwrapped);
    return inner !== undefined && isBroadRecordType(inner);
  }
  if (name === "Record") {
    const parameters = typeArgumentsOf(unwrapped);
    return (
      parameters.length === 2 &&
      isBroadRecordKeyType(parameters[0]) &&
      isUnknownOrAnyType(parameters[1])
    );
  }
  if (unwrapped.type !== "TSTypeLiteral" || unwrapped.members.length !== 1) {
    return false;
  }
  const [member] = unwrapped.members;
  return (
    member.type === "TSIndexSignature" &&
    member.parameters.length === 1 &&
    isBroadRecordKeyType(member.parameters[0].typeAnnotation.typeAnnotation) &&
    isUnknownOrAnyType(member.typeAnnotation.typeAnnotation)
  );
}

/** Broad-type kinds used by no-widen-then-assert. */
function broadTypeKind(type) {
  const unwrapped = unwrapReadonlyOperator(type);
  if (unwrapped.type === "TSUnknownKeyword" || unwrapped.type === "TSAnyKeyword") {
    return "top";
  }
  if (unwrapped.type === "TSObjectKeyword") {
    return "object";
  }
  return isBroadRecordType(unwrapped) ? "record" : null;
}

const FUNCTION_BOUNDARY_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression",
]);

function functionBoundary(node) {
  let current = node.parent;
  while (current != null && current.type !== "Program") {
    if (FUNCTION_BOUNDARY_TYPES.has(current.type)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/**
 * Custom ESLint plugin for safe Node.js patterns
 * Enforces safe child_process and filesystem patterns
 */
const localPlugin = {
  rules: {
    "no-unsafe-child-process": {
      meta: {
        type: "problem",
        docs: {
          description: "Prevent unsafe child_process usage that can cause zombie processes",
        },
        messages: {
          unsafePromisifyExec:
            "Do not use promisify(exec) directly. Use DisposableExec wrapper with 'using' declaration to prevent zombie processes.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            // Ban promisify(exec)
            if (
              node.callee.type === "Identifier" &&
              node.callee.name === "promisify" &&
              node.arguments.length > 0 &&
              node.arguments[0].type === "Identifier" &&
              node.arguments[0].name === "exec"
            ) {
              context.report({
                node,
                messageId: "unsafePromisifyExec",
              });
            }
          },
        };
      },
    },
    "no-sync-fs-methods": {
      meta: {
        type: "problem",
        docs: {
          description: "Prevent synchronous filesystem operations",
        },
        messages: {
          syncFsMethod:
            "Do not use synchronous fs methods ({{method}}). Use async version instead: {{asyncMethod}}",
        },
      },
      create(context) {
        // Map of sync methods to their async equivalents
        const syncMethods = {
          statSync: "stat",
          readFileSync: "readFile",
          writeFileSync: "writeFile",
          readdirSync: "readdir",
          mkdirSync: "mkdir",
          unlinkSync: "unlink",
          rmdirSync: "rmdir",
          existsSync: "access or stat",
          accessSync: "access",
          copyFileSync: "copyFile",
          renameSync: "rename",
          chmodSync: "chmod",
          chownSync: "chown",
          lstatSync: "lstat",
          linkSync: "link",
          symlinkSync: "symlink",
          readlinkSync: "readlink",
          realpathSync: "realpath",
          truncateSync: "truncate",
          fstatSync: "fstat",
          appendFileSync: "appendFile",
        };

        return {
          MemberExpression(node) {
            // Only flag if it's a property access on 'fs' or imported fs methods
            if (
              node.property &&
              node.property.type === "Identifier" &&
              syncMethods[node.property.name] &&
              node.object &&
              node.object.type === "Identifier" &&
              (node.object.name === "fs" || node.object.name === "fsPromises")
            ) {
              context.report({
                node,
                messageId: "syncFsMethod",
                data: {
                  method: node.property.name,
                  asyncMethod: syncMethods[node.property.name],
                },
              });
            }
          },
        };
      },
    },
    "no-cross-boundary-imports": {
      meta: {
        type: "problem",
        docs: {
          description: "Enforce folder boundaries to prevent architectural violations",
        },
        messages: {
          browserToNode:
            "browser/ cannot import from node/. Move shared code to common/ or use IPC.",
          nodeToDesktop:
            "node/ cannot import from desktop/. Move shared code to common/ or use dependency injection.",
          nodeToCli: "node/ cannot import from cli/. Move shared code to common/.",
          cliToBrowser: "cli/ cannot import from browser/. Move shared code to common/.",
          desktopToBrowser: "desktop/ cannot import from browser/. Move shared code to common/.",
        },
      },
      create(context) {
        return {
          ImportDeclaration(node) {
            // Allow type-only imports (for DI patterns)
            if (node.importKind === "type") {
              return;
            }

            const sourceFile = context.filename;
            const importPath = node.source.value;

            // Extract folder from source file (browser, node, desktop, cli, common)
            const sourceFolderMatch = sourceFile.match(
              /\/src\/(browser|node|desktop|cli|common)\//
            );
            if (!sourceFolderMatch) return;
            const sourceFolder = sourceFolderMatch[1];

            // Extract folder from import target
            // Handle relative imports (e.g., '../node/...')
            let targetFolder = null;
            if (importPath.startsWith("../")) {
              const targetMatch = importPath.match(/\.\.\/(browser|node|desktop|cli|common)\//);
              if (targetMatch) {
                targetFolder = targetMatch[1];
              }
            } else if (importPath.startsWith("@/")) {
              // Handle alias imports (e.g., '@/node/...')
              const targetMatch = importPath.match(/@\/(browser|node|desktop|cli|common)\//);
              if (targetMatch) {
                targetFolder = targetMatch[1];
              }
            }

            if (!targetFolder) return;

            // Allow imports from common
            if (targetFolder === "common") return;

            // Check for violations
            if (sourceFolder === "browser" && targetFolder === "node") {
              context.report({
                node,
                messageId: "browserToNode",
              });
            } else if (sourceFolder === "node" && targetFolder === "desktop") {
              context.report({
                node,
                messageId: "nodeToDesktop",
              });
            } else if (sourceFolder === "node" && targetFolder === "cli") {
              context.report({
                node,
                messageId: "nodeToCli",
              });
            } else if (sourceFolder === "cli" && targetFolder === "browser") {
              context.report({
                node,
                messageId: "cliToBrowser",
              });
            } else if (sourceFolder === "desktop" && targetFolder === "browser") {
              context.report({
                node,
                messageId: "desktopToBrowser",
              });
            }
          },
        };
      },
    },
    "no-native-interactive-tooltips": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Disallow native title tooltips on interactive controls when the content is long or dynamic",
        },
        messages: {
          useTooltip:
            "Native title tooltips on raw interactive elements truncate easily when the content is long or dynamic. Use the shared Tooltip surface instead, or pass `title` through a shared control that intercepts it.",
        },
      },
      create(context) {
        const MAX_NATIVE_TOOLTIP_LENGTH = 20;
        const INTERACTIVE_TAGS = new Set(["button", "input", "select", "textarea"]);

        const getAttribute = (node, attributeName) =>
          node.attributes.find(
            (attribute) =>
              attribute.type === "JSXAttribute" &&
              attribute.name.type === "JSXIdentifier" &&
              attribute.name.name === attributeName
          ) ?? null;

        const getStaticString = (expression) => {
          if (!expression) {
            return null;
          }

          if (expression.type === "Literal") {
            return typeof expression.value === "string" ? expression.value : null;
          }

          if (expression.type === "TemplateLiteral" && expression.expressions.length === 0) {
            return expression.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("");
          }

          return null;
        };

        const isProblematicTitleExpression = (expression) => {
          if (!expression) {
            return false;
          }

          if (expression.type === "Literal") {
            if (expression.value == null) {
              return false;
            }

            return (
              typeof expression.value === "string" &&
              (expression.value.includes("\n") ||
                expression.value.length > MAX_NATIVE_TOOLTIP_LENGTH)
            );
          }

          if (expression.type === "TemplateLiteral") {
            if (expression.expressions.length > 0) {
              return true;
            }

            const value = getStaticString(expression);
            return value !== null
              ? value.includes("\n") || value.length > MAX_NATIVE_TOOLTIP_LENGTH
              : true;
          }

          if (expression.type === "ConditionalExpression") {
            return (
              isProblematicTitleExpression(expression.consequent) ||
              isProblematicTitleExpression(expression.alternate)
            );
          }

          const staticValue = getStaticString(expression);
          if (staticValue !== null) {
            return staticValue.includes("\n") || staticValue.length > MAX_NATIVE_TOOLTIP_LENGTH;
          }

          return true;
        };

        return {
          JSXOpeningElement(node) {
            if (node.name.type !== "JSXIdentifier") {
              return;
            }

            const elementName = node.name.name;
            if (elementName !== elementName.toLowerCase()) {
              return;
            }

            const onClickAttribute = getAttribute(node, "onClick");
            const hrefAttribute = getAttribute(node, "href");
            const roleAttribute = getAttribute(node, "role");
            const roleValue =
              roleAttribute &&
              roleAttribute.value?.type === "Literal" &&
              typeof roleAttribute.value.value === "string"
                ? roleAttribute.value.value
                : null;
            const isInteractive =
              INTERACTIVE_TAGS.has(elementName) ||
              (elementName === "a" && hrefAttribute !== null) ||
              onClickAttribute !== null ||
              roleValue === "button" ||
              roleValue === "link" ||
              roleValue === "switch";
            if (!isInteractive) {
              return;
            }

            const titleAttribute = getAttribute(node, "title");
            if (!titleAttribute || !titleAttribute.value) {
              return;
            }

            // Normalize: Literal value nodes and JSXExpressionContainer inner
            // expressions are both valid AST expression nodes that
            // isProblematicTitleExpression already handles.
            let expression;
            if (titleAttribute.value.type === "Literal") {
              expression = titleAttribute.value;
            } else if (titleAttribute.value.type === "JSXExpressionContainer") {
              expression = titleAttribute.value.expression;
            } else {
              return;
            }

            if (isProblematicTitleExpression(expression)) {
              context.report({
                node: titleAttribute,
                messageId: "useTooltip",
              });
            }
          },
        };
      },
    },
    // Ported from anti-slop (https://github.com/dmmulroy/anti-slop).
    // Chained assertions like `x as unknown as T` fabricate type evidence:
    // the detour through `unknown` bypasses TypeScript's assertion overlap
    // check, so any value can be relabeled as any type. Fix the source type,
    // or validate untrusted input at the boundary (type guard / zod) instead.
    // Chains made only of `as const` are allowed.
    "no-chained-type-assertions": {
      meta: {
        type: "problem",
        docs: {
          description: "Disallow chained type assertions (e.g. `x as unknown as T`)",
        },
        messages: {
          chained:
            "Chained type assertions discard type evidence. Keep the original precise type, fix the source type, or parse/validate untrusted input at its boundary before narrowing.",
        },
      },
      create(context) {
        const isAssertion = (node) =>
          node.type === "TSAsExpression" || node.type === "TSTypeAssertion";
        const isConstAssertion = (node) =>
          node.typeAnnotation.type === "TSTypeReference" &&
          node.typeAnnotation.typeName.type === "Identifier" &&
          node.typeAnnotation.typeName.name === "const";
        // Non-null and satisfies wrappers are transparent links in a chain:
        // `(x as unknown)! as T` fabricates evidence exactly like
        // `x as unknown as T`, so traverse them in both walk directions.
        const isPassthrough = (node) =>
          node.type === "TSNonNullExpression" || node.type === "TSSatisfiesExpression";
        const unwrapPassthrough = (node) => {
          let current = node;
          while (isPassthrough(current)) {
            current = current.expression;
          }
          return current;
        };
        const check = (node) => {
          // Report once, from the outermost assertion of a chain.
          let child = node;
          let parent = node.parent;
          while (isPassthrough(parent) && parent.expression === child) {
            child = parent;
            parent = parent.parent;
          }
          if (isAssertion(parent) && parent.expression === child) {
            return;
          }
          let assertionCount = 0;
          let hasNonConstAssertion = false;
          let current = node;
          while (isAssertion(current)) {
            assertionCount += 1;
            hasNonConstAssertion ||= !isConstAssertion(current);
            current = unwrapPassthrough(current.expression);
          }
          if (assertionCount > 1 && hasNonConstAssertion) {
            context.report({ node, messageId: "chained" });
          }
        };
        return {
          TSAsExpression: check,
          TSTypeAssertion: check,
        };
      },
    },
    // Ported from anti-slop (https://github.com/dmmulroy/anti-slop).
    // `...(cond ? { x } : {})` hides property omission behind an empty-object
    // spread; the compiler sees `x` as merely optional instead of knowing when
    // it is present. Only fires inside object literals (JSX spread attributes
    // are exempt).
    "no-conditional-empty-object-spread": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Disallow object spreads that conditionally spread an empty object to omit fields",
        },
        messages: {
          avoid:
            "Conditional empty-object spread hides property omission. Build the object in separate statements and add the property only when present.",
        },
      },
      create(context) {
        const isEmptyObjectExpression = (node) =>
          node.type === "ObjectExpression" && node.properties.length === 0;
        return {
          SpreadElement(node) {
            if (node.parent.type !== "ObjectExpression") {
              return;
            }
            const argument = node.argument;
            if (
              argument.type === "ConditionalExpression" &&
              (isEmptyObjectExpression(argument.consequent) ||
                isEmptyObjectExpression(argument.alternate))
            ) {
              context.report({ node, messageId: "avoid" });
            }
          },
        };
      },
    },
    // Ported from anti-slop (https://github.com/dmmulroy/anti-slop).
    // When a value's type is syntactically known (a literal, or a stable const
    // tracing back to one), annotating or asserting it as `unknown`, `object`,
    // or `Record<...>` throws away evidence the compiler already had. Keep
    // inference, validate with `satisfies`, or use a named owner type.
    // Empty object literals flowing into dictionary types are exempt
    // (accumulator pattern: `const acc: Record<string, X> = {}`).
    "no-known-value-widening": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Disallow explicitly widening syntactically known values to broad types that discard type evidence",
        },
        messages: {
          widening:
            "The explicit {{target}} type on {{subject}} discards known type evidence. Keep inference, validate with `satisfies`, or use a named owner type.",
        },
        schema: [
          {
            type: "object",
            properties: {
              // When false, only assertion-position widening (`x as unknown`,
              // `{...} as Record<string, unknown>`) is checked; annotation
              // flows (bindings, returns, class properties) are left alone.
              checkAnnotations: { type: "boolean" },
            },
            additionalProperties: false,
          },
        ],
      },
      create(context) {
        const sourceCode = context.sourceCode;
        const checkAnnotations = context.options[0]?.checkAnnotations ?? true;

        const reportFlow = (expression, targetKind, subject) => {
          if (targetKind === null) {
            return;
          }
          if (targetKind === "open dictionary" && isEmptyObjectExpression(expression)) {
            return;
          }
          if (!hasKnownEvidence(sourceCode, expression)) {
            return;
          }
          context.report({
            node: expression,
            messageId: "widening",
            data: { target: targetKind, subject },
          });
        };

        const annotationTarget = (annotation) =>
          annotation == null || !checkAnnotations
            ? null
            : classifyWideningTarget(annotation.typeAnnotation);

        const checkAssertion = (node) => {
          // Skip inner assertions of chains; no-chained-type-assertions owns those.
          if (node.parent.type === "TSAsExpression" || node.parent.type === "TSTypeAssertion") {
            return;
          }
          reportFlow(node.expression, classifyWideningTarget(node.typeAnnotation), "assertion");
        };

        return {
          VariableDeclarator(node) {
            if (node.init === null || node.id.type !== "Identifier") {
              return;
            }
            reportFlow(
              node.init,
              annotationTarget(node.id.typeAnnotation),
              `binding \`${node.id.name}\``
            );
          },
          PropertyDefinition(node) {
            if (node.value === null) {
              return;
            }
            reportFlow(node.value, annotationTarget(node.typeAnnotation), "class property");
          },
          AssignmentExpression(node) {
            if (node.operator !== "=" || node.left.type !== "Identifier") {
              return;
            }
            const variable = resolveVariable(sourceCode, node.left);
            if (variable === null) {
              return;
            }
            const declarator = variableDeclarator(variable);
            if (declarator === null || declarator.id.type !== "Identifier") {
              return;
            }
            reportFlow(
              node.right,
              annotationTarget(declarator.id.typeAnnotation),
              `binding \`${declarator.id.name}\``
            );
          },
          ReturnStatement(node) {
            if (node.argument === null) {
              return;
            }
            const owner = functionBoundary(node);
            reportFlow(node.argument, annotationTarget(owner?.returnType), "the return value");
          },
          ArrowFunctionExpression(node) {
            if (node.body.type === "BlockStatement") {
              return;
            }
            reportFlow(node.body, annotationTarget(node.returnType), "the return value");
          },
          TSAsExpression: checkAssertion,
          TSTypeAssertion: checkAssertion,
        };
      },
    },
    // Ported from anti-slop (https://github.com/dmmulroy/anti-slop).
    // Closes the two-step evasion of no-chained-type-assertions: widening a
    // known value into a broad const binding (`const tmp: unknown = value`)
    // and later asserting the binding back to a narrower type (`tmp as Foo`)
    // is the same evidence-fabrication as `value as unknown as Foo`.
    "no-widen-then-assert": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Disallow widening a known value into a broad const binding and later asserting it back to a narrower type",
        },
        messages: {
          widenThenAssert:
            "Binding `{{name}}` discards type evidence and later recreates it with an assertion. Keep the precise type from initialization through use; parse boundary input once.",
        },
      },
      create(context) {
        const sourceCode = context.sourceCode;

        // Like hasKnownEvidence, but returns the source-type annotation when
        // one exists (typed params/bindings count) and stays within the same
        // function boundary. Returns { type } on evidence, null otherwise.
        const knownValueEvidence = (expression, boundary, visitedVariables) => {
          // See through `!`/`satisfies` so a wrapped assertion like
          // `(value as Foo)!` is still recognized as the evidence assertion.
          const withoutPassthroughs = unwrapPassthroughWrappers(expression);
          if (
            withoutPassthroughs.type === "TSAsExpression" ||
            withoutPassthroughs.type === "TSTypeAssertion"
          ) {
            // An assertion to a broad type destroys evidence; a narrower one is evidence.
            return broadTypeKind(withoutPassthroughs.typeAnnotation) === null
              ? { type: withoutPassthroughs.typeAnnotation }
              : null;
          }
          const unwrapped = unwrapAssertions(expression);
          if (isKnownEvidenceExpression(unwrapped)) {
            return { type: null };
          }
          if (unwrapped.type !== "Identifier") {
            return null;
          }
          const variable = resolveVariable(sourceCode, unwrapped);
          if (variable === null || visitedVariables.has(variable)) {
            return null;
          }
          const annotatedIdentifier = variable.identifiers.find(
            (identifier) => identifier.typeAnnotation != null
          );
          if (annotatedIdentifier !== undefined) {
            const annotation = annotatedIdentifier.typeAnnotation.typeAnnotation;
            if (
              functionBoundary(annotatedIdentifier) !== boundary ||
              broadTypeKind(annotation) !== null
            ) {
              return null;
            }
            return { type: annotation };
          }
          // Destructured parameters carry their annotation on the pattern,
          // not the identifier: `({ value }: { value: Foo })`. Resolve the
          // member type from an inline literal annotation; named type
          // references stay unresolvable (conservative: miss, never
          // false-positive).
          for (const identifier of variable.identifiers) {
            // Walk outward through (possibly nested) object patterns,
            // collecting the member path innermost-first, until we reach the
            // pattern that carries the annotation:
            //   { nested: { value } }: { nested: { value: Foo } }
            // yields path [value, nested] anchored at the outer annotation.
            // Array patterns and computed keys abort (conservative).
            const path = [];
            let node = identifier;
            let annotation = null;
            let annotatedPattern = null;
            for (;;) {
              let holder = node.parent;
              if (holder.type === "AssignmentPattern" && holder.left === node) {
                node = holder;
                holder = node.parent;
              }
              if (
                holder.type !== "Property" ||
                holder.parent.type !== "ObjectPattern" ||
                holder.key.type !== "Identifier" ||
                holder.computed
              ) {
                break;
              }
              path.push(holder.key.name);
              node = holder.parent;
              const patternAnnotation = node.typeAnnotation?.typeAnnotation;
              if (patternAnnotation != null) {
                annotation = patternAnnotation;
                annotatedPattern = node;
                break;
              }
            }
            if (annotation === null || functionBoundary(annotatedPattern) !== boundary) {
              continue;
            }
            // Resolve the path outermost-first through inline type literals;
            // named type references stay unresolvable (conservative).
            let memberType = annotation;
            for (let i = path.length - 1; i >= 0; i -= 1) {
              if (memberType.type !== "TSTypeLiteral") {
                memberType = null;
                break;
              }
              const keyName = path[i];
              const member = memberType.members.find(
                (candidate) =>
                  candidate.type === "TSPropertySignature" &&
                  candidate.key.type === "Identifier" &&
                  candidate.key.name === keyName &&
                  candidate.typeAnnotation != null
              );
              if (member === undefined) {
                memberType = null;
                break;
              }
              memberType = member.typeAnnotation.typeAnnotation;
            }
            if (memberType === null) {
              continue;
            }
            return broadTypeKind(memberType) === null ? { type: memberType } : null;
          }
          const declarator = variableDeclarator(variable);
          if (
            declarator === null ||
            declarator.init === null ||
            !isStableConstVariable(variable, declarator) ||
            functionBoundary(declarator) !== boundary
          ) {
            return null;
          }
          return knownValueEvidence(
            declarator.init,
            boundary,
            new Set([...visitedVariables, variable])
          );
        };

        // A stable const whose declared annotation (or initializer assertion)
        // erases known evidence into a broad type.
        const widenedBinding = (variable) => {
          const declarator = variableDeclarator(variable);
          if (
            declarator === null ||
            declarator.id.type !== "Identifier" ||
            declarator.init === null ||
            !isStableConstVariable(variable, declarator)
          ) {
            return null;
          }
          const boundary = functionBoundary(declarator);
          const declaredType = declarator.id.typeAnnotation?.typeAnnotation;
          // `const tmp = (value as unknown)!` widens exactly like
          // `const tmp = value as unknown`; see through transparent wrappers.
          const init = unwrapPassthroughWrappers(declarator.init);
          const initAssertion =
            init.type === "TSAsExpression" || init.type === "TSTypeAssertion" ? init : null;
          const initBroadKind =
            initAssertion === null ? null : broadTypeKind(initAssertion.typeAnnotation);
          const declaredBroadKind = declaredType === undefined ? null : broadTypeKind(declaredType);
          const broadKind = declaredBroadKind ?? initBroadKind;
          if (broadKind === null) {
            return null;
          }
          const originalExpression =
            initAssertion !== null && initBroadKind !== null ? initAssertion.expression : init;
          const evidence = knownValueEvidence(originalExpression, boundary, new Set([variable]));
          if (evidence === null) {
            return null;
          }
          return { broadKind, evidence, declaredAt: declarator.range[1], boundary };
        };

        const normalizedTypeText = (type) =>
          sourceCode.text.slice(type.range[0], type.range[1]).replace(/\s+/gu, "");

        const isDefinitelyObjectType = (type) => {
          const unwrapped = unwrapReadonlyOperator(type);
          switch (unwrapped.type) {
            case "TSArrayType":
            case "TSConstructorType":
            case "TSFunctionType":
            case "TSMappedType":
            case "TSObjectKeyword":
            case "TSTupleType":
              return true;
            case "TSTypeLiteral":
              return unwrapped.members.length > 0;
            case "TSIntersectionType":
              return unwrapped.types.every(isDefinitelyObjectType);
            default:
              return false;
          }
        };

        const isDefinitelyNarrowerRecordType = (type) => {
          const unwrapped = unwrapReadonlyOperator(type);
          if (unwrapped.type === "TSTypeLiteral") {
            return unwrapped.members.some((member) => member.type !== "TSIndexSignature");
          }
          const name = typeReferenceName(unwrapped);
          if (name === "Readonly") {
            const [inner] = typeArgumentsOf(unwrapped);
            return inner !== undefined && isDefinitelyNarrowerRecordType(inner);
          }
          if (name !== "Record") {
            return false;
          }
          const parameters = typeArgumentsOf(unwrapped);
          return parameters.length === 2 && !isUnknownOrAnyType(parameters[1]);
        };

        const assertionIsNarrower = (broadKind, evidence, assertedType) => {
          if (broadTypeKind(assertedType) !== null) {
            return false;
          }
          if (broadKind === "top") {
            return true;
          }
          if (
            evidence.type !== null &&
            normalizedTypeText(evidence.type) === normalizedTypeText(assertedType)
          ) {
            return true;
          }
          if (broadKind === "object") {
            return isDefinitelyObjectType(assertedType);
          }
          return isDefinitelyNarrowerRecordType(assertedType);
        };

        const checkAssertion = (node) => {
          const expression = unwrapAssertions(node.expression);
          if (expression.type !== "Identifier") {
            return;
          }
          const variable = resolveVariable(sourceCode, expression);
          if (variable === null) {
            return;
          }
          const widened = widenedBinding(variable);
          if (
            widened === null ||
            node.range[0] <= widened.declaredAt ||
            functionBoundary(node) !== widened.boundary ||
            !assertionIsNarrower(widened.broadKind, widened.evidence, node.typeAnnotation)
          ) {
            return;
          }
          context.report({
            node,
            messageId: "widenThenAssert",
            data: { name: expression.name },
          });
        };

        return {
          TSAsExpression: checkAssertion,
          TSTypeAssertion: checkAssertion,
        };
      },
    },
    // Ported from anti-slop (https://github.com/dmmulroy/anti-slop).
    // `type Foo = unknown` conceals the top type behind a name, so call sites
    // look typed while carrying no information. Keep `unknown` visible at the
    // parsing boundary or use the parsed owner type.
    "no-unknown-type-aliases": {
      meta: {
        type: "problem",
        docs: {
          description: "Disallow type aliases that resolve to bare `unknown`",
        },
        messages: {
          unknownAlias:
            "Type alias `{{alias}}` hides `unknown`. Keep `unknown` explicit at the parsing boundary; otherwise use the parsed owner type.",
        },
      },
      create(context) {
        // Visit every alias declaration (module, function, block, namespace
        // scope), not just Program.body, then evaluate once at Program:exit
        // so transitive chains resolve regardless of declaration order.
        const AMBIGUOUS = Symbol("ambiguous");
        const aliasesByName = new Map();
        const allAliases = [];
        return {
          TSTypeAliasDeclaration(node) {
            allAliases.push(node);
            // Name-based resolution is scope-insensitive; treat duplicate
            // names as unresolvable rather than guessing which shadows which.
            aliasesByName.set(node.id.name, aliasesByName.has(node.id.name) ? AMBIGUOUS : node);
          },
          "Program:exit"() {
            const resolvesToUnknown = (type, visited) => {
              if (type.type === "TSUnknownKeyword") {
                return true;
              }
              const name = typeReferenceName(type);
              if (name === null || visited.has(name) || typeArgumentsOf(type).length > 0) {
                return false;
              }
              const alias = aliasesByName.get(name);
              if (alias === undefined || alias === AMBIGUOUS || alias.typeParameters != null) {
                return false;
              }
              return resolvesToUnknown(alias.typeAnnotation, new Set([...visited, name]));
            };
            for (const alias of allAliases) {
              if (resolvesToUnknown(alias.typeAnnotation, new Set([alias.id.name]))) {
                context.report({
                  node: alias.id,
                  messageId: "unknownAlias",
                  data: { alias: alias.id.name },
                });
              }
            }
          },
        };
      },
    },
    // Ported from anti-slop (https://github.com/dmmulroy/anti-slop).
    // The bare `object` type carries almost no information (no property is
    // accessible) while still excluding primitives, so it is neither a safe
    // boundary type (`unknown` is) nor a useful contract (a named type is).
    "no-object-parameters": {
      meta: {
        type: "problem",
        docs: {
          description: "Disallow the broad `object` type on function parameters",
        },
        messages: {
          objectParameter:
            "Parameter `{{parameter}}` uses the broad `object` type. Accept a named owner type, or `unknown` plus parsing at the boundary.",
        },
      },
      create(context) {
        const parameterAnnotation = (parameter) => {
          if (parameter.type === "TSParameterProperty") {
            return parameterAnnotation(parameter.parameter);
          }
          if (parameter.type === "AssignmentPattern") {
            return parameter.left.typeAnnotation;
          }
          return parameter.typeAnnotation;
        };
        const isObjectType = (type) => {
          if (type.type === "TSObjectKeyword") {
            return true;
          }
          if (type.type === "TSUnionType") {
            return type.types.some(isObjectType);
          }
          return false;
        };
        const checkParameters = (node) => {
          for (const parameter of node.params) {
            const annotation = parameterAnnotation(parameter);
            if (annotation != null && isObjectType(annotation.typeAnnotation)) {
              context.report({
                node: parameter,
                messageId: "objectParameter",
                data: {
                  parameter: parameter.type === "Identifier" ? parameter.name : "(destructured)",
                },
              });
            }
          }
        };
        return {
          ArrowFunctionExpression: checkParameters,
          FunctionDeclaration: checkParameters,
          FunctionExpression: checkParameters,
          TSDeclareFunction: checkParameters,
          TSEmptyBodyFunctionExpression: checkParameters,
          TSMethodSignature: checkParameters,
          TSFunctionType: checkParameters,
          TSCallSignatureDeclaration: checkParameters,
          TSConstructSignatureDeclaration: checkParameters,
          TSConstructorType: checkParameters,
        };
      },
    },
  },
};

export default defineConfig([
  {
    ignores: [
      "dist/",
      "build/",
      "node_modules/",
      "*.js",
      "*.cjs",
      "*.mjs",
      "!eslint.config.mjs",
      "vite.config.ts",
      "electron.vite.config.ts",
      "src/browser/main.tsx",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        exports: "writable",
        module: "writable",
        require: "readonly",
        global: "readonly",
        window: "readonly",
        document: "readonly",
        requestAnimationFrame: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        navigator: "readonly",
        alert: "readonly",
      },
    },
    plugins: {
      react,
      "react-hooks": reactHooks,
      tailwindcss,
      local: localPlugin,
    },
    linterOptions: {
      // Grandfathered anti-slop violations are marked with per-site
      // eslint-disable-next-line directives. Erroring on unused directives
      // makes that a true shrink-only ratchet: fixing a site forces removal
      // of its directive, and the directive cannot silently outlive the code.
      reportUnusedDisableDirectives: "error",
    },
    settings: {
      react: {
        version: "detect",
      },
      tailwindcss: {
        // Don't try to load Tailwind config (v4 doesn't export resolveConfig)
        config: false,
        // CSS files to check
        cssFiles: ["**/*.css", "!**/node_modules", "!**/.*", "!**/dist", "!**/build"],
        // Disable callees check to avoid resolving config
        callees: [],
      },
    },
    rules: {
      ...react.configs.recommended.rules,
      // Use recommended-latest to get React Compiler lint rules
      ...reactHooks.configs["recommended-latest"].rules,

      // Flag unused variables, parameters, and imports
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          vars: "all",
          args: "after-used",
          ignoreRestSiblings: true,
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "all",
        },
      ],

      // Prohibit 'as any' type assertions
      "@typescript-eslint/no-explicit-any": "error",

      // Additional rule to catch 'as any' specifically
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        {
          assertionStyle: "as",
          objectLiteralTypeAssertions: "allow-as-parameter",
        },
      ],

      // Enforce shorthand array notation, e.g. Foo[] instead of Array<Foo>
      "@typescript-eslint/array-type": [
        "error",
        {
          default: "array-simple",
          readonly: "array-simple",
        },
      ],

      // Keep type-only imports explicit to avoid runtime inclusion
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          disallowTypeAnnotations: true,
        },
      ],

      // Require handling Promises instead of letting them float
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          ignoreVoid: true,
          ignoreIIFE: true,
        },
      ],

      // Highlight unnecessary assertions to keep code idiomatic
      "@typescript-eslint/no-unnecessary-type-assertion": "error",

      // Switches over union types must handle every member (or declare an
      // explicit default). Pairs with the Record<Enum, Value> mapping rule:
      // adding a union member then surfaces every switch that needs updating.
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        {
          // A default case counts as handling the rest; without this the rule
          // would force enumerating members that intentionally share one path.
          considerDefaultExhaustiveForUnions: true,
        },
      ],

      // Encourage readonly where possible to surface unintended mutations
      "@typescript-eslint/prefer-readonly": [
        "error",
        {
          onlyInlineLambdas: true,
        },
      ],

      // Prevent using any type at all
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",

      // React specific
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",

      // Tailwind CSS
      "tailwindcss/classnames-order": "warn",
      "tailwindcss/enforces-negative-arbitrary-values": "warn",
      "tailwindcss/enforces-shorthand": "warn",
      "tailwindcss/migration-from-tailwind-2": "warn",
      "tailwindcss/no-arbitrary-value": "off",
      "tailwindcss/no-contradicting-classname": "error",
      "tailwindcss/no-custom-classname": "off",

      // Safe Node.js patterns
      "local/no-unsafe-child-process": "error",
      "local/no-sync-fs-methods": "error",
      "local/no-cross-boundary-imports": "error",

      "local/no-native-interactive-tooltips": "error",

      // Anti-slop ports (see localPlugin). Chained assertions are banned in
      // production code; test/story/mock files are exempt (casting partial
      // doubles through `unknown` is the standard mock idiom). Pre-existing
      // violations carry per-site eslint-disable-next-line directives so new
      // violations fail lint even in files that contain grandfathered ones.
      "local/no-chained-type-assertions": "error",
      // Implemented but not enforced: 629 existing occurrences across 145
      // files use `...(cond ? { x } : {})` deliberately to omit keys
      // (omitted-vs-undefined matters for JSON serialization and spread
      // merging). Flip to "error" only after a codebase-wide cleanup.
      "local/no-conditional-empty-object-spread": "off",
      // Assertion-position widening of known values (`{...} as Record<string,
      // unknown>`, `literal as unknown`) is never necessary — an annotation or
      // `satisfies` always works and, unlike an assertion, cannot mask typos.
      // Annotation flows stay unchecked (checkAnnotations: false): 247 prod
      // sites include semantically required open dictionaries (arbitrary-key
      // tables like `Record<string, LucideIcon>` need the index signature at
      // call sites), the `Record<Enum, Value>` exhaustive-mapping pattern this
      // repo mandates, and legit `unknown`-returning boundary parsers.
      "local/no-known-value-widening": ["error", { checkAnnotations: false }],
      "local/no-widen-then-assert": "error",
      "local/no-unknown-type-aliases": "error",
      "local/no-object-parameters": "error",

      // Allow console for this app (it's a dev tool)
      "no-console": "off",

      // Allow require in specific contexts
      "@typescript-eslint/no-var-requires": "off",

      // Enforce absolute imports with @/ alias for cross-directory imports
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../!(tests)*", "../../!(tests)*"],
              message:
                "Use absolute imports with @/ instead of relative parent imports. Same-directory imports (./foo) are allowed.",
            },
          ],
        },
      ],

      // Warn on TODO comments
      "no-warning-comments": [
        "off",
        {
          terms: ["TODO", "FIXME", "XXX", "HACK"],
          location: "start",
        },
      ],

      // Enable TypeScript deprecation warnings
      "@typescript-eslint/prefer-ts-expect-error": "error",

      // Ban @ts-ignore comments and suggest @ts-expect-error instead
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": "allow-with-description",
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-check": false,
          minimumDescriptionLength: 3,
        },
      ],

      // Ban dynamic imports - they hide circular dependencies and should be avoided
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message:
            "Dynamic imports are not allowed. Use static imports at the top of the file instead. Dynamic imports hide circular dependencies and improper module structure.",
        },
      ],

      // Prevent accidentally interpolating undefined/null in template literals and JSX
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        {
          allowNumber: true,
          allowBoolean: true,
          allowAny: false,
          allowNullish: false, // Catch undefined/null interpolations
          allowRegExp: false,
        },
      ],
    },
  },
  {
    // Allow dynamic imports for lazy-loading (startup optimization / platform compat)
    files: [
      "src/services/aiService.ts",
      "src/utils/tools/tools.ts",
      "src/utils/ai/providerFactory.ts",
      "src/utils/main/tokenizer.ts",
      "src/node/runtime/SSH2ConnectionPool.ts",
    ],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
  {
    // Temporarily allow sync fs methods in files with existing usage
    // TODO: Gradually migrate these to async operations
    files: [
      "src/node/config/index.ts",
      "src/node/config/**/*.ts",
      "src/cli/debug/**/*.ts",
      "src/node/git.ts",
      "src/desktop/main.ts",
      "src/node/config.test.ts",
      "src/node/services/gitService.ts",
      "src/node/services/log.ts",
      "src/node/services/streamManager.ts",
      "src/node/services/tempDir.ts",
      "src/node/services/tools/bash.ts",
      "src/node/services/tools/bash.test.ts",
      "src/node/services/tools/testHelpers.ts",
      "src/node/utils/providerRequirements.ts",
    ],
    rules: {
      "local/no-sync-fs-methods": "off",
    },
  },
  {
    // Frontend architectural boundary - prevent services and tokenizer imports
    // Note: src/browser/utils/** and src/browser/stores/** are not included because:
    // - Some utils are shared between main/renderer (e.g., utils/tools registry)
    // - Stores can import from utils/messages which is renderer-safe
    // - Type-only imports from services are safe (types live in src/common/types/)
    files: [
      "src/browser/components/**",
      "src/browser/contexts/**",
      "src/browser/hooks/**",
      "src/browser/App.tsx",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/services/**", "../services/**", "../../services/**"],
              message:
                "Frontend code cannot import from services/. Use IPC or move shared code to utils/.",
            },
            {
              group: ["**/tokens/tokenizer", "**/tokens/tokenStatsCalculator"],
              message:
                "Frontend code cannot import tokenizer (2MB+ encodings). Use @/utils/tokens/usageAggregator for aggregation or @/utils/tokens/modelStats for pricing.",
            },
            {
              group: ["**/utils/main/**", "@/utils/main/**"],
              message:
                "Frontend code cannot import from utils/main/ (contains Node.js APIs). Move shared code to utils/ or use IPC.",
            },
          ],
        },
      ],
    },
  },
  {
    // Shiki must only be imported in the highlight worker to avoid blocking main thread
    // Type-only imports are allowed (erased at compile time)
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["src/browser/workers/highlightWorker.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["shiki"],
              importNamePattern: "^(?!type\\s)",
              allowTypeImports: true,
              message:
                "Shiki must only be imported in highlightWorker.ts to avoid blocking the main thread. Use highlightCode() from highlightWorkerClient.ts instead.",
            },
          ],
        },
      ],
    },
  },
  {
    // ORPC must import config schemas via direct file paths, never the schemas barrel
    files: ["src/common/orpc/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/common/config/schemas",
              message:
                "Import config schemas via direct file paths (e.g., @/common/config/schemas/appConfigOnDisk), not the barrel.",
            },
            {
              name: "@/common/config/schemas/index",
              message:
                "Import config schemas via direct file paths (e.g., @/common/config/schemas/appConfigOnDisk), not the barrel.",
            },
          ],
        },
      ],
    },
  },
  {
    // Config schemas must remain independent from ORPC schema definitions
    files: ["src/common/config/schemas/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/common/orpc/schemas/*", "**/orpc/schemas/*"],
              message:
                "Config schemas must not import from ORPC; use @/common/schemas/* or @/common/config/schemas/* instead.",
            },
          ],
        },
      ],
    },
  },
  {
    // Renderer process (frontend) architectural boundary - prevent Node.js API usage
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: [
      "src/cli/**",
      "src/desktop/**",
      "src/node/**",
      "**/*.test.ts",
      "**/*.test.tsx",
      // This file is only used by Node.js code (cli/debug) but lives in common/
      // TODO: Consider moving to node/utils/
      "src/common/utils/providers/ensureProvidersConfig.ts",
      // Telemetry uses defensive process checks for test environments
      "src/common/telemetry/**",
    ],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "process",
          message:
            "Renderer code cannot access 'process' global (not available in renderer). Use IPC to communicate with main process or use constants for environment-agnostic values.",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message:
            "Renderer code cannot access process.env (not available in renderer). Use IPC to get environment variables from main process or use constants.",
        },
      ],
    },
  },
  {
    // Workflow/action/runtime and script helper sources are plain JS evaluated outside the TS
    // program (QuickJS, skill assets, generated child-process wrappers, or local tooling), so
    // type-aware rules cannot apply. Lint them with core untyped rules so typos and dead helpers
    // fail loudly instead of becoming silent globals.
    files: [
      "src/node/builtinSkills/**/*.js",
      "src/node/builtinWorkflowActions/**/*.js",
      "src/node/workflowRuntime/*.js",
      "scripts/lib/*.js",
    ],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        exports: "writable",
        module: "writable",
        require: "readonly",
        globalThis: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        mux: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/prefer-for-of": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-undef": "error",
      "no-unused-vars": "error",
    },
  },
  {
    files: ["src/node/builtinWorkflowActions/**/_shared.js"],
    rules: {
      "no-unused-vars": "off",
    },
  },
  {
    files: ["src/node/builtinWorkflowActions/**/*.js"],
    ignores: ["src/node/builtinWorkflowActions/**/_shared.js"],
    languageOptions: {
      globals: {
        boundedCharBudget: "readonly",
        boundedCommentBodyCaptureBytes: "readonly",
        boundedIssueViewBodyCaptureBytes: "readonly",
        boundedIssueListBodyCaptureBytes: "readonly",
        boundedLimit: "readonly",
        captureGit: "readonly",
        excludedLabelSearchQuery: "readonly",
        findComment: "readonly",
        getIssueView: "readonly",
        inputObject: "readonly",
        issueListBodyJq: "readonly",
        isMatchingMarker: "readonly",
        listComments: "readonly",
        markerStatus: "readonly",
        normalizeIssue: "readonly",
        optionalString: "readonly",
        parseNameStatus: "readonly",
        parseStatusLine: "readonly",
        readStatus: "readonly",
        repositoryFromInput: "readonly",
        requiredIssueNumber: "readonly",
        requiredRepository: "readonly",
        requiredString: "readonly",
        resolveBase: "readonly",
        resolveMergeBase: "readonly",
        runGit: "readonly",
        splitRepository: "readonly",
        stringList: "readonly",
        truncateText: "readonly",
        tryResolveBase: "readonly",
        tryGit: "readonly",
      },
    },
  },
  {
    // Test/story/mock files and shared test support (harnesses/utils named
    // per repo convention: *.testHarness.ts, test[A-Z]*.ts): casting partial
    // doubles through `unknown` is the standard mocking idiom, so the
    // chained-assertion ban is production-only.
    files: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.stories.ts",
      "**/*.stories.tsx",
      "src/browser/stories/**",
      "**/*.testHarness.ts",
      "src/**/test[A-Z]*.ts",
    ],
    rules: {
      "local/no-chained-type-assertions": "off",
      "local/no-known-value-widening": "off",
      "local/no-widen-then-assert": "off",
      "local/no-object-parameters": "off",
    },
  },
  {
    // Test file configuration
    files: ["**/*.test.ts", "**/*.test.tsx"],
    languageOptions: {
      globals: {
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        jest: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
      },
    },
  },
  {
    // Storybook story files - disable type-aware rules for Storybook 10 barrel exports
    files: ["**/*.stories.ts", "**/*.stories.tsx", ".storybook/**/*.ts", ".storybook/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  ...storybook.configs["flat/recommended"],
]);
