# Plan: the chain encoder meets the devnet (D1 and D2)

Prepared on 2026-11-12 and 2026-11-13. Nothing in this folder has been signed or sent.

`imd-flop/src/chain/` (PR 48) encodes and signs `FlopSessionKeys.execute_via_session` around five
`ComputeChannel` calls. Three things about it have never met the chain:

- a mortal era signed by the lab;
- a declared spend exactly equal to the escrow (the one success on chain, rerun A6, declared more);
- the layouts of `open_channel` and `top_up_escrow`, which come from the metadata only.

And one thing is not known: whether an open moves anything beyond the escrow out of the owner's
account. This plan settles these with nine transactions at most.

`steps.json` is the plan as data. Every value in it names the committed file and field it comes
from, or says it is the plan's own choice and why. The tables and the command lines below are
printed from it by `plan.mjs`, and `plan.test.mjs` fails if this file and that output part.

## Who signs, with what

- owner: the lab's FLOP identity, `$OWNER` (`rerun` `accounts.owner.public_key`). Three
  transactions: T1, T2, T8. Signed by the research signer,
  `../2026-11-11-session-deny-list/flop-sign.mjs`, with an immortal era, as in the rerun.
- device: a new ed25519 key the lead makes on the PC with `flop-sign.mjs keygen --out <file>`.
  Up to six transactions. T3 to T7 are built only by `signSessionCall` of
  `imd-flop/dist/chain/`, through `sign-device.mjs`, with a mortal era of 64 blocks. T9, the sweep,
  is the research signer's, immortal, because the encoder writes only session calls.
- named account: `$NAMED` (`deny` `other_account_named.public_key`), the lab's own account that is
  not a miner, as in the rerun.
- No key's bytes appear anywhere in this folder. The commands name key files by `$KEY_OWNER` and
  `$KEY_DEVICE`. `sign-device.mjs` loads the key file itself and prints nothing of it.

The owner's account nonce at the start is read from the chain before T1. It should be
`OWNER_NONCE_AFTER_RERUN`, 14 (`run_log` `next_nonce.owner`). If it is not, something else was sent
from the owner since, and the lead says so before going on.

## A mortal transaction lives about a minute

The encoder's era is 64 blocks from its birth block, about a minute on this devnet. So each device
step is read, signed and sent in one go:

1. In the pane, `lab.deviceReads(device, sessionNonceKey)` reads the runtime's four names, the
   finalized head (the birth block, its number and hash), the device's account nonce and the raw
   session nonce. It prints them as one JSON value.
2. On the PC, `sign-device.mjs <step> --key <file> --results results.json --reads '<that JSON>'`
   builds the step's inner call from `steps.json`, signs and writes `signed/<step>.json`. It prints
   the encoder's description to stderr, and the file's sha256 and the last valid block to stdout.
3. In the pane, `lab.send(<text of the file>, <its sha256>)` submits it once and waits for a
   finalized block or its deadline.

If the last valid block has passed before step 3, the file is not sent. The lead moves it aside
and signs the step again from new reads; `sign-device.mjs` refuses to write over a signed file.

## The steps

| # | Signs | Tool | Call | Moves | Declared | Expected | When | If not |
|---|---|---|---|---|---|---|---|---|
| T1 | owner | research-signer | transfer | 150000000000000000 (0.15 FLOP) owner to device | none | success | in order | stop |
| T2 | owner | research-signer | create-session | nothing | none | success | in order | stop |
| T3 | device | encoder | execute_via_session(force_open) | 10000000000000000 (0.01 FLOP) owner to pallet | 10000000000000000 (0.01 FLOP) | success | in order | stop |
| T4 | device | encoder | execute_via_session(top_up_escrow) | 1000000000000000 (0.001 FLOP) owner to pallet | 1000000000000000 (0.001 FLOP) | recorded, not expected: included in a finalized block, and success or a named error of ComputeChannel or FlopSessionKeys | in order | stop |
| T5 | device | encoder | execute_via_session(open_channel) | 10000000000000000 (0.01 FLOP) owner to pallet | 10000000000000000 (0.01 FLOP) | recorded, not expected: included in a finalized block, and success or a named error of ComputeChannel or FlopSessionKeys | in order | stop |
| T6 | device | encoder | execute_via_session(expire_force_open) | 10000000000000000 (0.01 FLOP) pallet to owner<br>1000000000000000 (0.001 FLOP) pallet to owner if T4 succeeded | 0 (0 FLOP) | success | only if T3 recorded ComputeChannel.ForceOpenRequested; after block $T3.ComputeChannel.ForceOpenRequested.ack_deadline | stop (cleanup) |
| T7 | device | encoder | execute_via_session(timeout) | 10000000000000000 (0.01 FLOP) pallet to owner | 0 (0 FLOP) | success | only if T5 recorded ComputeChannel.ChannelOpened; after the block of T5 plus 120 blocks | stop (cleanup) |
| T8 | owner | research-signer | revoke | nothing | none | success | only if T2 succeeded | stop (cleanup) |
| T9 | device | research-signer | sweep | all it holds device to owner | none | success | only if T1 succeeded | stop (cleanup) |

