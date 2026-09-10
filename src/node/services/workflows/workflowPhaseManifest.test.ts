import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import type { WorkflowRunRecord } from "@/common/types/workflow";
import {
  hydrateWorkflowRunPhaseManifest,
  inferPhaseManifest,
  resolveWorkflowPhaseManifest,
} from "./workflowPhaseManifest";

let hashCounter = 0;
/** Unique per call so the memoization cache never couples unrelated assertions. */
function freshHash(): string {
  hashCounter += 1;
  return `sha256:test-${hashCounter}`;
}

function phaseNames(source: string): string[] | undefined {
  return inferPhaseManifest(source)?.map((phase) => phase.name);
}

/** Canonical legacy workflow (no meta.phases) wrapping `body` in the workflow function. */
function legacyWorkflow(body: string): string {
  return `export const meta = { description: "Legacy" };
export default function workflow({ args, phase, log, agent, parallel }) {
${body}
  return { reportMarkdown: "done" };
}
`;
}

describe("inferPhaseManifest", () => {
  test("collects static literal phases in first-occurrence order with dedup", () => {
    const source = legacyWorkflow(`
  phase("plan", { detail: "planning" });
  for (let i = 0; i < 3; i++) {
    phase("implement");
    if (i === 2) break;
    phase("verify");
  }
  phase(\`finalize\`);
  phase("implement");
`);
    expect(phaseNames(source)).toEqual(["plan", "implement", "verify", "finalize"]);
  });

  test("supports arrow-function and indirection default exports", () => {
    expect(
      phaseNames(`export default async ({ phase }) => { phase("only"); return {}; };\n`)
    ).toEqual(["only"]);
    expect(
      phaseNames(
        `async function run({ phase }) { phase("named"); return {}; }\nexport default run;\n`
      )
    ).toEqual(["named"]);
    expect(
      phaseNames(
        `const run = async ({ phase }) => { phase("const-arrow"); return {}; };\nexport default run;\n`
      )
    ).toEqual(["const-arrow"]);
  });

  test("ignores non-references: strings, comments, ctx.phase, phases identifiers, object keys", () => {
    const source = legacyWorkflow(`
  // phase("comment") must not count
  const note = 'call phase("in-string") later';
  const phases = ["not", "these"];
  const ctx = { phase: (name) => name };
  ctx.phase("member-call");
  const config = { phase: "object-key-value" };
  log(note, phases, config);
  phase("real");
`);
    expect(phaseNames(source)).toEqual(["real"]);
  });

  test("bails on dynamic names (concatenation and template interpolation)", () => {
    expect(phaseNames(legacyWorkflow(`phase("implement-" + args.key);`))).toBeUndefined();
    expect(phaseNames(legacyWorkflow("phase(`implement-${args.key}`);"))).toBeUndefined();
    expect(phaseNames(legacyWorkflow(`phase(args.name);`))).toBeUndefined();
    expect(phaseNames(legacyWorkflow(`phase();`))).toBeUndefined();
  });

  test("bails when phase escapes as a value (helper argument, return, alias, shorthand)", () => {
    expect(phaseNames(legacyWorkflow(`phase("ok"); runPhase(phase, "helper");`))).toBeUndefined();
    expect(phaseNames(legacyWorkflow(`return { phase };`))).toBeUndefined();
    expect(phaseNames(legacyWorkflow(`const p = phase; p("aliased");`))).toBeUndefined();
    expect(phaseNames(legacyWorkflow(`phase.call(null, "bound");`))).toBeUndefined();
    expect(phaseNames(legacyWorkflow(`phase?.("optional");`))).toBeUndefined();
  });

  test("bails on destructuring rename and non-canonical bindings", () => {
    expect(
      phaseNames(`export default function workflow({ phase: p }) { p("renamed"); return {}; }\n`)
    ).toBeUndefined();
    expect(
      phaseNames(`export default function workflow(ctx) { ctx.phase("member"); return {}; }\n`)
    ).toBeUndefined();
    expect(
      phaseNames(`export default function workflow({ other: phase }) { phase("x"); return {}; }\n`)
    ).toBeUndefined();
    // Rest element: `phase` is the leftover context object, not the primitive.
    expect(
      phaseNames(`export default function workflow({ ...phase }) { phase("x"); return {}; }\n`)
    ).toBeUndefined();
    expect(
      phaseNames(
        `export default function workflow({ agent, ...phase }) { phase("x"); return {}; }\n`
      )
    ).toBeUndefined();
    // Computed key: `key` may resolve to another capability (agent, log, …), so the
    // local named `phase` cannot be proven to be the phase primitive.
    expect(
      phaseNames(
        `const key = "agent";\nexport default function workflow({ [key]: phase }) { phase("x"); return {}; }\n`
      )
    ).toBeUndefined();
  });

  test("bails on mutable or reassigned default-export bindings", () => {
    // `let` initializer replaced before export: the runtime executes `b`, not `a`.
    expect(
      phaseNames(
        `let run = ({ phase }) => { phase("a"); return {}; };\n` +
          `run = ({ phase }) => { phase("b"); return {}; };\n` +
          `export default run;\n`
      )
    ).toBeUndefined();
    // Even an un-reassigned `let` is not an immutable binding.
    expect(
      phaseNames(`let run = ({ phase }) => { phase("a"); return {}; };\nexport default run;\n`)
    ).toBeUndefined();
    // A function declaration reassigned later is equally untrustworthy.
    expect(
      phaseNames(
        `function run({ phase }) { phase("a"); return {}; }\n` +
          `run = ({ phase }) => { phase("b"); return {}; };\n` +
          `export default run;\n`
      )
    ).toBeUndefined();
    // Immutable + untouched bindings still resolve (see "supports ... indirection").
    expect(
      phaseNames(`function run({ phase }) { phase("fn"); return {}; }\nexport default run;\n`)
    ).toEqual(["fn"]);
    // `export default function run` is itself a live binding.
    expect(
      phaseNames(
        `export default function run({ phase }) { phase("a"); return {}; }\n` +
          `run = ({ phase }) => { phase("b"); return {}; };\n`
      )
    ).toBeUndefined();
    // Non-binary rebinding forms: destructuring assignment and for-of targets.
    expect(
      phaseNames(
        `export default function run({ phase }) { phase("a"); return {}; }\n` +
          `({ run } = replacements);\n`
      )
    ).toBeUndefined();
    expect(
      phaseNames(
        `const run = ({ phase }) => { phase("a"); return {}; };\n` +
          `for (run of replacements) {}\nexport default run;\n`
      )
    ).toBeUndefined();
    // Any other mention (passing the binding around) is enough to bail.
    expect(
      phaseNames(
        `function run({ phase }) { phase("a"); return {}; }\nregister(run);\nexport default run;\n`
      )
    ).toBeUndefined();
  });

  test("bails when direct eval could touch the phase binding", () => {
    expect(phaseNames(legacyWorkflow(`eval("phase = () => {}"); phase("b");`))).toBeUndefined();
    // Even an eval that never mentions phase voids inference: its string is opaque.
    expect(
      phaseNames(legacyWorkflow(`phase("a"); const n = eval("1 + 1"); log(n);`))
    ).toBeUndefined();
    // Parenthesized callee is still a direct eval (the Reference survives).
    expect(phaseNames(legacyWorkflow(`((eval))("phase = () => {}"); phase("b");`))).toBeUndefined();
    // Indirect eval is a route to the global object (and thus to the runtime's
    // primitives), so ANY `eval` identifier voids inference — including a member
    // merely named eval, which the scanner does not try to disambiguate.
    expect(
      phaseNames(
        legacyWorkflow(
          `const g = (0, eval)("this"); g["__work" + "flowPhase"]("hidden"); phase("visible");`
        )
      )
    ).toBeUndefined();
    expect(
      phaseNames(
        legacyWorkflow(`phase("a"); const util = { eval: (x) => x }; log(util.eval("1"));`)
      )
    ).toBeUndefined();
  });

  test("bails when a parameter initializer already uses phase", () => {
    // Defaults evaluate before the body and the runtime context supplies no
    // `fallback`, so `setup` really is emitted — but only the body is scanned.
    expect(
      phaseNames(
        `export default function workflow({ phase, fallback = phase("setup") }) { phase("run"); return {}; }\n`
      )
    ).toBeUndefined();
    // Initializers that do not touch phase are fine.
    expect(
      phaseNames(
        `export default function workflow({ phase, quick = false }) { phase("run"); return {}; }\n`
      )
    ).toEqual(["run"]);
    // A computed destructuring key in another parameter evaluates phase too.
    expect(
      phaseNames(
        `export default function workflow({ phase }, { [phase("setup")]: ignored } = {}) { phase("run"); return {}; }\n`
      )
    ).toBeUndefined();
  });

  test("bails when the body reaches the context through arguments", () => {
    expect(
      phaseNames(legacyWorkflow(`arguments[0].phase("hidden"); phase("visible");`))
    ).toBeUndefined();
    // A parameter default can reach it too — before the body even runs.
    expect(
      phaseNames(
        `export default function workflow({ phase }, hidden = arguments[0]["phase"]("setup")) { phase("run"); return {}; }\n`
      )
    ).toBeUndefined();
  });

  test("bails when the script reaches into the runtime's internal globals", () => {
    // The prelude registers `__workflowPhase` (and other `__workflow*`/`__mux*`
    // primitives) globally; calling them directly emits phases the walk never sees.
    expect(
      phaseNames(legacyWorkflow(`__workflowPhase("hidden"); phase("visible");`))
    ).toBeUndefined();
    expect(phaseNames(legacyWorkflow(`phase("a"); log(__muxWorkflow);`))).toBeUndefined();
    // Computed access: no internal identifier in the AST, but the string names one,
    // and any route to the global object could reach it.
    expect(
      phaseNames(legacyWorkflow(`globalThis["__workflowPhase"]("hidden"); phase("visible");`))
    ).toBeUndefined();
    expect(
      phaseNames(legacyWorkflow(`const g = globalThis; phase("visible"); log(g);`))
    ).toBeUndefined();
    expect(
      phaseNames(legacyWorkflow(`const k = "__work" + "flowPhase"; log(Function); phase("a");`))
    ).toBeUndefined();
    expect(phaseNames(legacyWorkflow(`phase("a"); log(this);`))).toBeUndefined();
    // Reflective route to the Function constructor — by identifier or by string.
    expect(
      phaseNames(
        legacyWorkflow(
          `await [].filter.constructor("return __work" + "flowPhase('hidden')")(); phase("visible");`
        )
      )
    ).toBeUndefined();
    expect(
      phaseNames(
        legacyWorkflow(
          `[]["filter"]["constructor"]("return __work" + "flowPhase('hidden')")(); phase("visible");`
        )
      )
    ).toBeUndefined();
  });

  test("bails when the source has parse diagnostics even though an AST was recovered", () => {
    // The runner will refuse to compile this; a rail inferred from it would
    // describe code that never ran.
    expect(
      phaseNames(`export default function workflow({ phase }) { phase("a"); return {}; }\n@\n`)
    ).toBeUndefined();
  });

  test("bails on with statements, which resolve identifiers dynamically", () => {
    expect(
      phaseNames(legacyWorkflow(`with ({ phase: () => {} }) { phase("shadowed"); } phase("b");`))
    ).toBeUndefined();
  });

  test("bails on shadowing declarations", () => {
    expect(
      phaseNames(legacyWorkflow(`{ const phase = () => {}; phase("shadowed"); }`))
    ).toBeUndefined();
  });

  test("bails on phase references inside nested function bodies", () => {
    expect(
      phaseNames(legacyWorkflow(`const helper = () => phase("nested"); helper();`))
    ).toBeUndefined();
    // A nested arrow that never touches phase is fine.
    expect(
      phaseNames(
        legacyWorkflow(`phase("outer"); const results = [1, 2].map((x) => agent("do " + x));`)
      )
    ).toEqual(["outer"]);
  });

  test("bails with zero callsites or invalid inferred names", () => {
    expect(phaseNames(legacyWorkflow(`log("no phases");`))).toBeUndefined();
    expect(phaseNames(legacyWorkflow(`phase("");`))).toBeUndefined();
    expect(phaseNames(legacyWorkflow(`phase("${"x".repeat(121)}");`))).toBeUndefined();
  });

  test("real corpus: deep-research phase alphabet infers from its callsites", async () => {
    // Strip the meta declaration so inference (not the declaration) is exercised.
    const source = await fs.readFile(
      path.join(import.meta.dir, "..", "..", "builtinSkills", "deep-research", "workflow.js"),
      "utf-8"
    );
    const withoutMeta = source.replace(/^export const meta = \{[\s\S]*?\n\};/u, "");
    expect(phaseNames(withoutMeta)).toEqual(["scope", "search-fetch", "verify", "synthesize"]);
  });

  test("real corpus pattern: dynamic per-track conductors bail", () => {
    // track1/track2-style: dynamic names + phase passed into a helper.
    const source = `export default async function workflow({ args, phase, agent }) {
  const tracks = [{ key: "a" }, { key: "b" }];
  for (const track of tracks) {
    phase("implement-" + track.key);
    await agent("implement " + track.key);
  }
  return { reportMarkdown: "done" };
}
`;
    expect(phaseNames(source)).toBeUndefined();
  });
});

