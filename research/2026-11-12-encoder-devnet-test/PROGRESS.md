# Progress of the builder (read first if you take over)

## Fix round 3 (brief 2026-11-13-fix3-d1-encoder-devnet-test-prep.md)

Start: head `a9442dd`, no later commits on the branch. The third reviewer's branch (`6f443b3`)
merged by fast forward and pushed. 8 of its tests failed at the start (261 tests, 253 pass).
Order of work (the brief's): H1 with H2, H3, H4; H5; H6 to H11; the words; the mutants.

### Done, by rule id

- H1, H2, H3, H4: lead-stop.mjs researchStop, takeSignerReads, findCovers; record.mjs readingsOf
  and unsentLeft (names the copy for c and d); record-step.mjs records already-sent; steps.json
  stop_table rows "nonce" for T1, T2, T8, T9. Tests in lead-stop.test.mjs (H1 to H4, 9) and
  record-step.test.mjs (H2). fixtures.mjs accountReads and signerReads.
  Reviewer tests changed (case c or d now needs the signer's reads, the interface of H1):
  review2-next Q8 DEFECT, review3-stop table of attack B (reads for every research signer row
  with a signed copy), review3-stop DEFECT V3. Own tests changed: lead-stop F3 c, F3 d, the after
  stop test; record-step R2 (already-sent left the list of nothing submitted); plan P4 (the count
  holds the nonce rows).

- H5: judge.mjs judgeFinal: a lead_stop carried over at an id not in a finalized block; a missing
  test step with it is "stopped by the lead (case x)" and the batch stops there; a missing test
  step with no stop at or before it is differs ("missing from the final record"), so failed, exit 1;
  a lead_stop at a cleanup step goes into left (as nextOf does) and the steps after it are judged;
  after c or d the copy is left in words (unsentLeft). Tests in check.test.mjs (H5, 3). The fault
  is older than the last round: the branch "not run" with no problem for a missing test step came
  in with the first build, 59f8bd5 (R7, R8), before the first review.

- H6: sign-device.mjs retireTo (the next dead-<n> names, refused when one exists) and
  loneDeadSends (a dead send file with no dead copy of its number), both in preflight before the
  key: retireTo first (with --again and a signed file), then the lone check with or without
  --again. retire uses retireTo. Test in sign-device.test.mjs (H6).

- H7: pane-runner.js: refused-bundle, not-in-sent-list and already-sent of send and sendSame, and
  refused-bundle of find, carry sent_by. Test in pane-runner.test.mjs (H7).
- H10: pane-runner.js find ends within the runner's deadline: find-deadline with from, to (the
  last block of the chunks read one after another, null for none) and head; no new chunk after it;
  a block found and not read by then is finalized-unread. OUTCOMES and steps.json send_outcomes
  hold find-deadline (P2 covers it). lead-stop findCovers counts its range. Tests in
  pane-runner.test.mjs (H10, 2).
- H11: the not-sent words after a write that threw: "the write to the socket failed". Test (H11).
- already-sent row of send_outcomes says what H2 makes of it. plan.md regenerated; the README's
  sha256 line of pane-runner.js is fe91c295...fcc1e8 (plan.mjs sha256s).
- All 279 tests of the folder pass, the reviewers' 8 among them.

- H8: research-signed.mjs callOf refuses, before the research signer runs, a device public key in
  the record that is not 0x and 64 lower case hex digits, for every step. Test (H8).
- H9: judge.mjs nextOf drops the cleanup step of a channel only when the mismatch is at the step
  that opens it: the first step of the plan that names the channel (T3 for CH_T3, T5 for CH_T5),
  derived from steps.json, not typed. steps.json T4 channel row says T6 still applies. Test in
  lead-stop.test.mjs G4 (T4 added).

- The words: README (the lead's stop: case a with no reading, the signer's reads for c and d, the
  nonce above and below, the nonce row, already-sent, what is left after c and d; find-deadline and
  sent_by; H9; H5), plan.md prose (the same, shorter), steps.json what. plan.mjs md rewrote the
  printed blocks. Test in plan.test.mjs ("the words of fix round 3"). 281 of 281 pass.

- Mutants: mutants.json 211 (159 earlier, RV3 18, B3 34). The third reviewer's four equivalent
  ones (RV3-L4, RV3-R3, RV3-R4, RV3-S2) listed with the reviewer's reasons. RV3-N2's find made
  longer (judgeFinal holds the same line now). Seven earlier finds adapted to this round's code
  (B-X4, RV2-X2, RV2-X4, B2-F3l, B2-G4a, B2-F3n, B2-F3o), each saying so. A first run of those 59
  alone, in a scratch copy of the repo, under setpriv: running.

### Next

The 59 alone, then the report below, then the full run (node mutants.mjs <temp> --jobs 6).

### Decisions (fix round 3) and why

- H1: "the block before the first send" is the record's start (finalized block of record-step
  start), as the refusals of fix round 2 already said: it is before every send of the batch.
