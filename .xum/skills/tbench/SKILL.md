---
name: tbench
description: Terminal-Bench integration for Xum agent benchmarking and failure analysis
---

# Terminal-Bench Integration

This directory contains the xum agent adapter for [Terminal-Bench 2.0](https://tbench.ai/), using [Harbor](https://harborframework.com/) as the evaluation harness.

## Quick Start

When user asks to run a tbench, generally assume they mean in CI via workflow_dispatch.

```bash
# Run full benchmark suite
make benchmark-terminal

# Run specific tasks
make benchmark-terminal TB_TASK_NAMES="hello-world chess-best-move"

# Run with specific model and xhigh thinking
MUX_RUN_ARGS="--thinking xhigh" make benchmark-terminal TB_ARGS="--agent-kwarg model_name=anthropic/claude-opus-5"

# Run on Daytona cloud (high parallelism)
TB_ENV=daytona TB_CONCURRENCY=48 make benchmark-terminal
```

## Daytona Cloud Sandboxes

For faster benchmarks, use [Daytona](https://www.daytona.io/) cloud sandboxes instead of local Docker:

```bash
# Set API key (get from https://app.daytona.io)
export DAYTONA_API_KEY="your-api-key"

# Run with 48 concurrent cloud sandboxes (~6x faster than local)
make benchmark-terminal TB_ENV=daytona TB_CONCURRENCY=48

# Run specific tasks on Daytona
make benchmark-terminal TB_ENV=daytona TB_CONCURRENCY=48 TB_TASK_NAMES="chess-best-move stockfish-elo"
```

**Account limits (Tier 3):** Pool of 250 vCPU / 500GB RAM. Most tasks require 1 vCPU / 2GB RAM, with a few needing up to 4 vCPU / 8GB RAM. Harbor automatically requests the correct per-task resources.

**Speed comparison:**
| Environment | Concurrency | Full suite time |
|-------------|-------------|-----------------|
| Local Docker | 4 | ~90 min |
| Daytona Cloud | 48 | ~10-15 min |

## Configuration

### Environment Variables

- `TB_DATASET`: Dataset to use (default: `terminal-bench@2.0`)
- `TB_CONCURRENCY`: Number of concurrent tasks (default: 4)
- `TB_TIMEOUT`: Global timeout in seconds (default: 1800 = 30 minutes)
- `TB_ENV`: Environment to run in (`local` or `daytona`)
- `TB_TASK_NAMES`: Space-separated task names to run (default: all tasks)
- `TB_ARGS`: Additional arguments passed to harbor
- `MUX_RUN_ARGS`: CLI flags passed directly to `mux run` inside the container (e.g., `--thinking high --use-1m --budget 5.00`). This is the primary mechanism for all `mux run` flags — avoids per-flag plumbing.
- `MUX_RUN_AS_GOAL`: When set to `1`, runs each task instruction as a strict `mux run --goal` objective while still piping the instruction to stdin. Use `MUX_RUN_ARGS` for goal limits such as `--goal-turns` and `--goal-budget`. Incomplete strict-goal exits are left scoreable so Harbor can verify the workspace.

### Timeout Handling

The benchmark uses Harbor's **global timeout** applied to all tasks. The default is **30 minutes (1800 seconds)**, which provides sufficient time for most tasks while catching genuinely stuck agents. The xum runner does not wrap the command in GNU `timeout`; Harbor must classify task timeouts as `AgentTimeoutError` so the workflow can distinguish timeout/infra cases from xum process failures.

**Design Rationale:**

Based on analysis of Oct 30, 2025 nightly runs:

- Longest successful task: `blind-maze-explorer-algorithm.hard` at 20 minutes
- 95th percentile: ~15 minutes
- Mean duration: ~6 minutes

The 30-minute default provides comfortable headroom for complex tasks without excessive wait times for failed attempts.

**Override timeout:**

```bash
# Run with 60 minute timeout for very complex tasks
TB_TIMEOUT=3600 make benchmark-terminal

# Run with shorter 10 minute timeout for quick iteration
TB_TIMEOUT=600 make benchmark-terminal TB_SAMPLE_SIZE=5
```

**Note:** We prefer global timeout defaults over per-task configuration to avoid complexity and maintenance burden. If you find tasks consistently timing out, increase `TB_TIMEOUT` rather than adding per-task configuration.

## Agent Configuration

The agent adapter accepts a few Harbor kwargs (passed via `--agent-kwarg`):

- `model_name`: Model to use (e.g., `anthropic/claude-opus-5`, `openai/gpt-5.6-sol`)
- `experiments`: Experiments to enable, comma-separated (e.g., `programmatic-tool-calling`)

All other `mux run` CLI flags (thinking level, mode, runtime, budget, etc.) are passed via `MUX_RUN_ARGS` — no per-flag plumbing needed.

**CI dispatch (primary method):**

```bash
# Run with model, thinking, and 1M context
gh workflow run terminal-bench.yml \
  -f model_name=anthropic/claude-opus-5 \
  -f mux_run_args="--thinking high --use-1m"

# Run GPT-5.6 Sol with budget cap and high thinking
gh workflow run terminal-bench.yml \
  -f model_name=openai/gpt-5.6-sol \
  -f mux_run_args="--thinking high --budget 5.00"
```

**Strict goal-mode runs:**

```bash
# Run a single task as a strict CLI Goal Run
MUX_RUN_AS_GOAL=1 \
MUX_RUN_ARGS="--thinking high --goal-turns 30 --goal-budget 10.00" \
make benchmark-terminal TB_TASK_NAMES="chess-best-move"

# CI dispatch
gh workflow run terminal-bench.yml \
  -f model_name=anthropic/claude-sonnet-4-5 \
  -f task_names=chess-best-move \
  -f mux_run_as_goal=true \
  -f mux_run_args="--thinking high --goal-turns 30 --goal-budget 10.00"
```

**Local runs:**

```bash
# Pass flags via MUX_RUN_ARGS env var
MUX_RUN_ARGS="--thinking high --use-1m" make benchmark-terminal

# Model and experiments via TB_ARGS
MUX_RUN_ARGS="--thinking high" make benchmark-terminal TB_ARGS="--agent-kwarg model_name=openai/gpt-5.6-sol --agent-kwarg experiments=programmatic-tool-calling"
```

## Monitoring local benchmark output

Local Terminal-Bench runs can be long and log-driven. If you intentionally run one locally instead of dispatching CI, start it as a monitored background bash so Xum wakes on terminal benchmark failure/completion lines instead of requiring parent-side polling.

```ts
bash({
  script: 'make benchmark-terminal TB_TASK_NAMES="hello-world"',
  display_name: "Terminal-Bench Local",
  run_in_background: true,
  timeout_secs: 7200,
  monitor: {
    filter: "FAILED|ERROR|Traceback|AgentTimeoutError|results saved|Results saved|pass rate|score",
    cooldown_ms: 1000,
    max_events: 5,
  },
});
```

Use this only for line-oriented local process output. For GitHub workflow dispatch status, use a bounded background task/workflow monitor that polls `gh`/GitHub state.

## Results

Results are saved to `runs/YYYY-MM-DD__HH-MM-SS/`:

- `results.json`: Aggregate results with pass/fail rates
- `run_metadata.json`: Run configuration and metadata
- `<task-id>/`: Per-task directories containing:
  - `sessions/agent.log`: Full agent execution log
  - `sessions/agent.cast`: Asciinema recording of agent session
  - `sessions/tests.log`: Test execution output
  - `results.json`: Per-trial results

## CI/CD Integration

## Querying Results from BigQuery

Mux Terminal-Bench results are uploaded to BigQuery after CI runs. Query via `bq` CLI after authenticating with `gcloud auth login` and setting project to `mux-benchmarks`.

**Table:** `mux-benchmarks.benchmarks.tbench_results`

**Schema:** `run_id` (STRING), `task_id` (STRING), `model_name` (STRING), `thinking_level` (STRING: off/low/medium/high), `mode` (STRING: plan/exec), `dataset` (STRING), `experiments` (STRING), `passed` (BOOL), `score` (FLOAT), `n_input_tokens` (INT), `n_output_tokens` (INT), `github_run_id` (INT), `github_sha` (STRING), `ingested_at` (TIMESTAMP).

See `.github/workflows/terminal-bench.yml` and `.github/workflows/nightly-terminal-bench.yml` for GitHub Actions integration.

**Nightly workflow** runs both Claude and GPT models on the full task suite, uploading results as artifacts.

## Leaderboard Submission

To submit xum results to the [Terminal-Bench 2.0 leaderboard](https://tbench.ai/leaderboard/terminal-bench/2.0):

### Step 1: Prepare Submission

The leaderboard computes pass@k from multiple attempts per task. Provide
multiple runs so each becomes its own job folder inside the submission.

```bash
# Download latest 5 successful nightly runs (recommended for submission)
python3 benchmarks/terminal_bench/prepare_leaderboard_submission.py --n-runs 5

# Use specific run IDs (each becomes a separate job folder)
python3 benchmarks/terminal_bench/prepare_leaderboard_submission.py --run-id 111 222 333 444 555

# Use multiple existing artifact directories
python3 benchmarks/terminal_bench/prepare_leaderboard_submission.py --artifacts-dir ./run1 ./run2

# Download latest single run (quick iteration)
python3 benchmarks/terminal_bench/prepare_leaderboard_submission.py

# Only prepare specific models
python3 benchmarks/terminal_bench/prepare_leaderboard_submission.py --n-runs 5 --models anthropic/claude-opus-5
```

This creates a properly structured submission folder at `leaderboard_submission/` containing:

```
submissions/terminal-bench/2.0/Mux__<model>/
  metadata.yaml       # Agent and model info
  <job-folder-1>/     # Results from run 1
    config.json
    result.json
    <trial-1>/
      config.json
      result.json
      agent/
      verifier/
    ...
  <job-folder-2>/     # Results from run 2
    ...
```

### Step 2: Submit via HuggingFace Python API

The `hf upload` CLI tends to timeout on large submissions due to LFS file handling.
Use the Python API with an extended timeout instead:

```bash
# Install huggingface_hub (via uv or pip)
pip install huggingface_hub

# Authenticate (one-time setup)
hf auth login
```

```python
import httpx
from huggingface_hub import HfApi
from huggingface_hub.utils import configure_http_backend

configure_http_backend(
    backend_factory=lambda: httpx.Client(timeout=httpx.Timeout(300.0, connect=60.0))
)

api = HfApi()
api.upload_folder(
    repo_id="alexgshaw/terminal-bench-2-leaderboard",
    folder_path="./leaderboard_submission/submissions",
    path_in_repo="submissions",
    repo_type="dataset",
    create_pr=True,
    commit_message="Add Xum + <Model> submission",
    commit_description="- Agent: Xum (Coder)\n- Model: <model>\n- <N> tasks × <K> attempts",
)
```

The PR will be automatically validated by the leaderboard bot. Once merged, results appear on the leaderboard.

**Tips from past submissions:**

- The prepare script already strips `*.log` files (they trigger HF LFS and cause timeouts)
- `--artifacts-dir` accepts raw job folders directly (e.g., an extracted tarball root)
- To update an existing PR, pass `revision="refs/pr/<N>"` instead of `create_pr=True`
- To remove stale files from a PR, use `api.delete_folder(..., revision="refs/pr/<N>")`

## Files

- `mux_agent.py`: Main agent adapter implementing Harbor's `BaseInstalledAgent` interface
- `mux-run.sh`: Shell script that sets up environment and invokes xum CLI
- `mux_payload.py`: Helper to package xum app for containerized execution
- `mux_setup.sh.j2`: Jinja2 template for agent installation script
- `prepare_leaderboard_submission.py`: Script to prepare results for leaderboard submission
- `analyze_failure_rates.py`: Analyze failure rates to find optimization opportunities
- `download_run_logs.py`: Download and inspect raw agent logs from nightly runs

## Comparative Failure Analysis Workflow

When investigating why Xum fails on a task more than other agents, consider this workflow:

### 1. Identify High-Priority Failures

```bash
# Find tasks where Xum underperforms (high M/O ratio = Xum fails more than others)
python benchmarks/terminal_bench/analyze_failure_rates.py --top 20
```

### 2. Check BigQuery for Failure Patterns

```bash
# Authenticate and set project
gcloud auth login && gcloud config set project mux-benchmarks

# Query pass/fail by model for specific task (strip __hash suffix mentally)
bq query --use_legacy_sql=false '
SELECT model_name, passed, COUNT(*) as runs
FROM `mux-benchmarks.benchmarks.tbench_results`
WHERE REGEXP_REPLACE(task_id, r"__[a-zA-Z0-9]+$", "") = "TASK_NAME_HERE"
  AND github_workflow = "Nightly Terminal-Bench"
  AND passed IS NOT NULL
GROUP BY model_name, passed
ORDER BY model_name, passed
'
```

### 3. Download and Inspect Agent Logs

```bash
# List recent nightly runs
python benchmarks/terminal_bench/download_run_logs.py --list-runs

# Download latest run and filter to failing task
python benchmarks/terminal_bench/download_run_logs.py --task TASK_NAME --failures-only

# Download specific run, filter to specific model
python benchmarks/terminal_bench/download_run_logs.py --run-id 21230456195 --model opus --task TASK_NAME

# Verbose mode shows stderr from agent execution
python benchmarks/terminal_bench/download_run_logs.py --task TASK_NAME -v
```

Logs are cached in `.run_logs/<run-id>/`. Inspect:

- `agent/command-0/stdout.txt` — Full agent output (JSONL stream)
- `agent/command-0/stderr.txt` — Errors during execution
- `result.json` — Trial result with `verifier_result` and `exception_info`

### 4. Compare with Leaderboard Submissions

```bash
# Clone leaderboard repo from HuggingFace (cached in .leaderboard_cache/)
cd benchmarks/terminal_bench
git clone https://huggingface.co/datasets/alexgshaw/terminal-bench-2-leaderboard .leaderboard_cache/terminal-bench-2-leaderboard 2>/dev/null

# Find passing submissions for the task
find .leaderboard_cache -path "*TASK_NAME*" -name "result.json" -exec sh -c '
  agent=$(echo "$1" | cut -d/ -f5)
  reward=$(cat "$1" | python3 -c "import json,sys; print(json.load(sys.stdin).get(\"verifier_result\",{}).get(\"rewards\",{}).get(\"reward\",0))")
  echo "$agent: reward=$reward"
' _ {} \;
```

## Analyzing Failure Rates

To identify where Xum underperforms relative to other top agents, use the analysis script:

```bash
# Run analysis (requires bq CLI for Xum results, git for leaderboard data)
python benchmarks/terminal_bench/analyze_failure_rates.py

# Show more results
python benchmarks/terminal_bench/analyze_failure_rates.py --top 50

# Filter to specific Xum model
python benchmarks/terminal_bench/analyze_failure_rates.py --mux-model sonnet

# Force refresh of cached data
python benchmarks/terminal_bench/analyze_failure_rates.py --refresh

# Output as JSON for further processing
python benchmarks/terminal_bench/analyze_failure_rates.py --json > opportunities.json
```

The script computes the **M/O ratio** for each task:

```
M/O ratio = Xum failure rate / Average failure rate of top 10 agents
```

Tasks with **high M/O ratio** are where Xum underperforms relative to competitors—these represent the best optimization opportunities.

Example output:

```
================================================================================
OPTIMIZATION OPPORTUNITIES (sorted by M/O ratio)
================================================================================
Task ID                                   Xum Fail%  Avg Other%  M/O Ratio Agent
--------------------------------------------------------------------------------
some-difficult-task                         100.0%       10.0%       9.09 Mux__Claude-Sonnet-4.5
another-task                                 80.0%       20.0%       3.64 Mux__Claude-Sonnet-4.5
...

================================================================================
SUMMARY
================================================================================
Total tasks with Xum failures: 42
  High priority (M/O > 2.0):   12
  Medium priority (1.0 < M/O ≤ 2.0): 8
```
