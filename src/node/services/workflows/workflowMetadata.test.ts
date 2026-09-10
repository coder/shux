import { describe, expect, test } from "bun:test";

import {
  parseDeclaredPhases,
  parseDeclaredPhasesFromSource,
  parseWorkflowMetadata,
  WORKFLOW_PHASE_ISSUES_MAX,
  WorkflowDeclaredPhasesValidationError,
} from "./workflowMetadata";

function expectIssues(metadata: Record<string, unknown>, expectedFragments: string[]): void {
  try {
    parseDeclaredPhases(metadata);
    expect.unreachable("parseDeclaredPhases must reject invalid meta.phases");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowDeclaredPhasesValidationError);
    const { issues } = error as WorkflowDeclaredPhasesValidationError;
    expect(issues).toHaveLength(expectedFragments.length);
    for (const fragment of expectedFragments) {
      expect(issues.some((issue) => issue.includes(fragment))).toBe(true);
    }
  }
}

describe("parseDeclaredPhases", () => {
  test("returns undefined when meta.phases is absent", () => {
    expect(parseDeclaredPhases(null)).toBeUndefined();
    expect(parseDeclaredPhases({ description: "no phases" })).toBeUndefined();
  });

  test("parses a valid declaration preserving order and optional fields", () => {
    const phases = parseDeclaredPhases({
      phases: [
        { name: "scope", label: "Scope", description: "Pick angles" },
        { name: "verify", parallel: true },
        { name: "synthesize" },
      ],
    });
    expect(phases).toEqual([
      { name: "scope", label: "Scope", description: "Pick angles" },
      { name: "verify", parallel: true },
      { name: "synthesize" },
    ]);
  });

  test("parses meta.phases from real workflow source through parseWorkflowMetadata", () => {
    const source = `export const meta = {
  description: "Demo",
  phases: [{ name: "a" }, { name: "b", parallel: true }],
};
export default function workflow({ phase }) { phase("a"); phase("b"); return {}; }
`;
    expect(parseDeclaredPhases(parseWorkflowMetadata(source))).toEqual([
      { name: "a" },
      { name: "b", parallel: true },
    ]);
  });

  test("rejects a non-array declaration", () => {
    expectIssues({ phases: "scope" }, ["must be an array"]);
  });

  test("rejects an empty declaration", () => {
    expectIssues({ phases: [] }, ["at least one phase"]);
  });

  test("rejects more than the maximum number of phases", () => {
    const phases = Array.from({ length: 65 }, (_, i) => ({ name: `phase-${i}` }));
    expectIssues({ phases }, ["at most 64 phases"]);
  });

  test("enumerates every issue at once instead of stopping at the first", () => {
    expectIssues(
      {
        phases: [
          { name: "" },
          { name: "dup" },
          { name: "dup", bogus: true },
          "not-an-object",
          { name: "x".repeat(121), parallel: "yes" },
        ],
      },
      [
        "meta.phases[0].name must be a non-empty string",
        'meta.phases[2].name duplicates phase name "dup"',
        'meta.phases[2] has unknown key "bogus"',
        "meta.phases[3] must be an object",
        "meta.phases[4].name must be at most 120 characters",
        "meta.phases[4].parallel must be a boolean",
      ]
    );
  });

  test("bounds the enumerated diagnostics for hostile declarations", () => {
    // Discovery scans attacker-controlled scripts: neither entry count nor key
    // count nor key length may grow the error (and thus the cached/wire
    // warning) without bound.
    const collect = (metadata: Record<string, unknown>): WorkflowDeclaredPhasesValidationError => {
      try {
        parseDeclaredPhases(metadata);
        return expect.unreachable("must reject");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkflowDeclaredPhasesValidationError);
        return error as WorkflowDeclaredPhasesValidationError;
      }
    };

    const manyScalars = collect({ phases: Array.from({ length: 50_000 }, () => 0) });
    expect(manyScalars.issues).toHaveLength(WORKFLOW_PHASE_ISSUES_MAX + 1);
    expect(manyScalars.issues[0]).toContain("at most 64 phases");
    // Only the first 64 entries are inspected: 1 count issue + 64 entry issues
    // → 32 recorded + "… and 33 more".
    expect(manyScalars.issues.at(-1)).toBe("… and 33 more issue(s)");
    expect(manyScalars.issues.some((issue) => issue.includes("meta.phases[64]"))).toBe(false);

    const longKey = "k".repeat(10_000);
    const manyKeys = collect({
      phases: [Object.fromEntries(Array.from({ length: 5_000 }, (_, i) => [`${longKey}${i}`, 1]))],
    });
    expect(manyKeys.issues).toHaveLength(WORKFLOW_PHASE_ISSUES_MAX + 1);
    expect(manyKeys.message.length).toBeLessThan(WORKFLOW_PHASE_ISSUES_MAX * 200);
    expect(manyKeys.issues[0]).toContain(`"${"k".repeat(40)}…"`);
  });

  test("rejects invalid label and over-length description", () => {
    expectIssues(
      {
        phases: [
          { name: "a", label: 5 },
          { name: "b", description: "d".repeat(501) },
        ],
      },
      [
        "meta.phases[0].label must be a non-empty string",
        "meta.phases[1].description must be at most 500 characters",
      ]
    );
  });
});

