# Progress of the builder (read first if you take over)

## Fix round 2 (brief 2026-11-13-fix2-d1-encoder-devnet-test-prep.md)

Start: head `e18e725`; the second reviewer's branch (`8ff23d6`) merged by fast forward and pushed.
23 of its tests fail at the start. Order of work (the brief's): F1, F6, F10, F2, F11, the runner
(F4, F5, F7, F8), F9, F3 with G1 and G4, F12 and G2, the words, G3 last in its own commit.

### Done, by rule id

- merge of the second reviewer's branch.

### Next

- F1: research-signed.mjs (the plan's bytes of a research signer step), send-file and step use it.

### Decisions (fix round 2) and why

(none yet)

## Fix round 1


Branch `claude/encoder-devnet-test-prep`. First round from main `6d7ad0e`, head `fcfb8b5`.
Fix round brief: `/mnt/user-data/outputs/briefs/2026-11-13-fix-d1-encoder-devnet-test-prep.md`.
The reviewer's branch (`2e6b0e5`) is merged (fast forward). 17 reviewer tests fail at the start.

Order of work (the brief's): P1, S1 to S7, X1 to X9, E1 to E3, R1 to R4, C1 to C7, P2 to P8, W.
Run tests: `setpriv --inh-caps=-dac_override,-dac_read_search --bounding-set=-dac_override,-dac_read_search node --test`
in this folder. `imd-flop/dist` must be built.

## Done (fix round), by rule id

- merge of the reviewer's branch.
- lead-measurements-2026-11-13.json.
- P1: lib.mjs channelId (blake2b of imd-flop's @noble/hashes), ss58 and fromSs58 (prefix 42);
  CH_T3, CH_T5 computed in steps.json; T4, T6, T7 and the events use them; plan.test.mjs derives
  the rerun's A6 channel id. plan.md's printed blocks have markers; `node plan.mjs md` rewrites them.
- S1 to S7: device-key.mjs (S6), record.mjs (one reader of both kinds of record), judge.mjs nextOf
  (S2c), sign-device.mjs rewritten (--run, S2 a to g in order, send file, --again, attempts),
  steps.json T6 after_block greatest_of (S7), template record "run-time" with run_time per step.
  fixtures.mjs builds run time records for tests. sign-device.test.mjs rewritten (22 tests).
  Reviewer tests adapted: review-sign-device.test.mjs (all 7, to --run and --reads-sha256),
  review-plan.test.mjs "T4 can be signed from the run time record" (to --run).
  Known failing until C: check.test.mjs and review-check.test.mjs (old CH ids, record kind).

- X1 to X9: pane-runner.js rewritten (status table, lost connection, constants, mark at write,
  sendSame, find, short results with events sha256, relay text and sha256, accountReads).
  pane-runner.test.mjs rewritten (20 tests). The reviewer's runner tests pass unchanged: a
  transport that does not report the write is taken to have written once it answers.

- E1 to E3: explorer-reader.js and explorer-reader.test.mjs (4 tests). The relay object also
  carries source and read_utc (R3 needs them and only the pane knows read_utc).

- R1 to R3: record-step.mjs start and step, record-step.test.mjs (10 tests). steps.json gets a
  "channel" per encoder step. judge.mjs holdsBy: after a stop, a step never sent does not hold.
  Decided: record-step refuses to record a runner outcome that submitted nothing (refused-bundle,
  already-sent, not-in-sent-list, not-sent). A find result has no bundle sha256, so record-step
  checks the extrinsic's sha256 (extrinsic_sha256, given by every runner result) against the
  signed file's extrinsic. A channelId that is not the derived one is refused, not recorded.

- R4: plan.mjs next --run (only the next lines, every value filled), commandsOf/commandsText on
  the new interface (the reader's list), record-step.mjs send-file (a short send file for the
  research signer's steps too, so no multi line JSON is typed into the pane). The session nonce
  key is made by lib.mjs sessionNonceKey from the research signer's twox128 table (steps.json
  TWOX_*, read from flop-sign.mjs text), tested equal to flop-sign.mjs keys. plan-next.test.mjs.
  Known failing until P6: plan.test.mjs "R12: the README says ..." (README lines are old).

- C1 to C7: judge.mjs rewritten (record kinds, recordProblems for order and repeats, channel ids,
  attempts judged by their recorded error, C5 findings, C6 top up left, verdicts with
  balances_source), check.mjs (run time exits 3), check.test.mjs (+8 tests), review-check adapted
  (final record, balances_source, derived channel ids, T6 after T3 + ACK_WINDOW, T6.2 with its own
  extrinsic hash). Decided: a cleanup step whose last attempt is refused stops the batch there
  (verdict "stopped at T6, left: ..."); the C6 case is "passed as planned, left: ..." and exits 1.
  nextOf stops everything (step null) when recordProblems finds any.

- P2, P3, P4, P5, P7: steps.json send_outcomes (16 rows), stop_table (45 cells of table F and the
  lapsed session), plan.mjs outcomes, caps, stops, sha256s; plan.md rewritten with every printed
  block between markers; left_if_it_fails words of T6 to T9 name the attempts of S5. plan.mjs
  cleanupAfterStop removed: nextOf does that now (its test moved to nextOf). Tests in plan.test.mjs.
  "Binds" is the cap with the least room left after the step.

- P6, P8: README rewritten; tests in plan.test.mjs.
- Mutants: mutants.json (82: the reviewer's 18 adapted, 64 of the fix round), mutants.mjs. Run
  under setpriv: 78 killed, 4 equivalent (R-M17, B-S2d, B-S6b, B-R2i), none alive. The pasted
  files' mutants were run again without the two sha256 binding tests counting: all 22 killed.

- Full check under setpriv: this folder 149 of 149 pass, the rerun's folder 41 of 41.
- W: .github/workflows/research-offline.yml is the next and last commit, alone. It runs on pull
  requests and on pushes to main that touch its paths, so it does not run on a push to this
  branch: its first run is when the lead opens the pull request. Only two research folders hold
  tests; both are listed.

## Next

- After the W commit: read the GitHub checks of it and report. No more commits after W.

## Decisions (fix round) and why

- Run folder layout: `<run>/results.json`, `<run>/signed/<id>.json`, `<id>.send.json`,
  `<id>.dead-<n>.json`, `<id>.dead-<n>.send.json`.
- The run time record keeps each step's reading under `steps[i].run_time`: `sent` (the runner's
  relay text, parsed), `sent_sha256`, `explorer` (record form, with source and read_utc),
  `earlier_readings` (non final readings it replaced), `earlier_copies` (from the signed file).
- An attempt (S5) is its own entry in `steps` with `step: "T6.2"`.
- The key loader is shared by sign-device.mjs and record-step.mjs in `device-key.mjs`.
- S2c and S4 read together: when the record holds a reading of the id that is not in a finalized
  block, nextOf says "wait" with waiting "inclusion" and step that id. sign-device then signs it
  only with --again (S4), never without. Otherwise S4 could never follow a recorded deadline.
  This is the builder's reading; it is in the report for the lead to confirm.
- The runner's transport gets an `onWrite` hook (X4) and an `onLost` hook (X2). Reviewer tests
  that script a transport are adapted to call the hook; the change is listed.
