# Review P6b progress (reviewer, branch claude/review-p6b-miner-client)

Reviewed head: d408cc8. Tests in imd-flop/test/review-p6b-*.test.ts, rig in imd-flop/test/lib/review-p6b-fetch.ts.

## Done
- attack 1 bodies + timing grid + whole run over fake fetch (review-p6b-bodies): all agree
- attack 2 endpoint, 92 refused + 13 taken (review-p6b-endpoint): holds; note trailing dot DNS name taken
- attacks 3, 4 http (review-p6b-http): holds but RP6B-4
- attacks 5, 6, 7 order/ack/receipt/close (review-p6b-order): RP6B-1, 2, 3

- attack 8 messages (review-p6b-messages): holds
- attack 9 source scan + file walk (review-p6b-source): holds; builder scan weaker (RP6B-5)
- attack 10 mutants: /tmp/rev-p6b-tools/mutants.json, 77 mutants vs builder tests: 7 alive (4 equivalent: E-userinfo1 E-path2 H-afterTime H-chMax; 3 not: C-turn2xx H-dropCancel C-freshCh) + scan mutants S-uuid S-perf2 S-eval alive; review-p6b-kills kills C-turn2xx H-dropCancel; bodies test kills C-freshCh; source test kills S-*
- attack 11 README read: matches code; 11 for proof 3xx/oversize stated (see RP6B-4)
- attack 12 deviations read

## Next
- npm test whole, push, gh checks, report

## Findings so far
- RP6B-1 (L1, M-21): ack signed then delivery fails (500, 302, no answer, time limit, clock fail) -> turn throws, signed ack lost
- RP6B-2 (L2, M-22): minerRun requires endpoint field
- RP6B-3: turn result's leaf is the run's own array; caller mutation changes receipt finalRoot (C8)
- RP6B-4: proof 500 with body over limit is exit 11 not 5 (C11)
- RP6B-5 (low): seven files' scan lacks performance, hrtime, randomUUID, eval, require, import.meta (P6a scan has them)
