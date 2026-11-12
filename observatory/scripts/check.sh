#!/usr/bin/env bash
# The one check command for FLOP Observatory:   npm run check   (from observatory/)
#
# Offline by design: tests block every network and child process path (fetch, WebSocket, node:http,
# https, http2, net, tls, dgram, dns, child_process, worker threads), and nothing signs, spends or
# writes. The only network use is `npm ci`, which installs the pinned dev tools from the lockfile.
#
# Every run writes a new evidence directory and leaves earlier runs in place:
#   check-runs/<source-sha>/<timestamp>-<runner>-<random>/
#     report.txt          pin (revision, branch, dirty tree, tool versions), command, steps, exits,
#                         whether the run finished, and the outputs digest, which the last line of
#                         the log prints too. A run is a pass only with `finished: yes`. A run cut
#                         by a signal says `finished: no (stopped during step <name> by SIGTERM)`,
#                         one that exited early `finished: no (the script ended before its last
#                         step, after step <name>)`; either has an overall_exit that is never 0
#                         (128 plus the signal's number when cut) and `outputs_digest: none (the
#                         run did not finish)`, and the log's last lines say NOT FINISHED
#     steps.tsv           one line per step: name, command, exit code; a step cut by a signal is
#                         written with `cut by <SIGNAL>` as its exit, and the steps after it have
#                         no line
#     *.log               full output of each step
#     vitest.json         machine-readable test results
#     test-report.json    the results read again: every file ran, nothing skipped or left as a
#                         todo, and the same rules failing doctored copies of the report
#     attempts-journal.jsonl  every attempt, reset and final check, written by test/setup.ts the
#                         moment it happened (the attempts tests provoke on purpose and clear)
#     attempts-check.json the journal checked again once vitest has exited
#     attempts.jsonl      the journal's problems, if any (should be absent)
#     source-scan.json    every src module through the syntax tree scan, after the scan has caught
#                         every known bad sample and passed every known good one
#     canary.json         throwaway tests that each leave one forbidden attempt, all caught, two of
#                         them from a timer that fires after the file's final check
#     check-canary.json   scripts/check-lib.sh on a small driver: cut by SIGTERM, SIGINT and SIGHUP,
#                         ended early, finished with an empty outputs/, a failing step or every step
#                         passing, each read as it must be, and tampered copies of the library caught
#     mutants.json        each injected bug, the test that caught it, and both controls
#     mutants-canary.json the mutation runner classifying a real bug, an equivalent change, a
#                         syntax error and a missing test correctly, copying exactly the tracked
#                         files, and reporting a copy it cannot make as setup-failed
#     recount.json        TypeScript census against the independent Python recount, per fixture
#     recount-canary.json the cross-check catching a deliberately nudged total in every scenario
#     cli-checks.json     the command line wiring for unreadable pages, pins and health rules
#     outputs/<scenario>/ one snapshot per scenario rendered as feeds, page and an MCP transcript
#     consistency-<scenario>.json  page, feeds and MCP compared with the snapshot, every cell
#     consistency-canary.json  tampered copies of the outputs, each of which must fail the comparison
#     SHA256SUMS          hashes of every other file in this directory
#
# SHA256SUMS shows the files were not changed after the sums were written. It does not prove the
# commands ran, that the logs are complete, or that an exit of 0 means the tests passed truthfully.
# For that, rerun this command on the same revision in a fresh clone and compare outputs/.

set -u

pkg="$(cd "$(dirname "$0")/.." && pwd)"
cd "$pkg" || exit 1

utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

if repo="$(git -C "$pkg" rev-parse --show-toplevel 2>/dev/null)"; then
  source_sha="$(git -C "$repo" rev-parse HEAD)"
  git_branch="$(git -C "$repo" rev-parse --abbrev-ref HEAD)"
  dirty_list="$(git -C "$repo" status --porcelain=v1)"
else
  source_sha="unknown"
  git_branch="unknown"
  dirty_list="git status unavailable"
fi
if [ -z "$dirty_list" ]; then dirty="no"; else dirty="yes"; fi

if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  runner="github-actions"
  run_kind="gha-${GITHUB_RUN_ID:-0}-${GITHUB_RUN_ATTEMPT:-0}"
else
  runner="local"
  run_kind="local-$$"
fi
rand="$(od -An -N3 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-${run_kind}-${rand:-norand}"
evidence="$pkg/check-runs/$source_sha/$run_id"
mkdir -p "$evidence/outputs"
printf '%s\n' "${dirty_list:-clean}" >"$evidence/dirty.txt"
started_utc="$(utc)"
# The step runner, the signal handling and finalize (report.txt, SHA256SUMS and the last two
# lines). From here on, a signal or an exit before `finish` is a run that did not finish.
. "$pkg/scripts/check-lib.sh"

# 1. Clean install from the lockfile, then a clean build.
step install npm ci --no-audit --no-fund
rm -rf dist
step typecheck npx --no-install tsc -p tsconfig.check.json
step build npx --no-install tsc -p tsconfig.json

