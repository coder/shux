#!/usr/bin/env python3
"""
Analyze Terminal-Bench failure rates to identify optimization opportunities.

Pulls Mux results from BigQuery and other agents from HuggingFace leaderboard.
Computes:
  M/O ratio = Mux failure rate / Average failure rate of top 10 agents

Tasks with high M/O ratio are where Mux underperforms relative to competitors,
representing the best optimization opportunities.

Usage:
    # Default: analyze and show top 20 opportunities
    python benchmarks/terminal_bench/analyze_failure_rates.py

    # Show more results
    python benchmarks/terminal_bench/analyze_failure_rates.py --top 50

    # Filter to specific Mux model
    python benchmarks/terminal_bench/analyze_failure_rates.py --mux-model "claude-sonnet"

    # Force re-download of data
    python benchmarks/terminal_bench/analyze_failure_rates.py --refresh

Requirements:
    git (for cloning from HuggingFace)
    bq CLI (for querying Mux results from BigQuery)
"""

import argparse
import json
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

try:
    from .tbench_utils import extract_task_id, get_passed
except ImportError:
    from tbench_utils import extract_task_id, get_passed  # type: ignore[import-not-found,no-redef]

# Data directory for caching downloaded results
CACHE_DIR = Path(__file__).parent / ".leaderboard_cache"
LEADERBOARD_REPO = "alexgshaw/terminal-bench-2-leaderboard"
DATASET_VERSION = "2.0"


@dataclass
class TaskResult:
    """Result for a single task from an agent."""

    task_id: str
    passed: bool
    agent_name: str
    model_name: str


@dataclass
class AgentStats:
    """Aggregate stats for an agent."""

    agent_name: str
    model_name: str
    n_tasks: int
    n_passed: int

    @property
    def pass_rate(self) -> float:
        return self.n_passed / self.n_tasks if self.n_tasks > 0 else 0.0

    @property
    def fail_rate(self) -> float:
        return 1.0 - self.pass_rate


def download_leaderboard_data(refresh: bool = False) -> Path:
    """
    Download or update the leaderboard repo from HuggingFace using git clone.

    Uses git directly to avoid HuggingFace API rate limits.
    Returns the path to the cloned repo.
    """
    import subprocess
    import time

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    repo_path = CACHE_DIR / "terminal-bench-2-leaderboard"
    marker_file = repo_path / ".last_download"
    repo_url = f"https://huggingface.co/datasets/{LEADERBOARD_REPO}"

    # Check if we should skip download
    if repo_path.exists() and not refresh:
        if marker_file.exists():
            mtime = marker_file.stat().st_mtime
            age_hours = (time.time() - mtime) / 3600
            if age_hours < 24:
                print(
                    f"Using cached data (age: {age_hours:.1f}h). Use --refresh to update.",
                    file=sys.stderr,
                )
                return repo_path

    try:
        if repo_path.exists():
            # Pull latest changes
            print(f"Updating leaderboard data from {repo_url}...", file=sys.stderr)
            subprocess.run(
                ["git", "pull", "--ff-only"],
                cwd=repo_path,
                check=True,
                capture_output=True,
            )
        else:
            # Fresh clone (full clone needed - submissions are in different commits)
            print(f"Cloning leaderboard data from {repo_url}...", file=sys.stderr)
            subprocess.run(
                ["git", "clone", repo_url, str(repo_path)],
                check=True,
                capture_output=True,
            )
        marker_file.touch()
        print(f"Data ready at: {repo_path}", file=sys.stderr)
        return repo_path
    except subprocess.CalledProcessError as e:
        print(f"Git error: {e.stderr.decode() if e.stderr else e}", file=sys.stderr)
        if repo_path.exists():
            print("Using existing cached data.", file=sys.stderr)
            return repo_path
        raise


