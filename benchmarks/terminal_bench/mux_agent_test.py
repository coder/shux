from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import re
import shutil
import subprocess
import tarfile
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

import pytest

from harbor.trial.trial import AgentTimeoutError

from .mux_agent import MuxAgent
from .mux_payload import build_app_archive
from .mux_run_contract import mux_run_failure_marker


@pytest.fixture(autouse=True)
def _clear_mux_env(monkeypatch: pytest.MonkeyPatch) -> None:
    keys = (*MuxAgent._PROVIDER_ENV_KEYS, *MuxAgent._CONFIG_ENV_KEYS)
    for key in keys:
        monkeypatch.delenv(key, raising=False)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class _RunnerSmokeResult:
    completed: subprocess.CompletedProcess[str]
    log_dir: Path
    token_file: Path
    exit_code_file: Path
    timeout_marker: Path
    trust_timeout_args_file: Path
    args_file: Path


def _write_executable(path: Path, content: str) -> None:
    path.write_text(content)
    path.chmod(0o755)


def _run_mux_runner_smoke(
    tmp_path: Path,
    *,
    exit_code: int,
    goal_mode: str | None = None,
    timeout_ms: str | None = None,
    repo_git_config: tuple[str, str] | None = None,
    repo_git_config_bytes: bytes | None = None,
    pretrust_git_timeout: bool = False,
    trust_timeout: bool = False,
    fake_tee_exit_code: int | None = None,
    overwrite_stderr_after_status: bool = False,
    emit_run_complete: bool = True,
) -> _RunnerSmokeResult:
    app_root = tmp_path / "app"
    project_path = tmp_path / "project"
    fake_bun_root = tmp_path / "bun-root"
    fake_bin = fake_bun_root / "bin"
    log_dir = tmp_path / "logs" / "agent" / "command-0"
    token_file = tmp_path / "mux-tokens.json"
    args_file = tmp_path / "bun-args.txt"
    timeout_marker = tmp_path / "timeout-invoked.txt"
    trust_timeout_args_file = tmp_path / "trust-timeout-args.txt"

    app_root.mkdir()
    project_path.mkdir()
    fake_bin.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(project_path)], check=True)
    if repo_git_config is not None:
        subprocess.run(
            ["git", "-C", str(project_path), "config", *repo_git_config],
            check=True,
        )
    if repo_git_config_bytes is not None:
        with (project_path / ".git/config").open("ab") as config_file:
            config_file.write(repo_git_config_bytes)

    _write_executable(
        fake_bin / "bun",
        """#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "src/cli/trust.ts" ]]; then
  printf '%s\n' "$*" >"${FAKE_BUN_ARGS_FILE}.trust"
  exit 0
fi
printf '%s\n' "$*" >"${FAKE_BUN_ARGS_FILE}"
cat >/dev/null
if [[ "${FAKE_BUN_SKIP_RUN_COMPLETE:-0}" != "1" ]]; then
  printf '{"type":"run-complete","usage":{"inputTokens":7,"outputTokens":11,"cachedTokens":5,"cacheCreateTokens":3},"cost_usd":0.42}\n'
fi
exit "${FAKE_MUX_EXIT_CODE}"
""",
    )
    if fake_tee_exit_code is not None or overwrite_stderr_after_status:
        real_tee = shutil.which("tee")
        assert real_tee is not None
        _write_executable(
            fake_bin / "tee",
            f"""#!/usr/bin/env bash
set -euo pipefail
target=${{!#}}
input_source=$(readlink /proc/$$/fd/0)
if [[ "${{FAKE_OVERWRITE_STDERR_AFTER_STATUS:-0}}" == "1" \
  && "$target" == "${{FAKE_STDERR_FILE}}" \
  && "$input_source" == pipe:* ]]; then
  captured=$(mktemp)
  cat >"$captured"
  cat "$captured"
  while ! grep -Fq '[mux-run] ERROR:' "$target" 2>/dev/null; do :; done
  cat "$captured" >"$target"
  rm -f "$captured"
  exit 0
fi
"{real_tee}" "$@"
exit "${{FAKE_TEE_EXIT_CODE:-0}}"
""",
        )
    _write_executable(
        fake_bin / "timeout",
        """#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "15s" ]]; then
  if [[ "${FAKE_PRETRUST_GIT_TIMEOUT:-0}" == "1" ]]; then
    exit 124
  fi
  shift
  exec "$@"
fi
if [[ "${1:-}" == "60s" ]]; then
  printf '%s\n' "$*" >"${FAKE_TRUST_TIMEOUT_ARGS_FILE}"
  if [[ "${FAKE_TRUST_TIMEOUT:-0}" == "1" ]]; then
    exit 124
  fi
  shift
  exec "$@"
fi
printf 'timeout invoked\n' >"${FAKE_TIMEOUT_MARKER}"
exit 99
""",
    )

    env = os.environ.copy()
    env.update(
        {
            "BUN_INSTALL": str(fake_bun_root),
            "FAKE_BUN_ARGS_FILE": str(args_file),
            "FAKE_MUX_EXIT_CODE": str(exit_code),
            "FAKE_TIMEOUT_MARKER": str(timeout_marker),
            "FAKE_PRETRUST_GIT_TIMEOUT": "1" if pretrust_git_timeout else "0",
            "FAKE_TRUST_TIMEOUT": "1" if trust_timeout else "0",
            "FAKE_TRUST_TIMEOUT_ARGS_FILE": str(trust_timeout_args_file),
            "FAKE_OVERWRITE_STDERR_AFTER_STATUS": (
                "1" if overwrite_stderr_after_status else "0"
            ),
            "FAKE_STDERR_FILE": str(log_dir / "stderr.txt"),
            "MUX_APP_ROOT": str(app_root),
            "MUX_LOG_DIR": str(log_dir),
            "MUX_PROJECT_PATH": str(project_path),
            "MUX_RUN_SESSION_ROOT": str(tmp_path / "session-root"),
            "MUX_TOKEN_FILE": str(token_file),
            "PATH": f"{fake_bin}{os.pathsep}{env.get('PATH', '')}",
        }
    )
    if goal_mode is not None:
        env["MUX_RUN_AS_GOAL"] = goal_mode
    if timeout_ms is not None:
        env["MUX_TIMEOUT_MS"] = timeout_ms
    if fake_tee_exit_code is not None:
        env["FAKE_TEE_EXIT_CODE"] = str(fake_tee_exit_code)
    if not emit_run_complete:
        env["FAKE_BUN_SKIP_RUN_COMPLETE"] = "1"

    runner_path = _repo_root() / "benchmarks/terminal_bench/mux-run.sh"
    completed = subprocess.run(
        ["bash", str(runner_path), "solve it"],
        capture_output=True,
        env=env,
        text=True,
        check=False,
        timeout=10,
    )

    return _RunnerSmokeResult(
        completed=completed,
        log_dir=log_dir,
        token_file=token_file,
        exit_code_file=log_dir / MuxAgent._RUN_EXIT_CODE_NAME,
        timeout_marker=timeout_marker,
        trust_timeout_args_file=trust_timeout_args_file,
        args_file=args_file,
    )


