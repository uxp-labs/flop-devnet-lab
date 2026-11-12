# The step runner, the signal handling and finalize of scripts/check.sh, sourced by it (and by
# scripts/check-canary.mjs, through a small driver of its own).
#
# Before sourcing, the caller sets: evidence (the evidence folder, with outputs/ in it),
# source_sha, git_branch, dirty, runner, run_id and started_utc. Nothing else is read.
# The caller then runs its steps with `step <name> <command...>` and ends with `finish`.
#
# A run is a pass only when it reached `finish`. report.txt says so in its `finished:` line:
#   finished: yes
#   finished: no (stopped during step <name> by <SIGNAL>)
#   finished: no (stopped after step <name> by <SIGNAL>)       a signal between two steps
#   finished: no (the script ended before its last step, after step <name>)
# A run that did not finish never reports an exit of 0 and never gets an outputs digest.
# A step that is itself stopped by a signal, while the script is not, is a failed step in a
# finished run: its exit is 128 plus the signal, the run goes on and ends with overall_exit 1 and
# finished: yes.
# Not covered: SIGKILL cannot be handled. Then no report.txt is written, which is no pass, and the
# running step may be left running, because each step runs in a process group of its own.
#
# Each step runs in a process group of its own (job control is on only while it starts), and the
# script waits for it with `wait`, which a trapped signal interrupts at once. On SIGINT, SIGTERM or
# SIGHUP the script stops the step's whole group, writes the step to steps.tsv as cut, finalizes
# and exits with 128 plus the signal's number.

overall=0
check_finished=no
check_end=""
check_last_step=none
check_step_name=""
check_step_cmd=""
check_step_pid=""

check_signal_group() {
  # check_signal_group <signal> <group id>: signal every process in the group.
  kill "-$1" -- "-$2" 2>/dev/null
}

