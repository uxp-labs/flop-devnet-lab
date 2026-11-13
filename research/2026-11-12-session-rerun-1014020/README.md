# The session tests again, at spec 1014020

Run by the lead on 2026-11-12, after the owner said yes: 23 transactions on FLOP Devnet, blocks
3552721 to 3553566, every block executed by spec 1014020. 22 of the 23 steps pass `check.mjs`
whole. A10 passes in its events and result and is incomplete for one read, which the lab's
decoder does not state (below). No step answered otherwise than `steps.json` expects.

Everything below is written from `results.json` (sha256
`d4f92522f94f594de59b0ac8ada1b60e669479c09609687bacba44faa6fb4f10`) and the output of
`node check.mjs results.json`.

On 2026-11-13 the fill was run again with decoder-shape@3 (observatory review round 29), which
states `FlopSessionKeys.DelegateSessions` and `ComputeChannel.FailedAcks`. A10's
`delegate_sessions_of_device` is now decoded: an empty list (the node's bytes were `0x00`), and its
`reads_not_decoded` note is gone. `filled_from` names the shape format. Nothing else changed.
`results.json` is now sha256 `47292f1ec4af70d77709353307492e45ad022d79ef612c664acd5eba405049c5`, and
`node check.mjs results.json` says 23 pass.

## What was run

The order of `plan.md`, signed with `../2026-11-11-session-deny-list/flop-sign.mjs --spec 1014020`
on the owner's computer, sent one at a time and each waited to finality (`results.json` `run.how`).

- Session A (owner and dev1): the probe's two calls and the escrow test's five, in one session with
  `ComputeChannel` as the only allowed pallet and the escrow test's caps.
- Session B (owner and dev2): the deny list test's nine calls, with its allow list of nine names.
- Each session revoked; dev1 sent what it held to dev2, and dev2 everything back to the owner.

## How the record was made

- At run time the lead kept, for each step, the signer, nonce, call, extrinsic hash, block number
  and hash, extrinsic index, and the sha256 of the block's `System.Events` bytes.
- The observatory's fourth request list then read every one of those blocks:
  `observatory/fixtures/recording-20261112132634-0a472f1b49f7b661`, 48 of 48 calls answered. For
  each step the hash at its height and one `state_queryStorageAt` at that hash, for the block's
  events, its `System.LastRuntimeUpgrade` and the stored values the step names.
- Every block hash on the recording equals the one `results.json` gives, and the sha256 of every
  `System.Events` value equals `events_value_sha256`: two independent reads agree.
- `observatory/scripts/fill-rerun-results.mjs` filled `last_runtime_upgrade_spec`, `events`,
  `result`, `fee_raw` and the values of `reads_after` from the recording, through the lab's
  decoder's one door (`observatory/src/scale/block.ts`). `results.json` `filled_from` says so.
  Every other field is the lead's.

## Results

| Step | Block | Expected at 1014020 | Seen | Fee (raw) |
|---|---|---|---|---|
| A1 | 3552721 | success | success | 2723545745000000 |
| A2 | 3552729 | success | success | 6413391035000000 |
| A3 | 3552814 | ComputeChannel.ChannelNotFound | ComputeChannel.ChannelNotFound | 10558485985000000 |
| A4 | 3552822 | FlopSessionKeys.PalletNotAllowed | FlopSessionKeys.PalletNotAllowed | 4303715650000000 |
| A5 | 3552830 | FlopSessionKeys.SpendExceedsDeclared | FlopSessionKeys.SpendExceedsDeclared | 9422731810000000 |
| A6 | 3552838 | success | success | 9422731810000000 |
| A7 | 3552846 | FlopSessionKeys.PerTxLimitExceeded | FlopSessionKeys.PerTxLimitExceeded | 9422731810000000 |
| A8 | 3552854 | FlopSessionKeys.DailyCapExceeded | FlopSessionKeys.DailyCapExceeded | 9422731810000000 |
| A9 | 3553458 | success | success | 8639685985000000 |
| A10 | 3553465 | success | success | 3906000695000000 |
| A11 | 3553473 | success | success | 2770030705000000 |
| B1 | 3553481 | success | success | 6413391430000000 |
| B2 | 3553488 | FlopSessionKeys.PalletNotAllowed | FlopSessionKeys.PalletNotAllowed | 4191546515000000 |
| B3 | 3553495 | FlopSessionKeys.PalletNotAllowed | FlopSessionKeys.PalletNotAllowed | 4670915255000000 |
| B4 | 3553503 | FlopSessionKeys.PalletNotAllowed | FlopSessionKeys.PalletNotAllowed | 4732078660000000 |
| B5 | 3553510 | FlopSessionKeys.PalletNotAllowed | FlopSessionKeys.PalletNotAllowed | 4631785825000000 |
| B6 | 3553518 | FlopSessionKeys.PalletNotAllowed | FlopSessionKeys.PalletNotAllowed | 5508922285000000 |
| B7 | 3553526 | FlopSessionKeys.PalletNotAllowed | FlopSessionKeys.PalletNotAllowed | 5076400835000000 |
| B8 | 3553534 | FlopSessionKeys.PalletNotAllowed | FlopSessionKeys.PalletNotAllowed | 5936920985000000 |
| B9 | 3553543 | ComputeChannel.ChannelNotFound | ComputeChannel.ChannelNotFound | 10558485985000000 |
| B10 | 3553551 | success | success | 4303722570000000 |
| B11 | 3553558 | success | success | 3906000695000000 |
| B12 | 3553566 | success | success | 2770030705000000 |

`check.mjs`: 22 pass, 0 differ, 1 incomplete (A10: `read delegate_sessions_of_device is missing`),
0 not run. With that one read given, every step passes and the run's balance check holds.

## The cost

- Fees: 139705984785000000 raw (0.139705984785 FLOP), the sum of `fee_raw`. The owner's free
  balance fell by exactly that, from 24847973306290000000 to 24708267321505000000
  (`owner_free_balance_raw`): nothing but fees left the owner.
- The estimate was 0.134752084785 FLOP, the 1014014 fees. 4953900000000000 raw more was paid, all
  in three calls: `create_session` 1261905000000000 more each (A2, B1), `ComputeChannel.timeout`
  through a session 810030000000000 more each (A3, B9), and the expire through a session at A9
  810030000000000 more. Every other step paid exactly its 1014014 fee.
- The 0.15 FLOP sent to dev1 came back to the owner at B12, less the devices' fees. The 0.01 FLOP of
  escrow locked at A6 came back at A9.

## The A10 read the decoder does not state

- What is on the recording: at A10's block the node answers bytes `0x00` for
  `FlopSessionKeys.DelegateSessions` of dev1 (`results.json` A10 `reads_not_decoded`).
- The lab's decoder reads only the storage entries its reviewed shape states, and
  `DelegateSessions` is not one. So `reads_after.delegate_sessions_of_device` stays null: unknown to
  the decoder, never guessed.
- Read by position, not through the decoder: the entry's value type in the 1014020 metadata (type
  700) is a sequence, and `0x00` is a sequence of length 0, an empty list.

