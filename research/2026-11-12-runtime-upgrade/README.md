# FLOP devnet moved from spec 1014014 to spec 1014020: what we read at the boundary

On 2026-11-12 at 04:05 UTC the devnet's runtime was upgraded. This folder holds our own reads of
the four blocks around the upgrade, and one rule they show that anything decoding this chain has
to follow.

Read only. No transaction was sent. Every value is in `results.json` with how it was read.

## What happened

| Block | Time (UTC) | `state_getRuntimeVersion` at it | `System.LastRuntimeUpgrade` at it | Metadata at it | Runtime code at it |
|---|---|---|---|---|---|
| 3528527 | 04:05:08 | 1014014 | 1014014 | 482132 bytes, `f4fd2add…3444` | 2538890 bytes |
| 3528528 | 04:05:09 | **1014020** | **1014014** | 487100 bytes, `91294eb6…8238` | 2553782 bytes |
| 3528529 | 04:05:12 | 1014020 | 1014020 | 487100 bytes, `91294eb6…8238` | 2553782 bytes |
| 3528530 | 04:05:17 | 1014020 | 1014020 | not read | 2553782 bytes |

- Block 3528528 carries the upgrade: its third extrinsic is 2553899 bytes, and its events include
  `System.CodeUpdated`. The header has the one byte log `0x08`, the mark that the runtime
  environment changed in that block.
- The hash in `System.CodeUpdated` is `0xfd5ac06d…1e5b`. It equals the storage hash of the `:code`
  key at that block and at every later block we read.
- Block 3528529 is the first block the new runtime executed. `System.LastRuntimeUpgrade` changes
  there.
- Same genesis. Same spec name, `tzkv-runtime`. The transaction version is still 2.
- Our own hourly reading saw it too: the reading of 04:35 UTC on the `observatory-data` branch says
  runtime 1014020 at finalized block 3530299, with no reset and no conflict. The reading of
  03:28 UTC still said 1014014.

## Who authorised it, and how it landed

Read later the same day, from the same endpoint. It is under `authorization` in `results.json`.

| Block | Time (UTC) | `System.AuthorizedUpgrade` at it |
|---|---|---|
| 3528477 | 04:04:18 | absent |
| 3528478 | 04:04:19 | `0xfd5ac06d…1e5b` and `check_version` true |
| 3528527 | 04:05:08 | the same |
| 3528528 | 04:05:09 | absent |

- Block 3528478 holds a 145 byte extrinsic signed by `0x8e98…ce27`. That account is the value of
  `Sudo.Key` at that block. Its call is `Sudo.sudo(System.authorize_upgrade(code_hash))`.
- Our decoder, pinned to spec 1014014, reads that extrinsic's events as `System.UpgradeAuthorized`
  with the code hash `0xfd5ac06d…1e5b` and `check_version` true, then `Sudo.Sudid` with `Ok`. The
  fee was withdrawn and paid back: the fee paid is 0.
- The same account sent the upgrade extrinsic in block 3528528, with its next account nonce
  (49507 after 49506). Its call is `System.apply_authorized_upgrade(code)`, with 2553782 bytes of
  code. That is the size of the `:code` key from that block on.
- The hash that was authorised is the hash in `System.CodeUpdated` and the storage hash of `:code`.
- So the chain's own state named the coming code for 50 blocks, 50 seconds, before it landed.

What follows for a reader of this chain: `System.AuthorizedUpgrade` at the finalized head shows an
upgrade that is authorised and not yet applied, with the hash of its code. This one could have
been seen 50 blocks ahead. The metadata also has `System.set_code`, which the Sudo key could call
with no such warning. Whether FLOP Labs will always authorise first is not known.

The two extrinsics were read by position: the lab has no decoder for extrinsics. Each layout sums
to the extrinsic's length to the byte, and the argument of the first equals the hash in its event.

## The rule: a block is in the encoding of the runtime that executed it

Block 3528528 was executed by the old runtime. Its events, and everything else in its state, are
in spec 1014014's encoding. But ask the node about that same block and two calls already answer
for the new runtime:

- `state_getRuntimeVersion` at 3528528 says 1014020.
- `state_getMetadata` at 3528528 gives the new metadata.

Both describe the code stored in the state after the block, which is the code that will execute
the next block. So a reader that takes the version or the metadata from the block it is decoding
gets the wrong runtime for exactly one block per upgrade: the one that carries it.

What names the runtime that executed a block:

- `System.LastRuntimeUpgrade` read at that block, or
- the runtime version and metadata read at the block's parent.

We checked this with our own decoder (`observatory/src/scale`), which pins a block to a reviewed
runtime through `System.LastRuntimeUpgrade`:

