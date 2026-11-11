# Limiting an agent's spend on chain: a swarm research report

`report.md` is a research report bought from the IMD swarm on 2026-11-11. It is kept here as it was
delivered, byte for byte. It is a lead for `imd-flop`'s cap and for the observatory, not a rule:
nothing in it is taken as true until our own code or our own read of the chain confirms it. The
report labels every paragraph itself: `[RPC]` for a node answer, `[source]` for a public document,
`[inference]` for a conclusion, `[unknown]` for what it could not establish.

## Where it came from

- Question: how can a seat limit what an agent spends on chain with FLOP's agent wallet and session
  keys, so that a daily cap rests on the chain and not only on this tool's own ledger?
- IMD job: `7350b953-b817-4a46-bc2c-a38eab44de55` (a written report, `skill: research-report`).
- Paid: 0.5 IMD on Ethereum mainnet, transaction
  `0x59c134bba86e77c1c3246da1ce5f33bc394401d712739a94e97235aa62905b16`.
- Delivered to the public repository `Identity-md/research`, path
  `jobs/7350b953-b817-4a46-bc2c-a38eab44de55/files/artifacts/report.md`, at commit
  `56b115006d741948199c882683785389d02de78c`. The raw blocks, storage reads, decoded metadata and
  scripts it cites (`../evidence/`, `../scripts/`, `../sources/`) are in that repository beside it.
  They are not copied here.
- sha256 of `report.md`: `baacd5657f0cd7a50d41a8f471f482b8e2f14b06b8932b1d8048bc6adc24c475`
  (552022 bytes; the size is two appendices that list every pallet item and every type).
- IMD accepted the artifact. IMD says itself that acceptance is not an independent check of the
  claims. The swarm sent no transaction and made no paid request.

## What it says, in short

- The hosted gateway does not spend the enrolled wallet's chain balance. Enrollment checks that the
  wallet holds a minimum free balance and then issues an allowance the gateway keeps off chain
  (by default 25 FLOP, two requests a minute, gone within 24 hours). The compute channels are opened
  and funded by the gateway's own account.
- So there are two ledgers: the wallet's balance on chain, and the gateway's allowance. A child
  key's `max_spend` is a rule the gateway enforces, not a rule of the chain. The same holds for a
  daily cap counted by a client.
- The chain does have real limits:
  - `FlopSessionKeys` (pallet 94). An owner account grants a delegate account a session with a
    lifetime cap, a limit per call, a cap per epoch of 86400 blocks, an expiry and a list of allowed
    pallets. The delegate acts through `execute_via_session(owner, call, spend_amount, nonce)`. The
    metadata says the call reverts when the owner's balance falls by more than the amount declared.
    The owner can lower or raise the two limits within the lifetime cap, and revoke.
  - `AgentWallet` (pallet 95). A wallet with a limit per transfer, a daily cap and a list of allowed
    destinations. It guards one entry point, `agent_transfer`. Nothing shows that it guards the
    account's other calls.
- The published gateway interface binds its bearer to neither.
- The smallest design for a cap the chain enforces: the seat's owner keeps an account `S`. `S`
  creates a session for the worker's device key `D`, with `ComputeChannel` as the only allowed
  pallet. `D` opens and tops up channels through `execute_via_session`. `S`'s key never touches the
  device. This needs direct channel use, or a relay mode of the gateway that FLOP has not published.
- Not established: whether a session may call `ComputeChannel` at all (the list of denied pallets is
  not in the metadata), how nested calls are filtered, what happens at a reset boundary. The report
  ends with ten questions for the FLOP team.
- Until then the bound that can be had today is scarcity: a separate device account that holds only
  what it may lose.
- "Daily" on chain is 86400 blocks from the session's creation or last reset, counted lazily at the
  next spend. It is not a UTC day.

## What we confirmed ourselves, by hand, on 2026-11-11

From our own recording of the metadata (`observatory` fixture
`recording-20261111160917-3c228907aa129a01`, 482132 bytes, sha256
`f4fd2addba7fff1129483d0e66b8e6bc69141292f56443e201d3f073aab03444`, the same hash the report
gives), decoded with the polkadot-api reference decoder:

