---
title: Token-Budget Context Windows
description: An opt-in automatic reset policy with bounded retrieval and a manual-reset privacy floor
---

# 0005. Automatic Rollover Can Retrieve Earlier Context Windows

## Status

Accepted. Amends only consequence 2 of [ADR 0003](./0003-context-boundaries-for-compaction-and-reset.md) for automatic token-budget rollover.

## Context

Repeated automatic summaries lose detail and consume inference tokens. An opt-in policy can instead start a fresh Active Conversation Context while retaining Transcript History for explicit, bounded retrieval. Manual resets must keep their privacy semantics.

## Decision

Automatic rollover uses a provider-invisible Context Reset Boundary followed by a provider-visible synthetic lead-in. The lead-in identifies the new window and offers `session_history` retrieval; it does not summarize old messages. Earlier windows are retrievable only while the experiment is enabled and never across the newest manual reset. Manual `/clear --soft` remains provider-invisible, adds no lead-in, and establishes that privacy floor.

Manual `/compact`, idle compaction, continuous compaction, and effective RLM retain their existing behavior and take precedence over rollover. Existing edited-file carryover is unchanged. With automatic handling disabled, no rollover or flush warning is emitted, but hard assembled-request preflight still blocks oversized requests. `session_history` follows ordinary inherited agent and caller tool policy: an explicit tool name or matching wildcard must grant access, and later matching rules can remove it. The experiment does not widen narrow allowlists; built-in Exec and Plan grant access through `.*`, and Explore inherits that grant. If effective policy omits or disables history access, a rollover that would seal existing context is blocked rather than falling back to lossy summaries. A fitting first request in an empty or internal-only window does not require history access.

Before a rollover can clear context state or append a boundary, request admission reconciles the workspace's lazy plugin hooks and captures an immutable, ordered snapshot of the applicable request-assembly registrations. Unrestricted middleware is uncertified even when it appears benign: it could remove a tool or mutate its implementation/schema in place. Such middleware blocks rollover; it is never overridden by restoring a denied tool. Explicit workspace scopes are enforced during dispatch, so registrations for other workspaces do not block admission. Only the context-only registration adapter certifies toolset preservation: it receives no tool references and writes back system text alone. The sandboxed plugin context adapter uses this path.

The rollover turn's primary and fallback requests run the admitted snapshot; thinking rebuilds retain that assembled context and toolset. Neither consults later registry changes or constructs the toolset before cleanup. In-process automatic retries retain the same snapshot; it is never serialized into history or send options. Registration/unregistration changes affect subsequent admissions. Plugin disposal and managed-plugin mutation epochs remain live revocation checks, and hook execution reacquires sandbox mounts rather than retaining a disposed kernel. Ordinary non-rollover requests retain live middleware filtering.

A once-per-window warning offers a settled tool step to write the conventional `workspace/context-notes.md` file (up to 8 KiB, if writable). While token-budget mode is active, existing notes can be appended after the unchanged ordinary hot-memory selection, allowing up to nine entries without displacing the normal eight. This additional excerpt has its own 8 KiB / 2,000-token allowance, including formatting, rather than consuming the ordinary selection's budgets. Notes already selected normally are not duplicated. Memory and Memory Hot Set remain required; when token-budget mode is inactive, the file follows ordinary memory-selection rules. Rollover waits for a settled tool step, preserves tool call/result pairs, and allows only one pending rollover to be handled on the next send. Restart stays paused: it does not resurrect a queued continuation; the next message derives context pressure from persisted history.

The reset, lead-in, and triggering message or continuation are committed as one all-or-nothing batch before continuation. `HistoryService.appendManyToHistory` uses `writeFileAtomic` (temporary file and rename) under the cross-process history lock, rather than `fs.appendFile`; the current writer does not expose a torn batch prefix on crash. Recovery tests must still cover partial prefixes from legacy or externally modified histories without duplicating rollover or resurrecting queued work. A payload estimated not to fit even in a fresh window is rejected before a provider request.

Fresh-request, assembled-request, and settled-tool-output hard guards use the resolved model/capability encoding, bypassing approximation mode only for those counts. Large strings are counted in codepoint-safe chunks with boundary slack to bound long-run encoding work; encoding failures do not silently fall back to character ratios. Provider-family encodings and media/framing allowances remain estimates, so provider context-overflow handling remains a backstop. At a settled hard ceiling with automatic handling disabled, the turn stops without warning, rollover, continuation, or preflight quarantine; completed sibling tool results remain durable.

Ordinary text and JSON remain text even when they contain data URLs or media-shaped objects. Omitted JSON punctuation and escape expansion receive a conservative byte-based token allowance instead of relying only on the character heuristic. Only genuine provider media parts and supported tool-output media wrappers use media allowances. With Tool Search, preflight counts only advertised schemas while retaining the full tool map for execution. Each provider step is checked again after thinking/media transforms against the attempt's pinned model limit, including newly activated schemas. A per-step budget failure blocks without an emergency rollover; completed tool results remain durable. Builder preflight retains its existing recoverable rollover path.

