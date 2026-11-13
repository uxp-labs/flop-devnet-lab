# P2 fix round progress

Branch claude/imd-flop-chain-reads, from fcf75d0.

## Done
- Step 0: the reviewer's six test files from d7e90bb, unchanged. On fcf75d0 they give 13 failed, 81 passed (94). The 13 failures are all the DEFECT tests: L1 6, L2 1, L3 2, block 1, frozen list 1, unknown 2. The brief said 12 expected; the review's own list sums to 13.

- X1: node-rpc.ts answerOf. The error key is looked at first, for any object frame, so an error frame of any id is a failed call quoted as before (the existing error tests stay unchanged). Older fake sockets: rules.test.ts line 105, paid-gate.test.ts lines 141, 143, 473, presend-abort.test.ts line 52 got jsonrpc 2.0 and id 1. test/lib/scripted-gateway.ts already wrote faithful frames. New test/node-rpc.test.ts. Full vitest after X1: 7 failed (the remaining DEFECT tests), 1540 passed, 1 skipped.

## Next
The lead added X10, X11 and a W1 line at 13:05 (end of the brief): after X8, before W.
X1 done. X2 with X6 done: READ_METHODS frozen; nodeTransport rejects any other method before rpcCall (test/chain-read-node.test.ts). chain-read-source T5 count of chain-read test files went 5 to 6 for the new file (X7 rewrites that list).
 X2 with X6, X3, X5, X9, X4, X7, X8, W1 to W5.

## Report of the P2 fix round
(filled as the work goes)
