# Plan: the chain encoder meets the devnet (D1 and D2)

Prepared on 2026-11-12 and 2026-11-13, fixed after the independent review on 2026-11-13. Nothing in
this folder has been signed or sent.

`imd-flop/src/chain/` (PR 48) encodes and signs `FlopSessionKeys.execute_via_session` around five
`ComputeChannel` calls. Three things about it have never met the chain:

- a mortal era signed by the lab;
- a declared spend exactly equal to the escrow (the one success on chain, rerun A6, declared more);
- the layouts of `open_channel` and `top_up_escrow`, which come from the metadata only.

And one thing is not known: whether an open moves anything beyond the escrow out of the owner's
account. This plan settles these with nine transactions at most, and attempts of a cleanup step.

`steps.json` is the plan as data. Every value in it names the committed file and field it comes
from, or says it is the plan's own choice and why, or how it is computed. The tables and the command
lines below are printed from it by `plan.mjs` (`node plan.mjs md` writes them between their markers),
and `plan.test.mjs` fails if this file and that output part.

## Who signs, with what

- owner: the lab's FLOP identity, `$OWNER` (`rerun` `accounts.owner.public_key`). Three
  transactions: T1, T2, T8. Signed by the research signer,
  `../2026-11-11-session-deny-list/flop-sign.mjs`, with an immortal era, as in the rerun.
- device: a new ed25519 key the lead makes on the PC with `flop-sign.mjs keygen --out <file>`.
  Up to six transactions and the attempts of S5. T3 to T7 are built only by `signSessionCall` of
  `imd-flop/dist/chain/`, through `sign-device.mjs`, with a mortal era of 64 blocks. T9, the sweep,
  is the research signer's, immortal, because the encoder writes only session calls.
- named account: `$NAMED` (`deny` `other_account_named.public_key`), the lab's own account that is
  not a miner, as in the rerun.
- No key's bytes appear anywhere in this folder. The commands name key files by `$KEY_OWNER` and
  `$KEY_DEVICE`. `device-key.mjs` loads the device's key file for `sign-device.mjs` and
  `record-step.mjs`, takes only exactly what `flop-sign.mjs keygen` writes, and prints nothing of it.

The owner's account nonce at the start is read in the pane by `lab.accountReads` and written by
`record-step.mjs start`. It should be `OWNER_NONCE_AFTER_RERUN`, 14 (`run_log` `next_nonce.owner`);
the lead read 14 on 2026-11-13 (`lead-measurements-2026-11-13.json`
`measurements.owner_next_nonce`). If it is not, `start` records it and prints a notice.

## Channel ids are derived

The channel of T3 and the channel of T5 are not read from an event: the pane decodes nothing. They
are `CH_T3` and `CH_T5` of `steps.json`, computed by `lib.mjs` `channelId` in our own lines:
blake2b-256 of `"FLOP/COMPUTE_CHANNEL/ID"`, the byte 1, the genesis, the agent (the owner), the
miner and the channel nonce as a u64 little endian. The lead read the formula in FLOP's SDK 0.6.0
(`channelIdV1`) and checked it against the rerun's force_open
(`lead-measurements-2026-11-13.json` `measurements.channel_id_formula`), and `plan.test.mjs`
derives the rerun's A6 channel id from its own record. The formula is shown for `force_open` only.
`record-step.mjs` refuses an explorer reading whose `channelId` is not the derived one, so T5 shows
it for `open_channel` or refutes it.

## A mortal transaction lives about a minute

A block takes about 1.06 s and the finalized head is 4 to 5 blocks behind the best head, so a
device step lives about 58 blocks, about a minute, from the read of its birth block
(`lead-measurements-2026-11-13.json` `measurements.block_time_s`, `finalized_lag_blocks`,
`mortal_life_blocks`). The PC cannot reach the node (`measurements.pc_reaches_node`): the lead
relays every text by hand, about 14 s a hop (`measurements.relay_hop_s`). So each device step is
three hops, and what crosses is short and carries a sha256 the other side checks:

1. Pane to PC: `lab.deviceReads(device, sessionNonceKey)` gives the runtime's four names, the
   finalized head (the birth block), the device's next nonce and the raw session nonce, as a relay
   text and its sha256.
2. PC to pane: `sign-device.mjs <id> --run <folder> --key <file> --reads '<text>' --reads-sha256
   <sha>` checks the reads and the record, signs, and writes `signed/<id>.json` (the whole record,
   it stays on the PC) and `signed/<id>.send.json`. What crosses is the send file: exactly
   `{"step","extrinsic"}`, about 822 characters (`measurements.send_text_chars`), not the signed
   file of 4607 or 4971 bytes (`measurements.signed_file_bytes_t3`, `signed_file_bytes_t5`).
3. Pane to PC: `lab.send(<send file text>, <its sha256>)` submits it once and watches it. A pane call
   ends after 45 s and the runner's deadline is 120 s (`measurements.pane_call_limit_s`,
   `runner_deadline_s`), so the promise is kept on `window` and read in a second call. Its short
   result and sha256 go to `record-step.mjs step`.

If the last valid block has passed before hop 3, the file is not sent. The lead looks for it with
`lab.find` and signs a second copy only by S4 (`sign-device.mjs --again`), as the send outcomes
below say.

## The steps

