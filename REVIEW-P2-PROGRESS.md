# Review of P2 (chain reads): progress

Reviewer branch `claude/review-imd-flop-chain-reads`, reviewing `fcf75d0`.
Built: observatory then imd-flop, both `npm ci && npm run build`, exit 0.

## Findings so far

Test file `imd-flop/test/review-chain-read-lead.test.ts` (9 DEFECT tests fail on fcf75d0, 3 HOLDS pass).

1. L1 proven. rpcCall answers null for a frame with no result key ({}, a notification, error 0, another id). Through nodeTransport the session reads absent, the nonce known (Default, not stored), the breaker absent. Frames of another id and frames with no jsonrpc are taken as answers.
2. L2 proven. nodeTransport(url)("author_submitExtrinsic" as any, ...) puts that method on the wire.
3. L3 proven. Node answers (O,D1) keys with (O,D2) bytes at B10: session known with delegate D2; crossCheck agrees with dev2's event for a state whose delegate is D1.

4. A: a transport that throws an Error whose message getter throws, or answers a header JSON.stringify cannot write (bigint), makes readSessionState throw (low: not a JSON node answer). `review-chain-read-unknown.test.ts`, 2 DEFECT.

## Held

- A (22 HOLDS in review-chain-read-unknown.test.ts): every JSON value for head, header, block hash, metadata, LRU, Events and the three entries is unknown; "0x" is unknown everywhere; caps over by one refused; header number forms refused; thrown text/null/undefined/object unknown.
- Info: metadata "0x" leaves the session read known with three unknown entries and a runtime named by LRU only.
- R12: rpcCall is byte identical to gateway.ts at 23f4e4e but for `export`.

## Next

Attacks A to I.
