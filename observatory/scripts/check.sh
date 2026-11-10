#!/usr/bin/env bash
# The one check command for FLOP Observatory:   npm run check   (from observatory/)
#
# Offline by design: tests reject fetch and WebSocket, and nothing signs, spends or writes.
# The only network use is `npm ci`, which installs the pinned dev tools from the lockfile.
#
# Every run writes a new evidence directory and leaves earlier runs in place:
#   check-runs/<source-sha>/<timestamp>-<runner>-<random>/
#     report.txt          pin (revision, branch, dirty tree, tool versions), command, steps, exits
#     steps.tsv           one line per step: name, command, exit code
#     *.log               full output of each step
#     vitest.json         machine-readable test results
#     attempts.jsonl      any network, write, sign or spend attempt left by a test (should be absent)
#     mutants.json        each injected bug, the test that must catch it, and the outcome
#     recount.json        TypeScript census against the independent Python recount, per fixture
#     outputs/            one snapshot rendered as feeds, page and an MCP transcript
#     consistency.json    page, feeds and MCP compared field by field
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
overall=0

step() {
  # step <name> <command...>: run, log, record the exit code, keep going.
  local name="$1"
  shift
  local code
  "$@" >"$evidence/$name.log" 2>&1
  code=$?
  printf '%s\t%s\t%s\n' "$name" "$*" "$code" >>"$evidence/steps.tsv"
  if [ "$code" -ne 0 ]; then overall=1; fi
  printf '%-14s exit %s\n' "$name" "$code"
  return 0
}

finalize() {
  local ended
  ended="$(utc)"
  {
    echo "source_sha: $source_sha"
    echo "git_branch: $git_branch"
    echo "dirty: $dirty"
    echo "runner: $runner"
    echo "invoked: ${npm_lifecycle_event:+npm run }${npm_lifecycle_event:-bash ./scripts/check.sh}"
    echo "node: $(node -v 2>/dev/null || echo missing)"
    echo "npm: $(npm -v 2>/dev/null || echo missing)"
    echo "tsc: $(npx --no-install tsc --version 2>/dev/null || echo missing)"
    echo "vitest: $(npx --no-install vitest --version 2>/dev/null || echo missing)"
    echo "python: $(python3 --version 2>/dev/null || echo missing)"
    echo "os: $(uname -srm)"
    echo "started_utc: $started_utc"
    echo "ended_utc: $ended"
    echo "evidence_dir: check-runs/$source_sha/$run_id"
    echo "overall_exit: $overall"
    if [ -f "$evidence/outputs/pin.json" ]; then
      echo
      echo "chain point described by outputs/ (from fixtures in M0, not from a live chain):"
      cat "$evidence/outputs/pin.json"
    fi
    echo
    echo "steps:"
    cat "$evidence/steps.tsv"
    echo
    echo "checksum_note: SHA256SUMS hashes every other file in this directory. A match shows the bytes were not changed after the sums were written. It does not prove the commands ran, that the logs are complete, or that an exit of 0 means the tests passed truthfully. Rerun on the same revision in a fresh clone and compare outputs/."
  } >"$evidence/report.txt"
  (
    cd "$evidence" || exit 1
    find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum
  ) >"$evidence/SHA256SUMS.tmp"
  mv "$evidence/SHA256SUMS.tmp" "$evidence/SHA256SUMS"
  echo "evidence: check-runs/$source_sha/$run_id (overall exit $overall)"
}
trap finalize EXIT

# 1. Clean install from the lockfile, then a clean build.
step install npm ci --no-audit --no-fund
rm -rf dist
step typecheck npx --no-install tsc -p tsconfig.json --noEmit
step build npx --no-install tsc -p tsconfig.json

# 2. Unit, boundary and consistency tests. Any network, write, sign or spend attempt left in the
#    log fails the test file and is copied to attempts.jsonl.
step test env OBS_ATTEMPTS_FILE="$evidence/attempts.jsonl" npx --no-install vitest run \
  --reporter=default --reporter=json --outputFile.json="$evidence/vitest.json"

# 3. The harness itself: a test that leaves a fetch attempt in the log must fail.
step canary node scripts/canary.mjs

# 4. Injected bugs: every mutant must make its named test fail, and every named test must pass clean.
step mutants sh -c "node scripts/mutate.mjs > '$evidence/mutants.json'"

# 5. Independent recount: the Python recount's own tests, then TypeScript against Python per fixture.
step recount-tests python3 -I tools/test_recount.py
step recount sh -c "node scripts/compare-recount.mjs > '$evidence/recount.json'"

# 6. One snapshot through every output: feeds, page, snapshot log, and an MCP transcript.
step snapshot node dist/cli.js snapshot \
  --status fixtures/status-healthy \
  --escrows fixtures/escrows-verification \
  --census fixtures/census-complete \
  --drift fixtures/drift-seeded \
  --out "$evidence/outputs" \
  --log "$evidence/outputs/snapshots.jsonl" \
  --source-sha "$source_sha"
step mcp sh -c "node scripts/mcp-transcript.mjs '$evidence/outputs' > '$evidence/outputs/mcp-transcript.jsonl'"
step consistency sh -c "node scripts/consistency.mjs '$evidence/outputs' > '$evidence/consistency.json'"

exit "$overall"
