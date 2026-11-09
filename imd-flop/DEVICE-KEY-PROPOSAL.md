# Draft proposal: device key vouches for the FLOP key (for imd to ship)

Status: design note only. Not built in `imd-flop`. Nothing here is adopted by imd.

## Problem with link v1
Link v1 (in this CLI) asks the seat holder to make a new EIP-712 signature for each FLOP DID,
and a live run then needs an Ethereum RPC to check `ownerOf`. Both are extra steps that imd's
existing pairing already covers.

## What imd already has (per the Nov 9 review; check against imd's docs before relying on it)
- Each seat's worker has an Ed25519 device key, bound to the seat by the holder's EIP-712 signature.
- `GET https://api.imd.fun/pair/wallet/:address` lists a wallet's seats and their paired devices.

## Proposal
1. The worker keeps a separate FLOP key (sr25519/ed25519). The device key never pays.
2. The device key signs a statement with this domain tag: `imd-flop/device-vouch/v0\n` + `{tokenId, deviceKey, flopDid, ss58, genesisHash, issuedAt}`.
3. The FLOP key countersigns the same statement, which proves possession.
4. To verify: both signatures check out, `genesisHash` equals the pinned FLOP genesis, and imd's
   pairing record shows `deviceKey` currently paired to `tokenId` under the seat's current owner.

## What this gets
- Holders sign nothing new. The pairing they already did covers it.
- When a holder re-pairs the device or sells the seat, the pairing record changes and the link dies on the next verify, without an RPC on the worker.
- The FLOP key can rotate without touching the holder: the device key just signs a new vouch.

## Open questions for imd
- Does the pairing endpoint return the device public key and the current owner, or only device ids?
- Is the pairing record authoritative after a transfer, or does it need an `ownerOf` cross-check?
- Where should a vouch live: in imd's API next to the pairing, or only beside the worker?