<!-- printed by plan.mjs: table -->
| # | Signs | Tool | Call | Moves | Declared | Expected | When | If not |
|---|---|---|---|---|---|---|---|---|
| T1 | owner | research-signer | transfer | 150000000000000000 (0.15 FLOP) owner to device | none | success | in order | stop |
| T2 | owner | research-signer | create-session | nothing | none | success | in order | stop |
| T3 | device | encoder | execute_via_session(force_open) | 10000000000000000 (0.01 FLOP) owner to pallet | 10000000000000000 (0.01 FLOP) | success | in order | stop |
| T4 | device | encoder | execute_via_session(top_up_escrow) | 1000000000000000 (0.001 FLOP) owner to pallet | 1000000000000000 (0.001 FLOP) | recorded, not expected: included in a finalized block, and success or a named error of ComputeChannel or FlopSessionKeys | in order | stop |
| T5 | device | encoder | execute_via_session(open_channel) | 10000000000000000 (0.01 FLOP) owner to pallet | 10000000000000000 (0.01 FLOP) | recorded, not expected: included in a finalized block, and success or a named error of ComputeChannel or FlopSessionKeys | in order | stop |
| T6 | device | encoder | execute_via_session(expire_force_open) | 10000000000000000 (0.01 FLOP) pallet to owner<br>1000000000000000 (0.001 FLOP) pallet to owner if T4 succeeded | 0 (0 FLOP) | success | only if T3 recorded ComputeChannel.ForceOpenRequested; after the greatest of: the block of T3 plus 600 blocks and block $T3.ComputeChannel.ForceOpenRequested.ack_deadline | stop (cleanup) |
| T7 | device | encoder | execute_via_session(timeout) | 10000000000000000 (0.01 FLOP) pallet to owner | 0 (0 FLOP) | success | only if T5 recorded ComputeChannel.ChannelOpened; after the block of T5 plus 120 blocks | stop (cleanup) |
| T8 | owner | research-signer | revoke | nothing | none | success | only if T2 succeeded | stop (cleanup) |
| T9 | device | research-signer | sweep | all it holds device to owner | none | success | only if T1 succeeded | stop (cleanup) |
<!-- end of printed -->

What each step settles:

- T3: a mortal era signed by the lab is taken, and the declared spend equal to the escrow is taken.
  If the chain answers `FlopSessionKeys.SpendExceedsDeclared`, that is a finding about the
  encoder's rule E5, and the batch stops.
- T4: the chain reads the encoder's layout of `top_up_escrow`. Its doc comment speaks of a live
  session, and the channel of T3 waits for an ack, so a refusal such as `ComputeChannel.BadState`
  may come. Either way the step passes when it is included in a finalized block and named.
  `SpendExceedsDeclared` here is a finding about the encoder's declared spend, and the step still
  counts as recorded.
- T5 (D2): the chain reads the encoder's layout of `open_channel`. A refusal named by the 1014020
  table passes the step as T4 does. If it succeeds, a channel is open and T7 closes it.
- T6 and T7: the escrows come back. T6 is signed only from a birth block above the greater of T3's
  block plus the ack window and the explorer's `ackDeadline` of T3; T7 only above T5's block plus
  `MAX_DURATION_D2`.
- Each step's outcome, the ack deadline and whether T5 opened a channel come from FLOP's explorer
  (`EXPLORER`), read by `explorer-reader.js` in a tab on the explorer's own origin, marked as the
  explorer's reading and tied to the runner's block hash and to the derived channel id.

## The two open windows

- The ack window is 600 blocks (`facts` `constants.ComputeChannel.AckWindow.value`). The rerun saw
  the ack deadline 595 blocks after the block of inclusion (rerun A6 `ack_deadline` 3553433, block
  3552838). T6's earliest block is above the greater of T3's block plus `ACK_WINDOW` and
  `$T3.ComputeChannel.ForceOpenRequested.ack_deadline`, as the explorer gives it for T3.
- `MAX_DURATION_D2` is 120 blocks, the plan's choice. The 1014020 metadata states no lower bound:
  no constant and no error names one. The upper bound for an open the miner did not sign is
  `MaxUnconsentedSessionBlocks`, 14400. The channel's `opened_at` is taken to be the block of T5;
  that is not known. If the chain answers `SessionNotExpired`, T7 is refused and T7.2 is the attempt.

## The caps of the session

The session of T2 has the caps of the rerun's session A. Each device step's declared spend is held
against the per transaction limit, and the running sum against the daily cap and the session cap,
each earlier step taken as succeeded. The cap that binds is the one with the least room left after
the step: the daily cap binds from T4 on.

<!-- printed by plan.mjs: caps -->
| # | Declared | Per transaction limit | Sum so far | Daily cap left | Session cap left | Binds |
|---|---|---|---|---|---|---|
| T3 | 10000000000000000 (0.01) | 20000000000000000 (0.02) | 10000000000000000 (0.01) | 15000000000000000 (0.015) | 40000000000000000 (0.04) | per transaction limit |
| T4 | 1000000000000000 (0.001) | 20000000000000000 (0.02) | 11000000000000000 (0.011) | 14000000000000000 (0.014) | 39000000000000000 (0.039) | daily cap |
| T5 | 10000000000000000 (0.01) | 20000000000000000 (0.02) | 21000000000000000 (0.021) | 4000000000000000 (0.004) | 29000000000000000 (0.029) | daily cap |
| T6 | 0 (0) | 20000000000000000 (0.02) | 21000000000000000 (0.021) | 4000000000000000 (0.004) | 29000000000000000 (0.029) | daily cap |
| T7 | 0 (0) | 20000000000000000 (0.02) | 21000000000000000 (0.021) | 4000000000000000 (0.004) | 29000000000000000 (0.029) | daily cap |
<!-- end of printed -->

## What the batch costs

The fee of each step is the one the rerun recorded for a like step (`rerun` `steps[i].fee_raw`).
None exists for T4 and T5: their fees are not known. T7's like step, A3, was a refused timeout, so
its fee is a guess. The encoder's era adds one byte to each device extrinsic. An attempt of S5 costs
one more fee of its step.

<!-- printed by plan.mjs: costs -->
| # | Like step of the rerun | Fee there (raw) | FLOP |
|---|---|---|---|
| T1 | A1 | 2723545745000000 | 0.002723545745 |
| T2 | A2 | 6413391035000000 | 0.006413391035 |
| T3 | A6 | 9422731810000000 | 0.00942273181 |
| T4 | none | unknown | unknown |
| T5 | none | unknown | unknown |
| T6 | A9 | 8639685985000000 | 0.008639685985 |
| T7 | A3 | 10558485985000000 | 0.010558485985 |
| T8 | A10 | 3906000695000000 | 0.003906000695 |
| T9 | A11 | 2770030705000000 | 0.002770030705 |
| sum | | 44433871960000000 and T4, T5 unknown | 0.04443387196 and 2 unknown |

