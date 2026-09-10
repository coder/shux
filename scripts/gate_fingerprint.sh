#!/usr/bin/env bash
#
# gate_fingerprint.sh — memoize expensive verification gates (e.g. `make
# static-check`) against a content fingerprint of the current worktree.
#
# Why: agent validation loops often re-run identical gates against identical
# trees. Recording each gate outcome keyed by a worktree fingerprint lets
# callers skip a re-run when nothing has changed since the last run.
#
# Usage:
#   scripts/gate_fingerprint.sh fingerprint
#     Print the current worktree fingerprint (sha256 hex) and exit 0.
#
#   scripts/gate_fingerprint.sh record <gate> <pass|fail> <fingerprint>
#     Store the result for <gate> keyed by <fingerprint>, which MUST be the
#     fingerprint captured BEFORE the gate ran. Recording is refused when the
#     worktree no longer matches it: the gate's outcome describes the tree it
#     actually tested, and binding the record to a tree that changed mid-run
#     would let later `check` calls skip validation of untested changes.
#
#   scripts/gate_fingerprint.sh check <gate>
#     Exit 0 and print the cached result (pass|fail) when the recorded
#     fingerprint for <gate> matches the current worktree fingerprint.
#     Exit 1 when there is no record or it is stale: the caller must re-run
#     the gate and `record` the fresh outcome.
#
# Example fast path around a gate:
#   if result=$(scripts/gate_fingerprint.sh check static-check); then
#     [ "$result" = pass ] || exit 1   # cached fail
#   else
#     fp=$(scripts/gate_fingerprint.sh fingerprint)
#     if make static-check; then
#       scripts/gate_fingerprint.sh record static-check pass "$fp"
#     else
#       scripts/gate_fingerprint.sh record static-check fail "$fp"
#       exit 1
#     fi
#   fi
#
# Fingerprint = sha256 over:
#   - HEAD commit sha
#   - `git diff HEAD` (tracked changes, staged and unstaged; binary edits are
#     still captured via the blob hashes on `index` lines)
#   - sorted untracked-not-ignored file list with per-file content hashes
#
# Results live in a JSON file inside the worktree-local git dir (resolved via
# `git rev-parse --git-path`), so they are never committed, never fingerprint
# themselves, and do not leak across worktrees.
set -euo pipefail

STORE_BASENAME=gate_fingerprints.json

die() {
  # Plain-text prefix: the repo bans emoji status indicators (inconsistent
  # rendering across platforms/fonts).
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage: gate_fingerprint.sh <subcommand>
  fingerprint                Print the current worktree fingerprint.
  record <gate> <pass|fail> <fingerprint>
                             Store a gate result for <fingerprint> (captured
                             via `fingerprint` BEFORE the gate ran). Refused
                             when the worktree changed since then.
  check <gate>               Print cached result and exit 0 when fresh;
                             exit 1 when stale or missing (caller re-runs).
EOF
  exit 1
}

sha256_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    # macOS ships shasum but not always coreutils sha256sum.
    shasum -a 256 | awk '{print $1}'
  fi
}

# Keep gate keys shell/JSON/filename-friendly so callers can't smuggle in
# surprising strings (defensive: crash early on typos like an empty name).
assert_gate_name() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
    || die "invalid gate name '$1' (expected [A-Za-z0-9._-], starting alphanumeric)"
}

resolve_store_path() {
  # For a custom (non-shared) filename, --git-path resolves inside the
  # worktree-local git dir, e.g. .git/worktrees/<name>/ for linked worktrees.
  git rev-parse --path-format=absolute --git-path "$STORE_BASENAME"
}

# Untracked-not-ignored manifest: sorted paths with per-file content hashes
# plus the metadata a gate outcome can depend on — the executable bit (a
# chmod +x changes how builds/tests run the file) and symlink identity (a
# symlink must fingerprint as its target STRING, not the referent's content,
# and must never collide with a regular file of the same bytes).
# NUL-delimited plumbing AND NUL-terminated records: paths are the final
# field and may legally contain newlines, so a newline-terminated record
# would be ambiguous (one crafted filename could encode the same bytes as
# two separate records, letting a cached gate be reused for a different
# worktree). Paths can never contain NUL, so a NUL terminator keeps every
# record boundary unambiguous.
emit_untracked_manifest() {
  git status --porcelain=v1 -z -uall --no-renames \
    | while IFS= read -r -d '' entry; do
      if [ "${entry:0:2}" = '??' ]; then
        printf '%s\0' "${entry:3}"
      fi
    done \
    | LC_ALL=C sort -z \
    | while IFS= read -r -d '' path; do
      if [ -h "$path" ]; then
        # Hash the link target text (targets may contain arbitrary bytes).
        # `--` terminates option parsing: a root-level symlink named like
        # `-n` or `--help` is a legal Git path and must be an operand.
        printf 'symlink %s %s\0' "$(readlink -- "$path" | sha256_stream)" "$path"
      elif [ -f "$path" ] && [ -r "$path" ]; then
        if [ -x "$path" ]; then mode=x; else mode=-; fi
        printf '%s %s %s\0' "$(sha256_stream <"$path")" "$mode" "$path"
      else
        # Unreadable/special entries still perturb the fingerprint
        # deterministically instead of aborting.
        printf 'unhashable %s\0' "$path"
      fi
    done
}