def test_env_defaults_are_normalized(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path, model_name="anthropic/claude-sonnet-4-5")

    env = agent._env

    assert env["MUX_MODEL"] == "anthropic:claude-sonnet-4-5"
    assert env["MUX_PROJECT_CANDIDATES"] == agent._DEFAULT_PROJECT_CANDIDATES


def test_goal_mode_env_is_forwarded(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    monkeypatch.setenv("MUX_RUN_AS_GOAL", "true")

    agent = MuxAgent(logs_dir=tmp_path)

    assert agent._env["MUX_RUN_AS_GOAL"] == "1"


def test_goal_mode_defaults_to_disabled(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))

    agent = MuxAgent(logs_dir=tmp_path)

    assert "MUX_RUN_AS_GOAL" not in agent._env


def test_goal_mode_rejects_invalid_values(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    monkeypatch.setenv("MUX_RUN_AS_GOAL", "yes")

    agent = MuxAgent(logs_dir=tmp_path)
    with pytest.raises(ValueError, match="MUX_RUN_AS_GOAL"):
        _ = agent._env


def test_timeout_must_be_numeric(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    monkeypatch.setenv("MUX_TIMEOUT_MS", "not-a-number")

    agent = MuxAgent(logs_dir=tmp_path)
    with pytest.raises(ValueError):
        _ = agent._env


def test_timeout_kwarg_is_instance_local(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))

    agent = MuxAgent(logs_dir=tmp_path, timeout=1)

    assert os.environ.get("MUX_TIMEOUT_MS") is None
    assert agent._env["MUX_TIMEOUT_MS"] == "1000"
    assert "MUX_TIMEOUT_MS" not in MuxAgent(logs_dir=tmp_path / "other")._env


def test_mux_runner_scores_goal_mode_incomplete_exit(tmp_path: Path) -> None:
    result = _run_mux_runner_smoke(tmp_path, exit_code=3, goal_mode="1")

    assert result.completed.returncode == 0, result.completed.stderr
    assert result.exit_code_file.read_text() == "0"
    assert "WARNING: mux goal run stopped incomplete" in result.completed.stderr
    args = result.args_file.read_text()
    assert "--goal" in args
    assert "--no-mcp-config" in args
    assert "solve it" in args
    # Trust must be granted (against the resolved project dir) before the
    # agent starts, or sub-agent spawns fail the trust gate inside the run.
    trust_args = Path(f"{result.args_file}.trust").read_text()
    assert "src/cli/trust.ts" in trust_args
    assert str(tmp_path / "project") in trust_args
    timeout_args = result.trust_timeout_args_file.read_text()
    assert timeout_args.startswith("60s ")
    assert "bun src/cli/trust.ts --dir" in timeout_args
    assert str(tmp_path / "project") in timeout_args
    assert json.loads(result.token_file.read_text()) == {
        "input": 7,
        "output": 11,
        "cache_read": 5,
        "cache_write": 3,
        "cost_usd": 0.42,
    }
    stdout_event = json.loads((result.log_dir / "stdout.txt").read_text())
    assert stdout_event["type"] == "run-complete"
    # The full event stream and token summary are staged in the session root
    # for the post-run archive, alongside the CLI-written session files.
    session_root = result.log_dir.parents[2] / "session-root"
    assert (session_root / "run-stdout.jsonl").is_file()
    assert (session_root / "mux-tokens.json").is_file()


@pytest.mark.parametrize(
    "config_key",
    [
        "merge.evil.driver",
        "diff.external",
        "remote.origin.uploadpack",
        "gpg.program",
        "gpg.ssh.defaultKeyCommand",
        "gc.recentObjectsHook",
        "core.editor",
        "core.fsmonitor",
        "core.pager",
        "core.attributesFile",
        "core.alternateRefsCommand",
        "sequence.editor",
        "pager.log",
        "interactive.diffFilter",
        "browser.evil.cmd",
        "web.browser",
        "help.browser",
        "man.viewer",
        "difftool.evil.cmd",
        "mergetool.evil.path",
        "guitool.evil.cmd",
        "instaweb.httpd",
        "sendemail.smtpServer",
        "remote.origin.proxy",
        "uploadpack.packObjectsHook",
        "hook.pre-commit.command",
        "trailer.foo.cmd",
        "tar.tar.xz.command",
        "diff.tool",
        "merge.tool",
        "alias.evil.command",
    ],
)
def test_mux_runner_rejects_git_driver_before_trust(
    tmp_path: Path, config_key: str
) -> None:
    result = _run_mux_runner_smoke(
        tmp_path,
        exit_code=0,
        repo_git_config=(config_key, "./steal-secrets"),
    )

    assert result.completed.returncode == 1
    assert (
        "refusing to trust project with repo-controlled Git commands"
        in result.completed.stderr
    )
    assert not Path(f"{result.args_file}.trust").exists()


@pytest.mark.parametrize(
    ("config_key", "config_value"),
    [
        ("alias.exfil", "!./steal-secrets"),
        ("submodule.evil.update", "!./steal-secrets"),
    ],
)
def test_mux_runner_rejects_value_dependent_git_commands(
    tmp_path: Path, config_key: str, config_value: str
) -> None:
    result = _run_mux_runner_smoke(
        tmp_path,
        exit_code=0,
        repo_git_config=(config_key, config_value),
    )

    assert result.completed.returncode == 1
    assert "repo-controlled Git commands" in result.completed.stderr
    assert not Path(f"{result.args_file}.trust").exists()


def test_mux_runner_rejects_non_utf8_shell_alias_value(tmp_path: Path) -> None:
    result = _run_mux_runner_smoke(
        tmp_path,
        exit_code=0,
        repo_git_config_bytes=b"\n[alias]\n\texfil = \xffcommand\n",
    )

    assert result.completed.returncode == 1
    assert "unsupported Git command config values" in result.completed.stderr
    assert not Path(f"{result.args_file}.trust").exists()


def test_mux_runner_allows_non_shell_alias(tmp_path: Path) -> None:
    result = _run_mux_runner_smoke(
        tmp_path,
        exit_code=0,
        repo_git_config=("alias.summary", "status --short"),
    )

    assert result.completed.returncode == 0, result.completed.stderr
    assert Path(f"{result.args_file}.trust").exists()


@pytest.mark.parametrize(
    "config_key",
    ["include.path", "includeIf.onbranch:other.path"],
)
def test_mux_runner_rejects_git_config_includes(
    tmp_path: Path, config_key: str
) -> None:
    result = _run_mux_runner_smoke(
        tmp_path,
        exit_code=0,
        repo_git_config=(config_key, "../hidden-config"),
    )

    assert result.completed.returncode == 1
    assert "Git config includes" in result.completed.stderr
    assert not Path(f"{result.args_file}.trust").exists()


def test_mux_runner_rejects_oversized_git_config(tmp_path: Path) -> None:
    result = _run_mux_runner_smoke(
        tmp_path,
        exit_code=0,
        repo_git_config_bytes=b"\n[safe]\n\tlarge = " + b"x" * (300 * 1024) + b"\n",
    )

    assert result.completed.returncode == 1
    assert "Git config output exceeds limit" in result.completed.stderr
    assert not Path(f"{result.args_file}.trust").exists()


def test_mux_runner_rejects_non_ascii_git_config_name(tmp_path: Path) -> None:
    result = _run_mux_runner_smoke(
        tmp_path,
        exit_code=0,
        repo_git_config_bytes=b'\n[filter "\xffevil"]\n\tclean = ./steal-secrets\n',
    )

    assert result.completed.returncode == 1
    assert "non-ASCII Git config names" in result.completed.stderr
    assert not Path(f"{result.args_file}.trust").exists()


def test_mux_runner_refuses_trust_when_git_inspection_times_out(tmp_path: Path) -> None:
    result = _run_mux_runner_smoke(
        tmp_path,
        exit_code=0,
        pretrust_git_timeout=True,
    )

    assert result.completed.returncode == 1
    assert (
        "timed out inspecting repository automation drivers" in result.completed.stderr
    )
    assert not Path(f"{result.args_file}.trust").exists()


def test_mux_runner_refuses_trust_when_trust_command_times_out(tmp_path: Path) -> None:
    result = _run_mux_runner_smoke(
        tmp_path,
        exit_code=0,
        trust_timeout=True,
    )

    assert result.completed.returncode == 1
    assert "timed out trusting project" in result.completed.stderr
    assert "timed out trusting project" in (result.log_dir / "stderr.txt").read_text()
    session_stderr = result.log_dir.parents[2] / "session-root" / "run-stderr.log"
    assert "timed out trusting project" in session_stderr.read_text()
    assert not Path(f"{result.args_file}.trust").exists()


def test_mux_runner_preserves_incomplete_exit_outside_goal_mode(tmp_path: Path) -> None:
    result = _run_mux_runner_smoke(tmp_path, exit_code=3)

    assert result.completed.returncode == 3
    assert result.exit_code_file.read_text() == "3"
    assert "mux agent session failed (exit 3)" in result.completed.stderr
    assert result.token_file.exists()


def test_mux_runner_preserves_fatal_exit(tmp_path: Path) -> None:
    result = _run_mux_runner_smoke(tmp_path, exit_code=1, goal_mode="1")

    assert result.completed.returncode == 1
    assert result.exit_code_file.read_text() == "1"
    assert "mux agent session failed (exit 1)" in result.completed.stderr
    assert "WARNING: mux goal run stopped incomplete" not in result.completed.stderr
    assert json.loads(result.token_file.read_text()) == {
        "input": 7,
        "output": 11,
        "cache_read": 5,
        "cache_write": 3,
        "cost_usd": 0.42,
    }


def test_mux_runner_persists_failure_marker_to_collected_stderr(tmp_path: Path) -> None:
    """Failure markers must survive transports that drop channel stderr.

    Remote exec channels can lose the runner's stderr tail, which previously
    made a nonzero exit indistinguishable from a fabricated channel failure.
    The marker must land in the collected stderr file and its archived copy.
    """
    result = _run_mux_runner_smoke(tmp_path, exit_code=1)

    assert result.completed.returncode == 1
    marker = mux_run_failure_marker(1)
    assert marker in (result.log_dir / "stderr.txt").read_text()
    session_root = result.log_dir.parents[2] / "session-root"
    assert marker in (session_root / "run-stderr.log").read_text()


def test_mux_runner_waits_for_stderr_capture_before_persisting_status(
    tmp_path: Path,
) -> None:
    result = _run_mux_runner_smoke(
        tmp_path,
        exit_code=1,
        overwrite_stderr_after_status=True,
    )

    marker = mux_run_failure_marker(1)
    assert marker in (result.log_dir / "stderr.txt").read_text()
    session_root = result.log_dir.parents[2] / "session-root"
    assert marker in (session_root / "run-stderr.log").read_text()


def test_mux_runner_downgrades_tee_failure_after_run_complete(tmp_path: Path) -> None:
    """A dropped exec-channel stdout reader fails tee with EPIPE after the run
    finished; the complete collected file must keep the trial scoreable."""
    result = _run_mux_runner_smoke(tmp_path, exit_code=0, fake_tee_exit_code=1)

    assert result.completed.returncode == 0, result.completed.stderr
    assert result.exit_code_file.read_text() == "0"
    stderr_file = (result.log_dir / "stderr.txt").read_text()
    assert "stdout tee failed (exit 1) after run-complete" in stderr_file
    assert "failed to capture mux stdout" not in stderr_file


def test_mux_runner_keeps_tee_failure_without_run_complete(tmp_path: Path) -> None:
    result = _run_mux_runner_smoke(
        tmp_path, exit_code=0, fake_tee_exit_code=1, emit_run_complete=False
    )

    assert result.completed.returncode == 1
    assert (
        "failed to capture mux stdout (exit 1)"
        in (result.log_dir / "stderr.txt").read_text()
    )


def test_mux_runner_leaves_timeout_to_harbor(tmp_path: Path) -> None:
    result = _run_mux_runner_smoke(tmp_path, exit_code=0, timeout_ms="1000")

    assert result.completed.returncode == 0, result.completed.stderr
    assert result.exit_code_file.read_text() == "0"
    assert "Harbor remains timeout authority" in result.completed.stdout
    assert not result.timeout_marker.exists()


@dataclass
class _ExecResult:
    return_code: int
    stdout: str = ""
    stderr: str = ""


class _LocalShellEnvironment:
    async def exec(self, **kwargs: object) -> _ExecResult:
        command = kwargs.get("command")
        assert isinstance(command, str)
        completed = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            check=False,
        )
        return _ExecResult(
            return_code=completed.returncode,
            stdout=completed.stdout,
            stderr=completed.stderr,
        )


