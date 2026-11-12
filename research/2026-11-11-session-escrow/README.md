# Does a session's limit count channel escrow? A devnet test

On 2026-11-11 we sent nine transactions on FLOP Devnet to settle the question the probe in
`../2026-11-11-session-probe/` left open. That probe showed a `FlopSessionKeys` session may call
`ComputeChannel`. It moved nothing of value. This test moves escrow into a channel through a
session and reads what the session's meter and limits do.

## The answer

Yes. The session's meter sees the escrow, and the limits hold.

The owner gave a device key a session with a lifetime cap of 0.05 FLOP, 0.02 FLOP per call, 0.025
FLOP per day, and `ComputeChannel` as the only allowed pallet. Through it the device sent
`ComputeChannel.force_open`, the call that opens a channel without a handshake.

| The device asked for | Declared spend | What the chain did |
|---|---|---|
| a channel with 0.01 FLOP escrow | 0 | failed with `FlopSessionKeys.SpendExceedsDeclared`. Nothing moved. |
| the same channel | 0.012 FLOP | success. 0.01 FLOP went from the owner to the pallet account. The session's counters rose by 0.012 FLOP. |
| a channel with 0.03 FLOP escrow | 0.03 FLOP | failed with `FlopSessionKeys.PerTxLimitExceeded` |
| a channel with 0.019 FLOP escrow | 0.019 FLOP | failed with `FlopSessionKeys.DailyCapExceeded` (0.012 + 0.019 is above 0.025) |
| the refund, after the ack window | 0 | success. The full 0.01 FLOP came back to the owner. The counters stayed at 0.012 FLOP. |

So:

- A device cannot move more out of the owner's account than it declares. The call that tried was
  rolled back whole.
- What the device declares is what the limits count, even when less moves. Declaring too much only
  uses up the device's own room.
- The limit per call and the cap per day are checked against the declared amount, and they refuse.
- A refund does not give room back. The counters only go up. An owner who wants the room back
  changes the limits or makes a new session.
- The owner's account pays the escrow and gets the refund. The device pays every fee, also for a
  call that fails (0.0094 FLOP for each `force_open` here, 0.0078 FLOP for the refund call).
- A failed call leaves the session's nonce, its counters and the device's circuit breaker as they
  were.

This agrees with the doc comment the chain's own metadata carries for `execute_via_session`: the
declared amount is charged against the caps, and it must cover what the call moves out of the
owner's account, free or reserved.

## No miner was touched

- `force_open` names a miner. We named the lab's own empty account from the first probe. It is not
  a registered miner. The chain accepted it, and the channel waited in state `PendingAck`.
- The chain adds to a miner's `FailedAcks` counter when a `force_open` it did not answer expires,
  but only from an escrow of 0.05 FLOP (`MinForceOpenEscrowForFailedAck`). The escrow here was 0.01
  FLOP. `ForceOpenExpired` reported `failed_acks` 0, and the named account has no `FailedAcks` entry.
- `flop-sign.mjs` refuses to sign a `force_open` with an escrow of 0.05 FLOP or more.

## What it does not show

- `open_channel` and `top_up_escrow` through a session. They need a miner's handshake or a live
  channel. They move escrow out of the owner's account the same way, so the same meter should apply.
  That is an inference, not a reading.
- The list of pallets a session can never call. The metadata names it (`DENIED_PALLETS`) and does
  not print it.
- A channel that a miner answers and serves. That needs a miner with a public endpoint.
- Anything about the hosted gateway. It spends an allowance it keeps off chain.

## What was sent

Owner: the lab's FLOP identity, `5HEA8QECFwBg1F9cxoXzvQzryu2d5qj5zASJS7owNW2zebBz`.
Device: a key made for this test, `5GmkbyGrAAMoQCvhZsEqz9gYKkqML82qS39TaTjS84NChxvC`.
Named miner: the first probe's device account, `5Cm4uUXzfKUWWpi9xJgrCaMupmnZ1UiAhMD1XW6WvMFLkDvB`.
Channel: `0xe5655fd56d18ac9816623fd975d501322a7427fe5568c7aa02a19cf04dfd12dc`.
Chain: genesis `0x99c172c0…2d631`, spec 1014014, metadata sha256 `f4fd2add…3444`.
Since then the devnet has moved to spec 1014020 (2026-11-12, see `../2026-11-12-runtime-upgrade/`).
What is measured here is for spec 1014014 until it is run again.

