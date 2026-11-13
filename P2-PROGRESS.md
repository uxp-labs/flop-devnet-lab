# P2 progress (builder's file, removed in the last commit)

Brief: /mnt/user-data/outputs/briefs/2026-11-13-p2-chain-reads.md. Branch claude/imd-flop-chain-reads from main 23f4e4e.

## Done
- B1: rpcCall moved from imd-flop/src/gateway.ts to imd-flop/src/node-rpc.ts, exported, unchanged. Its helper
  serverText (and SERVER_TEXT_MAX) moved with it to imd-flop/src/server-text.ts, unchanged, exported, because
  both gateway.ts and node-rpc.ts quote server text and a second copy would be a second rule. No test changed.
  imd-flop npm test: 50 files, 1299 passed, 1 skipped.

- A2 0bbbbb5, A3/A4 observatory 3a29017 (exports map, declarations, test/package-exports.test.ts pinned).
- A5 de8dc51: offline-check.sh step 00-observatory-build; research-offline.yml builds observatory first.
- Source of src/chain-read written: result, bytes, freeze, door, shape-file, node, key-table(+types, by
  scripts/read-key-table.mjs), keys, session-state, cross-check, read. Typechecks. No tests of it yet.

## Next
Tests T1..T6 under imd-flop/test/chain-read-*.test.ts, README section (W1), REVIEW-LOG round (W2), checks.

## Open question for the lead (T3)
The rerun's record holds no absent session: a revoked session is STORED with active false (A10 and B11
batch answers in recording 4 hold Sessions bytes; results.json A10 reads_after session_active "false").
No stated session entry is answered null in any recording. T3 is built on a scripted null answer
for the Sessions key of the rerun's owner and dev2 at block A2 (before session B existed), and flagged.

## Decisions
- B1: serverText moved to its own module rather than duplicated or imported from gateway.ts (a cycle).
- Key table holds one runtime, 1014020, as the encoder's table does; System keys are shared.
- Cross check: exactly one SessionCallExecuted of the session at the block, else unknown.
- Scripted nodes: the rerun recording holds no header, so the scripted parent hash is derived in the test;
  the scripted finalized head is the step's own block.

## Report of P2
(written from the middle of the work on)
