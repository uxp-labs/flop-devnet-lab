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

## Held

- P1 seed in outputs, 12 paths (review-sign-device held test). P2 cwd steps.json not followed. P3 runner submits once (3 node answers).
- P11 scope diff empty. Genesis/spec checked by runtimeFor.

## Next

- check.mjs wrong records (order, recovery, balances); sums; plan words; mutants; table F