def query_mux_results_from_bq() -> list[TaskResult]:
    """
    Query Mux results from BigQuery.

    Uses the bq CLI to query mux-benchmarks.benchmarks.tbench_results.
    Returns TaskResult objects for all Mux benchmark runs.
    """
    import csv
    import subprocess

    query = """
    SELECT
        task_id,
        model_name,
        thinking_level,
        passed
    FROM `mux-benchmarks.benchmarks.tbench_results`
    WHERE dataset = 'terminal-bench@2.0'
    """

    print("Querying Mux results from BigQuery...", file=sys.stderr)
    try:
        result = subprocess.run(
            [
                "bq",
                "query",
                "--use_legacy_sql=false",
                "--format=csv",
                "--max_rows=100000",
                query,
            ],
            capture_output=True,
            text=True,
            check=True,
        )
    except FileNotFoundError:
        print(
            "Error: bq CLI not found. Install Google Cloud SDK and run 'gcloud auth login'",
            file=sys.stderr,
        )
        return []
    except subprocess.CalledProcessError as e:
        print(f"BigQuery error: {e.stderr}", file=sys.stderr)
        return []

    # Parse CSV output
    results: list[TaskResult] = []
    lines = result.stdout.strip().split("\n")
    if len(lines) < 2:
        print("No Mux results found in BigQuery", file=sys.stderr)
        return results

    reader = csv.DictReader(lines)
    skipped = 0
    for row in reader:
        # Skip incomplete runs (NULL passed)
        passed_str = row.get("passed", "").lower()
        if passed_str not in ("true", "false"):
            skipped += 1
            continue

        # Create agent name from model + thinking level for grouping
        model = row.get("model_name", "unknown")
        thinking = row.get("thinking_level", "off")

        # Strip trial hash from task_id (format: task-name__HASH -> task-name)
        raw_task_id = row["task_id"]
        task_id = raw_task_id.rsplit("__", 1)[0] if "__" in raw_task_id else raw_task_id

        results.append(
            TaskResult(
                task_id=task_id,
                passed=passed_str == "true",
                agent_name="Mux",
                model_name=f"{model}@{thinking}",
            )
        )

    print(f"Found {len(results)} Mux results from BigQuery", file=sys.stderr)
    if skipped:
        print(f"  (skipped {skipped} incomplete runs)", file=sys.stderr)
    return results


def parse_leaderboard_results(
    repo_path: Path, exclude_mux: bool = True
) -> list[TaskResult]:
    """
    Parse all agent results from the leaderboard repo structure.

    Expected structure:
        submissions/terminal-bench/2.0/<Agent>__<Model>/
            metadata.yaml
            <job-folder>/
                <trial-folder>/
                    result.json  # contains "passed" or "score"

    Args:
        exclude_mux: If True, skip Mux agents (we get those from BigQuery)
    """
    results: list[TaskResult] = []
    submissions_dir = repo_path / "submissions" / "terminal-bench" / DATASET_VERSION

    if not submissions_dir.exists():
        print(f"Warning: No submissions found at {submissions_dir}", file=sys.stderr)
        return results

    for agent_dir in submissions_dir.iterdir():
        if not agent_dir.is_dir():
            continue

        # Parse agent name and model from folder name (e.g., "Mux__Claude-Sonnet-4.5")
        parts = agent_dir.name.split("__", 1)
        agent_name = parts[0]
        model_name = parts[1] if len(parts) > 1 else "unknown"

        # Skip Mux agents if requested (we get those from BigQuery)
        if exclude_mux and agent_name.lower() == "mux":
            continue

        # Find all result.json files in trial folders
        for result_file in agent_dir.rglob("*/result.json"):
            # Skip job-level result.json (direct child of job folder)
            # We want trial-level results (one more level deep)
            relative = result_file.relative_to(agent_dir)
            if len(relative.parts) < 3:  # job/trial/result.json = 3 parts minimum
                continue

            try:
                with open(result_file) as f:
                    data = json.load(f)

                # Extract task_id from folder name (format: task-name__HASH)
                trial_folder = result_file.parent.name
                task_id = extract_task_id(trial_folder)

                # Determine pass/fail using shared logic
                passed = get_passed(data) or False

                results.append(
                    TaskResult(
                        task_id=task_id,
                        passed=passed,
                        agent_name=agent_name,
                        model_name=model_name,
                    )
                )
            except (json.JSONDecodeError, OSError) as e:
                print(f"Warning: Could not parse {result_file}: {e}", file=sys.stderr)

    return results