check_stop_tree() {
  # check_stop_tree <group id>: TERM the step's group, KILL what is left after 3 seconds, reap.
  local group="$1" waited=0
  check_signal_group TERM "$group"
  while check_signal_group 0 "$group" && [ "$waited" -lt 30 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  check_signal_group KILL "$group"
  wait "$group" 2>/dev/null
  return 0
}

step() {
  # step <name> <command...>: run, log, record the exit code, keep going.
  local name="$1"
  shift
  local code
  check_step_name="$name"
  check_step_cmd="$*"
  set -m
  "$@" >"$evidence/$name.log" 2>&1 </dev/null &
  check_step_pid=$!
  set +m
  wait "$check_step_pid"
  code=$?
  printf '%s\t%s\t%s\n' "$name" "$*" "$code" >>"$evidence/steps.tsv"
  check_step_name=""
  check_step_pid=""
  check_last_step="$name"
  if [ "$code" -ne 0 ]; then overall=1; fi
  printf '%-14s exit %s\n' "$name" "$code"
  return 0
}

check_cut() {
  # check_cut <signal name without SIG>: the trap for SIGINT, SIGTERM and SIGHUP.
  local sig="$1" job
  trap '' INT TERM HUP
  # A signal can land between the line that starts a step and the line that records its process
  # id, so every job of the script still running is stopped, each as the process group it was
  # started in, whether or not a step is recorded as running; check_step_pid is only for wait.
  for job in $(jobs -pr); do check_stop_tree "$job"; done
  if [ -n "$check_step_name" ]; then
    printf '%s\t%s\t%s\n' "$check_step_name" "$check_step_cmd" "cut by SIG$sig" >>"$evidence/steps.tsv"
    printf '%-14s cut by SIG%s\n' "$check_step_name" "$sig"
    check_end="stopped during step $check_step_name by SIG$sig"
  else
    check_end="stopped after step $check_last_step by SIG$sig"
  fi
  overall=$((128 + $(kill -l "$sig")))
  exit "$overall"
}

finish() {
  # The last line of the check: the only way a run counts as finished.
  check_finished=yes
  exit "$overall"
}

check_on_exit() {
  local status=$?
  trap '' INT TERM HUP
  if [ "$check_finished" != yes ] && [ -z "$check_end" ]; then
    # An exit before the last step, whatever its status, is never a pass.
    if [ "$status" -eq 0 ]; then status=1; fi
    overall="$status"
    check_end="the script ended before its last step, after step $check_last_step"
  fi
  finalize
  exit "$overall"
}

check_outputs_digest() {
  # One digest over every output file, the same command a rerun uses to compare outputs/.
  # No file at all gives none, never the hash of empty input.
  local files
  files="$(cd "$evidence/outputs" 2>/dev/null && find . -type f | LC_ALL=C sort)"
  if [ -z "$files" ]; then
    echo none
    return 0
  fi
  (cd "$evidence/outputs" && printf '%s\n' "$files" | xargs -r sha256sum | sha256sum | cut -d' ' -f1)
}

finalize() {
  local ended node_v finished_line digest_line printed_digest
  ended="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  node_v="$(node -v 2>/dev/null || echo missing)"
  if [ "$check_finished" = yes ]; then
    local digest
    digest="$(check_outputs_digest)"
    finished_line="finished: yes"
    digest_line="$digest (node $node_v; it holds for this Node version only)"
    printed_digest="$digest (node $node_v)"
  else
    finished_line="finished: no ($check_end)"
    digest_line="none (the run did not finish)"
    printed_digest="$digest_line"
  fi
  {
    echo "source_sha: $source_sha"
    echo "git_branch: $git_branch"
    echo "dirty: $dirty"
    echo "runner: $runner"
    echo "invoked: ${npm_lifecycle_event:+npm run }${npm_lifecycle_event:-bash ./scripts/check.sh}"
    echo "node: $node_v"
    echo "npm: $(npm -v 2>/dev/null || echo missing)"
    echo "tsc: $(npx --no-install tsc --version 2>/dev/null || echo missing)"
    echo "vitest: $(npx --no-install vitest --version 2>/dev/null || echo missing)"
    echo "python: $(python3 --version 2>/dev/null || echo missing)"
    echo "os: $(uname -srm)"
    echo "started_utc: $started_utc"
    echo "ended_utc: $ended"
    echo "evidence_dir: check-runs/$source_sha/$run_id"
    echo "overall_exit: $overall"
    echo "$finished_line"
    echo "outputs_digest: $digest_line"
    for pin in "$evidence"/outputs/*/pin.json; do
      [ -f "$pin" ] || continue
      echo
      echo "chain point for outputs/$(basename "$(dirname "$pin")") (from fixtures in M0, not from a live chain):"
      cat "$pin"
    done
    echo
    echo "steps:"
    if [ -f "$evidence/steps.tsv" ]; then cat "$evidence/steps.tsv"; fi
    echo
    echo "checksum_note: SHA256SUMS hashes every other file in this directory. A match shows the bytes were not changed after the sums were written. It does not prove the commands ran, that the logs are complete, or that an exit of 0 means the tests passed truthfully. Rerun on the same revision in a fresh clone and compare outputs/."
  } >"$evidence/report.txt"
  # The sums are computed before the file exists, so the sums file never lists itself. No temp
  # file, so a sandbox without mktemp still gets its sums.
  local sums
  sums="$(cd "$evidence" && find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum)"
  printf '%s\n' "$sums" >"$evidence/SHA256SUMS"
  chmod 644 "$evidence/SHA256SUMS"
  if [ "$check_finished" = yes ]; then
    echo "evidence: check-runs/$source_sha/$run_id (overall exit $overall)"
  else
    echo "evidence: check-runs/$source_sha/$run_id (NOT FINISHED: $check_end, exit $overall)"
  fi
  echo "outputs digest: $printed_digest"
}

trap check_on_exit EXIT
trap 'check_cut INT' INT
trap 'check_cut TERM' TERM
trap 'check_cut HUP' HUP
