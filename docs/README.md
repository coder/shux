# Xum Documentation

This directory contains the source for Xum documentation hosted on [Mintlify](https://mintlify.com/).

**Live docs:** https://mux.coder.com

## Local Development

```bash
# Serve docs locally with hot reload
make docs-server
```

## Features

- ✅ **Mermaid diagrams** - Add diagrams with ` ```mermaid ` code blocks
- ✅ **Link checking** - CI validates all internal links via `mintlify broken-links`
- ✅ **Auto-deploy** - Mintlify automatically deploys on push to main

## Structure

```
docs/
├── docs.json        # Mintlify configuration (navigation, theme, etc.)
├── custom.css       # Custom styling
├── img/             # Images and logos
└── *.md             # Documentation pages
```

## Adding Content

1. Create a new `.md` file in `docs/`
2. Add frontmatter with title and description
3. Add the page to `docs.json` navigation
4. Use standard markdown + mermaid diagrams

Example frontmatter:

```markdown
---
title: Page Title
description: Brief description for SEO
---
```

## Writing Guidelines

See [STYLE.md](./STYLE.md) for documentation writing guidelines.

## CI/CD

- **Link checking**: CI runs `mintlify broken-links` on every PR
- **Deployment**: Mintlify GitHub app auto-deploys on push to main
