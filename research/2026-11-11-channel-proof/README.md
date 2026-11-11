# Proving a gateway receipt on chain: a swarm research report

`report.md` is a research report bought from the IMD swarm on 2026-11-11. It is kept here as it was
delivered, byte for byte. It is a lead for the observatory's decoder and for `imd-flop`'s hold floor,
not a rule: nothing in it is taken as true until our own code or our own read of the chain confirms it.

## Where it came from

- Question: how can a client prove, with read only calls to a FLOP devnet RPC node, that the request
  behind one gateway receipt settled on chain, and for how much, through its compute channel?
- IMD job: `2f111874-d780-4578-80a7-2198c62bf86a` (a written report, `skill: research-report`).
- Paid: 0.5 IMD on Ethereum mainnet, transaction
  `0x1d27068c26f23be91cc15b9de9f33d7a9167bf9d25d617e9e897a29ea41483ed`.
- Delivered to the public repository `Identity-md/research`, path
  `jobs/2f111874-d780-4578-80a7-2198c62bf86a/files/artifacts/report.md`, at commit
  `e5cc94dab41170a1ce31d728c7d3638720cd25d1`.
- sha256 of `report.md`: `8f1f26a6264f1194b2ebe8009e92446db7889f64222b01d10b3a6be07e988c98`.
- IMD's own check of it was structural only: no test suite ran on it.

## What we confirmed ourselves, by hand, on 2026-11-11

Read through `wss://rpc.devnet.flop.network` at runtime spec 1014014:

- The storage key the report gives for `ComputeChannel.Channels` of channel
  `0x9f81f65bc93855d394329e4996bc78d949bb786178f3471c13d3853f9813ddd7` returns a value of 288 bytes at
  the finalized head. So the key construction is right and that channel is still in storage after
  it settled.
- In `System.Events` at block 3479299
  (`0xeba1182c9f2bbf5a8fd012afddc201c2ebed11b64f59b10c1d3c4fcc4b2ee18e`) the bytes `0x67 0x17`
  followed by the channel id appear at offset 888, then `minerPaid` 112860000000000002, `burned` 0,
  `aggregateGn` 38 and `cooperative` true, each a little endian `u128` but the last. So the pallet
  index is 103, `Settled` is variant 23, and its fields are in the order the report gives.
- In the same value the bytes `0x67 0x30` followed by the channel id appear at offset 832, then the
  amount 1140000000000000. So `AuditFeeEarmarked` is variant 48.

Everything else in the report is unconfirmed until the decoder reads it from the recorded metadata.

## What it means for this repo

- The chain proves a channel's settlement, not one request's amount. A channel can serve many
  requests, and the channels are opened by a shared gateway account. Without a commitment from FLOP
  that binds a request to its share of a channel, a receipt's `settled_spend_raw` can be checked
  against the channel's total only as an upper bound.
- So `imd-flop`'s hold floor cannot be lifted by chain proof alone today. It needs either that
  commitment from FLOP, or a spend limit enforced on chain for the agent's own account.
- The report ends with six questions for the FLOP team. They are the list to raise.
