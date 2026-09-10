<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/white-xum.svg" />
  <source media="(prefers-color-scheme: light)" srcset="docs/img/black-xum.svg" />
  <img src="docs/img/black-xum.svg" alt="Xum logo" width="18%" />
</picture>

# Xum - Coding Agent Multiplexer

[![Download](https://img.shields.io/badge/Download-Releases-purple)](https://github.com/coder/mux/releases)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](LICENSE)
[![Discord](https://img.shields.io/discord/1446553342699507907?logo=discord&label=Discord)](https://cdr.co/mux-discord)
[![X (formerly Twitter)](https://img.shields.io/badge/Follow-%40codermux-black?logo=x)](https://x.com/codermux)

</div>

> [!IMPORTANT]
> This project was renamed from Mux to Xum after Mux.com raised a trademark concern. “Mux” is a common technical abbreviation of “multiplexer” and we do not expect confusion between the projects, but chose to rename ours rather than spend more time on the dispute.

<p><img src="./docs/img/xum-demo.gif" alt="Xum product demo" width="100%" /></p>

## Features

- **Isolated workspaces** with central view on git divergence ([docs](https://mux.coder.com/runtime))
  - **[Local](https://mux.coder.com/runtime/local)**: run directly in your project directory
  - **[Worktree](https://mux.coder.com/runtime/worktree)**: git worktrees on your local machine
  - **[SSH](https://mux.coder.com/runtime/ssh)**: remote execution on a server over SSH
- **Multi-model** (`sonnet-4-*`, `grok-*`, `gpt-5-*`, `opus-4-*`)
  - Ollama supported for local LLMs ([docs](https://mux.coder.com/config/models#ollama-local))
  - OpenRouter supported for long-tail of LLMs ([docs](https://mux.coder.com/config/models#openrouter-cloud))
- **VS Code Extension**: Jump into Xum workspaces directly from VS Code ([docs](https://mux.coder.com/integrations/vscode-extension))
- Supporting UI and keybinds for efficiently managing a suite of agents
- Rich markdown outputs (mermaid diagrams, LaTeX, etc.)

Xum has a custom agent loop but much of the core UX is inspired by Claude Code. You'll find familiar features like Plan/Exec mode, vim inputs, `/compact` and new ones
like [opportunistic compaction](https://mux.coder.com/workspaces/compaction) and [mode prompts](https://mux.coder.com/agents/instruction-files#mode-prompts).

**[Read the full documentation →](https://mux.coder.com)**

## Install

Download pre-built binaries from [the releases page](https://github.com/coder/mux/releases) for
macOS and Linux.

[More on installation →](https://mux.coder.com/install)

## Screenshots

<!-- Screenshots below are generated from Storybook stories under Docs/README Screenshots -->
<table>
<tr>
<td align="center" width="50%">
<img src="./docs/img/code-review.webp" alt="Screenshot of code review" width="100%" /><br>
<sub>Integrated code-review for faster iteration</sub>
</td>
<td align="center" width="50%">
<img src="./docs/img/agent-status.webp" alt="Screenshot of agent status" width="100%" /><br>
<sub>Agents report their status through the sidebar</sub>
</td>
</tr>
<tr>
<td align="center" width="50%">
<img src="./docs/img/git-status.webp" alt="Screenshot of git status" width="100%" /><br>
<sub>Git divergence UI keeps you looped in on changes and potential conflicts</sub>
</td>
<td align="center" width="50%">
<img src="./docs/img/plan-mermaid.webp" alt="Screenshot of mermaid diagram" width="100%" /><br>
<sub>Mermaid diagrams make it easier to review complex proposals from the Agent</sub>
</td>
</tr>
<tr>
<td align="center" colspan="2">
<img src="./docs/img/costs-tab.webp" alt="Screenshot of costs table" width="50%" /><br>
<sub>Stay looped in on costs and token consumption</sub>
</td>
</tr>
<tr>
<td align="center" colspan="2">
<img src="./docs/img/context-management.webp" alt="Screenshot of context management dialog" width="50%" /><br>
<sub>Context management dialog keeps compaction controls in one place</sub>
</td>
</tr>
<tr>
<td align="center" colspan="2">
<img src="./docs/img/mobile-server-mode.webp" alt="Screenshot of Xum mobile UI" width="40%" /><br>
<sub>Xum server mode has a responsive UI for mobile users</sub>
</td>
</tr>
</table>

## More reading

See [the documentation](https://mux.coder.com) for more details.

## Development

See [AGENTS.md](./AGENTS.md) for development setup and guidelines.

## License

Copyright (C) 2026 Coder Technologies, Inc.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, version 3 of the License.

See [LICENSE](./LICENSE) for details.