| Locked at | Amount (raw) | FLOP | Comes back |
|---|---|---|---|
| T3 | 10000000000000000 | 0.01 | at T6, after the ack window |
| T4 | 1000000000000000 | 0.001 | at T6 with the escrow, if it moved |
| T5 | 10000000000000000 | 0.01 | at T7, after max_duration, if it moved |
<!-- end of printed -->

The device gets `FUND`, 0.15 FLOP (`escrow` `steps[0].what`). That is more than twice six device
transactions at the rerun's largest fee, `MAX_FEE` (`rerun` `steps[2].fee_raw`), as
`fund_rule` in `steps.json` says and `plan.test.mjs` checks. T9 returns what is left.

## When send ends

`lab.send`, `lab.sendSame` and `lab.find` end in one of the outcomes below, and `plan.test.mjs`
holds a row here for every outcome `pane-runner.js` lists. The rules: a mortal step is signed
again only by S4, and before that the lead uses `lab.find` from the birth block until the finalized
head is above the last valid block. An immortal step (T1, T2, T8, T9) is never signed to different
bytes: the lead uses `lab.find`, then `lab.sendSame`, and signs no later step until it is in a
finalized block or the batch is stopped. An outdated extrinsic comes back as refused-at-submission.
A refusal at submission is read by the node's code: one row for each of 1010, 1013 and 1014, and
one for any other code.

Before the send file of T1, T2, T8 or T9 is written, `record-step.mjs send-file` checks that the
extrinsic's own bytes are the plan's step (`research-signed.mjs`): the signer, the account nonce by
the record, an immortal era, no tip, and the call our research signer prints for the step's line.
`record-step.mjs step` checks it again before it records a reading. The signature is not checked:
a wrong one is refused by the node at no cost.

<!-- printed by plan.mjs: outcomes -->
| Outcome | What is known | The lead | A second copy |
|---|---|---|---|
| finalized | the extrinsic is in a block the node reported finalized, with the block's hash, number and the extrinsic's index, and the sha256 and length of that block's System.Events | record-step.mjs step --sent; then explorer.read and record-step.mjs step --explorer. plan.mjs next says what follows | never |
| finalized-not-found | the node said finalized for a block that does not hold the extrinsic. Not known whether another block holds it | record nothing as included. lab.find from the birth block (mortal) or from the start of the run (immortal), and record what it returns | mortal: only by S4, once find has read up to a finalized head above the last valid block without it. Immortal: never; lab.sendSame |
| finalized-not-canonical | the finalized block's hash is not the block at its height. Not known where the extrinsic is | as finalized-not-found: lab.find, and record what it returns | mortal: only by S4, once find has read up to a finalized head above the last valid block without it. Immortal: never; lab.sendSame |
| finalized-unread | the node said finalized, with the block's hash, but reading that block failed | lab.find from the birth block (mortal) or the start of the run (immortal): it reads the block again | mortal: only by S4, once find has read up to a finalized head above the last valid block without it. Immortal: never; lab.sendSame |
| refused-bundle | nothing was sent: the text or its sha256 changed on its way, or it holds no extrinsic | relay the send file and its sha256 again, exactly | not needed: the same copy is sent |
| already-sent | nothing was submitted by this call, but this page's sent list holds these bytes: they were written to a socket before (H2). It is a reading: record-step.mjs step records it, and nextOf takes the step as sent and not in a finalized block. It may be in the pool or in a block. With it in the record the lead's stop has neither case c nor case d | record it. Then lab.find from the birth block (mortal) or the start of the run (immortal), and record what it returns; if not found, lab.sendSame (immortal) or S4 (mortal) | mortal: only by S4. Immortal: never |
| not-in-sent-list | nothing was sent: sendSame sends only bytes send sent before | use lab.send | not needed |
| not-sent | nothing was written: the connection was not open. Nothing is marked as sent | paste the runner again in a fresh tab on the node, check its sha256, and lab.send the same send file | not needed: the same copy is sent |
| refused-at-submission (node code 1010) | on a first send: the node judged the extrinsic invalid (a bad signature, a used or future nonce it will not keep, a mortal copy whose era is over, or a fee it cannot pay): it is not in the pool and cannot be included as it is, and nothing moved. On a sendSame after an outcome that may still land (deadline, connection-lost, ended), 1010 can mean the first copy is already in a block (its nonce is used) | record it. After a sendSame that followed a deadline, connection-lost or ended: lab.find before anything else, from the block before the first send. After a first send: for an immortal step this is case c of record-step.mjs stop, and the cleanup steps that apply follow; for a mortal step, once the finalized head is above its last valid block, case b, or a second copy by S4 | mortal: by S4, when the nonce rule holds. Immortal: never; the lead stops at the step instead |
| refused-at-submission (node code 1013) | already imported: the node holds these bytes in its pool. It IS in the pool and may be included | treat it as sent: record it, then lab.find from the birth block (mortal) or the start of the run (immortal). No stop by the lead: the copy can land | mortal: by S4 only, once its era is over at a finalized head and find did not see it. Immortal: never |
| refused-at-submission (node code 1014) | the priority is too low: another transaction of the same signer and nonce is in the pool. A copy the record does not hold exists | stop signing and find out which transaction it is (lab.find from the birth block or the start of the run). S2e refuses every device step until the record holds what is on chain. No stop by the lead | never while the other is in the pool; the lead rules |
| refused-at-submission (node code other) | any other code: not in the pool, by the node's word | record it and read the node's words. lab.sendSame of the same bytes later; no stop by the lead (record-step.mjs stop allows case c only with 1010) | mortal: by S4, when the nonce rule holds. Immortal: never; lab.sendSame |
| deadline | no final status before the runner's deadline of 120 s. It may be in the pool, or in a block that is not final (in_block names it) | record it. lab.find from the birth block until the finalized head is above the last valid block (mortal), or until found (immortal). Sign no later step meanwhile | mortal: by S4 only, once its era is over at a finalized head and find did not see it. Immortal: never; lab.sendSame |
| connection-lost | the extrinsic was written, then the connection was lost. It may be in the pool or in a block | paste the runner again in a fresh tab, then as deadline | mortal: by S4 only, once its era is over at a finalized head and find did not see it. Immortal: never; lab.sendSame |
| ended (usurped) | another transaction with the same nonce took its place in the pool: a copy the record does not hold exists | stop signing. lab.find from the birth block for this copy; S2e refuses every device step until the record holds what is on chain | never: the nonce is used |
| ended (finalityTimeout) | it was in a block that did not become final in time. It may still be finalized | lab.find from the birth block, as deadline | mortal: by S4 only, once its era is over at a finalized head and find did not see it. Immortal: never; lab.sendSame |
| ended (dropped) | the pool dropped it. Not in a block, as far as the node knows | lab.find from the birth block, as deadline | mortal: by S4 once its era is over. Immortal: never; lab.sendSame |
| ended (invalid) | the pool found it invalid (for example its nonce was used or its era is over) | lab.find from the birth block; read the record's nonce rule | mortal: by S4 when the nonce rule holds. Immortal: never |
| not-found | find read the finalized blocks of the range it names and the extrinsic is not in them. Above the range, not known | mortal: find again from the end of the range until the finalized head is above the last valid block. Immortal: lab.sendSame, then find again | mortal: by S4, once the finalized head is above the last valid block and the nonce rule holds. Immortal: never |
| find-deadline | find did not finish before the runner's deadline (H10): it read the finalized blocks from its start to the block it names in to (none when to is null) and the extrinsic is not in them. Above that, not known | record it. lab.find again from the block after to (from the same start when to is null), and record what it returns | as not-found: mortal by S4 once the finalized head is above the last valid block and the nonce rule holds. Immortal: never |

