---
name: deep-review
description: Sub-agent powered code reviews spanning correctness, tests, consistency, and fit
advertise: false
---

# Deep Review Mode

Provide an **excellent code review** by defaulting to **parallelism**.

You should use sub-agents to review the change from multiple angles (correctness, tests, consistency, UX, performance, safety). Each sub-agent should have a focused mandate and return actionable findings with file paths.

## Step 0: Establish the review surface

Before reviewing, gather context:

- Identify the change scope: `git diff --name-only` (or the file list the user provides).
- Skim the diff for intent and risk: `git diff`.
- Note which layers are touched:
  - UI (React/components/styles)
  - Main process / backend services
  - IPC boundary / shared types
  - Tooling/scripts
  - Docs
  - Tests

If the change is large, split review by module and prioritize **high-risk** paths.

## Spawn the right sub-agents (change-type aware)

Spawn **2–5** sub-agents depending on scope. Tailor them to the change.

### Suggested sub-agent set

- **Correctness & edge cases** (always)
  - Goal: find logic bugs, missing error handling, race conditions, broken invariants.
- **Tests & verification** (always)
  - Goal: evaluate test coverage, propose missing tests, suggest commands to validate.
- **Consistency & architecture** (usually)
  - Goal: ensure changes match existing patterns, abstractions, and boundaries.
- **UX & accessibility** (when UI changed)
  - Goal: keyboard flows, a11y, visual consistency, empty/loading/error states.
- **Performance & reliability** (when hot paths / streaming / IO changed)
  - Goal: latency, unnecessary work, blocking calls, memory growth, resilience.
- **Docs & developer experience** (when docs/scripts/public API changed)
  - Goal: clarity, correctness, navigation updates, link integrity.

## Synthesize into a single excellent review

When sub-agent results arrive, produce a consolidated review with:

1. **Summary** (what changed + overall risk)
2. **Issues**
3. **Questions** (unknown intent; ask for clarification)
4. **Suggested validation plan** (commands + manual checks)

Issues should have a severity in form of:

| Severity | Description                              | Example                                                                                       |
| -------- | ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| P0       | Change must not be merged until resolved | Change would permanently break core workflows if merged.                                      |
| P1       | Change should not be merged              | New code will not work as expected due to severe bugs                                         |
| P2       | Consideration required before merging    | The change creates inconsistency / fragility                                                  |
| P3       | Minor issue                              | The change introduces a minor issue that may be addressed later                               |
| P4       | Long-term issue                          | The change raises concerns about long-term maintainability or may break under rare conditions |

### Review rubric

Use this rubric to avoid blind spots:

- **Correctness**: invariants, edge cases, error handling, races
- **Fitness**: does it meet the user goal, and does it match product constraints?
- **Tests**: coverage of new logic, regression tests, deterministic behavior
- **Consistency**: patterns, naming, types, boundaries, IPC typing
- **Maintainability**: complexity, duplication, readability
- **Performance**: hot paths, streaming, excessive re-renders/IO
- **Safety**: secrets, path traversal, injection risks, filesystem safety
- **DX**: logs, error messages, debuggability

## Anti-patterns

- **Single-threaded review** of a large change (spawn sub-agents).
- **Vague feedback** (“looks good”) without actionable items and file paths.
- **Non-verifiable suggestions** (always include a validation plan).
- **Scope creep** disguised as review (focus on minimal changes unless risk demands more).
