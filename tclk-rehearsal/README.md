# tclk hash-lock rehearsal (uxp-labs)

No value moved. No devnet, no imd.fun, no live rooms. Hash locks only (point locks are unaudited upstream).

- tclk clone: flop-labs/tclk @ 7d402db. Upstream suite: 153/153 vitest pass. Note: `pnpm -r build` fails in `flop/` (draft bug filed separately).
- `src/HashLock.sol`, a minimal sha256 ETH hash lock (test chains only, not audited). `forge test`: 5/5 (claim, wrong preimage, no double claim, refund only after timeout, no refund after claim).
- `test/uxp-swap.test.ts` (run from a tclk clone's tests/): a two-leg swap under one hash. FLOP leg = real tclk frames (offer, accept, lock, reveal/refund) on MemoryRail; ETH leg = HashLock on local anvil. 2/2 pass:
  1. Happy path: Alice locks ETH (2h), Bob locks FLOP (1h), Alice claims FLOP with a reveal frame, Bob pulls the secret from the frame alone and claims ETH.
  2. Refund path: no reveal. Bob refunds FLOP at 1h via a refund frame; ETH refund reverts early, then succeeds at 2h.

Timeouts: the secret holder's lock must outlive the other leg's (2h > 1h); tclk also enforces claimBy < refundAfter.
This is the payment leg for a FLOP-to-imd bridge. Next, once approved: swap MemoryRail for FlopRail on devnet, and the EVM leg for the real rail.

Run: `forge install foundry-rs/forge-std --no-git && forge test`. For the swap: clone flop-labs/tclk, copy `test/uxp-swap.test.ts` into its `tests/`, set `EVM` in the file to this folder, then `npx vitest run tests/uxp-swap.test.ts` (needs anvil on PATH).