## The claims of the three earlier tests at spec 1014020

What rests on events: the outcome and error of every step, what moved and who paid each fee,
`SessionCallExecuted`'s running totals, the ack deadline, and the acceptance of a `force_open`
naming a non miner. What rests on stored values: the session records, nonces and breakers read
after the steps (decoded through the door), and `FailedAcks` of the named account at A9, which the
batch answer lists with null, so the node holds nothing there (no decode needed).

Shown at spec 1014020, as at spec 1014014:

- probe:12, probe:14, probe:17, probe:19: events and results of A2, A3, A4.
- probe:23: A3's events, and its nonce and session counters read after it. Its breaker is not read
  at A3; the breaker's `tx_count` of 1 at A6 and A8, after the first success, bears on it.
- probe:25: the device paid the fee of each failed call (A3, A4). The amount at A3 is different
  (below).
- probe:27: creating and revoking moved nothing but the fee, no `Reserved` or `Held` (A2, A10).
  The amount of `create_session` is different (below).
- probe:28: the events of A10, and the session record read after it with `active` false. That
  `DelegateSessions` is empty rests on the by position reading above, not on the decoder.
- escrow:18, escrow:19, escrow:20, escrow:21, escrow:22, escrow:26, escrow:28, escrow:30,
  escrow:31, escrow:33, escrow:35, escrow:94: A5 to A9, events and reads.
- escrow:44: the `force_open` naming a non miner was accepted (A6, by its events). The capacity
  floor `plan.md` guessed at did not refuse it, and no charge on top of the escrow was taken: the
  owner's transfer at A6 and the return at A9 are each 0.01 FLOP.
- escrow:46: no `FailedAcks` for the named account after the unanswered `force_open` (A9).
- escrow:96: the ack deadline is 595 blocks after the block of inclusion, under the window of 600.
- escrow:99: the breaker counts the call that succeeded, `tx_count` 1 at A8 after a refusal.
- deny:12, deny:32, deny:35: the seven pallets are refused with `PalletNotAllowed` even when
  listed, the same error as an unlisted one (B2 to B8, A4).
- deny:28, deny:37, deny:39, deny:41: B1, B9, B10, with the nonces read after B9 and B10.

Shown differently:

- The fee amounts of `create_session` (probe:27), and of `timeout` and `expire` through a session
  (probe:25 for A3). The devices still pay; the amounts are higher at spec 1014020. Fees were
  compared, not judged (`plan.md`).

Left untested, as `plan.md` lists: escrow:44's channel state `PendingAck` and escrow:96's value of
`opened_at` (no read of `Channels`), escrow:99 to 101 (a new breaker period), deny:37 to 38 (the
stored allow list names), escrow:38 to 40 (source only, the doc comment's sha256 is unchanged), and
the signer's bytes against a reference encoder at spec 1014020 (the node accepted all 23).

## Tested

- `node check.mjs results.json`: the verdict above. `observatory/test/rerun-results.test.ts` pins
  it exactly through the checker's own module.
- `observatory/test/rerun-recording.test.ts`: the fixture, every hash, every events sha256, every
  block's runtime.
- `observatory/test/rerun-results.test.ts`: `results.json` is byte for byte the fill, the fill
  gives every filled field back from the recording alone, the lead's fields are untouched, the fees
  add up to the balance's fall.
- `node --test check.test.mjs`: the checker's own tests, from before the run.

## Source only

- `flop-sign.mjs` makes every call of the plan with flags: read from its source.
- The doc comments of the six calls the plan sends are the same at both specs (sha256 in
  `facts-1014020.json`).

## Unresolved

- No reference encoder check of the signer at spec 1014020.

## Not done

- `ComputeChannel.FailedAcks` and `FlopSessionKeys.DelegateSessions` are not stated in the reviewed
  shape. When a view needs them, they go in with a new shape version and its review, and the fill
  is run again.
- Claims left out of the rerun, with the reason for each, are listed in `plan.md`.
