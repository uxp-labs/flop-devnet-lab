# P2 fix round progress

Branch claude/imd-flop-chain-reads, from fcf75d0.

## Done
- Step 0: the reviewer's six test files from d7e90bb, unchanged. On fcf75d0 they give 13 failed, 81 passed (94). The 13 failures are all the DEFECT tests: L1 6, L2 1, L3 2, block 1, frozen list 1, unknown 2. The brief said 12 expected; the review's own list sums to 13.

- X1: node-rpc.ts answerOf. The error key is looked at first, for any object frame, so an error frame of any id is a failed call quoted as before (the existing error tests stay unchanged). Older fake sockets: rules.test.ts line 105, paid-gate.test.ts lines 141, 143, 473, presend-abort.test.ts line 52 got jsonrpc 2.0 and id 1. test/lib/scripted-gateway.ts already wrote faithful frames. New test/node-rpc.test.ts. Full vitest after X1: 7 failed (the remaining DEFECT tests), 1540 passed, 1 skipped.

## Next
The lead added X10, X11 and a W1 line at 13:05 (end of the brief): after X8, before W.
X1 done. X2 with X6 done: READ_METHODS frozen; nodeTransport rejects any other method before rpcCall (test/chain-read-node.test.ts). chain-read-source T5 count of chain-read test files went 5 to 6 for the new file (X7 rewrites that list).
X3 done: session-state.ts ofThePair, used by read.ts and cross-check.ts; test/chain-read-pair.test.ts (count in chain-read-source T5 now 7). The reviewer's HOLDS (info) test of a session with no owner and no delegate in review-chain-read-cross-check.test.ts pinned an agreement X3 removes: changed in the X3 commit to expect unknown, its name says so.
X5 done: read.ts asks chain_getBlockHash of the header's number after the header, before pinAt; test/chain-read-head.test.ts (T5 count 8). Full vitest: 2 failed (X4's DEFECT), 1563 passed, 1 skipped.
X9 done: door.ts provenPin, called by read.ts pinAt with KEY_TABLE.system.last_runtime_upgrade and lastRuntimeUpgradeKey(). The door's value is { spec_version: number, spec_name: text }, so it compares with runtimeOf's spec. test/chain-read-pin.test.ts (T5 count 9). The builder's test in chain-read-unknown.test.ts (upgrade block with its own metadata) pinned the reason prefix "System.Events:"; the refusal now comes at the pin, so the prefix is "the pin:" (one line changed). The spec comparison is not reachable while the door pins: the door reads the same record again and must agree; a mutant that drops it is equivalent.
X4 done: node.ts thrownWords and measured; tests in test/chain-read-node.test.ts. Full vitest: 1573 passed, 1 skipped, 0 failed.
X7 done: chain-read-source.test.ts scans all of src with comments taken out (code()), five forms, planted samples incl. the reviewer's; a text that ends inside a template fails the scan. The T5 list is now explicit: 15 files (builder 5, fix round 4, node-rpc.test.ts, reviewer 6), held against the folder. A planted dynamic import in door.ts fails two tests (checked by hand, not committed).
X8 done: chain-read-node.test.ts states every cap as a number with its reason, and holds each storage cap, the metadata cap and the header cap at its edge. No cap changed.
X10 done: scripts/need-observatory.mjs (exports needObservatory, NEEDED, BUILD, OBSERVATORY), prebuild and pretest in package.json, test/need-observatory.test.ts. By hand in a temporary copy with no observatory beside it: one line, exit 1.
X11 done: sign-device.mjs line 39 comment now two lines naming the observatory first. mutants.json: 211 finds, each exactly once. node --test there: 281 tests, 281 pass.
W1 done: README Chain reads section and Run it block (npm ci). package-lock.json untouched.
 X2 with X6, X3, X5, X9, X4, X7, X8, W1 to W5.

## Report of the P2 fix round
(filled as the work goes)
