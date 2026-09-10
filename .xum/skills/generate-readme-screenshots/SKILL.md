---
name: generate-readme-screenshots
description: >-
  Regenerate high-resolution README screenshots from Storybook stories.
  Use this skill when visual diffs are detected in any story under
  "Docs/README Screenshots", or when story data/layout changes require
  updated documentation assets. Triggers on: visual regressions
  in readme screenshot stories, changes to App.readmeScreenshots.stories.tsx,
  changes to mockFactory.ts that affect screenshot stories, or explicit
  user request to update README images.
---

# Generate README Screenshots

## Purpose

The README screenshots in `docs/img/*.webp` are **not manually captured** — they are
deterministically generated from Storybook stories defined in
`src/browser/stories/App.readmeScreenshots.stories.tsx`. When any of these stories
change visually (detected in review or local inspection), the corresponding WebP
assets must be regenerated and committed.

## Quick Reference

```bash
# 1. Build Storybook
make storybook-build

# 2. Serve the static build (keep running in background)
python3 -m http.server 6006 -d storybook-static &

# 3. Capture all screenshots (3800px, WebP quality 90)
bun run scripts/capture-readme-screenshots.ts

# 4. Capture a single story
bun run scripts/capture-readme-screenshots.ts --story CodeReview
```

## Prerequisites

The capture pipeline requires these tools. **If any are missing, stop immediately
and report the issue to the user with full detail** — do not silently skip or
produce degraded output.

| Dependency   | Purpose                                | Check command                    |
| :----------- | :------------------------------------- | :------------------------------- |
| `bun`        | Script runtime                         | `bun --version`                  |
| `playwright` | Headless browser automation            | `bun -e "require('playwright')"` |
| `sharp`      | Image processing (resize, WebP)        | `bun -e "require('sharp')"`      |
| `python3`    | Static file server for Storybook build | `which python3`                  |

### Prerequisite Verification

Before running the pipeline, verify all dependencies:

```bash
bun --version && \
bun -e "require('playwright'); require('sharp'); console.log('deps ok')" && \
which python3
```

If **any** of these fail:

1. **Do not proceed** with screenshot generation.
2. Report the exact failing command and error to the user.
3. Suggest remediation:
   - Missing `playwright`: `bun add -d playwright && bunx playwright install chromium`
   - Missing `sharp`: `bun add -d sharp`
   - Missing `python3`: suggest installing Python or using an alternative static server
   - Missing `bun`: this is a hard requirement — the entire repo uses bun

## Architecture

### Resolution & Output

| Parameter                 | Value                                  |
| :------------------------ | :------------------------------------- |
| CSS Viewport              | 1900 × 1188                            |
| Device Scale Factor (DPR) | 2                                      |
| Native capture resolution | 3800 × 2376                            |
| Output format             | WebP (quality 90, lanczos3 resampling) |
| Output directory          | `docs/img/`                            |

### Story → Screenshot Mapping

| Story Export Name         | Output File               | Has Interaction                 |
| :------------------------ | :------------------------ | :------------------------------ |
| `CodeReview`              | `code-review.webp`        | No                              |
| `AgentStatusSidebar`      | `agent-status.webp`       | No                              |
| `GitStatusPopover`        | `git-status.webp`         | Yes (open dialog + toggle mode) |
| `PlanMermaidWithCosts`    | `plan-mermaid.webp`       | No                              |
| `CostsTabRich`            | `costs-tab.webp`          | No                              |
| `ContextManagementDialog` | `context-management.webp` | Yes (open settings dialog)      |
| `MobileServerMode`        | `mobile-server-mode.webp` | No                              |

### Key Files