# 2. Unit, boundary and consistency tests. Any network, write, sign or spend attempt left in the
#    log fails the test file. Every attempt, reset and final check also goes to the journal the
#    moment it happens, and vitest checks the journal once every file has ended.
step test env OBS_ATTEMPTS_FILE="$evidence/attempts-journal.jsonl" npx --no-install vitest run \
  --reporter=default --reporter=json --outputFile.json="$evidence/vitest.json"
test_files="$(find test -maxdepth 1 -name '*.test.ts' | wc -l | tr -d ' ')"
# The test report again: every file ran, and no test was skipped, left as a todo or shut out by
# a .only, which vitest's exit code alone would not show.
step test-report sh -c "node scripts/test-report-check.mjs '$evidence/vitest.json' --expect-files $test_files > '$evidence/test-report.json'"
# The journal again, after vitest has exited: no attempt left in a file's log, nothing at all
# after a file's final check, and every test file reached that check.
step attempts sh -c "node scripts/attempts-check.mjs '$evidence/attempts-journal.jsonl' --unexpected '$evidence/attempts.jsonl' --expect-files $test_files > '$evidence/attempts-check.json'"

# The source scan over the syntax tree: module names and identifiers after their escapes are
# decoded, imports against an allow-list. It proves itself on known bad and good samples first.
step source-scan sh -c "node scripts/source-scan.mjs > '$evidence/source-scan.json'"

# 3. The harness itself: a test that leaves any forbidden attempt in the log must fail.
step canary sh -c "node scripts/canary.mjs > '$evidence/canary.json'"
# The check itself, cut: a signal or an early exit is reported as not finished, never 0 and with
# no digest, and the cut step's whole process tree is stopped. Run on a small driver, never here.
step check-canary sh -c "node scripts/check-canary.mjs > '$evidence/check-canary.json'"

# 4. Injected bugs, in a copy of every tracked file in the repo: an unmutated control must pass,
#    then every mutant must make at least one test in its named file fail. The runner proves its
#    own classification on four throwaway mutants, and its copy on a throwaway repo.
step mutants sh -c "node scripts/mutate.mjs > '$evidence/mutants.json'"
step mutants-canary sh -c "node scripts/mutate-canary.mjs > '$evidence/mutants-canary.json'"

# 5. Independent recount: the Python recount's own tests, then TypeScript against Python per fixture.
step recount-tests python3 -I tools/test_recount.py
step recount sh -c "node scripts/compare-recount.mjs > '$evidence/recount.json'"
# The cross-check itself: with one TypeScript total nudged by one, every scenario must disagree.
step recount-canary sh -c "node scripts/compare-recount.mjs --perturb > '$evidence/recount-canary.json'"

# 6. The command line wiring end to end.
step cli-checks sh -c "node scripts/cli-checks.mjs > '$evidence/cli-checks.json'"

# 7. One real snapshot per scenario through every output: feeds, page, snapshot log and an MCP
#    transcript, each compared with its snapshot cell by cell.
scenario() {
  # scenario <name> <cli snapshot part flags...>
  local name="$1"
  shift
  local out="$evidence/outputs/$name"
  step "snapshot-$name" node dist/cli.js snapshot "$@" --out "$out" --log "$out/snapshots.jsonl" --source-sha "$source_sha"
  step "mcp-$name" sh -c "node scripts/mcp-transcript.mjs '$out' > '$out/mcp-transcript.jsonl'"
  step "consistency-$name" sh -c "node scripts/consistency.mjs '$out' > '$evidence/consistency-$name.json'"
}
scenario healthy --status fixtures/status-healthy --escrows fixtures/escrows-verification \
  --census fixtures/census-complete --drift fixtures/drift-seeded
scenario reset --status fixtures/status-reset --escrows fixtures/escrows-conflicting \
  --census fixtures/census-reset --drift fixtures/drift-all-match
scenario nothing-read --status fixtures/status-unknown --census fixtures/census-gap
scenario degraded-faucet --status fixtures/status-degraded-real --escrows fixtures/escrows-unreadable-page \
  --census fixtures/census-unfinalized --drift fixtures/drift-seeded
scenario conflict --status fixtures/status-conflict --escrows fixtures/escrows-one-event-two-escrows \
  --census fixtures/census-paginated --drift fixtures/drift-seeded
# Accounts named after properties every JavaScript object inherits (__proto__ among them), so a
# writer that assigns keys one by one would drop one from a feed and break snapshot.json's hash.
scenario odd-accounts --status fixtures/status-healthy --census fixtures/census-odd-accounts
# The upgrade watch (RULES.md 7.2): the two reads saved at the status fixture's finalized head, so
# a non null watch goes through every output, the page section, upgrade.json and get_upgrade.
scenario upgrade --status fixtures/status-healthy --upgrade fixtures/watch-authorized
# The comparison itself: tampered copies of these outputs must each fail it, and clean copies pass.
step consistency-canary sh -c "node scripts/consistency-canary.mjs '$evidence/outputs/healthy' '$evidence/outputs/reset' \
  '$evidence/outputs/nothing-read' '$evidence/outputs/degraded-faucet' '$evidence/outputs/conflict' \
  '$evidence/outputs/odd-accounts' '$evidence/outputs/upgrade' > '$evidence/consistency-canary.json'"

finish