The node codes of the rows for refused-at-submission (1010 invalid, 1013 already imported, 1014 priority too low) are from the lead's knowledge of Substrate's author RPC. No committed file of this repo shows them. The first real refusal shows the shape of the node's answer (the runner keeps it as node: { code, message, data }).
<!-- end of printed -->

## The stop rule

Each step's "If not" in the steps table says what the lead does on an answer other than expected.
A stop ends the test steps. The cleanup steps that apply still run, in order, so no escrow and no
fee money is left behind where the batch can bring it back. `judge.mjs` `nextOf` says what is next
by the record, and `plan.mjs next --run <folder>` prints it.

A step that will not come on chain is stopped by the lead with `record-step.mjs stop <id>` and the
lead's words. It is allowed only at the step `plan.mjs next` names, with no finalized reading of it,
and only when its copy cannot land without being sent again: (a) nothing was signed and the record
holds no runner reading of it; (b) a device copy whose era is over by the device's reads, with the
device's nonce unmoved; (c) an owner step or the sweep refused at submission with node code 1010 on
a first send, with no earlier reading (a 1010 to a sendSame after a deadline, a lost connection or
an ended watch can mean the first copy is in a block: the lead uses lab.find instead); (d) an owner
step or the sweep with no runner reading, which the lead says was never sent. For c and d the
reads are lab.accountReads of the step's signer (the owner for T1, T2, T8; the device for T9), the
signed file must be the plan's step, and the signer's next nonce must equal the copy's: the node
counts its pool, so no transaction with that nonce is in a block or in the pool. A nonce above it
refuses the stop and names lab.find and lab.sendSame; one below it refuses: the record and the
chain disagree. If find then reads every finalized block from the record's start to the head
without the copy, a transaction not of this batch used the nonce: these tools go no further at
that step and record no stop (the row "nonce" below). The pane's already-sent is a reading: with
it in the record neither c nor d holds. After c or d what is left names the copy, its extrinsic
hash, its signer and its nonce: it stays valid until that nonce is used, must never be sent, and
the next transaction of that signer ends it. Anything else is refused with the row of the send
outcomes to follow. A stopped test step is a stop there, with the row for refused at submission
below, and the cleanup steps that apply follow. A stopped cleanup step counts as not bringing back
what it should, and the steps after it go on.

A channel id the explorer gives that is not the derived one is recorded with both ids. The judge
stops at that step. Only a mismatch at the step that opens the channel (T3 for CH_T3, T5 for CH_T5)
drops the cleanup step that names it: that step would name a channel that does not exist. After a
mismatch at T4, T6 still applies.

`check.mjs` exits 0 when the record is right and nothing is left on chain, 4 when it is right and
something is left (stopped or not), 1 when it is wrong, 3 for a run time record and 2 for its own
refusals. No verdict begins with "passed" when something is left.

For each step and each answer, what is on chain and what brings it back:

