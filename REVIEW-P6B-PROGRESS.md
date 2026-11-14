# Review P6b progress (reviewer, branch claude/review-p6b-miner-client)

Reviewed head: d408cc8. Tests in imd-flop/test/review-p6b-*.test.ts, rig in imd-flop/test/lib/review-p6b-fetch.ts.

## Done
- attack 1 bodies + timing grid + whole run over fake fetch (review-p6b-bodies): all agree
- attack 2 endpoint, 92 refused + 13 taken (review-p6b-endpoint): holds; note trailing dot DNS name taken
- attacks 3, 4 http (review-p6b-http): holds but RP6B-4
- attacks 5, 6, 7 order/ack/receipt/close (review-p6b-order): RP6B-1, 2, 3

## Next
- attack 8 messages scan, 9 source scans (review-p6b-source), 10 mutants in /tmp/rev-p6b, 11 README, 12 deviations, npm test, checks

## Findings so far
- RP6B-1 (L1, M-21): ack signed then delivery fails (500, 302, no answer, time limit, clock fail) -> turn throws, signed ack lost
- RP6B-2 (L2, M-22): minerRun requires endpoint field
- RP6B-3: turn result's leaf is the run's own array; caller mutation changes receipt finalRoot (C8)
- RP6B-4: proof 500 with body over limit is exit 11 not 5 (C11)
- note: seven files' scan lacks performance, hrtime, randomUUID, eval, require, import.meta (P6a scan has them)
