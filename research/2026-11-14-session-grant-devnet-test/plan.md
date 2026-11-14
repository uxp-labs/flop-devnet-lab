# The small devnet batch of G-19: the plan

This is the plan of the batch for a reader. Its tables and lists are printed from `steps.json` by
`plan.mjs`; `node plan.mjs md` writes them again, and `plan.test.mjs` holds them equal. The lead's
lines come from `node plan.mjs next --run "$RUN"`, never from this page.

## What it is for

`imd-flop session grant` prints the call an owner signs to give a seat's device key a session with
caps. No grant printed by the tool has landed on chain yet. The batch shows it, between the lab's
own accounts on FLOP devnet, with test tokens:

- G1: the grant the tool prints lands as `SessionCreated` with exactly the caps the tool derived.
- R1: the revoke the tool prints lands as `SessionRevoked`.
- G2: a second grant for the same pair after the revoke (U1). Taken or refused, both are results.
- R2: if G2 was taken, a revoke, so nothing is left active.

The owner S is the lab's owner (`steps.json` `OWNER`). The device D is made by the tool itself in
the run folder's seat home: `imd-flop init`, then `imd-flop cap set` with the plan's caps (B-3). D
signs nothing and holds nothing. Every owner call is the hex the tool printed, signed by the
research signer (`flop-sign.mjs sign --call <that hex>`), immortal.

## The steps

<!-- printed by plan.mjs: table -->
| Step | Signer | Call | Expected events | Expected fee | Only if | Cleanup |
|---|---|---|---|---|---|---|
| P0 | none | reads only | none | 0 |  | no |
| G1 | owner | session grant printed by the tool; second encoder: flop-sign.mjs call create-session | FlopSessionKeys.SessionCreated {owner 0xe462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2, delegate $DEVICE, spending_cap 25000000000000000, per_tx_limit 20000000000000000, daily_cap 25000000000000000, expires_at the block plus 86400} | 6413391035000000 (0.006413391035 FLOP) |  | no |
| R1 | owner | session revoke printed by the tool; second encoder: flop-sign.mjs call revoke | FlopSessionKeys.SessionRevoked {owner 0xe462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2, delegate $DEVICE} | 3906000695000000 (0.003906000695 FLOP) | G1 succeeded | yes, 3 tries |
| G2 | owner | session grant printed by the tool; second encoder: flop-sign.mjs call create-session | FlopSessionKeys.SessionCreated {owner 0xe462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2, delegate $DEVICE, spending_cap 25000000000000000, per_tx_limit 20000000000000000, daily_cap 25000000000000000, expires_at the block plus 86400}. U1: taken: SessionCreated as G1, then R2. refused with FlopSessionKeys.SessionAlreadyExists: the end. another error: recorded, U1 stays open, the end | 6413391035000000 (0.006413391035 FLOP); refused: unknown: no failed create_session is recorded in any committed file; bounded by 10558485985000000 | R1 succeeded | no |
| R2 | owner | session revoke printed by the tool; second encoder: flop-sign.mjs call revoke | FlopSessionKeys.SessionRevoked {owner 0xe462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2, delegate $DEVICE} | 3906000695000000 (0.003906000695 FLOP) | G2 succeeded | yes, 3 tries |
<!-- end of printed -->

Each owner step has these phases, in order, and `plan.mjs next` prints the lines of the next one:

1. call: a session tape at a head at or above the last finalized step; `tool-run.mjs <id> call`
   runs the tool's own `session grant` or `session revoke` over it; `record-step.mjs call` holds
   the printed call to the plan (owner, device, runtime, caps, the stored record line) and to the
   second encoder (`flop-sign.mjs call`), and writes `calls/<id>.json` only when both hold.
2. sign: `flop-sign.mjs sign --call` of that call at the nonce the record gives; `record-step.mjs
   send-file` checks the signed file (the last batch's `checkResearchSigned` with its `expected`
   parameter, then the spec, the transaction version and the genesis by the signature) and writes
   the send file only when it holds.
3. send: `lab.send` of `pane-runner.js`; `record-step.mjs step --sent`.
4. block: a block tape of the step's block; `tool-run.mjs <id> block` runs the tool's
   `readBlockEvents` over it; `record-step.mjs tool <id> block` keeps the extrinsic's events, its
   outcome and its fee, as the lab's own decoder reads them.
5. after: a session tape at a head at or above the step's block; the tool's `session show` over it.
6. beside: the explorer's reading (`explorer-reader.js`), a second and weaker source.

