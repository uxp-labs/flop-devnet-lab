# Review of P2 (chain reads): progress

Reviewer branch `claude/review-imd-flop-chain-reads`, reviewing `fcf75d0`.
Built: observatory then imd-flop, both `npm ci && npm run build`, exit 0.

## Findings so far

Test file `imd-flop/test/review-chain-read-lead.test.ts` (9 DEFECT tests fail on fcf75d0, 3 HOLDS pass).

1. L1 proven. rpcCall answers null for a frame with no result key ({}, a notification, error 0, another id). Through nodeTransport the session reads absent, the nonce known (Default, not stored), the breaker absent. Frames of another id and frames with no jsonrpc are taken as answers.
2. L2 proven. nodeTransport(url)("author_submitExtrinsic" as any, ...) puts that method on the wire.
3. L3 proven. Node answers (O,D1) keys with (O,D2) bytes at B10: session known with delegate D2; crossCheck agrees with dev2's event for a state whose delegate is D1.

4. A: a transport that throws an Error whose message getter throws, or answers a header JSON.stringify cannot write (bigint), makes readSessionState throw (low: not a JSON node answer). `review-chain-read-unknown.test.ts`, 2 DEFECT.

5. B: readSessionState answers the head header's number unchecked (no chain_getBlockHash). A header naming A9's number over A6's storage reads known at number A9. `review-chain-read-block.test.ts`, 1 DEFECT.

6. F: READ_METHODS is not frozen (as const only). `review-chain-read-tables-package.test.ts`, 1 DEFECT.
7. G: source scan blind spot. In the copy, `import(new URL(["..","..","..","observatory","dist","scale","shape.js"].join("/"), import.meta.url).href)` added to read.ts loads observatory shape.ts (keys SHAPE_SCHEMA, REVIEWED...) and chain-read-source.test.ts still passes 16 of 16. Low.

## Mutants (copy at /tmp/rp2-mut, list /tmp/rp2-tools/mutants.json, 53 mutants)

Builder's five files leave alive: N1 N5 N8 N9 N10 N12 R2 R10 X1 X2 X3 X7 X9.
Reviewer HOLDS tests kill N1 N8 R2 X1 X2 X3 X7 X9.
Equivalent (redundant guard caught later): N5, N10, R10.
Live: N9 (LRU cap), N12 (session cap): every test reads the cap from CAPS itself.
pinAt mutant (metadata at the block): 64 builder tests fail, most because the scripted node holds metadata only at stand in parents; the decisive one is the upgrade block test in chain-read-unknown.

## Held

- A (22 HOLDS in review-chain-read-unknown.test.ts): every JSON value for head, header, block hash, metadata, LRU, Events and the three entries is unknown; "0x" is unknown everywhere; caps over by one refused; header number forms refused; thrown text/null/undefined/object unknown.
- Info: metadata "0x" leaves the session read known with three unknown entries and a runtime named by LRU only.
- C: 5 HOLDS in review-chain-read-runtime.test.ts (3528528 and 3528529 with own, parent and other metadata).
- E: 24 HOLDS in review-chain-read-cross-check.test.ts (table).
- G: 18 HOLDS: exports map refuses bare name, package.json, dist/cli.js, scale/shape, .., %2e%2e, node_modules; shapeFileText refuses names that leave shapes/.
- Info: imd-flop/node_modules/.bin gets flop-observatory and flop-observatory-mcp from the file: dependency's bin.
- Info: observatory check.sh does rm -rf dist; dist holds 44 .d.ts beside 44 .js; no outputs digest or pin reads dist.
- D: door does not rebuild the key of System.Events or System.LastRuntimeUpgrade (decodeBlockEvents and runtimeOfBlock take no key); those two keys are held only by the key table test.
- R12: rpcCall is byte identical to gateway.ts at 23f4e4e but for `export`.

## Next

Attacks H, I.