describe("parseDeclaredPhasesFromSource", () => {
  const body = 'export default function workflow({ phase }) { phase("a"); return {}; }\n';

  test("returns undefined when the script declares no meta at all", () => {
    expect(parseDeclaredPhasesFromSource(body)).toBeUndefined();
  });

  test("returns undefined for a static meta without phases", () => {
    expect(
      parseDeclaredPhasesFromSource('export const meta = { description: "x" };\n' + body)
    ).toBeUndefined();
  });

  test("accepts JSON escaped solidus in neighboring metadata strings", () => {
    // `\/` is valid JSON (JSON.stringify output, hand-written URLs); it must not
    // route an otherwise valid declaration into the unreadable-phases rejection.
    expect(
      parseDeclaredPhasesFromSource(
        'export const meta = { description: "https:\\/\\/example.com", phases: [{ name: "a" }] };\n' +
          body
      )
    ).toEqual([{ name: "a" }]);
  });

  test("reads phases from a static meta", () => {
    expect(
      parseDeclaredPhasesFromSource('export const meta = { phases: [{ name: "a" }] };\n' + body)
    ).toEqual([{ name: "a" }]);
  });

  test("rejects an unreadable meta that declares phases instead of treating it as absent", () => {
    // `meta` exists and names `phases`, so a silently-ignored declaration would run
    // undeclared without telling the author — whatever form the value takes.
    for (const declaration of [
      'const phases = [{ name: "a" }];\nexport const meta = { phases };\n',
      'export const meta = { description: "x", phases: buildPhases() };\n',
      'export const meta = { "phases": [...shared] };\n',
      // Computed keys with a static string literal still name the key — escapes decoded.
      'export const meta = { ["phases"]: [{ name: "setup" }] };\n',
      "export const meta = { description: 'x', [`phases`]: [{ name: 'setup' }] };\n",
      'export const meta = { ["pha\\u0073es"]: buildPhases() };\n',
      // An interpolated template elsewhere in meta must not hide the phases key.
      "export const meta = { description: `x ${name}`, phases: buildPhases() };\n",
      // Anything that MAY supply phases at runtime counts: spreads and dynamic keys.
      "export const meta = { ...{ phases: buildPhases() } };\n",
      "export const meta = { description: 'x', ...shared };\n",
      'export const meta = { [key]: [{ name: "a" }], description: "x" };\n',
      // Transparent parentheses and identifier escapes cannot hide the key either.
      "export const meta = ({ phases: buildPhases() });\n",
      "export const meta = { pha\\u0073es: buildPhases() };\n",
      // Parses, but a `__proto__` key makes the value a non-plain object.
      'export const meta = { __proto__: {}, phases: [{ name: "setup" }] };\n',
      // Accessor / method / generator property syntax the strict parser never accepts.
      "export const meta = { get phases() { return buildPhases(); } };\n",
      'export const meta = { description: "x", async phases() { return []; } };\n',
      "export const meta = { *phases() {} };\n",
    ]) {
      const source = declaration + body;
      try {
        parseDeclaredPhasesFromSource(source);
        expect.unreachable("non-static meta.phases must be rejected");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkflowDeclaredPhasesValidationError);
        expect((error as WorkflowDeclaredPhasesValidationError).issues).toHaveLength(1);
        expect(String(error)).toContain("static object literal");
      }
      // The lenient reader still degrades to null for the same source, so the two
      // must not be conflated by callers.
      expect(parseWorkflowMetadata(source)).toBeNull();
    }
  });

  test("keeps ignoring unreadable meta that does not declare phases (legacy workflows stay startable)", () => {
    for (const declaration of [
      // Method/accessor syntax with an unrelated key is not a phases declaration.
      'export const meta = { description: "x", helper() {} };\n',
      'export const meta = { get description() { return "x"; }, async run() {} };\n',
      "export const meta = { *items() {}, get: 1, async: 2 };\n",
      'const description = "x";\nexport const meta = { description };\n',
      "export const meta = { argsSchema: buildSchema(), nested: { phases: 1 } };\n",
      // A computed no-substitution template key is decoded to its static name.
      // (A bare `` `helper`: `` key is a SyntaxError, not a legacy shape.)
      "export const meta = { [`helper`]: buildMetadata(), description: 'x' };\n",
      // Not even an object literal: nothing to declare phases in.
      "export const meta = sharedMeta;\n",
    ]) {
      expect(parseDeclaredPhasesFromSource(declaration + body)).toBeUndefined();
    }
  });
});