## The stop rule

<!-- printed by plan.mjs: stops -->
- P0: the runtime, the genesis or the transaction version at the start is not the plan's
- P0: SessionCount(S) is 9 or more, or cannot be read
- P0: the pair (S, D) is not absent
- P0, and every call, block and after reading: the tool exits other than 0
- before a signature: the tool's call is not the plan's (owner, device, runtime, caps, stored record line), or its hex differs from the second encoder's
- the signed file check refuses: nothing is sent
- a send outcome that is not a clean inclusion: the immortal rows of send_outcomes (plan.mjs outcomes)
- G1 failed in its block: stop, nothing is active, one fee is lost
- G1 succeeded but its SessionCreated fields are not the derived caps, owner and delegate, or its expires_at is not its block plus 86400, or show after G1 does not say active with those caps: R1, then stop
- a step's fee above 10558485985000000: stop after the cleanups that apply
- a revoke failed in its block: a cleanup try at the next nonce, 3 tries at most; then stop, and an active session is left until its expiry
- a revoke that succeeded but is not the plan's (no SessionRevoked of the pair, or show after it does not say revoked): stop
- G2 refused with FlopSessionKeys.SessionAlreadyExists: the end, U1 answered. Another error: the end, U1 stays open. Taken: R2
- an outcome that cannot be read from the block's events: stop
<!-- end of printed -->

A send outcome that is not a clean inclusion follows the immortal rows of the last batch's
`send_outcomes`, imported, not written again:

<!-- printed by plan.mjs: outcomes -->
- finalized: the extrinsic is in a block the node reported finalized, with the block's hash, number and the extrinsic's index, and the sha256 and length of that block's System.Events. The lead: record-step.mjs step --sent; then explorer.read and record-step.mjs step --explorer. plan.mjs next says what follows. A second copy: never
- finalized-not-found: the node said finalized for a block that does not hold the extrinsic. Not known whether another block holds it. The lead: record nothing as included. lab.find from the birth block (mortal) or from the start of the run (immortal), and record what it returns. A second copy: never; lab.sendSame
- finalized-not-canonical: the finalized block's hash is not the block at its height. Not known where the extrinsic is. The lead: as finalized-not-found: lab.find, and record what it returns. A second copy: never; lab.sendSame
- finalized-unread: the node said finalized, with the block's hash, but reading that block failed. The lead: lab.find from the birth block (mortal) or the start of the run (immortal): it reads the block again. A second copy: never; lab.sendSame
- refused-bundle: nothing was sent: the text or its sha256 changed on its way, or it holds no extrinsic. The lead: relay the send file and its sha256 again, exactly. A second copy: not needed: the same copy is sent
- already-sent: nothing was submitted by this call, but this page's sent list holds these bytes: they were written to a socket before (H2). It is a reading: record-step.mjs step records it, and nextOf takes the step as sent and not in a finalized block. It may be in the pool or in a block. With it in the record the lead's stop has neither case c nor case d. The lead: record it. Then lab.find from the birth block (mortal) or the start of the run (immortal), and record what it returns; if not found, lab.sendSame (immortal) or S4 (mortal). A second copy: never
- not-in-sent-list: nothing was sent: sendSame sends only bytes send sent before. The lead: use lab.send. A second copy: not needed
- not-sent: nothing was written: the connection was not open. Nothing is marked as sent. The lead: paste the runner again in a fresh tab on the node, check its sha256, and lab.send the same send file. A second copy: not needed: the same copy is sent
- refused-at-submission (node code 1010): on a first send: the node judged the extrinsic invalid (a bad signature, a used or future nonce it will not keep, a mortal copy whose era is over, or a fee it cannot pay): it is not in the pool and cannot be included as it is, and nothing moved. On a sendSame after an outcome that may still land (deadline, connection-lost, ended), 1010 can mean the first copy is already in a block (its nonce is used). The lead: record it. After a sendSame that followed a deadline, connection-lost or ended: lab.find before anything else, from the block before the first send. After a first send: for an immortal step this is case c of record-step.mjs stop, and the cleanup steps that apply follow; for a mortal step, once the finalized head is above its last valid block, case b, or a second copy by S4. A second copy: never; the lead stops at the step instead
- refused-at-submission (node code 1013): already imported: the node holds these bytes in its pool. It IS in the pool and may be included. The lead: treat it as sent: record it, then lab.find from the birth block (mortal) or the start of the run (immortal). No stop by the lead: the copy can land. A second copy: never
- refused-at-submission (node code 1014): the priority is too low: another transaction of the same signer and nonce is in the pool. A copy the record does not hold exists. The lead: stop signing and find out which transaction it is (lab.find from the birth block or the start of the run). S2e refuses every device step until the record holds what is on chain. No stop by the lead. A second copy: never while the other is in the pool; the lead rules
- refused-at-submission (node code other): any other code: not in the pool, by the node's word. The lead: record it and read the node's words. lab.sendSame of the same bytes later; no stop by the lead (record-step.mjs stop allows case c only with 1010). A second copy: never; lab.sendSame
- deadline: no final status before the runner's deadline of 120 s. It may be in the pool, or in a block that is not final (in_block names it). The lead: record it. lab.find from the birth block until the finalized head is above the last valid block (mortal), or until found (immortal). Sign no later step meanwhile. A second copy: never; lab.sendSame
- connection-lost: the extrinsic was written, then the connection was lost. It may be in the pool or in a block. The lead: paste the runner again in a fresh tab, then as deadline. A second copy: never; lab.sendSame
- ended (usurped): another transaction with the same nonce took its place in the pool: a copy the record does not hold exists. The lead: stop signing. lab.find from the birth block for this copy; S2e refuses every device step until the record holds what is on chain. A second copy: never: the nonce is used
- ended (finalityTimeout): it was in a block that did not become final in time. It may still be finalized. The lead: lab.find from the birth block, as deadline. A second copy: never; lab.sendSame
- ended (dropped): the pool dropped it. Not in a block, as far as the node knows. The lead: lab.find from the birth block, as deadline. A second copy: never; lab.sendSame
- ended (invalid): the pool found it invalid (for example its nonce was used or its era is over). The lead: lab.find from the birth block; read the record's nonce rule. A second copy: never
- not-found: find read the finalized blocks of the range it names and the extrinsic is not in them. Above the range, not known. The lead: mortal: find again from the end of the range until the finalized head is above the last valid block. Immortal: lab.sendSame, then find again. A second copy: never
- find-deadline: find did not finish before the runner's deadline (H10): it read the finalized blocks from its start to the block it names in to (none when to is null) and the extrinsic is not in them. Above that, not known. The lead: record it. lab.find again from the block after to (from the same start when to is null), and record what it returns. A second copy: never
<!-- end of printed -->