- H1: find covers the blocks when its not-found (or find-deadline) readings of the id, current and
  earlier, join end to end from the record's start up to a not-found that read to its own head.
  Only then, and only with reads whose next nonce is above the copy's, the refusal says these tools
  go no further and names the stop table's row "nonce". nextOf is unchanged there: it keeps waiting
  on the step, so no cleanup step is named and no stop is recorded.
- H1: when the record holds such a cover, the reads are checked for every research signer stop,
  not only c and d, so the words are right after a find.
- H2: an already-sent anywhere in the readings (current or earlier) refuses c and d.
- H5: a missing needed CLEANUP step with no stop stays as before (left, exit 4): the brief's
  consequence names test steps only. Reported for the lead to confirm.


## Fix round 2 (brief 2026-11-13-fix2-d1-encoder-devnet-test-prep.md)

Start: head `e18e725`; the second reviewer's branch (`8ff23d6`) merged by fast forward and pushed.
23 of its tests fail at the start. Order of work (the brief's): F1, F6, F10, F2, F11, the runner
(F4, F5, F7, F8), F9, F3 with G1 and G4, F12 and G2, the words, G3 last in its own commit.

### Done, by rule id

- merge of the second reviewer's branch.
- F1: research-signed.mjs (expectedOf, nonceOf, envelope, checkResearchSigned); send-file checks
  before it writes, recordReading checks every reading of a research signer id; plan.mjs next uses
  nonceOf. research-signed.test.mjs (13). fixtures.mjs planSigned: a stand in with the plan's bytes
  and a made up signature (record-step.test.mjs ownerSigned and plan-next send-file test adapted).
- F6: sign-device preflight ends with runtimeFor, the plan's runtime, encodeSessionCall and the
  declared spend by readCall; record-step start runs checkStartReads before the key. Own test in
  sign-device.test.mjs; its import list test now names reader.js.

- F10: sign-device deadCopies and earlierCopies; without --again dead files refuse; with --again
  and no signed file the newest dead copy's era is checked; a lone send file refuses. Test in
  sign-device.test.mjs.

- F2: explorer-reader.js carries failed_data (the ExtrinsicFailed's dispatchError, unchanged) and
  takes the error from the last ExtrinsicFailed; record-step explorerReading needs exactly one
  outcome event among the names, success agreeing with it, and the error moduleError derives from
  failed_data; judge recordProblems refuses a run time explorer reading whose success disagrees.
  Tests: record-step.test.mjs F2; explorerRelay helper adds failed_data; plan.test.mjs R8 P4 sets
  names that agree with the success it changes.
- F9 (done early, same file as F2): redirect "error", the answer's url must be the address asked.
  explorer-reader.test.mjs fetcher gives url; new F9 test.

### Next

- F11 done (lib fromSs58 re-encodes; test in plan.test.mjs).
- F4, F5, F7, F8: pane-runner.js: own keys of STATUSES only; the deadline stays on through locate
  (finalized-unread with the status's block, also on a lost connection while locating); the
  transport asks mayWrite before a write (no write once the call ended, "call-ended") and calls
  onWrite only after a write that did not throw ("write-failed" otherwise); a deadline with nothing
  written ends as not-sent. Tests in pane-runner.test.mjs. Reviewer test changed: review2-pane
  "a socket that opens after the deadline" now expects not-sent (F7's word), still no write.
- G1: steps.json send_outcomes: refused-at-submission rows by node_code 1010, 1013, 1014, "other";
  node_codes_source says the codes are the lead's knowledge; plan.mjs outcomeRow(plan, sent) goes by
  the code. stop_table "sub" rows say what earlier steps left and name the lead's stop (T2: FUND,
  T9). Channel rows (answer "channel") for T3 to T7 are in for G4. plan.test.mjs P2 and P4 adapted
  (rows by code; the channel rows counted), G1 test added.
- F3: lead-stop.mjs leadStop (cases a to d, refusals naming the send_outcomes row), record-step.mjs
  stop; judge nextOf reads lead_stop (test step: stop with the "sub" row; cleanup step: left, go
  on), holdsBy of a stopped step is false, recordProblems refuses a stop beside a finalized block;
  record.mjs NEVER_SENT, leadStopOf, unsentLeft; after a stop sign-device (before nextOf), send-file
  and record-step step refuse. lead-stop.test.mjs (9). Reviewer test changed: review2-next Q8 now
  sets node code 1010 and takes the lead's stop (case c) before it asks whether T9 is reached.
- G4: explorerReading records channel_mismatch [{event, derived, explorer}] instead of refusing;
  judge channelMismatches; nextOf stops at a test step with the stop table's "channel" row, leaves
  what the step moved under the explorer's id, and drops the cleanup steps that name that channel;
  a cleanup step with a mismatch goes into left (and "included and succeeded, but" stays). Test in
  lead-stop.test.mjs (G4) and record-step.test.mjs R2 (adapted from the refusal).
- F12: judgeFinal gives exit (0 right and nothing left, 4 right and something left, 1 wrong),
  the top up case says "as planned, left: ..."; run time exit 3; check.mjs exits by it and 2 for
  its own refusals (no file, not JSON). Tests in check.test.mjs. Reviewer tests changed:
  review2-next Q9 DEFECT (exit 4, the new verdict among the allowed ones, not "passed") and Q9
  measured (left exits 4).
- G2: judge runTimeRefund: T6, T7 and attempts, from the explorer's events; C6's words shared with
  the final judge (topUpText). Test in check.test.mjs.
- All 222 tests of the folder pass.
- The words: README (files, rows by code, the check of a research signer's file, the lead's stop,
  F2, G4, G2, exit codes), plan.md prose, steps.json what, template run_time_form; plan.mjs md and
  the README sha256 lines printed again. Test in plan.test.mjs.
- Mutants: mutants.json 156 (82 earlier, RV2 23, B2 51). First full run under setpriv: 146 killed,
  4 equivalent, 6 alive. Fixed: B-R4 and B-R4b pointed at dead code of plan.mjs lineValues (since
  F1 the nonces come from research-signed.mjs nonceOf): the dead code is removed and the mutants
  point at nonceOf. RV2-N4 and RV2-R4 listed equivalent with the second reviewer's reason.
  B2-F5b and B2-F3m got tests (pane-runner.test.mjs F5 status while reading; lead-stop.test.mjs a
  stop beside a finalized block). mutants.mjs counts the words test as a sha256 binding test.
- Second full mutant run on 604ce49 under setpriv: 156 mutants, 150 killed, 6 equivalent, none alive.
- F3c tightened (the lead's added rule): the runner's result names its call in sent_by (send,
  sendSame, find), recorded with the reading; case c holds only for a lone reading that answered a
  first send; otherwise refused, naming lab.find from the block before the first send. The 1010 row
  says both. Tests in lead-stop.test.mjs and pane-runner.test.mjs; review2-next Q8 adapted again
  (sent_by "send"). Mutants B2-F3n, B2-F3o, B2-F3p.
- Mutants of lead-stop.mjs (8) and pane-runner.js (31) on 5e98f87 under setpriv: all killed.
  GitHub checks of 5e98f87: all 7 success, the research check among them.
- G3: the workflow's paths, the next and last commit, alone. Nothing after it. F11, the runner, F9, F3 with G1 and G4, F12 and G2, the words, G3.

### Decisions (fix round 2) and why

- F1: the id itself is never counted in its own nonce, so the check gives the same answer when an
  explorer reading is added after the step is final. An attempt (T8.2) counts the refused T8.
- F3: for an encoder step whose signed file is gone but dead copies exist, the copy of case b is the
  newest dead copy (as F10 does for --again). Case a needs no signed file and no dead copy.
- F3: a stopped test step takes the stop table's "sub" row (the row of a step that never came on
  chain), prefixed with "stopped by the lead (case x)".
- F1: the F1 unit tests set OWNER to a test key in a copy of the plan held in memory, so the file
  flop-sign.mjs sign makes with that key passes as an owner step. CLI tests use planSigned.

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
