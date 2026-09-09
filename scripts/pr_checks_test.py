"""Offline PR check-discovery regressions: python3 scripts/pr_checks_test.py."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
HEAD = "1" * 40
MERGE = "2" * 40


def check(name="Required", conclusion="SUCCESS", suite=1, status="COMPLETED"):
    return {
        "__typename": "CheckRun",
        "id": f"check-{suite}",
        "name": name,
        "status": status,
        "conclusion": conclusion,
        "detailsUrl": f"https://github.com/fixture/repo/actions/runs/{suite}/job/{suite}",
        "checkSuite": {"id": f"suite-{suite}", "workflowRun": {"workflow": {"name": "PR"}}},
    }


def pixel():
    return {
        "__typename": "StatusContext",
        "id": "pixel",
        "context": "Pixel / Review",
        "state": "PENDING",
        "targetUrl": "https://pixel.coder.com/builds/1",
        "description": "Awaiting visual review",
    }


def page(oid, nodes=None, more=False):
    rollup = None if nodes is None else {
        "contexts": {
            "nodes": nodes,
            "pageInfo": {"hasNextPage": more, "endCursor": "next" if more else None},
        }
    }
    return {"data": {"repository": {"object": {"oid": oid, "statusCheckRollup": rollup}}}}


def fixture(nodes=None, merge_state="CLEAN"):
    return {
        "pr": {"state": "OPEN", "mergeable": "MERGEABLE", "mergeStateStatus": merge_state, "reviewDecision": "", "headRefOid": HEAD},
        "refs": {"headRefOid": HEAD, "potentialMergeCommit": {"oid": MERGE}},
        "pages": {HEAD: [page(HEAD, nodes)], MERGE: [page(MERGE)]},
    }


class PrChecksTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="pr-checks-test-")
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        gh = self.directory / "gh"
        # Strict protocol double: no path falls through to the real gh/network.
        # Paginated fixtures model GitHub's current rollup, not historical attempts.
        gh.write_text("""#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
fixture = json.loads(pathlib.Path(os.environ['PR_CHECK_FIXTURE']).read_text())
with open(os.environ['PR_CHECK_CALLS'], 'a') as calls:
    calls.write(json.dumps(args) + '\\n')
if args[:2] == ['pr', 'view']:
    print(json.dumps(fixture['pr']))
elif args[:2] == ['api', 'graphql']:
    query = next(arg[6:] for arg in args if arg.startswith('query='))
    if 'potentialMergeCommit' in query:
        calls = [json.loads(line) for line in pathlib.Path(os.environ['PR_CHECK_CALLS']).read_text().splitlines()]
        recheck = sum(any(arg.startswith('query=') and 'potentialMergeCommit' in arg for arg in call) for call in calls) > 1
        if recheck and fixture.get('fail_recheck'):
            sys.exit(1)
        refs = fixture.get('refs_after', fixture['refs']) if recheck else fixture['refs']
        state = dict(fixture['pr'], **refs) if refs is not None else None
        print(json.dumps({'data': {'repository': {'pullRequest': state}}}))
    elif 'statusCheckRollup' in query:
        assert '--paginate' in args and '--slurp' in args, args
        assert '$endCursor' in query and 'after: $endCursor' in query, query
        oid = next(arg[4:] for arg in args if arg.startswith('oid='))
        print(json.dumps(fixture['pages'][oid]))
        if fixture.get('fail_ref') == oid:
            print('API page request failed', file=sys.stderr)
            sys.exit(1)
    elif 'reviewThreads' in query:
        print(json.dumps({'data': {'repository': {'pullRequest': {'reviewThreads': {
            'nodes': [], 'pageInfo': {'hasNextPage': False, 'endCursor': None}
        }}}}}))
    else:
        raise AssertionError(query)
elif args[:2] == ['run', 'view']:
    assert args[2] == '2', args
    for job in fixture['jobs']:
        print(json.dumps(job))
