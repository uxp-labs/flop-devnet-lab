# Review of shape @3 (round 29): progress

Reviewer worktree: /home/claude/wt-review-shape3, branch claude/review-observatory-shape-3, reviewed head bdd5dde.

## Attacked
- 1, 2: ten entries and closure read a third way (polkadot-api, own walk): held, both runtimes. test/review-shape3-metadata.test.ts
- 3: door on new entries (other pallet, MeasuredRoots parts, extra byte, short, empty, u32 max, 2^128-1, default flags): held. test/review-shape3-door.test.ts
- 4: fill text. test/review-shape3-fill.test.ts

## Found
- F1 (medium, P4): fill writes DelegateSessions absent as "empty", same as a stored empty list.

## Next
- 5 (@2 refused everywhere), 6 (table vs sections, by hand in a copy), 7 writer, 8 records, 9 imd-flop, 10 mutants, 11 words, 12 test counts
