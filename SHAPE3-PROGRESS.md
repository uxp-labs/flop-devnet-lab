# Shape 3 progress (removed in the last commit)

Brief: /mnt/user-data/outputs/briefs/2026-11-13-shape3-more-stated-entries.md. Branch claude/observatory-shape-3 from main c153eb2.

## Done, by rule id

- B1, T2: STATED_TABLE in shape.ts, STATED_ENTRIES derived, deriveShape from it (test/stated-table.test.ts, reviewed-frozen).
- B4: scripts/write-shape.mjs via test/helpers/shape-file.ts (test/write-shape.test.ts, cli-checks case).
- B5, A1 to A4, T1: both shape files written by the writer, REVIEWED sha256, diff at @3. Only `schema` of every @2 key changed; 13 types added.
- B7: lead ruled. upgrade-requests.test.ts holds the record to the @2 fixture fixtures/shapes-at-2 (git show c153eb2).
- T6: test/shape-at-2.test.ts. The pin's refusal and the writer's compare name both formats (schemaNamed in shape.ts).
- T3, T4: test/stated-entries.test.ts.

- C1, T5: lead ruled (A10 null to "empty", note removed, filled_from.shape, README paragraph, fixture of the @2 day record, test that nothing else changed). check.mjs 23 pass.
- B6: read-key-table.mjs requires @3; key-table.ts byte for byte the same.
- T7: 13 moved mutants follow the code, 13 new r29 mutants (11 decoder, 2 record); test-counts updated.
- W1: README, RULES 9 and 10.

## Next

- mutate.mjs on decoder.json and record.json (running), REVIEW-LOG round 29, observatory npm test, imd-flop npm run check, research node --test, W3.

## Report of shape 3 (draft)

- Shape files: 1014014 574318 bytes sha256 5e66cf79e9cd5f3ec997e9ff0ac4fca8b08923e0f5cb8f5b2d10ef4aaa03a370, 482 types; 1014020 576231 bytes sha256 af3f7c6996338b8328de0e67f886c1479d5c382a9fc133ddac8d6862732fb185, 482 types.
- No file on either workflow's push path list is touched.

## Decided, and why

- The pin refusal for a shape file of another schema adds ": it is X, not Y" (A4 asks every reader to name both versions).
- shapeMetadata in review-decoder.test.ts takes `drop` instead of `sessionKeys` so each new pallet and entry can be left out.
- Unstated entry examples in storage-values.test.ts moved to entries still unstated (ModelsByMiner, TotalMiners, BlockHash, SessionCount).