class _FakeEnvironment:
    def __init__(
        self,
        result: _ExecResult,
        command_dir: Path | None = None,
        delay_sec: float = 0,
        session_archive: bytes | None = None,
        runner_exit_code: str | None = None,
        stale_runner_exit_code: str | None = None,
        preexisting_session_dirs: tuple[str, ...] = (),
        token_payload: str | None = None,
    ) -> None:
        self.result = result
        self.command_dir = command_dir
        self.delay_sec = delay_sec
        self.session_archive = session_archive
        self.runner_exit_code = runner_exit_code
        self.stale_runner_exit_code = stale_runner_exit_code
        self.preexisting_session_dirs = preexisting_session_dirs
        self.token_payload = token_payload
        self.snapshot_requested = False
        self.marker_download_bytes = 0
        self.exec_commands: list[str] = []
        self.download_attempts: list[tuple[str, Path]] = []

    async def exec(self, **_kwargs: object) -> _ExecResult:
        command = _kwargs.get("command")
        if isinstance(command, str):
            self.exec_commands.append(command)
        if (
            isinstance(command, str)
            and "head -c" in command
            and MuxAgent._RUN_EXIT_CODE_NAME in command
        ):
            exit_code = self.runner_exit_code or self.stale_runner_exit_code
            if exit_code is None:
                return _ExecResult(return_code=1)
            cap_match = re.search(r"head -c (\d+)", command)
            assert cap_match is not None
            return _ExecResult(
                return_code=0, stdout=exit_code[: int(cap_match.group(1))]
            )
        if (
            isinstance(command, str)
            and command.startswith("rm -f -- ")
            and MuxAgent._RUN_EXIT_CODE_NAME in command
        ):
            self.stale_runner_exit_code = None
            return _ExecResult(return_code=0)
        if (
            isinstance(command, str)
            and "find . -type f -name session-usage.json" in command
        ):
            self.snapshot_requested = True
            snapshot = "\0".join(self.preexisting_session_dirs)
            if snapshot:
                snapshot += "\0"
            return _ExecResult(
                return_code=0, stdout=base64.b64encode(snapshot.encode()).decode()
            )
        if isinstance(command, str) and "tar --null -czf - -T -" in command:
            if self.session_archive is None:
                return _ExecResult(return_code=1)
            archive_bytes = self.session_archive
            if self.snapshot_requested and all(
                path in command for path in self.preexisting_session_dirs
            ):
                archive_bytes = _archive_without_session_dirs(
                    archive_bytes, self.preexisting_session_dirs
                )
            cap_match = re.search(r"head -c (\d+)", command)
            assert cap_match is not None
            archive_cap = int(cap_match.group(1))
            encoded = base64.b64encode(archive_bytes[:archive_cap]).decode()
            return _ExecResult(return_code=0, stdout=encoded)
        timeout_sec = _kwargs.get("timeout_sec")
        if self.delay_sec:
            if isinstance(timeout_sec, (int, float)) and timeout_sec < self.delay_sec:
                await asyncio.sleep(timeout_sec)
                raise RuntimeError(f"Command timed out after {timeout_sec} seconds")
            await asyncio.sleep(self.delay_sec)
        if self.command_dir is not None:
            stdout_path = self.command_dir / MuxAgent._COMMAND_STDOUT_NAME
            stderr_path = self.command_dir / MuxAgent._COMMAND_STDERR_NAME
            assert stdout_path.exists()
            assert stderr_path.exists()
            stdout_path.write_text("sandbox out")
            stderr_path.write_text("sandbox err")
        return self.result

    async def download_file(self, source_path: str, target_path: Path) -> None:
        self.download_attempts.append((source_path, target_path))
        if source_path.endswith(f"/{MuxAgent._RUN_EXIT_CODE_NAME}"):
            exit_code = self.runner_exit_code or self.stale_runner_exit_code
            if exit_code is None:
                raise FileNotFoundError(source_path)
            self.marker_download_bytes += len(exit_code.encode())
            target_path.write_text(exit_code)
            return
        assert source_path == MuxAgent._TOKEN_FILE_PATH
        target_path.write_text(
            self.token_payload
            or '{"input": 7, "output": 11, "cache_read": 5, "cache_write": 3, "cost_usd": 0.42}'
        )