- Given spec 1014014, its reviewed metadata and block 3528528's own `LastRuntimeUpgrade`, it
  decodes the block's 3042 bytes of events to the last byte: 64 events, `System.CodeUpdated` at
  extrinsic 2 among them.
- Given spec 1014020, which is what `state_getRuntimeVersion` answers at that block, it refuses.
- Given spec 1014014 with the next block's `LastRuntimeUpgrade`, it refuses.

`results.json` holds the counts of the 64 events, the five events of the upgrade extrinsic and
the two refusals word for word.

## What this means for our earlier work

- Our three session tests (`../2026-11-11-session-probe/`, `../2026-11-11-session-escrow/`,
  `../2026-11-11-session-deny-list/`) and the miner counts (`../2026-11-12-miner-runbook/`) were
  measured at spec 1014014. They are not shown for spec 1014020 until they are run again.
- The new metadata still names `FlopSessionKeys`, `ComputeChannel` and `SessionToken`. It adds two
  calls, both in `ComputeChannel`: `set_capacity_reservation_rate` and `drop_capacity_reservation`.
  That is a read of names, not of behaviour. The full list is in the section after this one.
- The observatory's decoder refuses every block from 3528529 on until a shape for spec 1014020 is
  derived, read and added to its reviewed list. That is what the pin is for.
  Since review round 22 the shape is reviewed, and `observatory/test/upgrade-decode.test.ts` decodes
  3528529 and 3530299 under spec 1014020 on the observatory's third recording.
- Our twelve storage records hold the same bytes at 3528527 and at 3530299, on that recording, each
  decoded under its own runtime to the same value: `observatory/test/upgrade-storage.test.ts`.
- `flop-sign.mjs` in the session test folders signs for spec 1014014. A signature names the spec,
  so the devnet as it is now rejects what it signs. Before it is used again it needs the new spec
  and its call indexes checked against the new metadata.

## What the upgrade changed, and what it means for what we sign

We compared the two metadata answers of the observatory's third recording in two ways that share
no code: our own strict parser, by names, indexes and values, and the reference decoder, by the
structure of every type. Both give the same 39 differences. They are listed under
`what_changed_in_the_metadata` in `results.json`.

- Nothing was removed. No pallet was added, removed or moved. The extrinsic version is 4 and the
  nine signed extensions are the same, in the same order. The transaction version is 2.
- `ComputeChannel` gains two calls (50 and 51), two events (60 and 61), five errors (132 to 136),
  three storage entries and three constants. By their names they are about per miner capacity
  reservations and sessions a miner has not consented to.
- `Aleph` gains one event, one storage entry and two constants. By their names they are about a
  committee seed.
- `FlopSessionKeys` gains two errors, `SessionNonceExhausted` (16) and
  `RetiredSessionRecordMissing` (17). Three errors moved: `PalletNameTooLong` 16 to 18,
  `TooManyAllowedPallets` 17 to 19, `SpendExceedsDeclared` 18 to 20. Its calls, events and storage
  are the same.
- `HwCalibration` gains one error at index 6, so ten errors moved up by one, and one constant.
  `ModelRegistry` gains one error. `MinerStaking.CapacityStakePerGflop` changed its value. The
  `System.Version` constant changed with the spec version.

For our three signers (`flop-sign.mjs` in the session test folders): every call they encode has
the same pallet index, call index and fields in both runtimes, and the storage keys they read are
the same. They sign valid bytes for spec 1014020 with only the spec version changed, a flag they
already take. Read, not run.

A failed call names its error by two indexes, the pallet's and the error's. Our escrow test
recorded `SpendExceedsDeclared` as error 18. The same refusal at spec 1014020 would carry 20. Any
table of error names has to come from the metadata of the runtime that executed the block. Our
decoder gives the two indexes and never a name, and its reviewed shape states no errors.

A correction: this file first said the new metadata adds the call `set_model_mirrors`. That was
wrong. The call is in both runtimes.

## Not read, not shown

- The signatures on the two upgrade extrinsics were not checked, and how the upgrade was decided
  off chain is not on chain.
- Whether the chain accepts our signers' calls at spec 1014020, or does the same thing with them,
  is not shown. Only a rerun shows behaviour.
- No event of spec 1014020 was decoded.
- Whether any stored value was migrated at block 3528529 was not read.
- These reads came from one public RPC endpoint.

## Read it again

Every read is a plain JSON RPC call at a block hash, listed under `method` and `keys` in
`results.json`. An archive node answers all of them. The sizes and sha256 values there are of the
bytes the node answered.
