#!/usr/bin/env bash
# Shared offline check. Local shells and GitHub Actions both run:
#   npm run check
# from the imd-flop directory (this script).
#
# A clean install, a clean build, then the existing offline test script.
# npm test loads test/setup.ts, which rejects fetch and WebSocket.
#
# Each run writes a new directory:
#   check-runs/<source-sha>/<timestamp>-<runner>-<id>/
# Earlier runs are left in place.
#
# SHA256SUMS hashes the other files in that directory. A match means those
# bytes were unchanged after the sums were written. It does not prove the
# commands ran, that the logs are complete, or that exit 0 means the tests
# passed truthfully.

set -u

pkg="$(cd "$(dirname "$0")/.." && pwd)"
cd "$pkg" || exit 1

evidence=""
overall=0
finalized=0

utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

finalize() {
  [ "$finalized" -eq 1 ] && return 0
  finalized=1
  [ -n "$evidence" ] && [ -d "$evidence" ] || return 0

  local ended
  ended="$(utc)"
  cat >"$evidence/report.txt" <<EOF
source_sha: ${source_sha}
git_branch: ${git_branch}
dirty: ${dirty}
runner: ${runner}
github_event: ${github_event}
github_ref: ${github_ref}
node: ${node_version}
npm: ${npm_version}
invoked: ${invoked}
started_utc: ${started_utc}
ended_utc: ${ended}
evidence_dir: check-runs/${source_sha}/${run_id}
overall_exit: ${overall}

steps:
EOF
  if [ -f "$evidence/steps.tsv" ]; then
    while IFS=$'\t' read -r name display code; do
      [ -n "$name" ] || continue
      printf '%s\t%s\texit %s\tlog %s.log\n' "$name" "$display" "$code" "$name" >>"$evidence/report.txt"
    done <"$evidence/steps.tsv"
  fi
  {
    printf '\ndirty_tree:\n'
    cat "$evidence/dirty.txt"
    printf '\nchecksum_note: SHA256SUMS hashes every other file in this directory. A successful `sha256sum -c SHA256SUMS` shows those bytes were not changed after the sums were written. It does not prove the commands ran, that the logs are complete, or that an exit of 0 means the tests passed truthfully.\n'
  } >>"$evidence/report.txt"

  local tmp
  tmp="$(mktemp)"
  (
    cd "$evidence" || exit 1
    find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum
  ) >"$tmp"
  mv "$tmp" "$evidence/SHA256SUMS"
  return 0
}
trap finalize EXIT

dirty_tmp="$(mktemp)"
if git -C "$pkg" rev-parse --show-toplevel >/dev/null 2>&1; then
  repo="$(git -C "$pkg" rev-parse --show-toplevel)"
  source_sha="$(git -C "$repo" rev-parse HEAD)"
  git_branch="$(git -C "$repo" rev-parse --abbrev-ref HEAD)"
  git -C "$repo" status --porcelain=v1 >"$dirty_tmp"
else
  repo=""
  source_sha="unknown"
  git_branch="unknown"
  printf 'git status unavailable\n' >"$dirty_tmp"
fi

case "$source_sha" in
  *[!0-9a-fA-F]* | "") source_sha="unknown" ;;
esac

if [ ! -s "$dirty_tmp" ]; then
  dirty="no"
  printf 'clean\n' >"$dirty_tmp"
else
  dirty="yes"
fi

if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  runner="github-actions"
  run_kind="gha-${GITHUB_RUN_ID:-0}-${GITHUB_RUN_ATTEMPT:-0}"
else
  runner="local"
  run_kind="local-$$"
fi
github_event="${GITHUB_EVENT_NAME:-}"
github_ref="${GITHUB_REF:-}"
if [ "${npm_lifecycle_event:-}" = "check" ]; then
  invoked="npm run check"
else
  invoked="bash ./scripts/offline-check.sh"
fi

node_version="$(node -v 2>/dev/null || echo missing)"
npm_version="$(npm -v 2>/dev/null || echo missing)"
started_utc="$(utc)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
rand="$(od -An -N3 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
[ -n "$rand" ] || rand="norand"
run_id="${stamp}-${run_kind}-${rand}"

evidence="$pkg/check-runs/${source_sha}/${run_id}"
mkdir -p "$evidence" || exit 1
mv "$dirty_tmp" "$evidence/dirty.txt"
printf '%s\n' "$source_sha" >"$evidence/source-sha.txt"

run_step() {
  local name="$1"
  local display="$2"
  shift 2
  local log="$evidence/${name}.log"
  local code=0
  {
    printf 'COMMAND: %s\n' "$display"
    printf 'STARTED_UTC: %s\n' "$(utc)"
  } >"$log"
  "$@" 2>&1 | tee -a "$log"
  code="${PIPESTATUS[0]}"
  {
    printf 'EXIT: %s\n' "$code"
    printf 'ENDED_UTC: %s\n' "$(utc)"
  } >>"$log"
  printf '%s\t%s\t%s\n' "$name" "$display" "$code" >>"$evidence/steps.tsv"
  if [ "$code" -ne 0 ] && [ "$overall" -eq 0 ]; then
    overall="$code"
  fi
}

skip_step() {
  local name="$1"
  local display="$2"
  {
    printf 'COMMAND: %s\n' "$display"
    printf 'EXIT: skipped\n'
    printf 'REASON: an earlier step failed\n'
  } >"$evidence/${name}.log"
  printf '%s\t%s\tskipped\n' "$name" "$display" >>"$evidence/steps.tsv"
}

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  {
    printf 'COMMAND: node and npm on PATH\n'
    printf 'EXIT: 127\n'
  } >"$evidence/00-toolchain.log"
  printf '00-toolchain\tnode and npm on PATH\t127\n' >>"$evidence/steps.tsv"
  overall=127
  skip_step "01-npm-ci" "npm ci --engine-strict"
  skip_step "02-clean-build" "rm -rf dist && npm run build"
  skip_step "03-npm-test" "npm test"
  exit 127
fi

run_step "01-npm-ci" "npm ci --engine-strict" npm ci --engine-strict
if [ "$overall" -eq 0 ]; then
  run_step "02-clean-build" "rm -rf dist && npm run build" bash -c 'rm -rf dist && npm run build'
else
  skip_step "02-clean-build" "rm -rf dist && npm run build"
fi
if [ "$overall" -eq 0 ]; then
  run_step "03-npm-test" "npm test" npm test
else
  skip_step "03-npm-test" "npm test"
fi

exit "$overall"
