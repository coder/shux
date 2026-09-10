---
name: deep-research
description: "[Workflow] Run a multi-source, adversarially verified research workflow."
---

# Deep Research

Use this workflow when the user wants a deep, multi-source, fact-checked research report. Before invoking it, make sure the request is specific enough to research directly. If the prompt is underspecified, ask a few clarifying questions and pass the refined question as `input`.

Invoke with:

```js
workflow_run({
  script_path: "skill://deep-research/workflow.js",
  args: { input: "<refined research question>" },
});
```

Default to foreground mode because the user normally needs the final report before you can answer. If the user explicitly asks you to research in the background or be notified later, pass `run_in_background: true`, report the `runId`, and end the turn; Xum will wake the workspace with the terminal workflow result.

The workflow scopes search angles, searches and fetches sources, extracts falsifiable claims, verifies claims adversarially with exec agents using their configured defaults, and synthesizes a cited report with caveats.