elif args[0] == 'api' and args[1].endswith('/logs'):
    print('downloaded job ' + args[1].split('/')[-2])
else:
    raise AssertionError(args)
""")
        gh.chmod(0o755)

    def run_script(self, data, script="wait_pr_checks.sh"):
        path = self.directory / "fixture.json"
        path.write_text(json.dumps(data))
        calls = self.directory / "calls.jsonl"
        calls.write_text("")
        env = {
            key: value for key, value in os.environ.items()
            if not key.startswith(("MUX_", "GH_", "GITHUB_"))
        }
        env.update({
            "PATH": str(self.directory) + os.pathsep + os.environ["PATH"],
            "PR_CHECK_FIXTURE": str(path),
            "PR_CHECK_CALLS": str(calls),
            "MUX_SKIP_FETCH_SYNC": "1",
            "MUX_GH_OWNER": "fixture",
            "MUX_GH_REPO": "repo",
        })
        args = ["bash", str(SCRIPTS / script), "4194"]
        if script == "wait_pr_checks.sh":
            args.append("--once")
        result = subprocess.run(args, env=env, text=True, capture_output=True, timeout=15, check=False)
        self.calls = [json.loads(line) for line in calls.read_text().splitlines()]
        return result

    def assert_gate(self, expected, data):
        result = self.run_script(data)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def test_independent_same_name_failure_is_not_hidden_by_success_or_pixel(self):
        failed = check(conclusion="FAILURE", suite=2)
        result = self.assert_gate(1, fixture([check(), failed, pixel()], "BLOCKED"))
        self.assertIn(failed["detailsUrl"], result.stdout)
        self.assertNotIn(check()["detailsUrl"], result.stdout)

    def test_later_page_failure_is_reported(self):
        data = fixture()
        failed = check(conclusion="FAILURE", suite=2)
        data["pages"][HEAD] = [page(HEAD, [check()], more=True), page(HEAD, [failed])]
        result = self.assert_gate(1, data)
        self.assertIn(failed["detailsUrl"], result.stdout)

    def test_merge_ref_failure_is_reported_with_commit_identity(self):
        data = fixture([check()])
        failed = check(conclusion="FAILURE", suite=2)
        data["pages"][MERGE] = [page(MERGE, [failed])]
        result = self.assert_gate(1, data)
        self.assertIn(failed["detailsUrl"], result.stdout)
        self.assertIn(MERGE, result.stdout)

    def test_current_success_with_no_merge_checks_passes(self):
        self.assert_gate(0, fixture([check(suite=2)]))

    def test_multiple_successful_pages_pass(self):
        data = fixture()
        data["pages"][HEAD] = [page(HEAD, [check()], more=True), page(HEAD, [check(suite=2)])]
        self.assert_gate(0, data)

    def test_no_merge_ref_still_checks_head(self):
        data = fixture([check()])
        data["refs"]["potentialMergeCommit"] = None
        self.assert_gate(0, data)
        self.assertFalse(any(f"oid={MERGE}" in args for args in self.calls))

    def test_ref_or_state_change_during_discovery_returns_pending(self):
        for changed in (
            {"headRefOid": "3" * 40},
            {"potentialMergeCommit": {"oid": "3" * 40}},
            {"mergeStateStatus": "BLOCKED"},
        ):
            with self.subTest(changed=changed):
                data = fixture([check()])
                data["refs_after"] = dict(data["refs"], **changed)
                result = self.assert_gate(10, data)
                self.assertNotIn(check()["detailsUrl"], result.stdout)

    def test_head_change_between_status_and_discovery_returns_pending(self):
        data = fixture([check()])
        data["refs"]["headRefOid"] = "3" * 40
        self.assert_gate(10, data)
        self.assertFalse(any(any(arg.startswith("oid=") for arg in args) for args in self.calls))

    def test_failed_final_snapshot_read_cannot_accept_passing_checks(self):
        data = fixture([check()])
        data["fail_recheck"] = True
        self.assert_gate(1, data)

    def test_blocked_is_not_explained_by_pixel_alone(self):
        self.assert_gate(10, fixture([check(), pixel()], "BLOCKED"))

    def test_unstable_from_optional_pixel_can_pass(self):
        self.assert_gate(0, fixture([check(), pixel()], "UNSTABLE"))

    def test_empty_skipped_and_pixel_only_are_pending(self):
        for nodes in (None, [], [check(conclusion="SKIPPED")], [pixel()]):
            with self.subTest(nodes=nodes):
                self.assert_gate(10, fixture(nodes))

    def test_pending_or_unknown_state_cannot_be_hidden_by_success(self):
        for status in ("QUEUED", "IN_PROGRESS", "WAITING", "FUTURE_STATUS"):
            with self.subTest(status=status):
                self.assert_gate(10, fixture([check(), check(suite=2, status=status)]))

    def test_failure_conclusions_remain_blocking(self):
        for conclusion in ("FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"):
            with self.subTest(conclusion=conclusion):
                self.assert_gate(1, fixture([check(), check(suite=2, conclusion=conclusion)]))

    def test_api_failure_after_a_successful_page_fails_closed(self):
        data = fixture([check()])
        data["fail_ref"] = MERGE
        result = self.assert_gate(1, data)
        self.assertIn("API page request failed", result.stdout + result.stderr)

    def test_incomplete_pagination_fails_closed(self):
        data = fixture()
        data["pages"][HEAD] = [page(HEAD, [check()], more=True)]
        self.assert_gate(1, data)

    def test_missing_or_malformed_commit_data_fails_closed(self):
        for response in (
            {"data": {"repository": {"object": None}}},
            {"data": {"repository": {"object": {"oid": MERGE}}}},
            page("wrong", [check()]),
            {},
        ):
            with self.subTest(response=response):
                data = fixture([check()])
                data["pages"][MERGE] = [response]
                self.assert_gate(1, data)

    def test_legacy_status_failure_cannot_be_hidden_by_a_same_name_check(self):
        status = pixel()
        status.update(context="Required", state="ERROR", targetUrl="https://ci.example/failed")
        result = self.assert_gate(1, fixture([check(), status]))
        self.assertIn(status["targetUrl"], result.stdout)

    def test_malformed_contexts_fail_closed(self):
        for nodes in ("invalid", [{"__typename": "UnknownCheck"}]):
            with self.subTest(nodes=nodes):
                data = fixture([check()])
                data["pages"][MERGE] = [page(MERGE, nodes)]
                self.assert_gate(1, data)

    def test_missing_pr_refs_fail_closed(self):
        for refs in (None, {"headRefOid": HEAD}, {"headRefOid": HEAD, "potentialMergeCommit": {}}):
            with self.subTest(refs=refs):
                data = fixture([check()])
                data["refs"] = refs
                self.assert_gate(1, data)

    def test_log_extractor_finds_failed_suite_and_downloads_only_failed_jobs(self):
        data = fixture([check(), check(conclusion="FAILURE", suite=2), pixel()])
        data["jobs"] = [
            {"databaseId": 21, "name": "Required", "conclusion": "failure"},
            {"databaseId": 22, "name": "Lint", "conclusion": "success"},
        ]
        result = self.run_script(data, "extract_pr_logs.sh")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("downloaded job 21", result.stdout)
        self.assertNotIn("downloaded job 22", result.stdout)

    def test_log_extractor_does_not_select_a_pixel_failure(self):
        visual = pixel()
        visual["state"] = "FAILURE"
        result = self.run_script(fixture([check(), visual]), "extract_pr_logs.sh")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertFalse(any(args[:2] == ["run", "view"] for args in self.calls))


if __name__ == "__main__":
    unittest.main()