<!-- printed by plan.mjs: stops -->
| Step | Answer | On chain | What brings it back |
|---|---|---|---|
| T1 | success | FUND is on the device | T9 sends it back, less the device's fees |
| T1 | refused in its block | the owner's fee; nothing moved | nothing to bring back; the batch stops and nothing else is sent |
| T1 | refused at submission | nothing of T1: it is not in the pool, no fee is paid and no nonce moves. Nothing else is on chain | nothing is left. Read the row of send_outcomes for the node's code. With 1010 the lead stops at T1 (record-step.mjs stop, case c) and nothing else is sent; it is never signed to different bytes |
| T1 | in a block, not final by the deadline | not known: it is in a block that is not final, and may become final as ok or err, or be retracted | lab.find from the start of the run until found; then the row ok or err. If the pool dropped it, lab.sendSame. No later step is signed meanwhile |
| T1 | no answer | not known: no answer (a deadline with no block, a lost connection, or an end of the watch). It may be in the pool | as nf: lab.find, then lab.sendSame of the same bytes; never other bytes. No later step is signed until it is in a finalized block or the batch is stopped |
| T2 | success | the session of the device is live, bounded by its caps | T8 ends it; else it lapses A_BLOCKS after T2 |
| T2 | refused in its block | the owner's fee; no session | T9 sends the device's FUND back; nothing else is sent |
| T2 | refused at submission | nothing of T2: it is not in the pool, no fee is paid and no nonce moves. T1's FUND is on the device | read the row of send_outcomes for the node's code. With 1010 the lead stops at T2 (record-step.mjs stop, case c); then T9 sends FUND back, less the device's fees. T2 is never signed to different bytes |
| T2 | in a block, not final by the deadline | not known: it is in a block that is not final, and may become final as ok or err, or be retracted | lab.find from the start of the run until found; then the row ok or err. If the pool dropped it, lab.sendSame. No later step is signed meanwhile |
| T2 | no answer | not known: no answer (a deadline with no block, a lost connection, or an end of the watch). It may be in the pool | as nf: lab.find, then lab.sendSame of the same bytes; never other bytes. No later step is signed until it is in a finalized block or the batch is stopped |
| T3 | success | ESCROW_1 is in the pallet account under the channel CH_T3 | T6 brings it back, after the ack window |
| T3 | refused in its block | the device's fee; nothing is locked | T8 and T9 follow; T6 is not needed |
| T3 | refused at submission | nothing of T3: it is not in the pool, no fee is paid and no nonce moves. FUND is on the device and the session of T2 is live | a second copy only by S4 from new reads; or, once its era is over at a finalized head, the lead stops at T3 (record-step.mjs stop, case b); then T8 ends the session and T9 sends FUND back |
| T3 | in a block, not final by the deadline | not known: it is in a block that is not final, and may become final as ok or err, or be retracted | lab.find from its birth block until the finalized head is above its last valid block; what find returns is then the row ok, err or sub. S2e refuses every device step meanwhile |
| T3 | no answer | not known: no answer (a deadline with no block, a lost connection, or an end of the watch). It may be in the pool | as nf. Once the finalized head is above its last valid block, find has not seen it and the device's nonce is unchanged, the copy is dead and S4 signs a second one |
| T4 | success | TOP_UP is in the pallet account under CH_T3, beside the escrow of T3 | T6, if expire_force_open refunds a top up (not known); if it does not, nothing in this batch brings it back and the verdict says so (C6) |
| T4 | refused in its block | the device's fee; nothing moved | a named error is recorded and the batch goes on; an unnamed one stops it, and T6, T8, T9 follow |
| T4 | refused at submission | nothing of T4: it is not in the pool, no fee is paid and no nonce moves. ESCROW_1 is under CH_T3, FUND on the device, the session live | a second copy only by S4 from new reads; or, once its era is over, the lead stops at T4 (case b); then T6 brings ESCROW_1 back after the ack window, T8 and T9 follow |
| T4 | in a block, not final by the deadline | not known: it is in a block that is not final, and may become final as ok or err, or be retracted | lab.find from its birth block until the finalized head is above its last valid block; what find returns is then the row ok, err or sub. S2e refuses every device step meanwhile |
| T4 | no answer | not known: no answer (a deadline with no block, a lost connection, or an end of the watch). It may be in the pool | as nf. Once the finalized head is above its last valid block, find has not seen it and the device's nonce is unchanged, the copy is dead and S4 signs a second one |
| T5 | success | ESCROW_1 is in the pallet account under the channel CH_T5 | T7 brings it back, after MAX_DURATION_D2 |
| T5 | refused in its block | the device's fee; nothing is locked | a named error is recorded and T7 is not needed; an unnamed one stops the batch, and T6, T8, T9 follow |
| T5 | refused at submission | nothing of T5: it is not in the pool, no fee is paid and no nonce moves. ESCROW_1 and the top up of T4 are under CH_T3, FUND on the device, the session live | a second copy only by S4 from new reads; or, once its era is over, the lead stops at T5 (case b); then T6, T8 and T9; T7 is not needed |
| T5 | in a block, not final by the deadline | not known: it is in a block that is not final, and may become final as ok or err, or be retracted | lab.find from its birth block until the finalized head is above its last valid block; what find returns is then the row ok, err or sub. S2e refuses every device step meanwhile |
| T5 | no answer | not known: no answer (a deadline with no block, a lost connection, or an end of the watch). It may be in the pool | as nf. Once the finalized head is above its last valid block, find has not seen it and the device's nonce is unchanged, the copy is dead and S4 signs a second one |
| T6 | success | the escrow of T3 is back with the owner (and the top up, if it was refunded) | nothing is left of T3 |
| T6 | refused in its block | the device's fee; the escrow of T3 (and the top up of T4) stays under CH_T3 | T6.2 and T6.3 (S5) while the session lasts; if all are refused it stays, and the batch stops there with T8 and T9 still to send |
| T6 | refused at submission | nothing of T6: it is not in the pool, no fee is paid and no nonce moves. What T3 and T4 locked stays under CH_T3 | a second copy only by S4 from new reads; or, once its era is over, the lead stops T6 (case b): it then counts as not bringing back the escrow of CH_T3, which is left, and the cleanup steps after it go on |
| T6 | in a block, not final by the deadline | not known: it is in a block that is not final, and may become final as ok or err, or be retracted | lab.find from its birth block until the finalized head is above its last valid block; what find returns is then the row ok, err or sub. S2e refuses every device step meanwhile |
| T6 | no answer | not known: no answer (a deadline with no block, a lost connection, or an end of the watch). It may be in the pool | as nf. Once the finalized head is above its last valid block, find has not seen it and the device's nonce is unchanged, the copy is dead and S4 signs a second one |
| T7 | success | the escrow of T5 is back with the owner | nothing is left of T5 |
| T7 | refused in its block | the device's fee; the escrow of T5 stays under CH_T5 | T7.2 and T7.3 (S5) while the session lasts; if all are refused it stays, and T8 and T9 still follow |
| T7 | refused at submission | nothing of T7: it is not in the pool, no fee is paid and no nonce moves. ESCROW_1 of T5 stays under CH_T5 | a second copy only by S4 from new reads; or, once its era is over, the lead stops T7 (case b): it then counts as not bringing back the escrow of CH_T5, which is left, and T8 and T9 go on |
| T7 | in a block, not final by the deadline | not known: it is in a block that is not final, and may become final as ok or err, or be retracted | lab.find from its birth block until the finalized head is above its last valid block; what find returns is then the row ok, err or sub. S2e refuses every device step meanwhile |
| T7 | no answer | not known: no answer (a deadline with no block, a lost connection, or an end of the watch). It may be in the pool | as nf. Once the finalized head is above its last valid block, find has not seen it and the device's nonce is unchanged, the copy is dead and S4 signs a second one |
| T8 | success | the session is ended | nothing |
| T8 | refused in its block | the owner's fee; the session stays, bounded by its caps, until A_BLOCKS after T2 | T8.2 and T8.3 (S5); T9 is sent anyway |
| T8 | refused at submission | nothing of T8: it is not in the pool, no fee is paid and no nonce moves. The session stays live until it lapses A_BLOCKS after T2 | read the row of send_outcomes for the node's code. With 1010 the lead stops T8 (case c): the session is left to lapse, and T9 goes on. T8 is never signed to different bytes |
| T8 | in a block, not final by the deadline | not known: it is in a block that is not final, and may become final as ok or err, or be retracted | lab.find from the start of the run until found; then the row ok or err. If the pool dropped it, lab.sendSame. No later step is signed meanwhile |
| T8 | no answer | not known: no answer (a deadline with no block, a lost connection, or an end of the watch). It may be in the pool | as nf: lab.find, then lab.sendSame of the same bytes; never other bytes. No later step is signed until it is in a finalized block or the batch is stopped |
| T9 | success | the device is empty and gone from chain state | nothing |
| T9 | refused in its block | the device's fee; what the device holds stays on it, at most FUND less its fees | T9.2 and T9.3 (S5), each with the device's next nonce |
| T9 | refused at submission | nothing of T9: it is not in the pool, no fee is paid and no nonce moves. What the device holds stays on it | read the row of send_outcomes for the node's code. With 1010 the lead stops T9 (case c): the device's rest is left, and a later piece of work brings it back. T9 is never signed to different bytes |
| T9 | in a block, not final by the deadline | not known: it is in a block that is not final, and may become final as ok or err, or be retracted | lab.find from the start of the run until found; then the row ok or err. If the pool dropped it, lab.sendSame. No later step is signed meanwhile |
| T9 | no answer | not known: no answer (a deadline with no block, a lost connection, or an end of the watch). It may be in the pool | as nf: lab.find, then lab.sendSame of the same bytes; never other bytes. No later step is signed until it is in a finalized block or the batch is stopped |
| T3 | a channel id the explorer gives that is not the derived one (G4) | the explorer names a channel id for T3 that is not the derived CH_T3 (results.json run_time.explorer.channel_mismatch holds both): ESCROW_1 is in the pallet account under the channel id the explorer gave | nothing in this batch: the judge stops at T3, and T6, which names CH_T3, does not apply (it would name a channel that does not exist). T8 and T9 follow. A later piece of work brings the escrow back under the explorer's channel id |
| T4 | a channel id the explorer gives that is not the derived one (G4) | the explorer names a channel id for T4 that is not the derived CH_T3: the top up is under the channel id the explorer gave | the judge stops at T4. T6 still applies: it names CH_T3, which T3 opened under the derived id, and brings back what is under it (H9). T8 and T9 follow. A later piece of work brings back the top up under the explorer's channel id |
| T5 | a channel id the explorer gives that is not the derived one (G4) | the explorer names a channel id for T5 that is not the derived CH_T5: ESCROW_1 of T5 is under the channel id the explorer gave | nothing in this batch: the judge stops at T5, and T7, which names CH_T5, does not apply; T6, T8 and T9 follow. A later piece of work brings the escrow back under the explorer's channel id |
| T6 | a channel id the explorer gives that is not the derived one (G4) | the explorer names a channel id for T6 that is not the derived CH_T3 | the judge counts T6 as not bringing back what it should: the escrow is left under the explorer's channel id, and the cleanup steps after it go on. A later piece of work brings it back |
| T7 | a channel id the explorer gives that is not the derived one (G4) | the explorer names a channel id for T7 that is not the derived CH_T5 | the judge counts T7 as not bringing back what it should: the escrow is left under the explorer's channel id, and T8 and T9 go on. A later piece of work brings it back |
| T1 | the signer's nonce used by a transaction not of this batch (H1) | the owner's nonce of T1 was used by a transaction that is not of this batch: find read the finalized blocks from the record's start to the head without T1, and the owner's next nonce is above T1's. Nothing of this batch is on chain | nothing of this batch is left. These tools go no further at T1 and record no stop: the record says no more than is known. The lead rules; a later piece of work finds that transaction |
| T2 | the signer's nonce used by a transaction not of this batch (H1) | the owner's nonce of T2 was used by a transaction that is not of this batch: find read the finalized blocks from the record's start to the head without T2, and the owner's next nonce is above T2's. T1's FUND is on the device | what T1 left stays: FUND on the device. These tools go no further at T2 and record no stop, so T9 is not reached by them: a later piece of work brings FUND back |
| T8 | the signer's nonce used by a transaction not of this batch (H1) | the owner's nonce of T8 was used by a transaction that is not of this batch: find read the finalized blocks from the record's start to the head without T8, and the owner's next nonce is above T8's. The session of T2 stays live until it lapses A_BLOCKS after T2, and what the device holds stays on it | what the steps before left stays: the session until it lapses, the device's rest, and whatever the escrows of T3 to T7 left. These tools go no further at T8 and record no stop, so T9 is not reached by them: a later piece of work brings it back |
| T9 | the signer's nonce used by a transaction not of this batch (H1) | the device's nonce of T9 was used by a transaction that is not of this batch: find read the finalized blocks from the record's start to the head without T9, and the device's next nonce is above T9's. What the device holds stays on it, as far as this batch knows | what the steps before left stays: the device's rest, and whatever the escrows of T3 to T7 left. These tools go no further at T9 and record no stop: a later piece of work brings it back |
| session | lapsed | the session has lapsed, A_BLOCKS after T2, before a cleanup step that goes through it (T6 or T7): their escrows stay under CH_T3 and CH_T5 | nothing in this batch: the owner's own call (expire_force_open and timeout are permissionless) brings them back in a later piece of work. T8 is not needed then; T9 still follows |
<!-- end of printed -->