What each step settles:

- T3: a mortal era signed by the lab is taken, and the declared spend equal to the escrow is taken.
  If the chain answers `FlopSessionKeys.SpendExceedsDeclared`, that is a finding about the
  encoder's rule E5, and the batch stops.
- T4: the chain reads the encoder's layout of `top_up_escrow`. Its doc comment speaks of a live
  session, and the channel of T3 waits for an ack, so a refusal such as `ComputeChannel.BadState`
  may come. Either way the step passes when it is included in a finalized block and named.
- T5 (D2): the chain reads the encoder's layout of `open_channel`. A refusal named by the 1014020
  table passes the step as T4 does. If it succeeds, a channel is open and T7 closes it.
- T6 and T7: the escrows come back. T6 may be sent only after the ack deadline of T3; T7 only
  after `max_duration` of T5 has passed since its block.
- Before T1 and after every step, at the finalized block that holds the step: the owner's and the
  device's `System.Account` (free, reserved, nonce), the session's record, its nonce and the
  device's circuit breaker. The keys come from `flop-sign.mjs keys --owner $OWNER --delegate
  $DEVICE`. `check.mjs` compares the owner's free and reserved balance step by step with what the
  steps move, so "an open moves nothing but the escrow" is shown or refuted.

## The two open windows

- The ack window is 600 blocks (`facts` `constants.ComputeChannel.AckWindow.value`). The rerun saw
  the ack deadline 595 blocks after the block of inclusion (rerun A6 `ack_deadline` 3553433, block
  3552838). T6's earliest block is after `$T3.ComputeChannel.ForceOpenRequested.ack_deadline`, read
  from T3's events, not computed.
- `MAX_DURATION_D2` is 120 blocks, the plan's choice. The 1014020 metadata states no lower bound:
  no constant and no error names one. The upper bound for an open the miner did not sign is
  `MaxUnconsentedSessionBlocks`, 14400. The channel's `opened_at` is taken to be the block of T5,
  so T7 waits until 120 blocks after it; if the chain answers `SessionNotExpired`, T7 waits and is
  signed again.

## What the batch costs

The fee of each step is the one the rerun recorded for a like step (`rerun` `steps[i].fee_raw`).
None exists for T4 and T5. T7's like step, A3, was a refused timeout, so its fee is a guess. The
encoder's era adds one byte to each device extrinsic.

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

The device gets `FUND`, 0.15 FLOP (`escrow` `steps[0].what`). That is more than twice six device
transactions at the rerun's largest fee, `MAX_FEE` (`rerun` `steps[2].fee_raw`), as
`fund_rule` in `steps.json` says and `plan.test.mjs` checks. T9 returns what is left.

## The stop rule

Each step's "If not" in the table above says what the lead does on an answer other than expected.
A stop ends the test steps. The cleanup steps that apply still run, in order, so no escrow and no
fee money is left behind.

| Stop | The lead | Then sends | Left on chain, and how it comes back |
|---|---|---|---|
| T1 answers otherwise | stop the test steps | T9 if T1 succeeded | until those are final: nothing is left on the device |
| T2 answers otherwise | stop the test steps | T8 if T2 succeeded, T9 | until those are final: session is ended; nothing is left on the device |
| T3 answers otherwise | stop the test steps | T6 if T3 recorded ComputeChannel.ForceOpenRequested, T8, T9 | until those are final: escrow of T3 comes back; session is ended; nothing is left on the device |
| T4 answers otherwise | stop the test steps | T6, T8, T9 | until those are final: escrow of T3 comes back; session is ended; nothing is left on the device |
| T5 answers otherwise | stop the test steps | T6, T7 if T5 recorded ComputeChannel.ChannelOpened, T8, T9 | until those are final: escrow of T3 comes back; escrow of T5 comes back; session is ended; nothing is left on the device |
| T6 fails | stop | the cleanup steps after it that apply | the escrow of T3 (and its top up, if T4 moved one) stays in the pallet account under the channel of T3. expire_force_open is permissionless and stays possible: sign T6 again with a new step id through the session while it lasts (A_BLOCKS from T2). Do not send T8 before it is back |
| T7 fails | stop | the cleanup steps after it that apply | the escrow of T5 stays in the pallet account under the channel of T5. timeout is permissionless: sign it again through the session while the session lasts. Do not send T8 before it is back |
| T8 fails | stop | the cleanup steps after it that apply | the session stays until A_BLOCKS after T2, bounded by its caps; the device holds only its fees. Send T9 anyway, then revoke again |
| T9 fails | stop | the cleanup steps after it that apply | what the device holds stays on the device: at most FUND less its fees. Sign T9 again with the device's next nonce |

## How the lead tells the outcome at run time

The pane decodes nothing. Before the full record is made, these raw reads tell the lead where the
batch stands:

- included: the device's (or owner's) account nonce rose by one.
- a session call succeeded: the session nonce's raw value changed. A refused call is rolled back
  whole and leaves it as it was (rerun A3, A4).
- the record then names the outcome. `check.mjs results.json` judges it.

## The command lines

```
# run in a working folder outside the repo, after: mkdir calls signed
# LAB is the repo checkout; KEY_OWNER and KEY_DEVICE name the key files; FLOP_SIGN_LIBS names the libraries (LAB/imd-flop)
# OWNER_NONCE is the owner's account nonce read before T1; DEVICE_NONCE the device's, read before T9
# the pane: paste pane-runner.js, then: const lab = paneRunner.createRunner({ transport: paneRunner.wsTransport("wss://rpc.devnet.flop.network"), eventsKey: "0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7" })
# the research signer signs immortal; sign-device.mjs signs mortal, 64 blocks: read, sign and send it within a minute

