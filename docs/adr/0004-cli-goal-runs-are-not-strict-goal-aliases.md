---
title: CLI Goal Runs are not strict /goal aliases
description: Architecture decision for giving xum run --goal CLI-specific completion and limit semantics
---

# 0004. CLI Goal Runs are not strict /goal aliases

## Status

Accepted

## Context

`xum run` is designed for automation: it normally sends one request, streams the result, and exits. Interactive `/goal` is a workspace lifecycle command with defaults, controls, and cooldown behavior that assume a user can intervene from the UI.

Adding `xum run --goal` creates a different automation need. A script needs one process to keep driving an objective until there is an authoritative completion signal, while still preserving goal accounting and model-facing goal tools.

## Decision

Xum will model `xum run --goal` as a CLI Goal Run, not as a strict alias for interactive `/goal`.

A CLI Goal Run creates an ephemeral goal for the `xum run` process, sends either the provided message/stdin or the goal text as the kickoff message, and continues in exec mode until the persisted goal status is `complete` or a stop condition is reached. Interactive goal defaults are not applied; omitted `--goal-budget` and `--goal-turns` mean no goal-specific limit. The existing session `--budget` remains a separate hard stop.

CLI Goal Runs bypass the interactive goal continuation cooldown because the process itself is the automation boundary. They still use the shared goal service for prompts, accounting, tool availability, budget-limited wrap-up, and persisted completion state.

## Consequences

- `xum run` remains single-request by default, with `--goal` documented as the explicit multi-continuation exception.
- Scripts can trust exit code `0` only when the persisted goal is complete; free-text claims are not enough unless existing goal completion fallback persisted them.
- Goal and session budgets can stop the same process for different reasons, so CLI output and JSON events must identify which limit won.
- CLI-specific continuation behavior is parameterized in the shared goal service instead of duplicating goal prompt/accounting logic in the CLI.