describe("declared phases require an immutable meta binding", () => {
  const body = 'export default function workflow({ phase }) { phase("a"); return {}; }\n';
  const phases = '{ phases: [{ name: "a" }] }';

  test("rejects let/var declarations and any later mention of meta", () => {
    for (const declaration of [
      `export let meta = ${phases};\nmeta = { phases: [{ name: "b" }] };\n`,
      `export let meta = ${phases};\n`,
      `export const meta = ${phases};\nmeta.phases.push({ name: "b" });\n`,
      `export const meta = ${phases};\nconst alias = meta;\n`,
      // Template interpolations are executable code, not string text: a mutation
      // hidden in one (even nested in an inner template) must still be seen.
      `export const meta = ${phases};\nlog(\`\${(meta.phases[0].name = "changed")}\`);\n`,
      `export const meta = ${phases};\nlog(\`outer \${ \`inner \${ helper(meta) }\` }\`);\n`,
      // An identifier escape names the same binding; a textual scan cannot prove otherwise.
      `export const meta = ${phases};\nm\\u0065ta.phases[0].name = "changed";\n`,
      // Direct eval / Function can name the binding from inside a masked string.
      `export const meta = ${phases};\neval("meta.phases[0].name = 'b'");\n`,
      `export const meta = ${phases};\nFunction("meta.phases.length = 0")();\n`,
    ]) {
      expect(() => parseDeclaredPhasesFromSource(declaration + body)).toThrow(
        /immutable declaration/u
      );
    }
  });

  test("accepts const meta and ignores the word in strings or as a member name", () => {
    expect(
      parseDeclaredPhasesFromSource(
        `export const meta = { description: "about meta", phases: [{ name: "a" }] };\n` +
          "const x = ctx.meta;\n" +
          // Interpolation code is scanned, but template text and braces inside it
          // (`${ { meta: 1 }.other }` would count; `{ ...args }` does not) stay inert.
          "const banner = `meta ${ ({ ...args }).title } ${ ctx.meta }`;\n" +
          body
      )
    ).toEqual([{ name: "a" }]);
  });

  test("mutability is only enforced when phases are declared", () => {
    expect(
      parseDeclaredPhasesFromSource('export let meta = { description: "x" };\nmeta = {};\n' + body)
    ).toBeUndefined();
  });
});

describe("meta declaration detection after a block statement", () => {
  const body = 'export default function workflow({ phase }) { phase("a"); return {}; }\n';

  test("a static meta following a same-line block is still parsed", () => {
    const source =
      'const ready = true; if (ready) {} export const meta = { phases: [{ name: "a" }] };\n' + body;
    expect(parseDeclaredPhasesFromSource(source)).toEqual([{ name: "a" }]);
  });

  test("a non-static meta following a same-line block is rejected, not treated as absent", () => {
    const source =
      'const phases = [{ name: "a" }]; if (phases) {} export const meta = { phases };\n' + body;
    expect(() => parseDeclaredPhasesFromSource(source)).toThrow(
      WorkflowDeclaredPhasesValidationError
    );
  });

  test("a meta declaration nested inside a block is not a top-level declaration", () => {
    const source = "if (true) { const meta = { phases: [] }; }\n" + body;
    expect(parseDeclaredPhasesFromSource(source)).toBeUndefined();
  });
});

describe("meta declaration detection with comments between tokens", () => {
  const body = 'export default function workflow({ phase }) { phase("a"); return {}; }\n';

  test("comments between declaration tokens are treated as whitespace", () => {
    for (const declaration of [
      'export const meta /* phase metadata */ = { phases: [{ name: "a" }] };\n',
      'export /* x */ const meta = { phases: [{ name: "a" }] };\n',
      'export const meta // note\n  = { phases: [{ name: "a" }] };\n',
      'export const meta = /* v */ { phases: [{ name: "a" }] };\n',
    ]) {
      expect(parseDeclaredPhasesFromSource(declaration + body)).toEqual([{ name: "a" }]);
    }
  });

  test("a non-static meta with a comment before the initializer is still rejected", () => {
    const source =
      'const phases = [{ name: "a" }];\nexport const meta /* dynamic */ = { phases };\n' + body;
    expect(() => parseDeclaredPhasesFromSource(source)).toThrow(
      WorkflowDeclaredPhasesValidationError
    );
  });
});
