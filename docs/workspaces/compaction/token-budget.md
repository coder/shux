---
title: Token-Budget Context Windows
description: Start fresh context windows without automatic summaries and retrieve earlier work on demand
---

Enable **Token-budget context windows** in **Settings → Experiments** to replace usage-triggered automatic summaries with fresh context windows. The experiment is off by default.

## Threshold and precedence

Use the existing context-usage slider to choose the per-model threshold. The **Rolls over by N%** label includes the five-percentage-point force buffer: a 70% slider setting displays **Rolls over by 75%**. Automatic rollover is evaluated when sending and after a settled tool step. The displayed percentage is an upper bound; the hard request ceiling takes precedence if reached first. Rollover starts a fresh window without summarizing earlier messages. The transcript shows a **Context window rollover** divider; earlier messages remain on disk, in the UI, and in exports.

- Manual `/compact` and idle compaction still summarize normally.
- Continuous compaction and effective RLM take precedence over rollover.
- Setting the usage threshold to **100%** disables automatic rollover and its warning. Hard request-size checks still apply, including after settled tool steps: the turn can pause without queuing a rollover or discarding completed tool results.
- `session_history` must be allowed by the agent's inherited tool policy and any caller restrictions. Built-in Exec, Plan, and Explore already allow it. Narrow custom agents can add `session_history` or a matching wildcard to `tools.add`. If access is omitted or disabled, rollover pauses before sealing existing context instead of falling back to a lossy summary.

Rollover also pauses when applicable request middleware can change the toolset, before clearing context state or saving a boundary. Context-only integrations, including sandboxed plugin context hooks, remain supported. Xum pins the workspace's applicable hook registrations when admitting a rollover and uses that snapshot throughout the turn and its fallback attempts; later registration changes apply to subsequent requests. Plugin revocation still takes effect. Hooks explicitly scoped to another workspace do not block rollover. Ordinary requests and manual `/compact` retain their existing middleware behavior.

## Keeping useful context

Two machine-authored prompts, each at most once per window, ask the agent to write important context to the conventional `workspace/context-notes.md` file, up to **8 KiB**, if the workspace is writable:

- An **advance warning** (the collapsible **Context budget warning** row) fires ahead of the rollover point and asks the agent to write or update the notes, then continue the task. It fires ten percentage points below the threshold (fifteen before the rollover point) and, on small context windows, at least **6,144 tokens** before the rollover point, but never earlier than half of the usable window.
- A **final flush** (the **Context window ending: notes flush** row) is offered when a settled tool step crosses the rollover point mid-stream with enough headroom for one more notes-writing step. The agent gets a single provider step for one `memory` call; the window is then sealed regardless of what it wrote. The final flush is skipped when memory is read-only, `session_history` is unavailable, the projected usage leaves no headroom (checked again when the step dispatches), a user message is already queued, the rollover happens on a new user message rather than mid-stream, or Xum restarted before the flush step dispatched.

Both prompts are an opportunity to preserve notes, not a guarantee that the agent writes them. While token-budget mode is active, Xum can preload the notes as an **additional ninth memory**, without replacing the normal eight or using their existing byte/token budgets. The extra excerpt is separately bounded to **8 KiB / 2,000 tokens**, including formatting, and is not duplicated if already selected normally. This still requires **Memory** and **Memory Hot Set**; the experiment does not enable either. With token-budget mode inactive, notes follow the ordinary memory-selection rules.

The next window receives a model-only lead-in, not a summary. While the experiment is enabled, the agent can use `session_history` to list windows, search, or read earlier messages in the same workspace. Results are capped at **16 KiB** per call, with scans bounded to **2 MiB**, **500 rows**, and **1 MiB per line**. Large histories may require further bounded calls.

The newest manual `/clear --soft` is a privacy floor: the tool cannot retrieve messages before it. Manual reset behavior and edited-file carryover are unchanged. Turning the experiment off removes retrieval access without deleting old windows.

## Pauses and size limits

Rollover stops only after a tool step settles, preserving tool call/result pairs. Only one rollover may be pending; it is handled on the next send. Restart leaves the workspace paused rather than resurrecting a queued continuation, and the next message re-evaluates pressure from history.

The boundary, lead-in, and triggering message or continuation are saved as one atomic, all-or-nothing batch. Recovery also tolerates incomplete batches in legacy or externally modified histories. Requests estimated to exceed a fresh window are blocked before contacting the provider; rollover cannot make oversized attachments or instructions fit. Text guards use real encodings, but provider-family, media, and framing estimates can still differ from the provider's accounting. Pasted data URLs and ordinary tool JSON count as text, not as image attachments. With Tool Search, deferred schemas count only when advertised; each provider step rechecks activated tools and transformed messages. A failed step preflight pauses without starting another rollover. Before a rollover clears the current context, the complete pinned future request—including system instructions, memory, and advertised tools—must also fit. If admission fails, the current window stays open. An admitted request is prepared once and reused after the boundary is saved.
