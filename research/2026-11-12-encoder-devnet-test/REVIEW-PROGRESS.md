# Review progress (reviewer of fcfb8b5, branch claude/review-encoder-devnet-test)

Brief: `/mnt/user-data/outputs/briefs/2026-11-13-review-d1-encoder-devnet-test-prep.md`.
No file of the builder is changed. Tests of the reviewer are `review-*.test.mjs`.

## Baseline

- Builder tests: 60 pass. Rerun tests: 41 pass. Scope diff outside the folder: empty (P11 holds).

## Findings so far (each with its test)

- F1 high P4/P3: `{broadcast:[..]}` status ends the watch as "ended" (review-pane-runner: broadcast).
- F2 low P4: "dropped"/"invalid" strings ignored, waits to deadline (review-pane-runner: dropped).
- F3 medium P4: socket close not handled; says "not in any block"; heads() hangs (review-pane-runner: socket x2).
- F4 low P4: any host accepted (review-pane-runner: host).
- F5 medium P3: signed/ from cwd; results.json sent step re-signed (review-sign-device: P3 x2).
- F6 medium P9/P6: T6/T7 signed with an era that ends before their earliest block (review-sign-device: P9 x2).
- F7 low P2: alg of key file not checked (review-sign-device: sr25519).
- F8 medium P7: steps out of order across signers pass (review-check: T8 before T6, T1 after T3).
- F9 medium P7/P3: a step recorded twice passes (review-check: T4 twice).
- F10 medium P6: plan's recovery (new step id) impossible in sign-device and in check (review-check: recovery).
- F11 high P6: no run time source for T3 channel id / ack_deadline; pane decodes nothing (review-plan: T4 from run time record).
- F12 medium P9/P6: plan silent on refused-at-submission, outdated, deadline, ended (review-plan).
- F13 low P10: plan does not name the cap per step (review-plan).

## Held

- P1 seed in outputs, 12 paths (review-sign-device held test). P2 cwd steps.json not followed. P3 runner submits once (3 node answers).
- check catches: off by one, extra outflow, fee to owner, short refund, top up not back, wrong signer, missing T2, reserved, unnamed error. P5 sources, P10 sums and caps.
- P11 scope diff empty. Genesis/spec checked by runtimeFor.

## Next

- table F; report

## Mutants

`node review-mutants.mjs`: 18 mutants, 17 killed by the builder's tests, R-M17 equivalent (alive, reason in the json). Baseline 0 builder fails, 17 reviewer fails (the DEFECT tests).
