# Review of shape @3 (round 29): progress

Reviewer worktree: /home/claude/wt-review-shape3, branch claude/review-observatory-shape-3, reviewed head bdd5dde.

## Attacked
- 1, 2: ten entries and closure read a third way (polkadot-api, own walk): held, both runtimes. test/review-shape3-metadata.test.ts
- 3: door on new entries (other pallet, MeasuredRoots parts, extra byte, short, empty, u32 max, 2^128-1, default flags): held. test/review-shape3-door.test.ts
- 4: fill text. test/review-shape3-fill.test.ts
- 5: @2 refused: door, shape-diff, writer (builder tests); imd-flop read-key-table (mine, holds). test/review-shape3-at2.test.ts in imd-flop
- 6: table by hand in /tmp/rs3/copy: drop, rename, swap, section rename, key collision with events: all killed
- 7: writer compare and write both lines in copy: same sha; unreviewed spec exit 2; tape broken: stack trace exit 1, writes nothing
- 10: by hand r29-section-entries-dropped, r29-fill-delegate-pairs-dropped, r29-writer-format-unnamed: killed. Mine: FailedAcks 0 as absent survives branch tests; imd-flop schema line removed survives branch tests

## Found
- F2 (low, P10): FailedAcks stored 0 written absent survives branch tests
- F3 (low, P10): imd-flop schema check has no test
- F1 (medium, P4): fill writes DelegateSessions absent as "empty", same as a stored empty list.

## Next
- 8 records, 9 imd-flop check, 11 words, 12 test counts
