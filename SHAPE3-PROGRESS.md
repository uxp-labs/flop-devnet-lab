# Shape 3 progress (removed in the last commit)

Brief: /mnt/user-data/outputs/briefs/2026-11-13-shape3-more-stated-entries.md. Branch claude/observatory-shape-3 from main c153eb2.

## Done, by rule id

- B1, T2: STATED_TABLE in shape.ts, STATED_ENTRIES derived, deriveShape from it (test/stated-table.test.ts, reviewed-frozen).
- B4: scripts/write-shape.mjs via test/helpers/shape-file.ts (test/write-shape.test.ts, cli-checks case).
- B5, A1 to A4, T1: both shape files written by the writer, REVIEWED sha256, diff at @3. Only `schema` of every @2 key changed; 13 types added.
- B7: lead ruled. upgrade-requests.test.ts holds the record to the @2 fixture fixtures/shapes-at-2 (git show c153eb2).
- T6: test/shape-at-2.test.ts. The pin's refusal and the writer's compare name both formats (schemaNamed in shape.ts).
- T3, T4: test/stated-entries.test.ts.

## Next

- C1 with T5, B6, T7 (mutants, test-counts), W1 to W3.

## Decided, and why

- The pin refusal for a shape file of another schema adds ": it is X, not Y" (A4 asks every reader to name both versions).
- shapeMetadata in review-decoder.test.ts takes `drop` instead of `sessionKeys` so each new pallet and entry can be left out.
- Unstated entry examples in storage-values.test.ts moved to entries still unstated (ModelsByMiner, TotalMiners, BlockHash, SessionCount).