def compute_agent_stats(results: list[TaskResult]) -> dict[str, AgentStats]:
    """Compute aggregate stats for each agent."""
    # Group by agent+model
    by_agent: dict[str, list[TaskResult]] = defaultdict(list)
    for r in results:
        key = f"{r.agent_name}__{r.model_name}"
        by_agent[key].append(r)

    stats: dict[str, AgentStats] = {}
    for key, agent_results in by_agent.items():
        parts = key.split("__", 1)
        agent_name = parts[0]
        model_name = parts[1] if len(parts) > 1 else "unknown"
        n_passed = sum(1 for r in agent_results if r.passed)
        stats[key] = AgentStats(
            agent_name=agent_name,
            model_name=model_name,
            n_tasks=len(agent_results),
            n_passed=n_passed,
        )
    return stats


def get_top_agents(stats: dict[str, AgentStats], n: int = 10) -> list[str]:
    """Get the top N agents by pass rate (excluding Mux)."""
    sorted_agents = sorted(
        [(k, v) for k, v in stats.items() if not k.startswith("Mux__")],
        key=lambda x: x[1].pass_rate,
        reverse=True,
    )
    return [k for k, v in sorted_agents[:n]]


def compute_task_failure_rates(
    results: list[TaskResult], agents: list[str] | None = None
) -> dict[str, dict[str, float]]:
    """
    Compute failure rate per task per agent.

    Returns: {task_id: {agent_key: fail_rate}}
    """
    # Group by task_id and agent
    by_task_agent: dict[str, dict[str, list[bool]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for r in results:
        key = f"{r.agent_name}__{r.model_name}"
        if agents is None or key in agents:
            by_task_agent[r.task_id][key].append(r.passed)

    # Compute failure rates
    task_rates: dict[str, dict[str, float]] = {}
    for task_id, agent_results in by_task_agent.items():
        task_rates[task_id] = {}
        for agent_key, passes in agent_results.items():
            n_total = len(passes)
            n_failed = sum(1 for p in passes if not p)
            task_rates[task_id][agent_key] = n_failed / n_total if n_total > 0 else 0.0

    return task_rates


@dataclass
class OptimizationOpportunity:
    """A task where Mux underperforms relative to competitors."""

    task_id: str
    mux_fail_rate: float
    avg_other_fail_rate: float
    ratio: float  # M/O ratio
    mux_agent: str
    n_other_agents: int


def find_optimization_opportunities(
    results: list[TaskResult],
    mux_filter: str | None = None,
    top_n_agents: int = 10,
) -> list[OptimizationOpportunity]:
    """
    Find tasks where Mux has high failure rate relative to top agents.

    Returns opportunities sorted by M/O ratio (descending).
    """
    stats = compute_agent_stats(results)

    # Find Mux agents
    xum_agents = [k for k in stats.keys() if k.startswith("Mux__")]
    if mux_filter:
        xum_agents = [k for k in xum_agents if mux_filter.lower() in k.lower()]

    if not xum_agents:
        print("Warning: No Mux agents found in results", file=sys.stderr)
        return []

    # Get top N non-Mux agents
    top_agents = get_top_agents(stats, top_n_agents)
    if not top_agents:
        print("Warning: No non-Mux agents found", file=sys.stderr)
        return []

    print(f"\nAnalyzing Mux agents: {', '.join(xum_agents)}", file=sys.stderr)
    print(f"Comparing against top {len(top_agents)} agents:", file=sys.stderr)
    for agent in top_agents[:5]:
        s = stats[agent]
        print(
            f"  - {agent}: {s.pass_rate * 100:.1f}% ({s.n_passed}/{s.n_tasks})",
            file=sys.stderr,
        )
    if len(top_agents) > 5:
        print(f"  ... and {len(top_agents) - 5} more", file=sys.stderr)

    # Compute task-level failure rates
    all_relevant_agents = set(xum_agents) | set(top_agents)
    task_rates = compute_task_failure_rates(results, all_relevant_agents)

    # Find opportunities for each Mux agent
    opportunities: list[OptimizationOpportunity] = []

    for mux_agent in xum_agents:
        for task_id, agent_rates in task_rates.items():
            if mux_agent not in agent_rates:
                continue

            mux_fail_rate = agent_rates[mux_agent]

            # Compute average failure rate of top agents on this task
            other_rates = [
                agent_rates.get(a, 0.0) for a in top_agents if a in agent_rates
            ]
            if not other_rates:
                continue

            avg_other_fail_rate = sum(other_rates) / len(other_rates)

            # Compute M/O ratio (add small epsilon to avoid div by zero)
            epsilon = 0.01
            ratio = mux_fail_rate / (avg_other_fail_rate + epsilon)

            # Only include if Mux actually fails sometimes
            if mux_fail_rate > 0:
                opportunities.append(
                    OptimizationOpportunity(
                        task_id=task_id,
                        mux_fail_rate=mux_fail_rate,
                        avg_other_fail_rate=avg_other_fail_rate,
                        ratio=ratio,
                        mux_agent=mux_agent,
                        n_other_agents=len(other_rates),
                    )
                )

    # Sort by ratio (highest first = biggest optimization opportunity)
    opportunities.sort(key=lambda x: x.ratio, reverse=True)
    return opportunities


def print_opportunities(
    opportunities: list[OptimizationOpportunity], top_n: int = 20
) -> None:
    """Print optimization opportunities in a readable format."""
    print(f"\n{'=' * 80}")
    print("OPTIMIZATION OPPORTUNITIES (sorted by M/O ratio)")
    print(f"{'=' * 80}")
    print(
        f"{'Task ID':<40} {'Mux Fail%':>10} {'Avg Other%':>11} {'M/O Ratio':>10} {'Agent':<20}"
    )
    print("-" * 80)

    for opp in opportunities[:top_n]:
        print(
            f"{opp.task_id:<40} "
            f"{opp.mux_fail_rate * 100:>9.1f}% "
            f"{opp.avg_other_fail_rate * 100:>10.1f}% "
            f"{opp.ratio:>10.2f} "
            f"{opp.mux_agent:<20}"
        )

    if len(opportunities) > top_n:
        print(f"\n... and {len(opportunities) - top_n} more tasks")

    # Summary stats
    if opportunities:
        print(f"\n{'=' * 80}")
        print("SUMMARY")
        print(f"{'=' * 80}")
        total_tasks = len(opportunities)
        high_ratio = sum(1 for o in opportunities if o.ratio > 2.0)
        medium_ratio = sum(1 for o in opportunities if 1.0 < o.ratio <= 2.0)
        print(f"Total tasks with Mux failures: {total_tasks}")
        print(f"  High priority (M/O > 2.0):   {high_ratio}")
        print(f"  Medium priority (1.0 < M/O ≤ 2.0): {medium_ratio}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Analyze Terminal-Bench failure rates to find optimization opportunities"
    )
    parser.add_argument(
        "--top",
        type=int,
        default=20,
        help="Number of top opportunities to show (default: 20)",
    )
    parser.add_argument(
        "--mux-model",
        type=str,
        default=None,
        help="Filter to specific Mux model (substring match)",
    )
    parser.add_argument(
        "--top-agents",
        type=int,
        default=10,
        help="Number of top agents to compare against (default: 10)",
    )
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Force re-download of leaderboard data",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output results as JSON",
    )
    args = parser.parse_args()

    # Get Mux results from BigQuery
    mux_results = query_mux_results_from_bq()
    if not mux_results:
        print(
            "Warning: No Mux results from BigQuery. Ensure bq CLI is configured.",
            file=sys.stderr,
        )

    # Download/load other agents from HuggingFace leaderboard
    repo_path = download_leaderboard_data(refresh=args.refresh)
    print("Parsing leaderboard results (excluding Mux)...", file=sys.stderr)
    other_results = parse_leaderboard_results(repo_path, exclude_mux=True)
    print(f"Found {len(other_results)} results from other agents", file=sys.stderr)

    # Merge results
    results = mux_results + other_results
    if not results:
        print("No results to analyze.", file=sys.stderr)
        sys.exit(1)

    # Find opportunities
    opportunities = find_optimization_opportunities(
        results,
        mux_filter=args.mux_model,
        top_n_agents=args.top_agents,
    )

    if args.json:
        output = [
            {
                "task_id": o.task_id,
                "mux_fail_rate": o.mux_fail_rate,
                "avg_other_fail_rate": o.avg_other_fail_rate,
                "ratio": o.ratio,
                "mux_agent": o.mux_agent,
            }
            for o in opportunities[: args.top]
        ]
        print(json.dumps(output, indent=2))
    else:
        print_opportunities(opportunities, top_n=args.top)


if __name__ == "__main__":
    main()