def test_run_raises_after_preserving_logs_for_nonzero_exit(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    environment = _FakeEnvironment(
        _ExecResult(return_code=7, stdout="out", stderr="err")
    )
    context = SimpleNamespace()

    with pytest.raises(RuntimeError, match="mux agent command failed"):
        asyncio.run(agent.run("do the task", environment, context))

    command_dir = tmp_path / "command-0"
    assert (command_dir / "return-code.txt").read_text() == "7"
    assert (command_dir / MuxAgent._COMMAND_STDOUT_NAME).read_text() == "out"
    assert (command_dir / MuxAgent._COMMAND_STDERR_NAME).read_text() == "err"
    assert environment.download_attempts == [
        (agent._TOKEN_FILE_PATH, tmp_path / "mux-tokens.json"),
    ]
    # input(7) + cache_read(5) + cache_write(3): cache traffic counts as input
    assert getattr(context, "n_input_tokens") == 15
    assert getattr(context, "n_output_tokens") == 11
    assert getattr(context, "cost_usd") == 0.42


def test_run_uses_runner_exit_code_over_channel_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    environment = _FakeEnvironment(
        _ExecResult(return_code=1, stdout="truncated", stderr=""),
        runner_exit_code="0",
    )

    asyncio.run(agent.run("do the task", environment, SimpleNamespace()))

    diagnostic = tmp_path / "command-0" / "transport-diagnostic.log"
    assert "channel return code 1 disagreed with mux-run exit code 0" in (
        diagnostic.read_text()
    )


def test_run_bounds_oversized_runner_exit_marker(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    environment = _FakeEnvironment(
        _ExecResult(return_code=7),
        runner_exit_code="0" * 1024,
    )

    with pytest.raises(RuntimeError, match="exit 7"):
        asyncio.run(agent.run("do the task", environment, SimpleNamespace()))

    assert environment.marker_download_bytes == 0
    assert any(
        "head -c 4" in command and agent._RUN_EXIT_CODE_NAME in command
        for command in environment.exec_commands
    )


def test_run_uses_runner_exit_code_over_channel_success(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    environment = _FakeEnvironment(_ExecResult(return_code=0), runner_exit_code="1")

    with pytest.raises(RuntimeError, match="exit 1"):
        asyncio.run(agent.run("do the task", environment, SimpleNamespace()))


def test_run_ignores_stale_runner_exit_code(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    environment = _FakeEnvironment(
        _ExecResult(return_code=7),
        stale_runner_exit_code="0",
    )

    with pytest.raises(RuntimeError, match="exit 7"):
        asyncio.run(agent.run("do the task", environment, SimpleNamespace()))


def test_run_keeps_channel_failure_without_runner_exit_code(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    environment = _FakeEnvironment(_ExecResult(return_code=1))

    with pytest.raises(RuntimeError, match="exit 1"):
        asyncio.run(agent.run("do the task", environment, SimpleNamespace()))


@pytest.mark.parametrize("runner_exit_code", ["", "garbage", "99999999999999999999"])
def test_run_ignores_malformed_runner_exit_code(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, runner_exit_code: str
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    environment = _FakeEnvironment(
        _ExecResult(return_code=1), runner_exit_code=runner_exit_code
    )

    with pytest.raises(RuntimeError, match="exit 1"):
        asyncio.run(agent.run("do the task", environment, SimpleNamespace()))


def test_run_timeout_surfaces_agent_timeout_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path, timeout=0.01)
    environment = _FakeEnvironment(
        _ExecResult(return_code=0, stdout="out", stderr="err"),
        delay_sec=0.05,
    )
    context = SimpleNamespace()

    with pytest.raises(AgentTimeoutError, match="timed out after 0.01 seconds"):
        asyncio.run(agent.run("do the task", environment, context))

    assert environment.download_attempts == [
        (agent._TOKEN_FILE_PATH, tmp_path / "mux-tokens.json"),
    ]
    # input(7) + cache_read(5) + cache_write(3): cache traffic counts as input
    assert getattr(context, "n_input_tokens") == 15
    assert getattr(context, "n_output_tokens") == 11
    assert getattr(context, "cost_usd") == 0.42


def test_run_maps_near_timeout_return_code_124_to_agent_timeout(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path, timeout=0.01)
    environment = _FakeEnvironment(
        _ExecResult(return_code=124, stdout="partial event", stderr=""),
        delay_sec=0.01,
    )
    context = SimpleNamespace()

    with pytest.raises(AgentTimeoutError, match="timed out after 0.01 seconds"):
        asyncio.run(agent.run("do the task", environment, context))

    command_dir = tmp_path / "command-0"
    assert (command_dir / "return-code.txt").read_text() == "124"
    assert (command_dir / MuxAgent._COMMAND_STDOUT_NAME).read_text() == "partial event"


def test_run_keeps_fast_return_code_124_strict(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path, timeout=10)
    environment = _FakeEnvironment(_ExecResult(return_code=124))
    context = SimpleNamespace()

    with pytest.raises(RuntimeError, match="exit 124"):
        asyncio.run(agent.run("do the task", environment, context))


@pytest.mark.parametrize("return_code", [1, 137])
def test_run_keeps_non_timeout_agent_exits_strict(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, return_code: int
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path, timeout=0.01)
    environment = _FakeEnvironment(
        _ExecResult(return_code=return_code, stdout="partial event", stderr=""),
        delay_sec=0.01,
    )
    context = SimpleNamespace()

    with pytest.raises(RuntimeError, match=f"exit {return_code}"):
        asyncio.run(agent.run("do the task", environment, context))


def test_run_keeps_explicit_return_code_124_failure_strict(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path, timeout=0.01)
    environment = _FakeEnvironment(
        _ExecResult(
            return_code=124,
            stdout="partial event",
            stderr="[mux-run] ERROR: mux agent session failed (exit 124)",
        ),
        delay_sec=0.01,
    )
    context = SimpleNamespace()

    with pytest.raises(RuntimeError, match="exit 124"):
        asyncio.run(agent.run("do the task", environment, context))


def test_run_preseeds_command_logs_before_sandbox_exec(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    command_dir = tmp_path / "command-0"
    environment = _FakeEnvironment(
        _ExecResult(return_code=0, stdout="out", stderr="err"),
        command_dir=command_dir,
    )
    context = SimpleNamespace()

    asyncio.run(agent.run("do the task", environment, context))

    assert (command_dir / MuxAgent._COMMAND_STDOUT_NAME).read_text() == "out"
    assert (command_dir / MuxAgent._COMMAND_STDERR_NAME).read_text() == "err"


def test_run_populates_context_for_successful_exit(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    environment = _FakeEnvironment(
        _ExecResult(return_code=0, stdout="out", stderr="err")
    )
    context = SimpleNamespace()

    asyncio.run(agent.run("do the task", environment, context))

    command_dir = tmp_path / "command-0"
    assert (command_dir / "return-code.txt").read_text() == "0"
    assert (command_dir / MuxAgent._COMMAND_STDOUT_NAME).read_text() == "out"
    assert (command_dir / MuxAgent._COMMAND_STDERR_NAME).read_text() == "err"
    # input(7) + cache_read(5) + cache_write(3): cache traffic counts as input
    assert getattr(context, "n_input_tokens") == 15
    assert getattr(context, "n_output_tokens") == 11
    assert getattr(context, "cost_usd") == 0.42


def _sessions_archive_bytes(
    sessions: dict[str, dict], extra_files: dict[str, bytes] | None = None
) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for path, payload in (extra_files or {}).items():
            info = tarfile.TarInfo(path)
            info.size = len(payload)
            archive.addfile(info, io.BytesIO(payload))
        for session_id, usage in sessions.items():
            payload = json.dumps(usage).replace("Infinity", "1e309").encode("utf-8")
            info = tarfile.TarInfo(f"sessions/{session_id}/session-usage.json")
            info.size = len(payload)
            archive.addfile(info, io.BytesIO(payload))
    return buffer.getvalue()


def _archive_without_session_dirs(
    archive_bytes: bytes, session_dirs: tuple[str, ...]
) -> bytes:
    excluded = tuple(path.removeprefix("./") + "/" for path in session_dirs)
    source_buffer = io.BytesIO(archive_bytes)
    target_buffer = io.BytesIO()
    with tarfile.open(fileobj=source_buffer, mode="r:gz") as source:
        with tarfile.open(fileobj=target_buffer, mode="w:gz") as target:
            for member in source:
                member_path = member.name.removeprefix("./")
                if member_path.startswith(excluded):
                    continue
                target.addfile(member, source.extractfile(member))
    return target_buffer.getvalue()


def _usage_display(
    *,
    input_tokens: int = 10,
    cached: int = 100,
    cache_create: int = 5,
    output: int = 20,
    reasoning: int = 7,
    with_costs: bool = True,
) -> dict:
    def component(tokens: int, cost: float) -> dict:
        entry: dict = {"tokens": tokens}
        if with_costs:
            entry["cost_usd"] = cost
        return entry

    return {
        "byModel": {
            "anthropic:claude-test": {
                "input": component(input_tokens, 0.01),
                "cached": component(cached, 0.02),
                "cacheCreate": component(cache_create, 0.03),
                "output": component(output, 0.04),
                "reasoning": component(reasoning, 0.05),
            }
        },
        "version": 1,
    }


def test_run_streams_session_archive_through_byte_cap(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    environment = _FakeEnvironment(
        _ExecResult(return_code=0, stdout="out", stderr="err"),
        session_archive=_sessions_archive_bytes({"ws-main": _usage_display()}),
    )
    context = SimpleNamespace()

    asyncio.run(agent.run("do the task", environment, context))

    tar_commands = [
        command
        for command in environment.exec_commands
        if "tar --null -czf - -T -" in command
    ]
    assert len(tar_commands) == 1
    assert "cd /tmp/mux-run-root" in tar_commands[0]
    assert f"head -c {agent._SESSIONS_ARCHIVE_MAX_BYTES + 1}" in tar_commands[0]
    for expected in (
        "chat.jsonl",
        "chat-archive.jsonl",
        "session-usage.json",
        "run-stdout.jsonl",
        "run-stderr.log",
        "mux-tokens.json",
    ):
        assert expected in tar_commands[0]
    assert all(
        not source_path.startswith("/tmp/mux-sessions-")
        for source_path, _ in environment.download_attempts
    )
    assert (tmp_path / MuxAgent._SESSIONS_ARCHIVE_NAME).is_file()
    summary = json.loads((tmp_path / MuxAgent._SESSION_USAGE_SUMMARY_NAME).read_text())
    assert summary == {
        "input": 10,
        "output": 20,
        "reasoning": 7,
        "cache_read": 100,
        "cache_write": 5,
        "cost_usd": pytest.approx(0.15),
        "sessions": 1,
    }
    assert getattr(context, "cost_usd") == 0.42
    assert getattr(context, "n_input_tokens") == 15


def test_run_excludes_preexisting_session_directories(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    environment = _FakeEnvironment(
        _ExecResult(return_code=0),
        session_archive=_sessions_archive_bytes(
            {
                "ws-old": _usage_display(input_tokens=1000, output=1000),
                "ws-current": _usage_display(),
            }
        ),
        preexisting_session_dirs=("./sessions/ws-old",),
        token_payload=(
            '{"input": 1, "output": 1, "cache_read": 0, '
            '"cache_write": 0, "cost_usd": null}'
        ),
    )
    context = SimpleNamespace()

    asyncio.run(agent.run("do the task", environment, context))

    assert getattr(context, "n_input_tokens") == 115
    assert getattr(context, "n_output_tokens") == 20
    assert getattr(context, "cost_usd") == pytest.approx(0.15)


def test_session_archive_skips_hard_linked_telemetry(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    session_root = tmp_path / "session-root"
    good_session = session_root / "sessions/good"
    linked_session = session_root / "sessions/linked"
    good_session.mkdir(parents=True)
    linked_session.mkdir(parents=True)
    good_usage = json.dumps(_usage_display())
    (good_session / "session-usage.json").write_text(good_usage)
    credential_file = tmp_path / "providers.jsonc"
    credential_file.write_text('{"secret":"provider-key"}')
    os.link(credential_file, linked_session / "session-usage.json")
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    monkeypatch.setenv("MUX_RUN_SESSION_ROOT", str(session_root))
    agent = MuxAgent(logs_dir=tmp_path / "logs")
    agent.logs_dir.mkdir()

    asyncio.run(agent._download_session_artifacts(_LocalShellEnvironment(), ()))

    archive_path = agent.logs_dir / MuxAgent._SESSIONS_ARCHIVE_NAME
    with tarfile.open(archive_path, "r:gz") as archive:
        names = archive.getnames()
    assert "./sessions/good/session-usage.json" in names
    assert "./sessions/linked/session-usage.json" not in names
    diagnostic = (agent.logs_dir / "mux-sessions-collect.log").read_text()
    assert "skipped linked telemetry files" in diagnostic


def test_populate_context_prefers_priced_session_when_not_older(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    (tmp_path / "mux-tokens.json").write_text(
        '{"input": 1, "output": 2, "cache_read": 3, "cache_write": 4, "cost_usd": null}'
    )
    (tmp_path / MuxAgent._SESSIONS_ARCHIVE_NAME).write_bytes(
        _sessions_archive_bytes({"ws-main": _usage_display()})
    )
    context = SimpleNamespace()

    agent.populate_context_post_run(context)

    # input(10) + cache_read(100) + cache_write(5)
    assert getattr(context, "n_input_tokens") == 115
    assert getattr(context, "n_output_tokens") == 20
    assert getattr(context, "cost_usd") == pytest.approx(0.15)


def test_populate_context_uses_session_usage_when_token_file_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    (tmp_path / MuxAgent._SESSIONS_ARCHIVE_NAME).write_bytes(
        _sessions_archive_bytes({"ws-main": _usage_display(with_costs=False)})
    )
    context = SimpleNamespace()

    agent.populate_context_post_run(context)

    assert getattr(context, "n_input_tokens") == 115
    assert getattr(context, "n_output_tokens") == 20
    # No cost buckets recorded -> cost stays unset rather than a misleading 0.
    assert not hasattr(context, "cost_usd")


def test_run_rejects_oversized_streamed_session_archive(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    archive = _sessions_archive_bytes({"ws-main": _usage_display()})
    monkeypatch.setattr(MuxAgent, "_SESSIONS_ARCHIVE_MAX_BYTES", len(archive) - 1)
    agent = MuxAgent(logs_dir=tmp_path)
    environment = _FakeEnvironment(
        _ExecResult(return_code=0),
        session_archive=archive,
    )

    asyncio.run(agent.run("do the task", environment, SimpleNamespace()))

    assert not (tmp_path / MuxAgent._SESSIONS_ARCHIVE_NAME).exists()
    assert all(
        not source_path.startswith("/tmp/mux-sessions-")
        for source_path, _ in environment.download_attempts
    )
    diagnostic = (tmp_path / "mux-sessions-collect.log").read_text()
    assert "streamed archive too large" in diagnostic


def test_populate_context_prefers_fresher_unpriced_stdout_counts(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    (tmp_path / "mux-tokens.json").write_text(
        '{"input": 500, "output": 90, "cache_read": 800, "cache_write": 40, "cost_usd": null}'
    )
    (tmp_path / MuxAgent._SESSIONS_ARCHIVE_NAME).write_bytes(
        _sessions_archive_bytes({"ws-main": _usage_display()})
    )
    context = SimpleNamespace()

    agent.populate_context_post_run(context)

    assert getattr(context, "n_input_tokens") == 500 + 800 + 40
    assert getattr(context, "n_output_tokens") == 90
    assert not hasattr(context, "cost_usd")


def test_populate_context_rejects_priced_stdout_with_invalid_token_bucket(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    (tmp_path / "mux-tokens.json").write_text(
        '{"input": 1e309, "output": 0, "cost_usd": 0.5}'
    )
    (tmp_path / MuxAgent._SESSIONS_ARCHIVE_NAME).write_bytes(
        _sessions_archive_bytes({"ws-main": _usage_display()})
    )
    context = SimpleNamespace()

    agent.populate_context_post_run(context)

    assert getattr(context, "n_input_tokens") == 115
    assert getattr(context, "n_output_tokens") == 20
    assert getattr(context, "cost_usd") == pytest.approx(0.15)


def test_populate_context_keeps_valid_fresher_non_finite_token_file_counts(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    (tmp_path / "mux-tokens.json").write_text(
        '{"input": 1e309, "output": 1000, "cost_usd": null}'
    )
    (tmp_path / MuxAgent._SESSIONS_ARCHIVE_NAME).write_bytes(
        _sessions_archive_bytes({"ws-main": _usage_display()})
    )
    context = SimpleNamespace()

    agent.populate_context_post_run(context)

    assert getattr(context, "n_input_tokens") == 0
    assert getattr(context, "n_output_tokens") == 1000
    assert not hasattr(context, "cost_usd")


@pytest.mark.parametrize("cost_json", ["1e309", "-0.01", '"invalid"'])
def test_populate_context_keeps_fresher_counts_for_invalid_stdout_cost(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, cost_json: str
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    (tmp_path / "mux-tokens.json").write_text(
        f'{{"input": 500, "output": 90, "cost_usd": {cost_json}}}'
    )
    (tmp_path / MuxAgent._SESSIONS_ARCHIVE_NAME).write_bytes(
        _sessions_archive_bytes({"ws-main": _usage_display()})
    )
    context = SimpleNamespace()

    agent.populate_context_post_run(context)

    assert getattr(context, "n_input_tokens") == 500
    assert getattr(context, "n_output_tokens") == 90
    assert not hasattr(context, "cost_usd")


def test_populate_context_leaves_invalid_stdout_cost_unset_without_session(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    (tmp_path / "mux-tokens.json").write_text(
        '{"input": 7, "output": 11, "cost_usd": 1e309}'
    )
    context = SimpleNamespace()

    agent.populate_context_post_run(context)

    assert getattr(context, "n_input_tokens") == 7
    assert getattr(context, "n_output_tokens") == 11
    assert not hasattr(context, "cost_usd")


def test_populate_context_rejects_fractional_stdout_token_counts(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    (tmp_path / "mux-tokens.json").write_text(
        '{"input": 1.9, "output": 2.9, "cost_usd": 0.5}'
    )
    context = SimpleNamespace()

    agent.populate_context_post_run(context)

    assert getattr(context, "n_input_tokens") == 0
    assert getattr(context, "n_output_tokens") == 0
    assert getattr(context, "cost_usd") == pytest.approx(0.5)


def test_session_usage_leaves_cost_unset_for_unpriced_usage(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    usage = _usage_display()
    usage["byModel"]["custom:unknown-model"] = {
        "input": {"tokens": 42},
        "output": {"tokens": 9},
    }
    (tmp_path / MuxAgent._SESSIONS_ARCHIVE_NAME).write_bytes(
        _sessions_archive_bytes({"ws-main": usage})
    )

    totals = agent._summarize_session_usage()

    assert totals is not None
    assert totals["input"] == 10 + 42
    assert totals["cost_usd"] is None


def test_session_usage_rejects_archive_over_expanded_byte_cap(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    expanded_cap = 64 * 1024
    archive_bytes = _sessions_archive_bytes(
        {"ws-main": _usage_display()},
        {"sessions/ws-main/chat.jsonl": b"0" * (2 * 1024 * 1024)},
    )
    assert len(archive_bytes) < expanded_cap
    monkeypatch.setattr(
        MuxAgent, "_SESSIONS_ARCHIVE_MAX_EXPANDED_BYTES", expanded_cap, raising=False
    )
    agent = MuxAgent(logs_dir=tmp_path)
    (tmp_path / MuxAgent._SESSIONS_ARCHIVE_NAME).write_bytes(archive_bytes)

    totals = agent._summarize_session_usage()

    assert totals is None


def test_session_usage_accepts_archive_below_expanded_byte_cap(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    monkeypatch.setattr(
        MuxAgent, "_SESSIONS_ARCHIVE_MAX_EXPANDED_BYTES", 64 * 1024, raising=False
    )
    agent = MuxAgent(logs_dir=tmp_path)
    (tmp_path / MuxAgent._SESSIONS_ARCHIVE_NAME).write_bytes(
        _sessions_archive_bytes({"ws-main": _usage_display()})
    )

    totals = agent._summarize_session_usage()

    assert totals is not None
    assert totals["sessions"] == 1
    assert totals["input"] == 10
    assert totals["cost_usd"] == pytest.approx(0.15)


def test_session_usage_enforces_aggregate_byte_cap(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    (tmp_path / MuxAgent._SESSIONS_ARCHIVE_NAME).write_bytes(
        _sessions_archive_bytes(
            {
                "ws-1": _usage_display(),
                "ws-2": _usage_display(),
                "ws-3": _usage_display(),
            }
        )
    )
    # Cap below two members' worth: only the first parses, iteration stops.
    member_bytes = len(json.dumps(_usage_display()).encode("utf-8"))
    monkeypatch.setattr(
        MuxAgent, "_SESSION_USAGE_MAX_TOTAL_BYTES", member_bytes + member_bytes // 2
    )

    totals = agent._summarize_session_usage()

    assert totals is None


def test_session_usage_skips_malformed_entries(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    (tmp_path / MuxAgent._SESSIONS_ARCHIVE_NAME).write_bytes(
        _sessions_archive_bytes(
            {
                "ws-bad-by-model": {"byModel": "corrupt", "version": 1},
                "ws-bad-model-entry": {"byModel": {"m": None}, "version": 1},
                "ws-bad-component": {
                    "byModel": {"m": {"input": "corrupt", "output": {"tokens": 4}}},
                    "version": 1,
                },
                "ws-main": _usage_display(),
            }
        )
    )

    totals = agent._summarize_session_usage()

    assert totals is not None
    # Malformed byModel skipped entirely; malformed components skipped per-field.
    assert totals["sessions"] == 3
    assert totals["input"] == 10
    assert totals["output"] == 20 + 4


def test_session_usage_skips_non_finite_tokens_without_losing_valid_sessions(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    invalid_usage = {
        "byModel": {"m": {"input": {"tokens": float("inf"), "cost_usd": 0.5}}},
        "version": 1,
    }
    (tmp_path / MuxAgent._SESSIONS_ARCHIVE_NAME).write_bytes(
        _sessions_archive_bytes(
            {"ws-main": _usage_display(), "ws-non-finite": invalid_usage}
        )
    )

    totals = agent._summarize_session_usage()

    assert totals is not None
    assert totals["sessions"] == 2
    assert totals["input"] == 10
    assert totals["cost_usd"] == pytest.approx(0.15)


def test_session_usage_discards_fractional_tokens_and_cost(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    fractional_usage = {
        "byModel": {"m": {"input": {"tokens": 1.9, "cost_usd": 0.5}}},
        "version": 1,
    }
    (tmp_path / MuxAgent._SESSIONS_ARCHIVE_NAME).write_bytes(
        _sessions_archive_bytes(
            {"ws-main": _usage_display(), "ws-fractional": fractional_usage}
        )
    )

    totals = agent._summarize_session_usage()

    assert totals is not None
    assert totals["sessions"] == 2
    assert totals["input"] == 10
    assert totals["cost_usd"] == pytest.approx(0.15)


def test_session_usage_skips_non_finite_cost_without_losing_valid_sessions(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    invalid_usage = {
        "byModel": {"m": {"input": {"tokens": 4, "cost_usd": float("inf")}}},
        "version": 1,
    }
    (tmp_path / MuxAgent._SESSIONS_ARCHIVE_NAME).write_bytes(
        _sessions_archive_bytes(
            {"ws-main": _usage_display(), "ws-non-finite": invalid_usage}
        )
    )

    totals = agent._summarize_session_usage()

    assert totals is not None
    assert totals["sessions"] == 2
    assert totals["input"] == 14
    assert totals["cost_usd"] is None


def test_session_usage_keeps_child_of_malformed_rollup_parent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    malformed_parent = {
        "byModel": "corrupt",
        "rolledUpFrom": {"ws-child": True},
        "version": 1,
    }
    (tmp_path / MuxAgent._SESSIONS_ARCHIVE_NAME).write_bytes(
        _sessions_archive_bytes(
            {"ws-parent": malformed_parent, "ws-child": _usage_display()}
        )
    )

    totals = agent._summarize_session_usage()

    assert totals is not None
    assert totals["sessions"] == 1
    assert totals["input"] == 10
    assert totals["cost_usd"] == pytest.approx(0.15)


def test_session_usage_keeps_child_of_zero_usage_rollup_parent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    zero_parent = {
        "byModel": {"m": {"input": {"tokens": 0}}},
        "rolledUpFrom": {"ws-child": True},
        "version": 1,
    }
    (tmp_path / MuxAgent._SESSIONS_ARCHIVE_NAME).write_bytes(
        _sessions_archive_bytes(
            {"ws-parent": zero_parent, "ws-child": _usage_display()}
        )
    )

    totals = agent._summarize_session_usage()

    assert totals is not None
    assert totals["sessions"] == 2
    assert totals["input"] == 10
    assert totals["cost_usd"] == pytest.approx(0.15)


def test_session_usage_keeps_child_of_fractional_usage_rollup_parent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    fractional_parent = {
        "byModel": {"m": {"input": {"tokens": 1.9}}},
        "rolledUpFrom": {"ws-child": True},
        "version": 1,
    }
    (tmp_path / MuxAgent._SESSIONS_ARCHIVE_NAME).write_bytes(
        _sessions_archive_bytes(
            {"ws-parent": fractional_parent, "ws-child": _usage_display()}
        )
    )

    totals = agent._summarize_session_usage()

    assert totals is not None
    assert totals["sessions"] == 2
    assert totals["input"] == 10
    assert totals["cost_usd"] == pytest.approx(0.15)


def test_session_usage_keeps_child_for_false_rollup_entry(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    parent = _usage_display()
    parent["rolledUpFrom"] = {"ws-child": False}
    (tmp_path / MuxAgent._SESSIONS_ARCHIVE_NAME).write_bytes(
        _sessions_archive_bytes({"ws-parent": parent, "ws-child": _usage_display()})
    )

    totals = agent._summarize_session_usage()

    assert totals is not None
    assert totals["sessions"] == 2
    assert totals["input"] == 20
    assert totals["cost_usd"] == pytest.approx(0.3)


def test_session_usage_skips_child_for_enriched_rollup_entry(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    parent = _usage_display()
    parent["rolledUpFrom"] = {
        "ws-child": {
            "totalTokens": 142,
            "inputTokens": 10,
            "outputTokens": 20,
            "rolledUpAtMs": 1_000,
        }
    }
    (tmp_path / MuxAgent._SESSIONS_ARCHIVE_NAME).write_bytes(
        _sessions_archive_bytes({"ws-parent": parent, "ws-child": _usage_display()})
    )

    totals = agent._summarize_session_usage()

    assert totals is not None
    assert totals["sessions"] == 1
    assert totals["input"] == 10
    assert totals["cost_usd"] == pytest.approx(0.15)


def test_session_usage_skips_rolled_up_children(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MUX_AGENT_REPO_ROOT", str(_repo_root()))
    agent = MuxAgent(logs_dir=tmp_path)
    parent = _usage_display()
    parent["rolledUpFrom"] = {"ws-child": True}
    (tmp_path / MuxAgent._SESSIONS_ARCHIVE_NAME).write_bytes(
        _sessions_archive_bytes({"ws-main": parent, "ws-child": _usage_display()})
    )

    totals = agent._summarize_session_usage()

    assert totals is not None
    assert totals["sessions"] == 1
    assert totals["input"] == 10
    assert totals["cost_usd"] == pytest.approx(0.15)


def test_app_archive_includes_postinstall_script() -> None:
    assert "scripts/postinstall.sh" in MuxAgent._INCLUDE_PATHS

    repo_root = _repo_root()
    postinstall = repo_root / "scripts/postinstall.sh"
    assert postinstall.is_file()

    archive_bytes = build_app_archive(repo_root, ["scripts/postinstall.sh"])
    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as archive:
        assert "scripts/postinstall.sh" in archive.getnames()
