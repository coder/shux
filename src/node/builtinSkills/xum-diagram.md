---
name: xum-diagram
description: Mermaid diagram best practices and text-based chart alternatives
---

# Diagrams & Charts

Use this skill when creating diagrams, flowcharts, or chart-like visualizations.

## Mermaid (rendered)

The app renders fenced `mermaid` code blocks as interactive diagrams.

Best practices:

- Avoid side-by-side subgraphs (they display too wide)
- For comparisons, use separate diagram blocks or single graph with visual separation
- When using custom fill colors, include contrasting color property (e.g., `style note fill:#ff6b6b,color:#fff`)
- Make good use of visual space: e.g. use inline commentary
- Wrap node labels containing brackets or special characters in quotes (e.g., `Display["Message[]"]` not `Display[Message[]]`)

Supported diagram types: flowchart, sequence, class, state, ER, Gantt, pie, git graph, mindmap, timeline, sankey, and more. Choose the type that best fits the data.

## Text-based alternatives (no rendering required)

Not every visualization needs Mermaid. Prefer lightweight formats when they suffice:

- **Markdown tables** — best for structured comparisons, feature matrices, or tabular data
- **Bulleted/numbered lists** — best for hierarchies, step sequences, or simple trees
- **Indented tree notation** — for directory structures or shallow hierarchies
- **ASCII/Unicode bars** — quick inline quantitative comparisons (e.g., `████░░ 67%`)

Choose Mermaid when relationships, flow, or topology matter. Choose text when the data is tabular or sequential.