compute_fingerprint() {
  # Section markers keep the concatenation unambiguous (a diff line can never
  # be confused with an untracked-manifest line).
  {
    printf 'head %s\n' "$(git rev-parse HEAD)"
    printf '%s\n' '== tracked diff =='
    # --no-ext-diff/--no-color pin the output to stable builtin rendering
    # regardless of user diff config.
    git diff --no-ext-diff --no-color HEAD --
    printf '%s\n' '== untracked =='
    emit_untracked_manifest
  } | sha256_stream
}

# Load the store as a JSON object, self-healing: a missing or corrupt store
# resets to '{}' (worst case we re-run a gate; never fail the caller on it).
load_store() {
  local store="$1" current
  if [ -f "$store" ] \
    && current=$(jq -ce 'if type == "object" then . else error("not an object") end' "$store" 2>/dev/null); then
    printf '%s' "$current"
  else
    printf '{}'
  fi
}

cmd_fingerprint() {
  compute_fingerprint
}

cmd_record() {
  local gate="$1" result="$2" fp="$3" current store tmp
  assert_gate_name "$gate"
  case "$result" in
    pass | fail) ;;
    *) die "result must be 'pass' or 'fail', got '$result'" ;;
  esac
  [[ "$fp" =~ ^[0-9a-f]{64}$ ]] || die "fingerprint must be a sha256 hex string (capture it via 'fingerprint' before running the gate)"

  # Bind the record to the tree the gate actually tested: if the worktree
  # changed while the gate ran, the outcome does not describe the current
  # tree and caching it would let `check` skip validating untested changes.
  current=$(compute_fingerprint)
  [ "$current" = "$fp" ] \
    || die "worktree changed while the gate ran (fingerprint $fp -> $current); re-run the gate on the current tree"

  store=$(resolve_store_path)
  # Write via temp file + rename so a crash cannot leave a torn store.
  tmp=$(mktemp "${store}.tmp.XXXXXX")
  load_store "$store" \
    | jq --arg gate "$gate" --arg fp "$fp" --arg result "$result" \
      '.[$gate] = {fingerprint: $fp, result: $result, recorded_at: (now | floor)}' \
      >"$tmp"
  mv -f "$tmp" "$store"
}

cmd_check() {
  local gate="$1" fp store cached
  assert_gate_name "$gate"

  store=$(resolve_store_path)
  fp=$(compute_fingerprint)
  cached=$(load_store "$store" \
    | jq -r --arg gate "$gate" --arg fp "$fp" \
      '.[$gate] // empty | select(.fingerprint == $fp) | .result // empty')
  case "$cached" in
    pass | fail)
      printf '%s\n' "$cached"
      ;;
    '')
      echo "no fresh record for gate '$gate' (stale or never recorded); re-run the gate" >&2
      exit 1
      ;;
    *)
      # A record whose result is neither pass nor fail is corrupt: treat as
      # stale rather than propagating garbage to the caller.
      echo "corrupt record for gate '$gate'; re-run the gate" >&2
      exit 1
      ;;
  esac
}

command -v jq >/dev/null 2>&1 || die "missing required command: jq"
git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"
# `git status --porcelain` paths are toplevel-relative; run there so the
# untracked hashing works no matter where the caller invoked us from.
cd "$(git rev-parse --show-toplevel)"
git rev-parse -q --verify HEAD >/dev/null || die "repository has no HEAD commit"

[ $# -ge 1 ] || usage
SUBCOMMAND="$1"
shift

case "$SUBCOMMAND" in
  fingerprint)
    [ $# -eq 0 ] || usage
    cmd_fingerprint
    ;;
  record)
    [ $# -eq 3 ] || usage
    cmd_record "$1" "$2" "$3"
    ;;
  check)
    [ $# -eq 1 ] || usage
    cmd_check "$1"
    ;;
  *)
    usage
    ;;
esac