| File                                                    | Role                                       |
| :------------------------------------------------------ | :----------------------------------------- |
| `src/browser/stories/App.readmeScreenshots.stories.tsx` | Story definitions and mock data            |
| `scripts/capture-readme-screenshots.ts`                 | Playwright + Sharp capture pipeline        |
| `src/browser/stories/mockFactory.ts`                    | Deterministic mock data factories          |
| `src/browser/stories/mocks/orpc.ts`                     | Mock ORPC backend (terminal, git, secrets) |
| `docs/img/*.webp`                                       | Output screenshot assets                   |

## Step-by-Step Procedure

### 1. Build Storybook

```bash
make storybook-build
```

This produces `storybook-static/` in the repo root.

### 2. Start a Static Server

The capture script expects Storybook at `http://localhost:6006`. Use a **background
bash task** (not `nohup` or `&` in foreground) so the server survives:

```bash
# As a background bash task with ~10min lifetime
python3 -m http.server 6006 -d storybook-static
```

Verify the server is reachable:

```bash
bun -e "const r = await fetch('http://localhost:6006'); console.log(r.status)"
```

> **Important:** `curl` may succeed when `bun fetch` fails (different DNS resolution).
> Always verify with `bun -e "fetch(...)"` since the capture script uses bun's fetch.

### 3. Run the Capture Script

```bash
bun run scripts/capture-readme-screenshots.ts --storybook-url http://localhost:6006
```

The script:

- Iterates all 7 stories sequentially
- Opens a fresh Playwright page per story
- Waits for `networkidle` + 2s stabilization
- Runs `playInteraction` if defined (with up to 3 retries for flaky interactions)
- Captures full-page PNG, then converts to WebP via Sharp
- Writes to `docs/img/<outputFile>`

### 4. Handle Failures

Stories with `playInteraction` (GitStatusPopover, ContextManagementDialog)
can be flaky under sequential load due to UI timing. The script retries each up to
3 times. If failures persist:

```bash
# Retry individual failed stories
bun run scripts/capture-readme-screenshots.ts --story GitStatusPopover
bun run scripts/capture-readme-screenshots.ts --story ContextManagementDialog
```

### 5. Verify & Commit

```bash
# Check all 7 generated files are present
for f in code-review agent-status git-status plan-mermaid costs-tab context-management mobile-server-mode; do
  bun -e "const s = require('sharp'); const m = await s('docs/img/${f}.webp').metadata(); console.log('${f}:', m.width + 'x' + m.height)"
done

# Stage and commit
git add docs/img/*.webp
git commit -m "regenerate README screenshots at 3800px"
```

## When to Run This

1. **Visual changes are flagged** in any `Docs/README Screenshots` story
2. **Story data changes** in `App.readmeScreenshots.stories.tsx` or `mockFactory.ts`
3. **UI component changes** that affect the visual appearance of screenshot stories
4. **Explicit user request** to refresh README images
5. **After rebasing** on main when upstream changes affect shared UI components

## Troubleshooting

### "Storybook is not running"

The capture script verifies Storybook is reachable before starting. Ensure:

- `make storybook-build` completed successfully
- The static server is running on port 6006
- Verify with `bun -e "fetch('http://localhost:6006')"` (not just `curl`)

### Interactive stories fail with timeout

Radix popovers/tooltips portal to `document.body` and require precise hover timing.
The retry logic handles most cases. If persistent:

- Run the failing story individually (`--story <Name>`)
- Check if the story's mock data or selectors drifted from the actual component

### Images look wrong (clipped, misaligned)

- Check viewport constants in `capture-readme-screenshots.ts` (1900×1188, DPR 2)
- Screenshots use viewport-only capture (not `fullPage`) — if content overflows the
  viewport, the story layout needs adjustment, not the capture script
- The `StoryDef` interface supports a `postProcess` hook for custom Sharp pipelines
  if a future story needs cropping/compositing, but no current stories use it

### Why there is no ProductHero screenshot story

Intentional. README now uses `xum-demo.gif` as the hero media. The README
screenshot pipeline covers only the 7 generated WebP assets that remain in
README, starting with `code-review.webp`.