describe("resolveWorkflowPhaseManifest", () => {
  test("explicit meta.phases wins over inference", () => {
    const source = `export const meta = {
  description: "Declared",
  phases: [{ name: "declared-only", label: "Declared" }],
};
export default function workflow({ phase }) { phase("declared-only"); phase("extra"); return {}; }
`;
    const outcome = resolveWorkflowPhaseManifest(source, freshHash());
    expect(outcome).toEqual({
      kind: "manifest",
      manifest: {
        provenance: "declared",
        phases: [{ name: "declared-only", label: "Declared" }],
      },
    });
  });

  test("absent declaration falls back to inference with inferred provenance", () => {
    const outcome = resolveWorkflowPhaseManifest(legacyWorkflow(`phase("solo");`), freshHash());
    expect(outcome).toEqual({
      kind: "manifest",
      manifest: { provenance: "inferred", phases: [{ name: "solo" }] },
    });
  });

  test("invalid declaration reports a warning instead of throwing (read-path fail-safe)", () => {
    const source = `export const meta = { phases: [{ name: "" }] };
export default function workflow({ phase }) { phase("x"); return {}; }
`;
    const outcome = resolveWorkflowPhaseManifest(source, freshHash());
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind === "invalid") {
      expect(outcome.warning).toContain("meta.phases[0].name");
    }
  });

  test("a hostile declaration yields a bounded warning (memoized and sent to the renderer)", () => {
    // A trusted project's workflows/ is discovered automatically; ~1 MiB of
    // scalar phase entries must not become megabytes of cached warning text.
    const source = `export const meta = { phases: [${"0,".repeat(200_000)}] };
export default function workflow({ phase }) { phase("x"); return {}; }
`;
    const outcome = resolveWorkflowPhaseManifest(source, freshHash());
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind === "invalid") {
      expect(outcome.warning).toContain("at most 64 phases");
      expect(outcome.warning.length).toBeLessThan(8192);
    }
  });

  test("unparseable source degrades to none without throwing", () => {
    const outcome = resolveWorkflowPhaseManifest("this is not (valid js", freshHash());
    expect(outcome).toEqual({ kind: "none" });
  });

  test("a declared but non-static meta is invalid, never silently inferred", () => {
    // Static phase() literals would infer fine — but the author DECLARED meta, so
    // presenting an inferred rail would hide that their declaration was unreadable.
    const source = `const phases = [{ name: "x" }];
export const meta = { phases };
export default function workflow({ phase }) { phase("x"); return {}; }
`;
    const outcome = resolveWorkflowPhaseManifest(source, freshHash());
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind === "invalid") {
      expect(outcome.warning).toContain("static object literal");
    }
  });

  test("memoizes by sourceHash", () => {
    const hash = freshHash();
    const first = resolveWorkflowPhaseManifest(legacyWorkflow(`phase("memo");`), freshHash());
    const a = resolveWorkflowPhaseManifest(legacyWorkflow(`phase("memo");`), hash);
    // Same hash returns the cached object even for different source text.
    const b = resolveWorkflowPhaseManifest("completely different", hash);
    expect(a).toBe(b);
    expect(first).toEqual(a);
  });
});

