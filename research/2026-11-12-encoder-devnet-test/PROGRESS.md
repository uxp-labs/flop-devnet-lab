# Progress of the builder (read first if you take over)

Branch `claude/encoder-devnet-test-prep`. First round from main `6d7ad0e`, head `fcfb8b5`.
Fix round brief: `/mnt/user-data/outputs/briefs/2026-11-13-fix-d1-encoder-devnet-test-prep.md`.
The reviewer's branch (`2e6b0e5`) is merged (fast forward). 17 reviewer tests fail at the start.

Order of work (the brief's): P1, S1 to S7, X1 to X9, E1 to E3, R1 to R4, C1 to C7, P2 to P8, W.
Run tests: `setpriv --inh-caps=-dac_override,-dac_read_search --bounding-set=-dac_override,-dac_read_search node --test`
in this folder. `imd-flop/dist` must be built.

## Done (fix round), by rule id

- merge of the reviewer's branch.

## Next

- lead-measurements-2026-11-13.json, then P1.

## Decisions (fix round) and why

- Run folder layout: `<run>/results.json`, `<run>/signed/<id>.json`, `<id>.send.json`,
  `<id>.dead-<n>.json`, `<id>.dead-<n>.send.json`.
- The run time record keeps each step's reading under `steps[i].run_time`: `sent` (the runner's
  relay text, parsed), `sent_sha256`, `explorer` (record form, with source and read_utc),
  `earlier_readings` (non final readings it replaced), `earlier_copies` (from the signed file).
- An attempt (S5) is its own entry in `steps` with `step: "T6.2"`.
- The key loader is shared by sign-device.mjs and record-step.mjs in `device-key.mjs`.
- The runner's transport gets an `onWrite` hook (X4) and an `onLost` hook (X2). Reviewer tests
  that script a transport are adapted to call the hook; the change is listed.
