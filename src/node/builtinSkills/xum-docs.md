---
name: xum-docs
description: Index + offline snapshot of xum documentation (progressive disclosure).
---

# xum docs

This built-in skill helps the agent answer questions about **xum** (Coding Agent Multiplexer) without dumping the entire docs into context.

## How to use

### Prefer: read the bundled docs snapshot (recommended)

This skill bundles an **offline snapshot of the xum docs** under `references/docs/`.

Why prefer the bundled snapshot?

1. The docs tree below is guaranteed to match what’s embedded.
2. It’s more likely to match _your installed xum version_ (the live site may be ahead).

To read a specific page:

```ts
agent_skill_read_file({
  name: "xum-docs",
  filePath: "references/docs/config/models.mdx",
});
```

### Fallback: fetch the live docs (for newer features)

If the bundled docs don’t mention something (or you suspect the docs site has newer info), use `web_fetch`:

```ts
web_fetch({ url: "https://mux.coder.com/config/models" });
web_fetch({ url: "https://mux.coder.com/agents" });
```

#### Docs tree (auto-generated)

Use this index to find a page's:

- **Docs route** (for `web_fetch`)
- **Embedded file path** (for `agent_skill_read_file`)

<!-- BEGIN DOCS_TREE -->
- **Documentation**
  - **Getting Started**
    - Introduction (`/`) → `references/docs/index.mdx`
    - Install (`/install`) → `references/docs/install.mdx`: Download and install Xum for macOS, Linux, and Windows
    - **Models**
      - Models (`/config/models`) → `references/docs/config/models.mdx`: Select and configure AI models in Xum
      - Providers (`/config/providers`) → `references/docs/config/providers.mdx`: Configure API keys and settings for AI providers
    - Why Parallelize? (`/getting-started/why-parallelize`) → `references/docs/getting-started/why-parallelize.mdx`: Use cases for running multiple AI agents in parallel
    - Xum Gateway (`/getting-started/mux-gateway`) → `references/docs/getting-started/mux-gateway.mdx`: Log in to Xum Gateway to get evaluation credits
    - CLI (`/reference/cli`) → `references/docs/reference/cli.mdx`: Run one-off agent tasks and durable workflows from the command line
  - **Workspaces**
    - Workspaces (`/workspaces`) → `references/docs/workspaces/index.mdx`: Isolated development environments for parallel agent work
    - Scratch chats (`/workspaces/scratch-chats`) → `references/docs/workspaces/scratch-chats.mdx`: Start a durable chat with an app-managed folder and no project or Git repository.
    - Forking Workspaces (`/workspaces/fork`) → `references/docs/workspaces/fork.mdx`: Clone workspaces with conversation history to explore alternatives
    - .xumignore (`/workspaces/xumignore`) → `references/docs/workspaces/xumignore.mdx`: Sync gitignored files to worktree workspaces
    - **Compaction**
      - Compaction (`/workspaces/compaction`) → `references/docs/workspaces/compaction/index.mdx`: Managing conversation context size with compaction
      - Manual Compaction (`/workspaces/compaction/manual`) → `references/docs/workspaces/compaction/manual.mdx`: Commands for manually managing conversation context
      - Automatic Compaction (`/workspaces/compaction/automatic`) → `references/docs/workspaces/compaction/automatic.mdx`: Let Xum automatically compact your conversations based on usage or idle time
      - Customization (`/workspaces/compaction/customization`) → `references/docs/workspaces/compaction/customization.mdx`: Customize the compaction system prompt
    - **Runtimes**
      - Runtimes (`/runtime`) → `references/docs/runtime/index.mdx`: Configure where and how Xum executes agent workspaces
      - Local Runtime (`/runtime/local`) → `references/docs/runtime/local.mdx`: Run agents directly in your project directory
      - Worktree Runtime (`/runtime/worktree`) → `references/docs/runtime/worktree.mdx`: Isolated git worktree environments for parallel agent work
      - SSH Runtime (`/runtime/ssh`) → `references/docs/runtime/ssh.mdx`: Run agents on remote hosts over SSH for security and performance
      - Coder Runtime (`/runtime/coder`) → `references/docs/runtime/coder.mdx`: Run agents on Coder workspaces
      - Docker Runtime (`/runtime/docker`) → `references/docs/runtime/docker.mdx`: Run agents in isolated Docker containers
      - Dev Container Runtime (`/runtime/devcontainer`) → `references/docs/runtime/devcontainer.mdx`: Run agents in containers defined by devcontainer.json
    - **Hooks**
      - Init Hooks (`/hooks/init`) → `references/docs/hooks/init.mdx`: Run setup commands automatically when creating new workspaces
      - Tool Hooks (`/hooks/tools`) → `references/docs/hooks/tools.mdx`: Block dangerous commands, lint after edits, and set up your environment
      - Environment Variables (`/hooks/environment-variables`) → `references/docs/hooks/environment-variables.mdx`: Environment variables available in agent bash commands and hooks
  - **Agents**
    - Agents (`/agents`) → `references/docs/agents/index.mdx`: Define custom agents (modes + subagents) as Markdown files
    - Instruction Files (`/agents/instruction-files`) → `references/docs/agents/instruction-files.mdx`: Configure agent behavior with AGENTS.md files
    - Agent Skills (`/agents/agent-skills`) → `references/docs/agents/agent-skills.mdx`: Share reusable workflows and references with skills
    - Plan Mode (`/agents/plan-mode`) → `references/docs/agents/plan-mode.mdx`: Review and collaborate on plans before execution
    - System Prompt (`/agents/system-prompt`) → `references/docs/agents/system-prompt.mdx`: How Xum constructs the system prompt for AI models
    - Prompting Tips (`/agents/prompting-tips`) → `references/docs/agents/prompting-tips.mdx`: Tips and tricks for getting the most out of your AI agents
    - Best of N (`/agents/best-of-n`) → `references/docs/agents/best-of-n.mdx`: Improve plans, analysis, and reviews by asking Xum to explore multiple candidate answers in parallel
  - **Configuration**
    - MCP Servers (`/config/mcp-servers`) → `references/docs/config/mcp-servers.mdx`: Extend agent capabilities with Model Context Protocol servers
    - Policy File (`/config/policy-file`) → `references/docs/config/policy-file.mdx`: Admin-enforced restrictions for providers, models, MCP, and runtimes
    - Project Secrets (`/config/project-secrets`) → `references/docs/config/project-secrets.mdx`: Manage environment variables and API keys for your projects
    - Agentic Git Identity (`/config/agentic-git-identity`) → `references/docs/config/agentic-git-identity.mdx`: Configure a separate Git identity for AI-generated commits
    - Keyboard Shortcuts (`/config/keybinds`) → `references/docs/config/keybinds.mdx`: Complete keyboard shortcut reference for Xum
    - Notifications (`/config/notifications`) → `references/docs/config/notifications.mdx`: Configure how agents notify you about important events
    - Server Access (`/config/server-access`) → `references/docs/config/server-access.mdx`: Configure authentication and session controls for xum server/browser mode
    - Vim Mode (`/config/vim-mode`) → `references/docs/config/vim-mode.mdx`: Vim-style editing in the Xum chat input
  - **Guides**
    - GitHub Actions (`/guides/github-actions`) → `references/docs/guides/github-actions.mdx`: Automate your workflows with xum run in GitHub Actions
    - Symbol Shortcuts (`/guides/symbol-shortcuts`) → `references/docs/guides/symbol-shortcuts.mdx`: Insert math and trading symbols in the Xum chat input with LaTeX-style backslash commands
    - Agentic Git Identity (`/config/agentic-git-identity`) → `references/docs/config/agentic-git-identity.mdx`: Configure a separate Git identity for AI-generated commits
    - Prompting Tips (`/agents/prompting-tips`) → `references/docs/agents/prompting-tips.mdx`: Tips and tricks for getting the most out of your AI agents
  - **Integrations**
    - VS Code Extension (`/integrations/vscode-extension`) → `references/docs/integrations/vscode-extension.mdx`: Pair Xum workspaces with VS Code and Cursor editors
    - ACP (Editor Integrations) (`/integrations/acp`) → `references/docs/integrations/acp.mdx`: Connect Xum to Zed, Neovim, and JetBrains via the Agent Client Protocol
  - **Reference**
    - Mux compatibility (`/reference/mux-compatibility`) → `references/docs/reference/mux-compatibility.mdx`: Upgrade, downgrade, storage, command, environment, and deep-link compatibility during the Xum rename
    - Debugging (`/reference/debugging`) → `references/docs/reference/debugging.mdx`: View live backend logs and diagnose issues
    - Telemetry (`/reference/telemetry`) → `references/docs/reference/telemetry.mdx`: What Xum collects, what it doesn’t, and how to disable it
    - Storybook (`/reference/storybook`) → `references/docs/reference/storybook.mdx`: Develop and test Xum UI states in isolation
    - Terminal Benchmarking (`/reference/benchmarking`) → `references/docs/reference/benchmarking.mdx`: Run Terminal-Bench benchmarks with the Xum adapter
    - Context Boundaries for Compaction and Reset (`/adr/0003-context-boundaries-for-compaction-and-reset`) → `references/docs/adr/0003-context-boundaries-for-compaction-and-reset.md`: Architecture decision for modeling provider context windows separately from transcript history
    - CLI Goal Runs are not strict /goal aliases (`/adr/0004-cli-goal-runs-are-not-strict-goal-aliases`) → `references/docs/adr/0004-cli-goal-runs-are-not-strict-goal-aliases.md`: Architecture decision for giving xum run --goal CLI-specific completion and limit semantics
    - AGENTS.md (`/AGENTS`) → `references/docs/AGENTS.md`: Agent instructions for AI assistants working on the Xum codebase
<!-- END DOCS_TREE -->

1. Read the docs navigation (source of truth for which pages exist):

```ts
agent_skill_read_file({ name: "xum-docs", filePath: "references/docs/docs.json" });
```

2. Read a specific page by path (mirrors `docs/` in the xum repo):

- `/agents` → `references/docs/agents/index.mdx`
- `/config/models` → `references/docs/config/models.mdx`
- `/runtime` → `references/docs/runtime/index.mdx`

```ts
agent_skill_read_file({
  name: "xum-docs",
  filePath: "references/docs/config/models.mdx",
});
```

Notes:

- Many pages are `.mdx`; some are `.../index.mdx`.
- Images are not embedded; you may see `/img/...` references.

## When to use

Use this skill when the user asks how xum works (workspaces, runtimes, agents, models, hooks, keybinds, etc.).

## Links

- **GitHub**: https://github.com/coder/mux
- **Documentation**: https://mux.coder.com
