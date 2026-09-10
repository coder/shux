---
name: spawn
description: Delegate the whole task to a single sub-agent to preserve the parent's context window
advertise: false
---

# Spawn

When the user invokes `/spawn`, complete the entire task by spawning one sub-agent with a self-contained brief instead of doing the work yourself. This keeps your context window spent on coordination rather than on the file reads, searches, and tool output the work would otherwise accumulate.

Default to waiting for the sub-agent, then integrate and report its result. If the user explicitly asks to start the work in the background or be notified later, use `run_in_background: true`, report the task ID, and end the turn; Xum will wake the workspace when the sub-agent reaches a terminal state so you can integrate the result then. Do not background `/spawn` when the current answer depends on the result.