- `AgentWallet` is pallet 95. Its calls 0 to 8 are `create_wallet`, `fund_wallet`, `agent_transfer`,
  `owner_withdraw`, `deactivate_wallet`, `reactivate_wallet`, `settle_sponsored_payment`,
  `revoke_sponsored_payment`, `prune_sponsored_payment`, with the fields the report lists.
- `FlopSessionKeys` is pallet 94. Its calls 0 to 5 are `create_session`, `revoke_session`,
  `execute_via_session`, `force_revoke`, `force_reset_circuit_breaker`, `update_session_limits`,
  with the fields the report lists. Its eight storage items and their hashers are as listed. Its ten
  constants are as listed: `SessionEpochLength` 86400, `MaxSessionDuration` 864000,
  `MaxSessionsPerOwner` 10, `MaxSessionsPerDelegate` 10, `MaxAllowedPallets` 16,
  `CircuitBreakerPeriod` 60, `CircuitBreakerMaxTxs` 100, `CircuitBreakerMaxSpend`
  250000000000000000000, `MaxSessionRotationsPerHour` 3, `BlocksPerHour` 3600.
- `AgentIdentity` is pallet 106 and has no constants. `Proxy` is 32, `Multisig` 31, `Utility` 30.
- `ComputeChannel` is pallet 103 with 63 storage items. Calls 0 to 5 are `open_channel`,
  `top_up_escrow`, `settle`, `force_settle`, `finalize`, `timeout`.

Read through `wss://rpc.devnet.flop.network` at finalized block 3491724
(`0x56c8903a6b0593bc45d7074eaf4f86150df7f2b9a1cdf8abbeed9f5f913d65d7`):

- The block hashes at heights 3488117, 3479200, 3479245 and 3488318 are the ones the report gives.
- Our own identity (`5HEA8QECFwBg1F9cxoXzvQzryu2d5qj5zASJS7owNW2zebBz`) has nonce 0, 25 FLOP free
  and nothing reserved. It has no `AgentWallet.Wallets` entry and no
  `FlopSessionKeys.DelegateSessions` entry. The storage keys the report gives for it are right.
- The report's example session, read at its creation block 3488117 with the key the report gives:
  154 bytes holding the owner, the delegate, lifetime cap 782555000000000000, limit per call
  96697000000000000, daily cap 1874087000000000000, nothing spent, epoch start 3488117, expiry
  3594051, no allowed pallets listed, active. At the head the same key shows 5696000000000000 spent
  and the session no longer active. That fits the report's transfer and revocation examples.
- The worked channel `0x9f81f65b…ddd7` is still 288 bytes at the head, and its first 32 bytes are
  the account `0xd4a6e5ddeffd045fac51bc3ec81937436730cfd8e75433ed81ce01e20d188b79`. That is the
  gateway's channel account, not our seat.
- `FlopSessionKeys.TotalSessions` is 8548 and `AgentWallet.TotalWallets` is 8959. The report read
  8380 and 8789 about an hour earlier.

Not confirmed by us: every statement the report marks `[source]` about the gateway's enrollment and
allowance (we have not enrolled), the fee and balance movements of its worked examples, and
everything it marks `[unknown]`. We sent no transaction either.

## What it means for this repo

- `imd-flop`'s daily cap and job budget are counted in its own ledger, and the child key's limit is
  enforced by the gateway. Neither is enforced by the chain. The README already says the promise
  rests on a gateway that enforces the child key's cap. It must never say more.
- Through the hosted gateway a seat does not put its own chain balance at risk today. What the cap
  protects there is the allowance the gateway issued. That changes what a paid run costs a seat. It
  does not change the rule that the cap is never passed silently.
- The design this lab already uses (the owner keeps the seat wallet, the worker holds a separate
  device key) is the shape of a `FlopSessionKeys` session. If FLOP confirms that a session may call
  `ComputeChannel`, the hard cap is one owner signed `create_session` and a provider in `imd-flop`
  that sends its channel calls through `execute_via_session`. The hold floor then has a backstop the
  chain enforces.
- The observatory can show a seat's limit and how much of it is used with three storage reads at a
  finalized block: `Sessions(S, D)`, `SessionNonces(S, D)` and `CircuitBreakers(D)`. That is work
  for after the decoder.
- A cap per 86400 blocks is not a cap per UTC day. If the cap moves on chain, the product has to
  say which day it means.
- The ten questions at the end of the report join the six from the first report. They are the list
  to raise with the FLOP team.
