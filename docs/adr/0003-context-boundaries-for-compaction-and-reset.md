---
title: Context Boundaries for Compaction and Reset
description: Architecture decision for modeling provider context windows separately from transcript history
---

# 0003. Context Boundaries Separate Active Context from Transcript History

## Status

Accepted

## Context

Xum needs two ways to start a new active conversation context without treating all persisted transcript history the same way. Compaction summarizes earlier history into provider-visible content, while `/clear --soft` should preserve earlier transcript history but keep it out of future provider requests.

## Decision

Xum will model both compaction and context reset as kinds of Context Boundary. A Compaction Boundary carries a provider-visible summary of earlier transcript history. A Context Reset Boundary is visible transcript structure but is provider-invisible: it preserves earlier Transcript History while starting a new Active Conversation Context.

`/clear` remains a destructive Hard Clear. `/clear --soft` performs a Context Reset, clearing agent carryover state and creating a Context Reset Boundary only when the current context window contains provider-eligible messages. Repeated or empty context resets are no-op successes.

## Consequences

- Provider request assembly must use Context Boundaries to select the Active Conversation Context, then exclude provider-invisible boundaries before model conversion.
- Transcript display and export may include history above a Context Reset Boundary, but the agent must not receive that history or a synthetic note that the reset occurred.
- Persisted boundary metadata should distinguish boundary kinds instead of representing context resets as fake compaction summaries.
