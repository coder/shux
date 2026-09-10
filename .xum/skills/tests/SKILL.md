---
name: tests
description: Testing doctrine, commands, and test layout conventions
---

# Testing Guidelines

## Testing Doctrine

Two types of tests are preferred:

1. **True integration tests** — use real runtimes, real filesystems, real network calls. No mocks, stubs, or fakes. These prove the system works end-to-end.
2. **Unit tests on pure/isolated logic** — test pure functions or well-isolated modules where inputs and outputs are clear. No mocks needed because the code has no external dependencies.

Unit tests are located colocated with the source they test as ".test.ts[x]" files.

Integration tests are located in `tests/`, with these primary harnesses:

- `tests/ipc` — tests that rely on the IPC and are focussed on ensuring backend behavior.
- `tests/ui` — frontend integration tests that use the real IPC and happy-dom Full App rendering.
- `tests/e2e` - end-to-end tests using Playwright which are needed to verify browser behavior that
  can't be easily tested with happy-dom.

Additionally, we have stories in `src/browser/stories` that are primarily used for human visual
verification of UI changes.

## Mocking

Avoid mock-heavy tests that verify implementation details rather than behavior.

If you need mocks to test something, consider whether the code should be restructured to be more testable.

There is at least one exception to this rule: we have a `mockAiRouter` that can be used to simulate
LLM responses. Broadly the use of LLMs in tests follow these rules:

- Use real LLM for tests that verify our integration with the LLM provider
  - E.g., asserting that we correctly identify a context exceeded error
- Use a mockAiRouter for tests that verify behavior around the LLM logic
  - E.g., asserting that messages queue correctly following an LLM response
- Do not use a real LLM or mockAiRouter for logic that in no way touches agentic behavior.
  - E.g., a test that shows that opening a Terminal window works

Avoid tautological tests (simple mappings, identical copies of implementation); focus on invariants and boundary failures.

## When To Test

Ideally, all new features and bugs are well tested. Do not implement a feature or fix without a
robust testing strategy.

When fixing bugs, always start with the test (practice TDD). Reproduce the bug in the test, then fix
the production code, then verify the test passes.

## Test Runtime

All tests in `tests/` are run under `bun x jest` with `TEST_INTEGRATION=1` set.

Otherwise, tests that live in `src/` run under `bun test` (generally these are unit tests).

## Runtime & Checks

- Never kill the running Xum process; rely on the following for local validation:
  - `make typecheck`
  - `make static-check` (fast local lint/typecheck/fmt path)
  - `make static-check-full` (adds docs link and bench-agent validation used in CI)
  - targeted test invocations (e.g. `bun x jest tests/ipc/sendMessage.test.ts -t "pattern"`)
- Only wait on CI to pass when local, targeted checks pass.
- Prefer surgical test invocations over running full suites.
- Keep utils pure or parameterize external effects for easier testing.

## Coverage Expectations

- Prefer fixes that simplify existing code; such simplifications often do not need new tests.
- When adding complexity, add or extend tests. If coverage requires new infrastructure, propose the harness and then add the tests there.
- When asked for TDD, write real repo tests (no `/tmp` scripts) and commit them.
- Pull complex logic into easily tested utils. Target broad coverage with minimal cases that prove the feature matters.

## Storybook

- Ensure all UI changes are captured by at least one story.
  - Many changes will already be captured by an existing story.
- Only use full-app stories (`App.*.stories.tsx`). Do not add isolated component stories, even for small UI changes (they are not used/accepted in this repo).
- Use play functions with `@storybook/test` utilities (`within`, `userEvent`, `waitFor`) to interact with the UI and set up the desired visual state. Do not add props to production components solely for storybook convenience.
- Keep story data deterministic: avoid `Math.random()`, `Date.now()`, or other non-deterministic values in story setup. Pass explicit values when ordering or timing matters for visual stability.
- Scroll stabilization: After async operations that change element sizes (Shiki highlighting, Mermaid rendering, tool expansion), wait for `useAutoScroll`'s ResizeObserver RAF to complete. Use double-RAF: `await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`.

## UI Tests (`tests/ui`)

- Tests in `tests/ui` must render the **full app** via `AppLoader` and drive interactions from the **user's perspective** (clicking, typing, navigating).
- Use `renderReviewPanel()` helper or similar patterns that render `<AppLoader client={apiClient} />`.
- Never test isolated components or utility functions here—those belong as unit tests beside implementation (`*.test.ts`).
- **Never call backend APIs directly** (e.g., `env.orpc.workspace.remove()`) to trigger actions that you're testing—always simulate the user action (click the delete button, etc.). Calling the API bypasses frontend logic like navigation, state updates, and error handling, which is often where bugs hide.
  - Backend API calls are fine for setup/teardown or to avoid expensive operations.
  - Consider moving the test to `tests/ipc` if backend logic needs granular testing.
- Never bypass the UI in these tests; e.g. do not call `updatePersistedState` to change UI state—go through the UI to trigger the desired behavior.
- These tests require `TEST_INTEGRATION=1`; use `shouldRunIntegrationTests()` guard.
- Only call `validateApiKeys()` in tests that actually make AI API calls. Pure UI interaction tests (clicking buttons, selecting items) don't need API keys.

### Happy-dom Limitations

- **Radix Portal content renders in `document.body`** — happy-dom doesn't place it under `view.container`, so queries scoped to the app root will miss dialog/popover content.
- **Workaround:** For portal-based UI (Dialog/Popover/Tooltip), query `view.container.ownerDocument.body` (or `within(document.body)`) and drive interactions there. Prefer `userEvent` for typing to ensure controlled inputs update.
- If portal content still doesn't appear due to missing browser APIs, prefer conditional rendering (`{isOpen && <div>...}`) like `AgentModePicker`, or fall back to tests/e2e (~2min startup time).

### Test Helper Conventions

- Query elements within `view.container` (not `document.body`) when using non-portal components.
- Use `waitFor()` with explicit error messages to aid debugging: `if (!el) throw new Error("Element not found")`.
- Name helpers after user actions: `openBaseSelectorDropdown()`, `selectSuggestion()`, not implementation details.

## IPC Tests (`tests/ipc`)

Strive to test the backend entirely via IPC interactions. Avoid directly asserting or modifying
backend state here.

Exceptions include:

- Building a large history to test otherwise expensive operations (e.g. long-context handling)
- Testing logic where an observable side-effect is a part of the API contract, e.g. createProject creating
  a project directory if it doesn't already exist.

## Determinism

Strive to minimize raciness of tests. They run in a variety of environments, including bogged down CI runners.

Prefer explicit synchronization over arbitrary sleeps.

When explicit synchronization is not feasible, use patterns such as `waitFor` which can complete quickly in the common case.

## Exceptions

In some cases due to infrastructure or performance constraints we may opt to diverge from these guidelines.

In such cases, ensure the test code (or production code which lacks tests) is well commented with the rationale
behind the exception.