# T1: owner signs with the research-signer; expect success
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call transfer --to $DEVICE --amount 150000000000000000 > calls/T1.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_OWNER --call "$(node -p 'require("./calls/T1.json").call')" --nonce $((OWNER_NONCE+0)) --out signed/T1.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631
sha256sum signed/T1.json
#    in the pane: await lab.send(<text of signed/T1.json>, "<its sha256, printed above>")

# T2: owner signs with the research-signer; expect success
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call create-session --delegate $DEVICE --cap 50000000000000000 --per-tx 20000000000000000 --daily 25000000000000000 --blocks 7200 --allow ComputeChannel > calls/T2.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_OWNER --call "$(node -p 'require("./calls/T2.json").call')" --nonce $((OWNER_NONCE+1)) --out signed/T2.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631
sha256sum signed/T2.json
#    in the pane: await lab.send(<text of signed/T2.json>, "<its sha256, printed above>")

# T3: device signs with the encoder; expect success
#    in the pane, moments before: copy(JSON.stringify(await lab.deviceReads("$DEVICE", "<session_nonce key of flop-sign.mjs keys>")))
node "$LAB/research/2026-11-12-encoder-devnet-test/sign-device.mjs" T3 --key $KEY_DEVICE --results results.json --reads '<what deviceReads printed>'
#    in the pane: await lab.send(<text of signed/T3.json>, "<its sha256, printed above>")

# T4: device signs with the encoder; expect the outcome to be recorded
#    in the pane, moments before: copy(JSON.stringify(await lab.deviceReads("$DEVICE", "<session_nonce key of flop-sign.mjs keys>")))
node "$LAB/research/2026-11-12-encoder-devnet-test/sign-device.mjs" T4 --key $KEY_DEVICE --results results.json --reads '<what deviceReads printed>'  ; the channel id is taken from results.json
#    in the pane: await lab.send(<text of signed/T4.json>, "<its sha256, printed above>")

# T5: device signs with the encoder; expect the outcome to be recorded
#    in the pane, moments before: copy(JSON.stringify(await lab.deviceReads("$DEVICE", "<session_nonce key of flop-sign.mjs keys>")))
node "$LAB/research/2026-11-12-encoder-devnet-test/sign-device.mjs" T5 --key $KEY_DEVICE --results results.json --reads '<what deviceReads printed>'
#    in the pane: await lab.send(<text of signed/T5.json>, "<its sha256, printed above>")

# T6: device signs with the encoder; expect success; only if T3 recorded ComputeChannel.ForceOpenRequested; after block $T3.ComputeChannel.ForceOpenRequested.ack_deadline
#    in the pane, moments before: copy(JSON.stringify(await lab.deviceReads("$DEVICE", "<session_nonce key of flop-sign.mjs keys>")))
node "$LAB/research/2026-11-12-encoder-devnet-test/sign-device.mjs" T6 --key $KEY_DEVICE --results results.json --reads '<what deviceReads printed>'  ; the channel id is taken from results.json
#    in the pane: await lab.send(<text of signed/T6.json>, "<its sha256, printed above>")

# T7: device signs with the encoder; expect success; only if T5 recorded ComputeChannel.ChannelOpened; after the block of T5 plus 120 blocks
#    in the pane, moments before: copy(JSON.stringify(await lab.deviceReads("$DEVICE", "<session_nonce key of flop-sign.mjs keys>")))
node "$LAB/research/2026-11-12-encoder-devnet-test/sign-device.mjs" T7 --key $KEY_DEVICE --results results.json --reads '<what deviceReads printed>'  ; the channel id is taken from results.json
#    in the pane: await lab.send(<text of signed/T7.json>, "<its sha256, printed above>")

# T8: owner signs with the research-signer; expect success; only if T2 succeeded
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call revoke --delegate $DEVICE > calls/T8.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_OWNER --call "$(node -p 'require("./calls/T8.json").call')" --nonce $((OWNER_NONCE+2)) --out signed/T8.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631
sha256sum signed/T8.json
#    in the pane: await lab.send(<text of signed/T8.json>, "<its sha256, printed above>")

# T9: device signs with the research-signer; expect success; only if T1 succeeded
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call sweep --to 0xe462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2 > calls/T9.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_DEVICE --call "$(node -p 'require("./calls/T9.json").call')" --nonce $DEVICE_NONCE --out signed/T9.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631
sha256sum signed/T9.json
#    in the pane: await lab.send(<text of signed/T9.json>, "<its sha256, printed above>")
```
