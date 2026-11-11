# May a session call ComputeChannel? A devnet probe

On 2026-11-11 we sent six transactions on FLOP Devnet to settle one question left open by the report
in `../2026-11-11-onchain-spend-limit/`: the chain lets an owner account grant a device key a session
with spend limits (`FlopSessionKeys`), but may such a session call the `ComputeChannel` pallet, the
one that pays for inference? The list of pallets a session can never call is not in the metadata.

## The answer

Yes, as far as the session's pallet filter goes.

- A session whose allowed pallets are `["ComputeChannel"]` was created without complaint. The allow
  list takes the pallet's name as the metadata spells it.
- Through that session the device sent `ComputeChannel.timeout` for a channel id that does not
  exist. The call failed with `ComputeChannel.ChannelNotFound` (pallet 103, error 7). That error
  comes from inside the `ComputeChannel` pallet. So the session let the call through.
- As a control the device sent `System.remark` through the same session. It failed with
  `FlopSessionKeys.PalletNotAllowed` (pallet 94, error 7). That is what a refused pallet looks like.
- So `ComputeChannel` is not on the session pallet's deny list.

Also seen:

- A failed inner call rolls the whole call back. After the failed `timeout` the session's nonce was
  still 0 and its spend counters and the device's circuit breaker were unchanged.
- The device still pays the fee of a failed call: 0.009748 FLOP when the inner call was run, 0.004304
  FLOP when the session refused it.
- Creating a session cost 0.005151 FLOP, revoking it 0.003906 FLOP. No deposit was taken.
- After `revoke_session` the session's record stays in storage with `active` false. The device's
  `DelegateSessions` entry is empty.

## What it does not show

- That `open_channel` or `top_up_escrow` succeed through a session. Opening a channel needs a miner,
  a model and a handshake. None of that was done.
- How the session's spend meter counts the escrow those calls move, or that the limits hold when
  value does move. Nothing of value moved through the session here.
- Anything about the hosted gateway. It spends an allowance it keeps off chain and uses its own
  account on chain (see the report).

So this removes the first blocker for a cap the chain enforces. It is not that cap yet.

## What was sent

Owner: the lab's FLOP identity, `5HEA8QECFwBg1F9cxoXzvQzryu2d5qj5zASJS7owNW2zebBz`.
Device: a key made for this probe, `5Cm4uUXzfKUWWpi9xJgrCaMupmnZ1UiAhMD1XW6WvMFLkDvB`.
Chain: genesis `0x99c172c0…2d631`, spec 1014014, metadata sha256 `f4fd2add…3444`.

| # | Signed by | Call | Finalized in block | Result |
|---|---|---|---|---|
| 1 | owner | `Balances.transfer_keep_alive`: 0.1 FLOP to the device, for its fees | 3492693 | success |
| 2 | owner | `FlopSessionKeys.create_session`: lifetime cap 0.1 FLOP, 0.05 per call, 0.1 per day, 7200 blocks, allowed `ComputeChannel` | 3492718 | success |
| 3 | device | `execute_via_session` running `ComputeChannel.timeout` on a made up channel id | 3492760 | failed with `ComputeChannel.ChannelNotFound` |
| 4 | device | `execute_via_session` running `System.remark` | 3492808 | failed with `FlopSessionKeys.PalletNotAllowed` |
| 5 | owner | `FlopSessionKeys.revoke_session` | 3492879 | success |
| 6 | device | `Balances.transfer_all` back to the owner | 3492906 | success |

`results.json` has every block hash, extrinsic hash, call, fee and note. The cost was 0.028603234815
devnet FLOP in fees. The owner held 25 FLOP before and 24.971396765185 FLOP after. The device account
is empty and gone from chain state. The revoked session record stays on chain.

## How it was done

- `flop-sign.mjs` builds and signs the calls offline. It talks to no network. It signs only the
  call shapes this probe needs and refuses everything else, it never signs a transfer or a session
  cap above 1 FLOP, and it prints in plain words what it is about to sign. The keys stayed in files
  on the operator's computer and were never printed.
- Before any key was used, its seven calls and six storage keys were compared with the polkadot-api
  reference encoder, on the metadata we recorded ourselves. All were byte for byte the same.
- Each signed extrinsic was first checked by the node with
  `TaggedTransactionQueue_validate_transaction`, then sent with `author_submitAndWatchExtrinsic`,
  and read back from `System.Events` at the block that finalized it.
- The events were decoded with the polkadot-api reference decoder and the same recorded metadata.
- The extrinsics use an immortal era. That is acceptable for a throwaway probe on a devnet. A tool
  for real use should sign with a mortal era.

To check it yourself: read `System.Events` at the six block hashes in `results.json` from an archive
node and decode them with the metadata of spec 1014014.

## What it means for this repo

- The design in the report is open: the seat's owner creates a session for the worker's device key
  with `ComputeChannel` as the only allowed pallet, and the device pays for channels through
  `execute_via_session`. The next step is one real channel opened through a session, to see the
  spend meter count it. That needs a miner to open a channel with, so it waits on direct channel use.
- `flop-sign.mjs` is a probe tool, not a product. If `imd-flop` gets a session provider, its signer
  is built there with tests, a mortal era and the shape pin of the observatory.