| # | Signed by | Call | Finalized in block | Result |
|---|---|---|---|---|
| 1 | owner | `Balances.transfer_keep_alive`: 0.15 FLOP to the device, for its fees | 3497503 | success |
| 2 | owner | `FlopSessionKeys.create_session`: cap 0.05 FLOP, 0.02 per call, 0.025 per day, 7200 blocks, allowed `ComputeChannel` | 3497525 | success |
| 3 | device | `execute_via_session` running `force_open`, escrow 0.01 FLOP, declared 0 | 3497567 | failed with `SpendExceedsDeclared` |
| 4 | device | the same, declared 0.012 FLOP | 3497611 | success, `ForceOpenRequested`, ack deadline 3498205 |
| 5 | device | `force_open`, escrow 0.03 FLOP, declared 0.03 FLOP | 3497694 | failed with `PerTxLimitExceeded` |
| 6 | device | `force_open`, escrow 0.019 FLOP, declared 0.019 FLOP | 3497716 | failed with `DailyCapExceeded` |
| 7 | device | `execute_via_session` running `expire_force_open`, declared 0 | 3498234 | success, `ForceOpenExpired`, refunded 0.01 FLOP, `failed_acks` 0 |
| 8 | owner | `FlopSessionKeys.revoke_session` | 3498288 | success |
| 9 | device | `Balances.transfer_all` back to the owner | 3498313 | success |

`results.json` has every block hash, extrinsic hash, call, fee, the session and channel records
between the steps, and the owner's balance after each step. The cost was 0.060071646405 devnet FLOP
in fees, which is exactly the fall of the owner's balance from 24.971396765185 to 24.91132511878
FLOP. The device account is empty and gone from chain state. The closed channel record, the revoked
session record and the device's circuit breaker record stay on chain.

The model, measured root, decode policy, precision and SLA in the `force_open` are those of
`open_channel` calls seen on chain minutes before. They had to pass the chain's checks, and they did.

## Also seen

- `SessionCallExecuted` carries the session's running totals (`spent`, `epoch_spent`), not the
  amount of that one call. After the refund call it still said 0.012 FLOP.
- The channel's `opened_at` was 3497605 for a call included in block 3497611, and the ack deadline
  was `opened_at` + 600. The window is counted from a height a few blocks behind the block of
  inclusion.
- The device's circuit breaker counts calls that succeed: `tx_count` 1 with 0.012 FLOP after step 4,
  unchanged by the three failed calls, then a new period with `tx_count` 1 and 0 FLOP at the refund
  call.

## How it was done

- `flop-sign.mjs` here is version 2 of the first probe's signer. It adds two inner calls,
  `force_open` and `expire_force_open`, and the limit on the escrow. It still talks to no network,
  signs only the shapes it lists, and prints in plain words what it signs. The keys stayed in files
  on the operator's computer and were never printed.
- `check.mjs` compared its new calls and storage keys with the polkadot-api reference encoder on the
  metadata we recorded ourselves, before any key was used. All were byte for byte the same, and
  each refusal was seen.
- Each signed extrinsic was first checked by the node with
  `TaggedTransactionQueue_validate_transaction`, then sent with `author_submitAndWatchExtrinsic`,
  and read back from `System.Events` at the block that finalized it.
- Events and storage values were decoded with the polkadot-api reference decoder and the same
  metadata.
- The extrinsics use an immortal era. That is acceptable for a throwaway test on a devnet. A tool
  for real use signs with a mortal era.

To check it yourself: read `System.Events` at the nine block hashes in `results.json` from an
archive node and decode them with the metadata of spec 1014014. `results.json` gives the sha256 of
each events value as we read it.

## What it means for this repo

- The design in `../2026-11-11-onchain-spend-limit/` works on chain for the part we can reach: the
  seat's owner creates a session for the worker's device key with `ComputeChannel` as the only
  allowed pallet, and the device cannot take more than it declares, more than the limit per call,
  or more than the cap per day.
- For a daily cap the worker should declare what the call moves, no more. Refunds do not give room
  back, so a day of opened and expired channels still fills the cap. That is the safe direction,
  and it is the same shape as the hold floor in `imd-flop`: room is counted by what a call was
  allowed to take.
- Fees are outside the cap. They come from the device's own balance, so the owner bounds them by
  what he sends the device.
- What is left before a worker can pay for inference this way: a miner to open a real channel with
  (the direct session path in FLOP's docs), or a gateway mode that takes a session as payer.
