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

## The lead's rule on the stop (10:52 UTC), done
- E11: one assertion changed, six runtime dependencies, flop-observatory exactly file:../observatory: d6d21be.
- T3: SessionNonces is Default: no value is known 0 with stored false (the recorded null at 3530299 is the
  real case). Sessions and CircuitBreakers are Optional: no value is absent (made cases on A6). The key
  table carries each entry's modifier; Stored<T> known carries stored.

## Next (before the stop)
Checks: imd-flop npm run check, research node --test (two folders), observatory npm run check (long), then
GitHub checks of the last commit. Then remove this file in the last commit.

Done since: T1/T4 cb03f54, T2/T3/B2 b333a2c, C2/C4 6d9be3b, T5 2f6a561, T6 pass ca5936f (two
unreachable guards removed, tests added), W1/W2 d1beb05 (REVIEW-LOG round 30; 29 left for shape @3).
Sanity mutation pass (not committed, /tmp script): 29 hand mutants over src/chain-read, all killed after ca5936f.

## Open point for the lead (T3)
The rerun's record holds no absent session: a revoked session is STORED with active false (A10 and B11
batch answers in recording 4 hold Sessions bytes; results.json A10 reads_after session_active "false").
T3 uses instead the one recorded null of a stated session entry: SessionNonces(D1 as owner, S as
delegate) at block 3530299 in the upgrade recording (calls 43 of its requests.json). An Optional
Sessions answered null is tested on the rerun recording with that one answer changed to null.

## Decisions
- B1: serverText moved to its own module rather than duplicated or imported from gateway.ts (a cycle).
- Key table holds one runtime, 1014020, as the encoder's table does; System keys are shared.
- Cross check: exactly one SessionCallExecuted of the session at the block, else unknown.
- Scripted nodes: the rerun recording holds no header, so the scripted parent hash is derived in the test;
  the scripted finalized head is the step's own block.

## Report of P2 (draft, before the observatory check)
- imd-flop npm run check at a2d6207: finished, overall_exit 0, 4 steps (00-observatory-build, 01..03),
  55 files, 1429 passed, 1 skipped (the skip was there before P2: 1299 passed 1 skipped at B1).
- research node --test: encoder-devnet-test 281 of 281, session-rerun-1014020 41 of 41.
- observatory npm run check: running next at the commit that adds this text.
- Every rule A1..A6, B1, B2, C1..C7, T1..T6, W1, W2 done; W3 done; W2 check and W4 pending.