Before a proposed rollover clears context state or appends its boundary, the existing builder prepares the complete candidate request: pinned system/middleware text, fresh memory context, actual advertised schemas, and the exact candidate rows. Admission failure releases prepared resources without sealing the current window or clearing its context-scoped state. Successful admission persists those rows and starts the same one-shot prepared request, avoiding a second tool/system/hook assembly and pre-acceptance assistant-placeholder or stream registration. Candidate memory context is promoted only after the rollover append succeeds. The admission abort link is limited to preparation. Once the candidate is ready, explicit cancellation/rollback guards decide whether to discard it or retain delivery; normal turn interruption and disposal remain effective.

An in-process emergency retry restores only the copied file snapshot's original accepted tracking baseline, after the rollover batch commits and its owner is still current. It does not reread snapshot content, adopt a newer tracker baseline, or restore unrelated old-window files. Normal in-memory tracker lifetime is unchanged.

Only context-scoped cache, persisted carryover, and sandbox clearing runs before append. This ordering is deliberately fail-closed: a crash after publication must not reopen a fresh window with stale pre-reset carryover or kernel state. If cleanup succeeds but cancellation or append failure prevents publication, the old transcript remains with that disposable state cleared; it is not restored because a failed acknowledgment may still mean publication succeeded. Cancellation and admission are checked before cleanup and again before append. Branch-summary clearing and epoch notification run after append; cleanup failure must prevent a provider request. When rollover invalidates other sends, its own caller must adopt the updated epoch before continuing.

### Rejected request retention across downgrades

Rejected inputs and their owned snapshots are transcript-only. They are stored as empty, non-partial assistant records, retaining their identity and sequence; the original role, content, and display metadata live inside a new opaque metadata field. No original skill, file, command, or peer control metadata remains active on the outer record. Current display/export code can recover the original transcript projection without restoring it to provider history.

The preceding request assembler already excludes empty assistant records, so downgrading cannot replay rejected payloads merely because it ignores the new rejection flag. Older builds may not display the quarantined original content, but preserve it for a subsequent upgrade. Partial-truncation transaction markers likewise retain legacy decoded-text digests in their existing fields and add separately versioned byte digests, allowing both versions to recognize an accepted rewrite containing invalid UTF-8.

### Append-stable retrieval cursors

Head/tail hashes alone cannot distinguish an append from an interior rewrite followed by an append. Retrieval therefore uses a constant-size durable append receipt in addition to the bounded scan cursor. This receipt is cursor-safety metadata, not a rollover journal or a second copy of the transcript.

All cooperative history writers share the existing cross-process history lock. Before changing transcript files, a writer publishes a pending receipt; failure to invalidate the old receipt aborts the mutation. Only positively verified append operations may retain the receipt's epoch; a rewrite, truncation, rotation, recovery, or unexplained file change invalidates it. A stable receipt binds the epoch to the resulting chat and archive file stamps. Failure to finalize the receipt after accepting a history write expires cursors rather than reporting the accepted write as failed. Readers hold the same lock and validate the receipt and stamps before and after each bounded page, without running recovery during the scan. The bounded append scan still checks for newly added manual-reset privacy floors.

Append stability is guaranteed for tracked `HistoryService` appends, including tool-result appends and appends made by another backend process. Direct filesystem edits or appends observed outside a tracked transaction are untracked: existing cursors fail closed instead of treating file growth as proof of append-only history. Missing, malformed, pending, or mismatched receipts also expire existing cursors. A new query can establish a fresh baseline under the same history lock; it cannot revive an old cursor. Backend restarts continue to expire authenticated cursors.

The receipt assumes cooperative transcript writers honor the history lock and tracked mutation protocol. It detects untracked edits that change the observed file identity, size, or timestamps; fixed stamps do not prove content identity. A same-size rewrite can leave all observed stamps unchanged within a filesystem timestamp tick, even without an adversarial writer. Such changes, including edits racing an append/stat interval, are indistinguishable from no write under the bounded receipt contract. Stronger detection requires filesystem/write isolation or verification of the entire prior prefix, not bounded file stamps.

The receipt does not turn history readers into unbounded prefix verifiers. Transcript scan and result budgets remain unchanged, and the receipt itself has a fixed-size read limit. Raw malformed reset candidates must also survive automatic history rewrites: invalidating an old cursor cannot repair a privacy floor that a writer erased before a new query.

Archived sequence coverage is not proof that an active row is a replay. Retrieval retains rows with reused sequences so repaired or imported content remains accessible; possible physical replay duplicates may therefore appear in results.

## Consequences

- `session_history` list/search/read is bounded: 16 KiB per tool result, 2 MiB scanned, 500 rows, and a 1 MiB per-line cap. Retrieval is scoped to the calling workspace and the manual-reset privacy floor.
- Old windows remain on disk and in transcript display/export. The lead-in stays hidden in normal transcript display; warnings render as machine messages, not human prompts.
- Opting out disables retrieval, not retention. ADR 0003's remaining decisions and consequences are unchanged.
