# Progress of the builder (read first if you take over)

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

## Next

- R (record-step.mjs start and step, plan.mjs next).

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