## The fence

<!-- printed by plan.mjs: fence -->
- moved to any account: nothing
- expected fees, G2 taken (G1, R1, G2, R2): 20638783460000000 (0.02063878346 FLOP)
- expected fees, G2 refused (G1, R1, G2): 10319391730000000 (0.01031939173 FLOP) plus G2's fee, which no committed file records, at most 10558485985000000 (0.010558485985 FLOP)
- worst case: 8 sends (each owner step once, each revoke 3 times) at the most per step 10558485985000000 (0.010558485985 FLOP): 84467887880000000 (0.08446788788 FLOP)
- the fence: 150000000000000000 (0.15 FLOP); the worst case is at or under it
<!-- end of printed -->

## The pane

<!-- printed by plan.mjs: pane -->
# the node's tab, https://rpc.devnet.flop.network/: put the text of pane-runner.js in window.__src, check its sha256 there, run it; then the same with session-reads.js
#   sha256 of pane-runner.js: f034f6edc5d3a81218b67c3545bc5ba43d363ffd0fbd39a625c315cf235b5a78
#   sha256 of session-reads.js: 0e637aa57e603faf8d250d478e7efad877e8af36b6e90cfe5ef75fcb86a285f9
#   [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(window.__src)))].map((b) => b.toString(16).padStart(2, "0")).join("")
#   (0, eval)(window.__src)   once for each file, in that order; then: const lab = paneRunner.createRunner(); const reads = sessionReads.createReader()
# the explorer's tab, https://explorer.devnet.flop.network/: the same with explorer-reader.js
#   sha256 of explorer-reader.js: 26a479201af916eb7f0896e173fc7d89bb95b4bdac0e6f106caf5cf06e6c2c33
#   (0, eval)(window.__src); const explorer = explorerReader.createReader()
# a pane call ends after 45 s: keep each promise on window and read it in a second call
<!-- end of printed -->

## Out of this batch

U2, the expiry's edge, is out (B-4). P0 makes only the free read of `state_call` `Core_version` at
a block about 1000 below the head, and the record keeps whether the node answered. Nothing in the
batch depends on it.