describe("hydrateWorkflowRunPhaseManifest", () => {
  function makeRun(source: string): WorkflowRunRecord {
    return {
      id: "wfr_hydrate_test",
      workspaceId: "workspace-1",
      workflow: {
        name: "demo",
        description: "Demo workflow",
        scope: "project",
        executable: true,
      },
      source,
      sourceHash: freshHash(),
      args: {},
      status: "running",
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
      events: [],
      steps: [],
    };
  }

  test("returns a hydrated copy without mutating the input run", () => {
    const run = makeRun(legacyWorkflow(`phase("one"); phase("two");`));
    const hydrated = hydrateWorkflowRunPhaseManifest(run);
    expect(hydrated).not.toBe(run);
    expect(run.workflow.phaseManifest).toBeUndefined();
    expect(hydrated.workflow.phaseManifest).toEqual({
      provenance: "inferred",
      phases: [{ name: "one" }, { name: "two" }],
    });
  });

  test("marks hydrated records with an explicit null when no manifest resolves", () => {
    // null = "hydrated, none derivable"; clients use it to tell a hydrated record
    // apart from a pre-upgrade snapshot that simply lacks the field.
    const run = makeRun(`export default function workflow(ctx) { return {}; }\n`);
    const hydrated = hydrateWorkflowRunPhaseManifest(run);
    expect(hydrated.workflow.phaseManifest).toBeNull();
    expect(run.workflow.phaseManifest).toBeUndefined();
  });

  test("memoizes on the handed source, not the record's own sourceHash", () => {
    // A record whose sourceHash went stale (any producer other than the store, which
    // recomputes it) must not be served a manifest computed for other source text.
    const staleHash = freshHash();
    const first = { ...makeRun(legacyWorkflow(`phase("first");`)), sourceHash: staleHash };
    const second = { ...makeRun(legacyWorkflow(`phase("second");`)), sourceHash: staleHash };
    expect(hydrateWorkflowRunPhaseManifest(first).workflow.phaseManifest).toEqual({
      provenance: "inferred",
      phases: [{ name: "first" }],
    });
    expect(hydrateWorkflowRunPhaseManifest(second).workflow.phaseManifest).toEqual({
      provenance: "inferred",
      phases: [{ name: "second" }],
    });
  });

  test("replaces a stale persisted manifest with null when the source derives none", () => {
    // Hand-edited/corrupted run.json: the store strips it before schema validation,
    // but the read boundary must never echo such a value back to clients either.
    const stale = { provenance: "declared" as const, phases: [{ name: "attacker-phase" }] };
    const run = makeRun(`export default function workflow(ctx) { return {}; }\n`);
    const corrupted = { ...run, workflow: { ...run.workflow, phaseManifest: stale } };
    const hydrated = hydrateWorkflowRunPhaseManifest(corrupted);
    expect(hydrated.workflow.phaseManifest).toBeNull();
    expect(corrupted.workflow.phaseManifest).toBe(stale);
  });

  test("replaces a stale persisted manifest with the source-derived one", () => {
    const stale = { provenance: "declared" as const, phases: [{ name: "attacker-phase" }] };
    const run = makeRun(legacyWorkflow(`phase("real");`));
    const hydrated = hydrateWorkflowRunPhaseManifest({
      ...run,
      workflow: { ...run.workflow, phaseManifest: stale },
    });
    expect(hydrated.workflow.phaseManifest).toEqual({
      provenance: "inferred",
      phases: [{ name: "real" }],
    });
  });
});