## What is not known

- Whether `expire_force_open` refunds a top up. If T6 refunds the escrow alone, the top up stays
  in the pallet account under `CH_T3`, no step of this batch brings it back, and the verdict says so.
- Whether T5's `opened_at` is T5's block.
- The fees of T4 and T5.
- That the channel id formula holds for `open_channel`: it is shown for `force_open` only.
- The shapes of the node's transaction statuses come from the lead's and the reviewer's knowledge
  of Substrate, not from a committed file.

## The command lines

The reader's list. At run time `node plan.mjs next --run "$RUN"` prints only the next step's lines,
with every value filled from the record.

<!-- printed by plan.mjs: commands -->
```
# RUN is the run folder on the PC (record-step.mjs start makes its results.json); LAB is the repo checkout
# KEY_OWNER and KEY_DEVICE name the key files; FLOP_SIGN_LIBS names the libraries (LAB/imd-flop)
# OWNER_NONCE is the owner's next nonce at the start; DEVICE_NONCE the device's transactions included before T9
# the node's tab, https://rpc.devnet.flop.network/: put the text of pane-runner.js in window.__src, check its sha256 there, then run it and make the runner
#   sha256 of pane-runner.js: f034f6edc5d3a81218b67c3545bc5ba43d363ffd0fbd39a625c315cf235b5a78
#   [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(window.__src)))].map((b) => b.toString(16).padStart(2, "0")).join("")
#   (0, eval)(window.__src); const lab = paneRunner.createRunner()
# the explorer's tab, https://explorer.devnet.flop.network/: the same with explorer-reader.js
#   sha256 of explorer-reader.js: 26a479201af916eb7f0896e173fc7d89bb95b4bdac0e6f106caf5cf06e6c2c33
#   (0, eval)(window.__src); const explorer = explorerReader.createReader()
# a pane call ends after 45 s: keep each promise on window and read it in a second call
# plan.mjs next --run "$RUN" prints the lines of the next step only, with every value filled

# T1: owner signs with the research-signer; expect success
#  immortal: never signed to different bytes
#  PC:
mkdir -p "$RUN/calls" "$RUN/signed"
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call transfer --to $DEVICE --amount 150000000000000000 > "$RUN/calls/T1.json"
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key "$KEY_OWNER" --call "$(node -p 'require(process.argv[1]).call' "$RUN/calls/T1.json")" --nonce $((OWNER_NONCE+0)) --out "$RUN/signed/T1.json" --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631
#  send-file writes the send file only when the extrinsic's bytes are the plan's step: signer, nonce, immortal, no tip, this call (F1)
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" send-file T1 --run "$RUN"
#  pane, tab on the node (https://rpc.devnet.flop.network/):
window.__s = lab.send('<the second line send-file printed: the text of signed/T1.send.json>', "<its send_sha256>")
await window.__s   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" step T1 --run "$RUN" --sent '<relay>' --sent-sha256 <relay_sha256>
#  pane, tab on the explorer (https://explorer.devnet.flop.network/):
window.__e = explorer.read("<extrinsic_hash of signed/T1.json>")
await window.__e   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" step T1 --run "$RUN" --explorer '<relay>' --explorer-sha256 <relay_sha256>

# T2: owner signs with the research-signer; expect success
#  immortal: never signed to different bytes
#  PC:
mkdir -p "$RUN/calls" "$RUN/signed"
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call create-session --delegate $DEVICE --cap 50000000000000000 --per-tx 20000000000000000 --daily 25000000000000000 --blocks 7200 --allow ComputeChannel > "$RUN/calls/T2.json"
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key "$KEY_OWNER" --call "$(node -p 'require(process.argv[1]).call' "$RUN/calls/T2.json")" --nonce $((OWNER_NONCE+1)) --out "$RUN/signed/T2.json" --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631
#  send-file writes the send file only when the extrinsic's bytes are the plan's step: signer, nonce, immortal, no tip, this call (F1)
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" send-file T2 --run "$RUN"
#  pane, tab on the node (https://rpc.devnet.flop.network/):
window.__s = lab.send('<the second line send-file printed: the text of signed/T2.send.json>', "<its send_sha256>")
await window.__s   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" step T2 --run "$RUN" --sent '<relay>' --sent-sha256 <relay_sha256>
#  pane, tab on the explorer (https://explorer.devnet.flop.network/):
window.__e = explorer.read("<extrinsic_hash of signed/T2.json>")
await window.__e   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" step T2 --run "$RUN" --explorer '<relay>' --explorer-sha256 <relay_sha256>

# T3: device signs with the encoder; expect success
#  mortal, 64 blocks: read, sign and send it within a minute
#  pane, tab on the node (https://rpc.devnet.flop.network/):
window.__r = lab.deviceReads("$DEVICE_SS58", "<session_nonce of flop-sign.mjs keys --owner $OWNER --delegate $DEVICE>")
await window.__r   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/sign-device.mjs" T3 --run "$RUN" --key "$KEY_DEVICE" --reads '<relay>' --reads-sha256 <relay_sha256>
#  pane, tab on the node (https://rpc.devnet.flop.network/):
window.__s = lab.send('<the second line sign-device printed: the text of signed/T3.send.json>', "<its send_sha256>")
await window.__s   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" step T3 --run "$RUN" --sent '<relay>' --sent-sha256 <relay_sha256>
#  pane, tab on the explorer (https://explorer.devnet.flop.network/):
window.__e = explorer.read("<extrinsic_hash of signed/T3.json>")
await window.__e   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" step T3 --run "$RUN" --explorer '<relay>' --explorer-sha256 <relay_sha256>

# T4: device signs with the encoder; expect the outcome to be recorded
#  mortal, 64 blocks: read, sign and send it within a minute
#  pane, tab on the node (https://rpc.devnet.flop.network/):
window.__r = lab.deviceReads("$DEVICE_SS58", "<session_nonce of flop-sign.mjs keys --owner $OWNER --delegate $DEVICE>")
await window.__r   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/sign-device.mjs" T4 --run "$RUN" --key "$KEY_DEVICE" --reads '<relay>' --reads-sha256 <relay_sha256>
#  pane, tab on the node (https://rpc.devnet.flop.network/):
window.__s = lab.send('<the second line sign-device printed: the text of signed/T4.send.json>', "<its send_sha256>")
await window.__s   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" step T4 --run "$RUN" --sent '<relay>' --sent-sha256 <relay_sha256>
#  pane, tab on the explorer (https://explorer.devnet.flop.network/):
window.__e = explorer.read("<extrinsic_hash of signed/T4.json>")
await window.__e   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" step T4 --run "$RUN" --explorer '<relay>' --explorer-sha256 <relay_sha256>

# T5: device signs with the encoder; expect the outcome to be recorded
#  mortal, 64 blocks: read, sign and send it within a minute
#  pane, tab on the node (https://rpc.devnet.flop.network/):
window.__r = lab.deviceReads("$DEVICE_SS58", "<session_nonce of flop-sign.mjs keys --owner $OWNER --delegate $DEVICE>")
await window.__r   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/sign-device.mjs" T5 --run "$RUN" --key "$KEY_DEVICE" --reads '<relay>' --reads-sha256 <relay_sha256>
#  pane, tab on the node (https://rpc.devnet.flop.network/):
window.__s = lab.send('<the second line sign-device printed: the text of signed/T5.send.json>', "<its send_sha256>")
await window.__s   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" step T5 --run "$RUN" --sent '<relay>' --sent-sha256 <relay_sha256>
#  pane, tab on the explorer (https://explorer.devnet.flop.network/):
window.__e = explorer.read("<extrinsic_hash of signed/T5.json>")
await window.__e   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" step T5 --run "$RUN" --explorer '<relay>' --explorer-sha256 <relay_sha256>

# T6: device signs with the encoder; expect success; only if T3 recorded ComputeChannel.ForceOpenRequested; after the greatest of: the block of T3 plus 600 blocks and block $T3.ComputeChannel.ForceOpenRequested.ack_deadline
#  mortal, 64 blocks: read, sign and send it within a minute
#  pane, tab on the node (https://rpc.devnet.flop.network/):
window.__r = lab.deviceReads("$DEVICE_SS58", "<session_nonce of flop-sign.mjs keys --owner $OWNER --delegate $DEVICE>")
await window.__r   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/sign-device.mjs" T6 --run "$RUN" --key "$KEY_DEVICE" --reads '<relay>' --reads-sha256 <relay_sha256>
#  pane, tab on the node (https://rpc.devnet.flop.network/):
window.__s = lab.send('<the second line sign-device printed: the text of signed/T6.send.json>', "<its send_sha256>")
await window.__s   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" step T6 --run "$RUN" --sent '<relay>' --sent-sha256 <relay_sha256>
#  pane, tab on the explorer (https://explorer.devnet.flop.network/):
window.__e = explorer.read("<extrinsic_hash of signed/T6.json>")
await window.__e   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" step T6 --run "$RUN" --explorer '<relay>' --explorer-sha256 <relay_sha256>

# T7: device signs with the encoder; expect success; only if T5 recorded ComputeChannel.ChannelOpened; after the block of T5 plus 120 blocks
#  mortal, 64 blocks: read, sign and send it within a minute
#  pane, tab on the node (https://rpc.devnet.flop.network/):
window.__r = lab.deviceReads("$DEVICE_SS58", "<session_nonce of flop-sign.mjs keys --owner $OWNER --delegate $DEVICE>")
await window.__r   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/sign-device.mjs" T7 --run "$RUN" --key "$KEY_DEVICE" --reads '<relay>' --reads-sha256 <relay_sha256>
#  pane, tab on the node (https://rpc.devnet.flop.network/):
window.__s = lab.send('<the second line sign-device printed: the text of signed/T7.send.json>', "<its send_sha256>")
await window.__s   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" step T7 --run "$RUN" --sent '<relay>' --sent-sha256 <relay_sha256>
#  pane, tab on the explorer (https://explorer.devnet.flop.network/):
window.__e = explorer.read("<extrinsic_hash of signed/T7.json>")
await window.__e   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" step T7 --run "$RUN" --explorer '<relay>' --explorer-sha256 <relay_sha256>

# T8: owner signs with the research-signer; expect success; only if T2 succeeded
#  immortal: never signed to different bytes
#  PC:
mkdir -p "$RUN/calls" "$RUN/signed"
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call revoke --delegate $DEVICE > "$RUN/calls/T8.json"
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key "$KEY_OWNER" --call "$(node -p 'require(process.argv[1]).call' "$RUN/calls/T8.json")" --nonce $((OWNER_NONCE+2)) --out "$RUN/signed/T8.json" --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631
#  send-file writes the send file only when the extrinsic's bytes are the plan's step: signer, nonce, immortal, no tip, this call (F1)
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" send-file T8 --run "$RUN"
#  pane, tab on the node (https://rpc.devnet.flop.network/):
window.__s = lab.send('<the second line send-file printed: the text of signed/T8.send.json>', "<its send_sha256>")
await window.__s   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" step T8 --run "$RUN" --sent '<relay>' --sent-sha256 <relay_sha256>
#  pane, tab on the explorer (https://explorer.devnet.flop.network/):
window.__e = explorer.read("<extrinsic_hash of signed/T8.json>")
await window.__e   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" step T8 --run "$RUN" --explorer '<relay>' --explorer-sha256 <relay_sha256>

# T9: device signs with the research-signer; expect success; only if T1 succeeded
#  immortal: never signed to different bytes
#  PC:
mkdir -p "$RUN/calls" "$RUN/signed"
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call sweep --to 0xe462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2 > "$RUN/calls/T9.json"
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key "$KEY_DEVICE" --call "$(node -p 'require(process.argv[1]).call' "$RUN/calls/T9.json")" --nonce $DEVICE_NONCE --out "$RUN/signed/T9.json" --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631
#  send-file writes the send file only when the extrinsic's bytes are the plan's step: signer, nonce, immortal, no tip, this call (F1)
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" send-file T9 --run "$RUN"
#  pane, tab on the node (https://rpc.devnet.flop.network/):
window.__s = lab.send('<the second line send-file printed: the text of signed/T9.send.json>', "<its send_sha256>")
await window.__s   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" step T9 --run "$RUN" --sent '<relay>' --sent-sha256 <relay_sha256>
#  pane, tab on the explorer (https://explorer.devnet.flop.network/):
window.__e = explorer.read("<extrinsic_hash of signed/T9.json>")
await window.__e   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" step T9 --run "$RUN" --explorer '<relay>' --explorer-sha256 <relay_sha256>
```
<!-- end of printed -->
