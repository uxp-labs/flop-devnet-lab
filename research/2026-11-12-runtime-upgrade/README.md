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
- The new metadata still names `FlopSessionKeys`, `ComputeChannel` and `SessionToken`. It adds the
  calls `set_capacity_reservation_rate` and `set_model_mirrors`. That is a read of names, not of
  behaviour.
- The observatory's decoder refuses every block from 3528529 on until a shape for spec 1014020 is
  derived, read and added to its reviewed list. That is what the pin is for.
- `flop-sign.mjs` in the session test folders signs for spec 1014014. A signature names the spec,
  so the devnet as it is now rejects what it signs. Before it is used again it needs the new spec
  and its call indexes checked against the new metadata.

## Not read, not shown

- The call inside the upgrade extrinsic was not decoded. We do not state which call carried the
  code or who authorised it. The events show the sender paid no fee for it.
- No event of spec 1014020 was decoded.
- Whether any stored value was migrated at block 3528529 was not read.
- These reads came from one public RPC endpoint.

## Read it again

Every read is a plain JSON RPC call at a block hash, listed under `method` and `keys` in
`results.json`. An archive node answers all of them. The sizes and sha256 values there are of the
bytes the node answered.
