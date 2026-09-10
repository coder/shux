from __future__ import annotations

import asyncio
import base64
import json
import math
import os
import shlex
import tarfile
import time
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.models.agent.context import AgentContext
from harbor.trial.trial import AgentTimeoutError

from .mux_run_contract import (
    MUX_RUN_TIMEOUT_FAILURE_MARKER,
    RUN_COMPLETE_MARKER,
    TIMEOUT_RETURN_CODE,
)
from .mux_payload import build_app_archive


@dataclass(frozen=True)
class _AgentCommand:
    command: str
    env: dict[str, str]
    cwd: str | None = None
    timeout_sec: float | None = None


class MuxAgent(BaseInstalledAgent):
    """
    Minimal Terminal-Bench adapter that installs mux into the task container and
    forwards the benchmark instruction to the mux headless runner.
    """

    _ARCHIVE_NAME = "mux-app.tar.gz"
    _RUNNER_NAME = "mux-run.sh"
    _SETUP_SCRIPT_NAME = "mux_setup.sh"
    _COMMAND_STDOUT_NAME = "stdout.txt"
    _COMMAND_STDERR_NAME = "stderr.txt"
    _DEFAULT_MODEL = "anthropic:claude-sonnet-4-5"
    _DEFAULT_PROJECT_CANDIDATES = "/workspace:/app:/workspaces:/root/project"
    _INCLUDE_PATHS: Sequence[str] = (
        "package.json",
        "bun.lock",
        "bunfig.toml",
        "tsconfig.json",
        "tsconfig.main.json",
        "src",
        "dist",
        "scripts/postinstall.sh",
        # bun install applies package.json patchedDependencies; without the patch
        # files the in-sandbox install fails outright.
        "patches",
    )

    _PROVIDER_ENV_KEYS: Sequence[str] = (
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "OPENAI_API_BASE",
        "OPENAI_ORG_ID",
        "AZURE_OPENAI_API_KEY",
        "AZURE_OPENAI_ENDPOINT",
        "AZURE_OPENAI_DEPLOYMENT",
        "AZURE_OPENAI_API_VERSION",
        # Google provider uses either GOOGLE_GENERATIVE_AI_API_KEY or the legacy
        # GOOGLE_API_KEY env var. Forward both (and base URL override) into the
        # sandbox to avoid confusing "api_key_not_found" failures.
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_BASE_URL",
    )

    _CONFIG_ENV_KEYS: Sequence[str] = (
        "MUX_AGENT_GIT_URL",
        "MUX_BUN_INSTALL_URL",
        "MUX_PROJECT_PATH",
        "MUX_PROJECT_CANDIDATES",
        "MUX_MODEL",
        "MUX_TIMEOUT_MS",
        "MUX_CONFIG_ROOT",
        "MUX_APP_ROOT",
        "MUX_WORKSPACE_ID",
        "MUX_EXPERIMENTS",
        # Generic pass-through for arbitrary mux run CLI flags (e.g., --thinking
        # high --use-1m --budget 5.00). Avoids per-flag plumbing.
        "MUX_RUN_ARGS",
        "MUX_RUN_AS_GOAL",
        "MUX_RUN_SESSION_ROOT",
    )

    def __init__(
        self,
        logs_dir: Path,
        model_name: str = "anthropic:claude-sonnet-4-5",
        experiments: str | None = None,
        timeout: float | int | str | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(logs_dir=logs_dir, **kwargs)
        self._timeout_sec = self._parse_timeout_sec(timeout)
        self._timeout_ms = (
            str(round(self._timeout_sec * 1000))
            if self._timeout_sec is not None
            else None
        )
        repo_root_env = os.environ.get("MUX_AGENT_REPO_ROOT")
        repo_root = (
            Path(repo_root_env).resolve()
            if repo_root_env
            else Path(__file__).resolve().parents[2]
        )
        if not repo_root.exists():
            raise RuntimeError(f"mux repo root {repo_root} does not exist")

        runner_path = Path(__file__).with_name(self._RUNNER_NAME)
        if not runner_path.is_file():
            raise RuntimeError(f"mux runner script missing at {runner_path}")

        self._runner_path = runner_path
        self._repo_root = repo_root
        self._archive_bytes: bytes | None = None
        self._model_name = (model_name or "").strip()
        self._experiments = (experiments or "").strip() if experiments else None
        self._last_environment: BaseEnvironment | None = None

    @staticmethod
    def name() -> str:
        return "mux"

    @property
    def _env(self) -> dict[str, str]:
        env: dict[str, str] = {}

        for key in (*self._PROVIDER_ENV_KEYS, *self._CONFIG_ENV_KEYS):
            value = os.environ.get(key)
            if value:
                env[key] = value

        env.setdefault("MUX_MODEL", self._DEFAULT_MODEL)
        env.setdefault("MUX_CONFIG_ROOT", "/root/.mux")
        env.setdefault("MUX_APP_ROOT", "/opt/mux-app")
        env.setdefault("MUX_WORKSPACE_ID", "mux-bench")
        env.setdefault("MUX_PROJECT_CANDIDATES", self._DEFAULT_PROJECT_CANDIDATES)
        env.setdefault("MUX_RUN_SESSION_ROOT", self._DEFAULT_RUN_SESSION_ROOT)
        if self._timeout_ms is not None:
            env["MUX_TIMEOUT_MS"] = self._timeout_ms

        model_value = self._model_name or env["MUX_MODEL"]
        model_value = model_value.strip()
        if not model_value:
            raise ValueError("MUX_MODEL must be a non-empty string")
        if "/" in model_value and ":" not in model_value:
            provider, model_name = model_value.split("/", 1)
            model_value = f"{provider}:{model_name}"

        # Fail fast for Google models if credentials weren't forwarded into the
        # sandbox env. Otherwise Harbor/mux will fail later with a less actionable
        # "api_key_not_found" error.
        if model_value.startswith("google:") and not (
            env.get("GOOGLE_GENERATIVE_AI_API_KEY") or env.get("GOOGLE_API_KEY")
        ):
            raise ValueError(
                "Google models require GOOGLE_GENERATIVE_AI_API_KEY (preferred) or GOOGLE_API_KEY"
            )
        env["MUX_MODEL"] = model_value

        # These env vars are all set with defaults above, no need to validate
        for key in (
            "MUX_CONFIG_ROOT",
            "MUX_APP_ROOT",
            "MUX_WORKSPACE_ID",
            "MUX_PROJECT_CANDIDATES",
        ):
            env[key] = env[key].strip()

        if timeout_value := env.get("MUX_TIMEOUT_MS"):
            self._validate_timeout_ms(timeout_value)

        if project_path := env.get("MUX_PROJECT_PATH"):
            if not project_path.strip():
                raise ValueError("MUX_PROJECT_PATH must be non-empty when provided")

        mux_run_as_goal = self._normalize_mux_run_as_goal(env.get("MUX_RUN_AS_GOAL"))
        if mux_run_as_goal is None:
            env.pop("MUX_RUN_AS_GOAL", None)
        else:
            env["MUX_RUN_AS_GOAL"] = mux_run_as_goal

        # Set experiments from kwarg (takes precedence over env var)
        if self._experiments:
            env["MUX_EXPERIMENTS"] = self._experiments

        return env

    @staticmethod
    def _parse_timeout_sec(value: float | int | str | None) -> float | None:
        if value is None:
            return None

        timeout_sec = float(value)
        if timeout_sec <= 0:
            raise ValueError("timeout must be a positive number")
        return timeout_sec

    @staticmethod
    def _validate_timeout_ms(value: str) -> None:
        if not value.strip().isdigit():
            raise ValueError("MUX_TIMEOUT_MS must be an integer")

    @staticmethod
    def _normalize_mux_run_as_goal(value: str | None) -> str | None:
        if value is None:
            return None

        normalized = value.strip().lower()
        if normalized in ("", "0", "false"):
            return None
        if normalized in ("1", "true"):
            return "1"

        raise ValueError("MUX_RUN_AS_GOAL must be one of: 1, true, 0, false")

    @property
    def _install_agent_template_path(self) -> Path:
        return Path(__file__).with_name("mux_setup.sh.j2")

    _PROVIDERS_FILE_ENV_KEY = "MUX_PROVIDERS_FILE"
    _TOKEN_FILE_PATH = "/tmp/mux-tokens.json"
    _DEFAULT_RUN_LOG_DIR = "/logs/agent/command-0"
    _RUN_EXIT_CODE_NAME = "mux-run-exit-code.txt"
    _RUN_EXIT_CODE_MAX_BYTES = 3
    _DEFAULT_RUN_SESSION_ROOT = "/tmp/mux-run-root"
    _SESSIONS_ARCHIVE_NAME = "mux-sessions.tar.gz"
    _SESSION_USAGE_SUMMARY_NAME = "mux-session-usage.json"
    # Telemetry collection bounds: dataset-controlled trials must not be able to
    # exhaust host disk/memory through the sessions archive.
    _SESSIONS_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024
    _SESSIONS_ARCHIVE_MAX_EXPANDED_BYTES = 64 * 1024 * 1024
    _SESSION_USAGE_MAX_MEMBERS = 10_000
    _SESSION_USAGE_FILE_MAX_BYTES = 16 * 1024 * 1024
    _SESSION_USAGE_MAX_TOTAL_BYTES = 64 * 1024 * 1024
    _SESSION_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024

    async def _stage_providers_config(
        self, environment: BaseEnvironment, env: dict[str, str]
    ) -> None:
        """Upload host providers.jsonc into the sandbox when explicitly requested."""
        providers_file_raw = os.environ.get(self._PROVIDERS_FILE_ENV_KEY)
        if not providers_file_raw:
            return

        providers_path = Path(providers_file_raw).expanduser().resolve()
        if not providers_path.is_file():
            raise RuntimeError(
                f"{self._PROVIDERS_FILE_ENV_KEY}={providers_path} is not a readable file"
            )

        xum_config_root = (
            env.get("MUX_CONFIG_ROOT") or "/root/.mux"
        ).strip() or "/root/.mux"
        target_path = f"{xum_config_root.rstrip('/')}/providers.jsonc"

        await environment.upload_file(
            source_path=providers_path,
            target_path=target_path,
        )

    def _agent_version(self) -> str:
        version_method = getattr(self, "version", None)
        if callable(version_method):
            return version_method() or ""
        version_value = getattr(self, "_version", "")
        return version_value if isinstance(version_value, str) else ""

    def _write_setup_script(self) -> Path:
        setup_script = self._install_agent_template_path.read_text().replace(
            "{{ version if version is not none else '' }}",
            self._agent_version(),
        )
        setup_path = self.logs_dir / self._SETUP_SCRIPT_NAME
        setup_path.write_text(setup_script)
        return setup_path

    async def install(self, environment: BaseEnvironment) -> None:
        """Run the staged mux setup script inside the task environment."""
        # The setup script may install apt packages and writes under /opt, so run
        # it as root even if Harbor's default agent user changes.
        result = await environment.exec(
            command=f"bash /installed-agent/{self._SETUP_SCRIPT_NAME}",
            env=self._env,
            user="root",
        )
        if result.return_code != 0:
            raise RuntimeError(
                "mux setup failed "
                f"(exit {result.return_code}):\nstdout: {result.stdout}\nstderr: {result.stderr}"
            )

    async def setup(self, environment: BaseEnvironment) -> None:
        """Stage the mux payload before installing it in the task environment."""
        env = self._env

        # Harbor no longer renders installed-agent templates for custom agents.
        # Stage the rendered script ourselves so scheduled tbench runs are not
        # coupled to Harbor internals that have changed over time.
        await environment.exec(command="mkdir -p /installed-agent", user="root")

        if not self._archive_bytes:
            self._archive_bytes = build_app_archive(
                self._repo_root, self._INCLUDE_PATHS
            )

        archive_path = self.logs_dir / self._ARCHIVE_NAME
        archive_path.write_bytes(self._archive_bytes)
        await environment.upload_file(
            source_path=archive_path,
            target_path=f"/installed-agent/{self._ARCHIVE_NAME}",
        )

        await environment.upload_file(
            source_path=self._runner_path,
            target_path=f"/installed-agent/{self._RUNNER_NAME}",
        )

        await environment.upload_file(
            source_path=self._write_setup_script(),
            target_path=f"/installed-agent/{self._SETUP_SCRIPT_NAME}",
        )

        await self.install(environment)

        # Optionally seed the sandbox with providers.jsonc from the host machine.
        # This is required for OAuth-only configs where env var API keys are absent.
        await self._stage_providers_config(environment, env)

        # Store environment reference for token extraction later.
        self._last_environment = environment

    def create_run_agent_commands(self, instruction: str) -> list[_AgentCommand]:
        escaped = shlex.quote(instruction)
        command = f"bash /installed-agent/{self._RUNNER_NAME} {escaped}"
        return [
            _AgentCommand(command=command, env=self._env, timeout_sec=self._timeout_sec)
        ]

    async def _exec_agent_command(
        self,
        environment: BaseEnvironment,
        exec_input: _AgentCommand,
    ) -> ExecResult:
        try:
            return await environment.exec(
                command=exec_input.command,
                cwd=exec_input.cwd,
                env=exec_input.env,
                timeout_sec=exec_input.timeout_sec,
            )
        except asyncio.TimeoutError as exc:
            if exec_input.timeout_sec is None:
                raise
            raise self._agent_timeout_error(exec_input.timeout_sec) from exc
        except RuntimeError as exc:
            if exec_input.timeout_sec is not None and "timed out" in str(exc).lower():
                raise self._agent_timeout_error(exec_input.timeout_sec) from exc
            raise

    @staticmethod
    def _agent_timeout_error(timeout_sec: float) -> AgentTimeoutError:
        return AgentTimeoutError(
            f"Agent execution timed out after {timeout_sec:g} seconds"
        )

    @staticmethod
    def _is_exec_timeout_return(
        result: ExecResult,
        timeout_sec: float | None,
        elapsed_sec: float,
    ) -> bool:
        if timeout_sec is None or result.return_code != TIMEOUT_RETURN_CODE:
            return False

        assert timeout_sec > 0, "timeout_sec is validated when MuxAgent is constructed"
        timeout_threshold = max(timeout_sec * 0.95, timeout_sec - 10)
        if elapsed_sec < timeout_threshold:
            return False

        stdout = result.stdout or ""
        stderr = result.stderr or ""
        if RUN_COMPLETE_MARKER in stdout:
            return False
        if MUX_RUN_TIMEOUT_FAILURE_MARKER in stderr:
            return False

        return True

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        """Run agent commands, download token file, then populate context."""
        preexisting_session_dirs = await self._snapshot_session_usage_dirs(environment)
        sandbox_log_dir = (
            self._env.get("MUX_LOG_DIR") or self._DEFAULT_RUN_LOG_DIR
        ).rstrip("/")
        runner_exit_sandbox_path = f"{sandbox_log_dir}/{self._RUN_EXIT_CODE_NAME}"
        runner_marker_cleared = False
        try:
            clear_result = await environment.exec(
                command=f"rm -f -- {shlex.quote(runner_exit_sandbox_path)}",
                user="root",
                timeout_sec=30,
            )
            runner_marker_cleared = clear_result.return_code == 0
        except Exception:
            pass

        # Execute commands (from base class logic, but without calling populate_context)
        command_result: tuple[int, int] | None = None
        failed_command: tuple[int, int] | None = None
        timeout_error: AgentTimeoutError | None = None
        for i, exec_input in enumerate(self.create_run_agent_commands(instruction)):
            command_dir = self.logs_dir / f"command-{i}"
            command_dir.mkdir(parents=True, exist_ok=True)
            (command_dir / "command.txt").write_text(exec_input.command)

            # /logs is bind-mounted; pre-create files so sandbox tee output
            # does not leave root-owned files that host-side log writes cannot replace.
            stdout_path = command_dir / self._COMMAND_STDOUT_NAME
            stderr_path = command_dir / self._COMMAND_STDERR_NAME
            for output_path in (stdout_path, stderr_path):
                output_path.write_text("")

            started_at = time.monotonic()
            try:
                result = await self._exec_agent_command(environment, exec_input)
            except AgentTimeoutError as exc:
                timeout_error = exc
                break
            elapsed_sec = time.monotonic() - started_at

            (command_dir / "return-code.txt").write_text(str(result.return_code))
            if result.stdout:
                stdout_path.write_text(result.stdout)
            if result.stderr:
                stderr_path.write_text(result.stderr)
            if self._is_exec_timeout_return(
                result, exec_input.timeout_sec, elapsed_sec
            ):
                assert exec_input.timeout_sec is not None
                timeout_error = self._agent_timeout_error(exec_input.timeout_sec)
                break
            command_result = (i, result.return_code)
            if result.return_code != 0:
                break

        runner_exit_code: int | None = None
        if runner_marker_cleared:
            try:
                # The sandbox already authors trusted telemetry in this harness;
                # independent task verification remains the correctness boundary.
                marker_result = await environment.exec(
                    command=(
                        f"head -c {self._RUN_EXIT_CODE_MAX_BYTES + 1} -- "
                        f"{shlex.quote(runner_exit_sandbox_path)}"
                    ),
                    user="root",
                    timeout_sec=30,
                )
                raw_exit_code = marker_result.stdout or ""
                if (
                    marker_result.return_code == 0
                    and len(raw_exit_code.encode()) <= self._RUN_EXIT_CODE_MAX_BYTES
                    and raw_exit_code.isdecimal()
                ):
                    parsed_exit_code = int(raw_exit_code)
                    if parsed_exit_code <= 255:
                        runner_exit_code = parsed_exit_code
            except Exception:
                pass

        if command_result is not None:
            command_index, channel_return_code = command_result
            effective_return_code = channel_return_code
            if runner_exit_code is not None:
                effective_return_code = runner_exit_code
                if runner_exit_code != channel_return_code:
                    command_dir = self.logs_dir / f"command-{command_index}"
                    (command_dir / "transport-diagnostic.log").write_text(
                        f"channel return code {channel_return_code} disagreed with "
                        f"mux-run exit code {runner_exit_code}; using mux-run status\n"
                    )
            if effective_return_code != 0:
                failed_command = (command_index, effective_return_code)

        # Download token file from container BEFORE populating context
        # Clear any stale token file first to avoid reading outdated data if download fails
        token_file = self.logs_dir / "mux-tokens.json"
        token_file.unlink(missing_ok=True)
        try:
            await environment.download_file(self._TOKEN_FILE_PATH, token_file)
        except Exception:
            pass  # Token file may not exist if agent crashed early

        await self._download_session_artifacts(environment, preexisting_session_dirs)

        self.populate_context_post_run(context)

        if timeout_error is not None:
            raise timeout_error

        if failed_command is not None:
            command_index, return_code = failed_command
            raise RuntimeError(
                f"mux agent command failed (command {command_index}, exit {return_code})"
            )

    async def _snapshot_session_usage_dirs(
        self, environment: BaseEnvironment
    ) -> tuple[str, ...] | None:
        session_root = (
            self._env.get("MUX_RUN_SESSION_ROOT") or self._DEFAULT_RUN_SESSION_ROOT
        ).strip() or self._DEFAULT_RUN_SESSION_ROOT
        snapshot_limit = self._SESSION_SNAPSHOT_MAX_BYTES + 1
        script = (
            f"if [ ! -d {shlex.quote(session_root)} ]; then exit 0; fi\n"
            f"cd {shlex.quote(session_root)} || exit 1\n"
            "find . -type f -name session-usage.json -printf '%h\\0' "
            f"2>/dev/null | head -c {snapshot_limit} | base64 -w0\n"
        )
        try:
            result = await environment.exec(
                command=f"bash -c {shlex.quote(script)}",
                user="root",
                timeout_sec=30,
            )
            if result.return_code != 0:
                return None
            snapshot = base64.b64decode(result.stdout or "", validate=True)
            if len(snapshot) > self._SESSION_SNAPSHOT_MAX_BYTES:
                return None
            session_dirs = set()
            for raw_path in snapshot.split(b"\0"):
                if not raw_path:
                    continue
                path = raw_path.decode("utf-8")
                if path != "." and not path.startswith("./"):
                    return None
                session_dirs.add(path)
            return tuple(sorted(session_dirs))
        except Exception:
            return None

    async def _download_session_artifacts(
        self,
        environment: BaseEnvironment,
        preexisting_session_dirs: tuple[str, ...] | None,
    ) -> None:
        """Archive and download the mux sessions directory (chat.jsonl et al).

        The stdout JSONL stream can lose its tail (including the run-complete
        event that carries cost_usd) on remote backends, so the on-disk session
        files (chat.jsonl and session-usage.json, persisted on every
        stream-end) are the durable source for token/cost telemetry.
        Best-effort: never fail the trial over telemetry collection.
        """
        session_root = (
            self._env.get("MUX_RUN_SESSION_ROOT") or self._DEFAULT_RUN_SESSION_ROOT
        ).strip() or self._DEFAULT_RUN_SESSION_ROOT
        archive_path = self.logs_dir / self._SESSIONS_ARCHIVE_NAME
        archive_path.unlink(missing_ok=True)
        stream_limit = self._SESSIONS_ARCHIVE_MAX_BYTES + 1
        telemetry_match = (
            "\\( -name chat.jsonl -o -name chat-archive.jsonl "
            "-o -name session-usage.json -o -name run-stdout.jsonl "
            "-o -name run-stderr.log -o -name mux-tokens.json \\)"
        )
        telemetry_source = (
            f"if find . -type f {telemetry_match} ! -links 1 -print -quit "
            "2>/dev/null | grep -q .; then "
            "printf 'skipped linked telemetry files\n' >&2; fi\n"
            f"find . -type f {telemetry_match} -links 1 -print0 2>/dev/null"
        )
        if preexisting_session_dirs:
            excluded_patterns = "|".join(
                f"{shlex.quote(path)}/*" for path in preexisting_session_dirs
            )
            telemetry_source += (
                " | while IFS= read -r -d '' path; do "
                f'case "$path" in {excluded_patterns}) ;; '
                "*) printf '%s\\0' \"$path\" ;; esac; done"
            )
        # Stream only known telemetry files and cap raw archive bytes before
        # base64 expansion so sandbox tasks cannot inflate the host transfer.
        script = (
            f"cd {shlex.quote(session_root)} || exit 1\n"
            f"{telemetry_source} | tar --null -czf - -T - 2>/dev/null "
            f"| head -c {stream_limit} | base64 -w0\n"
        )
        # Telemetry collection is best-effort, but silent failures cost a full
        # benchmark run to notice: record every outcome to a diagnostic log.
        diag_path = self.logs_dir / "mux-sessions-collect.log"

        def _diag(message: str) -> None:
            try:
                with diag_path.open("a") as diag:
                    diag.write(message.rstrip() + "\n")
            except Exception:
                pass

        if preexisting_session_dirs is None:
            _diag("session snapshot unavailable")
            return

        try:
            # Run as root like install(): the agent session writes under /root.
            result = await environment.exec(
                command=f"bash -c {shlex.quote(script)}",
                user="root",
                timeout_sec=120,
            )
            encoded_archive = result.stdout or ""
            _diag(
                f"archive exec rc={result.return_code} "
                f"encoded_bytes={len(encoded_archive.encode())} "
                f"stderr={(result.stderr or '')[-500:]!r}"
            )
            if result.return_code != 0:
                return  # Sessions dir may not exist if the agent crashed early
            try:
                archive_data = base64.b64decode(encoded_archive, validate=True)
            except Exception:
                _diag("archive decode failed")
                return
            if len(archive_data) > self._SESSIONS_ARCHIVE_MAX_BYTES:
                _diag(f"streamed archive too large: {len(archive_data)} bytes")
                return
            archive_path.write_bytes(archive_data)
            _diag(f"streamed {len(archive_data)} bytes")
        except Exception as exc:
            _diag(f"collection failed: {type(exc).__name__}: {exc}")
            archive_path.unlink(missing_ok=True)

    @staticmethod
    def _is_valid_usage_number(value: object) -> bool:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return False
        try:
            return value >= 0 and math.isfinite(value)
        except OverflowError:
            return False

    @staticmethod
    def _is_valid_token_count(value: object) -> bool:
        return not isinstance(value, bool) and isinstance(value, int) and value >= 0

    @classmethod
    def _is_valid_rollup_entry(cls, entry: object) -> bool:
        if entry is True:
            return True
        if not isinstance(entry, dict):
            return False
        if not cls._is_valid_token_count(entry.get("totalTokens")):
            return False
        if not cls._is_valid_usage_number(entry.get("rolledUpAtMs")):
            return False
        for key in (
            "inputTokens",
            "outputTokens",
            "reasoningTokens",
            "cachedTokens",
            "cacheCreateTokens",
            "contextTokens",
        ):
            if key in entry and not cls._is_valid_token_count(entry[key]):
                return False
        if "totalCostUsd" in entry and not cls._is_valid_usage_number(
            entry["totalCostUsd"]
        ):
            return False
        for key in ("agentType", "model"):
            if key in entry and not isinstance(entry[key], str):
                return False
        return True

    @classmethod
    def _has_usable_session_usage(cls, data: dict[str, Any]) -> bool:
        by_model = data.get("byModel")
        if not isinstance(by_model, dict):
            return False
        for usage in by_model.values():
            if not isinstance(usage, dict):
                continue
            for bucket in ("input", "output", "reasoning", "cached", "cacheCreate"):
                component = usage.get(bucket)
                if not isinstance(component, dict):
                    continue
                tokens = component.get("tokens")
                if cls._is_valid_token_count(tokens) and tokens > 0:
                    return True
        return False

    def _summarize_session_usage(self) -> dict[str, Any] | None:
        """Aggregate token/cost buckets from session-usage.json files in the archive.

        Sums per-model ChatUsageDisplay buckets across session directories,
        skipping child sessions that a parent already merged (rolledUpFrom
        ledger) so delegated sub-agent usage is never double-counted.
        """
        archive_path = self.logs_dir / self._SESSIONS_ARCHIVE_NAME
        if not archive_path.is_file():
            return None

        per_session: dict[str, dict[str, Any]] = {}
        rolled_up_ids: set[str] = set()
        try:
            with tarfile.open(archive_path, "r:gz") as archive:
                members_seen = 0
                expanded_bytes = 0
                bytes_read = 0
                for member in archive:
                    members_seen += 1
                    if members_seen > self._SESSION_USAGE_MAX_MEMBERS:
                        return None
                    expanded_bytes += member.size
                    if expanded_bytes > self._SESSIONS_ARCHIVE_MAX_EXPANDED_BYTES:
                        return None
                    parts = Path(member.name).parts
                    if (
                        len(parts) < 3
                        or parts[-1] != "session-usage.json"
                        or not member.isfile()
                        or member.size > self._SESSION_USAGE_FILE_MAX_BYTES
                    ):
                        continue
                    # Aggregate cap: many small-header members must not add up
                    # to an unbounded allocation either.
                    if bytes_read + member.size > self._SESSION_USAGE_MAX_TOTAL_BYTES:
                        return None
                    try:
                        extracted = archive.extractfile(member)
                        if extracted is None:
                            continue
                        # Bounded read: never trust the header to limit allocation.
                        raw = extracted.read(self._SESSION_USAGE_FILE_MAX_BYTES + 1)
                        bytes_read += len(raw)
                        if len(raw) > self._SESSION_USAGE_FILE_MAX_BYTES:
                            continue
                        data = json.loads(raw.decode("utf-8"))
                    except Exception:
                        continue  # Skip malformed files, keep valid sessions
                    if not isinstance(data, dict):
                        continue
                    session_id = parts[-2]
                    per_session[session_id] = data
        except Exception:
            return None  # Corrupt/partial archive: telemetry stays best-effort

        for data in per_session.values():
            if not self._has_usable_session_usage(data):
                continue
            rolled_up = data.get("rolledUpFrom")
            if isinstance(rolled_up, dict):
                rolled_up_ids.update(
                    child_id
                    for child_id, entry in rolled_up.items()
                    if self._is_valid_rollup_entry(entry)
                )

        totals: dict[str, Any] = {
            "input": 0,
            "output": 0,
            "reasoning": 0,
            "cache_read": 0,
            "cache_write": 0,
            "cost_usd": None,
            "sessions": 0,
        }
        bucket_to_key = {
            "input": "input",
            "output": "output",
            "reasoning": "reasoning",
            "cached": "cache_read",
            "cacheCreate": "cache_write",
        }
        cost_sum = 0.0
        has_cost = False
        has_unpriced_usage = False
        for session_id, data in per_session.items():
            if session_id in rolled_up_ids:
                continue  # Parent session-usage.json already includes this child
            by_model = data.get("byModel")
            if not isinstance(by_model, dict):
                continue  # Skip malformed/older shapes, keep valid sessions
            totals["sessions"] += 1
            for usage in by_model.values():
                if not isinstance(usage, dict):
                    continue
                if usage.get("hasUnknownCosts"):
                    has_unpriced_usage = True
                for bucket, key in bucket_to_key.items():
                    component = usage.get(bucket)
                    if not isinstance(component, dict):
                        continue
                    tokens = component.get("tokens")
                    if not self._is_valid_token_count(tokens):
                        continue
                    totals[key] += int(tokens)
                    cost = component.get("cost_usd")
                    if self._is_valid_usage_number(cost):
                        cost_sum += cost
                        has_cost = True
                    elif tokens > 0:
                        # Nonzero usage without a price: reporting only the
                        # priced subset would misstate total cost.
                        has_unpriced_usage = True
        if totals["sessions"] == 0:
            return None
        if has_cost and not has_unpriced_usage:
            totals["cost_usd"] = cost_sum
        return totals

    @classmethod
    def _has_valid_token_buckets(cls, data: dict[str, Any]) -> bool:
        for key in ("input", "output", "reasoning", "cache_read", "cache_write"):
            if key in data and not cls._is_valid_token_count(data[key]):
                return False
        return True

    @classmethod
    def _total_tokens(cls, data: dict[str, Any]) -> int:
        total = 0
        for key in ("input", "output", "reasoning", "cache_read", "cache_write"):
            value = data.get(key)
            if cls._is_valid_token_count(value):
                total += int(value)
        return total

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Extract token usage and cost from the collected telemetry artifacts.

        Prefers mux-tokens.json when it carries valid cost (the run-complete event was
        observed); otherwise falls back to session-usage.json totals from the
        downloaded sessions archive, which survive stdout truncation and agent
        timeouts.
        """
        token_data: dict[str, Any] | None = None
        token_file = self.logs_dir / "mux-tokens.json"
        if token_file.exists():
            try:
                loaded = json.loads(token_file.read_text())
                token_data = loaded if isinstance(loaded, dict) else None
            except Exception:
                token_data = None

        try:
            session_totals = self._summarize_session_usage()
        except Exception:
            session_totals = None  # Telemetry must never fail the trial
        if session_totals is not None:
            # Persist the aggregate next to mux-tokens.json for run analysis.
            try:
                (self.logs_dir / self._SESSION_USAGE_SUMMARY_NAME).write_text(
                    json.dumps(session_totals, indent=1)
                )
            except Exception:
                pass

        data: dict[str, Any] | None
        token_cost = token_data.get("cost_usd") if token_data is not None else None
        if (
            token_data is not None
            and self._is_valid_usage_number(token_cost)
            and self._has_valid_token_buckets(token_data)
        ):
            data = token_data
        elif session_totals is not None and (
            token_data is None
            or self._total_tokens(session_totals) >= self._total_tokens(token_data)
        ):
            # Session totals only win when they reflect at least as much usage:
            # a timeout can leave stdout usage-deltas newer than the last
            # persisted stream-end, and those fresher token counts must not be
            # replaced by stale (or empty) session files.
            data = session_totals
        else:
            data = token_data
        if data is None:
            return

        try:
            # Harbor's context has no cache-token fields, and "input" is
            # only the uncached portion. Fold cache read/write into the
            # reported input total so cached legs are not understated;
            # the per-bucket breakdown stays in the JSON artifacts.
            context.n_input_tokens = sum(
                value if self._is_valid_token_count(value) else 0
                for value in (
                    data.get("input"),
                    data.get("cache_read"),
                    data.get("cache_write"),
                )
            )
            # Keep run-complete semantics: "output" excludes reasoning tokens
            # (the session summary reports reasoning as its own bucket).
            output_tokens = data.get("output")
            context.n_output_tokens = (
                output_tokens if self._is_valid_token_count(output_tokens) else 0
            )
            # cost_usd is computed by mux from model pricing
            cost_usd = data.get("cost_usd")
            if self._is_valid_usage_number(cost_usd):
                context.cost_usd = cost_usd
        except Exception:
            pass  # Token/cost extraction is best-effort
