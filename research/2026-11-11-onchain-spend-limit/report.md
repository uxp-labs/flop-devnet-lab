# FLOP seat spending controls: runtime bounds and the hosted-gateway gap

[RPC] Research snapshot: 2026-11-11, FLOP Devnet, `tzkv-runtime` spec `1014014`. The exact block, state root, metadata hash, node version and later canonical-block checks are recorded below. This report uses only public reads; it creates no account, key, enrollment, payment or transaction.

[inference] **Decision for imd-flop:** do not advertise the hosted gateway's `max_spend` or a locally counted daily quota as a chain-enforced daily inference cap. The runtime exposes genuine wallet and delegated-session budgets, but the published gateway interface does not bind its bearer allowance to either budget. The smallest promising runtime primitive is an owner-held seat account granting a separate device key a capped session, with every value-committing call dispatched through that session. Using this for the hosted gateway requires an integration that was not established here. Funding a separate account with a bounded amount provides an immediate balance-at-risk bound, but does not make the gateway's off-chain quota or a UTC daily counter on-chain. Evidence: sections 2–7.

[inference] Evidence labels apply to every factual paragraph and table row: **[RPC]** = this run's node response or metadata (including metadata documentation); **[source]** = public API, source package, documentation or explicitly attributed issue report; **[inference]** = conclusion/design derived from named evidence; **[unknown]** = not established. Metadata documentation describes intended runtime checks; successful historical calls do not prove rejection of every adversarial call. No custom FLOP pallet implementation was obtained, so this is an interface-accurate integration specification with explicit assurance gaps, not an implementation audit.

[source] Public documentation itself labels the agent-account page “Draft whitepaper”; the yellowpaper is a research draft and distinguishes requirements from implemented/publicly reproducible evidence. The report does not treat either as proof of current execution. [Agent accounts](https://docs.flop.network/docs/agent-accounts-and-spend-control), [yellowpaper reading guide](https://github.com/flop-labs/yellowpaper#how-to-interpret-evidence).

## 1. Inventory at spec 1014014

[RPC] The following tables exhaust the calls, storage, events, errors and constants of `AgentWallet`, `FlopSessionKeys`, `AgentIdentity`, `Proxy`, `Multisig` and `Utility`. Appendix A gives the same exhaustive inventory for related balance, scheduling, escrow, vesting, subsidy, storage-budget and emergency mechanisms; Appendix B resolves **every** SCALE type ID, including nested call and authorization types. All types are from the captured v14 registry, not guessed from SDK TypeScript. `u128` amounts are raw units, not display FLOP; `AccountId32` is 32 bytes; `H256` is 32 bytes. [Raw metadata](../evidence/metadata.scale), [decoded metadata](../evidence/metadata.json).

[RPC] Runtime pallet names are case-sensitive metadata names (`FlopSessionKeys`, `AgentWallet`, `AgentIdentity`). SDK APIs use camelCase sections/methods; the tables use the actual encoded call variant names. A call starts with the pallet index byte, then call index byte, followed by the listed SCALE fields. An event similarly uses pallet/event discriminants. For example `AgentWallet.create_wallet` begins `0x5f00`; `FlopSessionKeys.execute_via_session` begins `0x5e02`. [Metadata](../evidence/metadata.json).

[RPC] `AgentIdentity` has **no exposed constants**, although `register_agent` documentation says minimum stake is enforced. Thus the minimum cannot be supplied from this metadata as a constant. `AgentWallet` has no update-limit, update-destination, remove-wallet or rotate-agent dispatchable. `FlopSessionKeys.update_session_limits` changes per-transaction/daily values, not lifetime cap, expiry, delegate or allowlist. `ProxyType` exposes exactly `Any=0`, `NonTransfer=1`, `Governance=2`, `Staking=3`, `CancelProxy=4`; it has no user-defined “inference-only with amount X” variant. [Metadata types #112, #232, #327](../evidence/metadata.json).

[inference] The broader runtime includes Treasury/Bounties/ChildBounties governance spending, staking and model/compute/storage economics. Those are not owner-settable seat allowances. Full metadata for all pallets is retained so this classification is inspectable. Appendix A includes `DelegationCap` precisely to prevent confusing its validator delegation multiplier with an inference budget, and `PaidStorage` because its lane budgets are real but concern a different service. No separate general-purpose script/spend-condition pallet was identified; `HasStation` is the exposed condition/HTLC/escrow interface. [Complete pallet list and call registry](../evidence/metadata.json).

| Evidence | Item | Value |
|---|---|---|
| [RPC] | Snapshot finalized block | 3488318 / `0x20c874cb316e12de87b2eb156e5af742bcc594f54f100164c08806d4419d3d05` |
| [RPC] | Snapshot state root | `0x63ab6948d33a468f642c2cc664cc67b14b1665e503d0ab8418171457f5f41432` |
| [RPC] | Fetched UTC | 2026-11-11T16:47:25.360676+00:00 |
| [RPC] | Chain / node | FLOP Devnet / 1.1.0-13ff7e2c334 |
| [RPC] | Genesis | `0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631` |
| [RPC] | Runtime | tzkv-runtime spec 1014014; transactionVersion 2 |
| [RPC] | Metadata | v14; 482132 bytes; SHA-256 `f4fd2addba7fff1129483d0e66b8e6bc69141292f56443e201d3f073aab03444` |
| [RPC] | Runtime :code storage hash | `0x6d47bb492fb404e33d7ea8feedf4ddf5a04ffbc9d5d3a64235641cd06144c1df` |
| [RPC] | Properties | {"ss58Format":42,"tokenDecimals":18,"tokenSymbol":"FLOP"} |
| [RPC] | Archive spot check | Block 1 0xa6d964fd0f5d371ab72b8e9d46df191bc09382c2ee5e06a0564365f9487e220f; Timestamp.Now=1790775771001 |
| [RPC] | Later finalized verification | 3489681 / `0xd6bef28d9f32656994e059a21069c38a6686c1046edaf456e25d95bd9ddb1078`; 16 canonical captured blocks |

[RPC] Anchor values: [snapshot](../evidence/anchor.json), [code hash](../evidence/runtime-code-hash.json), [archive read](../evidence/block1.json), [canonical checks](../evidence/final-verification.json). Examples may postdate the initial identity snapshot; the later verification anchors those blocks.

### AgentWallet — pallet 95

[RPC] Agent transfer guardrails, funding accounting, owner freeze and buyer-signed sponsored exact payments. Interface and descriptions below are read from metadata, not a source audit. [Metadata](../evidence/metadata.json); canonical RPC: `state_getMetadata(H)` at [node](https://rpc.devnet.flop.network).

#### Calls

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `create_wallet` | `agent: sp_core::crypto::AccountId32 (#0)`; `per_tx_limit: u128`; `daily_cap: u128`; `allowed_destinations: Vec<sp_core::crypto::AccountId32 (#0)>` | Create a wallet for an agent with spending guardrails.  Only the owner can create a wallet. The agent account must not already have a wallet. |
| [RPC] | 1 | `fund_wallet` | `agent: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | Fund an agent wallet. Anyone can fund any agent wallet. |
| [RPC] | 2 | `agent_transfer` | `destination: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | Agent transfers FLOP to a destination, subject to guardrails.  Checks: 1. Wallet is active 2. Amount <= per_tx_limit 3. epoch_spent + amount <= daily_cap (with auto-epoch-reset) 4. Destination is in allowlist (if allowlist is non-empty) |
| [RPC] | 3 | `owner_withdraw` | `agent: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | Owner withdraws funds from the agent wallet.  SECURITY FIX (HIGH-01): The budget guard operates on the segregated wallet-funded balance (`WalletFunds`), NOT the agent account's commingled free balance. The owner can withdraw only wallet funds in excess of the agent's remaining daily budget (`daily_cap - epoch_spent`); the agent's personal balance is never withdrawable. Over-withdrawal is REJECTED (`InsufficientBalance`) rather than silently clamped, so the caller never gets `Ok` for a partial move. |
| [RPC] | 4 | `deactivate_wallet` | `agent: sp_core::crypto::AccountId32 (#0)` | Owner deactivates the agent wallet (freeze). |
| [RPC] | 5 | `reactivate_wallet` | `agent: sp_core::crypto::AccountId32 (#0)` | Owner reactivates the agent wallet. |
| [RPC] | 6 | `settle_sponsored_payment` | `authorization: pallet_agent_wallet::pallet::ExactPaymentAuthorization (#233)`; `signature: sp_runtime::MultiSignature (#153)` | Settle one buyer-signed x402 `exact` native FLOP authorization.  The signed origin pays the transaction fee and MUST equal the facilitator bound in the authorization. No facilitator fee is debited from the buyer. |
| [RPC] | 7 | `revoke_sponsored_payment` | `payment_id: primitive_types::H256 (#13)` | Permanently revoke an unsettled payment identifier for this payer. |
| [RPC] | 8 | `prune_sponsored_payment` | `payer: sp_core::crypto::AccountId32 (#0)`; `payment_id: primitive_types::H256 (#13)` | Remove a detailed settlement record after expiry. The permanent consumed-ID tombstone is intentionally retained. |

#### Storage

| Evidence | Storage prefix / item | Modifier | Hashers in key order | Key SCALE type | Stored value SCALE type | Purpose |
|---|---|---|---|---|---|---|
| [RPC] | `AgentWallet.Wallets` | Optional | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `pallet_agent_wallet::pallet::AgentWalletConfig (#705)` | Wallet configuration indexed by agent account. |
| [RPC] | `AgentWallet.WalletCount` | Default | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `u32` | Number of wallets per owner. |
| [RPC] | `AgentWallet.TotalWallets` | Default | plain | `—` | `u64` | Total agent wallets created. |
| [RPC] | `AgentWallet.WalletFunds` | Default | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `u128` | Wallet-funded balance per agent, segregated from the agent account's  personal free balance. Incremented by `fund_wallet`, decremented by agent  spends and owner withdrawals. The owner-withdraw budget guard operates on  this value so it cannot be defeated by the agent's commingled personal  funds (HIGH-01). |
| [RPC] | `AgentWallet.SponsoredSettlements` | Optional | Blake2_128Concat, Blake2_128Concat | `(sp_core::crypto::AccountId32 (#0), primitive_types::H256 (#13))` | `pallet_agent_wallet::pallet::SponsoredSettlementRecord (#708)` | Detailed successful-settlement accounting. Entries are prunable after expiry;  the compact consumed-ID tombstone below remains permanently replay-safe. |
| [RPC] | `AgentWallet.ConsumedSponsoredPayments` | Default | Blake2_128Concat, Blake2_128Concat | `(sp_core::crypto::AccountId32 (#0), primitive_types::H256 (#13))` | `bool` | Permanent compact replay tombstones. Payment identifiers are never reusable  by the same payer, even after detailed accounting records are pruned. |
| [RPC] | `AgentWallet.RevokedSponsoredPayments` | Default | Blake2_128Concat, Blake2_128Concat | `(sp_core::crypto::AccountId32 (#0), primitive_types::H256 (#13))` | `bool` | Permanent payer revocations for authorizations that have not settled yet.  They intentionally cannot be pruned: a payer may have signed more than one  validity window for the same identifier, so no supplied expiry is safe. |

#### Events

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `WalletCreated` | `owner: sp_core::crypto::AccountId32 (#0)`; `agent: sp_core::crypto::AccountId32 (#0)`; `per_tx_limit: u128`; `daily_cap: u128` | An agent wallet was created. |
| [RPC] | 1 | `WalletFunded` | `agent: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | An agent wallet was funded. |
| [RPC] | 2 | `AgentTransfer` | `agent: sp_core::crypto::AccountId32 (#0)`; `destination: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | An agent transferred FLOP via its wallet. |
| [RPC] | 3 | `OwnerWithdraw` | `owner: sp_core::crypto::AccountId32 (#0)`; `agent: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | The owner withdrew funds from the agent wallet. |
| [RPC] | 4 | `WalletDeactivated` | `owner: sp_core::crypto::AccountId32 (#0)`; `agent: sp_core::crypto::AccountId32 (#0)` | An agent wallet was deactivated. |
| [RPC] | 5 | `WalletReactivated` | `owner: sp_core::crypto::AccountId32 (#0)`; `agent: sp_core::crypto::AccountId32 (#0)` | An agent wallet was reactivated. |
| [RPC] | 6 | `EpochReset` | `agent: sp_core::crypto::AccountId32 (#0)` | Spending epoch was reset for an agent. |
| [RPC] | 7 | `SponsoredPaymentSettled` | `payment_id: primitive_types::H256 (#13)`; `settlement_hash: primitive_types::H256 (#13)`; `resource: primitive_types::H256 (#13)`; `payer: sp_core::crypto::AccountId32 (#0)`; `payee: sp_core::crypto::AccountId32 (#0)`; `facilitator: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | A facilitator settled one buyer-authorized native FLOP payment. |
| [RPC] | 8 | `SponsoredPaymentRevoked` | `payer: sp_core::crypto::AccountId32 (#0)`; `payment_id: primitive_types::H256 (#13)` | A payer revoked an unsettled authorization identifier. |
| [RPC] | 9 | `SponsoredPaymentRecordPruned` | `payer: sp_core::crypto::AccountId32 (#0)`; `payment_id: primitive_types::H256 (#13)` | An expired detailed settlement record was removed; replay tombstone remains. |

#### Errors

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `WalletAlreadyExists` | () | Wallet already exists for this agent. |
| [RPC] | 1 | `WalletNotFound` | () | Wallet not found for this agent. |
| [RPC] | 2 | `WalletInactive` | () | Wallet is not active. |
| [RPC] | 3 | `PerTxLimitExceeded` | () | Transfer exceeds per-transaction limit. |
| [RPC] | 4 | `DailyCapExceeded` | () | Transfer exceeds daily spending cap. |
| [RPC] | 5 | `DestinationNotAllowed` | () | Destination not in allowlist. |
| [RPC] | 6 | `NotOwner` | () | Only the owner can manage this wallet. |
| [RPC] | 7 | `NotAgent` | () | Only the agent can spend from this wallet. |
| [RPC] | 8 | `TooManyDestinations` | () | Too many destinations in the allowlist. |
| [RPC] | 9 | `TooManyWallets` | () | Too many wallets for this owner. |
| [RPC] | 10 | `InsufficientBalance` | () | Insufficient wallet balance. |
| [RPC] | 11 | `SessionCapExceeded` | () | Delegate's session is invalid or the spend exceeds its limits (CRIT-04). |
| [RPC] | 12 | `DestinationNotApprovedComputeSink` | () | Locked compute principal cannot be consumed for this destination: it is not a registered compute sink. Add the destination to an explicit allowlist AND ensure the runtime's `IsApprovedComputeSink` recognises it. |
| [RPC] | 13 | `WrongPaymentDomain` | () | Authorization uses an unsupported x402 protocol or FLOP mechanism version. |
| [RPC] | 14 | `WrongNetwork` | () | Authorization is for a different chain genesis hash. |
| [RPC] | 15 | `UnsupportedAsset` | () | Only native FLOP (asset id 0) is supported by this exact-v1 call. |
| [RPC] | 16 | `WrongFacilitator` | () | The submitting origin is not the facilitator bound by the buyer. |
| [RPC] | 17 | `AuthorizationNotYetValid` | () | Authorization is not active yet. |
| [RPC] | 18 | `AuthorizationExpired` | () | Authorization has expired. |
| [RPC] | 19 | `InvalidValidityWindow` | () | Authorization validity bounds are reversed. |
| [RPC] | 20 | `InvalidAuthorizationSignature` | () | Buyer signature does not verify over the canonical domain and SCALE payload. |
| [RPC] | 21 | `PaymentAlreadySettled` | () | This payer/payment identifier has already settled. |
| [RPC] | 22 | `PaymentRevoked` | () | The payer revoked this authorization before settlement. |
| [RPC] | 23 | `PaymentStateNotPrunable` | () | Replay/revocation state is absent or is not yet safe to prune. |

#### Constants

| Evidence | Constant | SCALE type | Decoded value (raw base units unless stated) | Purpose |
|---|---|---|---|---|
| [RPC] | `MaxAllowedDestinations` | `u32` | `16` | Maximum destination accounts in the allowlist. |
| [RPC] | `EpochLength` | `u32` | `86400` | Blocks per spending epoch (daily cap reset interval). |
| [RPC] | `MaxWalletsPerOwner` | `u32` | `10` | Maximum wallets per owner. |

### FlopSessionKeys — pallet 94

[RPC] Owner/delegate capabilities, lifetime/per-call/epoch caps, expiry, nonce and velocity breaker. Interface and descriptions below are read from metadata, not a source audit. [Metadata](../evidence/metadata.json); canonical RPC: `state_getMetadata(H)` at [node](https://rpc.devnet.flop.network).

#### Calls

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `create_session` | `delegate: sp_core::crypto::AccountId32 (#0)`; `spending_cap: u128`; `per_tx_limit: u128`; `daily_cap: u128`; `duration_blocks: u32`; `allowed_pallets: Vec<Vec<u8>>` | Create a new session granting `delegate` bounded capabilities.  # Arguments - `delegate`: Account that will use the session - `spending_cap`: Maximum FLOP the delegate may spend (lifetime) - `per_tx_limit`: R7-P0-08: Maximum FLOP per single transaction - `daily_cap`: R7-P0-08: Maximum FLOP per epoch (daily cap) - `duration_blocks`: How many blocks the session lasts - `allowed_pallets`: Optional pallet name allowlist (empty = all). Each name must   be at most 64 bytes and the list at most `MaxAllowedPallets` long; otherwise   the call fails rather than storing a narrowed (or empty) allowlist. |
| [RPC] | 1 | `revoke_session` | `delegate: sp_core::crypto::AccountId32 (#0)` | Revoke an active session. Only the owner can revoke. |
| [RPC] | 2 | `execute_via_session` | `owner: sp_core::crypto::AccountId32 (#0)`; `call: zkv_runtime::RuntimeCall (#61)`; `spend_amount: u128`; `nonce: u64` | Execute a runtime call on behalf of the session owner.  The delegate provides the owner's account and the call to execute. The pallet verifies the session is active, within cap, and the target pallet is allowed. Includes R7-P0-08 circuit breaker and daily cap enforcement. No session may call a [`DENIED_PALLETS`] pallet or this pallet.  # Arguments - `owner`: The account that created the session - `call`: The runtime call to execute as the owner - `spend_amount`: FLOP charged against the caps. It must cover what the call   moves out of the owner's account — the larger of the free-balance drop and   the free + reserved drop — or the whole extrinsic reverts with   `SpendExceedsDeclared` - `nonce`: INV-S01 — the session's current monotonic nonce. Must equal   the stored value; it is incremented on success so the same   authorization can never be replayed. |
| [RPC] | 3 | `force_revoke` | `owner: sp_core::crypto::AccountId32 (#0)`; `delegate: sp_core::crypto::AccountId32 (#0)` | Force-revoke a session (root origin, for governance). |
| [RPC] | 4 | `force_reset_circuit_breaker` | `delegate: sp_core::crypto::AccountId32 (#0)` | R7-P0-08: Manually reset the circuit breaker for a delegate (root only). Used in emergency situations where a legitimate delegate was incorrectly tripped. |
| [RPC] | 5 | `update_session_limits` | `delegate: sp_core::crypto::AccountId32 (#0)`; `per_tx_limit: u128`; `daily_cap: u128` | R7-P0-08: Update session limits (owner only). Allows the owner to adjust per-tx limit and daily cap for an active session. Cannot increase beyond original spending_cap remaining. |

#### Storage

| Evidence | Storage prefix / item | Modifier | Hashers in key order | Key SCALE type | Stored value SCALE type | Purpose |
|---|---|---|---|---|---|---|
| [RPC] | `FlopSessionKeys.Sessions` | Optional | Blake2_128Concat, Blake2_128Concat | `(sp_core::crypto::AccountId32 (#0), sp_core::crypto::AccountId32 (#0))` | `pallet_session_keys::pallet::SessionToken (#697)` | Session tokens indexed by (owner, delegate). |
| [RPC] | `FlopSessionKeys.DelegateSessions` | Default | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `Vec<(sp_core::crypto::AccountId32 (#0), sp_core::crypto::AccountId32 (#0))>` | Reverse index: delegate -> list of (owner, delegate) pairs  This enables efficient session lookup by delegate. |
| [RPC] | `FlopSessionKeys.SessionCount` | Default | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `u32` | Count of active sessions per owner. |
| [RPC] | `FlopSessionKeys.DelegateSessionCount` | Default | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `u32` | Count of active sessions per delegate. |
| [RPC] | `FlopSessionKeys.TotalSessions` | Default | plain | `—` | `u64` | Total sessions ever created. |
| [RPC] | `FlopSessionKeys.CircuitBreakers` | Optional | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `pallet_session_keys::pallet::CircuitBreakerState (#701)` | R7-P0-08: Circuit breaker state per delegate.  Tracks spending velocity in a rolling window. |
| [RPC] | `FlopSessionKeys.RotationHistory` | Default | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `pallet_session_keys::pallet::RotationHistoryEntry (#702)` | R7-P0-08: Session rotation history for rate limiting.  Key: owner account, Value: recent session creation block numbers. |
| [RPC] | `FlopSessionKeys.SessionNonces` | Default | Blake2_128Concat, Blake2_128Concat | `(sp_core::crypto::AccountId32 (#0), sp_core::crypto::AccountId32 (#0))` | `u64` | INV-S01: monotonic per-session replay nonce, keyed by (owner, delegate).  Stored in a parallel map (rather than as a field on `SessionToken`) so the  addition does not change the on-chain encoding of existing `SessionToken`  entries — no storage migration is required. `execute_via_session` requires  the caller to supply the current value and increments it, so a replayed  authorization (stale nonce) is rejected. |

#### Events

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `SessionCreated` | `owner: sp_core::crypto::AccountId32 (#0)`; `delegate: sp_core::crypto::AccountId32 (#0)`; `spending_cap: u128`; `per_tx_limit: u128`; `daily_cap: u128`; `expires_at: u32` | A new session was created. |
| [RPC] | 1 | `SessionRevoked` | `owner: sp_core::crypto::AccountId32 (#0)`; `delegate: sp_core::crypto::AccountId32 (#0)` | A session was revoked by the owner. |
| [RPC] | 2 | `SessionCallExecuted` | `owner: sp_core::crypto::AccountId32 (#0)`; `delegate: sp_core::crypto::AccountId32 (#0)`; `spent: u128`; `epoch_spent: u128` | A delegate executed a call via session. |
| [RPC] | 3 | `SessionExpired` | `owner: sp_core::crypto::AccountId32 (#0)`; `delegate: sp_core::crypto::AccountId32 (#0)` | A session expired and was cleaned up. |
| [RPC] | 4 | `DailyCapReset` | `owner: sp_core::crypto::AccountId32 (#0)`; `delegate: sp_core::crypto::AccountId32 (#0)` | R7-P0-08: Daily spending epoch was reset for a session. |
| [RPC] | 5 | `CircuitBreakerTripped` | `delegate: sp_core::crypto::AccountId32 (#0)`; `tx_count: u32`; `total_spend: u128`; `period_start: u32` | R7-P0-08: Circuit breaker was tripped for a delegate. |
| [RPC] | 6 | `CircuitBreakerReset` | `delegate: sp_core::crypto::AccountId32 (#0)` | R7-P0-08: Circuit breaker period was reset. |
| [RPC] | 7 | `SessionRotationLimited` | `owner: sp_core::crypto::AccountId32 (#0)`; `count_in_window: u32` | R7-P0-08: Session creation rate-limited for owner. |

#### Errors

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `SessionAlreadyExists` | () | Session already exists for this owner-delegate pair. |
| [RPC] | 1 | `SessionNotFound` | () | Session not found. |
| [RPC] | 2 | `SessionExpired` | () | Session has expired. |
| [RPC] | 3 | `SessionRevoked` | () | Session has been revoked. |
| [RPC] | 4 | `SpendingCapExceeded` | () | Total spending cap exceeded. |
| [RPC] | 5 | `PerTxLimitExceeded` | () | R7-P0-08: Per-transaction limit exceeded. |
| [RPC] | 6 | `DailyCapExceeded` | () | R7-P0-08: Daily spending cap exceeded. |
| [RPC] | 7 | `PalletNotAllowed` | () | Pallet not in allowlist. |
| [RPC] | 8 | `TooManySessions` | () | Too many active sessions for this owner. |
| [RPC] | 9 | `DurationTooLong` | () | Session duration exceeds maximum. |
| [RPC] | 10 | `NotOwner` | () | Only the owner can manage this session. |
| [RPC] | 11 | `NotDelegate` | () | Only the delegate can execute via this session. |
| [RPC] | 12 | `SelfDelegation` | () | Cannot create session for self. |
| [RPC] | 13 | `CircuitBreakerTripped` | () | R7-P0-08: Circuit breaker tripped — delegate must wait for period reset. |
| [RPC] | 14 | `SessionRotationLimited` | () | R7-P0-08: Session rotation rate limit exceeded. |
| [RPC] | 15 | `InvalidSessionNonce` | () | INV-S01: supplied session nonce does not match the expected value (stale/replayed authorization). |
| [RPC] | 16 | `PalletNameTooLong` | () | An `allowed_pallets` entry is longer than 64 bytes. |
| [RPC] | 17 | `TooManyAllowedPallets` | () | `allowed_pallets` has more entries than `MaxAllowedPallets`. |
| [RPC] | 18 | `SpendExceedsDeclared` | () | The dispatched call moved more of the owner's balance than `spend_amount`. |

#### Constants

| Evidence | Constant | SCALE type | Decoded value (raw base units unless stated) | Purpose |
|---|---|---|---|---|
| [RPC] | `MaxSessionsPerOwner` | `u32` | `10` | Maximum sessions per owner. |
| [RPC] | `MaxSessionsPerDelegate` | `u32` | `10` | Maximum sessions per delegate. |
| [RPC] | `MaxAllowedPallets` | `u32` | `16` | Maximum pallets in an allowlist. |
| [RPC] | `MaxSessionDuration` | `u32` | `864000` | Maximum session duration in blocks. |
| [RPC] | `SessionEpochLength` | `u32` | `86400` | Blocks per spending epoch (daily cap reset interval).  R7-P0-08: one day; the runtime sets it to `DAYS` so it tracks block time. |
| [RPC] | `CircuitBreakerPeriod` | `u32` | `60` | Circuit breaker period in blocks.  R7-P0-08: 60 blocks (~1 min at 1s blocks). |
| [RPC] | `CircuitBreakerMaxTxs` | `u32` | `100` | Maximum transactions per circuit breaker period.  R7-P0-08: 100 transactions. |
| [RPC] | `CircuitBreakerMaxSpend` | `u128` | `250000000000000000000` | Maximum spend per circuit breaker period.  R7-P0-08: 250 FLOP. |
| [RPC] | `MaxSessionRotationsPerHour` | `u32` | `3` | Maximum session rotations per hour (rate limiting).  R7-P0-08: 3 rotations per hour. |
| [RPC] | `BlocksPerHour` | `u32` | `3600` | Blocks in an hour for rotation rate limiting.  The runtime sets it to `HOURS` so it tracks block time. |

### AgentIdentity — pallet 106

[RPC] Agent registry, profile, stake, status, reputation and licensing; not an inference debit authorization. Interface and descriptions below are read from metadata, not a source audit. [Metadata](../evidence/metadata.json); canonical RPC: `state_getMetadata(H)` at [node](https://rpc.devnet.flop.network).

#### Calls

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `register_agent` | `name: bounded_collections::bounded_vec::BoundedVec (#183)`; `agent_type: pallet_agent_identity::types::AgentType (#328)`; `capabilities: bounded_collections::bounded_vec::BoundedVec (#329)`; `endpoints: bounded_collections::bounded_vec::BoundedVec (#192)`; `metadata_uri: bounded_collections::bounded_vec::BoundedVec (#180)`; `stake_amount: u128` | Register a new agent identity on-chain.  The caller becomes the owner of the agent. Agent starts in `Pending` status. Requires minimum stake to be reserved.  # Parameters - `name`: Agent display name (max 32 bytes) - `agent_type`: Classification (autonomous, semi-autonomous, supervised, human-controlled) - `capabilities`: List of capabilities with proficiency scores - `endpoints`: API endpoints for agent interaction - `metadata_uri`: Optional off-chain metadata URI (IPFS/Arweave) - `stake_amount`: FLOP tokens to stake (minimum enforced) |
| [RPC] | 1 | `update_agent` | `agent_id: primitive_types::H256 (#13)`; `name: Option (#332)`; `capabilities: Option (#333)`; `endpoints: Option (#334)`; `metadata_uri: Option (#335)` | Update agent profile (capabilities, endpoints, metadata).  Only the agent owner can update the profile. |
| [RPC] | 2 | `deposit_stake` | `agent_id: primitive_types::H256 (#13)`; `amount: u128` | Deposit additional stake for an agent. |
| [RPC] | 3 | `withdraw_stake` | `agent_id: primitive_types::H256 (#13)`; `amount: u128` | Withdraw stake from an agent (only excess above minimum). |
| [RPC] | 4 | `record_reputation` | `agent_id: primitive_types::H256 (#13)`; `event_type: pallet_agent_identity::types::ReputationEventType (#336)`; `reason: bounded_collections::bounded_vec::BoundedVec (#184)`; `reference: Option (#102)` | Record a reputation event for an agent.  Can be called by the protocol (e.g., after task completion). |
| [RPC] | 5 | `record_tee_verification` | `agent_id: primitive_types::H256 (#13)`; `verification_type: pallet_agent_identity::types::VerificationType (#337)`; `result: pallet_agent_identity::types::VerificationResult (#338)`; `expires_at: Option (#213)`; `proof_hash: Option (#102)` | Record a TEE verification for an agent.  Called by the TEE attestation pallet or authority. |
| [RPC] | 6 | `set_license` | `agent_id: primitive_types::H256 (#13)`; `license_type: pallet_agent_identity::types::AgentLicenseType (#339)`; `price_per_task: Option (#340)`; `terms_uri: bounded_collections::bounded_vec::BoundedVec (#180)` | Set license for an agent.  Only the agent owner can set the license. |
| [RPC] | 7 | `add_authorized_user` | `agent_id: primitive_types::H256 (#13)`; `user: sp_core::crypto::AccountId32 (#0)` | Add authorized user for a whitelist agent. |
| [RPC] | 8 | `verify_agent` | `agent_id: primitive_types::H256 (#13)` | Verify an agent (authority only). |
| [RPC] | 9 | `revoke_agent` | `agent_id: primitive_types::H256 (#13)`; `reason: Vec<u8>` | Revoke an agent (authority only). |
| [RPC] | 10 | `pause_agent` | `agent_id: primitive_types::H256 (#13)` | Pause an agent (owner only). |
| [RPC] | 11 | `resume_agent` | `agent_id: primitive_types::H256 (#13)` | Resume a paused agent (owner only). |
| [RPC] | 12 | `report_task_completion` | `agent_id: primitive_types::H256 (#13)`; `success: bool`; `flop_volume: u128` | Report task completion for an agent (called by protocol).  Updates success rate, task count, and volume metrics. |

#### Storage

| Evidence | Storage prefix / item | Modifier | Hashers in key order | Key SCALE type | Stored value SCALE type | Purpose |
|---|---|---|---|---|---|---|
| [RPC] | `AgentIdentity.Agents` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `pallet_agent_identity::types::AgentIdentityEntry (#839)` | All registered agents indexed by agent_id |
| [RPC] | `AgentIdentity.AgentsByOwner` | Default | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `bounded_collections::bounded_vec::BoundedVec (#850)` | Agents indexed by owner address for reverse lookup |
| [RPC] | `AgentIdentity.AgentsByCapability` | Default | Blake2_128Concat | `pallet_agent_identity::types::AgentCapability (#330)` | `bounded_collections::bounded_vec::BoundedVec (#850)` | Agents indexed by capability for discovery |
| [RPC] | `AgentIdentity.DidToAgent` | Optional | Blake2_128Concat | `bounded_collections::bounded_vec::BoundedVec (#180)` | `primitive_types::H256 (#13)` | DID to agent_id mapping |
| [RPC] | `AgentIdentity.AgentCount` | Default | plain | `—` | `u32` | Total count of registered agents |
| [RPC] | `AgentIdentity.NextAgentId` | Default | plain | `—` | `u64` | Next agent ID counter |
| [RPC] | `AgentIdentity.GlobalStats` | Default | plain | `—` | `pallet_agent_identity::AgentGlobalStats (#851)` | Global statistics for monitoring |
| [RPC] | `AgentIdentity.AgentLicenses` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `pallet_agent_identity::types::AgentLicense (#852)` | Agent licenses indexed by agent_id |

#### Events

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `AgentRegistered` | `agent_id: primitive_types::H256 (#13)`; `owner: sp_core::crypto::AccountId32 (#0)`; `name: bounded_collections::bounded_vec::BoundedVec (#183)`; `did: bounded_collections::bounded_vec::BoundedVec (#180)`; `agent_type: pallet_agent_identity::types::AgentType (#328)` | Agent registered successfully |
| [RPC] | 1 | `AgentUpdated` | `agent_id: primitive_types::H256 (#13)`; `updated_by: sp_core::crypto::AccountId32 (#0)` | Agent profile updated |
| [RPC] | 2 | `AgentStatusChanged` | `agent_id: primitive_types::H256 (#13)`; `old_status: pallet_agent_identity::types::AgentStatus (#449)`; `new_status: pallet_agent_identity::types::AgentStatus (#449)` | Agent status changed |
| [RPC] | 3 | `AgentVerified` | `agent_id: primitive_types::H256 (#13)`; `verified_by: sp_core::crypto::AccountId32 (#0)` | Agent verified by authority |
| [RPC] | 4 | `AgentRevoked` | `agent_id: primitive_types::H256 (#13)`; `reason: Vec<u8>` | Agent revoked by authority |
| [RPC] | 5 | `StakeDeposited` | `agent_id: primitive_types::H256 (#13)`; `amount: u128`; `new_total: u128` | Stake deposited for agent |
| [RPC] | 6 | `StakeWithdrawn` | `agent_id: primitive_types::H256 (#13)`; `amount: u128`; `new_total: u128` | Stake withdrawn from agent |
| [RPC] | 7 | `ReputationEvent` | `agent_id: primitive_types::H256 (#13)`; `event_type: pallet_agent_identity::types::ReputationEventType (#336)`; `score_change: i16`; `new_score: u16` | Reputation event recorded |
| [RPC] | 8 | `TeeVerified` | `agent_id: primitive_types::H256 (#13)`; `verification_type: pallet_agent_identity::types::VerificationType (#337)`; `result: pallet_agent_identity::types::VerificationResult (#338)` | TEE verification recorded |
| [RPC] | 9 | `LicenseSet` | `agent_id: primitive_types::H256 (#13)`; `license_type: pallet_agent_identity::types::AgentLicenseType (#339)` | License set for agent |
| [RPC] | 10 | `CapabilityUpdated` | `agent_id: primitive_types::H256 (#13)`; `capability: pallet_agent_identity::types::AgentCapability (#330)`; `score: u8` | Capability proficiency updated |
| [RPC] | 11 | `TaskCompleted` | `agent_id: primitive_types::H256 (#13)`; `success: bool`; `flop_volume: u128` | Task completed by agent |

#### Errors

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `AgentAlreadyRegistered` | () | Agent already registered |
| [RPC] | 1 | `AgentNotFound` | () | Agent not found |
| [RPC] | 2 | `TooManyAgents` | () | Agent count exceeds maximum |
| [RPC] | 3 | `NotAuthorized` | () | Not the owner of the agent |
| [RPC] | 4 | `AgentNotActive` | () | Agent is not active |
| [RPC] | 5 | `AgentNotPending` | () | Agent is not pending verification |
| [RPC] | 6 | `InsufficientStake` | () | Insufficient stake |
| [RPC] | 7 | `InvalidReputationEvent` | () | Invalid reputation event |
| [RPC] | 8 | `TooManyCapabilities` | () | Capability list is full |
| [RPC] | 9 | `TooManyEndpoints` | () | Endpoint list is full |
| [RPC] | 10 | `TooManyMetadata` | () | Metadata list is full |
| [RPC] | 11 | `TooManyVerifications` | () | Verification record limit reached |
| [RPC] | 12 | `AgentAlreadyRevoked` | () | Agent is already revoked |
| [RPC] | 13 | `InvalidDID` | () | Invalid DID format |
| [RPC] | 14 | `InvalidVerifier` | () | Caller is not authorized to perform this action |
| [RPC] | 15 | `NameTooLong` | () | Name exceeds maximum length |
| [RPC] | 16 | `UriTooLong` | () | URI exceeds maximum length |
| [RPC] | 17 | `LicenseNotFound` | () | License not found |
| [RPC] | 18 | `NotAuthorizedForAgent` | () | User not authorized for this agent (whitelist) |

#### Constants

[RPC] None exposed.

### Proxy — pallet 32

[RPC] Delegates call authority using runtime-defined proxy classes and optional announcement delays. Interface and descriptions below are read from metadata, not a source audit. [Metadata](../evidence/metadata.json); canonical RPC: `state_getMetadata(H)` at [node](https://rpc.devnet.flop.network).

#### Calls

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `proxy` | `real: sp_runtime::multiaddress::MultiAddress (#72)`; `force_proxy_type: Option (#111)`; `call: zkv_runtime::RuntimeCall (#61)` | Dispatch the given `call` from an account that the sender is authorised for through `add_proxy`.  The dispatch origin for this call must be _Signed_.  Parameters: - `real`: The account that the proxy will make a call on behalf of. - `force_proxy_type`: Specify the exact proxy type to be used and checked for this call. - `call`: The call to be made by the `real` account. |
| [RPC] | 1 | `add_proxy` | `delegate: sp_runtime::multiaddress::MultiAddress (#72)`; `proxy_type: zkv_runtime::proxy::ProxyType (#112)`; `delay: u32` | Register a proxy account for the sender that is able to make calls on its behalf.  The dispatch origin for this call must be _Signed_.  Parameters: - `proxy`: The account that the `caller` would like to make a proxy. - `proxy_type`: The permissions allowed for this proxy account. - `delay`: The announcement period required of the initial proxy. Will generally be zero. |
| [RPC] | 2 | `remove_proxy` | `delegate: sp_runtime::multiaddress::MultiAddress (#72)`; `proxy_type: zkv_runtime::proxy::ProxyType (#112)`; `delay: u32` | Unregister a proxy account for the sender.  The dispatch origin for this call must be _Signed_.  Parameters: - `proxy`: The account that the `caller` would like to remove as a proxy. - `proxy_type`: The permissions currently enabled for the removed proxy account. |
| [RPC] | 3 | `remove_proxies` | () | Unregister all proxy accounts for the sender.  The dispatch origin for this call must be _Signed_.  WARNING: This may be called on accounts created by `create_pure`, however if done, then the unreserved fees will be inaccessible. **All access to this account will be lost.** |
| [RPC] | 4 | `create_pure` | `proxy_type: zkv_runtime::proxy::ProxyType (#112)`; `delay: u32`; `index: u16` | Spawn a fresh new account that is guaranteed to be otherwise inaccessible, and initialize it with a proxy of `proxy_type` for `origin` sender.  Requires a `Signed` origin.  - `proxy_type`: The type of the proxy that the sender will be registered as over the new account. This will almost always be the most permissive `ProxyType` possible to allow for maximum flexibility. - `index`: A disambiguation index, in case this is called multiple times in the same transaction (e.g. with `utility::batch`). Unless you're using `batch` you probably just want to use `0`. - `delay`: The announcement period required of the initial proxy. Will generally be zero.  Fails with `Duplicate` if this has already been called in this transaction, from the same sender, with the same parameters.  Fails if there are insufficient funds to pay for deposit. |
| [RPC] | 5 | `kill_pure` | `spawner: sp_runtime::multiaddress::MultiAddress (#72)`; `proxy_type: zkv_runtime::proxy::ProxyType (#112)`; `index: u16`; `height: Compact<u32>`; `ext_index: Compact<u32>` | Removes a previously spawned pure proxy.  WARNING: **All access to this account will be lost.** Any funds held in it will be inaccessible.  Requires a `Signed` origin, and the sender account must have been created by a call to `create_pure` with corresponding parameters.  - `spawner`: The account that originally called `create_pure` to create this account. - `index`: The disambiguation index originally passed to `create_pure`. Probably `0`. - `proxy_type`: The proxy type originally passed to `create_pure`. - `height`: The height of the chain when the call to `create_pure` was processed. - `ext_index`: The extrinsic index in which the call to `create_pure` was processed.  Fails with `NoPermission` in case the caller is not a previously created pure account whose `create_pure` call has corresponding parameters. |
| [RPC] | 6 | `announce` | `real: sp_runtime::multiaddress::MultiAddress (#72)`; `call_hash: primitive_types::H256 (#13)` | Publish the hash of a proxy-call that will be made in the future.  This must be called some number of blocks before the corresponding `proxy` is attempted if the delay associated with the proxy relationship is greater than zero.  No more than `MaxPending` announcements may be made at any one time.  This will take a deposit of `AnnouncementDepositFactor` as well as `AnnouncementDepositBase` if there are no other pending announcements.  The dispatch origin for this call must be _Signed_ and a proxy of `real`.  Parameters: - `real`: The account that the proxy will make a call on behalf of. - `call_hash`: The hash of the call to be made by the `real` account. |
| [RPC] | 7 | `remove_announcement` | `real: sp_runtime::multiaddress::MultiAddress (#72)`; `call_hash: primitive_types::H256 (#13)` | Remove a given announcement.  May be called by a proxy account to remove a call they previously announced and return the deposit.  The dispatch origin for this call must be _Signed_.  Parameters: - `real`: The account that the proxy will make a call on behalf of. - `call_hash`: The hash of the call to be made by the `real` account. |
| [RPC] | 8 | `reject_announcement` | `delegate: sp_runtime::multiaddress::MultiAddress (#72)`; `call_hash: primitive_types::H256 (#13)` | Remove the given announcement of a delegate.  May be called by a target (proxied) account to remove a call that one of their delegates (`delegate`) has announced they want to execute. The deposit is returned.  The dispatch origin for this call must be _Signed_.  Parameters: - `delegate`: The account that previously announced the call. - `call_hash`: The hash of the call to be made. |
| [RPC] | 9 | `proxy_announced` | `delegate: sp_runtime::multiaddress::MultiAddress (#72)`; `real: sp_runtime::multiaddress::MultiAddress (#72)`; `force_proxy_type: Option (#111)`; `call: zkv_runtime::RuntimeCall (#61)` | Dispatch the given `call` from an account that the sender is authorized for through `add_proxy`.  Removes any corresponding announcement(s).  The dispatch origin for this call must be _Signed_.  Parameters: - `real`: The account that the proxy will make a call on behalf of. - `force_proxy_type`: Specify the exact proxy type to be used and checked for this call. - `call`: The call to be made by the `real` account. |
| [RPC] | 10 | `poke_deposit` | () | Poke / Adjust deposits made for proxies and announcements based on current values. This can be used by accounts to possibly lower their locked amount.  The dispatch origin for this call must be _Signed_.  The transaction fee is waived if the deposit amount has changed.  Emits `DepositPoked` if successful. |

#### Storage

| Evidence | Storage prefix / item | Modifier | Hashers in key order | Key SCALE type | Stored value SCALE type | Purpose |
|---|---|---|---|---|---|---|
| [RPC] | `Proxy.Proxies` | Default | Twox64Concat | `sp_core::crypto::AccountId32 (#0)` | `(bounded_collections::bounded_vec::BoundedVec (#596), u128)` | The set of account proxies. Maps the account which has delegated to the accounts  which are being delegated to, together with the amount held on deposit. |
| [RPC] | `Proxy.Announcements` | Default | Twox64Concat | `sp_core::crypto::AccountId32 (#0)` | `(bounded_collections::bounded_vec::BoundedVec (#600), u128)` | The announcements made by the proxy (key). |

#### Events

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `ProxyExecuted` | `result: Result (#35)` | A proxy was executed correctly, with the given. |
| [RPC] | 1 | `PureCreated` | `pure: sp_core::crypto::AccountId32 (#0)`; `who: sp_core::crypto::AccountId32 (#0)`; `proxy_type: zkv_runtime::proxy::ProxyType (#112)`; `disambiguation_index: u16`; `at: u32`; `extrinsic_index: u32` | A pure account has been created by new proxy with given disambiguation index and proxy type. |
| [RPC] | 2 | `PureKilled` | `pure: sp_core::crypto::AccountId32 (#0)`; `spawner: sp_core::crypto::AccountId32 (#0)`; `proxy_type: zkv_runtime::proxy::ProxyType (#112)`; `disambiguation_index: u16` | A pure proxy was killed by its spawner. |
| [RPC] | 3 | `Announced` | `real: sp_core::crypto::AccountId32 (#0)`; `proxy: sp_core::crypto::AccountId32 (#0)`; `call_hash: primitive_types::H256 (#13)` | An announcement was placed to make a call in the future. |
| [RPC] | 4 | `ProxyAdded` | `delegator: sp_core::crypto::AccountId32 (#0)`; `delegatee: sp_core::crypto::AccountId32 (#0)`; `proxy_type: zkv_runtime::proxy::ProxyType (#112)`; `delay: u32` | A proxy was added. |
| [RPC] | 5 | `ProxyRemoved` | `delegator: sp_core::crypto::AccountId32 (#0)`; `delegatee: sp_core::crypto::AccountId32 (#0)`; `proxy_type: zkv_runtime::proxy::ProxyType (#112)`; `delay: u32` | A proxy was removed. |
| [RPC] | 6 | `DepositPoked` | `who: sp_core::crypto::AccountId32 (#0)`; `kind: pallet_proxy::DepositKind (#397)`; `old_deposit: u128`; `new_deposit: u128` | A deposit stored for proxies or announcements was poked / updated. |

#### Errors

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `TooMany` | () | There are too many proxies registered or too many announcements pending. |
| [RPC] | 1 | `NotFound` | () | Proxy registration not found. |
| [RPC] | 2 | `NotProxy` | () | Sender is not a proxy of the account to be proxied. |
| [RPC] | 3 | `Unproxyable` | () | A call which is incompatible with the proxy type's filter was attempted. |
| [RPC] | 4 | `Duplicate` | () | Account is already a proxy. |
| [RPC] | 5 | `NoPermission` | () | Call may not be made by proxy because it may escalate its privileges. |
| [RPC] | 6 | `Unannounced` | () | Announcement, if made at all, was made too recently. |
| [RPC] | 7 | `NoSelfProxy` | () | Cannot add self as proxy. |

#### Constants

| Evidence | Constant | SCALE type | Decoded value (raw base units unless stated) | Purpose |
|---|---|---|---|---|
| [RPC] | `ProxyDepositBase` | `u128` | `2008000000000000000` | The base amount of currency needed to reserve for creating a proxy.   This is held for an additional storage item whose value size is  `sizeof(Balance)` bytes and whose key size is `sizeof(AccountId)` bytes. |
| [RPC] | `ProxyDepositFactor` | `u128` | `33000000000000000` | The amount of currency needed per proxy added.   This is held for adding 32 bytes plus an instance of `ProxyType` more into a  pre-existing storage value. Thus, when configuring `ProxyDepositFactor` one should take  into account `32 + proxy_type.encode().len()` bytes of data. |
| [RPC] | `MaxProxies` | `u32` | `32` | The maximum amount of proxies allowed for a single account. |
| [RPC] | `MaxPending` | `u32` | `32` | The maximum amount of time-delayed announcements that are allowed to be pending. |
| [RPC] | `AnnouncementDepositBase` | `u128` | `2008000000000000000` | The base amount of currency needed to reserve for creating an announcement.   This is held when a new storage item holding a `Balance` is created (typically 16  bytes). |
| [RPC] | `AnnouncementDepositFactor` | `u128` | `66000000000000000` | The amount of currency needed per announcement made.   This is held for adding an `AccountId`, `Hash` and `BlockNumber` (typically 68 bytes)  into a pre-existing storage value. |

### Multisig — pallet 31

[RPC] Threshold approval of a specific call/hash; no daily numeric spend ledger. Interface and descriptions below are read from metadata, not a source audit. [Metadata](../evidence/metadata.json); canonical RPC: `state_getMetadata(H)` at [node](https://rpc.devnet.flop.network).

#### Calls

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `as_multi_threshold_1` | `other_signatories: Vec<sp_core::crypto::AccountId32 (#0)>`; `call: zkv_runtime::RuntimeCall (#61)` | Immediately dispatch a multi-signature call using a single approval from the caller.  The dispatch origin for this call must be _Signed_.  - `other_signatories`: The accounts (other than the sender) who are part of the multi-signature, but do not participate in the approval process. - `call`: The call to be executed.  Result is equivalent to the dispatched result.  ## Complexity O(Z + C) where Z is the length of the call and C its execution weight. |
| [RPC] | 1 | `as_multi` | `threshold: u16`; `other_signatories: Vec<sp_core::crypto::AccountId32 (#0)>`; `maybe_timepoint: Option (#108)`; `call: zkv_runtime::RuntimeCall (#61)`; `max_weight: sp_weights::weight_v2::Weight (#10)` | Register approval for a dispatch to be made from a deterministic composite account if approved by a total of `threshold - 1` of `other_signatories`.  **If the approval threshold is met (including the sender's approval), this will immediately execute the call.** This is the only way to execute a multisig call - `approve_as_multi` will never trigger execution.  Payment: `DepositBase` will be reserved if this is the first approval, plus `threshold` times `DepositFactor`. It is returned once this dispatch happens or is cancelled.  The dispatch origin for this call must be _Signed_.  - `threshold`: The total number of approvals for this dispatch before it is executed. - `other_signatories`: The accounts (other than the sender) who can approve this dispatch. May not be empty. - `maybe_timepoint`: If this is the first approval, then this must be `None`. If it is not the first approval, then it must be `Some`, with the timepoint (block number and transaction index) of the first approval transaction. - `call`: The call to be executed.  NOTE: For intermediate approvals (not the final approval), you should generally use `approve_as_multi` instead, since it only requires a hash of the call and is more efficient.  Result is equivalent to the dispatched result if `threshold` is exactly `1`. Otherwise on success, result is `Ok` and the result from the interior call, if it was executed, may be found in the deposited `MultisigExecuted` event.  ## Complexity - `O(S + Z + Call)`. - Up to one balance-reserve or unreserve operation. - One passthrough operation, one insert, both `O(S)` where `S` is the number of   signatories. `S` is capped by `MaxSignatories`, with weight being proportional. - One call encode & hash, both of complexity `O(Z)` where `Z` is tx-len. - One encode & hash, both of complexity `O(S)`. - Up to one binary search and insert (`O(logS + S)`). - I/O: 1 read `O(S)`, up to 1 mutate `O(S)`. Up to one remove. - One event. - The weight of the `call`. - Storage: inserts one item, value size bounded by `MaxSignatories`, with a deposit   taken for its lifetime of `DepositBase + threshold * DepositFactor`. |
| [RPC] | 2 | `approve_as_multi` | `threshold: u16`; `other_signatories: Vec<sp_core::crypto::AccountId32 (#0)>`; `maybe_timepoint: Option (#108)`; `call_hash: [u8;32]`; `max_weight: sp_weights::weight_v2::Weight (#10)` | Register approval for a dispatch to be made from a deterministic composite account if approved by a total of `threshold - 1` of `other_signatories`.  **This function will NEVER execute the call, even if the approval threshold is reached.** It only registers approval. To actually execute the call, `as_multi` must be called with the full call data by any of the signatories.  This function is more efficient than `as_multi` for intermediate approvals since it only requires the call hash, not the full call data.  Payment: `DepositBase` will be reserved if this is the first approval, plus `threshold` times `DepositFactor`. It is returned once this dispatch happens or is cancelled.  The dispatch origin for this call must be _Signed_.  - `threshold`: The total number of approvals for this dispatch before it is executed. - `other_signatories`: The accounts (other than the sender) who can approve this dispatch. May not be empty. - `maybe_timepoint`: If this is the first approval, then this must be `None`. If it is not the first approval, then it must be `Some`, with the timepoint (block number and transaction index) of the first approval transaction. - `call_hash`: The hash of the call to be executed.  NOTE: To execute the call after approvals are gathered, any signatory must call `as_multi` with the full call data. This function cannot execute the call.  ## Complexity - `O(S)`. - Up to one balance-reserve or unreserve operation. - One passthrough operation, one insert, both `O(S)` where `S` is the number of   signatories. `S` is capped by `MaxSignatories`, with weight being proportional. - One encode & hash, both of complexity `O(S)`. - Up to one binary search and insert (`O(logS + S)`). - I/O: 1 read `O(S)`, up to 1 mutate `O(S)`. Up to one remove. - One event. - Storage: inserts one item, value size bounded by `MaxSignatories`, with a deposit   taken for its lifetime of `DepositBase + threshold * DepositFactor`. |
| [RPC] | 3 | `cancel_as_multi` | `threshold: u16`; `other_signatories: Vec<sp_core::crypto::AccountId32 (#0)>`; `timepoint: pallet_multisig::Timepoint (#109)`; `call_hash: [u8;32]` | Cancel a pre-existing, on-going multisig transaction. Any deposit reserved previously for this operation will be unreserved on success.  The dispatch origin for this call must be _Signed_.  - `threshold`: The total number of approvals for this dispatch before it is executed. - `other_signatories`: The accounts (other than the sender) who can approve this dispatch. May not be empty. - `timepoint`: The timepoint (block number and transaction index) of the first approval transaction for this dispatch. - `call_hash`: The hash of the call to be executed.  ## Complexity - `O(S)`. - Up to one balance-reserve or unreserve operation. - One passthrough operation, one insert, both `O(S)` where `S` is the number of   signatories. `S` is capped by `MaxSignatories`, with weight being proportional. - One encode & hash, both of complexity `O(S)`. - One event. - I/O: 1 read `O(S)`, one remove. - Storage: removes one item. |
| [RPC] | 4 | `poke_deposit` | `threshold: u16`; `other_signatories: Vec<sp_core::crypto::AccountId32 (#0)>`; `call_hash: [u8;32]` | Poke the deposit reserved for an existing multisig operation.  The dispatch origin for this call must be _Signed_ and must be the original depositor of the multisig operation.  The transaction fee is waived if the deposit amount has changed.  - `threshold`: The total number of approvals needed for this multisig. - `other_signatories`: The accounts (other than the sender) who are part of the   multisig. - `call_hash`: The hash of the call this deposit is reserved for.  Emits `DepositPoked` if successful. |

#### Storage

| Evidence | Storage prefix / item | Modifier | Hashers in key order | Key SCALE type | Stored value SCALE type | Purpose |
|---|---|---|---|---|---|---|
| [RPC] | `Multisig.Multisigs` | Optional | Twox64Concat, Blake2_128Concat | `(sp_core::crypto::AccountId32 (#0), [u8;32])` | `pallet_multisig::Multisig (#592)` | The set of open multisig operations. |

#### Events

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `NewMultisig` | `approving: sp_core::crypto::AccountId32 (#0)`; `multisig: sp_core::crypto::AccountId32 (#0)`; `call_hash: [u8;32]` | A new multisig operation has begun. |
| [RPC] | 1 | `MultisigApproval` | `approving: sp_core::crypto::AccountId32 (#0)`; `timepoint: pallet_multisig::Timepoint (#109)`; `multisig: sp_core::crypto::AccountId32 (#0)`; `call_hash: [u8;32]` | A multisig operation has been approved by someone. |
| [RPC] | 2 | `MultisigExecuted` | `approving: sp_core::crypto::AccountId32 (#0)`; `timepoint: pallet_multisig::Timepoint (#109)`; `multisig: sp_core::crypto::AccountId32 (#0)`; `call_hash: [u8;32]`; `result: Result (#35)` | A multisig operation has been executed. |
| [RPC] | 3 | `MultisigCancelled` | `cancelling: sp_core::crypto::AccountId32 (#0)`; `timepoint: pallet_multisig::Timepoint (#109)`; `multisig: sp_core::crypto::AccountId32 (#0)`; `call_hash: [u8;32]` | A multisig operation has been cancelled. |
| [RPC] | 4 | `DepositPoked` | `who: sp_core::crypto::AccountId32 (#0)`; `call_hash: [u8;32]`; `old_deposit: u128`; `new_deposit: u128` | The deposit for a multisig operation has been updated/poked. |

#### Errors

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `MinimumThreshold` | () | Threshold must be 2 or greater. |
| [RPC] | 1 | `AlreadyApproved` | () | Call is already approved by this signatory. |
| [RPC] | 2 | `NoApprovalsNeeded` | () | Call doesn't need any (more) approvals. |
| [RPC] | 3 | `TooFewSignatories` | () | There are too few signatories in the list. |
| [RPC] | 4 | `TooManySignatories` | () | There are too many signatories in the list. |
| [RPC] | 5 | `SignatoriesOutOfOrder` | () | The signatories were provided out of order; they should be ordered. |
| [RPC] | 6 | `SenderInSignatories` | () | The sender was contained in the other signatories; it shouldn't be. |
| [RPC] | 7 | `NotFound` | () | Multisig operation not found in storage. |
| [RPC] | 8 | `NotOwner` | () | Only the account that originally created the multisig is able to cancel it or update its deposits. |
| [RPC] | 9 | `NoTimepoint` | () | No timepoint was given, yet the multisig operation is already underway. |
| [RPC] | 10 | `WrongTimepoint` | () | A different timepoint was given to the multisig operation that is underway. |
| [RPC] | 11 | `UnexpectedTimepoint` | () | A timepoint was given, yet no multisig operation is underway. |
| [RPC] | 12 | `MaxWeightTooLow` | () | The maximum weight information provided was too low. |
| [RPC] | 13 | `AlreadyStored` | () | The data to be stored is already stored. |

#### Constants

| Evidence | Constant | SCALE type | Decoded value (raw base units unless stated) | Purpose |
|---|---|---|---|---|
| [RPC] | `DepositBase` | `u128` | `2088000000000000000` | The base amount of currency needed to reserve for creating a multisig execution or to  store a dispatch call for later.   This is held for an additional storage item whose value size is  `4 + sizeof((BlockNumber, Balance, AccountId))` bytes and whose key size is  `32 + sizeof(AccountId)` bytes. |
| [RPC] | `DepositFactor` | `u128` | `32000000000000000` | The amount of currency needed per unit threshold when creating a multisig execution.   This is held for adding 32 bytes more into a pre-existing storage value. |
| [RPC] | `MaxSignatories` | `u32` | `100` | The maximum amount of signatories allowed in the multisig. |

### Utility — pallet 30

[RPC] Combines or changes dispatch origins for calls; no independent spend budget. Interface and descriptions below are read from metadata, not a source audit. [Metadata](../evidence/metadata.json); canonical RPC: `state_getMetadata(H)` at [node](https://rpc.devnet.flop.network).

#### Calls

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `batch` | `calls: Vec<zkv_runtime::RuntimeCall (#61)>` | Send a batch of dispatch calls.  May be called from any origin except `None`.  - `calls`: The calls to be dispatched from the same origin. The number of call must not   exceed the constant: `batched_calls_limit` (available in constant metadata).  If origin is root then the calls are dispatched without checking origin filter. (This includes bypassing `frame_system::Config::BaseCallFilter`).  ## Complexity - O(C) where C is the number of calls to be batched.  This will return `Ok` in all circumstances. To determine the success of the batch, an event is deposited. If a call failed and the batch was interrupted, then the `BatchInterrupted` event is deposited, along with the number of successful calls made and the error of the failed call. If all were successful, then the `BatchCompleted` event is deposited. |
| [RPC] | 1 | `as_derivative` | `index: u16`; `call: zkv_runtime::RuntimeCall (#61)` | Send a call through an indexed pseudonym of the sender.  Filter from origin are passed along. The call will be dispatched with an origin which use the same filter as the origin of this call.  NOTE: If you need to ensure that any account-based filtering is not honored (i.e. because you expect `proxy` to have been used prior in the call stack and you do not want the call restrictions to apply to any sub-accounts), then use `as_multi_threshold_1` in the Multisig pallet instead.  NOTE: Prior to version *12, this was called `as_limited_sub`.  The dispatch origin for this call must be _Signed_. |
| [RPC] | 2 | `batch_all` | `calls: Vec<zkv_runtime::RuntimeCall (#61)>` | Send a batch of dispatch calls and atomically execute them. The whole transaction will rollback and fail if any of the calls failed.  May be called from any origin except `None`.  - `calls`: The calls to be dispatched from the same origin. The number of call must not   exceed the constant: `batched_calls_limit` (available in constant metadata).  If origin is root then the calls are dispatched without checking origin filter. (This includes bypassing `frame_system::Config::BaseCallFilter`).  ## Complexity - O(C) where C is the number of calls to be batched. |
| [RPC] | 3 | `dispatch_as` | `as_origin: zkv_runtime::OriginCaller (#98)`; `call: zkv_runtime::RuntimeCall (#61)` | Dispatches a function call with a provided origin.  The dispatch origin for this call must be _Root_.  ## Complexity - O(1). |
| [RPC] | 4 | `force_batch` | `calls: Vec<zkv_runtime::RuntimeCall (#61)>` | Send a batch of dispatch calls. Unlike `batch`, it allows errors and won't interrupt.  May be called from any origin except `None`.  - `calls`: The calls to be dispatched from the same origin. The number of call must not   exceed the constant: `batched_calls_limit` (available in constant metadata).  If origin is root then the calls are dispatch without checking origin filter. (This includes bypassing `frame_system::Config::BaseCallFilter`).  ## Complexity - O(C) where C is the number of calls to be batched. |
| [RPC] | 5 | `with_weight` | `call: zkv_runtime::RuntimeCall (#61)`; `weight: sp_weights::weight_v2::Weight (#10)` | Dispatch a function call with a specified weight.  This function does not check the weight of the call, and instead allows the Root origin to specify the weight of the call.  The dispatch origin for this call must be _Root_. |
| [RPC] | 6 | `if_else` | `main: zkv_runtime::RuntimeCall (#61)`; `fallback: zkv_runtime::RuntimeCall (#61)` | Dispatch a fallback call in the event the main call fails to execute. May be called from any origin except `None`.  This function first attempts to dispatch the `main` call. If the `main` call fails, the `fallback` is attemted. if the fallback is successfully dispatched, the weights of both calls are accumulated and an event containing the main call error is deposited.  In the event of a fallback failure the whole call fails with the weights returned.  - `main`: The main call to be dispatched. This is the primary action to execute. - `fallback`: The fallback call to be dispatched in case the `main` call fails.  ## Dispatch Logic - If the origin is `root`, both the main and fallback calls are executed without   applying any origin filters. - If the origin is not `root`, the origin filter is applied to both the `main` and   `fallback` calls.  ## Use Case - Some use cases might involve submitting a `batch` type call in either main, fallback   or both. |
| [RPC] | 7 | `dispatch_as_fallible` | `as_origin: zkv_runtime::OriginCaller (#98)`; `call: zkv_runtime::RuntimeCall (#61)` | Dispatches a function call with a provided origin.  Almost the same as [`Pallet::dispatch_as`] but forwards any error of the inner call.  The dispatch origin for this call must be _Root_. |

#### Storage

[RPC] None exposed.

#### Events

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `BatchInterrupted` | `index: u32`; `error: sp_runtime::DispatchError (#26)` | Batch of dispatches did not complete fully. Index of first failing dispatch given, as well as the error. |
| [RPC] | 1 | `BatchCompleted` | () | Batch of dispatches completed fully with no error. |
| [RPC] | 2 | `BatchCompletedWithErrors` | () | Batch of dispatches completed but has errors. |
| [RPC] | 3 | `ItemCompleted` | () | A single item within a Batch of dispatches has completed with no error. |
| [RPC] | 4 | `ItemFailed` | `error: sp_runtime::DispatchError (#26)` | A single item within a Batch of dispatches has completed with error. |
| [RPC] | 5 | `DispatchedAs` | `result: Result (#35)` | A call was dispatched. |
| [RPC] | 6 | `IfElseMainSuccess` | () | Main call was dispatched. |
| [RPC] | 7 | `IfElseFallbackCalled` | `main_error: sp_runtime::DispatchError (#26)` | The fallback call was dispatched. |

#### Errors

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `TooManyCalls` | () | Too many calls batched. |

#### Constants

| Evidence | Constant | SCALE type | Decoded value (raw base units unless stated) | Purpose |
|---|---|---|---|---|
| [RPC] | `batched_calls_limit` | `u32` | `10922` | The limit on the number of batched calls. |

## 2. Who pays through the hosted gateway

| Evidence | Stage | What is established | What is not established |
|---|---|---|---|
| [source] | Enrollment | `/enroll/wallet` verifies a wallet signature and checks finalized **free** balance against an issuer minimum (default 1 FLOP); it issues a model-scoped gateway allowance (default 25 FLOP, two requests/minute, expires within 24 hours). Re-enrollment rotates the bearer and preserves spend/expiry. | This describes a qualification check and issuer allowance; no funding transfer, reserved balance or on-chain delegated session is specified. |
| [source] | Bearer use | `/keys/me` returns credential kind, remaining quota and expiry; `/keys/ephemeral` narrows parent model/spend/rate/use/lifetime policy. The API describes a legacy floating-point quota ledger in receipt fields. | A bearer is not a Substrate signing key. No on-chain storage key for a bearer hash, enrolled account-to-session binding, debit authorization or proof of quota enforcement is exposed. |
| [RPC] | Channel opening | The observed example's `ComputeChannel.open_channel` is signed by channel account `5GsXb3TmNGixuEsbtixqHnqWr9UQJ2M8bkqBQWteNekgF98S`, which is the stored channel `agent`. Read-back opening/settlement blocks, events and balances are supplied in section 7. | The chain record does not identify the individual HTTP caller or their bearer credential. |
| [source] | Gateway relationship | Public issue #172 reports an enrolled user's unchanged balance/nonce and gateway-owned channels; it is corroborating discovery/context, not proof for that user's account here. | That report does not establish all current deployments' payment paths. |
| [source] | Hosted payment support | OpenAPI says direct public payment-proof settlement is not enabled and hosted requests currently use funded API keys. | No documented route supplies a session-dispatched seat-owned `open_channel`, an x402 authorization, or an on-chain daily-budget reference to `/chat/completions`. |

[source] Citations for the API rows: [OpenAPI](https://api.flop.network/openapi.json), JSON pointers `/paths/~1enroll~1wallet/post`, `/paths/~1keys~1me/get`, `/paths/~1keys~1ephemeral/post`, `/components/schemas/CredentialReceipt`, `/info/description`; saved verbatim as [openapi.json](../evidence/openapi.json). The gateway-account report is [FLOP issue #172](https://github.com/flop-labs/yellowpaper/issues/172). It remains an attributed user report; this research does not promote comments to runtime source.

[inference] Consequently there are two ledgers: (a) the enrolled wallet's native chain balance, and (b) a gateway allowance/quota ledger. A funded-wallet check is not a transfer authorization. The existing API does not establish that the user's original 25 FLOP goes anywhere between enrollment and inference. Do not describe that 25 FLOP as deposited in a gateway agent wallet or escrow. For the observed gateway-owned channel, opening transfers native FLOP from the channel account to the ComputeChannel sovereign escrow account; it is not left as reserved balance of the enrolled wallet. The bearer consumes a separate off-chain allowance. [API contract](../evidence/openapi.json); [node channel/payment evidence](../evidence/payment-state.json).

[unknown] A universal statement about exactly when/how **every enrolled wallet** is debited cannot be proved without a request-level account binding or gateway implementation. This run did not enroll or make a paid request. In particular, any private billing arrangement that later charges users, pooled prefunding, custodial ledger liabilities or alternative gateway mode is unknown. No enrollment 503 was tested; the OpenAPI documents that response, but this report does not claim a fresh observed enrollment failure.

[inference] A child credential's `max_spend` is a **gateway-enforced constraint in the public interface**, not a runtime balance cap. The session pallet takes account IDs, a RuntimeCall, an integer spend declaration and nonce; it never receives the HTTP child's bearer token or quota. Creating a wallet/session independently does not connect these ledgers. There may be private integration, but none is specified or proven here. [RPC metadata](../evidence/metadata.json); [OpenAPI](../evidence/openapi.json).

## 3. Bounds offered by the chain

### 3.1 Agent wallet

[RPC] `create_wallet(agent, per_tx_limit, daily_cap, allowed_destinations)` stores the owner and guardrails. `agent_transfer(destination, amount)` documents active status, per-transfer maximum, epoch-spent maximum and a nonempty destination allowlist. `WalletFunds` separately records funding, spends and owner withdrawals; the real funding example shows the tokens themselves in the agent account's ordinary free balance, not a separately addressed smart-contract account. A real transfer increments wallet epoch spend and decrements WalletFunds by exactly the transferred principal. [Metadata](../evidence/metadata.json), [wallet before/after state](../evidence/example-state.json), section 7.1.

[inference] This is an entry-point budget, not evidence of an account-wide spending firewall. A device that has the **agent account's unrestricted signing key** can potentially call `Balances` or another spending pallet directly. Nothing in wallet metadata establishes a global signed-transaction filter protecting that same account; the observed funded account's free balance is not frozen by the wallet. Do not keep the treasury on an unrestricted device account and assume `create_wallet` protects all of it. [Signed extensions and balances metadata](../evidence/metadata.json), [wallet account state](../evidence/example-state.json).

[RPC] Wallet management: owner signs `deactivate_wallet(agent)` to pause the guarded wallet and `reactivate_wallet(agent)` to resume. There is no wallet-policy setter or wallet deletion/revocation call in this runtime. `owner_withdraw` is documented to allow only segregated wallet funds **in excess of** the remaining daily budget; it rejects rather than clamps over-withdrawals. Therefore it is not a general “withdraw everything now” revocation mechanism. `fund_wallet` permits anyone to fund any wallet; funding does not change its stored limit. [AgentWallet call/storage documentation](../evidence/metadata.json).

[unknown] Whether deactivation blocks every sponsored-payment or direct ComputeChannel path, whether owner withdrawal checks a pending epoch reset, how zero limits are validated, and which compute-sink registry qualifies locked principal are not derivable from the interface. Error `DestinationNotApprovedComputeSink` exists; the implementing `IsApprovedComputeSink` predicate is not exposed as code in metadata. No immutable policy can safely be described as owner-adjustable without a dispatchable or public implementation demonstrating it.

[RPC] No wallet creation deposit constant or reserve event appears in the worked creation; it charges a transaction fee. This observed call does **not** establish a guaranteed zero deposit in every branch. The observed `agent_transfer` charges `3744215780000000` raw in fees **in addition to** its principal, but only principal appears in `epoch_spent`. [Creation/transfer block events](../evidence/block-e2caed76e69ce904042ca35eb6360982ad89e384f2cdf03057a5e4a35c93d7de.json), [transfer block](../evidence/block-36285797c39814175824703feda744d94f3bbbf5ff9ba2624f5c8005259be7c5.json).

### 3.2 Delegated session

[RPC] `create_session(delegate, spending_cap, per_tx_limit, daily_cap, duration_blocks, allowed_pallets)` is owner-signed. Its documentation defines lifetime, per-call and epoch ceilings and expiry. `execute_via_session(owner, call, spend_amount, nonce)` is delegate-signed and dispatches as owner. Its documentation says actual chargeable movement must not exceed the declaration: the greater of the owner's free-balance drop and total free-plus-reserved drop, otherwise the **whole extrinsic reverts** with `SpendExceedsDeclared`. This is materially stronger than trusting `spend_amount` supplied by the agent. [FlopSessionKeys call docs](../evidence/metadata.json), types #231/#697.

[inference] Under that documented check, reserving free funds into escrow is charged when the free balance falls; it cannot escape merely because free+reserved stayed constant. A later transfer out of reserved funds may be charged again if executed through the session and it reduces total balance. Full call auditing is necessary before assuming principal is counted only once. Refunds or net-neutral loops do not establish a fresh budget credit: the counter is the declared `spend_amount`, and no decrement/refund interface is exposed. Net-balance measurement also does not by itself specify the treatment of deferred calls, holds/freezes, cross-pallet callbacks or preexisting escrow. [Execute documentation and storage fields](../evidence/metadata.json).

[RPC] The session stores `spent`, `epoch_spent`, `epoch_start`, `expires_at`, `allowed_pallets`, `active`; nonce is a separate `SessionNonces(owner,delegate)` map. It allows at most ten sessions per owner and ten per delegate, sixteen allowed pallets, duration up to 864000 blocks. Epoch length is 86400 blocks. The per-delegate breaker has 60-block period, 100-transaction ceiling, 250000000000000000000 raw spend ceiling; session rotation is limited to three per 3600 blocks. Empty allowlist means all **otherwise permitted** pallets; self and `DENIED_PALLETS` remain excluded. The exact denylist is not included in metadata. [Constants/call docs](../evidence/metadata.json).

[source] The yellowpaper specifies lazy windows: wallet/session budgets start at creation or the previous reset; the first spend after 86400 blocks resets that budget and starts the next window. Breaker limits are shared across a delegate's sessions, reset after its period, and either limb should latch rejection. This is the published specification, not a verified execution trace at a reset boundary. [Yellowpaper §6.2 and clock table](https://github.com/flop-labs/yellowpaper/blob/main/yellowpaper.md#62-agent-autonomy--operating-without-per-action-consensus); captured [lines 190, 1358–1383](../evidence/yellowpaper.md).

[RPC] Owner signs `update_session_limits(delegate, per_tx_limit, daily_cap)` to raise/lower those two values, with documented ceiling of original lifetime cap remaining. A real attempted update above that remainder fails with `SpendingCapExceeded` (94/error 4), leaves the session policy unchanged and still pays a fee (section 7.2). Owner signs `revoke_session(delegate)`; the observed revocation leaves the record with `active=false` and retains prior counters. Root has `force_revoke(owner,delegate)` and `force_reset_circuit_breaker(delegate)`. [Call metadata](../evidence/metadata.json), [failed update](../evidence/block-ad437d438c00687b782a127d2b52a819b444b84a571e5054da0990e8c301a92a.json), [session state](../evidence/example-state.json).

[inference] There is no owner pause/resume session call. Revoke for a reliable documented stop; do not depend on setting zero until zero-value validation is confirmed. Extending expiry, raising lifetime exposure or changing allowed pallets requires a newly authorized session; replacement/recreation semantics and nonce continuity need implementation confirmation. Revocation cannot undo previously committed escrow or erase an off-chain channel receipt signing key. The session allowlist restricts pallets, not particular call variants or miner accounts; a `ComputeChannel` allowance does not by itself pin one callee, miner or model. Session limits are per `(owner,delegate)`, not a single budget shared by every device of an owner; a seat with multiple sessions may have multiple allowances. [Session schema and calls](../evidence/metadata.json).

[RPC] The real direct `AgentWallet.agent_transfer` in section 7.3 also increments a matching session's spend and breaker counters without incrementing the session dispatch nonce. This confirms an additional cross-pallet path for that particular wallet/session pair. It is **not** proof that every direct ComputeChannel call or every alternate session of that delegate is charged similarly. [Node before/after](../evidence/session-spend-state.json).

[unknown] Public metadata does not reveal the full recursive call filter, exact denied pallets, whether `ComputeChannel` is accepted by `execute_via_session`, selector behavior when a delegate has several sessions, atomic rollback details for failed inner calls, exact expiry comparison (`>=` versus `>`), fee treatment on wrapper dispatch or breaker-counter persistence on rejected calls. No session-dispatch execution/rejection trace was located in the bounded discovery sample. These are release-gating questions for a secure integration, not details to guess from Substrate defaults.

### 3.3 Other mechanisms and what each cannot promise

| Evidence | Mechanism | Enforced/publicly exposed bound | Owner operation / cost / failure | Gateway/miner exposure and limit |
|---|---|---|---|---|
| [RPC] | Native account with limited funding | Native balance/locks and existential deposit: `10000000000000000` raw = 0.01 FLOP. Transfer APIs include `transfer_keep_alive`, `transfer_allow_death`, `transfer_all`. | Owner funds device account via `Balances.transfer_keep_alive(dest,value)`. Fees require additional funds or reduce useful compute. Direct device key has full control of its own spendable balance. | A normal signed transfer cannot spend unavailable balance; it is an available-principal bound, not an automatic daily meter or gateway allowance cap. |
| [inference] | Owner-controlled replenishment | Limiting total funding bounds owner loss to the sum deliberately transferred, subject to prior commitments and any additional incoming funds. | For a true daily **loss envelope**, count all pending authorizations/escrow plus free funds and fees; carry or sweep leftovers deliberately. Blindly adding B each day accumulates unused balances. | An off-chain scheduler decides when funding occurs. Chain scarcity persists if the device ignores bookkeeping, but there is no self-resetting UTC cap in this construction. |
| [RPC] | Proxy | Runtime-defined call class; optional `delay` and call-hash announcements. No balance or period fields in proxy records. | `add_proxy(delegate,type,delay)`; remove exact relationship with `remove_proxy`, all with `remove_proxies`; reject pending announcement. One proxy reserves base+factor = 2041000000000000000 raw (2.041 FLOP). An announcement reserves base+factor = 2074000000000000000 raw (2.074 FLOP), plus ordinary fees. | `Any` is not a budget. No per-miner/callee or numeric inference-only class is exposed. Exact FLOP filters for NonTransfer etc are unknown; never infer safety from their names. |
| [RPC] | Multisig | Specific-call threshold approval, maximum 100 signatories, deposit base 2088000000000000000 raw + 32000000000000000 raw per threshold unit under documented formula. | `as_multi`, `approve_as_multi`, `cancel_as_multi` manage operation; threshold-one variant requires no multi-party wait. Fees/deposits depend on branch. `MultisigExecuted.result` can fail even when outer extrinsic succeeds. | Prevents unilateral approval if threshold is greater than compromised devices, but imposes consensus per authorization; no daily scalar cap. |
| [RPC] | Utility | `batch`, `batch_all`, `force_batch`, origin-changing and weighted dispatch interfaces; no monetary cap storage; `batched_calls_limit` caps batch length. | `batch_all` documents all-or-nothing call state; `batch` can interrupt after earlier successes; inspect inner/outer results. | Wrapping calls is not a spend limit. Filters must cover nested calls; do not grant Utility merely for convenience before auditing the session/proxy filter. |
| [RPC] | Buyer-signed sponsored exact payment | Authorization includes payer, payee, amount, resource, payment ID, facilitator, genesis/network and block validity. Facilitator must sign/submit and pays extrinsic fee; payer signature authorizes the exact payment. Consumed/revoked IDs persist. | Payer signs authorization off chain; facilitator calls `settle_sponsored_payment(authorization,signature)`. Payer calls `revoke_sponsored_payment(payment_id)`; pruning retains consumed tombstone. Wrong domain/network/asset/facilitator, expiry, replay and bad signature have named errors. | Exact-payment authority is not automatically an aggregate daily cap. No proven gateway route uses it. Whether all wallet/session caps are applied to this call needs source or a trace; do not reuse the enrollment signature as such authority. |
| [RPC] | `HasStation` escrow | Explicit escrow amount/condition/deadline; `ControlledEscrowRemaining` and controllers exist. Full conditions are type-defined in Appendix B. | `open_escrow`, approvals, satisfy/refund and HTLC lifecycle; counterparties and lock expiry are part of the record. | Bounds that escrow, not every call from the owner or a hosted gateway token. Refund paths do not automatically settle an HTTP request. |
| [RPC] | Vesting / WorkVesting / AirdropVesting | Protocol grants/locks and compute-principal accounting; no general seat owner daily-budget setter. | Claim/grant/authority operations as inventoried. Approved compute restrictions appear in AgentWallet errors. | Locked-compute principal is not interchangeable with freely transferable funds. Not a replacement for a device capability budget. |
| [RPC] | PaidStorage | Reservation and funded service-lane policies with advance/revoke operations. | Calls and policy structures in Appendix A/B; storage pricing and lane authorization differ from inference. | A storage-service capability does not authorize or limit the hosted inference gateway. |
| [RPC] | Emergency controls / subsidy / DelegationCap | Privileged pauses/overrides, subsidy phase, or validator delegation multiplier. | Root/governance operations; override timelock 259200 blocks and cooldown 604800; EmergencyPause has its own durations. | These are not knobs a seat owner can use to manage one agent's inference cap. |

[RPC] Table sources: [complete captured metadata](../evidence/metadata.json), particularly Proxy constants and call documentation, Multisig deposit documentation, and types #233, #697, #705. Exact reserve movements for a **new** proxy/multisig were not submitted; deposits above use metadata constants/formulas and exclude transaction fees.

[source] zkVerify's public `proxy.rs` at commit `2959b6f56ce2703199c25b405942068f332168c9` defines the same five proxy discriminants and fixed `InstanceFilter<RuntimeCall>` implementations. Its NonTransfer filter excludes Balances but admits selected wrappers and its own chain's pallets. This is inheritance context, **not** the FLOP spec-1014014 filter: its RuntimeCall still includes staking/GRANDPA classes absent from the captured FLOP runtime. [Public source lines 21–171](https://github.com/zkVerify/zkVerify/blob/2959b6f56ce2703199c25b405942068f332168c9/runtime/zkverify/src/proxy.rs#L21), [saved source](../sources/zkverify/runtime/zkverify/src/proxy.rs).

[inference] A miner can realize a valid precommitted escrow without asking the current delegate to authorize fresh principal; a gateway cannot debit an owner account merely by holding a bearer credential unless it also has a native debit capability/signature or custody of funds. Therefore cap scope must be stated as **new owner balance commitment through the guarded entry point**, including fees separately, rather than all eventual settlement amounts on a calendar day. A malicious gateway holding a broad treasury signing key would bypass this design entirely. [Session balance-check docs](../evidence/metadata.json), [gateway API](../evidence/openapi.json), [channel evidence](../evidence/payment-state.json).

## 4. Smallest design for one seat identity and a daily cap

[inference] **Hosted gateway today:** no supported sequence was found that makes its bearer quota obey a payer-side on-chain daily cap. The current published API issues an issuer-funded allowance and exposes no seat-owned capped-session debit mode. The runtime has a daily-cap primitive, but its existence cannot establish its use by `/chat/completions`. Keep local/child-key limits described as gateway policy until FLOP supplies the missing binding. [OpenAPI](../evidence/openapi.json), sections 2 and 7.

[inference] **Minimum native-capability design, for direct inference or a future gateway relayer:** use `S` for one stable seat **payer AccountId**, whose unrestricted signing key remains owner-held; use `D` for the device/delegate AccountId. These symbols are design roles, not substitute addresses. The supplied `5HEA8…` can be S only if its owner can keep its full key off the device; this run does not assume possession or create D. Define exact integer raw values `B` (epoch cap), `P≤B` (per-call cap), `L` (lifetime cap), `T≤864000` (duration). No AgentIdentity registration, proxy or agent wallet is intrinsically needed to encode a session owner/delegate capability. Bound D’s fee purse separately: fees paid by D are outside an owner-balance meter, and a cap on inference principal is not a cap on total fees. Whether direct inference accepts its dispatch still needs confirmation below.

| Evidence | When | Signer | Exact extrinsic / action | Required result |
|---|---|---|---|---|
| [inference] | Once, if needed | Seat owner funding account | `Balances.transfer_keep_alive(Id(S), value)` and separately fund D for outer transaction fees, using chosen real accounts. | S's compute principal and D's fee purse are separately bounded; include existential deposits. Existing funded S needs no redundant transfer. |
| [inference] | Once per authorization lifetime | S's owner-held key | `FlopSessionKeys.create_session(D, L, P, B, T, [UTF8("ComputeChannel")])` | Finalized `SessionCreated`; read back `Sessions(S,D)` and `SessionNonces(S,D)`. Explicit allowlist, not empty. This encodes the intended policy; **do not ship before FLOP confirms ComputeChannel is not denied and all relevant dispatch paths are covered**. |
| [inference] | Every new commitment | D | Read nonce `n`; sign `FlopSessionKeys.execute_via_session(S, ComputeChannel.open_channel(actual arguments from metadata), E, n)` or wrap a top-up similarly. `E` covers the documented owner balance decrease, not a floating quote. | Check outer `ExtrinsicSuccess`, inner channel events, session counters/nonce and actual account movements. Only use the seat owner as channel payer. No owner signature/key on device. |
| [inference] | Every inference session | Session receipt key according to channel protocol | Supply the channel `agent_key` and required miner/receipt signatures per the compute protocol. This key is a distinct protocol role from the native D delegation even if an implementation deliberately binds them. | A receipt key may authorize existing escrow; it must not confer unbounded replenishment from S. Miner/model/attestation prerequisites remain necessary. |
| [inference] | Each 86400-block budget window | No new owner extrinsic if policy/lifetime continue | Runtime's documented lazy epoch reset occurs on the next guarded spend. Read `epoch_start` and height; do not create a fresh session every day merely to reset counters. | `epoch_spent` is limited by B in the runtime's block window. Lifetime `spent` remains bounded by L. |
| [inference] | At cap | D may try; runtime decides | Attempted spend above remaining per-call/epoch/lifetime authority should fail with the corresponding documented session error. | Stop local work; inspect failure and charged outer fee. No automatic owner top-up/replacement to defeat the cap. |
| [inference] | Raise/lower P/B | S | `update_session_limits(D,newP,newB)` | Must fit documented lifetime remainder; re-read storage because there is no dedicated update event in this event enum. |
| [inference] | Stop / key compromise | S | `revoke_session(D)`; separately revoke HTTP credentials if used and stop granting new channel keys. | Finalized `SessionRevoked`, `active=false`. Existing committed escrow/receipt rights may persist. |
| [inference] | Expiry/rotation | S | Explicit new authorization only after reviewing retained spend, other sessions and pending escrow; use `create_session` only where the runtime permits new/replacement pairs. | Lifetime/epoch budgets must not be reset by automatic rotation. Exact recreate behavior remains unknown. |

[RPC] `ComputeChannel.open_channel` has many protocol fields, all encoded in the exact signature below; it is **not** a `(miner,amount)` transfer shortcut. The companion generator inserts its arguments and the `top_up_escrow`, `settle`, `force_open`, `timeout` signatures from this metadata immediately after this section. [Call registry](../evidence/metadata.json).

[unknown] This direct/session-wrapped design was **not** exercised by sending transactions, and ComputeChannel's allowed/denied status, recursive filter and balance-meter semantics for every lifecycle call are not public-source-confirmed. It is the smallest intended interface, not a tested claim that a currently enrolled gateway key can use it. FLOP must either support seat-payer session relay, or accept a separate verifiable bounded payment authorization and map it to requests. A new gateway feature alone must not bypass the runtime session wrapper.

[inference] **Nearest implementable exposure bound without that integration:** keep one fixed device/payment account per seat and transfer only a deliberately budgeted amount into it; never give the device the funding wallet key or unrestricted proxy. Replenishment uses owner-signed `Balances.transfer_keep_alive(Id(device),amount)`. This protects the funding treasury by native balance scarcity even if local accounting fails. It does not make hosted subsidy/quota usage chain-billed, does not restrict which calls the device chooses, and provides no automatic UTC-day reset. If the owner replenishes daily, choose a target exposure after subtracting free leftovers, pending authorizations/escrow and fees; unused old escrow can settle on a later day. [Balances interface](../evidence/metadata.json), [observed escrow lifecycle](../evidence/payment-state.json).

[inference] One FLOP payer AccountId per seat is compatible with a separate replaceable device delegation key. “One identity” should refer to that stable payer, not an assertion that AgentIdentity's H256 registration, an HTTP bearer, a channel receipt key and a device AccountId are the same object. Register AgentIdentity only if the product separately needs that registry. [AgentIdentity schema](../evidence/metadata.json).

[RPC] Immediately before the successful worked wallet creation, `AgentsByOwner(wallet_owner)` is absent with default `[]`; immediately before the successful linked session creation, `AgentsByOwner(session_owner)` is also absent/default `[]`. Thus these two owners did not require an AgentIdentity registry entry to make those calls. Exact keys, historical hashes and raw null responses are in [registration prerequisite state](../evidence/registration-prerequisite-state.json).


### Exact ComputeChannel calls referenced by the design

| Evidence | Pallet/call index | Call | Arguments in SCALE order | Metadata purpose |
|---|---|---|---|---|
| [RPC] | 103/0 | open_channel | miner: sp_core::crypto::AccountId32 (#0); model_hash: primitive_types::H256 (#13); measured_root: primitive_types::H256 (#13); decode_policy_hash: primitive_types::H256 (#13); precision: pallet_model_registry::types::ModelPrecision (#246); enclave_key: [u8;32]; agent_key: [u8;32]; sla: pallet_compute_channel::pallet::Sla (#294); escrow: u128; nonce: u64; settlement_class: pallet_compute_channel::pallet::SettlementClass (#295) | **Open a session** (inclusion 1 of 2). The agent escrows the reserved-capacity payment, commits the measured model root (verified against the registry now), and binds a caller-supplied session signing key. The pallet does not verify TEE provenance for that key. |
| [RPC] | 103/1 | top_up_escrow | channel_id: primitive_types::H256 (#13); additional: u128 | **Top up escrow in place** (Lightning splice-in). Raises a live session's reserved capacity without close+reopen — avoids re-establishing the off-chain session and losing KV-cache warmth (R2 §3.2). |
| [RPC] | 103/2 | settle | channel_id: primitive_types::H256 (#13); final_root: primitive_types::H256 (#13); aggregate_gn: u128; claimed_measured_root: primitive_types::H256 (#13); agent_receipt_sig: [u8;64]; transcript_ref: Option (#296); verified_turns: Vec<pallet_compute_channel::pallet::VerifiedTurn (#298)> | **Cooperative settle** (inclusion 2 of 2). The miner posts the final root + aggregate `G_n` together with the agent's last signed receipt; both parties agreed to private payment ⇒ pay out immediately. This does not establish execution or public reward eligibility. The escrow (reserved capacity) is paid to the miner in full — **under-use is not refunded** (decision #1). |
| [RPC] | 103/3 | force_settle | channel_id: primitive_types::H256 (#13); final_root: primitive_types::H256 (#13); aggregate_gn: u128; claimed_measured_root: primitive_types::H256 (#13); agent_receipt_sig: [u8;64]; transcript_ref: Option (#296); verified_turns: Vec<pallet_compute_channel::pallet::VerifiedTurn (#298)> | **Force-settle** (escape hatch / permissionless). Either party posts the latest signed receipt **without** counterparty cooperation. This does *not* pay immediately — it opens the challenge window; after it closes with no upheld fraud, anyone calls `finalize` (metadata reference: Pallet::finalize). A later force-settle with a higher (validly-signed) `aggregate_gn` supersedes the earlier one (highest receipt wins; monotonic replay protection). |
| [RPC] | 103/4 | finalize | channel_id: primitive_types::H256 (#13) | **Finalize** a force-settled channel after its challenge window closes with no upheld fraud. Permissionless. Pays the verified work amount, refunds non-penalty unused escrow, without issuing public work credit. |
| [RPC] | 103/5 | timeout | channel_id: primitive_types::H256 (#13) | **Timeout / abort** (permissionless). If the session exceeded its `max_duration` while still `Open` — the miner reserved capacity but posted no settlement — this is **non-delivery** (a dispute condition): the agent's escrow is refunded and the channel closes. (Distinct from under-use, which is never refunded.) |
| [RPC] | 103/9 | force_open | miner: sp_core::crypto::AccountId32 (#0); model_hash: primitive_types::H256 (#13); measured_root: primitive_types::H256 (#13); decode_policy_hash: primitive_types::H256 (#13); precision: pallet_model_registry::types::ModelPrecision (#246); agent_key: [u8;32]; sla: pallet_compute_channel::pallet::Sla (#294); escrow: u128; nonce: u64 | **Permissionless open** (escape hatch). The agent escrows the reserved-capacity payment and posts session params against a *named* miner it has not handshaked with off-chain. The channel enters [`ChannelState::PendingAck`]; the named miner has [`Config::AckWindow`] blocks to `force_ack` (metadata reference: Pallet::force_ack) with its session signing key, or anyone may `expire_force_open` (metadata reference: Pallet::expire_force_open) for a full refund. No enclave key is bound here — there has been no handshake yet. |

## 5. What a read-only observer checks

[RPC] Storage keys are `Twox128(storage_prefix) || Twox128(item_name) || hash(key_1_SCALE) || …`. For `Blake2_128Concat`, append `Blake2b-128(key_bytes) || key_bytes` **per key**, not one hash of the tuple for a double map. For Proxy.Proxies, use `Twox64Concat(AccountId32)`. SS58 display text is decoded to the 32 account bytes before hashing; it is not SCALE-encoded as a string. The requested address decodes to `0xe462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2`. [Metadata storage hashers](../evidence/metadata.json), [key-construction implementation and vectors](../scripts/keys.py).

[inference] Minimum steady-state read for a **known pair** `(S,D)` and known runtime is one `state_queryStorageAt([Sessions(S,D),SessionNonces(S,D),CircuitBreakers(D)],H)` after obtaining finalized H. The token itself gives lifetime/day usage, epoch start, expiry, activity and allowed pallets; the breaker gives the additional velocity restriction. A wallet-backed transfer needs `Wallets(agent)`, `WalletFunds(agent)` and `System.Account(agent)` too. For total risk, inspect S/D account balances and every other session/proxy/escrow authority; a single pair proves only that pair's bound. [Schema](../evidence/metadata.json), [actual batched query](../evidence/identity-queryStorageAt.json).

[inference] Cold client: (1) obtain `chain_getFinalizedHead`; (2) batch `chain_getHeader(H)`, `state_getRuntimeVersion(H)`, `state_getMetadata(H)` and genesis check if uncached; (3) query the needed keys at H. A cached registry pinned to the metadata/code hash avoids downloading metadata each read. `DelegateSessions(D)` discovers owner/delegate pairs for a known device in one read, followed by the token reads; owner-side enumeration uses `state_getKeysPaged` over `Sessions` prefix plus owner hash/key. The supplied address alone does not reveal a nonexistent or private device key, so a concrete `(S,D)` double-map key cannot be honestly invented. [Metadata layout](../evidence/metadata.json); [SDK owner/delegate enumeration implementation lines 168–250](../sources/sdk-0.5.2/dist/agent-wallet.js).

[RPC] The exact keys and observed values **for the supplied identity**, including missing-key defaults, are inserted below. Its original account has 25 FLOP free, zero reserved, nonce zero; no wallet, session reverse index, proxy or AgentIdentity reverse-index registration exists at H. This confirms the lead about funding but does not prove “not enrolled” in an off-chain gateway database. [Node state](../evidence/identity-state.json).

[inference] Validate activity and expiry against H, not local clock; compare the epoch boundary to `epoch_start + constant`. A stale nonzero stored counter may await lazy reset, so report both stored usage and projected reset eligibility. Watch `WalletCreated/Funded`, `AgentTransfer`, `EpochReset`, deactivation/reactivation/withdraw; `SessionCreated/Revoked/Expired`, `SessionCallExecuted`, `DailyCapReset`, breaker events; `ProxyAdded/Removed`, multisig inner result; and `System.ExtrinsicFailed/Success` plus `TransactionFeePaid`. A failed call's fee is real even if policy state did not change. A limit update may be visible only in storage. [Event inventory](../evidence/metadata.json), [failed update evidence](../evidence/block-ad437d438c00687b782a127d2b52a819b444b84a571e5054da0990e8c301a92a.json).

[RPC] The captured [read proof](../evidence/identity-read-proof.json) supplies trie nodes from `state_getReadProof(keys,H)`; header state root is in [anchor.json](../evidence/anchor.json). This run decoded node responses but did **not** cryptographically verify the trie proof or consensus finality certificate. “Read from the node” here is RPC evidence, not an independently verified light-client proof. An observer requiring trustless state should verify the proof against a separately trusted finalized header.


### Exact supplied-identity keys at the snapshot

| Evidence | Storage item | Full storage key | Value |
|---|---|---|---|
| [RPC] | System.Account | `0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9f9edc9e72d99b3c30da8e2d40b25bd41e462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2` | `{"nonce":0,"consumers":0,"providers":1,"sufficients":0,"data":{"free":25000000000000000000,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | AgentWallet.Wallets | `0x14e9e00acd6d607b26a12304b528a15da64f9201059f2ce9f59920724cac5be4f9edc9e72d99b3c30da8e2d40b25bd41e462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2` | `absent (Option::None)` |
| [RPC] | AgentWallet.WalletFunds | `0x14e9e00acd6d607b26a12304b528a15d390547c4f733dd3953f499b5ed2d6d42f9edc9e72d99b3c30da8e2d40b25bd41e462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2` | `absent; metadata default 0` |
| [RPC] | AgentWallet.WalletCount | `0x14e9e00acd6d607b26a12304b528a15d94c0d2743a8c0f9d39e77a1848209241f9edc9e72d99b3c30da8e2d40b25bd41e462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2` | `absent; metadata default 0` |
| [RPC] | FlopSessionKeys.DelegateSessions | `0x26d6680094539fc341d5ea8ffc79d76f27cdbf61319cbf5774a1df6f3711570ff9edc9e72d99b3c30da8e2d40b25bd41e462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2` | `absent; metadata default []` |
| [RPC] | FlopSessionKeys.SessionCount | `0x26d6680094539fc341d5ea8ffc79d76f3f12a0368a9fb531f2aaa704a19baa26f9edc9e72d99b3c30da8e2d40b25bd41e462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2` | `absent; metadata default 0` |
| [RPC] | FlopSessionKeys.DelegateSessionCount | `0x26d6680094539fc341d5ea8ffc79d76f340dea6f70a10dd2fdca6fa2160a8321f9edc9e72d99b3c30da8e2d40b25bd41e462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2` | `absent; metadata default 0` |
| [RPC] | FlopSessionKeys.CircuitBreakers | `0x26d6680094539fc341d5ea8ffc79d76f8ab2f41796e7514fa8610f8d361c94e7f9edc9e72d99b3c30da8e2d40b25bd41e462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2` | `absent (Option::None)` |
| [RPC] | FlopSessionKeys.RotationHistory | `0x26d6680094539fc341d5ea8ffc79d76f414c1a2a80168699e867c42895354e2df9edc9e72d99b3c30da8e2d40b25bd41e462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2` | `absent; metadata default {"timestamps":[]}` |
| [RPC] | Proxy.Proxies | `0x1809d78346727a0ef58c0fa03bafa3231d885dcfb277f185f2d8e62a5f290c85debbadfcaaa77f7ee462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2` | `absent; metadata default [[],0]` |
| [RPC] | AgentIdentity.AgentsByOwner | `0xb4eb3a8b7674e14f328665c68aeb3b1ee9ac6e4cb9540ca7e8735cf4dfe22612f9edc9e72d99b3c30da8e2d40b25bd41e462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2` | `absent; metadata default []` |
| [RPC] | Timestamp.Now | `0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb` | `1794415641001` |
| [RPC] | AgentWallet.TotalWallets | `0x14e9e00acd6d607b26a12304b528a15de7caea115d749432257f5f019d9ecceb` | `8789` |
| [RPC] | FlopSessionKeys.TotalSessions | `0x26d6680094539fc341d5ea8ffc79d76fe10cb403d011d3074d3f4d4b326e32d6` | `8380` |

[RPC] For `Sessions(S,D)` and `SessionNonces(S,D)`, if S is the supplied identity, the **owner prefix before the unknown delegate component** is respectively:

- [RPC] `Sessions`: `0x26d6680094539fc341d5ea8ffc79d76f028685274e698e781f7f2766cba0cc83f9edc9e72d99b3c30da8e2d40b25bd41e462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2`; append `Blake2b128(D32) || D32`.
- [RPC] `SessionNonces`: `0x26d6680094539fc341d5ea8ffc79d76fa8bf8c9b4fb4963e0d891d0ea6eb7b2cf9edc9e72d99b3c30da8e2d40b25bd41e462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2`; append `Blake2b128(D32) || D32`.

[inference] These are prefixes, not complete session keys. `DelegateSessions(supplied identity)` is empty at H, and no arbitrary D is substituted. The delivered [key builder](../scripts/keys.py) computes full keys once an owner-approved device AccountId is known.

## 6. Trust left in the gateway

[inference] With a properly integrated runtime payer/session path, the gateway may consume **all authorized budget** opening poor-value channels, pick an allowed but unhelpful miner/model, over-reserve rather than buy the minimum work, delay responses, omit or misallocate request receipts, censor or refuse service, and leave escrow committed until the protocol's permitted settlement/timeout. The payer-side limit prevents extra principal commitments only through its covered authority; it does not establish output quality, per-request allocation, fair pricing or miner honesty. [Session/pallet metadata](../evidence/metadata.json), [pooled receipt schema](../evidence/openapi.json).

[inference] A gateway holding a valid channel receipt key may authorize settlement of that channel's committed amount even after device-session revocation, subject to channel rules. It should not be able to mint additional authority over S without a covered call/signature. A miner must satisfy the channel protocol but a valid payout can exhaust the escrow; neither a session daily counter nor a child HTTP key should be described as undoing an already valid escrow obligation. The runtime/source behavior for revocation versus channel signatures remains an explicit implementation question.

[inference] Under the **current hosted allowance** arrangement, runtime payer controls still do not stop a dishonest gateway from ignoring `max_spend`, changing off-chain quota/receipts, or charging an external/custodial ledger under whatever authority it holds. A compromised bearer alone does not prove authority to transfer the enrolled wallet's native balance. User loss and allowance usage are different bounds. Never give the gateway S's unrestricted signing key to bridge this gap. [API authentication and receipts](../evidence/openapi.json).

## 7. Worked node examples

[RPC] All examples below decode raw `chain_getBlock` extrinsics and `System.Events`, then read storage before/after the **whole block**. Account changes may include other calls in the same block; event phases identify the individual extrinsic. Every raw block, event SCALE value and storage value is saved alongside its decode. For every example block the runtime is spec 1014014 and metadata bytes match the snapshot hash; final canonical block-number checks are saved in [final-verification.json](../evidence/final-verification.json). Historical signature bytes are public chain evidence; no signature was produced here.

[source] The explorer was used only to discover hashes/addresses: [wallet discovery endpoint](https://explorer.devnet.flop.network/api/transactions?limit=100&offset=0&section=agentWallet), [session endpoint](https://explorer.devnet.flop.network/api/transactions?limit=100&offset=0&section=flopSessionKeys). The first saved pages each contain 100 indexed entries. A later `method=executeViaSession` query returned other methods too, so that filter was demonstrably not reliable and no absence claim is based on it. Indexer parameter/event text is not the evidence for the decoded values below. [Discovery data](../evidence/example-discovery.json), [ignored-filter response](../evidence/explorer-execute.json).

### 7.1 Wallet creation → funding → spend → freeze → resume

[RPC] The worked wallet uses owner `5GYXtQDfSoxGVKvjj3hmSNAWFqoTb4DrChd6qAzPL68NuXsQ` (`0xc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a`) and agent `5ERpXc2gLv39tC6Qe7QWgbu5ncYgX9VH6MbQa8tG9Br545L4` (`0x689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750`). These are historical third-party accounts, not keys controlled or created by this research. Full signatures, fee recipients and ordered event fields are in the block JSON linked in the generated tables below.


#### Create: block 3488342, extrinsic 2

[RPC] Block `0xe2caed76e69ce904042ca35eb6360982ad89e384f2cdf03057a5e4a35c93d7de`; extrinsic `0x6d201e7219068af0bfa0f91af215d0ac99676bb34be81319f8b777f86d3b7d0f`; signer `5GYXtQDfSoxGVKvjj3hmSNAWFqoTb4DrChd6qAzPL68NuXsQ`. [Raw bytes and decode](../evidence/block-e2caed76e69ce904042ca35eb6360982ad89e384f2cdf03057a5e4a35c93d7de.json).

[RPC] Arguments decoded from the node:

```json
{
  "AgentWallet": [
    {
      "create_wallet": {
        "agent": "0x689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750",
        "per_tx_limit": 138389000000000000,
        "daily_cap": 867389000000000000,
        "allowed_destinations": []
      }
    }
  ]
}
```

| Evidence | Order within phase | Event | Every field, in metadata order | Topics |
|---|---|---|---|---|
| [RPC] | 0 | Balances.Withdraw | `{"who":"0xc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a","amount":3490035865000000}` | `[]` |
| [RPC] | 1 | AgentWallet.WalletCreated | `{"owner":"0xc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a","agent":"0x689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750","per_tx_limit":138389000000000000,"daily_cap":867389000000000000}` | `[]` |
| [RPC] | 2 | Balances.Deposit | `{"who":"0xb0f8840c076f67c33c3abc5587be9ef2668459e348e5012bf1799a792f320678","amount":3490035865000000}` | `[]` |
| [RPC] | 3 | TransactionPayment.TransactionFeePaid | `{"who":"0xc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a","actual_fee":3490035865000000,"tip":0}` | `[]` |
| [RPC] | 4 | System.ExtrinsicSuccess | `{"dispatch_info":{"weight":{"ref_time":698007000,"proof_size":15985},"class":{"Normal":[]},"pays_fee":{"Yes":[]}}}` | `[]` |

| Evidence | State boundary | Item | Key | Complete decoded value |
|---|---|---|---|---|
| [RPC] | parent / before whole block | AgentWallet.Wallets | `0x14e9e00acd6d607b26a12304b528a15da64f9201059f2ce9f59920724cac5be4d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `{"absent":true,"default":null}` |
| [RPC] | parent / before whole block | AgentWallet.WalletFunds | `0x14e9e00acd6d607b26a12304b528a15d390547c4f733dd3953f499b5ed2d6d42d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `{"absent":true,"default":0}` |
| [RPC] | parent / before whole block | System.Account | `0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `{"nonce":0,"consumers":0,"providers":1,"sufficients":0,"data":{"free":25014684000000000000,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | parent / before whole block | System.Account | `0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9c44e9961f26b2a67d7c25cbcafd92a8cc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a` | `{"nonce":1,"consumers":0,"providers":1,"sufficients":0,"data":{"free":25000834454255000000,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | after whole block | AgentWallet.Wallets | `0x14e9e00acd6d607b26a12304b528a15da64f9201059f2ce9f59920724cac5be4d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `{"owner":"0xc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a","per_tx_limit":138389000000000000,"daily_cap":867389000000000000,"epoch_spent":0,"epoch_start":3488342,"active":true,"allowed_destinations":[]}` |
| [RPC] | after whole block | AgentWallet.WalletFunds | `0x14e9e00acd6d607b26a12304b528a15d390547c4f733dd3953f499b5ed2d6d42d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `{"absent":true,"default":0}` |
| [RPC] | after whole block | System.Account | `0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `{"nonce":0,"consumers":0,"providers":1,"sufficients":0,"data":{"free":25014684000000000000,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | after whole block | System.Account | `0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9c44e9961f26b2a67d7c25cbcafd92a8cc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a` | `{"nonce":2,"consumers":0,"providers":1,"sufficients":0,"data":{"free":24997344418390000000,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |


#### Fund: block 3488395, extrinsic 3

[RPC] Block `0x1d2d632f909094a49add9d1db60d07a6c9173706a152d14ea2bec2f514df8a1d`; extrinsic `0x3ffec8404e1a70b1e8e79f51fca706ef3765dbe88dfb42b4a7e89c2a73e7ef6a`; signer `5GYXtQDfSoxGVKvjj3hmSNAWFqoTb4DrChd6qAzPL68NuXsQ`. [Raw bytes and decode](../evidence/block-1d2d632f909094a49add9d1db60d07a6c9173706a152d14ea2bec2f514df8a1d.json).

[RPC] Arguments decoded from the node:

```json
{
  "AgentWallet": [
    {
      "fund_wallet": {
        "agent": "0x689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750",
        "amount": 33120000000000000
      }
    }
  ]
}
```

| Evidence | Order within phase | Event | Every field, in metadata order | Topics |
|---|---|---|---|---|
| [RPC] | 0 | Balances.Withdraw | `{"who":"0xc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a","amount":3220890780000000}` | `[]` |
| [RPC] | 1 | Balances.Transfer | `{"from":"0xc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a","to":"0x689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750","amount":33120000000000000}` | `[]` |
| [RPC] | 2 | AgentWallet.WalletFunded | `{"agent":"0x689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750","amount":33120000000000000}` | `[]` |
| [RPC] | 3 | Balances.Deposit | `{"who":"0xa0c40b5121b28b836ee79761553681af8b4cbc9afbb6906f2e5a89ca7b90020c","amount":3220890780000000}` | `[]` |
| [RPC] | 4 | TransactionPayment.TransactionFeePaid | `{"who":"0xc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a","actual_fee":3220890780000000,"tip":0}` | `[]` |
| [RPC] | 5 | System.ExtrinsicSuccess | `{"dispatch_info":{"weight":{"ref_time":644178000,"proof_size":15985},"class":{"Normal":[]},"pays_fee":{"Yes":[]}}}` | `[]` |

| Evidence | State boundary | Item | Key | Complete decoded value |
|---|---|---|---|---|
| [RPC] | parent / before whole block | AgentWallet.Wallets | `0x14e9e00acd6d607b26a12304b528a15da64f9201059f2ce9f59920724cac5be4d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `{"owner":"0xc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a","per_tx_limit":138389000000000000,"daily_cap":867389000000000000,"epoch_spent":0,"epoch_start":3488342,"active":true,"allowed_destinations":[]}` |
| [RPC] | parent / before whole block | AgentWallet.WalletFunds | `0x14e9e00acd6d607b26a12304b528a15d390547c4f733dd3953f499b5ed2d6d42d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `{"absent":true,"default":0}` |
| [RPC] | parent / before whole block | System.Account | `0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `{"nonce":0,"consumers":0,"providers":1,"sufficients":0,"data":{"free":25014684000000000000,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | parent / before whole block | System.Account | `0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9c44e9961f26b2a67d7c25cbcafd92a8cc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a` | `{"nonce":8,"consumers":1,"providers":1,"sufficients":0,"data":{"free":14734993828430000000,"reserved":10246494000000000000,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | after whole block | AgentWallet.Wallets | `0x14e9e00acd6d607b26a12304b528a15da64f9201059f2ce9f59920724cac5be4d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `{"owner":"0xc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a","per_tx_limit":138389000000000000,"daily_cap":867389000000000000,"epoch_spent":0,"epoch_start":3488342,"active":true,"allowed_destinations":[]}` |
| [RPC] | after whole block | AgentWallet.WalletFunds | `0x14e9e00acd6d607b26a12304b528a15d390547c4f733dd3953f499b5ed2d6d42d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `33120000000000000` |
| [RPC] | after whole block | System.Account | `0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `{"nonce":0,"consumers":0,"providers":1,"sufficients":0,"data":{"free":25047804000000000000,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | after whole block | System.Account | `0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9c44e9961f26b2a67d7c25cbcafd92a8cc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a` | `{"nonce":9,"consumers":1,"providers":1,"sufficients":0,"data":{"free":14770169937650000000,"reserved":10246494000000000000,"frozen":0,"flags":170141183460469231731687303715884105728}}` |


#### Spend: block 3488403, extrinsic 2

[RPC] Block `0x36285797c39814175824703feda744d94f3bbbf5ff9ba2624f5c8005259be7c5`; extrinsic `0x81d16049f2d2ceec7d18f8d479a326c67e175bdaec5e081d173a201b563727b9`; signer `5ERpXc2gLv39tC6Qe7QWgbu5ncYgX9VH6MbQa8tG9Br545L4`. [Raw bytes and decode](../evidence/block-36285797c39814175824703feda744d94f3bbbf5ff9ba2624f5c8005259be7c5.json).

[RPC] Arguments decoded from the node:

```json
{
  "AgentWallet": [
    {
      "agent_transfer": {
        "destination": "0xc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a",
        "amount": 18557000000000000
      }
    }
  ]
}
```

| Evidence | Order within phase | Event | Every field, in metadata order | Topics |
|---|---|---|---|---|
| [RPC] | 0 | Balances.Withdraw | `{"who":"0x689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750","amount":3744215780000000}` | `[]` |
| [RPC] | 1 | Balances.Transfer | `{"from":"0x689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750","to":"0xc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a","amount":18557000000000000}` | `[]` |
| [RPC] | 2 | AgentWallet.AgentTransfer | `{"agent":"0x689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750","destination":"0xc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a","amount":18557000000000000}` | `[]` |
| [RPC] | 3 | Balances.Deposit | `{"who":"0x786d3bea8cd9c4fda4c50bf3f5f03fe47b09e695d5c53e95a5ad6c2326ba3871","amount":3744215780000000}` | `[]` |
| [RPC] | 4 | TransactionPayment.TransactionFeePaid | `{"who":"0x689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750","actual_fee":3744215780000000,"tip":0}` | `[]` |
| [RPC] | 5 | System.ExtrinsicSuccess | `{"dispatch_info":{"weight":{"ref_time":748843000,"proof_size":15985},"class":{"Normal":[]},"pays_fee":{"Yes":[]}}}` | `[]` |

| Evidence | State boundary | Item | Key | Complete decoded value |
|---|---|---|---|---|
| [RPC] | parent / before whole block | AgentWallet.Wallets | `0x14e9e00acd6d607b26a12304b528a15da64f9201059f2ce9f59920724cac5be4d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `{"owner":"0xc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a","per_tx_limit":138389000000000000,"daily_cap":867389000000000000,"epoch_spent":0,"epoch_start":3488342,"active":true,"allowed_destinations":[]}` |
| [RPC] | parent / before whole block | AgentWallet.WalletFunds | `0x14e9e00acd6d607b26a12304b528a15d390547c4f733dd3953f499b5ed2d6d42d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `33120000000000000` |
| [RPC] | parent / before whole block | System.Account | `0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `{"nonce":0,"consumers":0,"providers":1,"sufficients":0,"data":{"free":25047804000000000000,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | parent / before whole block | System.Account | `0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9c44e9961f26b2a67d7c25cbcafd92a8cc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a` | `{"nonce":9,"consumers":1,"providers":1,"sufficients":0,"data":{"free":14770169937650000000,"reserved":10246494000000000000,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | after whole block | AgentWallet.Wallets | `0x14e9e00acd6d607b26a12304b528a15da64f9201059f2ce9f59920724cac5be4d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `{"owner":"0xc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a","per_tx_limit":138389000000000000,"daily_cap":867389000000000000,"epoch_spent":18557000000000000,"epoch_start":3488342,"active":true,"allowed_destinations":[]}` |
| [RPC] | after whole block | AgentWallet.WalletFunds | `0x14e9e00acd6d607b26a12304b528a15d390547c4f733dd3953f499b5ed2d6d42d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `14563000000000000` |
| [RPC] | after whole block | System.Account | `0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `{"nonce":1,"consumers":0,"providers":1,"sufficients":0,"data":{"free":25025502784220000000,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | after whole block | System.Account | `0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9c44e9961f26b2a67d7c25cbcafd92a8cc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a` | `{"nonce":10,"consumers":1,"providers":1,"sufficients":0,"data":{"free":14770075721870000000,"reserved":10246494000000000000,"frozen":0,"flags":170141183460469231731687303715884105728}}` |


#### Deactivate: block 3488414, extrinsic 3

[RPC] Block `0xf8500166c6999f8765546246021fff4091ccaf0f5e8f3f495a48440ac73b43b3`; extrinsic `0x1b66d66ad506afb1b082fba85bb090d26b36af65aa17513615c26ea5bf6600c9`; signer `5GYXtQDfSoxGVKvjj3hmSNAWFqoTb4DrChd6qAzPL68NuXsQ`. [Raw bytes and decode](../evidence/block-f8500166c6999f8765546246021fff4091ccaf0f5e8f3f495a48440ac73b43b3.json).

[RPC] Arguments decoded from the node:

```json
{
  "AgentWallet": [
    {
      "deactivate_wallet": {
        "agent": "0x689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750"
      }
    }
  ]
}
```

| Evidence | Order within phase | Event | Every field, in metadata order | Topics |
|---|---|---|---|---|
| [RPC] | 0 | Balances.Withdraw | `{"who":"0xc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a","amount":2663665700000000}` | `[]` |
| [RPC] | 1 | AgentWallet.WalletDeactivated | `{"owner":"0xc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a","agent":"0x689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750"}` | `[]` |
| [RPC] | 2 | Balances.Deposit | `{"who":"0xe0825ae98d71567e9a5f5756a4702022f7a30283839420c90dcabf9b5d75d01f","amount":2663665700000000}` | `[]` |
| [RPC] | 3 | TransactionPayment.TransactionFeePaid | `{"who":"0xc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a","actual_fee":2663665700000000,"tip":0}` | `[]` |
| [RPC] | 4 | System.ExtrinsicSuccess | `{"dispatch_info":{"weight":{"ref_time":532733000,"proof_size":13382},"class":{"Normal":[]},"pays_fee":{"Yes":[]}}}` | `[]` |

| Evidence | State boundary | Item | Key | Complete decoded value |
|---|---|---|---|---|
| [RPC] | parent / before whole block | AgentWallet.Wallets | `0x14e9e00acd6d607b26a12304b528a15da64f9201059f2ce9f59920724cac5be4d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `{"owner":"0xc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a","per_tx_limit":138389000000000000,"daily_cap":867389000000000000,"epoch_spent":18557000000000000,"epoch_start":3488342,"active":true,"allowed_destinations":[]}` |
| [RPC] | parent / before whole block | AgentWallet.WalletFunds | `0x14e9e00acd6d607b26a12304b528a15d390547c4f733dd3953f499b5ed2d6d42d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `14563000000000000` |
| [RPC] | parent / before whole block | System.Account | `0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `{"nonce":1,"consumers":0,"providers":1,"sufficients":0,"data":{"free":25025502784220000000,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | parent / before whole block | System.Account | `0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9c44e9961f26b2a67d7c25cbcafd92a8cc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a` | `{"nonce":10,"consumers":1,"providers":1,"sufficients":0,"data":{"free":14770075721870000000,"reserved":10246494000000000000,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | after whole block | AgentWallet.Wallets | `0x14e9e00acd6d607b26a12304b528a15da64f9201059f2ce9f59920724cac5be4d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `{"owner":"0xc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a","per_tx_limit":138389000000000000,"daily_cap":867389000000000000,"epoch_spent":18557000000000000,"epoch_start":3488342,"active":false,"allowed_destinations":[]}` |
| [RPC] | after whole block | AgentWallet.WalletFunds | `0x14e9e00acd6d607b26a12304b528a15d390547c4f733dd3953f499b5ed2d6d42d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `14563000000000000` |
| [RPC] | after whole block | System.Account | `0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `{"nonce":1,"consumers":0,"providers":1,"sufficients":0,"data":{"free":25025502784220000000,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | after whole block | System.Account | `0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9c44e9961f26b2a67d7c25cbcafd92a8cc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a` | `{"nonce":11,"consumers":1,"providers":1,"sufficients":0,"data":{"free":14767412056170000000,"reserved":10246494000000000000,"frozen":0,"flags":170141183460469231731687303715884105728}}` |


#### Reactivate: block 3488422, extrinsic 4

[RPC] Block `0x945f378e668aaa87d8cb8cc1ba068a4fe565125947e9d939a2f5af543b4bfacd`; extrinsic `0x06839633665e6a1ca82ee7be365fcd16901c6bff5c233c38596aab640330ca32`; signer `5GYXtQDfSoxGVKvjj3hmSNAWFqoTb4DrChd6qAzPL68NuXsQ`. [Raw bytes and decode](../evidence/block-945f378e668aaa87d8cb8cc1ba068a4fe565125947e9d939a2f5af543b4bfacd.json).

[RPC] Arguments decoded from the node:

```json
{
  "AgentWallet": [
    {
      "reactivate_wallet": {
        "agent": "0x689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750"
      }
    }
  ]
}
```

| Evidence | Order within phase | Event | Every field, in metadata order | Topics |
|---|---|---|---|---|
| [RPC] | 0 | Balances.Withdraw | `{"who":"0xc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a","amount":2664465700000000}` | `[]` |
| [RPC] | 1 | AgentWallet.WalletReactivated | `{"owner":"0xc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a","agent":"0x689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750"}` | `[]` |
| [RPC] | 2 | Balances.Deposit | `{"who":"0x38a07c3e7e58dcd4689f99050c6a28434d327168c166910809636b65595e076d","amount":2664465700000000}` | `[]` |
| [RPC] | 3 | TransactionPayment.TransactionFeePaid | `{"who":"0xc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a","actual_fee":2664465700000000,"tip":0}` | `[]` |
| [RPC] | 4 | System.ExtrinsicSuccess | `{"dispatch_info":{"weight":{"ref_time":532893000,"proof_size":13382},"class":{"Normal":[]},"pays_fee":{"Yes":[]}}}` | `[]` |

| Evidence | State boundary | Item | Key | Complete decoded value |
|---|---|---|---|---|
| [RPC] | parent / before whole block | AgentWallet.Wallets | `0x14e9e00acd6d607b26a12304b528a15da64f9201059f2ce9f59920724cac5be4d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `{"owner":"0xc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a","per_tx_limit":138389000000000000,"daily_cap":867389000000000000,"epoch_spent":18557000000000000,"epoch_start":3488342,"active":false,"allowed_destinations":[]}` |
| [RPC] | parent / before whole block | AgentWallet.WalletFunds | `0x14e9e00acd6d607b26a12304b528a15d390547c4f733dd3953f499b5ed2d6d42d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `14563000000000000` |
| [RPC] | parent / before whole block | System.Account | `0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `{"nonce":1,"consumers":0,"providers":1,"sufficients":0,"data":{"free":25025502784220000000,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | parent / before whole block | System.Account | `0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9c44e9961f26b2a67d7c25cbcafd92a8cc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a` | `{"nonce":11,"consumers":1,"providers":1,"sufficients":0,"data":{"free":14767412056170000000,"reserved":10246494000000000000,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | after whole block | AgentWallet.Wallets | `0x14e9e00acd6d607b26a12304b528a15da64f9201059f2ce9f59920724cac5be4d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `{"owner":"0xc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a","per_tx_limit":138389000000000000,"daily_cap":867389000000000000,"epoch_spent":18557000000000000,"epoch_start":3488342,"active":true,"allowed_destinations":[]}` |
| [RPC] | after whole block | AgentWallet.WalletFunds | `0x14e9e00acd6d607b26a12304b528a15d390547c4f733dd3953f499b5ed2d6d42d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `14563000000000000` |
| [RPC] | after whole block | System.Account | `0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9d4c1241cc8daa397f42fd57c1ac84b21689313f9d32c7e66960e0f4451661af1237e95b7885922da08456a7887873750` | `{"nonce":1,"consumers":0,"providers":1,"sufficients":0,"data":{"free":25025502784220000000,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | after whole block | System.Account | `0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9c44e9961f26b2a67d7c25cbcafd92a8cc62a3e20483ba748d2060284647e45002a4df9325761d4f8d173aad4d4be4c6a` | `{"nonce":12,"consumers":1,"providers":1,"sufficients":0,"data":{"free":14764747590470000000,"reserved":10246494000000000000,"frozen":0,"flags":170141183460469231731687303715884105728}}` |

[inference] In the isolated guarded spend, principal `18557000000000000` reduces WalletFunds `33120000000000000 → 14563000000000000` and increments epoch spend by that amount. The cap checks occur on the guarded transfer; fees are additional. No inference receipt or miner identity is bound to this transfer. [State](../evidence/example-state.json).

### 7.2 Session creation → rejected policy update → revocation

[RPC] The linked session owner is `5GGzAkXEbNfUh9NKq8EvLxnuGup2LrKsDKk6gw4yCE79Xyby` (`0xba4ec9f984ae3c780877bb31f361a8e389b133a5ca6604e55f0f1dcbdf17f14a`), delegate `5Fghago3qMKErQJmqjBcqXBVu8iV2CJwS1tE4FvMJjsK1GSV` (`0xa0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a`). Creation chooses a daily cap **larger** than the lifetime cap; the successful creation shows clients must use the minimum applicable ceiling rather than assume constructor normalization. A later too-large update fails as described below. [Node block/state evidence](../evidence/example-state.json).


#### Create linked session: block 3488117, extrinsic 3

[RPC] Block `0x7b72a1d4ee6aa47321cb6f5309afeb6aed891977bc56cb2dc953e93c803051aa`; extrinsic `0x33012e3ed9faed0285fde763c6d0329ead0b78faa745bb68b3b3993b673ba0a8`; signer `5GGzAkXEbNfUh9NKq8EvLxnuGup2LrKsDKk6gw4yCE79Xyby`. [Raw bytes and decode](../evidence/block-7b72a1d4ee6aa47321cb6f5309afeb6aed891977bc56cb2dc953e93c803051aa.json).

[RPC] Arguments decoded from the node:

```json
{
  "FlopSessionKeys": [
    {
      "create_session": {
        "delegate": "0xa0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a",
        "spending_cap": 782555000000000000,
        "per_tx_limit": 96697000000000000,
        "daily_cap": 1874087000000000000,
        "duration_blocks": 105934,
        "allowed_pallets": []
      }
    }
  ]
}
```

| Evidence | Order within phase | Event | Every field, in metadata order | Topics |
|---|---|---|---|---|
| [RPC] | 0 | Balances.Withdraw | `{"who":"0xba4ec9f984ae3c780877bb31f361a8e389b133a5ca6604e55f0f1dcbdf17f14a","amount":5151485965000000}` | `[]` |
| [RPC] | 1 | FlopSessionKeys.SessionCreated | `{"owner":"0xba4ec9f984ae3c780877bb31f361a8e389b133a5ca6604e55f0f1dcbdf17f14a","delegate":"0xa0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a","spending_cap":782555000000000000,"per_tx_limit":96697000000000000,"daily_cap":1874087000000000000,"expires_at":3594051}` | `[]` |
| [RPC] | 2 | Balances.Deposit | `{"who":"0xa0d86aa66025c8f07806344a3964ee858821458e0598981f293da3a62714be0f","amount":5151485965000000}` | `[]` |
| [RPC] | 3 | TransactionPayment.TransactionFeePaid | `{"who":"0xba4ec9f984ae3c780877bb31f361a8e389b133a5ca6604e55f0f1dcbdf17f14a","actual_fee":5151485965000000,"tip":0}` | `[]` |
| [RPC] | 4 | System.ExtrinsicSuccess | `{"dispatch_info":{"weight":{"ref_time":1030297000,"proof_size":15985},"class":{"Normal":[]},"pays_fee":{"Yes":[]}}}` | `[]` |

| Evidence | Boundary | Item | Full key | Complete decoded value |
|---|---|---|---|---|
| [RPC] | before block | Sessions | `0x26d6680094539fc341d5ea8ffc79d76f028685274e698e781f7f2766cba0cc83250789de6f9c38eebf749b4b77849a18ba4ec9f984ae3c780877bb31f361a8e389b133a5ca6604e55f0f1dcbdf17f14a43cc949c7516afa5072f2f829705ad89a0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a` | `null` |
| [RPC] | before block | SessionNonces | `0x26d6680094539fc341d5ea8ffc79d76fa8bf8c9b4fb4963e0d891d0ea6eb7b2c250789de6f9c38eebf749b4b77849a18ba4ec9f984ae3c780877bb31f361a8e389b133a5ca6604e55f0f1dcbdf17f14a43cc949c7516afa5072f2f829705ad89a0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a` | `null` |
| [RPC] | before block | CircuitBreakers | `0x26d6680094539fc341d5ea8ffc79d76f8ab2f41796e7514fa8610f8d361c94e743cc949c7516afa5072f2f829705ad89a0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a` | `null` |
| [RPC] | after block | Sessions | `0x26d6680094539fc341d5ea8ffc79d76f028685274e698e781f7f2766cba0cc83250789de6f9c38eebf749b4b77849a18ba4ec9f984ae3c780877bb31f361a8e389b133a5ca6604e55f0f1dcbdf17f14a43cc949c7516afa5072f2f829705ad89a0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a` | `{"owner":"0xba4ec9f984ae3c780877bb31f361a8e389b133a5ca6604e55f0f1dcbdf17f14a","delegate":"0xa0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a","spending_cap":782555000000000000,"per_tx_limit":96697000000000000,"daily_cap":1874087000000000000,"epoch_spent":0,"epoch_start":3488117,"spent":0,"expires_at":3594051,"allowed_pallets":[],"active":true}` |
| [RPC] | after block | SessionNonces | `0x26d6680094539fc341d5ea8ffc79d76fa8bf8c9b4fb4963e0d891d0ea6eb7b2c250789de6f9c38eebf749b4b77849a18ba4ec9f984ae3c780877bb31f361a8e389b133a5ca6604e55f0f1dcbdf17f14a43cc949c7516afa5072f2f829705ad89a0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a` | `0` |
| [RPC] | after block | CircuitBreakers | `0x26d6680094539fc341d5ea8ffc79d76f8ab2f41796e7514fa8610f8d361c94e743cc949c7516afa5072f2f829705ad89a0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a` | `{"period_start":3488117,"tx_count":0,"total_spend":0,"tripped":false}` |


#### Rejected limit update: block 3488299, extrinsic 2

[RPC] Block `0xad437d438c00687b782a127d2b52a819b444b84a571e5054da0990e8c301a92a`; extrinsic `0xf732db7f74accd856871254df8b774fd0a7c637da16e91316d06258cc5d80802`; signer `5GGzAkXEbNfUh9NKq8EvLxnuGup2LrKsDKk6gw4yCE79Xyby`. [Raw bytes and decode](../evidence/block-ad437d438c00687b782a127d2b52a819b444b84a571e5054da0990e8c301a92a.json).

[RPC] Arguments decoded from the node:

```json
{
  "FlopSessionKeys": [
    {
      "update_session_limits": {
        "delegate": "0xa0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a",
        "per_tx_limit": 112394000000000000,
        "daily_cap": 1139889000000000000
      }
    }
  ]
}
```

| Evidence | Order within phase | Event | Every field, in metadata order | Topics |
|---|---|---|---|---|
| [RPC] | 0 | Balances.Withdraw | `{"who":"0xba4ec9f984ae3c780877bb31f361a8e389b133a5ca6604e55f0f1dcbdf17f14a","amount":2719565860000000}` | `[]` |
| [RPC] | 1 | Balances.Deposit | `{"who":"0x92017e3c490f5952769fe0e2b6634e5823baec154068db4e38ea4c016ccffe0c","amount":2719565860000000}` | `[]` |
| [RPC] | 2 | TransactionPayment.TransactionFeePaid | `{"who":"0xba4ec9f984ae3c780877bb31f361a8e389b133a5ca6604e55f0f1dcbdf17f14a","actual_fee":2719565860000000,"tip":0}` | `[]` |
| [RPC] | 3 | System.ExtrinsicFailed | `{"dispatch_error":{"Module":[{"index":94,"error":"0x04000000"}]},"dispatch_info":{"weight":{"ref_time":543913000,"proof_size":15985},"class":{"Normal":[]},"pays_fee":{"Yes":[]}}}` | `[]` |

| Evidence | Boundary | Item | Full key | Complete decoded value |
|---|---|---|---|---|
| [RPC] | before block | Sessions | `0x26d6680094539fc341d5ea8ffc79d76f028685274e698e781f7f2766cba0cc83250789de6f9c38eebf749b4b77849a18ba4ec9f984ae3c780877bb31f361a8e389b133a5ca6604e55f0f1dcbdf17f14a43cc949c7516afa5072f2f829705ad89a0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a` | `{"owner":"0xba4ec9f984ae3c780877bb31f361a8e389b133a5ca6604e55f0f1dcbdf17f14a","delegate":"0xa0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a","spending_cap":782555000000000000,"per_tx_limit":96697000000000000,"daily_cap":1874087000000000000,"epoch_spent":5696000000000000,"epoch_start":3488117,"spent":5696000000000000,"expires_at":3594051,"allowed_pallets":[],"active":true}` |
| [RPC] | before block | SessionNonces | `0x26d6680094539fc341d5ea8ffc79d76fa8bf8c9b4fb4963e0d891d0ea6eb7b2c250789de6f9c38eebf749b4b77849a18ba4ec9f984ae3c780877bb31f361a8e389b133a5ca6604e55f0f1dcbdf17f14a43cc949c7516afa5072f2f829705ad89a0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a` | `0` |
| [RPC] | before block | CircuitBreakers | `0x26d6680094539fc341d5ea8ffc79d76f8ab2f41796e7514fa8610f8d361c94e743cc949c7516afa5072f2f829705ad89a0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a` | `{"period_start":3488117,"tx_count":1,"total_spend":5696000000000000,"tripped":false}` |
| [RPC] | after block | Sessions | `0x26d6680094539fc341d5ea8ffc79d76f028685274e698e781f7f2766cba0cc83250789de6f9c38eebf749b4b77849a18ba4ec9f984ae3c780877bb31f361a8e389b133a5ca6604e55f0f1dcbdf17f14a43cc949c7516afa5072f2f829705ad89a0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a` | `{"owner":"0xba4ec9f984ae3c780877bb31f361a8e389b133a5ca6604e55f0f1dcbdf17f14a","delegate":"0xa0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a","spending_cap":782555000000000000,"per_tx_limit":96697000000000000,"daily_cap":1874087000000000000,"epoch_spent":5696000000000000,"epoch_start":3488117,"spent":5696000000000000,"expires_at":3594051,"allowed_pallets":[],"active":true}` |
| [RPC] | after block | SessionNonces | `0x26d6680094539fc341d5ea8ffc79d76fa8bf8c9b4fb4963e0d891d0ea6eb7b2c250789de6f9c38eebf749b4b77849a18ba4ec9f984ae3c780877bb31f361a8e389b133a5ca6604e55f0f1dcbdf17f14a43cc949c7516afa5072f2f829705ad89a0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a` | `0` |
| [RPC] | after block | CircuitBreakers | `0x26d6680094539fc341d5ea8ffc79d76f8ab2f41796e7514fa8610f8d361c94e743cc949c7516afa5072f2f829705ad89a0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a` | `{"period_start":3488117,"tx_count":1,"total_spend":5696000000000000,"tripped":false}` |


#### Revoke linked session: block 3488304, extrinsic 2

[RPC] Block `0x114ea8320e2a78cf418c22f94e858e95ad695c05bff8b6423faf17f13b705d48`; extrinsic `0x2dae4a98d7b1ddbd4ea7838771bdcf6bc1b733e82f7f3e7f07152f5a2f898016`; signer `5GGzAkXEbNfUh9NKq8EvLxnuGup2LrKsDKk6gw4yCE79Xyby`. [Raw bytes and decode](../evidence/block-114ea8320e2a78cf418c22f94e858e95ad695c05bff8b6423faf17f13b705d48.json).

[RPC] Arguments decoded from the node:

```json
{
  "FlopSessionKeys": [
    {
      "revoke_session": {
        "delegate": "0xa0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a"
      }
    }
  ]
}
```

| Evidence | Order within phase | Event | Every field, in metadata order | Topics |
|---|---|---|---|---|
| [RPC] | 0 | Balances.Withdraw | `{"who":"0xba4ec9f984ae3c780877bb31f361a8e389b133a5ca6604e55f0f1dcbdf17f14a","amount":3906000700000000}` | `[]` |
| [RPC] | 1 | FlopSessionKeys.SessionRevoked | `{"owner":"0xba4ec9f984ae3c780877bb31f361a8e389b133a5ca6604e55f0f1dcbdf17f14a","delegate":"0xa0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a"}` | `[]` |
| [RPC] | 2 | Balances.Deposit | `{"who":"0xb0f8840c076f67c33c3abc5587be9ef2668459e348e5012bf1799a792f320678","amount":3906000700000000}` | `[]` |
| [RPC] | 3 | TransactionPayment.TransactionFeePaid | `{"who":"0xba4ec9f984ae3c780877bb31f361a8e389b133a5ca6604e55f0f1dcbdf17f14a","actual_fee":3906000700000000,"tip":0}` | `[]` |
| [RPC] | 4 | System.ExtrinsicSuccess | `{"dispatch_info":{"weight":{"ref_time":781200000,"proof_size":15985},"class":{"Normal":[]},"pays_fee":{"Yes":[]}}}` | `[]` |

| Evidence | Boundary | Item | Full key | Complete decoded value |
|---|---|---|---|---|
| [RPC] | before block | Sessions | `0x26d6680094539fc341d5ea8ffc79d76f028685274e698e781f7f2766cba0cc83250789de6f9c38eebf749b4b77849a18ba4ec9f984ae3c780877bb31f361a8e389b133a5ca6604e55f0f1dcbdf17f14a43cc949c7516afa5072f2f829705ad89a0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a` | `{"owner":"0xba4ec9f984ae3c780877bb31f361a8e389b133a5ca6604e55f0f1dcbdf17f14a","delegate":"0xa0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a","spending_cap":782555000000000000,"per_tx_limit":96697000000000000,"daily_cap":1874087000000000000,"epoch_spent":5696000000000000,"epoch_start":3488117,"spent":5696000000000000,"expires_at":3594051,"allowed_pallets":[],"active":true}` |
| [RPC] | before block | SessionNonces | `0x26d6680094539fc341d5ea8ffc79d76fa8bf8c9b4fb4963e0d891d0ea6eb7b2c250789de6f9c38eebf749b4b77849a18ba4ec9f984ae3c780877bb31f361a8e389b133a5ca6604e55f0f1dcbdf17f14a43cc949c7516afa5072f2f829705ad89a0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a` | `0` |
| [RPC] | before block | CircuitBreakers | `0x26d6680094539fc341d5ea8ffc79d76f8ab2f41796e7514fa8610f8d361c94e743cc949c7516afa5072f2f829705ad89a0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a` | `{"period_start":3488117,"tx_count":1,"total_spend":5696000000000000,"tripped":false}` |
| [RPC] | after block | Sessions | `0x26d6680094539fc341d5ea8ffc79d76f028685274e698e781f7f2766cba0cc83250789de6f9c38eebf749b4b77849a18ba4ec9f984ae3c780877bb31f361a8e389b133a5ca6604e55f0f1dcbdf17f14a43cc949c7516afa5072f2f829705ad89a0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a` | `{"owner":"0xba4ec9f984ae3c780877bb31f361a8e389b133a5ca6604e55f0f1dcbdf17f14a","delegate":"0xa0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a","spending_cap":782555000000000000,"per_tx_limit":96697000000000000,"daily_cap":1874087000000000000,"epoch_spent":5696000000000000,"epoch_start":3488117,"spent":5696000000000000,"expires_at":3594051,"allowed_pallets":[],"active":false}` |
| [RPC] | after block | SessionNonces | `0x26d6680094539fc341d5ea8ffc79d76fa8bf8c9b4fb4963e0d891d0ea6eb7b2c250789de6f9c38eebf749b4b77849a18ba4ec9f984ae3c780877bb31f361a8e389b133a5ca6604e55f0f1dcbdf17f14a43cc949c7516afa5072f2f829705ad89a0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a` | `0` |
| [RPC] | after block | CircuitBreakers | `0x26d6680094539fc341d5ea8ffc79d76f8ab2f41796e7514fa8610f8d361c94e743cc949c7516afa5072f2f829705ad89a0289b7a5d6bf829bedd27e5d54b3f5366303393d3ff871eaa42075a6ec20c7a` | `{"period_start":3488117,"tx_count":1,"total_spend":5696000000000000,"tripped":false}` |

[RPC] At creation `expires_at = 3488117 + 105934 = 3594051`; lifetime `782555000000000000`, initial daily `1874087000000000000`. At the failed update the stored prior spend is `5696000000000000`; lifetime remainder is `776859000000000000`, below requested daily `1139889000000000000`. The node returns Module(index=94,error=0x04000000), decoded by this block’s metadata as `SpendingCapExceeded`. After revocation, `active=false` but spend and epoch fields remain. [Node state](../evidence/example-state.json).


#### Independent additional create_session example: block 3488302, extrinsic 2

[RPC] Block `0x65890b494db18a7ff2e32512e03022b31ea414b005563103e4ea94b44d0ccde1`; extrinsic `0x66a8293fb2a5334f714ba5a597911ac84230f4a2aa237595bd2126bf11d0d34f`; signer `5EC4cgq3ba2Yhbr1kTeBj7XEYAsURY7TFSN43y3mryPR1f6e`. [Raw bytes and decode](../evidence/block-65890b494db18a7ff2e32512e03022b31ea414b005563103e4ea94b44d0ccde1.json).

[RPC] Arguments decoded from the node:

```json
{
  "FlopSessionKeys": [
    {
      "create_session": {
        "delegate": "0xed6eb8bb9c6a64ba364d177acff4728f291dc0de65e6087cfbddd2802ce69be9",
        "spending_cap": 851331459000000000,
        "per_tx_limit": 179702954000000000,
        "daily_cap": 638908360000000000,
        "duration_blocks": 132737,
        "allowed_pallets": []
      }
    }
  ]
}
```

| Evidence | Order within phase | Event | Every field, in metadata order | Topics |
|---|---|---|---|---|
| [RPC] | 0 | Balances.Withdraw | `{"who":"0x5e1510c94f666db6223dbee3d2f45a141133ab3cab212238f3b55b0c7d69d185","amount":5151485960000000}` | `[]` |
| [RPC] | 1 | FlopSessionKeys.SessionCreated | `{"owner":"0x5e1510c94f666db6223dbee3d2f45a141133ab3cab212238f3b55b0c7d69d185","delegate":"0xed6eb8bb9c6a64ba364d177acff4728f291dc0de65e6087cfbddd2802ce69be9","spending_cap":851331459000000000,"per_tx_limit":179702954000000000,"daily_cap":638908360000000000,"expires_at":3621039}` | `[]` |
| [RPC] | 2 | Balances.Deposit | `{"who":"0xa0d86aa66025c8f07806344a3964ee858821458e0598981f293da3a62714be0f","amount":5151485960000000}` | `[]` |
| [RPC] | 3 | TransactionPayment.TransactionFeePaid | `{"who":"0x5e1510c94f666db6223dbee3d2f45a141133ab3cab212238f3b55b0c7d69d185","actual_fee":5151485960000000,"tip":0}` | `[]` |
| [RPC] | 4 | System.ExtrinsicSuccess | `{"dispatch_info":{"weight":{"ref_time":1030297000,"proof_size":15985},"class":{"Normal":[]},"pays_fee":{"Yes":[]}}}` | `[]` |

### 7.3 Observed implicit session charging on a wallet transfer

[RPC] At block 3488169, extrinsic 2, `0x5580d4dd08e14e28f337dbe91768a610aabc8356047784bf1946313eb56baae3`, the delegate above directly signs `AgentWallet.agent_transfer(owner,5696000000000000)`. `Balances.Transfer`, `AgentWallet.AgentTransfer`, `TransactionFeePaid(actual_fee=3744215780000000,tip=0)` and `System.ExtrinsicSuccess` occur in that order after the initial fee withdrawal and before/after the fee deposit as shown in the complete event list. The wallet cap is `873062000000000000`, per-call `146015000000000000`, epoch start 3488103. [Raw block/events](../evidence/block-2b23561d70637d67781d1250a485dbe5cb97170964baa986b6f23ea8485faadf.json).

[RPC] Before → after: WalletFunds `38679000000000000 → 32983000000000000`; wallet `epoch_spent 0 → 5696000000000000`; session `spent` and `epoch_spent` each `0 → 5696000000000000`; breaker `tx_count 0 → 1`, `total_spend 0 → 5696000000000000`, `tripped=false`; `SessionNonces` stays 0. Agent free balance `13932254829210000000 → 13922814613430000000`; reserved stays `11086328000000000000`; nonce `7 → 8`. The free drop equals `5696000000000000 + 3744215780000000`, proving principal-only counter treatment **for this observed path**. [Before/after raw and decoded storage](../evidence/session-spend-state.json).

[inference] This is useful evidence that the runtime has cross-pallet session accounting, but it is not an `execute_via_session` demonstration, not an inference payment and not a rejection test. No historical gateway request is associated with this transfer. Do not substitute it for proof that a hosted bearer spends under these limits.

### 7.4 Channel payment payer and settlement

[RPC] The earlier report's channel was re-read from this node: `0x9f81f65bc93855d394329e4996bc78d949bb786178f3471c13d3853f9813ddd7`. Its stored agent is `5GsXb3TmNGixuEsbtixqHnqWr9UQJ2M8bkqBQWteNekgF98S` (`0xd4a6e5ddeffd045fac51bc3ec81937436730cfd8e75433ed81ce01e20d188b79`), not the supplied seat address. Its stored `opened_at` is 3479195, but the actual `open_channel` inclusion is **block 3479200**, as decoded from that block. It is Closed at settlement and snapshot. The field is not a reliable substitute for locating the inclusion extrinsic. The `escrow` field remains `114000000000000002` in the Closed record: **do not interpret a retained Closed escrow field as live reserved funds**. [Raw channel](../evidence/payment-channel.json).

[RPC] Opening block 3479200 transfers **1 raw unit** from the channel agent to sovereign account `0x6d6f646c666c6f702f63686e0000000000000000000000000000000000000000`. `ComputeChannel.PalletId` is the eight bytes `0x666c6f702f63686e` (`flop/chn`), documented as the sovereign account holding live escrow. At block 3479245, extrinsic 2, `top_up_escrow(channel_id,114000000000000001)` transfers that additional principal to the same account and emits total `114000000000000002`. Payer reserved balance is zero before and after both operations; the sovereign free balance increases by their principal. These are actual transfers into pooled pallet custody, not reservations in the payer account. [Opening node block](../evidence/block-6a10899ac5251a2aa8ad5add9e2f113dc7a2ce711da4819a73086ef62321d9a1.json), [top-up node block](../evidence/block-920dc42cb5fb0f1d5d203a58a486dfe9178b2c4e7889669c6200b873cfcec7f7.json), [complete balances](../evidence/payment-complete-state.json), [metadata constant](../evidence/metadata.json).

[RPC] `ChannelAuthoredOpenedAt(channel_id)=3479200`, while the channel's retained `opened_at=3479195`. Metadata describes the former as the authored opening height for work capacity, separate from the retained finalized-deadline encoding. Reading only `Channels.opened_at` to locate the extrinsic would have selected a block with no opening transaction. [Node authored-height storage](../evidence/channel-authored-opened-at.json), [metadata documentation](../evidence/metadata.json).

[RPC] At 3479299, hash `0xeba1182c9f2bbf5a8fd012afddc201c2ebed11b64f59b10c1d3c4fcc4b2ee18e`, the node events for this channel include `AuditFeeEarmarked(amount=1140000000000000)` and `Settled(miner_paid=112860000000000002,burned=0,aggregate_gn=38,cooperative=true)`. Their monetary sum is exactly `114000000000000002`. The observed sovereign account decreases by the miner-paid leg `112860000000000002`; the audit amount is earmarked, not an additional immediate transfer in this phase. The miner signs settlement and pays its extrinsic fee; this does not debit new principal from the gateway account. This proves this channel's settlement amounts, not an individual HTTP request's allocated spend. [Raw block/events](../evidence/block-eba1182c9f2bbf5a8fd012afddc201c2ebed11b64f59b10c1d3c4fcc4b2ee18e.json).

[source] The API explicitly permits one terminal event to cover several requests and calls `settled_spend_raw` the gateway's exact **request allocation** from reconciliation; null is unavailable, not zero. [CredentialReceipt schema](../evidence/openapi.json). [inference] No per-request authenticated allocation commitment was found in the runtime evidence. Thus a receipt allocation and a channel payout are separate evidence claims, consistent with the earlier report, rather than proof that this seat's chain cap was consumed.


#### Channel opening: block 3479200, extrinsic 2

[RPC] Block `0x6a10899ac5251a2aa8ad5add9e2f113dc7a2ce711da4819a73086ef62321d9a1`; extrinsic `0xab04ab00d5e8429ebd74aaf01bf57244faa0ea0b2d13053f58948a2580f3efc1`; signer `5GsXb3TmNGixuEsbtixqHnqWr9UQJ2M8bkqBQWteNekgF98S`. [Raw bytes and decode](../evidence/block-6a10899ac5251a2aa8ad5add9e2f113dc7a2ce711da4819a73086ef62321d9a1.json).

[RPC] Arguments decoded from the node:

```json
{
  "ComputeChannel": [
    {
      "open_channel": {
        "miner": "0x847236b52ea6fb0e1efc84ac1bdc9a881194f71cc646a71fcf52cb1f0d93d74b",
        "model_hash": "0x1a52c1abe781db051e70ae357f72bb70161ca0c092df0b618f22a9292ba63306",
        "measured_root": "0x1a52c1abe781db051e70ae357f72bb70161ca0c092df0b618f22a9292ba63306",
        "decode_policy_hash": "0xeca6a3f9c5a9fa1556892182ffef15b1273c075146a2d1a87814ae83ecea3053",
        "precision": {
          "BF16": []
        },
        "enclave_key": "0x3611e96ecc3295994ae62273b20c66d8da28185e8201c281dee7731afa4cc046",
        "agent_key": "0xb6b3dd9a474a02c8d059241c9a73576dea9d59ac968888b68fdcb4b9b4cbe057",
        "sla": {
          "max_turns": 1024,
          "max_duration": 1200,
          "reattest_every": 1
        },
        "escrow": 1,
        "nonce": 4696343118152568904,
        "settlement_class": {
          "Standard": []
        }
      }
    }
  ]
}
```

| Evidence | Order within phase | Event | Every field, in metadata order | Topics |
|---|---|---|---|---|
| [RPC] | 0 | Balances.Withdraw | `{"who":"0xd4a6e5ddeffd045fac51bc3ec81937436730cfd8e75433ed81ce01e20d188b79","amount":7812826700000000}` | `[]` |
| [RPC] | 1 | Balances.Transfer | `{"from":"0xd4a6e5ddeffd045fac51bc3ec81937436730cfd8e75433ed81ce01e20d188b79","to":"0x6d6f646c666c6f702f63686e0000000000000000000000000000000000000000","amount":1}` | `[]` |
| [RPC] | 2 | ComputeChannel.AssuranceClassPinned | `{"channel_id":"0x9f81f65bc93855d394329e4996bc78d949bb786178f3471c13d3853f9813ddd7","class":{"TeeToploc":[]}}` | `[]` |
| [RPC] | 3 | ComputeChannel.ChannelOpened | `{"channel_id":"0x9f81f65bc93855d394329e4996bc78d949bb786178f3471c13d3853f9813ddd7","agent":"0xd4a6e5ddeffd045fac51bc3ec81937436730cfd8e75433ed81ce01e20d188b79","miner":"0x847236b52ea6fb0e1efc84ac1bdc9a881194f71cc646a71fcf52cb1f0d93d74b","escrow":1,"measured_root":"0x1a52c1abe781db051e70ae357f72bb70161ca0c092df0b618f22a9292ba63306"}` | `[]` |
| [RPC] | 4 | ComputeChannel.CalibrationSnapshotted | `{"channel_id":"0x9f81f65bc93855d394329e4996bc78d949bb786178f3471c13d3853f9813ddd7","miner":"0x847236b52ea6fb0e1efc84ac1bdc9a881194f71cc646a71fcf52cb1f0d93d74b","cap_gflops_per_sec":130,"assurance_tier":{"Soft":[]},"calibration_version":1,"soft_tier_spot_check_rate_ppm":25000}` | `[]` |
| [RPC] | 5 | Balances.Deposit | `{"who":"0xa0c40b5121b28b836ee79761553681af8b4cbc9afbb6906f2e5a89ca7b90020c","amount":7812826700000000}` | `[]` |
| [RPC] | 6 | TransactionPayment.TransactionFeePaid | `{"who":"0xd4a6e5ddeffd045fac51bc3ec81937436730cfd8e75433ed81ce01e20d188b79","actual_fee":7812826700000000,"tip":0}` | `[]` |
| [RPC] | 7 | System.ExtrinsicSuccess | `{"dispatch_info":{"weight":{"ref_time":1562565000,"proof_size":237625},"class":{"Normal":[]},"pays_fee":{"Yes":[]}}}` | `[]` |


#### Channel top-up: block 3479245, extrinsic 2

[RPC] Block `0x920dc42cb5fb0f1d5d203a58a486dfe9178b2c4e7889669c6200b873cfcec7f7`; extrinsic `0x64c04d765ca2376b1fae99f4ecee94b8c33d82e63470cc65fca627b301d0a54e`; signer `5GsXb3TmNGixuEsbtixqHnqWr9UQJ2M8bkqBQWteNekgF98S`. [Raw bytes and decode](../evidence/block-920dc42cb5fb0f1d5d203a58a486dfe9178b2c4e7889669c6200b873cfcec7f7.json).

[RPC] Arguments decoded from the node:

```json
{
  "ComputeChannel": [
    {
      "top_up_escrow": {
        "channel_id": "0x9f81f65bc93855d394329e4996bc78d949bb786178f3471c13d3853f9813ddd7",
        "additional": 114000000000000001
      }
    }
  ]
}
```

| Evidence | Order within phase | Event | Every field, in metadata order | Topics |
|---|---|---|---|---|
| [RPC] | 0 | Balances.Withdraw | `{"who":"0xd4a6e5ddeffd045fac51bc3ec81937436730cfd8e75433ed81ce01e20d188b79","amount":3188940790000000}` | `[]` |
| [RPC] | 1 | Balances.Transfer | `{"from":"0xd4a6e5ddeffd045fac51bc3ec81937436730cfd8e75433ed81ce01e20d188b79","to":"0x6d6f646c666c6f702f63686e0000000000000000000000000000000000000000","amount":114000000000000001}` | `[]` |
| [RPC] | 2 | ComputeChannel.EscrowToppedUp | `{"channel_id":"0x9f81f65bc93855d394329e4996bc78d949bb786178f3471c13d3853f9813ddd7","added":114000000000000001,"total":114000000000000002}` | `[]` |
| [RPC] | 3 | Balances.Deposit | `{"who":"0x92017e3c490f5952769fe0e2b6634e5823baec154068db4e38ea4c016ccffe0c","amount":3188940790000000}` | `[]` |
| [RPC] | 4 | TransactionPayment.TransactionFeePaid | `{"who":"0xd4a6e5ddeffd045fac51bc3ec81937436730cfd8e75433ed81ce01e20d188b79","actual_fee":3188940790000000,"tip":0}` | `[]` |
| [RPC] | 5 | System.ExtrinsicSuccess | `{"dispatch_info":{"weight":{"ref_time":637788000,"proof_size":22105},"class":{"Normal":[]},"pays_fee":{"Yes":[]}}}` | `[]` |


#### Channel settlement: block 3479299, extrinsic 3

[RPC] Block `0xeba1182c9f2bbf5a8fd012afddc201c2ebed11b64f59b10c1d3c4fcc4b2ee18e`; extrinsic `0x4b3441424a1d051b7fdecaea871bdd9726d6a2b515201756bf1095924511cb31`; signer `5F4N78WfS4arLKzyCADdegLF5wkNZk1dJEYpTfJy3KZ3C9QM`. [Raw bytes and decode](../evidence/block-eba1182c9f2bbf5a8fd012afddc201c2ebed11b64f59b10c1d3c4fcc4b2ee18e.json).

[RPC] Arguments decoded from the node:

```json
{
  "ComputeChannel": [
    {
      "settle": {
        "channel_id": "0x9f81f65bc93855d394329e4996bc78d949bb786178f3471c13d3853f9813ddd7",
        "final_root": "0x1094f1818d2de05816e576df19a846abb2bcd5167871a3c116a106a3a8831797",
        "aggregate_gn": 38,
        "claimed_measured_root": "0x1a52c1abe781db051e70ae357f72bb70161ca0c092df0b618f22a9292ba63306",
        "agent_receipt_sig": "0xfcdc15af17e6670b4096695e458bd52ee90152036012a1bc1d1a8c74c96aa141a3589195048283ddf7320b37b1d50710778d641ec24c77e4d5b6b52f37351a8f",
        "transcript_ref": {
          "None": []
        },
        "verified_turns": [
          {
            "leaf_version": {
              "V3": []
            },
            "turn_index": 0,
            "h_in": "0x28855869c3bb25186b320f6c685763d5f2395c8cfa49e3f5928a5096a78e3f42",
            "h_out": "0xdb1abe6a7b5b0c896ba6fa847e1740627313e14083c6eef083bdaa620ed17a00",
            "g_n": 38,
            "decode_policy_hash": "0xeca6a3f9c5a9fa1556892182ffef15b1273c075146a2d1a87814ae83ecea3053",
            "h_ids": "0xbc6fced3ba1e54e89e9617aaa65bf07166ffab3f3decea006b0608e8d3372432",
            "toploc_commitment_hash": "0x7a6771d6e241340ebecdfb79dadda88f8ff51baa5bd9c193f747ca4fb231d724",
            "miner_recv_ms": 1904971,
            "miner_done_ms": 1905558,
            "latency_ms": 587,
            "enclave_sig": "0xf0f691da7009db34119ed8fa1a3c8afd49f3adba54c2be7fab47c14f93946f3ee6d0f1146d2cb8b2e063a2ad29003b68248b6068c0d22f02ead7fcb8ab00428f",
            "merkle_path": []
          }
        ]
      }
    }
  ]
}
```

| Evidence | Order within phase | Event | Every field, in metadata order | Topics |
|---|---|---|---|---|
| [RPC] | 0 | Balances.Withdraw | `{"who":"0x847236b52ea6fb0e1efc84ac1bdc9a881194f71cc646a71fcf52cb1f0d93d74b","amount":9194802785000000}` | `[]` |
| [RPC] | 1 | Balances.Transfer | `{"from":"0x6d6f646c666c6f702f63686e0000000000000000000000000000000000000000","to":"0x847236b52ea6fb0e1efc84ac1bdc9a881194f71cc646a71fcf52cb1f0d93d74b","amount":112860000000000002}` | `[]` |
| [RPC] | 2 | ComputeChannel.AuditFeeEarmarked | `{"channel_id":"0x9f81f65bc93855d394329e4996bc78d949bb786178f3471c13d3853f9813ddd7","amount":1140000000000000}` | `[]` |
| [RPC] | 3 | ComputeChannel.Settled | `{"channel_id":"0x9f81f65bc93855d394329e4996bc78d949bb786178f3471c13d3853f9813ddd7","miner_paid":112860000000000002,"burned":0,"aggregate_gn":38,"cooperative":true}` | `[]` |
| [RPC] | 4 | Balances.Deposit | `{"who":"0x80e81cf042ec7c2291a8660db3b3c6be656596193a79264c38a3a554a89fd27b","amount":9194802785000000}` | `[]` |
| [RPC] | 5 | TransactionPayment.TransactionFeePaid | `{"who":"0x847236b52ea6fb0e1efc84ac1bdc9a881194f71cc646a71fcf52cb1f0d93d74b","actual_fee":9194802785000000,"tip":0}` | `[]` |
| [RPC] | 6 | System.ExtrinsicSuccess | `{"dispatch_info":{"weight":{"ref_time":1838960000,"proof_size":295253},"class":{"Normal":[]},"pays_fee":{"Yes":[]}}}` | `[]` |


[RPC] Native account balances around these blocks (full keys/raw values are in [payment-complete-state.json](../evidence/payment-complete-state.json)):

| Evidence | Block hash | AccountId32 | Full account value |
|---|---|---|---|
| [RPC] | 0x17ee156ddfc1be8dec3aa921e5d39482344e8068ff668be1076441eca66a7a4f | `d4a6e5ddeffd045fac51bc3ec81937436730cfd8e75433ed81ce01e20d188b79` | `{"nonce":69456,"consumers":0,"providers":1,"sufficients":0,"data":{"free":979350260618286747191044,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0x17ee156ddfc1be8dec3aa921e5d39482344e8068ff668be1076441eca66a7a4f | `6d6f646c666c6f702f63686e0000000000000000000000000000000000000000` | `{"nonce":0,"consumers":0,"providers":1,"sufficients":0,"data":{"free":1356786886500000000859,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0x17ee156ddfc1be8dec3aa921e5d39482344e8068ff668be1076441eca66a7a4f | `847236b52ea6fb0e1efc84ac1bdc9a881194f71cc646a71fcf52cb1f0d93d74b` | `{"nonce":252,"consumers":0,"providers":1,"sufficients":0,"data":{"free":90255502890917028936,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0x6a10899ac5251a2aa8ad5add9e2f113dc7a2ce711da4819a73086ef62321d9a1 | `d4a6e5ddeffd045fac51bc3ec81937436730cfd8e75433ed81ce01e20d188b79` | `{"nonce":69457,"consumers":0,"providers":1,"sufficients":0,"data":{"free":979350252805460047191043,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0x6a10899ac5251a2aa8ad5add9e2f113dc7a2ce711da4819a73086ef62321d9a1 | `6d6f646c666c6f702f63686e0000000000000000000000000000000000000000` | `{"nonce":0,"consumers":0,"providers":1,"sufficients":0,"data":{"free":1356786886500000000860,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0x6a10899ac5251a2aa8ad5add9e2f113dc7a2ce711da4819a73086ef62321d9a1 | `847236b52ea6fb0e1efc84ac1bdc9a881194f71cc646a71fcf52cb1f0d93d74b` | `{"nonce":252,"consumers":0,"providers":1,"sufficients":0,"data":{"free":90255502890917028936,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0x93da85106b4b69da642282f07eeae6764c409b83f2a4ee639d811855bfdb891e | `d4a6e5ddeffd045fac51bc3ec81937436730cfd8e75433ed81ce01e20d188b79` | `{"nonce":69463,"consumers":0,"providers":1,"sufficients":0,"data":{"free":979349669366853647191041,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0x93da85106b4b69da642282f07eeae6764c409b83f2a4ee639d811855bfdb891e | `6d6f646c666c6f702f63686e0000000000000000000000000000000000000000` | `{"nonce":0,"consumers":0,"providers":1,"sufficients":0,"data":{"free":1357332886500000000862,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0x93da85106b4b69da642282f07eeae6764c409b83f2a4ee639d811855bfdb891e | `847236b52ea6fb0e1efc84ac1bdc9a881194f71cc646a71fcf52cb1f0d93d74b` | `{"nonce":252,"consumers":0,"providers":1,"sufficients":0,"data":{"free":90255502890917028936,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0x9c0ac85d24b12803e66d3def5a03cd43a2a03e55a48f8ddda166a85fac123062 | `d4a6e5ddeffd045fac51bc3ec81937436730cfd8e75433ed81ce01e20d188b79` | `{"nonce":69463,"consumers":0,"providers":1,"sufficients":0,"data":{"free":979349669366853647191041,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0x9c0ac85d24b12803e66d3def5a03cd43a2a03e55a48f8ddda166a85fac123062 | `6d6f646c666c6f702f63686e0000000000000000000000000000000000000000` | `{"nonce":0,"consumers":0,"providers":1,"sufficients":0,"data":{"free":1357332886500000000862,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0x9c0ac85d24b12803e66d3def5a03cd43a2a03e55a48f8ddda166a85fac123062 | `847236b52ea6fb0e1efc84ac1bdc9a881194f71cc646a71fcf52cb1f0d93d74b` | `{"nonce":253,"consumers":0,"providers":1,"sufficients":0,"data":{"free":88949249455007028936,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0x47bdf929b418a203dfd47c9a4fd36a036fe56279c319afe08b37c823dc229b18 | `d4a6e5ddeffd045fac51bc3ec81937436730cfd8e75433ed81ce01e20d188b79` | `{"nonce":69463,"consumers":0,"providers":1,"sufficients":0,"data":{"free":979349669366853647191041,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0x47bdf929b418a203dfd47c9a4fd36a036fe56279c319afe08b37c823dc229b18 | `6d6f646c666c6f702f63686e0000000000000000000000000000000000000000` | `{"nonce":0,"consumers":0,"providers":1,"sufficients":0,"data":{"free":1357332886500000000862,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0x47bdf929b418a203dfd47c9a4fd36a036fe56279c319afe08b37c823dc229b18 | `847236b52ea6fb0e1efc84ac1bdc9a881194f71cc646a71fcf52cb1f0d93d74b` | `{"nonce":253,"consumers":0,"providers":1,"sufficients":0,"data":{"free":88949249455007028936,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0x920dc42cb5fb0f1d5d203a58a486dfe9178b2c4e7889669c6200b873cfcec7f7 | `d4a6e5ddeffd045fac51bc3ec81937436730cfd8e75433ed81ce01e20d188b79` | `{"nonce":69464,"consumers":0,"providers":1,"sufficients":0,"data":{"free":979349552177912857191040,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0x920dc42cb5fb0f1d5d203a58a486dfe9178b2c4e7889669c6200b873cfcec7f7 | `6d6f646c666c6f702f63686e0000000000000000000000000000000000000000` | `{"nonce":0,"consumers":0,"providers":1,"sufficients":0,"data":{"free":1357446886500000000863,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0x920dc42cb5fb0f1d5d203a58a486dfe9178b2c4e7889669c6200b873cfcec7f7 | `847236b52ea6fb0e1efc84ac1bdc9a881194f71cc646a71fcf52cb1f0d93d74b` | `{"nonce":253,"consumers":0,"providers":1,"sufficients":0,"data":{"free":88949249455007028936,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0xd0b59f33ce5660ee81dbebd72670ff824079be7949b75738f3c7a13540119c09 | `d4a6e5ddeffd045fac51bc3ec81937436730cfd8e75433ed81ce01e20d188b79` | `{"nonce":69471,"consumers":0,"providers":1,"sufficients":0,"data":{"free":979349497773998927191039,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0xd0b59f33ce5660ee81dbebd72670ff824079be7949b75738f3c7a13540119c09 | `6d6f646c666c6f702f63686e0000000000000000000000000000000000000000` | `{"nonce":0,"consumers":0,"providers":1,"sufficients":0,"data":{"free":1356484606500000000862,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0xd0b59f33ce5660ee81dbebd72670ff824079be7949b75738f3c7a13540119c09 | `847236b52ea6fb0e1efc84ac1bdc9a881194f71cc646a71fcf52cb1f0d93d74b` | `{"nonce":253,"consumers":0,"providers":1,"sufficients":0,"data":{"free":88949249455007028936,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0x37b23091195e6ce7c2a74ac6a3e56b2209fa2846cb4a0a46d80792338ba5fe2d | `d4a6e5ddeffd045fac51bc3ec81937436730cfd8e75433ed81ce01e20d188b79` | `{"nonce":69471,"consumers":0,"providers":1,"sufficients":0,"data":{"free":979349497773998927191039,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0x37b23091195e6ce7c2a74ac6a3e56b2209fa2846cb4a0a46d80792338ba5fe2d | `6d6f646c666c6f702f63686e0000000000000000000000000000000000000000` | `{"nonce":0,"consumers":0,"providers":1,"sufficients":0,"data":{"free":1356484606500000000862,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0x37b23091195e6ce7c2a74ac6a3e56b2209fa2846cb4a0a46d80792338ba5fe2d | `847236b52ea6fb0e1efc84ac1bdc9a881194f71cc646a71fcf52cb1f0d93d74b` | `{"nonce":254,"consumers":0,"providers":1,"sufficients":0,"data":{"free":88946506829142028936,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0xaad1d81c1d390358e8a60ca5ed26c46b80d17c71d5a2c187caee64d854711b10 | `d4a6e5ddeffd045fac51bc3ec81937436730cfd8e75433ed81ce01e20d188b79` | `{"nonce":69472,"consumers":0,"providers":1,"sufficients":0,"data":{"free":979349490056463217191040,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0xaad1d81c1d390358e8a60ca5ed26c46b80d17c71d5a2c187caee64d854711b10 | `6d6f646c666c6f702f63686e0000000000000000000000000000000000000000` | `{"nonce":0,"consumers":0,"providers":1,"sufficients":0,"data":{"free":1356484606500000000861,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0xaad1d81c1d390358e8a60ca5ed26c46b80d17c71d5a2c187caee64d854711b10 | `847236b52ea6fb0e1efc84ac1bdc9a881194f71cc646a71fcf52cb1f0d93d74b` | `{"nonce":254,"consumers":0,"providers":1,"sufficients":0,"data":{"free":88946506829142028936,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0xeba1182c9f2bbf5a8fd012afddc201c2ebed11b64f59b10c1d3c4fcc4b2ee18e | `d4a6e5ddeffd045fac51bc3ec81937436730cfd8e75433ed81ce01e20d188b79` | `{"nonce":69472,"consumers":0,"providers":1,"sufficients":0,"data":{"free":979349490056463217191040,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0xeba1182c9f2bbf5a8fd012afddc201c2ebed11b64f59b10c1d3c4fcc4b2ee18e | `6d6f646c666c6f702f63686e0000000000000000000000000000000000000000` | `{"nonce":0,"consumers":0,"providers":1,"sufficients":0,"data":{"free":1356371746500000000859,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |
| [RPC] | 0xeba1182c9f2bbf5a8fd012afddc201c2ebed11b64f59b10c1d3c4fcc4b2ee18e | `847236b52ea6fb0e1efc84ac1bdc9a881194f71cc646a71fcf52cb1f0d93d74b` | `{"nonce":255,"consumers":0,"providers":1,"sufficients":0,"data":{"free":89050172026357028938,"reserved":0,"frozen":0,"flags":170141183460469231731687303715884105728}}` |

## 8. Failure modes and integration requirements

| Evidence | Failure mode | Required handling |
|---|---|---|
| [inference] | Runtime upgrade changes indices, fields, call filters or meter implementation | Pin genesis, spec, metadata digest **and runtime code hash**. At a new code/metadata hash stop new delegations/commitments until the exact registry and filter are reviewed; same pallet name/spec alone is insufficient. Decode historical events with metadata appropriate to that block. |
| [inference] | Reset reuses genesis | Persist trusted non-genesis checkpoints (height/hash/state root), creation block hashes and authorization IDs; compare them to the node's canonical finalized chain. If a previous finalized checkpoint no longer matches, halt and rebuild state after an explicit reset decision. Genesis equality alone cannot distinguish histories sharing block zero. |
| [RPC] | Sessions outlive the device/HTTP key | The HTTP child has a new-request clock and an authenticated-session clock; the on-chain token has `expires_at`; ComputeChannel has its own `agent_key`, SLA and escrow. No single clock is a revocation of all three objects. |
| [inference] | Session revocation races with an already committed channel | Revoke native capability and HTTP access, but retain/expose outstanding escrow obligations. Native session revocation must not be represented as canceling already signed channel receipts. Confirm on-chain ordering/finality before reporting a stop. |
| [source] | “Daily” resets at an unexpected time | Published wallet/session windows are 86400 **blocks from creation/reset**, lazy at next spend, not midnight UTC or BABE epochs. At ~1 second cadence this approximates a day; chain delays extend elapsed time. Implement a displayed block boundary and an explicit chosen product definition of “daily.” |
| [inference] | Boundary bursts | A fixed-window cap can permit B near the end of one window and B just after the reset in a short elapsed interval. It is not a rolling-24-hour loss bound. The breaker supplies a different short window; it does not fix UTC semantics. |
| [inference] | Rotating or adding sessions multiplies authority | Sum all active `(owner,delegate)` caps and live escrow; do not create new allowances to bypass exhaustion. Revocation/recreation semantics may reset counters; require deliberate owner approval and risk reconciliation. |
| [RPC] | Dust and fees | Native amounts are u128 with 18 decimals, ED 0.01 FLOP. A real wallet transfer's fees are outside its principal counter. API legacy reservation/spend numbers are floating point while exact allocation is a decimal string. |
| [inference] | Rounding/local accounting drift | Parse raw amounts as integer decimal strings/BigInt; convert user decimal budgets exactly, reject >18 fractional digits or round down deliberately. Round quote reservations up only within remaining integer budget, never release an unproven null as zero. Reserve fees separately. Do not use JavaScript Number or SDK defaults based on `Math.round(x*1e18)` as an exact policy serializer. |
| [inference] | Refund/replenishment/delayed settlement crosses a day | Distinguish gross newly committed principal from actual settled service spend, free refunds and prior-day escrow. Track pending commitments; a lifetime balance or a reserved field alone cannot be called today's paid-inference usage. |
| [inference] | Wrapper/nested or deferred call bypass | Do not permit Utility, Proxy, Multisig, Scheduler or broad arbitrary calls in a spend session before recursive filters and deferred-balance effects are audited. A net balance check does not describe future commitments unless every such path is covered. |
| [unknown] | x402 authorizations coexist with sessions/wallets | Confirm aggregate checks and exact canonical signature bytes before issuing authorizations. Replay tombstones bound repeated IDs, not the sum of unlimited distinct signed IDs. Enrollment signatures are not exact-payment signatures. |
| [inference] | Off-chain state is unavailable | Missing receipts, catalog drift, enrollment quota exhaustion and gateway refusal do not authorize raising native caps or silently changing seat identity. Keep reservations conservative and expose unresolved state. |
| [inference] | RPC/indexer lies or lags | Use finalized node reads at a common hash; verify proofs/finality if stronger assurance is needed. Explorer success flags and event text are discovery only. Keep raw bytes and the exact registry used for decode. |

[RPC] RPC-related rows cite [metadata](../evidence/metadata.json), [identity state](../evidence/identity-state.json), [fee trace](../evidence/session-spend-state.json), [code hash](../evidence/runtime-code-hash.json) and [OpenAPI clocks/receipt fields](../evidence/openapi.json). [source] Window rules: [yellowpaper §6.2](https://github.com/flop-labs/yellowpaper/blob/main/yellowpaper.md#62-agent-autonomy--operating-without-per-action-consensus). [source] Float conversion exists in [CLI 0.4.4 lines 978–988](../sources/cli-0.4.4/dist/cli.js); SDK calibrated-session argument construction uses BigInts in [SDK 0.5.2 lines 93–150](../sources/sdk-0.5.2/dist/agent-wallet.js).

### What remains unconfirmed

| Evidence | Unconfirmed point | Why it matters / evidence needed |
|---|---|---|
| [unknown] | Exact FLOP session denied-pallet list, nested-call recursion, filters and failure atomicity | Need public deployed-source commit/Wasm conformance vectors, not metadata descriptions alone. |
| [unknown] | Whether a session may wrap ComputeChannel open/top-up, including locked-principal paths | A cap primitive that cannot reach inference does not implement the requested integration. |
| [unknown] | Gateway allowance → native payer mapping for a specific request | Need supported API fields and a verifiable payment/request binding. No enrollment or inference was performed in this read-only assignment. |
| [unknown] | Whether exact sponsored settlement always consumes wallet/session aggregate budgets | Need code/trace covering facilitator-origin dispatch, payer authority and direct-account bypasses. |
| [unknown] | Lifetime cap/allowlist/expiry replacement, nonce survival, multiple-session selection | Need behavior at revoke/recreate/expiry and delegate with several owners, including implicit wallet charge selection. |
| [unknown] | Actual reset boundary execution, zero-limit validation, expiry inclusivity, rejected-call breaker persistence | Present interface/spec state intent; no write-based boundary testing was allowed. |
| [unknown] | General account-global guard against bypassing AgentWallet | Funding trace shows ordinary free balance and guarded-call accounting, not a lock on every possible dispatch. |
| [unknown] | Fee formula/weights for a hypothetical future wrapped paid inference and hidden minimum AgentIdentity stake | Fees depend on exact extrinsic/runtime state; AgentIdentity minimum is not an exposed constant. No guessed fixed cost is supplied. |
| [unknown] | Universal archive availability or exact sustained block cadence | A block-1 timestamp read succeeded, and snapshot/header timestamps are retained; this does not test all historical state or measure sustained performance. |
| [unknown] | Current availability of new enrollment or restoration of expired allowances | Public contract/issues describe limits; no enrollment was attempted. A 503 observation supplied in the brief remains a lead, not this run's RPC fact. |
| [unknown] | Independent trie/finality verification | Proof nodes were captured but not verified by a separate light-client implementation. |

### Questions for FLOP, prioritized for implementation

1. [unknown] What deployed source commit and reproducible Wasm correspond to spec 1014014 and the code hash captured here? Please publish `pallet_session_keys`, `pallet_agent_wallet`, the runtime proxy filters, SignedExtra, and all spend hooks into ComputeChannel/HasStation/PaidStorage.
2. [unknown] Can `execute_via_session` dispatch `ComputeChannel.open_channel`, `top_up_escrow` and required closing calls? What is the complete hard denylist, does allowlisting use exact metadata pallet names, and how are nested/deferred calls filtered?
3. [unknown] Does hosted wallet enrollment merely issue the documented subsidy/allowance, or can a request debit that wallet? If the latter, publish the exact signer, payer account, extrinsics, storage and request-to-payment commitment. How can an owner bind a bearer credential to `Sessions(S,D)` without disclosing S's full key?
4. [unknown] Is a supported gateway-relay mode planned in which the seat remains the channel payer and all escrow commitments run through its runtime capability? Can the gateway accept an already bounded account/session rather than shared-channel custody?
5. [unknown] Are `settle_sponsored_payment` authorizations subjected to both wallet/session budgets? What exactly is signed, what selects a delegate's session, and can an ordinary direct transfer or ComputeChannel call spend wallet-funded free balance outside those checks?
6. [unknown] Which movements are counted on open, top-up, cooperative/forced settlement, timeout, refund, holds/freezes and locked compute? Are fees included anywhere, and are failed-inner-call counters/nonces reverted? Please provide public amount/rejection vectors.
7. [unknown] What happens to active sessions, nonces, counters and breaker state at expiry/revoke/recreate, zero limit, lower-than-already-spent update and multiple sessions? Does an old `agent_key` retain rights over live channels after native revocation?
8. [unknown] Is the intended product “daily” the documented lazy 86400-block window or a UTC/rolling 24-hour period? Is there any supported owner-wide aggregate daily budget spanning devices, wallet spends, sessions and sponsored payments?
9. [unknown] How is immutable AgentWallet policy changed without changing the seat account, and how can an owner safely recover all funds on compromise given the `owner_withdraw` remaining-budget guard?
10. [unknown] Which non-genesis checkpoint/reset identifier should clients pin to detect a devnet reset that preserves genesis, and what upgrade/reset behavior is guaranteed for existing sessions, exact-payment tombstones and gateway allowances?

### Source and reproducibility notes

[source] Primary artifacts used: [FLOP public docs](https://docs.flop.network/docs/agent-accounts-and-spend-control), [integration guide](https://docs.flop.network/docs/agent-integration), [direct miner guide](https://docs.flop.network/docs/send-to-specific-miner), [yellowpaper](https://github.com/flop-labs/yellowpaper), [public organization repository listing](https://github.com/flop-labs), [network issue #17](https://github.com/flop-labs/network/issues/17) as discovery/context, [gateway OpenAPI](https://api.flop.network/openapi.json), versioned npm packages [SDK 0.5.2](https://registry.npmjs.org/@flop-labs/sdk/-/sdk-0.5.2.tgz) and [CLI 0.4.4](https://registry.npmjs.org/@flop-labs/cli/-/cli-0.4.4.tgz), [zkVerify runtime source](https://github.com/zkVerify/zkVerify/blob/2959b6f56ce2703199c25b405942068f332168c9/runtime/zkverify/src/proxy.rs), and the [earlier report](https://github.com/Identity-md/research/blob/main/jobs/2f111874-d780-4578-80a7-2198c62bf86a/files/artifacts/report.md) solely as a lead before node re-reading.

[source] The SDK/CLI registry records expose their source repository as `flop-labs/flop-core`; the public FLOP organization listing supplied no deployed custom runtime implementation. Package hashes and extracted published files are retained under `sources/` and `evidence/*-package-digest.json`. The advertised versioned packages, not unpinned SDK behavior, support the cited helper signatures. [SDK package metadata](../evidence/sdk-registry.json), [CLI package metadata](../evidence/cli-registry.json), [organization repository list](../evidence/repos.json).

[source] The agent-account page is the whitepaper-derived source consulted; a guessed `/whitepaper` URL returned 404, so no separate whitepaper PDF/text is claimed as reviewed. Saved docs retain their stated update dates. The captured yellowpaper's first line names upstream `flop-core@dfd98a59d`; its public mirror commit is retained in [yellowpaper-commit.json](../evidence/yellowpaper-commit.json). The public engineering-source attribution is not a claim that private source was read.

[inference] Reproduce offline using Python 3 standard library: `python3 scripts/check_evidence.py`, then `python3 scripts/build_report.py`. Online collection scripts are optional, read-only, and their cached requests/responses identify endpoint, method, parameters and retrieval time. `scripts/scale.py` implements a small v14 metadata/state decoder, not a signing client. Verification here establishes internal decoding/hash/arithmetic consistency, not independent authority or runtime rejection safety.

## Appendix A. Related runtime mechanisms: exhaustive metadata inventory

### Balances — pallet 4

[RPC] Native free/reserved/frozen balances and transfers. Interface and descriptions below are read from metadata, not a source audit. [Metadata](../evidence/metadata.json); canonical RPC: `state_getMetadata(H)` at [node](https://rpc.devnet.flop.network).

#### Calls

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `transfer_allow_death` | `dest: sp_runtime::multiaddress::MultiAddress (#72)`; `value: Compact<u128>` | Transfer some liquid free balance to another account.  `transfer_allow_death` will set the `FreeBalance` of the sender and receiver. If the sender's account is below the existential deposit as a result of the transfer, the account will be reaped.  The dispatch origin for this call must be `Signed` by the transactor. |
| [RPC] | 2 | `force_transfer` | `source: sp_runtime::multiaddress::MultiAddress (#72)`; `dest: sp_runtime::multiaddress::MultiAddress (#72)`; `value: Compact<u128>` | Exactly as `transfer_allow_death`, except the origin must be root and the source account may be specified. |
| [RPC] | 3 | `transfer_keep_alive` | `dest: sp_runtime::multiaddress::MultiAddress (#72)`; `value: Compact<u128>` | Same as the [`transfer_allow_death`] call, but with a check that the transfer will not kill the origin account.  99% of the time you want [`transfer_allow_death`] instead.  [`transfer_allow_death`]: struct.Pallet.html#method.transfer |
| [RPC] | 4 | `transfer_all` | `dest: sp_runtime::multiaddress::MultiAddress (#72)`; `keep_alive: bool` | Transfer the entire transferable balance from the caller account.  NOTE: This function only attempts to transfer _transferable_ balances. This means that any locked, reserved, or existential deposits (when `keep_alive` is `true`), will not be transferred by this function. To ensure that this function results in a killed account, you might need to prepare the account by removing any reference counters, storage deposits, etc...  The dispatch origin of this call must be Signed.  - `dest`: The recipient of the transfer. - `keep_alive`: A boolean to determine if the `transfer_all` operation should send all   of the funds the account has, causing the sender account to be killed (false), or   transfer everything except at least the existential deposit, which will guarantee to   keep the sender account alive (true). |
| [RPC] | 5 | `force_unreserve` | `who: sp_runtime::multiaddress::MultiAddress (#72)`; `amount: u128` | Unreserve some balance from a user by force.  Can only be called by ROOT. |
| [RPC] | 6 | `upgrade_accounts` | `who: Vec<sp_core::crypto::AccountId32 (#0)>` | Upgrade a specified account.  - `origin`: Must be `Signed`. - `who`: The account to be upgraded.  This will waive the transaction fee if at least all but 10% of the accounts needed to be upgraded. (We let some not have to be upgraded just in order to allow for the possibility of churn). |
| [RPC] | 8 | `force_set_balance` | `who: sp_runtime::multiaddress::MultiAddress (#72)`; `new_free: Compact<u128>` | Set the regular balance of a given account.  The dispatch origin for this call is `root`. |
| [RPC] | 9 | `force_adjust_total_issuance` | `direction: pallet_balances::types::AdjustmentDirection (#77)`; `delta: Compact<u128>` | Adjust the total issuance in a saturating way.  Can only be called by root and always needs a positive `delta`.  # Example |
| [RPC] | 10 | `burn` | `value: Compact<u128>`; `keep_alive: bool` | Burn the specified liquid free balance from the origin account.  If the origin's account ends up below the existential deposit as a result of the burn and `keep_alive` is false, the account will be reaped.  Unlike sending funds to a _burn_ address, which merely makes the funds inaccessible, this `burn` operation will reduce total issuance by the amount _burned_. |

#### Storage

| Evidence | Storage prefix / item | Modifier | Hashers in key order | Key SCALE type | Stored value SCALE type | Purpose |
|---|---|---|---|---|---|---|
| [RPC] | `Balances.TotalIssuance` | Default | plain | `—` | `u128` | The total units issued in the system. |
| [RPC] | `Balances.InactiveIssuance` | Default | plain | `—` | `u128` | The total units of outstanding deactivated balance in the system. |
| [RPC] | `Balances.Account` | Default | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `pallet_balances::types::AccountData (#5)` | The Balances pallet example of storing the balance of an account.   # Example   ```nocompile   impl pallet_balances::Config for Runtime {     type AccountStore = StorageMapShim<Self::Account<Runtime>, frame_system::Provider<Runtime>, AccountId, Self::AccountData<Balance>>   }  ```   You can also store the balance of an account in the `System` pallet.   # Example   ```nocompile   impl pallet_balances::Config for Runtime {    type AccountStore = System   }  ```   But this comes with tradeoffs, storing account balances in the system pallet stores  `frame_system` data alongside the account data contrary to storing account balances in the  `Balances` pallet, which uses a `StorageMap` to store balances data only.  NOTE: This is only used in the case that this pallet is used to store balances. |
| [RPC] | `Balances.Locks` | Default | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `bounded_collections::weak_bounded_vec::WeakBoundedVec (#494)` | Any liquidity locks on some account balances.  NOTE: Should only be accessed when setting, changing and freeing a lock.   Use of locks is deprecated in favour of freezes. See `https://github.com/paritytech/substrate/pull/12951/` |
| [RPC] | `Balances.Reserves` | Default | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `bounded_collections::bounded_vec::BoundedVec (#498)` | Named reserves on some account balances.   Use of reserves is deprecated in favour of holds. See `https://github.com/paritytech/substrate/pull/12951/` |
| [RPC] | `Balances.Holds` | Default | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `bounded_collections::bounded_vec::BoundedVec (#501)` | Holds on account balances. |
| [RPC] | `Balances.Freezes` | Default | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `bounded_collections::bounded_vec::BoundedVec (#504)` | Freeze locks on account balances. |

#### Events

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `Endowed` | `account: sp_core::crypto::AccountId32 (#0)`; `free_balance: u128` | An account was created with some free balance. |
| [RPC] | 1 | `DustLost` | `account: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | An account was removed whose balance was non-zero but below ExistentialDeposit, resulting in an outright loss. |
| [RPC] | 2 | `Transfer` | `from: sp_core::crypto::AccountId32 (#0)`; `to: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | Transfer succeeded. |
| [RPC] | 3 | `BalanceSet` | `who: sp_core::crypto::AccountId32 (#0)`; `free: u128` | A balance was set by root. |
| [RPC] | 4 | `Reserved` | `who: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | Some balance was reserved (moved from free to reserved). |
| [RPC] | 5 | `Unreserved` | `who: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | Some balance was unreserved (moved from reserved to free). |
| [RPC] | 6 | `ReserveRepatriated` | `from: sp_core::crypto::AccountId32 (#0)`; `to: sp_core::crypto::AccountId32 (#0)`; `amount: u128`; `destination_status: frame_support::traits::tokens::misc::BalanceStatus (#39)` | Some balance was moved from the reserve of the first account to the second account. Final argument indicates the destination balance type. |
| [RPC] | 7 | `Deposit` | `who: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | Some amount was deposited (e.g. for transaction fees). |
| [RPC] | 8 | `Withdraw` | `who: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | Some amount was withdrawn from the account (e.g. for transaction fees). |
| [RPC] | 9 | `Slashed` | `who: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | Some amount was removed from the account (e.g. for misbehavior). |
| [RPC] | 10 | `Minted` | `who: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | Some amount was minted into an account. |
| [RPC] | 11 | `MintedCredit` | `amount: u128` | Some credit was balanced and added to the TotalIssuance. |
| [RPC] | 12 | `Burned` | `who: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | Some amount was burned from an account. |
| [RPC] | 13 | `BurnedDebt` | `amount: u128` | Some debt has been dropped from the Total Issuance. |
| [RPC] | 14 | `Suspended` | `who: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | Some amount was suspended from an account (it can be restored later). |
| [RPC] | 15 | `Restored` | `who: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | Some amount was restored into an account. |
| [RPC] | 16 | `Upgraded` | `who: sp_core::crypto::AccountId32 (#0)` | An account was upgraded. |
| [RPC] | 17 | `Issued` | `amount: u128` | Total issuance was increased by `amount`, creating a credit to be balanced. |
| [RPC] | 18 | `Rescinded` | `amount: u128` | Total issuance was decreased by `amount`, creating a debt to be balanced. |
| [RPC] | 19 | `Locked` | `who: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | Some balance was locked. |
| [RPC] | 20 | `Unlocked` | `who: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | Some balance was unlocked. |
| [RPC] | 21 | `Frozen` | `who: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | Some balance was frozen. |
| [RPC] | 22 | `Thawed` | `who: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | Some balance was thawed. |
| [RPC] | 23 | `TotalIssuanceForced` | `old: u128`; `new: u128` | The `TotalIssuance` was forcefully changed. |
| [RPC] | 24 | `Held` | `reason: zkv_runtime::RuntimeHoldReason (#40)`; `who: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | Some balance was placed on hold. |
| [RPC] | 25 | `BurnedHeld` | `reason: zkv_runtime::RuntimeHoldReason (#40)`; `who: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | Held balance was burned from an account. |
| [RPC] | 26 | `TransferOnHold` | `reason: zkv_runtime::RuntimeHoldReason (#40)`; `source: sp_core::crypto::AccountId32 (#0)`; `dest: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | A transfer of `amount` on hold from `source` to `dest` was initiated. |
| [RPC] | 27 | `TransferAndHold` | `reason: zkv_runtime::RuntimeHoldReason (#40)`; `source: sp_core::crypto::AccountId32 (#0)`; `dest: sp_core::crypto::AccountId32 (#0)`; `transferred: u128` | The `transferred` balance is placed on hold at the `dest` account. |
| [RPC] | 28 | `Released` | `reason: zkv_runtime::RuntimeHoldReason (#40)`; `who: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | Some balance was released from hold. |
| [RPC] | 29 | `Unexpected` | `0: pallet_balances::pallet::UnexpectedKind (#48)` | An unexpected/defensive event was triggered. |

#### Errors

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `VestingBalance` | () | Vesting balance too high to send value. |
| [RPC] | 1 | `LiquidityRestrictions` | () | Account liquidity restrictions prevent withdrawal. |
| [RPC] | 2 | `InsufficientBalance` | () | Balance too low to send value. |
| [RPC] | 3 | `ExistentialDeposit` | () | Value too low to create account due to existential deposit. |
| [RPC] | 4 | `Expendability` | () | Transfer/payment would kill account. |
| [RPC] | 5 | `ExistingVestingSchedule` | () | A vesting schedule already exists for this account. |
| [RPC] | 6 | `DeadAccount` | () | Beneficiary account must pre-exist. |
| [RPC] | 7 | `TooManyReserves` | () | Number of named reserves exceed `MaxReserves`. |
| [RPC] | 8 | `TooManyHolds` | () | Number of holds exceed `VariantCountOf<T::RuntimeHoldReason>`. |
| [RPC] | 9 | `TooManyFreezes` | () | Number of freezes exceed `MaxFreezes`. |
| [RPC] | 10 | `IssuanceDeactivated` | () | The issuance cannot be modified since it is already deactivated. |
| [RPC] | 11 | `DeltaZero` | () | The delta cannot be zero. |

#### Constants

| Evidence | Constant | SCALE type | Decoded value (raw base units unless stated) | Purpose |
|---|---|---|---|---|
| [RPC] | `ExistentialDeposit` | `u128` | `10000000000000000` | The minimum amount required to keep an account open. MUST BE GREATER THAN ZERO!   If you *really* need it to be zero, you can enable the feature `insecure_zero_ed` for  this pallet. However, you do so at your own risk: this will open up a major DoS vector.  In case you have multiple sources of provider references, you may also get unexpected  behaviour if you set this to zero.   Bottom line: Do yourself a favour and make it at least one! |
| [RPC] | `MaxLocks` | `u32` | `50` | The maximum number of locks that should exist on an account.  Not strictly enforced, but used for weight estimation.   Use of locks is deprecated in favour of freezes. See `https://github.com/paritytech/substrate/pull/12951/` |
| [RPC] | `MaxReserves` | `u32` | `50` | The maximum number of named reserves that can exist on an account.   Use of reserves is deprecated in favour of holds. See `https://github.com/paritytech/substrate/pull/12951/` |
| [RPC] | `MaxFreezes` | `u32` | `16` | The maximum number of individual freeze locks that can exist on an account at any time. |

### TransactionPayment — pallet 5

[RPC] Extrinsic fee events and fee multiplier; not an inference budget. Interface and descriptions below are read from metadata, not a source audit. [Metadata](../evidence/metadata.json); canonical RPC: `state_getMetadata(H)` at [node](https://rpc.devnet.flop.network).

#### Calls

[RPC] None exposed.

#### Storage

| Evidence | Storage prefix / item | Modifier | Hashers in key order | Key SCALE type | Stored value SCALE type | Purpose |
|---|---|---|---|---|---|---|
| [RPC] | `TransactionPayment.NextFeeMultiplier` | Default | plain | `—` | `sp_arithmetic::fixed_point::FixedU128 (#514)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `TransactionPayment.StorageVersion` | Default | plain | `—` | `pallet_transaction_payment::Releases (#515)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `TransactionPayment.TxPaymentCredit` | Optional | plain | `—` | `frame_support::traits::storage::NoDrop (#516)` | The `OnChargeTransaction` stores the withdrawn tx fee here.   Use `withdraw_txfee` and `remaining_txfee` to access from outside the crate. |

#### Events

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `TransactionFeePaid` | `who: sp_core::crypto::AccountId32 (#0)`; `actual_fee: u128`; `tip: u128` | A transaction fee `actual_fee`, of which `tip` was added to the minimum inclusion fee, has been paid by `who`. |

#### Errors

[RPC] None exposed.

#### Constants

| Evidence | Constant | SCALE type | Decoded value (raw base units unless stated) | Purpose |
|---|---|---|---|---|
| [RPC] | `OperationalFeeMultiplier` | `u8` | `5` | A fee multiplier for `Operational` extrinsics to compute "virtual tip" to boost their  `priority`   This value is multiplied by the `final_fee` to obtain a "virtual tip" that is later  added to a tip component in regular `priority` calculations.  It means that a `Normal` transaction can front-run a similarly-sized `Operational`  extrinsic (with no tip), by including a tip value greater than the virtual tip.   ```rust,ignore  // For `Normal`  let priority = priority_calc(tip);   // For `Operational`  let virtual_tip = (inclusion_fee + tip) * OperationalFeeMultiplier;  let priority = priority_calc(tip + virtual_tip);  ```   Note that since we use `final_fee` the multiplier applies also to the regular `tip`  sent with the transaction. So, not only does the transaction get a priority bump based  on the `inclusion_fee`, but we also amplify the impact of tips applied to `Operational`  transactions. |

### Scheduler — pallet 1

[RPC] Schedules future dispatches; inspect when reasoning about deferred spending. Interface and descriptions below are read from metadata, not a source audit. [Metadata](../evidence/metadata.json); canonical RPC: `state_getMetadata(H)` at [node](https://rpc.devnet.flop.network).

#### Calls

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `schedule` | `when: u32`; `maybe_periodic: Option (#67)`; `priority: u8`; `call: zkv_runtime::RuntimeCall (#61)` | Anonymously schedule a task. |
| [RPC] | 1 | `cancel` | `when: u32`; `index: u32` | Cancel a scheduled task (named or anonymous), by providing the block it is scheduled for execution in, as well as the index of the task in that block's agenda.  In the case of a named task, it will remove it from the lookup table as well. |
| [RPC] | 2 | `schedule_named` | `id: [u8;32]`; `when: u32`; `maybe_periodic: Option (#67)`; `priority: u8`; `call: zkv_runtime::RuntimeCall (#61)` | Schedule a named task. |
| [RPC] | 3 | `cancel_named` | `id: [u8;32]` | Cancel a named scheduled task. |
| [RPC] | 4 | `schedule_after` | `after: u32`; `maybe_periodic: Option (#67)`; `priority: u8`; `call: zkv_runtime::RuntimeCall (#61)` | Anonymously schedule a task after a delay. |
| [RPC] | 5 | `schedule_named_after` | `id: [u8;32]`; `after: u32`; `maybe_periodic: Option (#67)`; `priority: u8`; `call: zkv_runtime::RuntimeCall (#61)` | Schedule a named task after a delay. |
| [RPC] | 6 | `set_retry` | `task: (u32, u32)`; `retries: u8`; `period: u32` | Set a retry configuration for a task so that, in case its scheduled run fails, it will be retried after `period` blocks, for a total amount of `retries` retries or until it succeeds.  Tasks which need to be scheduled for a retry are still subject to weight metering and agenda space, same as a regular task. If a periodic task fails, it will be scheduled normally while the task is retrying.  Tasks scheduled as a result of a retry for a periodic task are unnamed, non-periodic clones of the original task. Their retry configuration will be derived from the original task's configuration, but will have a lower value for `remaining` than the original `total_retries`.  This call **cannot** be used to set a retry configuration for a named task. |
| [RPC] | 7 | `set_retry_named` | `id: [u8;32]`; `retries: u8`; `period: u32` | Set a retry configuration for a named task so that, in case its scheduled run fails, it will be retried after `period` blocks, for a total amount of `retries` retries or until it succeeds.  Tasks which need to be scheduled for a retry are still subject to weight metering and agenda space, same as a regular task. If a periodic task fails, it will be scheduled normally while the task is retrying.  Tasks scheduled as a result of a retry for a periodic task are unnamed, non-periodic clones of the original task. Their retry configuration will be derived from the original task's configuration, but will have a lower value for `remaining` than the original `total_retries`.  This is the only way to set a retry configuration for a named task. |
| [RPC] | 8 | `cancel_retry` | `task: (u32, u32)` | Removes the retry configuration of a task. |
| [RPC] | 9 | `cancel_retry_named` | `id: [u8;32]` | Cancel the retry configuration of a named task. |

#### Storage

| Evidence | Storage prefix / item | Modifier | Hashers in key order | Key SCALE type | Stored value SCALE type | Purpose |
|---|---|---|---|---|---|---|
| [RPC] | `Scheduler.IncompleteSince` | Optional | plain | `—` | `u32` | Block number at which the agenda began incomplete execution. |
| [RPC] | `Scheduler.Agenda` | Default | Twox64Concat | `u32` | `bounded_collections::bounded_vec::BoundedVec (#478)` | Items to be executed, indexed by the block number that they should be executed on. |
| [RPC] | `Scheduler.Retries` | Optional | Blake2_128Concat | `(u32, u32)` | `pallet_scheduler::RetryConfig (#482)` | Retry configurations for items to be executed, indexed by task address. |
| [RPC] | `Scheduler.Lookup` | Optional | Twox64Concat | `[u8;32]` | `(u32, u32)` | Lookup from a name to the block number and index of the task.   For v3 -> v4 the previously unbounded identities are Blake2-256 hashed to form the v4  identities. |

#### Events

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `Scheduled` | `when: u32`; `index: u32` | Scheduled some task. |
| [RPC] | 1 | `Canceled` | `when: u32`; `index: u32` | Canceled some task. |
| [RPC] | 2 | `Dispatched` | `task: (u32, u32)`; `id: Option (#34)`; `result: Result (#35)` | Dispatched some task. |
| [RPC] | 3 | `RetrySet` | `task: (u32, u32)`; `id: Option (#34)`; `period: u32`; `retries: u8` | Set a retry configuration for some task. |
| [RPC] | 4 | `RetryCancelled` | `task: (u32, u32)`; `id: Option (#34)` | Cancel a retry configuration for some task. |
| [RPC] | 5 | `CallUnavailable` | `task: (u32, u32)`; `id: Option (#34)` | The call for the provided hash was not found so the task has been aborted. |
| [RPC] | 6 | `PeriodicFailed` | `task: (u32, u32)`; `id: Option (#34)` | The given task was unable to be renewed since the agenda is full at that block. |
| [RPC] | 7 | `RetryFailed` | `task: (u32, u32)`; `id: Option (#34)` | The given task was unable to be retried since the agenda is full at that block or there was not enough weight to reschedule it. |
| [RPC] | 8 | `PermanentlyOverweight` | `task: (u32, u32)`; `id: Option (#34)` | The given task can never be executed since it is overweight. |
| [RPC] | 9 | `AgendaIncomplete` | `when: u32` | Agenda is incomplete from `when`. |

#### Errors

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `FailedToSchedule` | () | Failed to schedule a call |
| [RPC] | 1 | `NotFound` | () | Cannot find the scheduled call. |
| [RPC] | 2 | `TargetBlockNumberInPast` | () | Given target block number is in the past. |
| [RPC] | 3 | `RescheduleNoChange` | () | Reschedule failed because it does not change scheduled time. |
| [RPC] | 4 | `Named` | () | Attempt to use a non-named function on a named task. |

#### Constants

| Evidence | Constant | SCALE type | Decoded value (raw base units unless stated) | Purpose |
|---|---|---|---|---|
| [RPC] | `MaximumWeight` | `sp_weights::weight_v2::Weight (#10)` | `{"ref_time":600000000000,"proof_size":14757395258967641292}` | The maximum weight that may be scheduled per block for any dispatchables. |
| [RPC] | `MaxScheduledPerBlock` | `u32` | `50` | The maximum number of scheduled calls in the queue for a single block.   NOTE:  + Dependent pallets' benchmarks might require a higher limit for the setting. Set a  higher limit under `runtime-benchmarks` feature. |

### Vesting — pallet 51

[RPC] Time-based balance locks, not a daily inference cap. Interface and descriptions below are read from metadata, not a source audit. [Metadata](../evidence/metadata.json); canonical RPC: `state_getMetadata(H)` at [node](https://rpc.devnet.flop.network).

#### Calls

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `vest` | () | Unlock any vested funds of the sender account.  The dispatch origin for this call must be _Signed_ and the sender must have funds still locked under this pallet.  Emits either `VestingCompleted` or `VestingUpdated`.  ## Complexity - `O(1)`. |
| [RPC] | 1 | `vest_other` | `target: sp_runtime::multiaddress::MultiAddress (#72)` | Unlock any vested funds of a `target` account.  The dispatch origin for this call must be _Signed_.  - `target`: The account whose vested funds should be unlocked. Must have funds still locked under this pallet.  Emits either `VestingCompleted` or `VestingUpdated`.  ## Complexity - `O(1)`. |
| [RPC] | 2 | `vested_transfer` | `target: sp_runtime::multiaddress::MultiAddress (#72)`; `schedule: pallet_vesting::vesting_info::VestingInfo (#159)` | Create a vested transfer.  The dispatch origin for this call must be _Signed_.  - `target`: The account receiving the vested funds. - `schedule`: The vesting schedule attached to the transfer.  Emits `VestingCreated`.  NOTE: This will unlock all schedules through the current block.  ## Complexity - `O(1)`. |
| [RPC] | 3 | `force_vested_transfer` | `source: sp_runtime::multiaddress::MultiAddress (#72)`; `target: sp_runtime::multiaddress::MultiAddress (#72)`; `schedule: pallet_vesting::vesting_info::VestingInfo (#159)` | Force a vested transfer.  The dispatch origin for this call must be _Root_.  - `source`: The account whose funds should be transferred. - `target`: The account that should be transferred the vested funds. - `schedule`: The vesting schedule attached to the transfer.  Emits `VestingCreated`.  NOTE: This will unlock all schedules through the current block.  ## Complexity - `O(1)`. |
| [RPC] | 4 | `merge_schedules` | `schedule1_index: u32`; `schedule2_index: u32` | Merge two vesting schedules together, creating a new vesting schedule that unlocks over the highest possible start and end blocks. If both schedules have already started the current block will be used as the schedule start; with the caveat that if one schedule is finished by the current block, the other will be treated as the new merged schedule, unmodified.  NOTE: If `schedule1_index == schedule2_index` this is a no-op. NOTE: This will unlock all schedules through the current block prior to merging. NOTE: If both schedules have ended by the current block, no new schedule will be created and both will be removed.  Merged schedule attributes: - `starting_block`: `MAX(schedule1.starting_block, scheduled2.starting_block,   current_block)`. - `ending_block`: `MAX(schedule1.ending_block, schedule2.ending_block)`. - `locked`: `schedule1.locked_at(current_block) + schedule2.locked_at(current_block)`.  The dispatch origin for this call must be _Signed_.  - `schedule1_index`: index of the first schedule to merge. - `schedule2_index`: index of the second schedule to merge. |
| [RPC] | 5 | `force_remove_vesting_schedule` | `target: sp_runtime::multiaddress::MultiAddress (#72)`; `schedule_index: u32` | Force remove a vesting schedule  The dispatch origin for this call must be _Root_.  - `target`: An account that has a vesting schedule - `schedule_index`: The vesting schedule index that should be removed |

#### Storage

| Evidence | Storage prefix / item | Modifier | Hashers in key order | Key SCALE type | Stored value SCALE type | Purpose |
|---|---|---|---|---|---|---|
| [RPC] | `Vesting.Vesting` | Optional | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `bounded_collections::bounded_vec::BoundedVec (#621)` | Information regarding the vesting of a given account. |
| [RPC] | `Vesting.StorageVersion` | Default | plain | `—` | `pallet_vesting::Releases (#623)` | Storage version of the pallet.   New networks start with latest version, as determined by the genesis build. |

#### Events

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `VestingCreated` | `account: sp_core::crypto::AccountId32 (#0)`; `schedule_index: u32` | A vesting schedule has been created. |
| [RPC] | 1 | `VestingUpdated` | `account: sp_core::crypto::AccountId32 (#0)`; `unvested: u128` | The amount vested has been updated. This could indicate a change in funds available. The balance given is the amount which is left unvested (and thus locked). |
| [RPC] | 2 | `VestingCompleted` | `account: sp_core::crypto::AccountId32 (#0)` | An \[account\] has become fully vested. |

#### Errors

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `NotVesting` | () | The account given is not vesting. |
| [RPC] | 1 | `AtMaxVestingSchedules` | () | The account already has `MaxVestingSchedules` count of schedules and thus cannot add another one. Consider merging existing schedules in order to add another. |
| [RPC] | 2 | `AmountLow` | () | Amount being transferred is too low to create a vesting schedule. |
| [RPC] | 3 | `ScheduleIndexOutOfBounds` | () | An index was out of bounds of the vesting schedules. |
| [RPC] | 4 | `InvalidScheduleParams` | () | Failed to create a new schedule because some parameter was invalid. |

#### Constants

| Evidence | Constant | SCALE type | Decoded value (raw base units unless stated) | Purpose |
|---|---|---|---|---|
| [RPC] | `MinVestedTransfer` | `u128` | `1000000000000000000` | The minimum amount transferred to call `vested_transfer`. |
| [RPC] | `MaxVestingSchedules` | `u32` | `28` | No description in metadata; execution semantics unknown beyond the encoded interface. |

### HasStation — pallet 85

[RPC] HTLCs and condition-controlled escrow, including controller remaining balances. Interface and descriptions below are read from metadata, not a source audit. [Metadata](../evidence/metadata.json); canonical RPC: `state_getMetadata(H)` at [node](https://rpc.devnet.flop.network).

#### Calls

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 18 | `create_near_htlc` | `agent: bounded_collections::bounded_vec::BoundedVec (#178)`; `task: pallet_has_station::pallet::ComputeTask (#179)`; `hash_lock: primitive_types::H256 (#13)`; `reward_amount: u128`; `timeout_blocks: u32`; `near_recipient: bounded_collections::bounded_vec::BoundedVec (#178)`; `near_amount: u64`; `near_timeout_seconds: u32` | Open a NEAR swap using the contract's timeout_seconds, not BTC hours. Zero BTC hours identifies this metadata as NEAR without changing its encoding. |
| [RPC] | 0 | `create_htlc` | `agent: bounded_collections::bounded_vec::BoundedVec (#178)`; `task: pallet_has_station::pallet::ComputeTask (#179)`; `hash_lock: primitive_types::H256 (#13)`; `reward_amount: u128`; `timeout_blocks: u32` | Create a standard HTLC for AI compute task settlement. Locks `reward_amount` FLOP from the caller's account. |
| [RPC] | 1 | `redeem_htlc` | `htlc_id: primitive_types::H256 (#13)`; `pre_image: bounded_collections::bounded_vec::BoundedVec (#180)`; `tee_quote: pallet_has_station::pallet::TeeQuote (#182)` | Redeem an HTLC by revealing the preimage (standard flow). |
| [RPC] | 2 | `refund_htlc` | `htlc_id: primitive_types::H256 (#13)` | Refund an HTLC after the timelock expires. |
| [RPC] | 3 | `check_htlc_status` | `hash_lock: primitive_types::H256 (#13)` | Check HTLC status (query extrinsic). |
| [RPC] | 4 | `create_cross_chain_htlc` | `agent: bounded_collections::bounded_vec::BoundedVec (#178)`; `task: pallet_has_station::pallet::ComputeTask (#179)`; `hash_lock: primitive_types::H256 (#13)`; `reward_amount: u128`; `timeout_blocks: u32`; `btc_address: bounded_collections::bounded_vec::BoundedVec (#178)`; `btc_amount_sats: u64`; `btc_timelock_hours: u32` | Create a cross-chain HTLC for a FLOP ↔ BTC atomic swap.  This is step 1 of the 5-step cross-chain handshake (PROTOCOL_SPEC 5.2): the agent locks FLOP with a 2-hour timelock and attaches BTC metadata so the counterparty knows where to lock BTC.  CRIT-01 Phase 1: Validates timelock symmetry with 20% safety margin. |
| [RPC] | 5 | `relay_preimage` | `hash_lock: primitive_types::H256 (#13)`; `pre_image: bounded_collections::bounded_vec::BoundedVec (#180)`; `btc_txid: Option (#185)` | Relay a preimage observed on the Bitcoin network to auto-settle the FLOP-side HTLC.  This is step 5 of the cross-chain handshake: a registered relayer detects the preimage reveal on BTC and submits it here to settle the FLOP HTLC on behalf of the buyer. |
| [RPC] | 6 | `update_chain_divergence_extrinsic` | `expected_btc_blocks: u64`; `actual_btc_blocks: u64` | Update chain divergence metrics (oracle/relayer only).  CRIT-01 Remediation (Phase 1): Called by BTC relayer or oracle to monitor Bitcoin block time variance and trigger circuit breaker if needed.  # Arguments * `expected_btc_blocks` - Expected BTC blocks at 10min/block rate * `actual_btc_blocks` - Actual BTC blocks observed |
| [RPC] | 7 | `register_relayer` | `relayer: sp_core::crypto::AccountId32 (#0)` | Register a BTC relayer account (root only). |
| [RPC] | 8 | `unregister_relayer` | `relayer: sp_core::crypto::AccountId32 (#0)` | Unregister a BTC relayer account (root only). |
| [RPC] | 9 | `create_htlc_commit` | `hash_commitment: primitive_types::H256 (#13)`; `timeout_blocks: u32`; `btc_timeout_blocks: Option (#93)` | Create an HTLC commitment (commit phase of commit-reveal).  The caller submits a hash commitment computed as:   commitment = SHA256(preimage \|\| salt \|\| miner_account_encoded)  This locks the commitment on-chain without revealing the preimage. The actual preimage is revealed later via `reveal_htlc`.  SPEC-013: This enables timelock symmetry — the FLOP-side timelock must exceed the BTC-side timelock by at least `TimelockSymmetrySafetyMargin` blocks (144 BTC blocks ≈ 24 hours). |
| [RPC] | 10 | `reveal_htlc` | `hash_commitment: primitive_types::H256 (#13)`; `preimage: bounded_collections::bounded_vec::BoundedVec (#180)`; `salt: bounded_collections::bounded_vec::BoundedVec (#180)`; `miner: sp_core::crypto::AccountId32 (#0)` | Reveal the preimage for a previously created HTLC commitment.  The caller provides the preimage, salt, and miner account. The pallet verifies that SHA256(preimage \|\| salt \|\| miner_account) == hash_commitment.  On success, the commitment is marked as revealed and the preimage is stored on-chain for auditing. |
| [RPC] | 11 | `cancel_expired_commit` | `hash_commitment: primitive_types::H256 (#13)` | Cancel an expired commit-reveal commitment.  Anyone can call this after the commit's expiry block has passed. |
| [RPC] | 12 | `open_escrow` | `payee: sp_core::crypto::AccountId32 (#0)`; `amount: u128`; `policy: pallet_has_station::pallet::Policy (#187)`; `deadline_blocks: u32` | Open a conditional escrow: reserve `amount` from the caller, payable to `payee` once `policy` is satisfied, or refundable to the caller after `deadline_blocks`. An HTLC is `policy = And[Hash(h)]`. |
| [RPC] | 13 | `approve_escrow` | `escrow_id: primitive_types::H256 (#13)` | Approve an escrow, satisfying a `Sig(caller)` leaf in its policy. Idempotent. Rejects callers not referenced by any `Sig` leaf so the approval set stays bounded by the policy (≤ `MAX_POLICY_CLAUSES`) and can't be grown by strangers. |
| [RPC] | 14 | `satisfy_escrow` | `escrow_id: primitive_types::H256 (#13)`; `preimages: bounded_collections::bounded_vec::BoundedVec (#192)` | Release an escrow to its payee if `policy` is satisfied by the supplied `preimages` (for `Hash` leaves and the scalar witness of `Point` (PTLC) leaves) plus recorded approvals (for `Sig` leaves) and the finalized head (for `Before`/`After` leaves). Anyone may submit.  The `deadline` is an authoritative boundary on the FINALIZED head: release is only possible *before* it, refund only *at/after* it. The two windows are complementary (no overlap, no gap), so the timeout fails closed — a payee cannot win funds once the funder is entitled to refund. An HTLC is therefore the policy `And[Hash(h)]` redeemable until `deadline`. |
| [RPC] | 15 | `refund_escrow` | `escrow_id: primitive_types::H256 (#13)` | Refund an open escrow to its funder once the deadline has passed on the FINALIZED head (reorg-safe, mirroring `refund_htlc`). Funder-only. |
| [RPC] | 16 | `create_htlc_for_work` | `agent: bounded_collections::bounded_vec::BoundedVec (#178)`; `task: pallet_has_station::pallet::ComputeTask (#179)`; `hash_lock: primitive_types::H256 (#13)`; `reward_amount: u128`; `timeout_blocks: u32`; `task_hash: primitive_types::H256 (#13)`; `output_commitment: primitive_types::H256 (#13)` | Open a standard HTLC and bind offchain task/output commitments to it. The commitments do not change the hashlock payout predicate. |
| [RPC] | 17 | `redeem_htlc_with_receipt` | `htlc_id: primitive_types::H256 (#13)`; `pre_image: bounded_collections::bounded_vec::BoundedVec (#180)`; `tee_quote: pallet_has_station::pallet::TeeQuote (#182)`; `receipt_hash: primitive_types::H256 (#13)`; `verifier_ref: Option (#102)` | Redeem a work HTLC and publish a receipt reference. This records a claimant-supplied receipt, not verifier acceptance of the work. |

#### Storage

| Evidence | Storage prefix / item | Modifier | Hashers in key order | Key SCALE type | Stored value SCALE type | Purpose |
|---|---|---|---|---|---|---|
| [RPC] | `HasStation.HtlcsByHashLock` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `pallet_has_station::pallet::HtlcRecord (#659)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `HasStation.HtlcWorkCommitments` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `(primitive_types::H256 (#13), primitive_types::H256 (#13))` | Commitments for HTLCs explicitly opened for offchain work. Kept separate  so existing HtlcRecord values retain their SCALE encoding. |
| [RPC] | `HasStation.HashLockById` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `primitive_types::H256 (#13)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `HasStation.HtlcCounter` | Default | plain | `—` | `u64` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `HasStation.CrossChainMeta` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `pallet_has_station::pallet::BtcSwapMeta (#663)` | Cross-chain BTC metadata for HTLCs that are part of an atomic swap. |
| [RPC] | `HasStation.RegisteredRelayers` | Optional | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `()` | Registered BTC relayer accounts authorized to auto-settle cross-chain HTLCs. |
| [RPC] | `HasStation.HtlcCreators` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `sp_core::crypto::AccountId32 (#0)` | Creator account for each HTLC (tracks who locked tokens). |
| [RPC] | `HasStation.RelayerCount` | Default | plain | `—` | `u32` | Number of registered relayers. |
| [RPC] | `HasStation.SettlementPaused` | Default | plain | `—` | `bool` | Circuit breaker: Pauses HTLC settlements during extreme chain divergence.  Set to true when Bitcoin block time variance exceeds 20% from expected. |
| [RPC] | `HasStation.ChainDivergencePct` | Default | plain | `—` | `u32` | Current chain divergence percentage (BTC block time variance from expected).  Updated by oracle or relayer monitoring. |
| [RPC] | `HasStation.LastCircuitBreakTrigger` | Optional | plain | `—` | `u32` | Block when circuit breaker was last triggered (for monitoring). |
| [RPC] | `HasStation.PendingCommits` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `pallet_has_station::pallet::CommitRecord (#664)` | Pending commit-reveal commitments (SPEC-013).   Maps a hash commitment → CommitRecord. The miner first calls  `create_htlc_commit` to lock a commitment on-chain, then later  calls `reveal_htlc` to reveal the preimage and settle. |
| [RPC] | `HasStation.Escrows` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `pallet_has_station::pallet::EscrowRecord (#665)` | All open/closed escrows by id (generalized conditional escrow, T2). |
| [RPC] | `HasStation.EscrowCounter` | Default | plain | `—` | `u64` | Monotonic counter for deriving escrow ids. |
| [RPC] | `HasStation.EscrowApprovals` | Optional | Blake2_128Concat, Blake2_128Concat | `(primitive_types::H256 (#13), sp_core::crypto::AccountId32 (#0))` | `()` | Per-escrow approvals: `(escrow_id, account) -> ()`. Drives the `Sig` leaf and  k-of-n thresholds without an on-chain signature scheme — an account "signs" by  submitting an `approve_escrow` extrinsic. |
| [RPC] | `HasStation.ControlledEscrowControllers` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `sp_core::crypto::AccountId32 (#0)` | Controller authorized to release a Policy escrow incrementally or split its  remainder at terminal settlement. Kept beside `Escrows` so the existing  `EscrowRecord` SCALE shape remains unchanged. |
| [RPC] | `HasStation.ControlledEscrowRemaining` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `u128` | Reserved principal still locked for a controlled escrow. |

#### Events

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `HtlcCreated` | `htlc_id: primitive_types::H256 (#13)`; `hash_lock: primitive_types::H256 (#13)`; `agent: Vec<u8>`; `reward_amount: u128`; `timeout_block: u32` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 1 | `HtlcRedeemed` | `htlc_id: primitive_types::H256 (#13)`; `hash_lock: primitive_types::H256 (#13)`; `miner: Vec<u8>`; `gn_used: u64`; `quote_digest: Option (#102)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 2 | `HtlcRefunded` | `htlc_id: primitive_types::H256 (#13)`; `hash_lock: primitive_types::H256 (#13)`; `agent: Vec<u8>` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 3 | `CrossChainHtlcCreated` | `htlc_id: primitive_types::H256 (#13)`; `hash_lock: primitive_types::H256 (#13)`; `btc_amount_sats: u64`; `flop_reward_amount: u128` | A cross-chain HTLC was created with BTC metadata. |
| [RPC] | 4 | `PreimageRelayed` | `htlc_id: primitive_types::H256 (#13)`; `hash_lock: primitive_types::H256 (#13)`; `relayer: sp_core::crypto::AccountId32 (#0)` | A relayer auto-settled an HTLC using a preimage observed on BTC. |
| [RPC] | 5 | `RelayerRegistered` | `relayer: sp_core::crypto::AccountId32 (#0)` | A BTC relayer was registered. |
| [RPC] | 6 | `RelayerUnregistered` | `relayer: sp_core::crypto::AccountId32 (#0)` | A BTC relayer was unregistered. |
| [RPC] | 7 | `HtlcCommitCreated` | `hash_commitment: primitive_types::H256 (#13)`; `committer: sp_core::crypto::AccountId32 (#0)`; `expiry_block: u32` | A commit-reveal HTLC commitment was created (SPEC-013). |
| [RPC] | 8 | `HtlcRevealed` | `hash_commitment: primitive_types::H256 (#13)`; `committer: sp_core::crypto::AccountId32 (#0)`; `preimage: Vec<u8>` | A commit-reveal HTLC was revealed and settled (SPEC-013). |
| [RPC] | 9 | `CommitExpired` | `hash_commitment: primitive_types::H256 (#13)` | A pending commit expired and was cancelled. |
| [RPC] | 10 | `CircuitBreakerTriggered` | `divergence_pct: u32`; `block: u32` | Circuit breaker triggered due to chain divergence. |
| [RPC] | 11 | `SettlementResumed` | `block: u32` | Settlement resumed after chain divergence normalized. |
| [RPC] | 12 | `ChainDivergenceUpdated` | `divergence_pct: u32`; `expected_btc_blocks: u64`; `actual_btc_blocks: u64` | Chain divergence updated by oracle/relayer. |
| [RPC] | 13 | `EscrowOpened` | `escrow_id: primitive_types::H256 (#13)`; `funder: sp_core::crypto::AccountId32 (#0)`; `payee: sp_core::crypto::AccountId32 (#0)`; `amount: u128`; `deadline: u32` | A conditional escrow was opened (T2). |
| [RPC] | 14 | `EscrowApproved` | `escrow_id: primitive_types::H256 (#13)`; `approver: sp_core::crypto::AccountId32 (#0)` | An account approved an escrow (satisfies a `Sig` leaf). |
| [RPC] | 15 | `EscrowReleased` | `escrow_id: primitive_types::H256 (#13)`; `payee: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | An escrow's policy was satisfied and the funds were released to the payee. |
| [RPC] | 16 | `PointWitnessRevealed` | `escrow_id: primitive_types::H256 (#13)`; `statement: [u8;33]`; `witness: [u8;32]` | A PTLC point-lock leaf was satisfied: the scalar witness `y` for statement `Y` was revealed on-chain. Emitted once per matched `Point` leaf so a cross-chain relayer (or the indexer) can extract `y` and complete the adjacent leg of a multi-hop / atomic swap. `statement` and `witness` are the SEC1 33-byte point and the 32-byte big-endian scalar respectively. |
| [RPC] | 17 | `EscrowRefunded` | `escrow_id: primitive_types::H256 (#13)`; `funder: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | An escrow was refunded to the funder after its deadline. |
| [RPC] | 18 | `ControlledEscrowReleased` | `escrow_id: primitive_types::H256 (#13)`; `amount: u128`; `remaining: u128` | A controller released delivered-value collateral back to its funder. |
| [RPC] | 19 | `ControlledEscrowSettled` | `escrow_id: primitive_types::H256 (#13)`; `released_to_funder: u128`; `paid_out: u128` | A controller atomically distributed all remaining collateral. |
| [RPC] | 20 | `HtlcWorkCreated` | `htlc_id: primitive_types::H256 (#13)`; `hash_lock: primitive_types::H256 (#13)`; `task_hash: primitive_types::H256 (#13)`; `output_commitment: primitive_types::H256 (#13)` | Commitments supplied by the payer; neither hash verifies the work. |
| [RPC] | 21 | `HtlcWorkClaimed` | `htlc_id: primitive_types::H256 (#13)`; `hash_lock: primitive_types::H256 (#13)`; `receipt_hash: primitive_types::H256 (#13)`; `verifier_ref: Option (#102)` | Claim metadata only. A verifier reference is not verifier acceptance. |
| [RPC] | 22 | `HtlcTimeoutBurned` | `htlc_id: primitive_types::H256 (#13)`; `amount: u128` | Part of a post-timeout resolution was destroyed before payout. |

#### Errors

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `InsufficientBalance` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 1 | `InvalidHashLock` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 2 | `InvalidRewardAmount` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 3 | `HtlcNotFound` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 4 | `InvalidPreImage` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 5 | `InvalidTeeQuote` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 6 | `AlreadyRedeemed` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 7 | `AlreadySettled` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 8 | `TimeoutNotReached` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 9 | `NotARelayer` | () | Caller is not a registered relayer. |
| [RPC] | 10 | `NotTheAgent` | () | Caller is not the original agent/creator of this HTLC. |
| [RPC] | 11 | `RelayerAlreadyRegistered` | () | Relayer is already registered. |
| [RPC] | 12 | `TooManyRelayers` | () | Maximum number of relayers reached. |
| [RPC] | 13 | `NotCrossChainHtlc` | () | No cross-chain metadata for this HTLC. |
| [RPC] | 14 | `CommitAlreadyExists` | () | Commit already exists for this hash commitment. |
| [RPC] | 15 | `CommitNotFound` | () | No pending commit found for this hash commitment. |
| [RPC] | 16 | `CommitAlreadyRevealed` | () | Commit has already been revealed. |
| [RPC] | 17 | `CommitExpired` | () | Commit has expired. |
| [RPC] | 18 | `TimelockSymmetryViolation` | () | Timelock symmetry violation: FLOP timeout must exceed BTC timeout by at least 20%. |
| [RPC] | 19 | `FinalitySafeMode` | () | New finality-clocked locks are disabled until finality lag recovers. |
| [RPC] | 20 | `PreimageMismatch` | () | Preimage does not match the hash commitment. |
| [RPC] | 21 | `NotTheCommitter` | () | Only the original committer can cancel a commit. |
| [RPC] | 22 | `SettlementPaused` | () | Settlement is paused due to chain divergence (circuit breaker). |
| [RPC] | 23 | `ChainDivergenceTooHigh` | () | Chain divergence exceeds safe threshold (20%). |
| [RPC] | 24 | `EscrowNotFound` | () | Escrow not found for the given id. |
| [RPC] | 25 | `EscrowNotOpen` | () | Escrow is not in the `Open` state (already released or refunded). |
| [RPC] | 26 | `PolicyNotSatisfied` | () | The release policy was not satisfied by the supplied witness. |
| [RPC] | 27 | `DeadlineNotReached` | () | Refund attempted before the escrow's deadline (finalized head). |
| [RPC] | 28 | `NotTheFunder` | () | Only the funder may refund an escrow. |
| [RPC] | 29 | `InvalidPolicy` | () | Policy has no clauses, or a `Threshold(k)` with `k` out of `1..=clauses`. |
| [RPC] | 30 | `InvalidEscrowAmount` | () | Escrow amount must be non-zero. |
| [RPC] | 31 | `EscrowExpired` | () | Release attempted at/after the escrow's deadline — the funder may now refund. |
| [RPC] | 32 | `NotAnApprover` | () | Caller is not referenced by any `Sig` leaf in the escrow's policy. |
| [RPC] | 33 | `InvalidPointStatement` | () | A `Point` leaf carries a statement that is not a valid SEC1-compressed secp256k1 point (bad prefix byte or off-curve). Rejected at open-time so `evaluate_policy` never has to reason about an unsatisfiable lock. |
| [RPC] | 34 | `NotEscrowController` | () | Caller does not match the controller bound to this escrow. |
| [RPC] | 35 | `EscrowAccountingMismatch` | () | A partial release or terminal split does not conserve locked principal. |
| [RPC] | 36 | `InvalidHtlcBurnShare` | () | The configured HTLC burn share exceeds 1000 parts per thousand. |
| [RPC] | 37 | `WorkCommitmentNotFound` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |

#### Constants

| Evidence | Constant | SCALE type | Decoded value (raw base units unless stated) | Purpose |
|---|---|---|---|---|
| [RPC] | `MaxRelayers` | `u32` | `20` | Maximum number of registered relayers. |
| [RPC] | `HtlcBurnShare` | `u32` | `0` | Share of a finalized post-timeout resolution burned, in parts per thousand.  Zero preserves the existing payout until a runtime upgrade arms the lever. |
| [RPC] | `TimelockSymmetrySafetyMargin` | `u32` | `20` | Safety margin for timelock symmetry: FLOP timeout must exceed  BTC timeout by at least this percentage (spec: 20% safety margin).  This accounts for Bitcoin block time variance (avg 10min, can vary 5-20min). |
| [RPC] | `BtcBlockTimeInFlopBlocks` | `u32` | `600` | Number of one-second FLOP blocks in one average Bitcoin block. |
| [RPC] | `FinalityFreezeThreshold` | `u32` | `120` | Reject new finality-clocked locks once best-minus-finalized reaches this lag. |
| [RPC] | `MaxFinalityStall` | `u32` | `3600` | Recovery allowance added to foreign-chain timelock margins. |

### WorkVesting — pallet 88

[RPC] Work-conditioned grants; protocol grant policy, not an owner-selected daily inference cap. Interface and descriptions below are read from metadata, not a source audit. [Metadata](../evidence/metadata.json); canonical RPC: `state_getMetadata(H)` at [node](https://rpc.devnet.flop.network).

#### Calls

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `create_grant` | `miner: sp_core::crypto::AccountId32 (#0)`; `amount: u128` | Create an ignition grant for a miner.  Requires the miner's calibration to be complete (B_p finalized). Mints `amount` tokens to the miner and freezes them. |
| [RPC] | 1 | `claim_unlocked` | () | Claim unlocked tokens based on last epoch's performance.  Computes the unlock amount from `(LastEpochGn / B_p)^2` applied to the currently frozen balance, then reduces the freeze. |
| [RPC] | 2 | `force_revoke_grant` | `miner: sp_core::crypto::AccountId32 (#0)` | Force-revoke a miner's grant (root only / governance).  Thaws frozen tokens and transfers them to the Treasury. |
| [RPC] | 3 | `force_create_grant` | `miner: sp_core::crypto::AccountId32 (#0)`; `amount: u128`; `pledge_baseline: u64` | Create a grant bypassing calibration check (root only, for testing). |

#### Storage

| Evidence | Storage prefix / item | Modifier | Hashers in key order | Key SCALE type | Stored value SCALE type | Purpose |
|---|---|---|---|---|---|---|
| [RPC] | `WorkVesting.Escrows` | Optional | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `pallet_work_vesting::pallet::EscrowInfo (#675)` | Per-miner escrow state. |
| [RPC] | `WorkVesting.CurrentEpochGn` | Default | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `u64` | G_n accumulated by each miner in the current epoch. |
| [RPC] | `WorkVesting.LastEpochGn` | Default | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `u64` | G_n from the last completed epoch (used for unlock calculation). |
| [RPC] | `WorkVesting.EpochStartBlock` | Default | plain | `—` | `u32` | Block number when the current epoch started. |
| [RPC] | `WorkVesting.BlackoutCounter` | Default | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `u32` | Consecutive failing epochs per miner (for blackout tracking). |
| [RPC] | `WorkVesting.ActiveMiners` | Default | plain | `—` | `bounded_collections::bounded_vec::BoundedVec (#676)` | Set of miners with active (non-revoked) escrows. |
| [RPC] | `WorkVesting.TotalEscrowed` | Default | plain | `—` | `u128` | Total tokens currently frozen across all escrows. |

#### Events

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `GrantCreated` | `miner: sp_core::crypto::AccountId32 (#0)`; `amount: u128`; `pledge_baseline: u64` | An ignition grant was created for a miner. |
| [RPC] | 1 | `TokensUnlocked` | `miner: sp_core::crypto::AccountId32 (#0)`; `amount: u128`; `remaining_frozen: u128` | Tokens were unlocked and released from escrow. |
| [RPC] | 2 | `GrantFullyVested` | `miner: sp_core::crypto::AccountId32 (#0)` | A grant was fully vested (all tokens released). |
| [RPC] | 3 | `GrantRevoked` | `miner: sp_core::crypto::AccountId32 (#0)`; `amount_to_treasury: u128`; `reason: pallet_work_vesting::pallet::RevocationReason (#415)` | A grant was revoked. |
| [RPC] | 4 | `EscrowSlashed` | `miner: sp_core::crypto::AccountId32 (#0)`; `amount_slashed: u128`; `remaining_frozen: u128` | Escrow partially slashed (e.g., ghost task penalty). |
| [RPC] | 5 | `EpochRolledOver` | `epoch_start_block: u32` | Epoch rolled over; G_n tallies reset. |
| [RPC] | 6 | `BlackoutWarning` | `miner: sp_core::crypto::AccountId32 (#0)`; `consecutive_failing_epochs: u32` | Blackout counter incremented for a miner. |

#### Errors

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `AlreadyHasGrant` | () | Miner already has an active grant. |
| [RPC] | 1 | `NoActiveGrant` | () | Miner has no active grant. |
| [RPC] | 2 | `CalibrationNotComplete` | () | Miner's calibration is not complete. |
| [RPC] | 3 | `GrantAlreadyRevoked` | () | Grant has already been revoked. |
| [RPC] | 4 | `NothingToClaim` | () | Nothing to claim (no unlocked tokens available). |
| [RPC] | 5 | `TooManyVestingMiners` | () | Maximum number of vesting miners reached. |
| [RPC] | 6 | `ZeroPledgeBaseline` | () | Pledge baseline is zero. |
| [RPC] | 7 | `FullyVested` | () | Grant is fully vested, nothing remaining. |
| [RPC] | 8 | `MinerRetired` | () | A retired miner cannot receive a new grant. |
| [RPC] | 9 | `RetirementLiabilitiesOutstanding` | () | Retired collateral still backs unresolved obligations. |

#### Constants

| Evidence | Constant | SCALE type | Decoded value (raw base units unless stated) | Purpose |
|---|---|---|---|---|
| [RPC] | `TreasuryAccount` | `sp_core::crypto::AccountId32 (#0)` | `"0x6d6f646c7a6b2f74727372790000000000000000000000000000000000000000"` | Treasury account for revoked tokens. |
| [RPC] | `BlocksPerEpoch` | `u32` | `86400` | Blocks per epoch for G_n averaging (e.g., 86_400 for 1 day at 1s blocks). |
| [RPC] | `BlackoutBlockThreshold` | `u32` | `86400` | Consecutive low-performance blocks before blackout revocation. |
| [RPC] | `RatePrecision` | `u128` | `1000000` | Precision multiplier for fixed-point math (1_000_000 = PPM). |
| [RPC] | `MaxVestingMiners` | `u32` | `5000` | Maximum number of miners with active escrows. |

### AirdropVesting — pallet 91

[RPC] Cohort grant vesting/compute-spend accounting; not a generic seat budget. Interface and descriptions below are read from metadata, not a source audit. [Metadata](../evidence/metadata.json); canonical RPC: `state_getMetadata(H)` at [node](https://rpc.devnet.flop.network).

#### Calls

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `create_airdrop_grant` | `beneficiary: sp_core::crypto::AccountId32 (#0)`; `tier: pallet_airdrop_vesting::pallet::AirdropTier (#226)`; `amount: u128`; `testnet_performance: Option (#93)` | Create an airdrop grant for a single beneficiary (root only).  Vesting is linear per block over 90 days (7,776,000 blocks). |
| [RPC] | 1 | `batch_create_airdrop_grants` | `grants: Vec<(sp_core::crypto::AccountId32 (#0), pallet_airdrop_vesting::pallet::AirdropTier (#226), u128, Option (#93))>` | Create airdrop grants in batch (root only).  Each entry is `(beneficiary, tier, amount, testnet_performance)`. |
| [RPC] | 2 | `claim_vested` | () | Claim vested airdrop tokens (linear unlock, can claim multiple times).  Calculates unlocked amount based on blocks elapsed, removes freeze for the claimed portion, and transfers to free balance. |
| [RPC] | 3 | `update_miner_performance` | `miner: sp_core::crypto::AccountId32 (#0)`; `mainnet_performance: u32` | Update miner performance score (affects vesting rate).  Called periodically during first 90 days to adjust unlock rate based on mainnet vs testnet performance ratio. |

#### Storage

| Evidence | Storage prefix / item | Modifier | Hashers in key order | Key SCALE type | Stored value SCALE type | Purpose |
|---|---|---|---|---|---|---|
| [RPC] | `AirdropVesting.AirdropGrants` | Optional | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `pallet_airdrop_vesting::pallet::AirdropGrant (#691)` | Per-account airdrop grant. |
| [RPC] | `AirdropVesting.TotalFrozen` | Default | plain | `—` | `u128` | Total tokens frozen across all airdrop grants. |
| [RPC] | `AirdropVesting.ActiveGrantCount` | Default | plain | `—` | `u32` | Total number of active (unclaimed) grants. |
| [RPC] | `AirdropVesting.TotalGrantsCreated` | Default | plain | `—` | `u32` | Total grants ever created (for stats). |

#### Events

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `AirdropGrantCreated` | `beneficiary: sp_core::crypto::AccountId32 (#0)`; `tier: pallet_airdrop_vesting::pallet::AirdropTier (#226)`; `amount: u128`; `cliff_blocks: u32` | An airdrop grant was created. |
| [RPC] | 1 | `AirdropClaimed` | `beneficiary: sp_core::crypto::AccountId32 (#0)`; `claimed_amount: u128`; `total_unlocked: u128` | Vested amount was claimed (freeze removed for unlocked portion). |
| [RPC] | 2 | `MinerPerformanceUpdated` | `miner: sp_core::crypto::AccountId32 (#0)`; `testnet_score: u32`; `mainnet_score: u32`; `adjustment_factor: u32` | Miner performance was updated (affects vesting rate). |
| [RPC] | 3 | `BatchGrantsCreated` | `count: u32`; `total_amount: u128` | A batch of airdrop grants was created. |

#### Errors

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `AlreadyHasGrant` | () | Account already has an airdrop grant. |
| [RPC] | 1 | `NoGrant` | () | No airdrop grant found for this account. |
| [RPC] | 2 | `AlreadyClaimed` | () | Grant already claimed. |
| [RPC] | 3 | `CliffNotExpired` | () | Cliff period has not expired yet. |
| [RPC] | 4 | `ZeroAmount` | () | Zero amount. |
| [RPC] | 5 | `EmptyBatch` | () | Batch is empty. |
| [RPC] | 6 | `BatchTooLarge` | () | Batch exceeds maximum size. |
| [RPC] | 7 | `NothingToClaim` | () | Nothing to claim (all vested tokens already claimed). |
| [RPC] | 8 | `InvalidPerformanceScore` | () | Invalid performance score (must be > 0). |

#### Constants

| Evidence | Constant | SCALE type | Decoded value (raw base units unless stated) | Purpose |
|---|---|---|---|---|
| [RPC] | `VestingDurationBlocks` | `u32` | `7776000` | Vesting duration in blocks (spec: 90 days = 7,776,000 blocks at 1s). |
| [RPC] | `MaxBatchSize` | `u32` | `500` | Maximum grants per batch operation. |

### FlopSubsidy — pallet 93

[RPC] Protocol subsidy phase tracking; not a seat-controlled daily cap. Interface and descriptions below are read from metadata, not a source audit. [Metadata](../evidence/metadata.json); canonical RPC: `state_getMetadata(H)` at [node](https://rpc.devnet.flop.network).

#### Calls

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `force_end_subsidies` | () | Force end subsidies (root only, for emergency or testing) |

#### Storage

| Evidence | Storage prefix / item | Modifier | Hashers in key order | Key SCALE type | Stored value SCALE type | Purpose |
|---|---|---|---|---|---|---|
| [RPC] | `FlopSubsidy.SubsidyEndBlock` | Default | plain | `—` | `u32` | Block when subsidies end (SUBSIDY_DURATION_BLOCKS = 315,360,000 from genesis) |
| [RPC] | `FlopSubsidy.TotalLabsSubsidy` | Default | plain | `—` | `u128` | Total subsidies paid to Labs (cumulative) |
| [RPC] | `FlopSubsidy.TotalFoundationSubsidy` | Default | plain | `—` | `u128` | Total subsidies paid to Foundation (cumulative) |
| [RPC] | `FlopSubsidy.SubsidyActive` | Default | plain | `—` | `bool` | Subsidy status |
| [RPC] | `FlopSubsidy.LabsAccount` | Optional | plain | `—` | `sp_core::crypto::AccountId32 (#0)` | Configured FLOP Labs multisig account. |
| [RPC] | `FlopSubsidy.FoundationAccount` | Optional | plain | `—` | `sp_core::crypto::AccountId32 (#0)` | Configured FLOP Foundation multisig account. |

#### Events

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `SubsidyPaid` | `block_number: u32`; `labs_amount: u128`; `foundation_amount: u128` | Subsidy paid to Labs and Foundation |
| [RPC] | 1 | `SubsidiesEnded` | `final_block: u32`; `total_labs: u128`; `total_foundation: u128` | Subsidies have ended (sunrise reached) |

#### Errors

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `RecipientNotConfigured` | () | A required subsidy recipient was not configured at genesis. |
| [RPC] | 1 | `SubsidyScheduleExhausted` | () | The halving schedule pays zero at this block — nothing is minted. Unreachable while `now < SubsidyEndBlock`; raised (never silently swallowed as a zero mint) if the two ever disagree. |

#### Constants

[RPC] None exposed.

### DelegationCap — pallet 98

[RPC] Validator stake delegation cap, not inference spending. Interface and descriptions below are read from metadata, not a source audit. [Metadata](../evidence/metadata.json); canonical RPC: `state_getMetadata(H)` at [node](https://rpc.devnet.flop.network).

#### Calls

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `register_validator` | `validator: sp_core::crypto::AccountId32 (#0)` | Register a validator for delegation cap tracking.  Called when an account starts validating. Initializes the delegation cap based on current self-stake. |
| [RPC] | 1 | `deregister_validator` | `validator: sp_core::crypto::AccountId32 (#0)` | Deregister a validator from cap tracking.  Called when a validator stops validating or is slashed out. |
| [RPC] | 2 | `update_cap` | `validator: sp_core::crypto::AccountId32 (#0)` | Update delegation cap for a validator.  Called when a validator bonds/unbonds additional stake. Recalculates the cap based on new self-stake. |

#### Storage

| Evidence | Storage prefix / item | Modifier | Hashers in key order | Key SCALE type | Stored value SCALE type | Purpose |
|---|---|---|---|---|---|---|
| [RPC] | `DelegationCap.TotalDelegatedStake` | Default | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `u128` | Current total delegated stake per validator (excluding self-stake). |
| [RPC] | `DelegationCap.ValidatorCount` | Default | plain | `—` | `u32` | Number of validators with active delegation caps. |

#### Events

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `NominationRejected` | `validator: sp_core::crypto::AccountId32 (#0)`; `requested: u128`; `cap: u128`; `current_delegated: u128` | A nomination was rejected due to delegation cap. |
| [RPC] | 1 | `CapUpdated` | `validator: sp_core::crypto::AccountId32 (#0)`; `self_stake: u128`; `new_cap: u128` | Delegation cap updated for a validator. |
| [RPC] | 2 | `ValidatorRegistered` | `validator: sp_core::crypto::AccountId32 (#0)`; `self_stake: u128`; `cap: u128` | Validator registered for cap tracking. |
| [RPC] | 3 | `ValidatorRemoved` | `validator: sp_core::crypto::AccountId32 (#0)` | Validator removed from cap tracking. |

#### Errors

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `DelegationCapExceeded` | () | Total delegated stake would exceed the delegation cap. |
| [RPC] | 1 | `ValidatorNoSelfStake` | () | Validator has no self-stake — cannot accept delegation. |
| [RPC] | 2 | `NotAValidator` | () | Account is not a validator. |

#### Constants

| Evidence | Constant | SCALE type | Decoded value (raw base units unless stated) | Purpose |
|---|---|---|---|---|
| [RPC] | `MaxDelegationMultiplier` | `u32` | `10` | Maximum delegation multiplier (default: 10×). |

### EmergencyOverride — pallet 99

[RPC] Timelocked privileged override; not owner-level budget management. Interface and descriptions below are read from metadata, not a source audit. [Metadata](../evidence/metadata.json); canonical RPC: `state_getMetadata(H)` at [node](https://rpc.devnet.flop.network).

#### Calls

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `queue_override` | `call: Vec<u8>`; `reason: Vec<u8>` | Queue a runtime call for execution after the timelock period.  # Arguments - `call`: The runtime call to execute (encoded) - `reason`: Public justification (max 256 bytes)  # Requirements - Root origin only - No other override currently pending - Cooldown period has elapsed since last execution - Call cannot be another `emergency_override` (self-protection) |
| [RPC] | 1 | `execute_override` | () | Execute a queued override after the timelock has elapsed.  Can be called by anyone (permissionless execution) once the timelock period has passed. |
| [RPC] | 2 | `cancel_override` | () | Cancel a pending override (root only).  Can be used to cancel a queued override before the timelock expires. |

#### Storage

| Evidence | Storage prefix / item | Modifier | Hashers in key order | Key SCALE type | Stored value SCALE type | Purpose |
|---|---|---|---|---|---|---|
| [RPC] | `EmergencyOverride.PendingOverrideStorage` | Optional | plain | `—` | `pallet_emergency_override::pallet::PendingOverride (#745)` | Currently pending override (only one at a time). |
| [RPC] | `EmergencyOverride.LastOverrideBlock` | Default | plain | `—` | `u32` | Block number when the last override was executed. |
| [RPC] | `EmergencyOverride.TotalOverrides` | Default | plain | `—` | `u64` | Total overrides ever queued. |
| [RPC] | `EmergencyOverride.TotalExecuted` | Default | plain | `—` | `u64` | Total overrides ever executed. |
| [RPC] | `EmergencyOverride.TotalCancelled` | Default | plain | `—` | `u64` | Total overrides ever cancelled. |

#### Events

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `OverrideQueued` | `call_hash: primitive_types::H256 (#13)`; `reason: Vec<u8>`; `effective_at: u32`; `queued_by: sp_core::crypto::AccountId32 (#0)` | An override was queued with a timelock. |
| [RPC] | 1 | `OverrideExecuted` | `call_hash: primitive_types::H256 (#13)`; `executed_at: u32` | A queued override was executed. |
| [RPC] | 2 | `OverrideCancelled` | `call_hash: primitive_types::H256 (#13)`; `cancelled_at: u32` | A queued override was cancelled. |

#### Errors

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `OverrideAlreadyPending` | () | Another override is already pending; only one at a time allowed. |
| [RPC] | 1 | `NoOverridePending` | () | No override is currently pending. |
| [RPC] | 2 | `TimelockNotElapsed` | () | Timelock has not elapsed yet. |
| [RPC] | 3 | `CooldownNotElapsed` | () | Cooldown period has not elapsed since last override. |
| [RPC] | 4 | `CannotOverrideSelf` | () | Cannot queue an emergency_override call (self-protection). |
| [RPC] | 5 | `ReasonTooLong` | () | Reason text exceeds maximum length. |
| [RPC] | 6 | `CallTooLarge` | () | Encoded call exceeds maximum size. |
| [RPC] | 7 | `CallDecodeFailed` | () | Failed to decode the queued call. |

#### Constants

| Evidence | Constant | SCALE type | Decoded value (raw base units unless stated) | Purpose |
|---|---|---|---|---|
| [RPC] | `TimelockBlocks` | `u32` | `259200` | Blocks to wait before override can be executed (72 hours at 1s). |
| [RPC] | `CooldownBlocks` | `u32` | `604800` | Blocks to wait between overrides (7 days at 1s). |
| [RPC] | `MaxReasonLength` | `u32` | `256` | Maximum reason length (256 bytes). |
| [RPC] | `MaxCallSize` | `u32` | `65536` | Maximum encoded call size. |

### EmergencyPause — pallet 105

[RPC] Privileged pallet/global halt; not a seat owner pause mechanism. Interface and descriptions below are read from metadata, not a source audit. [Metadata](../evidence/metadata.json); canonical RPC: `state_getMetadata(H)` at [node](https://rpc.devnet.flop.network).

#### Calls

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `emergency_pause` | `pallets: Vec<Vec<u8>>`; `reason: Vec<u8>`; `duration: Option (#93)` | Pause one or more pallets until `expires_at` (now + duration). `PauseOrigin` (root). |
| [RPC] | 1 | `emergency_resume` | `pallet: Vec<u8>` | Resume a paused pallet. `ResumeOrigin` (governance). |
| [RPC] | 2 | `emergency_pause_all` | `reason: Vec<u8>`; `duration: Option (#93)` | Pause everything (nuclear option). `PauseOrigin` (root). |
| [RPC] | 3 | `emergency_resume_all` | () | Lift a global pause. `ResumeOrigin` (governance). |

#### Storage

| Evidence | Storage prefix / item | Modifier | Hashers in key order | Key SCALE type | Stored value SCALE type | Purpose |
|---|---|---|---|---|---|---|
| [RPC] | `EmergencyPause.PausedPallets` | Optional | Blake2_128Concat | `bounded_collections::bounded_vec::BoundedVec (#835)` | `pallet_emergency_pause::pallet::PauseInfo (#836)` | Per-pallet pauses, keyed by pallet name. |
| [RPC] | `EmergencyPause.GlobalPause` | Optional | plain | `—` | `pallet_emergency_pause::pallet::PauseInfo (#836)` | Global pause (halts everything that checks `ensure_not_paused`). |
| [RPC] | `EmergencyPause.PausedCount` | Default | plain | `—` | `u32` | Count of currently paused pallets (bounds insertion + iteration). |

#### Events

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `PalletPaused` | `pallet: Vec<u8>`; `expires_at: u32` | A pallet was paused until `expires_at`. |
| [RPC] | 1 | `PalletResumed` | `pallet: Vec<u8>` | A pallet was resumed by governance. |
| [RPC] | 2 | `PauseExpired` | `pallet: Vec<u8>` | A pallet pause auto-expired. |
| [RPC] | 3 | `GlobalPauseActivated` | `expires_at: u32` | A global pause was activated until `expires_at`. |
| [RPC] | 4 | `GlobalPauseDeactivated` | () | A global pause was lifted by governance. |
| [RPC] | 5 | `GlobalPauseExpired` | () | A global pause auto-expired. |

#### Errors

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `TooManyPausedPallets` | () | Adding this pause would exceed `MaxPausedPallets`. |
| [RPC] | 1 | `NotPaused` | () | The target is not currently paused. |
| [RPC] | 2 | `EmptyPalletList` | () | The pallet list was empty. |
| [RPC] | 3 | `DurationTooLong` | () | Requested duration exceeds `MaxPauseDuration`. |
| [RPC] | 4 | `ReasonTooLong` | () | Reason text exceeds `MaxReasonLength`. |
| [RPC] | 5 | `PalletNameTooLong` | () | Pallet name exceeds `MaxPalletNameLen`. |
| [RPC] | 6 | `Paused` | () | The operation is blocked because the pallet (or everything) is paused. |
| [RPC] | 7 | `ProtectedPallet` | () | The named pallet is protected (runtime PROTECTED set) and may not be paused. |

#### Constants

| Evidence | Constant | SCALE type | Decoded value (raw base units unless stated) | Purpose |
|---|---|---|---|---|
| [RPC] | `DefaultPauseDuration` | `u32` | `86400` | Default pause duration when the caller supplies none. |
| [RPC] | `MaxPauseDuration` | `u32` | `604800` | Maximum pause duration (auto-expiry ceiling — bounds rogue-key damage). |
| [RPC] | `MaxPausedPallets` | `u32` | `32` | Maximum simultaneously paused pallets (bounds the `on_initialize` scan). |
| [RPC] | `MaxPalletNameLen` | `u32` | `64` | Maximum length of a pallet name. |
| [RPC] | `MaxReasonLength` | `u32` | `256` | Maximum length of a reason string. |

### PaidStorage — pallet 108

[RPC] Storage reservation, service-lane budgets and revocable policies; not hosted inference credential policy. Interface and descriptions below are read from metadata, not a source audit. [Metadata](../evidence/metadata.json); canonical RPC: `state_getMetadata(H)` at [node](https://rpc.devnet.flop.network).

#### Calls

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `set_profile` | `profile: Option (#272)` | Set or clear the provisional devnet profile. Index is provisional until E.54. This root-only administration call is the exception to the active-profile guard. |
| [RPC] | 1 | `declare_capacity` | `epoch: u64`; `encoded_bytes: u64` | Declare `encoded_bytes` of capacity for the next epoch and hold its collateral (R5.4d). One declaration per provider per epoch. Index is provisional until E.54. |
| [RPC] | 2 | `vote_tariff` | `epoch: u64`; `tariff: pallet_paid_storage::pallet::Rates (#276)` | Vote the next epoch's tariff (R5.4e). Counted only with a capacity declaration for that epoch; one vote per declarer. Index is provisional until E.54. |
| [RPC] | 3 | `open_reservation` | `reserved_bytes: u64`; `term: u32`; `max_cost: u128`; `nonce: u64` | Fund a fixed term at the open epoch's tariff. Index provisional until E.54. |
| [RPC] | 4 | `finalize_reservation` | `reservation: u64` | Expire Pending placement or close an ended reservation after rent settles. Index provisional until E.54. |
| [RPC] | 5 | `fund_service_lane` | `reservation: u64`; `provider: sp_core::crypto::AccountId32 (#0)`; `budget: u128`; `nonce: u64` | Fund one assigned provider's service budget. Index provisional until E.54. |
| [RPC] | 6 | `redeem_service` | `lane: [u8;32]`; `voucher: pallet_paid_storage::wire::ServiceVoucher (#286)` | D-0519 M2: only the pinned provider dispatches cumulative claims. |
| [RPC] | 7 | `close_service_lane` | `lane: [u8;32]` | Close fixes the claim window; post-close signatures remain budget bounded. |
| [RPC] | 8 | `finalize_service_lane` | `lane: [u8;32]` | Refund only above the fixed deadline on the known finalized prefix. |
| [RPC] | 9 | `advance_policy` | `reservation: u64`; `scope: pallet_paid_storage::policy::PolicyScope (#290)` | Create epoch one or advance a live scope; revoked scopes cannot reopen. |
| [RPC] | 10 | `revoke_policy` | `reservation: u64`; `scope: pallet_paid_storage::policy::PolicyScope (#290)` | Permanently revoke this scope and, for a namespace, all object children. |
| [RPC] | 11 | `post_checkpoint` | `epoch: u64`; `root: [u8;32]`; `counters_commitment: [u8;32]` | One authenticated F.7 checkpoint per provider/epoch, within inclusive grace. |
| [RPC] | 12 | `set_rent_profile` | `terms: pallet_paid_storage::rent::RentProfileV (#291)` | Root supplies the missing E.54 rent bounds explicitly while the profile is idle. |
| [RPC] | 13 | `set_memory_profile` | `terms: pallet_paid_storage::memory::MemoryProfileV (#292)` | Explicit D-0512 experimental inputs, frozen before capacity or deals exist. |

#### Storage

| Evidence | Storage prefix / item | Modifier | Hashers in key order | Key SCALE type | Stored value SCALE type | Purpose |
|---|---|---|---|---|---|---|
| [RPC] | `PaidStorage.Profile` | Optional | plain | `—` | `pallet_paid_storage::pallet::ProfileV (#273)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `PaidStorage.ProfileRevision` | Default | plain | `—` | `u32` | Bumped by every `set_profile(Some(_))`; each tariff records the revision whose  governance floor and ceiling applied. |
| [RPC] | `PaidStorage.CapacityDeclarations` | Optional | Twox64Concat, Blake2_128Concat | `(u64, sp_core::crypto::AccountId32 (#0))` | `pallet_paid_storage::pallet::CapacityDeclaration (#785)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `PaidStorage.DeclarerCount` | Default | Twox64Concat | `u64` | `u32` | Declarations per epoch, capped at `MaxDeclarers`. |
| [RPC] | `PaidStorage.EpochTariffs` | Optional | Twox64Concat | `u64` | `pallet_paid_storage::pallet::EpochTariff (#436)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `PaidStorage.LastTariffEpoch` | Optional | plain | `—` | `u64` | Epoch of the latest stored tariff: the previous tariff for the next boundary. |
| [RPC] | `PaidStorage.LastBoundaryEpoch` | Optional | plain | `—` | `u64` | Latest epoch whose boundary was processed. Never moves backward. |
| [RPC] | `PaidStorage.TripwireCounter` | Default | plain | `—` | `u32` | Consecutive processed boundaries whose ended epoch had free declared capacity below  the demand headroom. |
| [RPC] | `PaidStorage.Reservations` | Optional | Blake2_128Concat | `u64` | `pallet_paid_storage::reservations::CapacityReservation (#786)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `PaidStorage.CounterForReservations` | Default | plain | `—` | `u32` | Counter for the related counted storage map |
| [RPC] | `PaidStorage.PendingReservations` | Default | plain | `—` | `bounded_collections::bounded_vec::BoundedVec (#795)` | `MaxDeclarers` is a hard encoding ceiling; the profile imposes the work limit. |
| [RPC] | `PaidStorage.NextReservationId` | Default | plain | `—` | `u64` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `PaidStorage.RentProfile` | Optional | plain | `—` | `pallet_paid_storage::rent::RentProfileV (#291)` | Versioned UNRATIFIED inputs alongside ProfileV, preserving its wire encoding. |
| [RPC] | `PaidStorage.MemoryProfile` | Optional | plain | `—` | `pallet_paid_storage::memory::MemoryProfileV (#292)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `PaidStorage.RentContracts` | Optional | Blake2_128Concat | `u64` | `pallet_paid_storage::rent::RentContract (#796)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `PaidStorage.RentSlots` | Optional | Blake2_128Concat, Twox64Concat | `(u64, u32)` | `pallet_paid_storage::rent::RentSlot (#797)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `PaidStorage.ProviderCheckpoints` | Optional | Twox64Concat, Blake2_128Concat | `(u64, sp_core::crypto::AccountId32 (#0))` | `pallet_paid_storage::rent::PostedCheckpoint (#798)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `PaidStorage.LiveRentReservations` | Default | plain | `—` | `bounded_collections::bounded_vec::BoundedVec (#795)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `PaidStorage.RentCursor` | Optional | plain | `—` | `pallet_paid_storage::rent::ReleaseCursor (#799)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `PaidStorage.CheckpointPruneCursor` | Optional | plain | `—` | `u64` | Next epoch to probe. Absence starts at zero, including pre-upgrade checkpoints. |
| [RPC] | `PaidStorage.PayerReservation` | Optional | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `u64` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `PaidStorage.UsedReservationNonces` | Optional | Blake2_128Concat, Twox64Concat | `(sp_core::crypto::AccountId32 (#0), u64)` | `u64` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `PaidStorage.ProviderAssignedBytes` | Default | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `u64` | Outstanding assignments across all declaration epochs. |
| [RPC] | `PaidStorage.ServiceLanes` | Optional | Blake2_128Concat | `[u8;32]` | `pallet_paid_storage::lanes::ServiceLane (#800)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `PaidStorage.LaneOf` | Optional | Twox64Concat, Blake2_128Concat | `(u64, sp_core::crypto::AccountId32 (#0))` | `[u8;32]` | A provider slot remains occupied until its Closing lane is finalized. |
| [RPC] | `PaidStorage.LiveLaneCount` | Default | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `u32` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `PaidStorage.UsedLaneNonces` | Optional | Blake2_128Concat, Twox64Concat | `(sp_core::crypto::AccountId32 (#0), u64)` | `[u8;32]` | Permanent history, like reservation nonces: never prune or reuse these keys. |
| [RPC] | `PaidStorage.LaneNonceCount` | Default | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `u64` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `PaidStorage.ObjectPolicies` | Optional | Blake2_128Concat, Blake2_128Concat | `(u64, pallet_paid_storage::policy::PolicyScope (#290))` | `pallet_paid_storage::policy::ObjectPolicy (#803)` | Additive v3 state; absence denies authority. Revocations are never pruned. |
| [RPC] | `PaidStorage.PolicyCount` | Default | Blake2_128Concat | `u64` | `u32` | No description in metadata; execution semantics unknown beyond the encoded interface. |

#### Events

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `ProfileSet` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 1 | `ProfileCleared` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 2 | `CapacityDeclared` | `epoch: u64`; `provider: sp_core::crypto::AccountId32 (#0)`; `encoded_bytes: u64`; `collateral: u128` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 3 | `TariffVoteRecorded` | `epoch: u64`; `provider: sp_core::crypto::AccountId32 (#0)`; `vote: pallet_paid_storage::pallet::Rates (#276)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 4 | `EpochTariffSet` | `epoch: u64`; `tariff: pallet_paid_storage::pallet::EpochTariff (#436)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 5 | `NoEpochTariff` | `epoch: u64`; `reason: pallet_paid_storage::pallet::NoTariffReason (#439)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 6 | `EpochBoundarySkipped` | `epoch: u64` | The epoch index was not after the last processed boundary (the epoch length changed); nothing was computed. |
| [RPC] | 7 | `ReservationPending` | `reservation: u64`; `payer: sp_core::crypto::AccountId32 (#0)`; `escrow: u128` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 8 | `ReservationActivated` | `reservation: u64`; `activation: u64`; `end: u64` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 9 | `ReservationAborted` | `reservation: u64`; `payer: sp_core::crypto::AccountId32 (#0)`; `refunded: u128` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 10 | `ServiceLaneFunded` | `lane: [u8;32]`; `payer: sp_core::crypto::AccountId32 (#0)`; `provider: sp_core::crypto::AccountId32 (#0)`; `funded: u128` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 11 | `ServicePaid` | `lane: [u8;32]`; `provider: sp_core::crypto::AccountId32 (#0)`; `delta: u128`; `paid: u128`; `remaining: u128` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 12 | `ServiceLaneClosing` | `lane: [u8;32]`; `boundary: u64`; `deadline: u64`; `remaining: u128` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 13 | `ServiceLaneClosed` | `lane: [u8;32]`; `payer: sp_core::crypto::AccountId32 (#0)`; `refunded: u128`; `paid: u128` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 14 | `PolicyAdvanced` | `reservation: u64`; `scope: pallet_paid_storage::policy::PolicyScope (#290)`; `epoch: u64` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 15 | `PolicyRevoked` | `reservation: u64`; `scope: pallet_paid_storage::policy::PolicyScope (#290)`; `epoch: u64` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 16 | `RentProfileSet` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 17 | `CheckpointPosted` | `provider: sp_core::crypto::AccountId32 (#0)`; `epoch: u64`; `root: [u8;32]`; `counters_commitment: [u8;32]` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 18 | `RentReleased` | `reservation: u64`; `provider: sp_core::crypto::AccountId32 (#0)`; `epoch: u64`; `delta: u128`; `audited: bool` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 19 | `ReservationClosed` | `reservation: u64`; `payer: sp_core::crypto::AccountId32 (#0)`; `paid: u128`; `refunded: u128` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 20 | `MemoryProfileSet` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |

#### Errors

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `InactiveProfile` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 1 | `OpenWork` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 2 | `InvalidProfile` | () | A zero epoch length, tripwire length, denominator or collateral rate, or a floor above its ceiling. |
| [RPC] | 3 | `DenominatorChanged` | () | A tariff exists and the new profile changes a denominator. |
| [RPC] | 4 | `NotActiveValidator` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 5 | `NotNextEpoch` | () | Only the next epoch accepts declarations and votes. |
| [RPC] | 6 | `EpochStarted` | () | The epoch's boundary has already been processed. |
| [RPC] | 7 | `ZeroCapacity` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 8 | `DuplicateDeclaration` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 9 | `TooManyDeclarers` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 10 | `InsufficientCollateral` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 11 | `NoDeclaration` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 12 | `DuplicateVote` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 13 | `ArithmeticOverflow` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 14 | `InvalidReservation` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 15 | `NoCurrentTariff` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 16 | `MaxCostExceeded` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 17 | `InsufficientEscrow` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 18 | `DuplicateReservation` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 19 | `DuplicateNonce` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 20 | `TooManyReservations` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 21 | `UnknownReservation` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 22 | `NotExpiredPending` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 23 | `AlreadyFinalized` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 24 | `InconsistentReservation` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 25 | `UnknownLane` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 26 | `InvalidLane` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 27 | `DuplicateLane` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 28 | `TooManyLanes` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 29 | `NonceHistoryExhausted` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 30 | `InvalidVoucher` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 31 | `InvalidVoucherAmount` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 32 | `StaleVoucher` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 33 | `LaneBudgetExceeded` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 34 | `LaneClaimExpired` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 35 | `UnknownFinalizedHeight` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 36 | `LaneClaimPending` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 37 | `InconsistentLane` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 38 | `NotReservationOwner` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 39 | `ClosedReservation` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 40 | `InvalidPolicyScope` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 41 | `UnknownPolicy` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 42 | `RevokedPolicy` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 43 | `InconsistentPolicy` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 44 | `TooManyPolicies` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 45 | `MissingRentTerms` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 46 | `NotAssignedProvider` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 47 | `DuplicateCheckpoint` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 48 | `CheckpointOutsideGrace` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 49 | `RentPending` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 50 | `ReservationNotEnded` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |

#### Constants

| Evidence | Constant | SCALE type | Decoded value (raw base units unless stated) | Purpose |
|---|---|---|---|---|
| [RPC] | `MaxDeclarers` | `u32` | `1000` | Declarations accepted per epoch; bounds the boundary hook. Set it at or above  the active-set cap so early declarers cannot crowd out the rest. |

### ComputeChannel — pallet 103

[RPC] Payer escrow custody, channel commitments, per-identity reservations and miner settlement; included to specify the actual native money path. Interface and descriptions below are read from metadata, not a source audit. [Metadata](../evidence/metadata.json); canonical RPC: `state_getMetadata(H)` at [node](https://rpc.devnet.flop.network).

#### Calls

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `open_channel` | `miner: sp_core::crypto::AccountId32 (#0)`; `model_hash: primitive_types::H256 (#13)`; `measured_root: primitive_types::H256 (#13)`; `decode_policy_hash: primitive_types::H256 (#13)`; `precision: pallet_model_registry::types::ModelPrecision (#246)`; `enclave_key: [u8;32]`; `agent_key: [u8;32]`; `sla: pallet_compute_channel::pallet::Sla (#294)`; `escrow: u128`; `nonce: u64`; `settlement_class: pallet_compute_channel::pallet::SettlementClass (#295)` | **Open a session** (inclusion 1 of 2). The agent escrows the reserved-capacity payment, commits the measured model root (verified against the registry now), and binds a caller-supplied session signing key. The pallet does not verify TEE provenance for that key. |
| [RPC] | 1 | `top_up_escrow` | `channel_id: primitive_types::H256 (#13)`; `additional: u128` | **Top up escrow in place** (Lightning splice-in). Raises a live session's reserved capacity without close+reopen — avoids re-establishing the off-chain session and losing KV-cache warmth (R2 §3.2). |
| [RPC] | 2 | `settle` | `channel_id: primitive_types::H256 (#13)`; `final_root: primitive_types::H256 (#13)`; `aggregate_gn: u128`; `claimed_measured_root: primitive_types::H256 (#13)`; `agent_receipt_sig: [u8;64]`; `transcript_ref: Option (#296)`; `verified_turns: Vec<pallet_compute_channel::pallet::VerifiedTurn (#298)>` | **Cooperative settle** (inclusion 2 of 2). The miner posts the final root + aggregate `G_n` together with the agent's last signed receipt; both parties agreed to private payment ⇒ pay out immediately. This does not establish execution or public reward eligibility. The escrow (reserved capacity) is paid to the miner in full — **under-use is not refunded** (decision #1). |
| [RPC] | 15 | `certificate_settle` | `channel_id: primitive_types::H256 (#13)`; `final_root: primitive_types::H256 (#13)`; `aggregate_gn: u128`; `claimed_measured_root: primitive_types::H256 (#13)`; `agent_receipt_sig: [u8;64]`; `cert_commitment: primitive_types::H256 (#13)`; `bookkeeping_cert: Option (#102)`; `transcript_ref: Option (#296)`; `sampled_audit: Option (#302)`; `metering_cert: Option (#102)` | **Certificate settle** (#535, premium class). Cooperative settle whose credited `aggregate_gn` is backed by a batched GEMM work certificate: the verifier checks `cert_commitment` against the model's registered weight MLE commitment, so the credited value is a *proven* op-count for the covered GEMM fraction rather than a plausibility-gated self-report. The agent receipt is still required (receipts prove delivery on every settle path; the certificate proves work, not delivery), and the #455 gates still run — tripwires bound the non-GEMM fraction the certificate does not cover. Enforces the premium price floor `escrow ≥ price_per_gflop · aggregate_gn · MinCertificatePremiumPpm`.  #794: `bookkeeping_cert` composes the aggregation-integrity half — the settled `aggregate_gn` must be proven to equal `Σ per-leaf g_n` (same-journal statement) or the settle rejects ([`Error::BookkeepingRejected`]). It fails closed on the money path: a runtime that wires a real backend ([`BookkeepingVerifier::required`]) rejects an omitted cert ([`Error::BookkeepingRequired`]), so a miner cannot skip the gate. Under the `()` backend (no zk verifier yet) the cert is optional and the miner may fall back to the work-cert-only settle.  #871: `metering_cert` composes the per-leaf half — each committed leaf's `g_n` must be proven to equal `measured_gn(committed token counts)` under the model's `tokens_per_byte_band_ppm` cap, or the settle rejects ([`Error::MeteringRejected`]). Bookkeeping ∧ metering is the composed billing-integrity guarantee (`Computable.MeteringCertInt`). Same fail-closed discipline as bookkeeping ([`MeteringCertVerifier::required`] / [`Error::MeteringRequired`]); the band is read from the model registry, so a miner cannot supply a looser cap. |
| [RPC] | 3 | `force_settle` | `channel_id: primitive_types::H256 (#13)`; `final_root: primitive_types::H256 (#13)`; `aggregate_gn: u128`; `claimed_measured_root: primitive_types::H256 (#13)`; `agent_receipt_sig: [u8;64]`; `transcript_ref: Option (#296)`; `verified_turns: Vec<pallet_compute_channel::pallet::VerifiedTurn (#298)>` | **Force-settle** (escape hatch / permissionless). Either party posts the latest signed receipt **without** counterparty cooperation. This does *not* pay immediately — it opens the challenge window; after it closes with no upheld fraud, anyone calls `finalize` (metadata reference: Pallet::finalize). A later force-settle with a higher (validly-signed) `aggregate_gn` supersedes the earlier one (highest receipt wins; monotonic replay protection). |
| [RPC] | 4 | `finalize` | `channel_id: primitive_types::H256 (#13)` | **Finalize** a force-settled channel after its challenge window closes with no upheld fraud. Permissionless. Pays the verified work amount, refunds non-penalty unused escrow, without issuing public work credit. |
| [RPC] | 5 | `timeout` | `channel_id: primitive_types::H256 (#13)` | **Timeout / abort** (permissionless). If the session exceeded its `max_duration` while still `Open` — the miner reserved capacity but posted no settlement — this is **non-delivery** (a dispute condition): the agent's escrow is refunded and the channel closes. (Distinct from under-use, which is never refunded.) |
| [RPC] | 6 | `open_dispute` | `channel_id: primitive_types::H256 (#13)`; `contested_turn: u32` | **Open a single-turn fraud dispute** during the challenge window. Standing (D-0424): only the channel agent or an active validator may challenge; arbitrary public origins are rejected **before** the bond locks. Names the contested turn directly (`lo == hi`); miner answers with `respond_dispute` (metadata reference: Pallet::respond_dispute). For multi-round isolation use `open_bisection_dispute` (metadata reference: Pallet::open_bisection_dispute). |
| [RPC] | 17 | `open_bisection_dispute` | `channel_id: primitive_types::H256 (#13)`; `n_turns: u32` | **Open a multi-round bisection dispute** over `n_turns` (power of two, `2..=MaxSettlementTurns`). Isolates one turn in `⌈log₂ n⌉` midpoint rounds (`DisputeBisection.covers`), then the leaf check of `respond_dispute` (metadata reference: Pallet::respond_dispute). Miner must open child roots via `respond_bisection` (metadata reference: Pallet::respond_bisection); challenger narrows via `challenge_bisection` (metadata reference: Pallet::challenge_bisection). |
| [RPC] | 18 | `respond_bisection` | `channel_id: primitive_types::H256 (#13)`; `left_root: primitive_types::H256 (#13)`; `right_root: primitive_types::H256 (#13)` | **Miner midpoint response**: open child roots for `[lo, mid]` and `[mid+1, hi]` such that `hash(left‖right) == parent_root`. Resets the response window for the challenger's side choice. |
| [RPC] | 19 | `challenge_bisection` | `channel_id: primitive_types::H256 (#13)`; `choose_left: bool` | **Challenger midpoint pick**: choose the left (`[lo, mid]`) or right (`[mid+1, hi]`) half. When the interval collapses to one turn, the miner must answer with `respond_dispute` (metadata reference: Pallet::respond_dispute). |
| [RPC] | 7 | `respond_dispute` | `channel_id: primitive_types::H256 (#13)`; `leaf_version: pallet_compute_channel::TranscriptLeafVersion (#299)`; `turn_index: u32`; `h_in: primitive_types::H256 (#13)`; `h_out: primitive_types::H256 (#13)`; `g_n: u128`; `decode_policy_hash: primitive_types::H256 (#13)`; `h_ids: primitive_types::H256 (#13)`; `toploc_commitment_hash: primitive_types::H256 (#13)`; `miner_recv_ms: u64`; `miner_done_ms: u64`; `latency_ms: u64`; `enclave_sig: [u8;64]`; `merkle_path: Vec<(primitive_types::H256 (#13), bool)>` | **Respond to a dispute** (miner / defender). Proves the contested turn was validly produced: the enclave signed the leaf and the leaf is a member of the committed transcript root. Valid ⇒ dispute dismissed and the challenger's bond is forfeited to the miner. Legal only once bisection has isolated a single turn (`lo == hi`). |
| [RPC] | 8 | `resolve_timeout_dispute` | `channel_id: primitive_types::H256 (#13)` | **Resolve a timed-out dispute** (permissionless). - Awaiting miner (midpoint open or leaf): fraud defaults — slash miner,   refund agent, return challenger bond. - Awaiting challenger side-pick: challenger abandoned — dismiss, bond to miner. |
| [RPC] | 20 | `resolve_unrecoverable_transcript` | `channel_id: primitive_types::H256 (#13)` | **ENG-7 unrecoverable transcript void** (permissionless).  When neutral DA reports the channel transcript as unrecoverable (`BlobUnrecoverable` / RS loss beyond tolerance after repair deadline), the open dispute (if any) is void — not won by either party: - no fraud verdict, no miner fraud slash - challenger bond returned - channel closes at the last co-signed receipt payable - miner paid co-signed prefix only; agent refunded the unsigned tail - `aggregate_gn` credited from that receipt only  Does not re-slash DA-audited providers (serve-or-slash already ran). Available while `Settling` with unrecoverable DA — no need to wait for the challenge/response window when recovery is already impossible. |
| [RPC] | 42 | `set_fcu_empirical_params` | `params: Option (#305)` | Update future funding economics atomically; clearing requires drained obligations. |
| [RPC] | 43 | `set_fcu_mass_slash_paused` | `paused: bool` | Explicit F2 circuit breaker; absence remains paused in the runtime adapter. |
| [RPC] | 47 | `set_fcu_primary_admissions_paused` | `paused: bool` | Stop new primary exposure without disabling funded obligations or claims. |
| [RPC] | 48 | `register_fcu_service_profile` | `profile: pallet_compute_channel::fcu_service::FcuServiceProfile (#307)`; `qualification: pallet_compute_channel::fcu_service::FcuProfileQualification (#308)` | Register an immutable measured profile and one immutable qualification revision. |
| [RPC] | 49 | `set_fcu_service_profile_status` | `profile_hash: primitive_types::H256 (#13)`; `status: pallet_compute_channel::fcu_service::FcuProfileStatus (#310)` | Retirement preserves the immutable qualified terms of sold reservations. |
| [RPC] | 26 | `fund_forward_offer` | `offer: pallet_compute_channel::pallet::StandingOffer (#311)`; `miner_signature: [u8;64]` | Lock the miner bond for a signed forward offer before publication. |
| [RPC] | 27 | `cancel_funded_forward_offer` | `offer_nonce: u64` | Release an unused funded offer after its signed pickup window expires. |
| [RPC] | 28 | `claim_forward_availability` | `channel_id: primitive_types::H256 (#13)` | Lazily claim the availability earnout accrued so far. |
| [RPC] | 29 | `release_forward_bond` | `channel_id: primitive_types::H256 (#13)`; `final_root: primitive_types::H256 (#13)`; `aggregate_gn: u128`; `agent_receipt_sig: [u8;64]`; `verified_turns: Vec<pallet_compute_channel::pallet::VerifiedTurn (#298)>` | Release the miner bond pro-rata to cumulative receipt-backed delivery. |
| [RPC] | 30 | `assign_forward_channel` | `channel_id: primitive_types::H256 (#13)`; `new_agent: sp_core::crypto::AccountId32 (#0)`; `new_agent_key: [u8;32]`; `new_agent_signature: [u8;64]` | Assign a bilateral forward position to a countersigning buyer. |
| [RPC] | 31 | `transfer_forward_units` | `channel_id: primitive_types::H256 (#13)`; `to: sp_core::crypto::AccountId32 (#0)`; `units: u128` | Transfer divisible forward rights. Launch config (100% lot) admits only transfer-all; the 10% test config exercises up to ten holders. |
| [RPC] | 32 | `claim_forward_distribution` | `channel_id: primitive_types::H256 (#13)` | Pull the caller's linear share of terminal refunds and buyer damages. |
| [RPC] | 33 | `open_forward_draw` | `channel_id: primitive_types::H256 (#13)`; `units: u128`; `nonce: u64` | Admit a holder sub-stream first-come without preempting an active draw. |
| [RPC] | 34 | `close_forward_draw` | `channel_id: primitive_types::H256 (#13)`; `draw_id: primitive_types::H256 (#13)` | Close a draw by either party, or permissionlessly after the term ends. |
| [RPC] | 35 | `post_forward_bid` | `model_hash: primitive_types::H256 (#13)`; `measured_root: primitive_types::H256 (#13)`; `decode_policy_hash: primitive_types::H256 (#13)`; `precision: pallet_model_registry::types::ModelPrecision (#246)`; `agent_key: [u8;32]`; `sla: pallet_compute_channel::pallet::Sla (#294)`; `terms: pallet_compute_channel::pallet::ForwardTerms (#313)`; `nonce: u64` | Post fixed-price demand with the buyer payment locked before discovery. |
| [RPC] | 36 | `commit_forward_bid_claim` | `bid_id: primitive_types::H256 (#13)`; `commitment: primitive_types::H256 (#13)` | Register a miner commitment and lock its delivery bond before entropy. |
| [RPC] | 37 | `seal_forward_bid_claims` | `bid_id: primitive_types::H256 (#13)` | Freeze registration, then and only then sample claim-draw entropy. |
| [RPC] | 38 | `reveal_forward_bid_claim` | `bid_id: primitive_types::H256 (#13)`; `enclave_key: [u8;32]`; `salt: primitive_types::H256 (#13)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 39 | `clear_forward_bid` | `bid_id: primitive_types::H256 (#13)` | Select the entropy-ranked revealed claimant and activate the channel. |
| [RPC] | 40 | `cancel_forward_bid` | `bid_id: primitive_types::H256 (#13)` | Cancel an empty bid immediately, or any uncleared bid after its phase deadline. |
| [RPC] | 25 | `open_channel_with_offer` | `offer: pallet_compute_channel::pallet::StandingOffer (#311)`; `miner_signature: [u8;64]`; `measured_root: primitive_types::H256 (#13)`; `decode_policy_hash: primitive_types::H256 (#13)`; `agent_key: [u8;32]`; `escrow: u128`; `agent_signature: [u8;64]`; `settlement_class: pallet_compute_channel::pallet::SettlementClass (#295)` | Open directly from a miner-signed standing capacity offer. The offer supplies the enclave key and SLA without a live rendezvous; the agent receipt key countersigns the exact acceptance terms. |
| [RPC] | 9 | `force_open` | `miner: sp_core::crypto::AccountId32 (#0)`; `model_hash: primitive_types::H256 (#13)`; `measured_root: primitive_types::H256 (#13)`; `decode_policy_hash: primitive_types::H256 (#13)`; `precision: pallet_model_registry::types::ModelPrecision (#246)`; `agent_key: [u8;32]`; `sla: pallet_compute_channel::pallet::Sla (#294)`; `escrow: u128`; `nonce: u64` | **Permissionless open** (escape hatch). The agent escrows the reserved-capacity payment and posts session params against a *named* miner it has not handshaked with off-chain. The channel enters [`ChannelState::PendingAck`]; the named miner has [`Config::AckWindow`] blocks to `force_ack` (metadata reference: Pallet::force_ack) with its session signing key, or anyone may `expire_force_open` (metadata reference: Pallet::expire_force_open) for a full refund. No enclave key is bound here — there has been no handshake yet. |
| [RPC] | 10 | `force_ack` | `channel_id: primitive_types::H256 (#13)`; `enclave_key: [u8;32]` | **Acknowledge a `force_open`** (named miner only). Binds the miner's caller-supplied `enclave_key` session signing key and transitions [`ChannelState::PendingAck`] → [`ChannelState::Open`]; the pallet does not verify TEE provenance. The SLA clock (re)starts from the ack block. Must land before the ack window elapses. |
| [RPC] | 41 | `register_session_evidence` | `channel_id: primitive_types::H256 (#13)`; `slot: pallet_compute_channel::SessionEvidenceSlot (#314)`; `commitment: primitive_types::H256 (#13)`; `size_bytes: u32` | Allocate one immutable activation or final-transcript DA slot for a funded Open channel (D-0412). Bytes stay off chain; this neither submits the TOPLOC marker nor authorizes proof acceptance or payment. |
| [RPC] | 21 | `submit_toploc_evidence` | `channel_id: primitive_types::H256 (#13)`; `commitment_ref: primitive_types::H256 (#13)` | **Submit a TOPLOC activation commitment** (#753 / D-0431). The miner records the DA reference of the TOPLOC commitment it published for this session. This is the settlement-gate evidence: a channel whose assurance class requires TOPLOC cannot `settle` (metadata reference: Pallet::settle) / [`certificate_settle`] / [`force_settle`] until at least one commitment is on record. It does not itself adjudicate the band (that stays on the reactive `report_toploc_*` path, fail-closed per cell until #748) — commitment presence is the D-0431 floor. |
| [RPC] | 11 | `expire_force_open` | `channel_id: primitive_types::H256 (#13)` | **Expire an unacked `force_open`** (permissionless). If the named miner did not ack by `ack_deadline`, refund the agent's full escrow, close the channel, release the weights pin, and record the miner-side reputational event when the escrow is not dust ([`FailedAcks`] += 1, [`Event::ForceOpenExpired`]). No slash — a missed ack is unavailability, not fraud. |
| [RPC] | 12 | `set_toploc_model_tolerance` | `model_hash: primitive_types::H256 (#13)`; `tolerance: hp_poui::toploc::ToplocTolerance (#315)` | **Calibrate a model's TOPLOC tolerance band** (governance / root). The band is model-owned, never miner-supplied; [`Pallet::report_toploc_mismatch`] judges attested distances against it. Disputes fail closed when unset. |
| [RPC] | 16 | `set_toploc_model_band_constants` | `model_hash: primitive_types::H256 (#13)`; `precision: pallet_model_registry::types::ModelPrecision (#246)`; `constants: hp_poui::toploc::ToplocBandConstants (#316)` | **Commit derived TOPLOC band constants** for a (model, precision) pair (governance / root). Constants are κ-derived governance inputs (not compiled defaults). When set, the report path consumes [`band_verdict_from_constants`] for Accept/Escalate/Slash/Unavailable.  # Activation ordering (operational safety)  Once band constants exist for a (model, precision), the band lane **fully supersedes** the legacy lane-distance path in [`resolve_toploc_report`]: the verdict is decided solely by the signed `milli_exponent_error`. Validators on pre-band software omit that field, so it decodes as `0`, and `band_verdict_from_constants(_, 0)` → [`BandVerdict::Accept`] → every mismatch report for that model fails closed with `ToplocVerifierAccepted` (no slash on either lane). This zero is indistinguishable on-chain from a legitimately in-band `0`, so it cannot be guarded here. Governance MUST therefore activate band constants only after the active validator fleet emits a real `milli_exponent_error`: upgrade the validators first, activate the constants second. |
| [RPC] | 13 | `report_toploc_mismatch` | `channel_id: primitive_types::H256 (#13)`; `miner: sp_core::crypto::AccountId32 (#0)`; `attestations: Vec<hp_poui::toploc::ToplocMismatchAttestation (#318)>` | **Report a TOPLOC tier-2 mismatch** on one turn of a session (§3.4/§3.6). Anyone may relay the bundle; authority comes from the in-bundle BFT quorum of active validators, not the submitter. Each validator independently fetched the miner's per-turn activation commitment from DA, re-ran the prefill, and signed the recomputed distance. When a quorum agrees on out-of-band evidence the verdict is identical to a defaulted transcript fraud ([`Pallet::resolve_timeout_dispute`]): slash the miner via the forgery path, refund the agent's escrow in full, and close the channel.  When derived-band constants are set for the channel's (model, precision), the signed `milli_exponent_error` is judged by [`band_verdict_from_constants`]: Escalate emits [`Event::ToplocEscalationRequested`] without slash; Slash still requires this quorum and then runs the forgery path. |
| [RPC] | 14 | `report_toploc_mismatch_claim` | `channel_id: primitive_types::H256 (#13)`; `miner: sp_core::crypto::AccountId32 (#0)`; `turn_index: u32`; `activation_hash: primitive_types::H256 (#13)`; `recomputed_hash: primitive_types::H256 (#13)`; `distance: hp_poui::toploc::ToplocDistance (#319)`; `milli_exponent_error: u64`; `claim: hp_poui::AttestClaim (#202)` | **Report a TOPLOC mismatch using the shared attestation-result primitive.** The claim is verified against the profile pinned when the channel opened; profile churn or unknown profiles fail closed. The off-chain evidence and normalized claims stay off-chain, committed by `evidence_hash` and `claims_root`; the on-chain subject binds this exact channel-turn evidence.  When derived-band constants are set, `milli_exponent_error` is a verdict input (Escalate ≠ slash). Slash still requires a Fraud claim + quorum. |
| [RPC] | 22 | `resolve_toploc_escalation` | `channel_id: primitive_types::H256 (#13)`; `clear_sigs: Vec<([u8;32], [u8;64])>` | **Clear a TOPLOC escalation** (#754). An active-validator quorum vouches that the deeper re-check exonerated the miner (the escalated turn is not fraud): the case is closed and settlement unfreezes. `clear_sigs` are sr25519 signatures by distinct active validators over `(channel_id, turn_index, ESCALATION_CLEAR_TAG)`, meeting the same `ceil(active × ValidatorAttestationThreshold)` quorum as a mismatch report. |
| [RPC] | 23 | `expire_toploc_escalation` | `channel_id: primitive_types::H256 (#13)` | **Time out a TOPLOC escalation** (#754, permissionless). After the response window elapses with no terminal verdict (no stronger report upheld fraud, no quorum clear), resolve the case as **inconclusive**: refund the agent's full escrow, close the channel, credit no `G_n`, slash nothing. Conserves escrow/bonds and never silently accepts fraud (the miner is not paid). |
| [RPC] | 24 | `claim_audit_fee` | `channel_id: primitive_types::H256 (#13)`; `evidence: primitive_types::H256 (#13)` | **Claim an audit fee** (#846). A validator that has performed audit work on a settled channel submits its evidence (`evidence`, a non-zero attestation commitment) and claims [`Config::AuditFeePerTurn`] from the audit pool funded by the 1% session-fee earmark.  Fail-closed, no unpaid-duty path: - caller must be an active validator (VRF-assignment binding is a follow-up;   the attestation evidence gates the claim today), - evidence must be present (no evidence → no pay), - one paid claim per `(channel_id, validator)` (no drain by re-claim), - the pool must fund the fee (a duty is never assigned the pool cannot pay).  Surplus stays in the pool for the standard validator distribution (a follow-up sweep); the earmark→claim split never creates or destroys value (conservation). |
| [RPC] | 44 | `list_forward_units` | `channel_id: primitive_types::H256 (#13)`; `units: u128`; `total_price: u128`; `expires_at: u32` | Lock a holder's outgoing rights behind one exact-price, whole-fill listing. |
| [RPC] | 45 | `fill_forward_listing` | `channel_id: primitive_types::H256 (#13)`; `seller: sp_core::crypto::AccountId32 (#0)`; `listing_id: primitive_types::H256 (#13)`; `max_total_price: u128` | Atomically consume the listing, move holder rights and pay the seller in FLOP. |
| [RPC] | 46 | `cancel_forward_listing` | `channel_id: primitive_types::H256 (#13)`; `seller: sp_core::crypto::AccountId32 (#0)`; `listing_id: primitive_types::H256 (#13)` | Seller cancellation, or one-record permissionless cleanup after expiry/termination. |

#### Storage

| Evidence | Storage prefix / item | Modifier | Hashers in key order | Key SCALE type | Stored value SCALE type | Purpose |
|---|---|---|---|---|---|---|
| [RPC] | `ComputeChannel.Channels` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `pallet_compute_channel::pallet::Channel (#805)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `ComputeChannel.FcuServiceProfiles` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `pallet_compute_channel::fcu_service::FcuServiceProfile (#307)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `ComputeChannel.FcuServiceQualifications` | Optional | Blake2_128Concat, Blake2_128Concat | `(primitive_types::H256 (#13), primitive_types::H256 (#13))` | `pallet_compute_channel::fcu_service::FcuProfileQualification (#308)` | Immutable qualification revisions remain addressable by sold commitments. |
| [RPC] | `ComputeChannel.FcuServiceProfileStatus` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `pallet_compute_channel::fcu_service::FcuProfileStatus (#310)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `ComputeChannel.FcuBlockTimestamp` | Optional | plain | `—` | `(u32, u64)` | Written by the validated Timestamp inherent hook, never by a user extrinsic. |
| [RPC] | `ComputeChannel.ForwardOfferEconomics` | Optional | Blake2_128Concat, Blake2_128Concat | `(sp_core::crypto::AccountId32 (#0), u64)` | `pallet_compute_channel::FcuEmpiricalParams (#306)` | Economics fixed when the provider first funds an offer. |
| [RPC] | `ComputeChannel.ForwardBidEconomics` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `pallet_compute_channel::FcuEmpiricalParams (#306)` | Economics fixed when the purchaser first funds a bid. |
| [RPC] | `ComputeChannel.ForwardEconomics` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `pallet_compute_channel::FcuEmpiricalParams (#306)` | Inherited economics; global updates affect future funded obligations only. |
| [RPC] | `ComputeChannel.ForwardListings` | Optional | Blake2_128Concat, Blake2_128Concat | `(primitive_types::H256 (#13), sp_core::crypto::AccountId32 (#0))` | `pallet_compute_channel::pallet::ForwardListing (#808)` | At most one listing per holder, hence bounded by MaxForwardHolders per channel. |
| [RPC] | `ComputeChannel.ForwardListingNonce` | Default | Blake2_128Concat | `primitive_types::H256 (#13)` | `u64` | Permanent channel-scoped sequence; never reset by cancellation, fill or cleanup. |
| [RPC] | `ComputeChannel.ChannelAuthoredOpenedAt` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `u32` | Authored opening height for work capacity; reset on `force_ack`.  Kept outside Channel so old SCALE values and finalized deadlines stay intact.  Absence explicitly selects the legacy mixed-clock capacity contract.  Retained with the permanent Channels record, including after closure. |
| [RPC] | `ComputeChannel.Disputes` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `pallet_compute_channel::pallet::Dispute (#809)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `ComputeChannel.ToplocModelTolerance` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `hp_poui::toploc::ToplocTolerance (#315)` | Governance-calibrated TOPLOC tolerance band per logical model hash. A TOPLOC  mismatch dispute judges the attested distance against this band (model-owned,  never miner-supplied), so a miner cannot widen its own acceptance window  (§3.4). Absent ⇒ the model is not calibrated and disputes fail closed.   This is the **lane-distance** band (`ToplocTolerance`). The derived  two-threshold band lives in [`ToplocModelBandConstants`] — a different metric. |
| [RPC] | `ComputeChannel.ToplocModelBandConstants` | Optional | Blake2_128Concat, Blake2_128Concat | `(primitive_types::H256 (#13), pallet_model_registry::types::ModelPrecision (#246))` | `hp_poui::toploc::ToplocBandConstants (#316)` | Governance-committed derived TOPLOC band constants per (model, precision).  Fields: `kappa_profile_hash`, `band_tau_accept`, `band_tau_slash`,  `challenge_k`, `challenge_window_w`. Consumed by [`band_verdict_from_constants`]  on the report path. Absent ⇒ derived band unavailable (lane path may still  apply via [`ToplocModelTolerance`]). New map — no migration of existing storage. |
| [RPC] | `ComputeChannel.SettlementClasses` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `pallet_compute_channel::pallet::SettlementClass (#295)` | #534/#535: settlement class per channel, written at open. Kept OUT of the  `Channel` struct so existing stored channels decode unchanged (no migration);  absent ⇒ `Standard` (fail closed: never certificate-eligible by default). |
| [RPC] | `ComputeChannel.SettlementTariffPay` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `u128` | #719: two-part tariff pay amount for a posted unilateral settlement  (`BasePerTurn · turn_count + Σ G_n`). Written at `force_settle`, read by  `finalize`, removed on close. Kept OUT of `Channel` / `ChannelState::Settling`  so existing SCALE decoding is unchanged.  Version 2 lazily materializes explicitly eligible legacy claims on use;  current marker-backed missing tariffs fail closed. |
| [RPC] | `ComputeChannel.LegacyTariffEligibilityEnabled` | Default | plain | `—` | `bool` | Enabled once by the v1→v2 upgrade, never for fresh v2 genesis. |
| [RPC] | `ComputeChannel.SettlementTariffInitialized` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `()` | A tariff was materialized or posted under v2. Retained with closed Channels  so deleting a tariff can never restore legacy eligibility. |
| [RPC] | `ComputeChannel.SettledTurns` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `u32` | Committed bisection domain (power-of-two leaf count of the settled  transcript tree) pinned at `force_settle`, read by  `open_bisection_dispute` (metadata reference: Pallet::open_bisection_dispute), removed on  close. Binds the challenger's `n_turns` to the real tree shape so an  over-claim cannot drive `parent_root` onto a leaf and force the honest  miner into an unanswerable `respond_bisection` (a false slash). Kept OUT  of `Channel` / `ChannelState::Settling` so existing SCALE decoding is  unchanged (no migration). |
| [RPC] | `ComputeChannel.SettledTurnIndices` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `bounded_collections::bounded_vec::BoundedVec (#810)` | Turn indices verified at the current `force_settle` post (sorted), pinned and  removed with [`SettledTurns`]. A dispute may only name one of these: the miner  can always answer a turn it posted (the same leaf and path), and no other index  is answerable, so an unbounded `contested_turn` would let the response timeout  slash an honest miner for fraud. Absent for a channel settled before this entry  existed, which therefore rejects disputes until the settlement is reposted.  Kept out of `Channel` so existing SCALE decoding is unchanged (no migration). |
| [RPC] | `ComputeChannel.ToplocMismatchProfiles` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `hp_poui::AttestProfileRef (#410)` | Attestation profile pinned at channel creation for the shared TOPLOC claim path.  Legacy validator bundles remain accepted separately; missing profile ⇒ the new  claim path fails closed without changing existing channel encoding. |
| [RPC] | `ComputeChannel.ChannelAssuranceClass` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `pallet_compute_channel::AssuranceClass (#444)` | #753 / D-0431: assurance class pinned per channel at open. Present ⇒ the channel  was opened post-upgrade and is subject to the required-TOPLOC-evidence settle  gate; **absent ⇒ a pre-upgrade channel**, grandfathered out of the gate so  in-flight legacy channels still settle (same idiom as [`ChannelDecodePolicies`]).  New map — no migration of existing storage. |
| [RPC] | `ComputeChannel.ChannelToplocEvidence` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `pallet_compute_channel::ToplocEvidence (#811)` | #753: TOPLOC activation-commitment evidence submitted for a channel (the  settlement-gate marker). Written by [`Pallet::submit_toploc_evidence`], read by  the settle gate, removed on close. Absent (on a TOPLOC-required channel) ⇒  settlement fails closed. New map — no migration. |
| [RPC] | `ComputeChannel.SessionEvidenceRegistrations` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `(bounded_collections::bounded_vec::BoundedVec (#813), Option (#816))` | At most SLA max_turns activation allocations plus one final transcript.  New side map: historical Channel/Dispute/receipt encodings are unchanged.  Removed on every terminal close; DA records retain their original expiry. |
| [RPC] | `ComputeChannel.ToplocEscalations` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `pallet_compute_channel::pallet::ToplocEscalation (#817)` | #754: an open TOPLOC escalation case for a channel. The middle band verdict  (`BandVerdict::Escalate` — deviation between the accept and slash thresholds) is  neither acceptance nor immediate slash, so it must not silently let the miner  settle. Opening a case **freezes settlement** (`ensure_no_open_escalation`) until  a terminal verdict: escalate-to-slash (a stronger report upholds fraud), a  validator-quorum **clear** ([`Pallet::resolve_toploc_escalation`]), or **timeout**  ([`Pallet::expire_toploc_escalation`] → inconclusive full refund, no miner pay, no  slash). New map — no migration of existing storage. |
| [RPC] | `ComputeChannel.FailedAcks` | Default | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `u32` | Miner-side reputational counter: number of non-dust [`Pallet::force_open`]s a  miner let expire by failing to [`Pallet::force_ack`] in time. The off-chain  discovery / reputation layer reads this (matching moved off-chain —  reputation is load-bearing). A missed ack is unavailability, not fraud, so  this is never a slash. |
| [RPC] | `ComputeChannel.UsedOfferNonces` | Optional | Blake2_128Concat, Blake2_128Concat | `(sp_core::crypto::AccountId32 (#0), u64)` | `primitive_types::H256 (#13)` | Permanent replay tombstone for each accepted miner offer. One entry is  written per offer-backed channel, matching the already-permanent channel  record; expiry bounds stale signatures while the tombstone prevents reuse. |
| [RPC] | `ComputeChannel.FailedOfferOpens` | Default | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `u32` | Miner-side reputational counter for signed offer capacity that timed out  without any settlement. This is weak, unattributed availability evidence,  never a slash or a standalone ranking input. |
| [RPC] | `ComputeChannel.FcuEmpiricalParameters` | Optional | plain | `—` | `pallet_compute_channel::FcuEmpiricalParams (#306)` | No genesis or fallback economics: absence keeps the forward surface disabled. |
| [RPC] | `ComputeChannel.FcuMassSlashPaused` | Optional | plain | `—` | `bool` | An explicit governance unpause is required before FCU default slashing. |
| [RPC] | `ComputeChannel.FcuPrimaryAdmissionsPaused` | Default | plain | `—` | `bool` | New financial exposure is paused by default; existing obligations can drain. |
| [RPC] | `ComputeChannel.ForwardBidSeals` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `(u32, u64)` | Authored block and BABE epoch at registration seal; separate from legacy bid encoding.  Pruned with its bid on clear/cancel. |
| [RPC] | `ComputeChannel.ForwardBidEpochEntropy` | Optional | Twox64Concat | `u8` | `(u64, primitive_types::H256 (#13), u32)` | Epoch-tagged entropy ring. The runtime adapter writes six u8 slots only;  a slot is reused after every dependent bid's fixed execution window expires. |
| [RPC] | `ComputeChannel.FundedForwardOffers` | Optional | Blake2_128Concat, Blake2_128Concat | `(sp_core::crypto::AccountId32 (#0), u64)` | `pallet_compute_channel::pallet::FundedForwardOffer (#819)` | Miner-funded forward offers awaiting one countersigned pickup. |
| [RPC] | `ComputeChannel.ForwardPositions` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `pallet_compute_channel::pallet::ForwardPosition (#820)` | Forward accounting kept outside the legacy channel value for decode compatibility. |
| [RPC] | `ComputeChannel.ForwardChannelsByMiner` | Default | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `bounded_collections::bounded_vec::BoundedVec (#821)` | Bounded reverse index used by Ghost-task callbacks. |
| [RPC] | `ComputeChannel.ForwardHolderUnits` | Default | Blake2_128Concat, Blake2_128Concat | `(primitive_types::H256 (#13), sp_core::crypto::AccountId32 (#0))` | `u128` | Economic rights are always units, including the launch-time bilateral holder. |
| [RPC] | `ComputeChannel.ForwardHolderCount` | Default | Blake2_128Concat | `primitive_types::H256 (#13)` | `u32` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `ComputeChannel.ForwardDistributions` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `pallet_compute_channel::pallet::ForwardDistribution (#822)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `ComputeChannel.ForwardDraws` | Optional | Blake2_128Concat, Blake2_128Concat | `(primitive_types::H256 (#13), primitive_types::H256 (#13))` | `pallet_compute_channel::pallet::ForwardDraw (#823)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `ComputeChannel.ForwardActiveUnits` | Default | Blake2_128Concat | `primitive_types::H256 (#13)` | `u128` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `ComputeChannel.ForwardHolderActiveUnits` | Default | Blake2_128Concat, Blake2_128Concat | `(primitive_types::H256 (#13), sp_core::crypto::AccountId32 (#0))` | `u128` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `ComputeChannel.ForwardDrawCount` | Default | Blake2_128Concat | `primitive_types::H256 (#13)` | `u32` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `ComputeChannel.ForwardBids` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `pallet_compute_channel::pallet::ForwardBid (#824)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `ComputeChannel.ForwardBidClaims` | Optional | Blake2_128Concat, Blake2_128Concat | `(primitive_types::H256 (#13), sp_core::crypto::AccountId32 (#0))` | `pallet_compute_channel::pallet::ForwardBidClaim (#826)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `ComputeChannel.UsedForwardBidNonces` | Optional | Blake2_128Concat, Blake2_128Concat | `(sp_core::crypto::AccountId32 (#0), u64)` | `()` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `ComputeChannel.TotalEscrowReserved` | Default | plain | `—` | `u128` | Telemetry / conservation counters (smallest unit). |
| [RPC] | `ComputeChannel.TotalMinerPaid` | Default | plain | `—` | `u128` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `ComputeChannel.TotalBurned` | Default | plain | `—` | `u128` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `ComputeChannel.TotalRefunded` | Default | plain | `—` | `u128` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `ComputeChannel.TotalGnCredited` | Default | plain | `—` | `u128` | Historical public credit. Retained for storage compatibility; current-profile  channel payouts never increase it (YP R11.2b). |
| [RPC] | `ComputeChannel.TotalForwardBondLocked` | Default | plain | `—` | `u128` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `ComputeChannel.TotalForwardBondReleased` | Default | plain | `—` | `u128` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `ComputeChannel.TotalForwardBondSlashed` | Default | plain | `—` | `u128` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `ComputeChannel.TotalAuditEarmarked` | Default | plain | `—` | `u128` | #846: cumulative amount earmarked into the audit pool from settlements (1% of each  miner payment). The available pool = `TotalAuditEarmarked − TotalAuditPaid`, held  in the pallet's sovereign account. Conservation counter. |
| [RPC] | `ComputeChannel.TotalAuditPaid` | Default | plain | `—` | `u128` | #846: cumulative audit fees paid out to validators from the pool. |
| [RPC] | `ComputeChannel.AuditClaimed` | Optional | Blake2_128Concat, Blake2_128Concat | `(primitive_types::H256 (#13), sp_core::crypto::AccountId32 (#0))` | `()` | #846: double-claim guard — validators already paid for auditing a settled channel.  Keyed `(channel_id, validator)`. One paid audit verdict per validator per channel. |
| [RPC] | `ComputeChannel.ActiveReservationCount` | Default | Blake2_128Concat | `sp_core::crypto::AccountId32 (#0)` | `u32` | Per-agent (signer AccountId) count of active reservations (Open or PendingAck from force_open).  Bounded (u32); incremented on reserve at open/force_open (post-escrow), decremented on all close paths (settle/timeout/expire/fraud).  Enables the A1 per-identity cap. |
| [RPC] | `ComputeChannel.ChannelCalibrationSnapshots` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `pallet_compute_channel::CalibrationSnapshot (#827)` | Cap/tier/version captured when a channel becomes open. Kept outside  `Channel<T>` to preserve legacy channel SCALE decoding. |
| [RPC] | `ComputeChannel.ChannelModelArch` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `Option (#102)` | Separate architecture snapshot. Missing entry is a legacy channel;  Some(None) records an explicitly unconfigured model at creation.  Retained with the channel tombstone; historical Channel encoding is unchanged. |
| [RPC] | `ComputeChannel.ChannelDecodePolicies` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `primitive_types::H256 (#13)` | Decode policy pinned when a channel is opened. Missing means a pre-upgrade  channel, so explicit V1/V0 versions remain allowed only for that channel. |
| [RPC] | `ComputeChannel.ChannelWireProfiles` | Optional | Blake2_128Concat | `primitive_types::H256 (#13)` | `u8` | Encoding profile pinned at channel creation. Missing identifies an  in-flight pre-E.51 channel; unknown values fail closed. |
| [RPC] | `ComputeChannel.ChallengeWindowExtensions` | Default | Blake2_128Concat | `primitive_types::H256 (#13)` | `u8` | Number of objective degraded-state extensions already granted for a channel.  Kept outside `Channel<T>` so existing channel SCALE encoding stays stable. |

#### Events

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `ChannelOpened` | `channel_id: primitive_types::H256 (#13)`; `agent: sp_core::crypto::AccountId32 (#0)`; `miner: sp_core::crypto::AccountId32 (#0)`; `escrow: u128`; `measured_root: primitive_types::H256 (#13)` | A channel was opened; escrow reserved. Emitted by both the cooperative [`Pallet::open_channel`] and on [`Pallet::force_ack`]. |
| [RPC] | 1 | `OfferAccepted` | `channel_id: primitive_types::H256 (#13)`; `miner: sp_core::crypto::AccountId32 (#0)`; `offer_nonce: u64`; `expiry: u32` | A signed standing offer was accepted and opened directly as `Open`. |
| [RPC] | 2 | `OfferOpenFailed` | `channel_id: primitive_types::H256 (#13)`; `miner: sp_core::crypto::AccountId32 (#0)`; `failed_offer_opens: u32` | An offer-backed channel reached the non-delivery timeout. The cumulative counter changes only above the dust threshold and remains weak evidence because the timeout cannot attribute agent abandonment versus miner failure. |
| [RPC] | 3 | `ForwardOfferFunded` | `miner: sp_core::crypto::AccountId32 (#0)`; `offer_nonce: u64`; `bond: u128`; `start_block: u32`; `end_block: u32` | A miner locked the bond backing a signed forward offer. |
| [RPC] | 4 | `ForwardOfferCancelled` | `miner: sp_core::crypto::AccountId32 (#0)`; `offer_nonce: u64`; `bond_released: u128` | An unused funded forward offer was cancelled after signature expiry. |
| [RPC] | 5 | `ForwardChannelOpened` | `channel_id: primitive_types::H256 (#13)`; `agent: sp_core::crypto::AccountId32 (#0)`; `miner: sp_core::crypto::AccountId32 (#0)`; `start_block: u32`; `end_block: u32`; `duration_seconds: u64`; `quota_total: u128`; `price_per_gn: u128`; `payment: u128`; `bond: u128` | A funded forward offer became the bonded channel redemption vehicle. |
| [RPC] | 6 | `ForwardAvailabilityClaimed` | `channel_id: primitive_types::H256 (#13)`; `amount: u128`; `cumulative: u128` | Lazy availability earnout paid against elapsed, successful Ghost evidence. |
| [RPC] | 7 | `ForwardBondReleased` | `channel_id: primitive_types::H256 (#13)`; `delivered_gn: u128`; `amount: u128`; `cumulative: u128` | Delivery evidence released the matching cumulative bond fraction. |
| [RPC] | 8 | `ForwardAssigned` | `channel_id: primitive_types::H256 (#13)`; `previous_agent: sp_core::crypto::AccountId32 (#0)`; `new_agent: sp_core::crypto::AccountId32 (#0)` | The buyer assigned the remaining forward position to a countersigning account. |
| [RPC] | 9 | `ForwardUnitsTransferred` | `channel_id: primitive_types::H256 (#13)`; `from: sp_core::crypto::AccountId32 (#0)`; `to: sp_core::crypto::AccountId32 (#0)`; `units: u128`; `from_remaining: u128`; `to_total: u128` | Divisible rights moved without changing the underlying bonded channel. |
| [RPC] | 10 | `ForwardDistributionClaimed` | `channel_id: primitive_types::H256 (#13)`; `holder: sp_core::crypto::AccountId32 (#0)`; `units: u128`; `amount: u128` | One holder pulled its linear share of terminal refunds/damages. |
| [RPC] | 11 | `ForwardDrawOpened` | `channel_id: primitive_types::H256 (#13)`; `draw_id: primitive_types::H256 (#13)`; `holder: sp_core::crypto::AccountId32 (#0)`; `units: u128`; `aggregate_units: u128` | A holder admitted a non-preemptible sub-stream under the shared rate cap. |
| [RPC] | 12 | `ForwardDrawClosed` | `channel_id: primitive_types::H256 (#13)`; `draw_id: primitive_types::H256 (#13)`; `units: u128`; `aggregate_units: u128` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 13 | `ForwardBidPosted` | `bid_id: primitive_types::H256 (#13)`; `buyer: sp_core::crypto::AccountId32 (#0)`; `payment: u128`; `commit_deadline: u32` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 14 | `ForwardBidClaimCommitted` | `bid_id: primitive_types::H256 (#13)`; `miner: sp_core::crypto::AccountId32 (#0)`; `bond: u128` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 15 | `ForwardBidClaimsSealed` | `bid_id: primitive_types::H256 (#13)`; `claimant_count: u32`; `reveal_deadline: u32` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 16 | `ForwardBidClaimRevealed` | `bid_id: primitive_types::H256 (#13)`; `miner: sp_core::crypto::AccountId32 (#0)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 17 | `ForwardBidCleared` | `bid_id: primitive_types::H256 (#13)`; `channel_id: primitive_types::H256 (#13)`; `winner: sp_core::crypto::AccountId32 (#0)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 18 | `ForwardBidCancelled` | `bid_id: primitive_types::H256 (#13)`; `buyer: sp_core::crypto::AccountId32 (#0)`; `payment_released: u128` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 19 | `ForwardSettled` | `channel_id: primitive_types::H256 (#13)`; `outcome: pallet_compute_channel::pallet::ForwardOutcome (#441)`; `delivered_gn: u128`; `miner_paid: u128`; `buyer_refunded: u128`; `buyer_damages: u128`; `backup_bounty: u128`; `bond_released: u128`; `bond_slashed: u128` | Terminal forward term-tape row. |
| [RPC] | 20 | `ForceOpenRequested` | `channel_id: primitive_types::H256 (#13)`; `agent: sp_core::crypto::AccountId32 (#0)`; `miner: sp_core::crypto::AccountId32 (#0)`; `escrow: u128`; `ack_deadline: u32` | A permissionless [`Pallet::force_open`] was posted; escrow reserved and the named miner has until `ack_deadline` to [`Pallet::force_ack`]. |
| [RPC] | 21 | `ForceOpenExpired` | `channel_id: primitive_types::H256 (#13)`; `miner: sp_core::crypto::AccountId32 (#0)`; `refunded: u128`; `failed_acks: u32` | A `force_open` expired unacked: the agent was refunded. `failed_acks` is the miner's counter after applying the non-dust threshold. |
| [RPC] | 22 | `EscrowToppedUp` | `channel_id: primitive_types::H256 (#13)`; `added: u128`; `total: u128` | Escrow topped up in place (splice-in). |
| [RPC] | 23 | `Settled` | `channel_id: primitive_types::H256 (#13)`; `miner_paid: u128`; `burned: u128`; `aggregate_gn: u128`; `cooperative: bool` | A channel settled (paid out) — cooperatively or after the window. |
| [RPC] | 24 | `SettlementPosted` | `channel_id: primitive_types::H256 (#13)`; `final_root: primitive_types::H256 (#13)`; `aggregate_gn: u128`; `challenge_end: u32` | A unilateral settlement was posted; challenge window open. |
| [RPC] | 25 | `TimedOutRefunded` | `channel_id: primitive_types::H256 (#13)`; `refunded: u128` | Non-delivery timeout: escrow refunded to the agent. |
| [RPC] | 26 | `DisputeOpened` | `channel_id: primitive_types::H256 (#13)`; `challenger: sp_core::crypto::AccountId32 (#0)`; `contested_turn: u32` | A fraud dispute was opened. |
| [RPC] | 27 | `BisectionOpened` | `channel_id: primitive_types::H256 (#13)`; `challenger: sp_core::crypto::AccountId32 (#0)`; `lo: u32`; `hi: u32` | Multi-round bisection opened over turn interval `[lo, hi]`. |
| [RPC] | 28 | `BisectionResponded` | `channel_id: primitive_types::H256 (#13)`; `lo: u32`; `hi: u32`; `left_root: primitive_types::H256 (#13)`; `right_root: primitive_types::H256 (#13)` | Miner posted midpoint child roots for the active interval. |
| [RPC] | 29 | `BisectionChallenged` | `channel_id: primitive_types::H256 (#13)`; `lo: u32`; `hi: u32`; `rounds: u32` | Challenger picked a half; interval narrowed (or leaf isolated). |
| [RPC] | 30 | `DisputeDismissed` | `channel_id: primitive_types::H256 (#13)` | The miner answered a challenge with a valid transcript leaf; dispute dismissed (challenger forfeits bond to the miner). |
| [RPC] | 31 | `FraudUpheld` | `channel_id: primitive_types::H256 (#13)`; `miner: sp_core::crypto::AccountId32 (#0)`; `slashed: u128` | Fraud upheld: the miner was slashed and the agent refunded. |
| [RPC] | 32 | `ToplocModelToleranceSet` | `model_hash: primitive_types::H256 (#13)`; `tolerance: hp_poui::toploc::ToplocTolerance (#315)` | Governance set/updated a model's calibrated TOPLOC tolerance band. |
| [RPC] | 33 | `ToplocModelBandConstantsSet` | `model_hash: primitive_types::H256 (#13)`; `precision: pallet_model_registry::types::ModelPrecision (#246)`; `constants: hp_poui::toploc::ToplocBandConstants (#316)` | Governance set/updated derived TOPLOC band constants for (model, precision). |
| [RPC] | 34 | `ToplocFraudUpheld` | `channel_id: primitive_types::H256 (#13)`; `turn_index: u32`; `miner: sp_core::crypto::AccountId32 (#0)`; `slashed: u128`; `validators: u32` | A validator quorum proved a TOPLOC tier-2 mismatch on a session turn: the miner was slashed (forgery path), the agent refunded, and the channel closed. |
| [RPC] | 35 | `ToplocEscalationRequested` | `channel_id: primitive_types::H256 (#13)`; `turn_index: u32`; `miner: sp_core::crypto::AccountId32 (#0)`; `milli_exponent_error: u64`; `validators: u32` | Derived-band verdict is Escalate: second-verifier recompute requested. No slash — honest-but-unlucky hardware lands here (derivation §3). |
| [RPC] | 36 | `ToplocEscalationOpened` | `channel_id: primitive_types::H256 (#13)`; `turn_index: u32`; `deadline: u32` | #754: a TOPLOC escalation case was opened; settlement is frozen until a terminal verdict (slash / clear / timeout). |
| [RPC] | 37 | `ToplocEscalationCleared` | `channel_id: primitive_types::H256 (#13)`; `turn_index: u32`; `validators: u32` | #754: a validator quorum cleared the escalation (deeper re-check passed); settlement is unfrozen. |
| [RPC] | 38 | `ToplocEscalationTimedOut` | `channel_id: primitive_types::H256 (#13)`; `turn_index: u32`; `refunded: u128` | #754: the escalation window elapsed with no terminal verdict; resolved inconclusive — agent refunded in full, channel closed, no miner pay, no slash. |
| [RPC] | 39 | `CertificateSettled` | `channel_id: primitive_types::H256 (#13)`; `aggregate_gn: u128`; `cert_commitment: primitive_types::H256 (#13)` | #535: a premium channel settled against a verified work certificate (always paired with the `Settled` event from the shared payout path). |
| [RPC] | 40 | `CalibrationSnapshotted` | `channel_id: primitive_types::H256 (#13)`; `miner: sp_core::crypto::AccountId32 (#0)`; `cap_gflops_per_sec: u64`; `assurance_tier: pallet_compute_channel::AssuranceTier (#442)`; `calibration_version: u32`; `soft_tier_spot_check_rate_ppm: u32` | Calibration cap/tier/version was captured for a newly open channel. |
| [RPC] | 41 | `ToplocAttestClaimAccepted` | `channel_id: primitive_types::H256 (#13)`; `profile: hp_poui::AttestProfileRef (#410)`; `verdict: hp_poui::AttestVerdict (#203)` | A shared attestation-result claim was accepted for a TOPLOC fraud verdict. |
| [RPC] | 42 | `ChallengeWindowExtended` | `channel_id: primitive_types::H256 (#13)`; `reason: pallet_compute_channel::pallet::SettlementDegradeReason (#443)`; `new_deadline: u32`; `extensions: u8` | An objective component outage extended the challenge/response window. |
| [RPC] | 43 | `DegradedRefunded` | `channel_id: primitive_types::H256 (#13)`; `reason: pallet_compute_channel::pallet::SettlementDegradeReason (#443)`; `refunded: u128` | Neutral DA became unrecoverable before settlement could be safely challenged with no co-signed payable split available; fail closed by refunding full escrow without a miner fraud slash. |
| [RPC] | 44 | `UnrecoverableTranscriptVoided` | `channel_id: primitive_types::H256 (#13)`; `miner_paid: u128`; `agent_refunded: u128`; `aggregate_gn: u128` | ENG-7: unrecoverable transcript void. No fraud verdict; challenger bond returned; channel closes at the last co-signed receipt — miner paid only the receipt-bound payable, agent refunded the unsigned tail, `aggregate_gn` credited from that receipt only. DA providers are not re-slashed here. |
| [RPC] | 45 | `AssuranceClassPinned` | `channel_id: primitive_types::H256 (#13)`; `class: pallet_compute_channel::AssuranceClass (#444)` | #753 / D-0431: assurance class pinned at channel open (disclosed to agents / discovery). `TeeToploc` = TOPLOC required for all sessions. |
| [RPC] | 46 | `ToplocEvidenceSubmitted` | `channel_id: primitive_types::H256 (#13)`; `miner: sp_core::crypto::AccountId32 (#0)`; `commitment_ref: primitive_types::H256 (#13)`; `turns_committed: u32` | #753: a TOPLOC activation commitment was recorded for the channel — the settlement-gate evidence marker. |
| [RPC] | 47 | `AuditDataForfeited` | `channel_id: primitive_types::H256 (#13)`; `miner: sp_core::crypto::AccountId32 (#0)`; `agent_refunded: u128`; `slashed: u128`; `window_value: u128` | #844 publish-or-forfeit: a value window finalized with no published audit blob. The miner is paid nothing (agent fully refunded) and slashed a bounded liveness forfeit (≥ window value) — distinct from a fraud slash, and distinct from the ENG-7 DA-loss void (which pays the co-signed receipt). |
| [RPC] | 48 | `AuditFeeEarmarked` | `channel_id: primitive_types::H256 (#13)`; `amount: u128` | #846: 1% of a miner's settlement payment earmarked to the audit pool. |
| [RPC] | 49 | `AuditFeeClaimed` | `channel_id: primitive_types::H256 (#13)`; `validator: sp_core::crypto::AccountId32 (#0)`; `amount: u128`; `evidence: primitive_types::H256 (#13)` | #846: a validator claimed an audit fee from the pool against submitted evidence. |
| [RPC] | 50 | `SessionEvidenceRegistered` | `channel_id: primitive_types::H256 (#13)`; `slot: pallet_compute_channel::SessionEvidenceSlot (#314)`; `commitment: primitive_types::H256 (#13)`; `size_bytes: u32` | Bounded DA allocation only; custody and settlement remain separate. |
| [RPC] | 51 | `FcuEmpiricalParamsSet` | `params: Option (#305)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 52 | `FcuMassSlashPauseSet` | `paused: bool` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 53 | `ForwardBidRegistrationSealed` | `bid_id: primitive_types::H256 (#13)`; `authored_block: u32` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 54 | `ForwardUnitsListed` | `channel_id: primitive_types::H256 (#13)`; `seller: sp_core::crypto::AccountId32 (#0)`; `listing_id: primitive_types::H256 (#13)`; `units: u128`; `total_price: u128`; `expires_at: u32`; `delivered_gn: u128` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 55 | `ForwardUnitsSold` | `channel_id: primitive_types::H256 (#13)`; `seller: sp_core::crypto::AccountId32 (#0)`; `buyer: sp_core::crypto::AccountId32 (#0)`; `listing_id: primitive_types::H256 (#13)`; `units: u128`; `total_price: u128` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 56 | `ForwardListingCancelled` | `channel_id: primitive_types::H256 (#13)`; `seller: sp_core::crypto::AccountId32 (#0)`; `listing_id: primitive_types::H256 (#13)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 57 | `FcuPrimaryAdmissionsPauseSet` | `paused: bool` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 58 | `FcuServiceProfileRegistered` | `profile_hash: primitive_types::H256 (#13)`; `qualification_hash: primitive_types::H256 (#13)` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 59 | `FcuServiceProfileStatusSet` | `profile_hash: primitive_types::H256 (#13)`; `status: pallet_compute_channel::fcu_service::FcuProfileStatus (#310)` | No description in metadata; execution semantics unknown beyond the encoded interface. |

#### Errors

| Evidence | Index | Name | Fields in SCALE order | Purpose / metadata description |
|---|---:|---|---|---|
| [RPC] | 0 | `RequiredToplocEvidenceMissing` | () | #753 / D-0431: settlement requires a TOPLOC activation commitment for this channel's assurance class, but none was submitted (fail closed). |
| [RPC] | 1 | `ToplocEvidenceChannelNotOpen` | () | #753: `submit_toploc_evidence` requires the channel to be `Open`. |
| [RPC] | 2 | `ZeroToplocCommitment` | () | #753: a TOPLOC commitment reference must be non-zero. |
| [RPC] | 3 | `ToplocEscalationOpen` | () | #754: settlement is frozen — a TOPLOC escalation case is open for this channel and must reach a terminal verdict (slash / clear / timeout) first. |
| [RPC] | 4 | `NoToplocEscalation` | () | #754: no open TOPLOC escalation case exists for this channel. |
| [RPC] | 5 | `ToplocEscalationNotExpired` | () | #754: the escalation window has not elapsed yet; cannot time it out. |
| [RPC] | 6 | `ChannelExists` | () | A channel with this id already exists. |
| [RPC] | 7 | `ChannelNotFound` | () | No such channel. |
| [RPC] | 8 | `ZeroEscrow` | () | Escrow must be non-zero. |
| [RPC] | 9 | `TooManyActiveReservations` | () | Per-identity active reservation cap exceeded (A1 anti-spam; cap scales with escrow not flat). |
| [RPC] | 10 | `NotAParty` | () | Caller is not a party to this channel. |
| [RPC] | 11 | `BadState` | () | The channel is not in the required state for this action. |
| [RPC] | 12 | `MeasuredRootMismatch` | () | The submitted measured root does not match the channel commitment. |
| [RPC] | 13 | `MeasuredRootRejected` | () | The measured root failed the registry gate (§3.3). |
| [RPC] | 14 | `BadReceiptSignature` | () | The agent receipt signature did not verify (cooperative settle). |
| [RPC] | 15 | `AggregateGnMismatch` | () | Agent-signed aggregate `G_n` did not equal the transcript-verified turn sum. |
| [RPC] | 16 | `DuplicateVerifiedTurn` | () | The same turn was supplied twice in a settlement proof bundle. |
| [RPC] | 17 | `VerifiedTurnOutOfBounds` | () | A verified turn index exceeds the channel's SLA turn bound. |
| [RPC] | 18 | `TooManySettlementTurns` | () | A settlement proof bundle carried more turns than `MaxSettlementTurns`. |
| [RPC] | 19 | `MerklePathTooLong` | () | A verified turn's Merkle authentication path exceeded `MaxMerklePathLen`. |
| [RPC] | 20 | `SlaMaxTurnsTooLarge` | () | An SLA `max_turns` exceeds `MaxSettlementTurns` (would strand settlement). |
| [RPC] | 21 | `VerifiedWorkOverflow` | () | The transcript-verified `G_n` sum overflowed `u128`. |
| [RPC] | 22 | `VerifiedWorkExceedsEscrow` | () | Transcript-verified work exceeds the escrow reservation. |
| [RPC] | 23 | `TariffExceedsEscrow` | () | Two-part tariff (`BasePerTurn · turns + Σ G_n`) exceeds the escrow reservation. |
| [RPC] | 24 | `TariffRegression` | () | A settling repost lowered the two-part tariff pay (would underpay the miner). |
| [RPC] | 25 | `RefundPenaltyOverflow` | () | Refund penalty multiplication overflowed u128. |
| [RPC] | 26 | `BadEnclaveSignature` | () | The enclave signature over the contested leaf did not verify. |
| [RPC] | 27 | `UnsupportedLeafVersion` | () | The selected leaf version is not accepted for this channel profile. |
| [RPC] | 28 | `LeafFieldsInconsistent` | () | Fields unused by the selected version were non-zero, or V3 lacked `h_ids`. |
| [RPC] | 29 | `LeafNotInRoot` | () | The contested leaf is not a member of the committed transcript root. |
| [RPC] | 30 | `WindowNotElapsed` | () | The challenge window / response window has not yet elapsed. |
| [RPC] | 31 | `WindowElapsed` | () | The challenge window, or the open dispute's response window, has already elapsed. |
| [RPC] | 32 | `DisputeExists` | () | A dispute is already open on this channel. |
| [RPC] | 33 | `DisputeNotFound` | () | No dispute is open on this channel. |
| [RPC] | 34 | `WrongTurnResponded` | () | `respond_dispute` proved a different turn than the one the challenger contested. |
| [RPC] | 35 | `BisectionNotAtLeaf` | () | Multi-round bisection is still narrowing; leaf response not yet legal. |
| [RPC] | 36 | `BisectionNotAwaitingResponse` | () | Miner already posted child roots (or leaf is isolated); wrong phase. |
| [RPC] | 37 | `BisectionNotAwaitingChallenge` | () | Challenger already chose (or miner has not opened); wrong phase. |
| [RPC] | 38 | `BisectionBadChildRoots` | () | Child roots do not hash to the active interval parent root. |
| [RPC] | 39 | `BisectionBadTurnCount` | () | Bisection turn count must be a power of two in `[2, MaxSettlementTurns]`. |
| [RPC] | 40 | `BisectionRoundCap` | () | Midpoint rounds exceeded `⌈log₂ MaxSettlementTurns⌉`. |
| [RPC] | 41 | `SessionNotExpired` | () | The session has not exceeded its max duration (timeout precondition). |
| [RPC] | 42 | `GnRegression` | () | Aggregate `G_n` regressed below the already-posted claim (replay). |
| [RPC] | 43 | `TranscriptUnavailable` | () | The disputed transcript is no longer retrievable from DA. |
| [RPC] | 44 | `TranscriptNotUnrecoverable` | () | Transcript DA is still recoverable; unrecoverable void does not apply. |
| [RPC] | 45 | `ModelWeightsLeaseExpired` | () | The model's weights lease has expired (or is inside grace) — top it up in `da-registry` before opening a session against it (D-0407). |
| [RPC] | 46 | `NotPendingAck` | () | The channel is not awaiting a `force_ack` (wrong state for this action). |
| [RPC] | 47 | `AckWindowElapsed` | () | The `force_open` ack window has already elapsed — the open can now only be expired ([`Pallet::expire_force_open`]), not acked. |
| [RPC] | 48 | `AckWindowNotElapsed` | () | The `force_open` ack window has not yet elapsed; the open cannot be expired. |
| [RPC] | 49 | `NotNamedMiner` | () | Caller is not the named miner for this `force_open`. |
| [RPC] | 50 | `OfferExpired` | () | The standing offer expired against the finalized head. |
| [RPC] | 51 | `OfferNotExpired` | () | A funded offer cannot be cancelled until its signed expiry passes. |
| [RPC] | 52 | `OfferNonceUsed` | () | This miner-scoped offer nonce was already accepted. |
| [RPC] | 53 | `BadOfferSignature` | () | The standing offer signature did not verify against its miner account. |
| [RPC] | 54 | `BadOfferAcceptanceSignature` | () | The agent receipt key did not countersign the exact offer acceptance. |
| [RPC] | 55 | `OfferEscrowBelowMinimum` | () | Submitted escrow is below the offer's signed minimum. |
| [RPC] | 56 | `FcuNotActivated` | () | FCU parameters are intentionally unset in the runtime. |
| [RPC] | 57 | `InvalidForwardTerms` | () | Forward window/rate/quota/price/bond terms are malformed. |
| [RPC] | 58 | `ForwardOfferNotFunded` | () | Forward offer must be funded before countersigned pickup. |
| [RPC] | 59 | `ForwardOfferFundingMismatch` | () | The signed offer does not match its funded bond commitment. |
| [RPC] | 60 | `ForwardNotStarted` | () | Forward service evidence cannot be posted before `start_block`. |
| [RPC] | 61 | `ForwardWindowNotElapsed` | () | Forward position has not reached its terminal window. |
| [RPC] | 62 | `ForwardDeliveryOutOfBounds` | () | The requested delivery regresses or exceeds the contracted quota. |
| [RPC] | 63 | `NoForwardAvailabilityAccrued` | () | No new availability earnout has accrued. |
| [RPC] | 64 | `FcuSlashPaused` | () | No successful/missed Ghost evidence exists for the elapsed window. D-0430 degraded state or F2 mass-slash breaker pauses default. |
| [RPC] | 65 | `TooManyForwardChannels` | () | Bounded miner reverse index is full. |
| [RPC] | 66 | `ForwardArithmeticOverflow` | () | Checked FCU payment/bond/earnout arithmetic overflowed. |
| [RPC] | 67 | `ForwardAssignmentLockedPrincipal` | () | A forward position cannot be funded from vesting-locked principal, and so cannot change refund owner. |
| [RPC] | 68 | `ForwardLotTooSmall` | () | Unit transfer would create a non-zero balance below the governed lot. |
| [RPC] | 69 | `TooManyForwardHolders` | () | Holder cap would be exceeded. |
| [RPC] | 70 | `ForwardHolderHasActiveDraw` | () | Transfers cannot preempt a holder's live draw. |
| [RPC] | 71 | `ForwardHolderNotFound` | () | No holder units or terminal pull distribution exist. |
| [RPC] | 72 | `ForwardDrawUnavailable` | () | Draw rate is zero, exceeds remaining capacity, or draw id is reused. |
| [RPC] | 73 | `TooManyForwardDraws` | () | Concurrent draw-record cap reached. |
| [RPC] | 74 | `ForwardBidExists` | () | Bid nonce/object already exists. |
| [RPC] | 75 | `ForwardBidBadPhase` | () | Bid phase/deadline does not permit this transition. |
| [RPC] | 76 | `ForwardBidClaimInvalid` | () | Claim commitment missing, duplicated, or incorrectly revealed. |
| [RPC] | 77 | `ForwardBidClaimantSetInvalid` | () | Claim set is empty or full. |
| [RPC] | 78 | `ForwardBidEntropyUnavailable` | () | Post-registration entropy was unavailable. |
| [RPC] | 79 | `FinalitySafeMode` | () | Finality is stalled; new finality-dependent channel opens are disabled. |
| [RPC] | 80 | `ToplocToleranceNotCalibrated` | () | The model has no governance-calibrated TOPLOC tolerance band (fail closed). |
| [RPC] | 81 | `ToplocBandUnavailable` | () | Derived TOPLOC band constants are missing or misordered (fail closed). |
| [RPC] | 82 | `ToplocEvidenceMismatch` | () | The TOPLOC attestation bundle does not all vouch for identical evidence. |
| [RPC] | 83 | `ToplocEvidenceChannelMismatch` | () | The TOPLOC evidence references a different channel than the one disputed. |
| [RPC] | 84 | `ToplocVerifierAccepted` | () | The attested activation is inside the calibrated band (no fraud), or the committed and recomputed hashes are identical (the verifier accepted). |
| [RPC] | 85 | `ValidatorNotActive` | () | A TOPLOC attestation signer is not an active validator. |
| [RPC] | 86 | `InvalidValidatorSignature` | () | A TOPLOC attestation signature did not verify, or its id is malformed. |
| [RPC] | 87 | `ToplocQuorumNotMet` | () | The distinct active-validator signers did not meet the BFT quorum. |
| [RPC] | 88 | `NotPremiumChannel` | () | #535: the channel was not opened as `CertificatePremium`. |
| [RPC] | 89 | `PremiumRequiresInt8Exact` | () | #534: premium class requires INT8-exact serving (W8A8/int32 accumulate). |
| [RPC] | 90 | `PremiumRequiresWeightCommitment` | () | #533: the model has no registered weight MLE commitment at this precision. |
| [RPC] | 91 | `PremiumPriceFloorNotMet` | () | #535: escrow does not meet `price_per_gflop · gn · MinCertificatePremiumPpm`. |
| [RPC] | 92 | `CertificateRejected` | () | #535: the work certificate did not verify (or no verifier backend is wired). |
| [RPC] | 93 | `BookkeepingRejected` | () | #794: the supplied bookkeeping cert did not verify — the settled `aggregate_gn` was not proven to equal `Σ per-leaf g_n` (or no verifier backend is wired). |
| [RPC] | 94 | `BookkeepingRequired` | () | #794: the runtime's `BookkeepingVerifier` requires a bookkeeping cert but the caller omitted it (`bookkeeping_cert == None`). Fail closed — a miner cannot skip the aggregation-integrity gate on the certified money path. |
| [RPC] | 95 | `MeteringRejected` | () | #871: the supplied metering cert did not verify — a per-leaf `g_n` was not proven to equal `measured_gn(committed counts)` under the band cap (or no verifier backend is wired). |
| [RPC] | 96 | `MeteringRequired` | () | #871: the runtime's `MeteringCertVerifier` requires a metering cert but the caller omitted it (`metering_cert == None`). Fail closed — a miner cannot skip the per-leaf `g_n`-honesty gate on the certified money path. |
| [RPC] | 97 | `CalibrationUnavailable` | () | No calibration cap was available for a nonzero settlement. |
| [RPC] | 98 | `SettlementExceedsCalibrationCap` | () | Session settlement exceeded `min(snapshot_cap, current_cap) * elapsed_blocks`. |
| [RPC] | 99 | `ToplocProfileNotPinned` | () | The channel has no pinned TOPLOC attestation profile for the new claim path. |
| [RPC] | 100 | `InvalidToplocAttestClaim` | () | The shared attestation claim failed registry/profile/quorum verification. |
| [RPC] | 101 | `ToplocClaimSubjectMismatch` | () | The shared TOPLOC claim subject did not bind the disputed evidence tuple. |
| [RPC] | 102 | `InvalidToplocVerdict` | () | TOPLOC mismatch claims only uphold fraud-tagged failed verdicts. |
| [RPC] | 103 | `AttestationStale` | () | The channel's attestation freshness window elapsed before settlement. |
| [RPC] | 104 | `DegradedWindowExtensionCapped` | () | The objective degraded-state extension cap is exhausted. |
| [RPC] | 105 | `DecodePolicyRejected` | () | The decode policy was not allowed for the model at channel open. |
| [RPC] | 106 | `DecodePolicyHashMismatch` | () | A transcript proof did not match the channel-pinned decode policy. |
| [RPC] | 107 | `NoDisputeStanding` | () | Origin lacks dispute standing (D-0424): must be the channel agent or an active validator. Rejected before the challenger bond is locked. |
| [RPC] | 108 | `MissingAuditEvidence` | () | #846: an audit-fee claim requires submitted evidence (a non-zero attestation commitment). Fail closed — no evidence, no pay (no unpaid-duty path). |
| [RPC] | 109 | `AuditAlreadyClaimed` | () | #846: this validator has already claimed the audit fee for this channel. |
| [RPC] | 110 | `AuditPoolInsufficient` | () | #846: the audit pool has insufficient earmarked funds to pay this claim. Fail closed — a duty is never assigned that the pool cannot fund. |
| [RPC] | 111 | `DisputeTurnNotSettled` | () | The disputed turn was not verified at the current settlement post (or the channel was settled before posted turns were recorded), so the miner could not answer it. Rejected before the challenger bond is locked. |
| [RPC] | 112 | `SettlementTariffMissing` | () | Terminal unrecoverable-DA settlement requires a posted tariff or an explicitly eligible legacy tariff materialized after v1 → v2 activation. |
| [RPC] | 113 | `MinerRetired` | () | New exposure cannot target a permanently retired miner. |
| [RPC] | 114 | `SessionEvidenceTooLarge` | () | Session DA size is zero, exceeds its typed slot cap, or overflows. |
| [RPC] | 115 | `SessionEvidenceConflict` | () | An immutable evidence slot was already assigned different bytes. |
| [RPC] | 116 | `ForwardStateUpgradeRequired` | () | Predecessor forward state must be explicitly handled before exact-rate execution. |
| [RPC] | 117 | `ForwardListingLocked` | () | Seller has locked outgoing rights behind an outstanding listing. |
| [RPC] | 118 | `ForwardListingUnavailable` | () | Listing is absent, stale, expired, exhausted, or bound to different rights. |
| [RPC] | 119 | `ForwardSalePriceExceeded` | () | Exact whole-listing payment exceeds the buyer's signed budget. |
| [RPC] | 120 | `FcuEconomicSnapshotMissing` | () | Funded obligations require their original economic snapshot. |
| [RPC] | 121 | `FcuObligationsOutstanding` | () | Clearing configuration would disable outstanding financial claims. |
| [RPC] | 122 | `FcuPrimaryAdmissionsPaused` | () | New primary funding or position creation is paused by governance. |
| [RPC] | 123 | `FcuInvalidServiceProfile` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 124 | `FcuInvalidQualification` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 125 | `FcuServiceProfileUnknown` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 126 | `FcuQualificationUnknown` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 127 | `FcuQualificationConflict` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 128 | `FcuServiceProfileUnavailable` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 129 | `FcuInvalidServiceWindow` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 130 | `FcuTimestampUnavailable` | () | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | 131 | `FcuNativeIntegrationRequired` | () | Native service binding and custody must be implemented before new exposure. |

#### Constants

| Evidence | Constant | SCALE type | Decoded value (raw base units unless stated) | Purpose |
|---|---|---|---|---|
| [RPC] | `PalletId` | `frame_support::PalletId (#550)` | `"0x666c6f702f63686e"` | Sovereign account holding live escrow. |
| [RPC] | `MaxForwardChannelsPerMiner` | `u32` | `16` | Bound on active forward positions tracked per miner for Ghost callbacks. |
| [RPC] | `MaxForwardHolders` | `u32` | `10` | Dormant divisible path is bounded to ten holders at the 10% minimum lot. |
| [RPC] | `MaxForwardDraws` | `u32` | `32` | Bounds concurrent sub-stream admission records per forward channel. |
| [RPC] | `ForwardBidCommitWindow` | `u32` | `600` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `ForwardBidRevealWindow` | `u32` | `600` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `MaxForwardBidClaimants` | `u32` | `32` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `MinCertificatePremiumPpm` | `u32` | `1500000` | #535: minimum premium-class price multiple in ppm (1_500_000 = 1.5×) over  the model's per-GFLOP rate. `certificate_settle` requires  `escrow ≥ price_per_gflop · aggregate_gn · multiple` so a premium  settlement cannot pay standard-rate escrow for certificate-backed work.  #628: when [`Self::SampledAuditAlphaPpm`] < 1e6 the effective floor is  `premium_ppm_for_alpha(this, alpha)`. |
| [RPC] | `SampledAuditAlphaPpm` | `u32` | `50000` | #628: sampled-audit rate in ppm (50_000 = 5%). `1_000_000` = full audit  (blanket certificate mode). Used for α-tiered premium floor. |
| [RPC] | `SampledAuditCheckpointTurns` | `u32` | `16` | #628: KV-checkpoint interval C (turns). Audited-turn replay restarts  from the nearest checkpoint; bound = C. |
| [RPC] | `MaxSessionActivationBytes` | `u32` | `65536` | No description in metadata; execution semantics unknown beyond the encoded interface. |
| [RPC] | `FinalityLagWarn` | `u32` | `30` | Warning lag threshold in blocks. |
| [RPC] | `FinalityFreezeThreshold` | `u32` | `120` | Safe-mode threshold in blocks; new finality-dependent opens are rejected at/above it. |
| [RPC] | `MaxFinalityStall` | `u32` | `3600` | Escape-eligibility threshold in blocks. |
| [RPC] | `DaRetention` | `u32` | `1209600` | The `da-registry` retention `W`, strictly longer than the worst-case  maximum-depth dispute; validated in [`Pallet::integrity_test`]. |
| [RPC] | `DisputeWindow` | `u32` | `604800` | Challenge window; together with every maximum-depth bisection leg and the  one degraded extension, **must be < `DaRetention`.** |
| [RPC] | `ChallengerBond` | `u128` | `100000000000000000000` | Bond a challenger locks when opening a dispute. |
| [RPC] | `DisputeResponseWindow` | `u32` | `7200` | Window (blocks) the miner has to answer a challenge before the fraud  verdict defaults against it. |
| [RPC] | `RefundPenalty` | `sp_arithmetic::per_things::Perbill (#208)` | `200000000` | Penalty fraction applied to unused escrow on ambiguous early close. |
| [RPC] | `AuditForfeitSlashPpm` | `u32` | `1000000` | #844 publish-or-forfeit: the audit-data liveness-forfeit slash floor, in  parts-per-million of the withheld window's value. A value window finalized  with no published audit blob pays the miner nothing AND slashes at least  `window_value · this / 1_000_000`. Must be `≥ 1_000_000` (≥ window value) so  silence never beats being audited; it stays below the fraud slash (full stake  + blacklist) structurally. Enforced in [`Pallet::integrity_test`]. |
| [RPC] | `AuditFeeSplitPpm` | `u32` | `10000` | #846: fraction (ppm) of the miner's settlement payment (the session-fee leg)  earmarked to the audit pool that pays validators for audit work. Ratified at  1% = `10_000` ppm. Must be `< 1_000_000` (never confiscates the whole payment);  enforced in [`Pallet::integrity_test`]. |
| [RPC] | `AuditFeePerTurn` | `u128` | `1000000000000000000` | #846: fee paid to a validator per claimed audit verdict, drawn from the audit  pool ([`Pallet::claim_audit_fee`]). Claims are gated on submitted evidence and  on pool solvency (no unpaid-duty path). |
| [RPC] | `AckWindow` | `u32` | `600` | Window (blocks) the named miner has to [`Pallet::force_ack`] a  [`Pallet::force_open`] before it expires with a full refund (decision: the  permissionless on-chain open escape hatch). |
| [RPC] | `MaxActiveReservationsBase` | `u32` | `400` | Base concurrent active reservations per agent identity (A1 anti-spam). |
| [RPC] | `EscrowPerReservationSlot` | `u128` | `50000000000000000000` | Escrow units (smallest) granting +1 to effective per-identity cap.  effective = base + floor(escrow / this); scales with bonded escrow (costly), fail-closed, not flat. |
| [RPC] | `MinForceOpenEscrowForFailedAck` | `u128` | `50000000000000000` | Minimum escrow that makes an availability timeout increment a miner-side  counter. Smaller `force_open` and standing-offer reservations still expire  with a full refund, but no counter increment (D-0423). |
| [RPC] | `SoftTierSpotCheckRatePpm` | `u32` | `25000` | Spot-check rate for SOFT-tier channels, parts per million. |
| [RPC] | `ValidatorAttestationThreshold` | `sp_arithmetic::per_things::Perbill (#208)` | `666666666` | BFT fraction of the active validator set required to uphold a TOPLOC  mismatch (default `2/3`, matching proof crediting; `D-0414`). |
| [RPC] | `ToplocMismatchProfile` | `hp_poui::AttestProfileRef (#410)` | `{"profile_id":"0x0202020202020202020202020202020202020202020202020202020202020202","version":1}` | TOPLOC mismatch profile/version pinned onto each new channel. |
| [RPC] | `ToplocEscalationWindow` | `u32` | `7200` | #754: how long (in finality blocks) a TOPLOC escalation case stays open  before [`Pallet::expire_toploc_escalation`] may resolve it as inconclusive.  Validators have this window to gather a stronger report (escalate → slash) or  a quorum clear; settlement is frozen throughout. Governance-set. |
| [RPC] | `MaxSettlementTurns` | `u32` | `1024` | Hard upper bound on the number of `VerifiedTurn`s a single  `settle`/`force_settle` proof bundle may carry — and, since it also caps an  SLA's `max_turns` at open, the most turns a session can ever accrue. Bounds  the O(n) enclave-signature verifications and O(n²) duplicate scan in  `verified_gn_from_turns` so settlement weight stays linear and cannot be  under-charged (weight-DoS guard). |
| [RPC] | `MaxMerklePathLen` | `u32` | `64` | Maximum Merkle authentication-path length accepted per `VerifiedTurn`  (a path proves membership in a tree of up to `2^MaxMerklePathLen` leaves).  Bounds the per-turn hashing in `verify_turn_proof` so an unbounded  `merkle_path` cannot inflate verification work beyond the charged weight. |
| [RPC] | `BasePerTurn` | `u128` | `1` | Per-turn flat fee component of the two-part tariff (#719):  `turn_pay = BasePerTurn + G_n` (rate = 1 in channel pay units).  Dust turns (`G_n = 0/1`) stay protocol-valid but self-fund fixed costs  (leaf + DA + audit-lottery ticket). Integrity: `BasePerTurn ≥ CTurnFixed`. |
| [RPC] | `CTurnFixed` | `u128` | `1` | Lower bound on `BasePerTurn` — protocol estimate of fixed per-turn cost.  Enforced in [`Pallet::integrity_test`] (same class as fee-design  `MinBaseFee ≥ marginal_cost`). |
## Appendix B. Complete SCALE type dictionary

[RPC] Every type ID below is local to this metadata hash. Composite fields and tuple elements encode left to right; enum index is its SCALE discriminant. `sequence` uses a compact length, arrays have fixed length, `compact` wraps its target type. These are decoded metadata definitions; generic bound types describe wrappers but do not themselves prove dispatch-time policy. The complete paths, generic parameters and documentation are retained in [metadata.json](../evidence/metadata.json). `Optional` storage means missing key maps to Option::None; a present value encodes the listed value directly. A `Default` missing value uses its metadata default bytes.

| Evidence | Type ID | Path | Exact SCALE shape / referenced type IDs | Generic parameters |
|---|---:|---|---|---|
| [RPC] | 0 | `sp_core::crypto::AccountId32` | `struct(None:#1)` | `[]` |
| [RPC] | 1 | `` | `array:{"len":32,"type":2}` | `[]` |
| [RPC] | 2 | `` | `primitive:"u8"` | `[]` |
| [RPC] | 3 | `frame_system::AccountInfo` | `struct(nonce:#4, consumers:#4, providers:#4, sufficients:#4, data:#5)` | `[{"name":"Nonce","type":4},{"name":"AccountData","type":5}]` |
| [RPC] | 4 | `` | `primitive:"u32"` | `[]` |
| [RPC] | 5 | `pallet_balances::types::AccountData` | `struct(free:#6, reserved:#6, frozen:#6, flags:#7)` | `[{"name":"Balance","type":6}]` |
| [RPC] | 6 | `` | `primitive:"u128"` | `[]` |
| [RPC] | 7 | `pallet_balances::types::ExtraFlags` | `struct(None:#6)` | `[]` |
| [RPC] | 8 | `` | `primitive:"bool"` | `[]` |
| [RPC] | 9 | `frame_support::dispatch::PerDispatchClass` | `struct(normal:#10, operational:#10, mandatory:#10)` | `[{"name":"T","type":10}]` |
| [RPC] | 10 | `sp_weights::weight_v2::Weight` | `struct(ref_time:#11, proof_size:#11)` | `[]` |
| [RPC] | 11 | `` | `compact:12` | `[]` |
| [RPC] | 12 | `` | `primitive:"u64"` | `[]` |
| [RPC] | 13 | `primitive_types::H256` | `struct(None:#1)` | `[]` |
| [RPC] | 14 | `` | `sequence:2` | `[]` |
| [RPC] | 15 | `sp_runtime::generic::digest::Digest` | `struct(logs:#16)` | `[]` |
| [RPC] | 16 | `` | `sequence:17` | `[]` |
| [RPC] | 17 | `sp_runtime::generic::digest::DigestItem` | `enum(6:PreRuntime(None:#18, None:#14); 4:Consensus(None:#18, None:#14); 5:Seal(None:#18, None:#14); 0:Other(None:#14); 8:RuntimeEnvironmentUpdated())` | `[]` |
| [RPC] | 18 | `` | `array:{"len":4,"type":2}` | `[]` |
| [RPC] | 19 | `` | `sequence:20` | `[]` |
| [RPC] | 20 | `frame_system::EventRecord` | `struct(phase:#460, event:#21, topics:#69)` | `[{"name":"E","type":21},{"name":"T","type":13}]` |
| [RPC] | 21 | `zkv_runtime::RuntimeEvent` | `enum(0:System(None:#22); 1:Scheduler(None:#32); 2:Preimage(None:#37); 4:Balances(None:#38); 5:TransactionPayment(None:#49); 8:Offences(None:#50); 9:Historical(None:#52); 11:Session(None:#53); 14:Treasury(None:#54); 15:ConvictionVoting(None:#55); 16:Referenda(None:#59); 25:Bounties(None:#392); 26:ChildBounties(None:#393); 30:Utility(None:#394); 31:Multisig(None:#395); 32:Proxy(None:#396); 33:Identity(None:#398); 50:Sudo(None:#399); 51:Vesting(None:#400); 81:Aggregate(None:#401); 83:TokenClaim(None:#404); 84:Crl(None:#405); 85:HasStation(None:#407); 86:FlopPoui(None:#408); 87:HwCalibration(None:#411); 88:WorkVesting(None:#414); 89:SyntheticTasks(None:#416); 90:Attest(None:#418); 91:AirdropVesting(None:#419); 92:BlockRewards(None:#420); 93:FlopSubsidy(None:#421); 94:FlopSessionKeys(None:#422); 95:AgentWallet(None:#423); 96:Validators(None:#424); 97:MinerStaking(None:#425); 100:MinerSlashing(None:#426); 98:DelegationCap(None:#427); 99:EmergencyOverride(None:#428); 101:ModelRegistry(None:#429); 109:ModelRegistrars(None:#433); 102:DaRegistry(None:#434); 108:PaidStorage(None:#435); 103:ComputeChannel(None:#440); 107:MeteringVerifier(None:#445); 104:Aleph(None:#446); 105:EmergencyPause(None:#447); 106:AgentIdentity(None:#448); 161:SettlementGroth16Pallet(None:#451); 162:SettlementRisc0Pallet(None:#452); 163:SettlementUltraplonkPallet(None:#453); 165:SettlementPlonky2Pallet(None:#454); 166:SettlementFFlonkPallet(None:#455); 167:SettlementSp1Pallet(None:#456); 168:SettlementUltrahonkPallet(None:#457); 169:SettlementEzklPallet(None:#458); 170:SettlementTeePallet(None:#459))` | `[]` |
| [RPC] | 22 | `frame_system::pallet::Event` | `enum(0:ExtrinsicSuccess(dispatch_info:#23); 1:ExtrinsicFailed(dispatch_error:#26, dispatch_info:#23); 2:CodeUpdated(hash:#13); 3:NewAccount(account:#0); 4:KilledAccount(account:#0); 5:Remarked(sender:#0, hash:#13); 6:UpgradeAuthorized(code_hash:#13, check_version:#8); 7:RejectedInvalidAuthorizedUpgrade(code_hash:#13, error:#26))` | `[{"name":"T","type":null}]` |
| [RPC] | 23 | `frame_system::DispatchEventInfo` | `struct(weight:#10, class:#24, pays_fee:#25)` | `[]` |
| [RPC] | 24 | `frame_support::dispatch::DispatchClass` | `enum(0:Normal(); 1:Operational(); 2:Mandatory())` | `[]` |
| [RPC] | 25 | `frame_support::dispatch::Pays` | `enum(0:Yes(); 1:No())` | `[]` |
| [RPC] | 26 | `sp_runtime::DispatchError` | `enum(0:Other(); 1:CannotLookup(); 2:BadOrigin(); 3:Module(None:#27); 4:ConsumerRemaining(); 5:NoProviders(); 6:TooManyConsumers(); 7:Token(None:#28); 8:Arithmetic(None:#29); 9:Transactional(None:#30); 10:Exhausted(); 11:Corruption(); 12:Unavailable(); 13:RootNotAllowed(); 14:Trie(None:#31))` | `[]` |
| [RPC] | 27 | `sp_runtime::ModuleError` | `struct(index:#2, error:#18)` | `[]` |
| [RPC] | 28 | `sp_runtime::TokenError` | `enum(0:FundsUnavailable(); 1:OnlyProvider(); 2:BelowMinimum(); 3:CannotCreate(); 4:UnknownAsset(); 5:Frozen(); 6:Unsupported(); 7:CannotCreateHold(); 8:NotExpendable(); 9:Blocked())` | `[]` |
| [RPC] | 29 | `sp_arithmetic::ArithmeticError` | `enum(0:Underflow(); 1:Overflow(); 2:DivisionByZero())` | `[]` |
| [RPC] | 30 | `sp_runtime::TransactionalError` | `enum(0:LimitReached(); 1:NoLayer())` | `[]` |
| [RPC] | 31 | `sp_runtime::proving_trie::TrieError` | `enum(0:InvalidStateRoot(); 1:IncompleteDatabase(); 2:ValueAtIncompleteKey(); 3:DecoderError(); 4:InvalidHash(); 5:DuplicateKey(); 6:ExtraneousNode(); 7:ExtraneousValue(); 8:ExtraneousHashReference(); 9:InvalidChildReference(); 10:ValueMismatch(); 11:IncompleteProof(); 12:RootMismatch(); 13:DecodeError())` | `[]` |
| [RPC] | 32 | `pallet_scheduler::pallet::Event` | `enum(0:Scheduled(when:#4, index:#4); 1:Canceled(when:#4, index:#4); 2:Dispatched(task:#33, id:#34, result:#35); 3:RetrySet(task:#33, id:#34, period:#4, retries:#2); 4:RetryCancelled(task:#33, id:#34); 5:CallUnavailable(task:#33, id:#34); 6:PeriodicFailed(task:#33, id:#34); 7:RetryFailed(task:#33, id:#34); 8:PermanentlyOverweight(task:#33, id:#34); 9:AgendaIncomplete(when:#4))` | `[{"name":"T","type":null}]` |
| [RPC] | 33 | `` | `tuple:[4,4]` | `[]` |
| [RPC] | 34 | `Option` | `enum(0:None(); 1:Some(None:#1))` | `[{"name":"T","type":1}]` |
| [RPC] | 35 | `Result` | `enum(0:Ok(None:#36); 1:Err(None:#26))` | `[{"name":"T","type":36},{"name":"E","type":26}]` |
| [RPC] | 36 | `` | `tuple:[]` | `[]` |
| [RPC] | 37 | `pallet_preimage::pallet::Event` | `enum(0:Noted(hash:#13); 1:Requested(hash:#13); 2:Cleared(hash:#13))` | `[{"name":"T","type":null}]` |
| [RPC] | 38 | `pallet_balances::pallet::Event` | `enum(0:Endowed(account:#0, free_balance:#6); 1:DustLost(account:#0, amount:#6); 2:Transfer(from:#0, to:#0, amount:#6); 3:BalanceSet(who:#0, free:#6); 4:Reserved(who:#0, amount:#6); 5:Unreserved(who:#0, amount:#6); 6:ReserveRepatriated(from:#0, to:#0, amount:#6, destination_status:#39); 7:Deposit(who:#0, amount:#6); 8:Withdraw(who:#0, amount:#6); 9:Slashed(who:#0, amount:#6); 10:Minted(who:#0, amount:#6); 11:MintedCredit(amount:#6); 12:Burned(who:#0, amount:#6); 13:BurnedDebt(amount:#6); 14:Suspended(who:#0, amount:#6); 15:Restored(who:#0, amount:#6); 16:Upgraded(who:#0); 17:Issued(amount:#6); 18:Rescinded(amount:#6); 19:Locked(who:#0, amount:#6); 20:Unlocked(who:#0, amount:#6); 21:Frozen(who:#0, amount:#6); 22:Thawed(who:#0, amount:#6); 23:TotalIssuanceForced(old:#6, new:#6); 24:Held(reason:#40, who:#0, amount:#6); 25:BurnedHeld(reason:#40, who:#0, amount:#6); 26:TransferOnHold(reason:#40, source:#0, dest:#0, amount:#6); 27:TransferAndHold(reason:#40, source:#0, dest:#0, transferred:#6); 28:Released(reason:#40, who:#0, amount:#6); 29:Unexpected(None:#48))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 39 | `frame_support::traits::tokens::misc::BalanceStatus` | `enum(0:Free(); 1:Reserved())` | `[]` |
| [RPC] | 40 | `zkv_runtime::RuntimeHoldReason` | `enum(2:Preimage(None:#41); 11:Session(None:#42); 81:Aggregate(None:#43); 86:FlopPoui(None:#44); 102:DaRegistry(None:#45); 108:PaidStorage(None:#46); 160:CommonVerifiers(None:#47))` | `[]` |
| [RPC] | 41 | `pallet_preimage::pallet::HoldReason` | `enum(0:Preimage())` | `[]` |
| [RPC] | 42 | `pallet_session::pallet::HoldReason` | `enum(0:Keys())` | `[]` |
| [RPC] | 43 | `pallet_aggregate::pallet::HoldReason` | `enum(0:Aggregation(); 1:Domain(); 2:Delivery(); 3:Allowlist())` | `[]` |
| [RPC] | 44 | `pallet_flop_poui::pallet::HoldReason` | `enum(0:TaskFee())` | `[]` |
| [RPC] | 45 | `pallet_da_registry::pallet::HoldReason` | `enum(0:LeaseDeposit(); 1:EndpointDeposit())` | `[]` |
| [RPC] | 46 | `pallet_paid_storage::pallet::HoldReason` | `enum(0:CapacityCollateral(); 1:ReservationEscrow(); 2:ServiceLaneEscrow())` | `[]` |
| [RPC] | 47 | `pallet_verifiers::common::pallet::HoldReason` | `enum(0:VkRegistration())` | `[]` |
| [RPC] | 48 | `pallet_balances::pallet::UnexpectedKind` | `enum(0:BalanceUpdated(); 1:FailedToMutateAccount())` | `[]` |
| [RPC] | 49 | `pallet_transaction_payment::pallet::Event` | `enum(0:TransactionFeePaid(who:#0, actual_fee:#6, tip:#6))` | `[{"name":"T","type":null}]` |
| [RPC] | 50 | `pallet_offences::pallet::Event` | `enum(0:Offence(kind:#51, timeslot:#14))` | `[]` |
| [RPC] | 51 | `` | `array:{"len":16,"type":2}` | `[]` |
| [RPC] | 52 | `pallet_session::historical::pallet::Event` | `enum(0:RootStored(index:#4); 1:RootsPruned(up_to:#4))` | `[{"name":"T","type":null}]` |
| [RPC] | 53 | `pallet_session::pallet::Event` | `enum(0:NewSession(session_index:#4); 1:NewQueued(); 2:ValidatorDisabled(validator:#0); 3:ValidatorReenabled(validator:#0))` | `[{"name":"T","type":null}]` |
| [RPC] | 54 | `pallet_treasury::pallet::Event` | `enum(0:Spending(budget_remaining:#6); 1:Awarded(proposal_index:#4, award:#6, account:#0); 2:Burnt(burnt_funds:#6); 3:Rollover(rollover_balance:#6); 4:Deposit(value:#6); 5:SpendApproved(proposal_index:#4, amount:#6, beneficiary:#0); 6:UpdatedInactive(reactivated:#6, deactivated:#6); 7:AssetSpendApproved(index:#4, asset_kind:#36, amount:#6, beneficiary:#0, valid_from:#4, expire_at:#4); 8:AssetSpendVoided(index:#4); 9:Paid(index:#4, payment_id:#36); 10:PaymentFailed(index:#4, payment_id:#36); 11:SpendProcessed(index:#4))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 55 | `pallet_conviction_voting::pallet::Event` | `enum(0:Delegated(None:#0, None:#0, None:#56); 1:Undelegated(None:#0, None:#56); 2:Voted(who:#0, vote:#57, poll_index:#4); 3:VoteRemoved(who:#0, vote:#57, poll_index:#4); 4:VoteUnlocked(who:#0, class:#56))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 56 | `` | `primitive:"u16"` | `[]` |
| [RPC] | 57 | `pallet_conviction_voting::vote::AccountVote` | `enum(0:Standard(vote:#58, balance:#6); 1:Split(aye:#6, nay:#6); 2:SplitAbstain(aye:#6, nay:#6, abstain:#6))` | `[{"name":"Balance","type":6}]` |
| [RPC] | 58 | `pallet_conviction_voting::vote::Vote` | `struct(None:#2)` | `[]` |
| [RPC] | 59 | `pallet_referenda::pallet::Event` | `enum(0:Submitted(index:#4, track:#56, proposal:#60); 1:DecisionDepositPlaced(index:#4, who:#0, amount:#6); 2:DecisionDepositRefunded(index:#4, who:#0, amount:#6); 3:DepositSlashed(who:#0, amount:#6); 4:DecisionStarted(index:#4, track:#56, proposal:#60, tally:#391); 5:ConfirmStarted(index:#4); 6:ConfirmAborted(index:#4); 7:Confirmed(index:#4, tally:#391); 8:Approved(index:#4); 9:Rejected(index:#4, tally:#391); 10:TimedOut(index:#4, tally:#391); 11:Cancelled(index:#4, tally:#391); 12:Killed(index:#4, tally:#391); 13:SubmissionDepositRefunded(index:#4, who:#0, amount:#6); 14:MetadataSet(index:#4, hash:#13); 15:MetadataCleared(index:#4, hash:#13))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 60 | `frame_support::traits::preimages::Bounded` | `enum(0:Legacy(hash:#13); 1:Inline(None:#178); 2:Lookup(hash:#13, len:#4))` | `[{"name":"T","type":61},{"name":"H","type":390}]` |
| [RPC] | 61 | `zkv_runtime::RuntimeCall` | `enum(0:System(None:#62); 1:Scheduler(None:#66); 2:Preimage(None:#68); 3:Timestamp(None:#70); 4:Balances(None:#71); 10:Babe(None:#78); 11:Session(None:#88); 14:Treasury(None:#92); 15:ConvictionVoting(None:#94); 16:Referenda(None:#97); 25:Bounties(None:#103); 26:ChildBounties(None:#104); 30:Utility(None:#105); 31:Multisig(None:#107); 32:Proxy(None:#110); 33:Identity(None:#113); 50:Sudo(None:#157); 51:Vesting(None:#158); 81:Aggregate(None:#160); 83:TokenClaim(None:#166); 84:Crl(None:#175); 85:HasStation(None:#177); 86:FlopPoui(None:#194); 87:HwCalibration(None:#209); 88:WorkVesting(None:#216); 89:SyntheticTasks(None:#217); 90:Attest(None:#222); 91:AirdropVesting(None:#225); 92:BlockRewards(None:#229); 93:FlopSubsidy(None:#230); 94:FlopSessionKeys(None:#231); 95:AgentWallet(None:#232); 96:Validators(None:#234); 97:MinerStaking(None:#237); 100:MinerSlashing(None:#239); 98:DelegationCap(None:#241); 99:EmergencyOverride(None:#242); 101:ModelRegistry(None:#243); 109:ModelRegistrars(None:#269); 102:DaRegistry(None:#270); 108:PaidStorage(None:#271); 103:ComputeChannel(None:#293); 107:MeteringVerifier(None:#322); 104:Aleph(None:#325); 105:EmergencyPause(None:#326); 106:AgentIdentity(None:#327); 161:SettlementGroth16Pallet(None:#341); 162:SettlementRisc0Pallet(None:#352); 163:SettlementUltraplonkPallet(None:#356); 165:SettlementPlonky2Pallet(None:#360); 166:SettlementFFlonkPallet(None:#365); 167:SettlementSp1Pallet(None:#376); 168:SettlementUltrahonkPallet(None:#377); 169:SettlementEzklPallet(None:#384); 170:SettlementTeePallet(None:#387))` | `[]` |
| [RPC] | 62 | `frame_system::pallet::Call` | `enum(0:remark(remark:#14); 1:set_heap_pages(pages:#12); 2:set_code(code:#14); 3:set_code_without_checks(code:#14); 4:set_storage(items:#63); 5:kill_storage(keys:#65); 6:kill_prefix(prefix:#14, subkeys:#4); 7:remark_with_event(remark:#14); 9:authorize_upgrade(code_hash:#13); 10:authorize_upgrade_without_checks(code_hash:#13); 11:apply_authorized_upgrade(code:#14))` | `[{"name":"T","type":null}]` |
| [RPC] | 63 | `` | `sequence:64` | `[]` |
| [RPC] | 64 | `` | `tuple:[14,14]` | `[]` |
| [RPC] | 65 | `` | `sequence:14` | `[]` |
| [RPC] | 66 | `pallet_scheduler::pallet::Call` | `enum(0:schedule(when:#4, maybe_periodic:#67, priority:#2, call:#61); 1:cancel(when:#4, index:#4); 2:schedule_named(id:#1, when:#4, maybe_periodic:#67, priority:#2, call:#61); 3:cancel_named(id:#1); 4:schedule_after(after:#4, maybe_periodic:#67, priority:#2, call:#61); 5:schedule_named_after(id:#1, after:#4, maybe_periodic:#67, priority:#2, call:#61); 6:set_retry(task:#33, retries:#2, period:#4); 7:set_retry_named(id:#1, retries:#2, period:#4); 8:cancel_retry(task:#33); 9:cancel_retry_named(id:#1))` | `[{"name":"T","type":null}]` |
| [RPC] | 67 | `Option` | `enum(0:None(); 1:Some(None:#33))` | `[{"name":"T","type":33}]` |
| [RPC] | 68 | `pallet_preimage::pallet::Call` | `enum(0:note_preimage(bytes:#14); 1:unnote_preimage(hash:#13); 2:request_preimage(hash:#13); 3:unrequest_preimage(hash:#13); 4:ensure_updated(hashes:#69))` | `[{"name":"T","type":null}]` |
| [RPC] | 69 | `` | `sequence:13` | `[]` |
| [RPC] | 70 | `pallet_timestamp::pallet::Call` | `enum(0:set(now:#11))` | `[{"name":"T","type":null}]` |
| [RPC] | 71 | `pallet_balances::pallet::Call` | `enum(0:transfer_allow_death(dest:#72, value:#75); 2:force_transfer(source:#72, dest:#72, value:#75); 3:transfer_keep_alive(dest:#72, value:#75); 4:transfer_all(dest:#72, keep_alive:#8); 5:force_unreserve(who:#72, amount:#6); 6:upgrade_accounts(who:#76); 8:force_set_balance(who:#72, new_free:#75); 9:force_adjust_total_issuance(direction:#77, delta:#75); 10:burn(value:#75, keep_alive:#8))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 72 | `sp_runtime::multiaddress::MultiAddress` | `enum(0:Id(None:#0); 1:Index(None:#73); 2:Raw(None:#14); 3:Address32(None:#1); 4:Address20(None:#74))` | `[{"name":"AccountId","type":0},{"name":"AccountIndex","type":36}]` |
| [RPC] | 73 | `` | `compact:36` | `[]` |
| [RPC] | 74 | `` | `array:{"len":20,"type":2}` | `[]` |
| [RPC] | 75 | `` | `compact:6` | `[]` |
| [RPC] | 76 | `` | `sequence:0` | `[]` |
| [RPC] | 77 | `pallet_balances::types::AdjustmentDirection` | `enum(0:Increase(); 1:Decrease())` | `[]` |
| [RPC] | 78 | `pallet_babe::pallet::Call` | `enum(0:report_equivocation(equivocation_proof:#79, key_owner_proof:#84); 1:report_equivocation_unsigned(equivocation_proof:#79, key_owner_proof:#84); 2:plan_config_change(config:#85))` | `[{"name":"T","type":null}]` |
| [RPC] | 79 | `sp_consensus_slots::EquivocationProof` | `struct(offender:#82, slot:#83, first_header:#80, second_header:#80)` | `[{"name":"Header","type":80},{"name":"Id","type":82}]` |
| [RPC] | 80 | `sp_runtime::generic::header::Header` | `struct(parent_hash:#13, number:#81, state_root:#13, extrinsics_root:#13, digest:#15)` | `[{"name":"Number","type":4},{"name":"Hash","type":null}]` |
| [RPC] | 81 | `` | `compact:4` | `[]` |
| [RPC] | 82 | `sp_consensus_babe::app::Public` | `struct(None:#1)` | `[]` |
| [RPC] | 83 | `sp_consensus_slots::Slot` | `struct(None:#12)` | `[]` |
| [RPC] | 84 | `sp_session::MembershipProof` | `struct(session:#4, trie_nodes:#65, validator_count:#4)` | `[]` |
| [RPC] | 85 | `sp_consensus_babe::digests::NextConfigDescriptor` | `enum(1:V1(c:#86, allowed_slots:#87))` | `[]` |
| [RPC] | 86 | `` | `tuple:[12,12]` | `[]` |
| [RPC] | 87 | `sp_consensus_babe::AllowedSlots` | `enum(0:PrimarySlots(); 1:PrimaryAndSecondaryPlainSlots(); 2:PrimaryAndSecondaryVRFSlots())` | `[]` |
| [RPC] | 88 | `pallet_session::pallet::Call` | `enum(0:set_keys(keys:#89, proof:#14); 1:purge_keys())` | `[{"name":"T","type":null}]` |
| [RPC] | 89 | `zkv_runtime::SessionKeys` | `struct(babe:#82, authority_discovery:#90, aleph:#91)` | `[]` |
| [RPC] | 90 | `sp_authority_discovery::app::Public` | `struct(None:#1)` | `[]` |
| [RPC] | 91 | `hp_aleph::app::Public` | `struct(None:#1)` | `[]` |
| [RPC] | 92 | `pallet_treasury::pallet::Call` | `enum(3:spend_local(amount:#75, beneficiary:#72); 4:remove_approval(proposal_id:#81); 5:spend(asset_kind:#36, amount:#75, beneficiary:#0, valid_from:#93); 6:payout(index:#4); 7:check_status(index:#4); 8:void_spend(index:#4))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 93 | `Option` | `enum(0:None(); 1:Some(None:#4))` | `[{"name":"T","type":4}]` |
| [RPC] | 94 | `pallet_conviction_voting::pallet::Call` | `enum(0:vote(poll_index:#81, vote:#57); 1:delegate(class:#56, to:#72, conviction:#95, balance:#6); 2:undelegate(class:#56); 3:unlock(class:#56, target:#72); 4:remove_vote(class:#96, index:#4); 5:remove_other_vote(target:#72, class:#56, index:#4))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 95 | `pallet_conviction_voting::conviction::Conviction` | `enum(0:None(); 1:Locked1x(); 2:Locked2x(); 3:Locked3x(); 4:Locked4x(); 5:Locked5x(); 6:Locked6x())` | `[]` |
| [RPC] | 96 | `Option` | `enum(0:None(); 1:Some(None:#56))` | `[{"name":"T","type":56}]` |
| [RPC] | 97 | `pallet_referenda::pallet::Call` | `enum(0:submit(proposal_origin:#98, proposal:#60, enactment_moment:#101); 1:place_decision_deposit(index:#4); 2:refund_decision_deposit(index:#4); 3:cancel(index:#4); 4:kill(index:#4); 5:nudge_referendum(index:#4); 6:one_fewer_deciding(track:#56); 7:refund_submission_deposit(index:#4); 8:set_metadata(index:#4, maybe_hash:#102))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 98 | `zkv_runtime::OriginCaller` | `enum(0:system(None:#99); 17:Origins(None:#100))` | `[]` |
| [RPC] | 99 | `frame_support::dispatch::RawOrigin` | `enum(0:Root(); 1:Signed(None:#0); 2:None(); 3:Authorized())` | `[{"name":"AccountId","type":0}]` |
| [RPC] | 100 | `zkv_runtime::governance::origins::pallet_custom_origins::Origin` | `enum(0:ReferendumCanceller(); 1:MediumSpender(); 2:WishForChange())` | `[]` |
| [RPC] | 101 | `frame_support::traits::schedule::DispatchTime` | `enum(0:At(None:#4); 1:After(None:#4))` | `[{"name":"BlockNumber","type":4}]` |
| [RPC] | 102 | `Option` | `enum(0:None(); 1:Some(None:#13))` | `[{"name":"T","type":13}]` |
| [RPC] | 103 | `pallet_bounties::pallet::Call` | `enum(0:propose_bounty(value:#75, description:#14); 1:approve_bounty(bounty_id:#81); 2:propose_curator(bounty_id:#81, curator:#72, fee:#75); 3:unassign_curator(bounty_id:#81); 4:accept_curator(bounty_id:#81); 5:award_bounty(bounty_id:#81, beneficiary:#72); 6:claim_bounty(bounty_id:#81); 7:close_bounty(bounty_id:#81); 8:extend_bounty_expiry(bounty_id:#81, remark:#14); 9:approve_bounty_with_curator(bounty_id:#81, curator:#72, fee:#75); 10:poke_deposit(bounty_id:#81))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 104 | `pallet_child_bounties::pallet::Call` | `enum(0:add_child_bounty(parent_bounty_id:#81, value:#75, description:#14); 1:propose_curator(parent_bounty_id:#81, child_bounty_id:#81, curator:#72, fee:#75); 2:accept_curator(parent_bounty_id:#81, child_bounty_id:#81); 3:unassign_curator(parent_bounty_id:#81, child_bounty_id:#81); 4:award_child_bounty(parent_bounty_id:#81, child_bounty_id:#81, beneficiary:#72); 5:claim_child_bounty(parent_bounty_id:#81, child_bounty_id:#81); 6:close_child_bounty(parent_bounty_id:#81, child_bounty_id:#81))` | `[{"name":"T","type":null}]` |
| [RPC] | 105 | `pallet_utility::pallet::Call` | `enum(0:batch(calls:#106); 1:as_derivative(index:#56, call:#61); 2:batch_all(calls:#106); 3:dispatch_as(as_origin:#98, call:#61); 4:force_batch(calls:#106); 5:with_weight(call:#61, weight:#10); 6:if_else(main:#61, fallback:#61); 7:dispatch_as_fallible(as_origin:#98, call:#61))` | `[{"name":"T","type":null}]` |
| [RPC] | 106 | `` | `sequence:61` | `[]` |
| [RPC] | 107 | `pallet_multisig::pallet::Call` | `enum(0:as_multi_threshold_1(other_signatories:#76, call:#61); 1:as_multi(threshold:#56, other_signatories:#76, maybe_timepoint:#108, call:#61, max_weight:#10); 2:approve_as_multi(threshold:#56, other_signatories:#76, maybe_timepoint:#108, call_hash:#1, max_weight:#10); 3:cancel_as_multi(threshold:#56, other_signatories:#76, timepoint:#109, call_hash:#1); 4:poke_deposit(threshold:#56, other_signatories:#76, call_hash:#1))` | `[{"name":"T","type":null}]` |
| [RPC] | 108 | `Option` | `enum(0:None(); 1:Some(None:#109))` | `[{"name":"T","type":109}]` |
| [RPC] | 109 | `pallet_multisig::Timepoint` | `struct(height:#4, index:#4)` | `[{"name":"BlockNumber","type":4}]` |
| [RPC] | 110 | `pallet_proxy::pallet::Call` | `enum(0:proxy(real:#72, force_proxy_type:#111, call:#61); 1:add_proxy(delegate:#72, proxy_type:#112, delay:#4); 2:remove_proxy(delegate:#72, proxy_type:#112, delay:#4); 3:remove_proxies(); 4:create_pure(proxy_type:#112, delay:#4, index:#56); 5:kill_pure(spawner:#72, proxy_type:#112, index:#56, height:#81, ext_index:#81); 6:announce(real:#72, call_hash:#13); 7:remove_announcement(real:#72, call_hash:#13); 8:reject_announcement(delegate:#72, call_hash:#13); 9:proxy_announced(delegate:#72, real:#72, force_proxy_type:#111, call:#61); 10:poke_deposit())` | `[{"name":"T","type":null}]` |
| [RPC] | 111 | `Option` | `enum(0:None(); 1:Some(None:#112))` | `[{"name":"T","type":112}]` |
| [RPC] | 112 | `zkv_runtime::proxy::ProxyType` | `enum(0:Any(); 1:NonTransfer(); 2:Governance(); 3:Staking(); 4:CancelProxy())` | `[]` |
| [RPC] | 113 | `pallet_identity::pallet::Call` | `enum(0:add_registrar(account:#72); 1:set_identity(info:#114); 2:set_subs(subs:#149); 3:clear_identity(); 4:request_judgement(reg_index:#81, max_fee:#75); 5:cancel_request(reg_index:#4); 6:set_fee(index:#81, fee:#75); 7:set_account_id(index:#81, new:#72); 8:set_fields(index:#81, fields:#12); 9:provide_judgement(reg_index:#81, target:#72, judgement:#151, identity:#13); 10:kill_identity(target:#72); 11:add_sub(sub:#72, data:#117); 12:rename_sub(sub:#72, data:#117); 13:remove_sub(sub:#72); 14:quit_sub(); 15:add_username_authority(authority:#72, suffix:#14, allocation:#4); 16:remove_username_authority(suffix:#14, authority:#72); 17:set_username_for(who:#72, username:#14, signature:#152, use_allocation:#8); 18:accept_username(username:#156); 19:remove_expired_approval(username:#156); 20:set_primary_username(username:#156); 21:unbind_username(username:#156); 22:remove_username(username:#156); 23:kill_username(username:#156))` | `[{"name":"T","type":null}]` |
| [RPC] | 114 | `pallet_identity::legacy::IdentityInfo` | `struct(additional:#115, display:#117, legal:#117, web:#117, riot:#117, email:#117, pgp_fingerprint:#148, image:#117, twitter:#117)` | `[{"name":"FieldLimit","type":null}]` |
| [RPC] | 115 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#147)` | `[{"name":"T","type":116},{"name":"S","type":null}]` |
| [RPC] | 116 | `` | `tuple:[117,117]` | `[]` |
| [RPC] | 117 | `pallet_identity::types::Data` | `enum(0:None(); 1:Raw0(None:#118); 2:Raw1(None:#119); 3:Raw2(None:#120); 4:Raw3(None:#121); 5:Raw4(None:#18); 6:Raw5(None:#122); 7:Raw6(None:#123); 8:Raw7(None:#124); 9:Raw8(None:#125); 10:Raw9(None:#126); 11:Raw10(None:#127); 12:Raw11(None:#128); 13:Raw12(None:#129); 14:Raw13(None:#130); 15:Raw14(None:#131); 16:Raw15(None:#132); 17:Raw16(None:#51); 18:Raw17(None:#133); 19:Raw18(None:#134); 20:Raw19(None:#135); 21:Raw20(None:#74); 22:Raw21(None:#136); 23:Raw22(None:#137); 24:Raw23(None:#138); 25:Raw24(None:#139); 26:Raw25(None:#140); 27:Raw26(None:#141); 28:Raw27(None:#142); 29:Raw28(None:#143); 30:Raw29(None:#144); 31:Raw30(None:#145); 32:Raw31(None:#146); 33:Raw32(None:#1); 34:BlakeTwo256(None:#1); 35:Sha256(None:#1); 36:Keccak256(None:#1); 37:ShaThree256(None:#1))` | `[]` |
| [RPC] | 118 | `` | `array:{"len":0,"type":2}` | `[]` |
| [RPC] | 119 | `` | `array:{"len":1,"type":2}` | `[]` |
| [RPC] | 120 | `` | `array:{"len":2,"type":2}` | `[]` |
| [RPC] | 121 | `` | `array:{"len":3,"type":2}` | `[]` |
| [RPC] | 122 | `` | `array:{"len":5,"type":2}` | `[]` |
| [RPC] | 123 | `` | `array:{"len":6,"type":2}` | `[]` |
| [RPC] | 124 | `` | `array:{"len":7,"type":2}` | `[]` |
| [RPC] | 125 | `` | `array:{"len":8,"type":2}` | `[]` |
| [RPC] | 126 | `` | `array:{"len":9,"type":2}` | `[]` |
| [RPC] | 127 | `` | `array:{"len":10,"type":2}` | `[]` |
| [RPC] | 128 | `` | `array:{"len":11,"type":2}` | `[]` |
| [RPC] | 129 | `` | `array:{"len":12,"type":2}` | `[]` |
| [RPC] | 130 | `` | `array:{"len":13,"type":2}` | `[]` |
| [RPC] | 131 | `` | `array:{"len":14,"type":2}` | `[]` |
| [RPC] | 132 | `` | `array:{"len":15,"type":2}` | `[]` |
| [RPC] | 133 | `` | `array:{"len":17,"type":2}` | `[]` |
| [RPC] | 134 | `` | `array:{"len":18,"type":2}` | `[]` |
| [RPC] | 135 | `` | `array:{"len":19,"type":2}` | `[]` |
| [RPC] | 136 | `` | `array:{"len":21,"type":2}` | `[]` |
| [RPC] | 137 | `` | `array:{"len":22,"type":2}` | `[]` |
| [RPC] | 138 | `` | `array:{"len":23,"type":2}` | `[]` |
| [RPC] | 139 | `` | `array:{"len":24,"type":2}` | `[]` |
| [RPC] | 140 | `` | `array:{"len":25,"type":2}` | `[]` |
| [RPC] | 141 | `` | `array:{"len":26,"type":2}` | `[]` |
| [RPC] | 142 | `` | `array:{"len":27,"type":2}` | `[]` |
| [RPC] | 143 | `` | `array:{"len":28,"type":2}` | `[]` |
| [RPC] | 144 | `` | `array:{"len":29,"type":2}` | `[]` |
| [RPC] | 145 | `` | `array:{"len":30,"type":2}` | `[]` |
| [RPC] | 146 | `` | `array:{"len":31,"type":2}` | `[]` |
| [RPC] | 147 | `` | `sequence:116` | `[]` |
| [RPC] | 148 | `Option` | `enum(0:None(); 1:Some(None:#74))` | `[{"name":"T","type":74}]` |
| [RPC] | 149 | `` | `sequence:150` | `[]` |
| [RPC] | 150 | `` | `tuple:[0,117]` | `[]` |
| [RPC] | 151 | `pallet_identity::types::Judgement` | `enum(0:Unknown(); 1:FeePaid(None:#6); 2:Reasonable(); 3:KnownGood(); 4:OutOfDate(); 5:LowQuality(); 6:Erroneous())` | `[{"name":"Balance","type":6}]` |
| [RPC] | 152 | `Option` | `enum(0:None(); 1:Some(None:#153))` | `[{"name":"T","type":153}]` |
| [RPC] | 153 | `sp_runtime::MultiSignature` | `enum(0:Ed25519(None:#154); 1:Sr25519(None:#154); 2:Ecdsa(None:#155); 3:Eth(None:#155))` | `[]` |
| [RPC] | 154 | `` | `array:{"len":64,"type":2}` | `[]` |
| [RPC] | 155 | `` | `array:{"len":65,"type":2}` | `[]` |
| [RPC] | 156 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#14)` | `[{"name":"T","type":2},{"name":"S","type":null}]` |
| [RPC] | 157 | `pallet_sudo::pallet::Call` | `enum(0:sudo(call:#61); 1:sudo_unchecked_weight(call:#61, weight:#10); 2:set_key(new:#72); 3:sudo_as(who:#72, call:#61); 4:remove_key())` | `[{"name":"T","type":null}]` |
| [RPC] | 158 | `pallet_vesting::pallet::Call` | `enum(0:vest(); 1:vest_other(target:#72); 2:vested_transfer(target:#72, schedule:#159); 3:force_vested_transfer(source:#72, target:#72, schedule:#159); 4:merge_schedules(schedule1_index:#4, schedule2_index:#4); 5:force_remove_vesting_schedule(target:#72, schedule_index:#4))` | `[{"name":"T","type":null}]` |
| [RPC] | 159 | `pallet_vesting::vesting_info::VestingInfo` | `struct(locked:#6, per_block:#6, starting_block:#4)` | `[{"name":"Balance","type":6},{"name":"BlockNumber","type":4}]` |
| [RPC] | 160 | `pallet_aggregate::pallet::Call` | `enum(0:aggregate(domain_id:#4, aggregation_id:#12); 1:register_domain(aggregation_size:#4, queue_size:#93, aggregate_rules:#161, proof_rules:#162, delivery:#163, delivery_owner:#165); 2:hold_domain(domain_id:#4); 3:unregister_domain(domain_id:#4); 4:set_total_delivery_fee(domain_id:#4, fee:#6, owner_tip:#6); 5:allowlist_proof_submitters(domain_id:#4, submitters:#76); 6:remove_proof_submitters(domain_id:#4, submitters:#76))` | `[{"name":"T","type":null}]` |
| [RPC] | 161 | `pallet_aggregate::data::AggregateSecurityRules` | `enum(0:Untrusted(); 1:OnlyOwner(); 2:OnlyOwnerUncompleted())` | `[]` |
| [RPC] | 162 | `pallet_aggregate::data::ProofSecurityRules` | `enum(0:Untrusted(); 1:OnlyOwner(); 2:OnlyAllowlisted())` | `[]` |
| [RPC] | 163 | `pallet_aggregate::data::Delivery` | `struct(destination:#164, fee:#6, owner_tip:#6)` | `[{"name":"B","type":6}]` |
| [RPC] | 164 | `hp_dispatch::Destination` | `enum(0:None())` | `[]` |
| [RPC] | 165 | `Option` | `enum(0:None(); 1:Some(None:#0))` | `[{"name":"T","type":0}]` |
| [RPC] | 166 | `pallet_token_claim::pallet::Call` | `enum(0:begin_claim(beneficiaries:#167, claim_message:#172); 1:claim(beneficiary:#173, signature:#153); 2:claim_for(dest:#0); 3:add_beneficiaries(beneficiaries:#167); 4:end_claim(); 5:remove_beneficiaries(limit:#93); 6:claim_ethereum(beneficiary:#169, signature:#155, dest:#0); 7:claim_ethereum_for(beneficiary:#169, dest:#0))` | `[{"name":"T","type":null}]` |
| [RPC] | 167 | `BTreeMap` | `struct(None:#170)` | `[{"name":"K","type":168},{"name":"V","type":6}]` |
| [RPC] | 168 | `pallet_token_claim::beneficiary::Beneficiary` | `enum(0:Substrate(None:#0); 1:Ethereum(None:#169))` | `[{"name":"T","type":null}]` |
| [RPC] | 169 | `primitive_types::H160` | `struct(None:#74)` | `[]` |
| [RPC] | 170 | `` | `sequence:171` | `[]` |
| [RPC] | 171 | `` | `tuple:[168,6]` | `[]` |
| [RPC] | 172 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#14)` | `[{"name":"T","type":2},{"name":"S","type":null}]` |
| [RPC] | 173 | `sp_runtime::MultiSigner` | `enum(0:Ed25519(None:#1); 1:Sr25519(None:#1); 2:Ecdsa(None:#174); 3:Eth(None:#174))` | `[]` |
| [RPC] | 174 | `` | `array:{"len":33,"type":2}` | `[]` |
| [RPC] | 175 | `pallet_crl::pallet::Call` | `enum(0:register_ca(name:#14, root_cert:#14); 1:unregister_ca(name:#14); 2:update_crl(ca_name:#14, crl_input:#176))` | `[{"name":"T","type":null}]` |
| [RPC] | 176 | `pallet_crl::CrlInput` | `enum(0:Pem(crl:#14, cert_chain:#14); 1:Der(crl:#14, cert_chain:#14))` | `[]` |
| [RPC] | 177 | `pallet_has_station::pallet::Call` | `enum(18:create_near_htlc(agent:#178, task:#179, hash_lock:#13, reward_amount:#6, timeout_blocks:#4, near_recipient:#178, near_amount:#12, near_timeout_seconds:#4); 0:create_htlc(agent:#178, task:#179, hash_lock:#13, reward_amount:#6, timeout_blocks:#4); 1:redeem_htlc(htlc_id:#13, pre_image:#180, tee_quote:#182); 2:refund_htlc(htlc_id:#13); 3:check_htlc_status(hash_lock:#13); 4:create_cross_chain_htlc(agent:#178, task:#179, hash_lock:#13, reward_amount:#6, timeout_blocks:#4, btc_address:#178, btc_amount_sats:#12, btc_timelock_hours:#4); 5:relay_preimage(hash_lock:#13, pre_image:#180, btc_txid:#185); 6:update_chain_divergence_extrinsic(expected_btc_blocks:#12, actual_btc_blocks:#12); 7:register_relayer(relayer:#0); 8:unregister_relayer(relayer:#0); 9:create_htlc_commit(hash_commitment:#13, timeout_blocks:#4, btc_timeout_blocks:#93); 10:reveal_htlc(hash_commitment:#13, preimage:#180, salt:#180, miner:#0); 11:cancel_expired_commit(hash_commitment:#13); 12:open_escrow(payee:#0, amount:#6, policy:#187, deadline_blocks:#4); 13:approve_escrow(escrow_id:#13); 14:satisfy_escrow(escrow_id:#13, preimages:#192); 15:refund_escrow(escrow_id:#13); 16:create_htlc_for_work(agent:#178, task:#179, hash_lock:#13, reward_amount:#6, timeout_blocks:#4, task_hash:#13, output_commitment:#13); 17:redeem_htlc_with_receipt(htlc_id:#13, pre_image:#180, tee_quote:#182, receipt_hash:#13, verifier_ref:#102))` | `[{"name":"T","type":null}]` |
| [RPC] | 178 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#14)` | `[{"name":"T","type":2},{"name":"S","type":null}]` |
| [RPC] | 179 | `pallet_has_station::pallet::ComputeTask` | `struct(model:#180, prompt:#181, tee_requirements:#178)` | `[]` |
| [RPC] | 180 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#14)` | `[{"name":"T","type":2},{"name":"S","type":null}]` |
| [RPC] | 181 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#14)` | `[{"name":"T","type":2},{"name":"S","type":null}]` |
| [RPC] | 182 | `pallet_has_station::pallet::TeeQuote` | `struct(version:#183, gn_weight:#12, attestation:#184)` | `[]` |
| [RPC] | 183 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#14)` | `[{"name":"T","type":2},{"name":"S","type":null}]` |
| [RPC] | 184 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#14)` | `[{"name":"T","type":2},{"name":"S","type":null}]` |
| [RPC] | 185 | `Option` | `enum(0:None(); 1:Some(None:#186))` | `[{"name":"T","type":186}]` |
| [RPC] | 186 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#14)` | `[{"name":"T","type":2},{"name":"S","type":null}]` |
| [RPC] | 187 | `pallet_has_station::pallet::Policy` | `struct(combinator:#188, clauses:#189)` | `[{"name":"AccountId","type":0},{"name":"BlockNumber","type":4}]` |
| [RPC] | 188 | `pallet_has_station::pallet::Combinator` | `enum(0:And(); 1:Or(); 2:Threshold(None:#4))` | `[]` |
| [RPC] | 189 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#191)` | `[{"name":"T","type":190},{"name":"S","type":null}]` |
| [RPC] | 190 | `pallet_has_station::pallet::Predicate` | `enum(0:Hash(None:#13); 1:Sig(None:#0); 2:Before(None:#4); 3:After(None:#4); 4:Point(None:#174))` | `[{"name":"AccountId","type":0},{"name":"BlockNumber","type":4}]` |
| [RPC] | 191 | `` | `sequence:190` | `[]` |
| [RPC] | 192 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#193)` | `[{"name":"T","type":180},{"name":"S","type":null}]` |
| [RPC] | 193 | `` | `sequence:180` | `[]` |
| [RPC] | 194 | `pallet_flop_poui::pallet::Call` | `enum(0:submit_stark_batch(proofs:#195, gn_weight:#12, task_hash:#13, latency_ms:#12, model_hash:#13, output_hash:#13); 1:set_simulator_mode(enabled:#8); 2:register_hardware_key(key:#14); 3:reserved_idx_3(); 4:reserved_idx_4(); 5:submit_proof_for_verification(proofs:#195, gn_weight:#12, task_hash:#13, latency_ms:#12, model_hash:#13, output_hash:#13, decode_policy_hash:#13, hardware_id_hash:#13); 6:submit_validator_attestation(attestation:#199); 15:submit_validator_attestations(attestations:#201); 17:submit_poui_tee_attest_claim(task_hash:#13, claim:#202); 16:set_validator_attestation_threshold(threshold:#208); 13:set_gn_tripwire_enforced(enforced:#8))` | `[{"name":"T","type":null}]` |
| [RPC] | 195 | `` | `sequence:196` | `[]` |
| [RPC] | 196 | `pallet_flop_poui::pallet::StarkProof` | `struct(vk_hash:#13, proof_data:#197, public_inputs:#198)` | `[{"name":"T","type":null}]` |
| [RPC] | 197 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#14)` | `[{"name":"T","type":2},{"name":"S","type":null}]` |
| [RPC] | 198 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#14)` | `[{"name":"T","type":2},{"name":"S","type":null}]` |
| [RPC] | 199 | `hp_poui::ValidatorAttestation` | `struct(task_hash:#13, gn_weight:#12, latency_ms:#12, model_hash:#13, output_hash:#13, decode_policy_hash:#13, tee_type:#200, quote_verified:#8, event_log_verified:#8, hardware_id_hash:#13, validator_id:#1, signature:#154)` | `[]` |
| [RPC] | 200 | `hp_poui::TeeType` | `enum(0:IntelTdx(); 1:NvidiaHopperCc(); 2:NvidiaRubinCc(); 3:Simulator())` | `[]` |
| [RPC] | 201 | `` | `sequence:199` | `[]` |
| [RPC] | 202 | `hp_poui::AttestClaim` | `struct(profile_id:#13, profile_version:#4, evidence_hash:#13, claims_root:#13, verdict:#203, subject:#13, signatures:#206)` | `[]` |
| [RPC] | 203 | `hp_poui::AttestVerdict` | `struct(outcome:#204, reason_code:#205)` | `[]` |
| [RPC] | 204 | `hp_poui::AttestOutcome` | `enum(0:Pass(); 1:Fail())` | `[]` |
| [RPC] | 205 | `hp_poui::AttestReasonCode` | `enum(0:None(); 1:PolicyNotSatisfied(); 2:EvidenceUnavailable(); 3:Drift(); 4:CanaryMismatch(); 5:Fraud(); 6:Timeout(); 7:Other(None:#56); 8:Unverifiable(); 9:Unavailable(); 10:Stale(); 11:Conflicting(); 12:Rejected(); 13:Escrowed(); 14:Paused())` | `[]` |
| [RPC] | 206 | `` | `sequence:207` | `[]` |
| [RPC] | 207 | `hp_poui::AttestSignature` | `struct(verifier_id:#1, signature:#154)` | `[]` |
| [RPC] | 208 | `sp_arithmetic::per_things::Perbill` | `struct(None:#4)` | `[]` |
| [RPC] | 209 | `pallet_hw_calibration::pallet::Call` | `enum(0:record_attested_gpu_inventory(who:#0, inventory:#210); 1:set_sku_ceiling(sku:#186, ceiling_gflops_per_sec:#213); 2:accept_benchmark_burst(empirical_cap_gflops_per_sec:#12, burst_started_at:#4, jobs:#214); 3:renew_benchmark_cap(renewal_started_at:#4, jobs:#214); 4:record_hardware_fingerprint(who:#0, fingerprint:#13); 5:prune_expired_cap(who:#0))` | `[{"name":"T","type":null}]` |
| [RPC] | 210 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#212)` | `[{"name":"T","type":211},{"name":"S","type":null}]` |
| [RPC] | 211 | `` | `tuple:[186,56]` | `[]` |
| [RPC] | 212 | `` | `sequence:211` | `[]` |
| [RPC] | 213 | `Option` | `enum(0:None(); 1:Some(None:#12))` | `[{"name":"T","type":12}]` |
| [RPC] | 214 | `` | `sequence:215` | `[]` |
| [RPC] | 215 | `` | `tuple:[13,12]` | `[]` |
| [RPC] | 216 | `pallet_work_vesting::pallet::Call` | `enum(0:create_grant(miner:#0, amount:#6); 1:claim_unlocked(); 2:force_revoke_grant(miner:#0); 3:force_create_grant(miner:#0, amount:#6, pledge_baseline:#12))` | `[{"name":"T","type":null}]` |
| [RPC] | 217 | `pallet_synthetic_tasks::pallet::Call` | `enum(0:issue_ghost_task(target_miner:#0, task_hash:#13, gn_weight_expected:#12, deadline_blocks:#93); 1:batch_issue_ghost_tasks(tasks:#218, deadline_blocks:#93); 2:submit_ghost_result(task_hash:#13, correct:#8); 3:issue_calibration_job(target_miner:#0, task_hash:#13, expected_gn:#12, deadline_blocks:#93, pack_id:#4, output_commitment:#13); 7:batch_issue_calibration_jobs(jobs:#220, deadline_blocks:#93); 4:submit_ghost_attest_claim(task_hash:#13, claim:#202); 5:submit_ghost_appeal(task_hash:#13, evidence_hash:#13); 6:resolve_ghost_appeal(task_hash:#13, overturn:#8))` | `[{"name":"T","type":null}]` |
| [RPC] | 218 | `` | `sequence:219` | `[]` |
| [RPC] | 219 | `` | `tuple:[0,13,12]` | `[]` |
| [RPC] | 220 | `` | `sequence:221` | `[]` |
| [RPC] | 221 | `` | `tuple:[0,13,12,4,13]` | `[]` |
| [RPC] | 222 | `pallet_attest::pallet::Call` | `enum(0:upsert_profile(profile_id:#13, appraisal_policy_hash:#13, verifier_set:#223, assurance_tier:#224, min_threshold:#4, version:#4); 1:submit_claim(claim:#202))` | `[{"name":"T","type":null}]` |
| [RPC] | 223 | `` | `sequence:1` | `[]` |
| [RPC] | 224 | `hp_poui::AttestAssuranceTier` | `enum(0:Informational(); 1:Canary(); 2:Fraud(); 3:EconomicCritical())` | `[]` |
| [RPC] | 225 | `pallet_airdrop_vesting::pallet::Call` | `enum(0:create_airdrop_grant(beneficiary:#0, tier:#226, amount:#6, testnet_performance:#93); 1:batch_create_airdrop_grants(grants:#227); 2:claim_vested(); 3:update_miner_performance(miner:#0, mainnet_performance:#4))` | `[{"name":"T","type":null}]` |
| [RPC] | 226 | `pallet_airdrop_vesting::pallet::AirdropTier` | `enum(0:Miner(); 1:Validator(); 2:Agent())` | `[]` |
| [RPC] | 227 | `` | `sequence:228` | `[]` |
| [RPC] | 228 | `` | `tuple:[0,226,6,93]` | `[]` |
| [RPC] | 229 | `pallet_block_rewards::pallet::Call` | `enum(0:force_distribute())` | `[{"name":"T","type":null}]` |
| [RPC] | 230 | `pallet_flop_subsidy::pallet::Call` | `enum(0:force_end_subsidies())` | `[{"name":"T","type":null}]` |
| [RPC] | 231 | `pallet_session_keys::pallet::Call` | `enum(0:create_session(delegate:#0, spending_cap:#6, per_tx_limit:#6, daily_cap:#6, duration_blocks:#4, allowed_pallets:#65); 1:revoke_session(delegate:#0); 2:execute_via_session(owner:#0, call:#61, spend_amount:#6, nonce:#12); 3:force_revoke(owner:#0, delegate:#0); 4:force_reset_circuit_breaker(delegate:#0); 5:update_session_limits(delegate:#0, per_tx_limit:#6, daily_cap:#6))` | `[{"name":"T","type":null}]` |
| [RPC] | 232 | `pallet_agent_wallet::pallet::Call` | `enum(0:create_wallet(agent:#0, per_tx_limit:#6, daily_cap:#6, allowed_destinations:#76); 1:fund_wallet(agent:#0, amount:#6); 2:agent_transfer(destination:#0, amount:#6); 3:owner_withdraw(agent:#0, amount:#6); 4:deactivate_wallet(agent:#0); 5:reactivate_wallet(agent:#0); 6:settle_sponsored_payment(authorization:#233, signature:#153); 7:revoke_sponsored_payment(payment_id:#13); 8:prune_sponsored_payment(payer:#0, payment_id:#13))` | `[{"name":"T","type":null}]` |
| [RPC] | 233 | `pallet_agent_wallet::pallet::ExactPaymentAuthorization` | `struct(protocol_version:#56, mechanism_version:#56, network:#13, payer:#0, payee:#0, asset_id:#4, amount:#6, payment_id:#13, valid_after:#4, valid_before:#4, resource:#13, facilitator:#0)` | `[{"name":"AccountId","type":0},{"name":"Balance","type":6},{"name":"BlockNumber","type":4},{"name":"Hash","type":13}]` |
| [RPC] | 234 | `pallet_validators::pallet::Call` | `enum(0:register(); 1:deregister(); 2:update_performance(validator:#0, uptime:#4, block_rate:#4, accuracy:#4, latency:#4); 3:slash(validator:#0, reason:#235); 4:force_set_minimum_stake(new_stake:#6, reason:#14); 15:set_value_coupled_floor(value_floor:#6, reason:#14); 16:sponsor_validator(validator:#0, amount:#6, reward_policy:#236); 17:sponsor_unbond(position_id:#12, amount:#6); 18:sponsor_withdraw(position_id:#12); 19:sponsor_register_validator(validator:#0, amount:#6, reward_policy:#236); 20:sponsor_top_up(position_id:#12, amount:#6); 5:rotate(ejected:#4, promoted:#4); 6:eject_validator(validator:#0); 7:delegate(validator:#0, amount:#6); 8:undelegate(); 9:withdraw_unbonded(); 10:claim_rewards(); 11:set_commission(new_commission:#208); 12:jail(validator:#0, downtime_blocks:#4); 13:un_jail(); 14:rejoin())` | `[{"name":"T","type":null}]` |
| [RPC] | 235 | `pallet_validators::pallet::SlashingReason` | `enum(0:Collusion(); 1:Equivocation(); 2:EvidenceForgery(); 3:TeeAttestationFailure(); 4:Liveness())` | `[]` |
| [RPC] | 236 | `pallet_validators::pallet::SponsorRewardPolicy` | `enum(0:Operator(); 1:Sponsor())` | `[]` |
| [RPC] | 237 | `pallet_miner_staking::pallet::Call` | `enum(0:register_miner(commission_rate:#208); 1:deregister_miner(); 2:delegate(miner:#0, amount:#6); 3:unbond(miner:#0, amount:#6); 4:claim_unbonded(); 5:set_commission(new_rate:#208); 6:set_miner_status(is_active:#8); 7:distribute_rewards(miner:#0, total_reward:#6); 8:top_up_self_stake(amount:#6); 9:sponsor_miner(miner:#0, amount:#6, reward_policy:#238); 10:sponsor_unbond(position_id:#12, amount:#6); 11:sponsor_withdraw(position_id:#12); 12:retire_miner(miner:#0); 13:sponsor_register_miner(miner:#0, amount:#6, commission_rate:#208, reward_policy:#238); 14:sponsor_top_up(position_id:#12, amount:#6))` | `[{"name":"T","type":null}]` |
| [RPC] | 238 | `pallet_miner_staking::pallet::SponsorRewardPolicy` | `enum(0:Operator(); 1:Sponsor())` | `[]` |
| [RPC] | 239 | `pallet_miner_slashing::pallet::Call` | `enum(0:slash_proof_forgery(miner:#0, task_hash:#13); 1:slash_tee_failure(miner:#0, task_hash:#13); 2:slash_double_spending(miner:#0, task_hash:#13); 3:report_invalid_proof(miner:#0, task_hash:#13); 4:emergency_slash(miner:#0, reason:#240, slash_percent:#208, blacklist:#8); 5:unblacklist(miner:#0))` | `[{"name":"T","type":null}]` |
| [RPC] | 240 | `pallet_miner_slashing::pallet::SlashingReason` | `enum(0:ProofForgery(); 1:TeeAttestationFailure(); 2:DoubleSpending(); 3:InvalidProof(); 4:AuditLivenessForfeit())` | `[]` |
| [RPC] | 241 | `pallet_delegation_cap::pallet::Call` | `enum(0:register_validator(validator:#0); 1:deregister_validator(validator:#0); 2:update_cap(validator:#0))` | `[{"name":"T","type":null}]` |
| [RPC] | 242 | `pallet_emergency_override::pallet::Call` | `enum(0:queue_override(call:#14, reason:#14); 1:execute_override(); 2:cancel_override())` | `[{"name":"T","type":null}]` |
| [RPC] | 243 | `pallet_model_registry::pallet::Call` | `enum(0:register_model(model_hash:#13, model_name:#178, version:#183, model_uri:#184, architecture:#244, params_billion:#4, supported_precisions:#245, gflops_per_token:#12, min_vram_gb:#4, supported_tee_platforms:#248, task_types:#251, license_hash:#102); 18:set_model_workload_class(model_hash:#13, workload_class:#254); 1:approve_model(model_hash:#13, approver:#0); 2:deprecate_model(model_hash:#13, reason:#14); 3:revoke_model(model_hash:#13, reason:#14); 4:submit_benchmarks(model_hash:#13, benchmarks:#255); 5:verify_benchmarks(model_hash:#13, oracle_account:#0); 6:register_miner(model_hash:#13, gpu_model:#178, vram_gb:#4, tee_type:#249); 7:update_miner_availability(model_hash:#13, status:#259); 8:unregister_miner(model_hash:#13); 9:update_model_metrics(model_hash:#13, tasks_completed_delta:#12, gflops_consumed_delta:#12, latency_ms:#12, success:#8); 10:set_model_price(model_hash:#13, price_per_gflop:#6); 11:set_model_weights_ref(model_hash:#13, weights_ref:#260); 12:set_measured_root(model_hash:#13, precision:#246, root:#13); 13:remove_measured_root(model_hash:#13, precision:#246); 14:set_measured_root_enforcement(enabled:#8); 15:set_weight_mle_commitment(model_hash:#13, precision:#246, root:#13); 16:set_allowed_decode_policies(model_hash:#13, policies:#69); 17:clear_allowed_decode_policies(model_hash:#13); 19:set_tokens_per_byte_band_ppm(model_hash:#13, tokens_per_byte_band_ppm:#4); 20:set_model_arch_hash(model_hash:#13, arch_hash:#13); 22:set_model_admission_requirements(model_hash:#13, weights_size_bytes:#12, requires_hybrid_profile:#8); 23:set_qualification_profile(profile_id:#13, profile:#262); 24:set_qualification_custody(account:#0, domain:#102); 25:set_qualification_checker(profile_id:#13, checker:#0, qualified:#8); 26:qualification_opt_in(profile_id:#13, enabled:#8); 27:request_qualification(model_hash:#13, terms:#264); 28:accept_qualification(model_hash:#13, request_id:#13); 29:ack_qualification(model_hash:#13, request_id:#13); 30:submit_qualification_result(model_hash:#13, request_id:#13, output_hash:#13, evidence:#260, evidence_bytes:#12); 31:finish_qualification(model_hash:#13, request_id:#13, result_commitment:#13, verdict:#265, report_hash:#13); 32:cancel_qualification(model_hash:#13, request_id:#13); 33:expire_qualification(model_hash:#13, request_id:#13); 34:release_qualification_pins(model_hash:#13, request_id:#13); 21:set_model_mirrors(model_hash:#13, sources:#266))` | `[{"name":"T","type":null}]` |
| [RPC] | 244 | `pallet_model_registry::types::ModelArchitecture` | `enum(0:Transformer(); 1:CNN(); 2:RNN(); 3:LSTM(); 4:Diffusion(); 5:MixtureOfExperts(); 6:Custom(None:#180))` | `[]` |
| [RPC] | 245 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#247)` | `[{"name":"T","type":246},{"name":"S","type":null}]` |
| [RPC] | 246 | `pallet_model_registry::types::ModelPrecision` | `enum(0:FP32(); 1:FP16(); 2:BF16(); 3:INT8(); 4:INT4(); 5:Mixed())` | `[]` |
| [RPC] | 247 | `` | `sequence:246` | `[]` |
| [RPC] | 248 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#250)` | `[{"name":"T","type":249},{"name":"S","type":null}]` |
| [RPC] | 249 | `pallet_model_registry::types::TeeType` | `enum(0:NvidiaCc(); 1:IntelTdx(); 2:AmdSevSnp(); 3:IntelSgx())` | `[]` |
| [RPC] | 250 | `` | `sequence:249` | `[]` |
| [RPC] | 251 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#253)` | `[{"name":"T","type":252},{"name":"S","type":null}]` |
| [RPC] | 252 | `pallet_model_registry::types::Capability` | `enum(0:TextGeneration(); 1:Translation(); 2:Summarization(); 3:QuestionAnswering(); 4:CodeGeneration(); 5:CodeReview(); 6:MathematicalReasoning(); 7:LogicalReasoning(); 8:Planning(); 9:ImageGeneration(); 10:ImageUnderstanding(); 11:AudioGeneration(); 12:VideoGeneration(); 13:Embeddings(); 14:FunctionCalling(); 15:StructuredOutput())` | `[]` |
| [RPC] | 253 | `` | `sequence:252` | `[]` |
| [RPC] | 254 | `hp_poui::flop_meter::WorkloadClass` | `enum(0:LlmAutoregressive(); 1:DiffusionIterative(); 2:WorldModelRollout(); 3:PolicyControl())` | `[]` |
| [RPC] | 255 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#258)` | `[{"name":"T","type":256},{"name":"S","type":null}]` |
| [RPC] | 256 | `pallet_model_registry::types::BenchmarkScore` | `struct(benchmark_name:#178, score:#4, verified_at:#12, verified_by:#0, decays_at:#12, source:#257)` | `[]` |
| [RPC] | 257 | `pallet_model_registry::types::BenchmarkSource` | `enum(0:Official(); 1:Community(); 2:TeeVerified(); 3:External())` | `[]` |
| [RPC] | 258 | `` | `sequence:256` | `[]` |
| [RPC] | 259 | `pallet_model_registry::types::MinerAvailabilityStatus` | `enum(0:Online(); 1:Idle(); 2:Busy(); 3:Offline())` | `[]` |
| [RPC] | 260 | `pallet_da_registry::pallet::DataRef` | `struct(commitment:#13, provider_id:#2, retention:#261)` | `[]` |
| [RPC] | 261 | `pallet_da_registry::pallet::RetentionClass` | `enum(0:Ephemeral(); 1:Leased())` | `[]` |
| [RPC] | 262 | `Option` | `enum(0:None(); 1:Some(None:#263))` | `[{"name":"T","type":263}]` |
| [RPC] | 263 | `pallet_model_registry::qualification::QualificationProfile` | `struct(arch_hash:#13, precision:#246, decode_policy_hash:#13, backend_image_hash:#13, checker_version:#13, workload_hash:#13, max_evidence_bytes:#12, max_duration_blocks:#12)` | `[]` |
| [RPC] | 264 | `pallet_model_registry::qualification::QualificationTerms` | `struct(profile_id:#13, source:#184, revision:#74, manifest_hash:#13, checker:#0, execution_budget:#6, checking_budget:#6, storage_budget:#6, execution_fee:#6, checking_fee:#6, accept_by:#12, load_by:#12, execute_by:#12, check_by:#12, retain_until:#12)` | `[{"name":"AccountId","type":0}]` |
| [RPC] | 265 | `pallet_model_registry::qualification::QualificationVerdict` | `enum(0:Positive(); 1:Incorrect(); 2:Unavailable())` | `[]` |
| [RPC] | 266 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#268)` | `[{"name":"T","type":267},{"name":"S","type":null}]` |
| [RPC] | 267 | `pallet_model_registry::types::ModelSource` | `enum(0:Https(None:#184); 1:HuggingFace(None:#184); 2:ModelScope(None:#184); 3:DaLayer(None:#260))` | `[]` |
| [RPC] | 268 | `` | `sequence:267` | `[]` |
| [RPC] | 269 | `pallet_membership::pallet::Call` | `enum(0:add_member(who:#72); 1:remove_member(who:#72); 2:swap_member(remove:#72, add:#72); 3:reset_members(members:#76); 4:change_key(new:#72); 5:set_prime(who:#72); 6:clear_prime())` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 270 | `pallet_da_registry::pallet::Call` | `enum(0:register_blob(commitment:#13, size_bytes:#12); 1:issue_audit(commitment:#13, audit_id:#13, expected:#13, provider_index:#93); 2:submit_audit_response(audit_id:#13, response:#13); 13:submit_audit_attest_claim(audit_id:#13, claim:#202); 3:prune_blob(commitment:#13); 4:reassign_blob(commitment:#13); 5:top_up_lease(commitment:#13, additional_term:#4); 6:poke_lease(commitment:#13); 7:reactivate_blob(commitment:#13, size_bytes:#12, lease_term:#4); 8:withdraw_lease(commitment:#13); 9:set_deposit_per_byte(new:#6); 12:set_replication_factor(new:#4); 10:announce_endpoint(endpoint:#14); 11:clear_endpoint())` | `[{"name":"T","type":null}]` |
| [RPC] | 271 | `pallet_paid_storage::pallet::Call` | `enum(0:set_profile(profile:#272); 1:declare_capacity(epoch:#12, encoded_bytes:#12); 2:vote_tariff(epoch:#12, tariff:#276); 3:open_reservation(reserved_bytes:#12, term:#4, max_cost:#6, nonce:#12); 4:finalize_reservation(reservation:#12); 5:fund_service_lane(reservation:#12, provider:#0, budget:#6, nonce:#12); 6:redeem_service(lane:#1, voucher:#286); 7:close_service_lane(lane:#1); 8:finalize_service_lane(lane:#1); 9:advance_policy(reservation:#12, scope:#290); 10:revoke_policy(reservation:#12, scope:#290); 11:post_checkpoint(epoch:#12, root:#1, counters_commitment:#1); 12:set_rent_profile(terms:#291); 13:set_memory_profile(terms:#292))` | `[{"name":"T","type":null}]` |
| [RPC] | 272 | `Option` | `enum(0:None(); 1:Some(None:#273))` | `[{"name":"T","type":273}]` |
| [RPC] | 273 | `pallet_paid_storage::pallet::ProfileV` | `struct(version:#274, max_reservation_bytes:#12, max_lanes_per_owner:#4, epoch_length_blocks:#4, collateral_per_byte:#6, step_bound:#208, demand_headroom_bytes:#12, tripwire_epochs:#4, rent_den:#12, retrieval_den:#12, tariff_floor:#275, tariff_ceiling:#275, reservation_providers:#4, max_reservations:#4, max_term_blocks:#4, pending_expiry_blocks:#4, lane_claim_window_blocks:#4, admission:#277)` | `[]` |
| [RPC] | 274 | `pallet_paid_storage::pallet::ProfileVersion` | `enum(0:DevnetUnratified())` | `[]` |
| [RPC] | 275 | `Option` | `enum(0:None(); 1:Some(None:#276))` | `[{"name":"T","type":276}]` |
| [RPC] | 276 | `pallet_paid_storage::pallet::Rates` | `struct(rent_num:#12, setup_fee:#6, retrieval_num:#12, request_fee:#6)` | `[]` |
| [RPC] | 277 | `Option` | `enum(0:None(); 1:Some(None:#278))` | `[{"name":"T","type":278}]` |
| [RPC] | 278 | `pallet_paid_storage::admission::AdmissionPolicy` | `struct(provider:#279, protected:#279, payer:#279, max_attempts:#12, interval_ticks:#12, per_interval:#281, burst:#281, request_lifetime_blocks:#4, cpu_unit:#284, clock_domain:#285)` | `[]` |
| [RPC] | 279 | `pallet_paid_storage::admission::Resources` | `struct(occupancy:#280, work:#281, concurrency:#282, unpaid:#283)` | `[]` |
| [RPC] | 280 | `pallet_paid_storage::admission::Occupancy` | `struct(encoded_bytes:#12, objects:#12)` | `[]` |
| [RPC] | 281 | `pallet_paid_storage::admission::Work` | `struct(envelope_bytes:#12, signature_attempts:#12, ingress_bytes:#12, disk_read_bytes:#12, disk_write_bytes:#12, cpu_units:#12, egress_bytes:#12, retries:#12)` | `[]` |
| [RPC] | 282 | `pallet_paid_storage::admission::Concurrency` | `struct(requests:#12, connections:#12, work_slots:#12)` | `[]` |
| [RPC] | 283 | `pallet_paid_storage::admission::Unpaid` | `struct(amount:#6, bytes:#12, requests:#12)` | `[]` |
| [RPC] | 284 | `pallet_paid_storage::admission::CpuUnit` | `enum(0:ThreadCpuNanosecond())` | `[]` |
| [RPC] | 285 | `pallet_paid_storage::admission::ReplenishmentClock` | `enum(0:BlockHeight())` | `[]` |
| [RPC] | 286 | `pallet_paid_storage::wire::ServiceVoucher` | `struct(payload:#287, signature:#154)` | `[]` |
| [RPC] | 287 | `pallet_paid_storage::wire::ServiceVoucherPayload` | `struct(version:#288, suite:#289, genesis_hash:#1, lane:#1, sequence:#12, object:#1, object_version:#12, request_nonce:#1, range_commitment:#1, cumulative_activated_writes:#12, cumulative_deduplicated_bytes:#12, cumulative_requests:#12, cumulative_amount:#6, payer:#1, signer:#1)` | `[]` |
| [RPC] | 288 | `pallet_paid_storage::wire::WireProfileVersion` | `enum(0:DevnetUnratified())` | `[]` |
| [RPC] | 289 | `pallet_paid_storage::wire::SignatureSuite` | `enum(0:DevnetSr25519())` | `[]` |
| [RPC] | 290 | `pallet_paid_storage::policy::PolicyScope` | `struct(namespace:#186, object:#185)` | `[]` |
| [RPC] | 291 | `pallet_paid_storage::rent::RentProfileV` | `struct(version:#274, checkpoint_grace_blocks:#4, challenge_window_blocks:#4, max_steps_per_block:#4)` | `[]` |
| [RPC] | 292 | `pallet_paid_storage::memory::MemoryProfileV` | `struct(version:#274, head_quorum:#4, max_manifest_entries:#4, max_namespaces:#4, max_store_bytes:#12, max_request_bytes:#4, ciphertext_suite:#2, codec_id:#1, reconstruction_threshold:#4, plaintext_chunk_bytes:#4, max_private_manifest_bytes:#4, max_ciphertext_bytes:#12)` | `[]` |
| [RPC] | 293 | `pallet_compute_channel::pallet::Call` | `enum(0:open_channel(miner:#0, model_hash:#13, measured_root:#13, decode_policy_hash:#13, precision:#246, enclave_key:#1, agent_key:#1, sla:#294, escrow:#6, nonce:#12, settlement_class:#295); 1:top_up_escrow(channel_id:#13, additional:#6); 2:settle(channel_id:#13, final_root:#13, aggregate_gn:#6, claimed_measured_root:#13, agent_receipt_sig:#154, transcript_ref:#296, verified_turns:#297); 15:certificate_settle(channel_id:#13, final_root:#13, aggregate_gn:#6, claimed_measured_root:#13, agent_receipt_sig:#154, cert_commitment:#13, bookkeeping_cert:#102, transcript_ref:#296, sampled_audit:#302, metering_cert:#102); 3:force_settle(channel_id:#13, final_root:#13, aggregate_gn:#6, claimed_measured_root:#13, agent_receipt_sig:#154, transcript_ref:#296, verified_turns:#297); 4:finalize(channel_id:#13); 5:timeout(channel_id:#13); 6:open_dispute(channel_id:#13, contested_turn:#4); 17:open_bisection_dispute(channel_id:#13, n_turns:#4); 18:respond_bisection(channel_id:#13, left_root:#13, right_root:#13); 19:challenge_bisection(channel_id:#13, choose_left:#8); 7:respond_dispute(channel_id:#13, leaf_version:#299, turn_index:#4, h_in:#13, h_out:#13, g_n:#6, decode_policy_hash:#13, h_ids:#13, toploc_commitment_hash:#13, miner_recv_ms:#12, miner_done_ms:#12, latency_ms:#12, enclave_sig:#154, merkle_path:#300); 8:resolve_timeout_dispute(channel_id:#13); 20:resolve_unrecoverable_transcript(channel_id:#13); 42:set_fcu_empirical_params(params:#305); 43:set_fcu_mass_slash_paused(paused:#8); 47:set_fcu_primary_admissions_paused(paused:#8); 48:register_fcu_service_profile(profile:#307, qualification:#308); 49:set_fcu_service_profile_status(profile_hash:#13, status:#310); 26:fund_forward_offer(offer:#311, miner_signature:#154); 27:cancel_funded_forward_offer(offer_nonce:#12); 28:claim_forward_availability(channel_id:#13); 29:release_forward_bond(channel_id:#13, final_root:#13, aggregate_gn:#6, agent_receipt_sig:#154, verified_turns:#297); 30:assign_forward_channel(channel_id:#13, new_agent:#0, new_agent_key:#1, new_agent_signature:#154); 31:transfer_forward_units(channel_id:#13, to:#0, units:#6); 32:claim_forward_distribution(channel_id:#13); 33:open_forward_draw(channel_id:#13, units:#6, nonce:#12); 34:close_forward_draw(channel_id:#13, draw_id:#13); 35:post_forward_bid(model_hash:#13, measured_root:#13, decode_policy_hash:#13, precision:#246, agent_key:#1, sla:#294, terms:#313, nonce:#12); 36:commit_forward_bid_claim(bid_id:#13, commitment:#13); 37:seal_forward_bid_claims(bid_id:#13); 38:reveal_forward_bid_claim(bid_id:#13, enclave_key:#1, salt:#13); 39:clear_forward_bid(bid_id:#13); 40:cancel_forward_bid(bid_id:#13); 25:open_channel_with_offer(offer:#311, miner_signature:#154, measured_root:#13, decode_policy_hash:#13, agent_key:#1, escrow:#6, agent_signature:#154, settlement_class:#295); 9:force_open(miner:#0, model_hash:#13, measured_root:#13, decode_policy_hash:#13, precision:#246, agent_key:#1, sla:#294, escrow:#6, nonce:#12); 10:force_ack(channel_id:#13, enclave_key:#1); 41:register_session_evidence(channel_id:#13, slot:#314, commitment:#13, size_bytes:#4); 21:submit_toploc_evidence(channel_id:#13, commitment_ref:#13); 11:expire_force_open(channel_id:#13); 12:set_toploc_model_tolerance(model_hash:#13, tolerance:#315); 16:set_toploc_model_band_constants(model_hash:#13, precision:#246, constants:#316); 13:report_toploc_mismatch(channel_id:#13, miner:#0, attestations:#317); 14:report_toploc_mismatch_claim(channel_id:#13, miner:#0, turn_index:#4, activation_hash:#13, recomputed_hash:#13, distance:#319, milli_exponent_error:#12, claim:#202); 22:resolve_toploc_escalation(channel_id:#13, clear_sigs:#320); 23:expire_toploc_escalation(channel_id:#13); 24:claim_audit_fee(channel_id:#13, evidence:#13); 44:list_forward_units(channel_id:#13, units:#6, total_price:#6, expires_at:#4); 45:fill_forward_listing(channel_id:#13, seller:#0, listing_id:#13, max_total_price:#6); 46:cancel_forward_listing(channel_id:#13, seller:#0, listing_id:#13))` | `[{"name":"T","type":null}]` |
| [RPC] | 294 | `pallet_compute_channel::pallet::Sla` | `struct(max_turns:#4, max_duration:#4, reattest_every:#4)` | `[{"name":"BlockNumber","type":4}]` |
| [RPC] | 295 | `pallet_compute_channel::pallet::SettlementClass` | `enum(0:Standard(); 1:CertificatePremium())` | `[]` |
| [RPC] | 296 | `Option` | `enum(0:None(); 1:Some(None:#260))` | `[{"name":"T","type":260}]` |
| [RPC] | 297 | `` | `sequence:298` | `[]` |
| [RPC] | 298 | `pallet_compute_channel::pallet::VerifiedTurn` | `struct(leaf_version:#299, turn_index:#4, h_in:#13, h_out:#13, g_n:#6, decode_policy_hash:#13, h_ids:#13, toploc_commitment_hash:#13, miner_recv_ms:#12, miner_done_ms:#12, latency_ms:#12, enclave_sig:#154, merkle_path:#300)` | `[]` |
| [RPC] | 299 | `pallet_compute_channel::TranscriptLeafVersion` | `enum(0:V0(); 1:V1(); 2:V2(); 3:V3())` | `[]` |
| [RPC] | 300 | `` | `sequence:301` | `[]` |
| [RPC] | 301 | `` | `tuple:[13,8]` | `[]` |
| [RPC] | 302 | `Option` | `enum(0:None(); 1:Some(None:#303))` | `[{"name":"T","type":303}]` |
| [RPC] | 303 | `pallet_compute_channel::pallet::SampledAuditArgs` | `struct(beacon:#13, n_turns:#4, audit_turns:#304)` | `[]` |
| [RPC] | 304 | `` | `sequence:4` | `[]` |
| [RPC] | 305 | `Option` | `enum(0:None(); 1:Some(None:#306))` | `[{"name":"T","type":306}]` |
| [RPC] | 306 | `pallet_compute_channel::FcuEmpiricalParams` | `struct(bond_multiplier_ppm:#4, availability_split_ppm:#4)` | `[]` |
| [RPC] | 307 | `pallet_compute_channel::fcu_service::FcuServiceProfile` | `struct(version:#2, model_hash:#13, measured_root:#13, decode_policy_hash:#13, meter_profile_hash:#13, chunk_policy_hash:#13, timing_policy_hash:#13, remedy_policy_hash:#13, precision:#2, min_chunk_gn:#6, max_chunk_gn:#6, max_context_tokens:#6, max_output_tokens:#6, max_concurrency:#4, acceptance_budget_ms:#12)` | `[]` |
| [RPC] | 308 | `pallet_compute_channel::fcu_service::FcuProfileQualification` | `struct(evidence_hash:#13, witness_keys:#309, max_delivered_entries:#12, pilot_qualified:#8, economics_qualified:#8)` | `[]` |
| [RPC] | 309 | `` | `array:{"len":2,"type":1}` | `[]` |
| [RPC] | 310 | `pallet_compute_channel::fcu_service::FcuProfileStatus` | `enum(0:Admitted(); 1:Retired(); 2:EmergencyPaused())` | `[]` |
| [RPC] | 311 | `pallet_compute_channel::pallet::StandingOffer` | `struct(miner:#0, model_hash:#13, precision:#246, enclave_key:#1, min_escrow:#6, sla:#294, capacity_hint:#4, expiry:#4, nonce:#12, forward:#312)` | `[{"name":"AccountId","type":0},{"name":"Balance","type":6},{"name":"BlockNumber","type":4}]` |
| [RPC] | 312 | `Option` | `enum(0:None(); 1:Some(None:#313))` | `[{"name":"T","type":313}]` |
| [RPC] | 313 | `pallet_compute_channel::pallet::ForwardTerms` | `struct(start_block:#4, end_block:#4, duration_seconds:#12, quota_total:#6, price_per_gn:#6, bond:#6, backup:#165)` | `[{"name":"AccountId","type":0},{"name":"Balance","type":6},{"name":"BlockNumber","type":4}]` |
| [RPC] | 314 | `pallet_compute_channel::SessionEvidenceSlot` | `enum(0:Activation(None:#4); 1:Transcript())` | `[]` |
| [RPC] | 315 | `hp_poui::toploc::ToplocTolerance` | `struct(reject_misses_at_or_above:#56, reject_l1_at_or_above:#4, lane_delta:#56)` | `[]` |
| [RPC] | 316 | `hp_poui::toploc::ToplocBandConstants` | `struct(kappa_profile_hash:#13, band_tau_accept:#12, band_tau_slash:#12, challenge_k:#4, challenge_window_w:#12)` | `[]` |
| [RPC] | 317 | `` | `sequence:318` | `[]` |
| [RPC] | 318 | `hp_poui::toploc::ToplocMismatchAttestation` | `struct(channel_id:#13, turn_index:#4, activation_hash:#13, recomputed_hash:#13, distance:#319, milli_exponent_error:#12, validator_id:#1, signature:#154)` | `[]` |
| [RPC] | 319 | `hp_poui::toploc::ToplocDistance` | `struct(hamming_misses:#56, l1_distance:#4)` | `[]` |
| [RPC] | 320 | `` | `sequence:321` | `[]` |
| [RPC] | 321 | `` | `tuple:[1,154]` | `[]` |
| [RPC] | 322 | `pallet_metering_verifier::pallet::Call` | `enum(0:set_guest_image_id(image_id:#13); 1:clear_guest_image_id(); 2:submit_metering_cert(record:#323, receipt:#324); 3:prune_stale_cert(commitment:#13); 4:set_hybrid_profile(arch_hash:#13, image_id:#102); 5:submit_hybrid_cert(record:#323, receipt:#324); 6:prune_stale_hybrid_cert(commitment:#13))` | `[{"name":"T","type":null}]` |
| [RPC] | 323 | `pallet_metering_verifier::SessionMeteringRecord` | `struct(channel_id:#13, final_root:#13, aggregate_gn:#6, tokens_per_byte_band_ppm:#4, arch_hash:#13, n_turns:#4, circuit_version:#56)` | `[]` |
| [RPC] | 324 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#14)` | `[{"name":"T","type":2},{"name":"S","type":null}]` |
| [RPC] | 325 | `pallet_aleph::pallet::Call` | `enum(0:force_rotate(); 1:report_finalized(number:#4, hash:#13); 2:note_finalized(number:#4, hash:#13))` | `[{"name":"T","type":null}]` |
| [RPC] | 326 | `pallet_emergency_pause::pallet::Call` | `enum(0:emergency_pause(pallets:#65, reason:#14, duration:#93); 1:emergency_resume(pallet:#14); 2:emergency_pause_all(reason:#14, duration:#93); 3:emergency_resume_all())` | `[{"name":"T","type":null}]` |
| [RPC] | 327 | `pallet_agent_identity::pallet::Call` | `enum(0:register_agent(name:#183, agent_type:#328, capabilities:#329, endpoints:#192, metadata_uri:#180, stake_amount:#6); 1:update_agent(agent_id:#13, name:#332, capabilities:#333, endpoints:#334, metadata_uri:#335); 2:deposit_stake(agent_id:#13, amount:#6); 3:withdraw_stake(agent_id:#13, amount:#6); 4:record_reputation(agent_id:#13, event_type:#336, reason:#184, reference:#102); 5:record_tee_verification(agent_id:#13, verification_type:#337, result:#338, expires_at:#213, proof_hash:#102); 6:set_license(agent_id:#13, license_type:#339, price_per_task:#340, terms_uri:#180); 7:add_authorized_user(agent_id:#13, user:#0); 8:verify_agent(agent_id:#13); 9:revoke_agent(agent_id:#13, reason:#14); 10:pause_agent(agent_id:#13); 11:resume_agent(agent_id:#13); 12:report_task_completion(agent_id:#13, success:#8, flop_volume:#6))` | `[{"name":"T","type":null}]` |
| [RPC] | 328 | `pallet_agent_identity::types::AgentType` | `enum(0:Autonomous(); 1:SemiAutonomous(); 2:Supervised(); 3:HumanControlled())` | `[]` |
| [RPC] | 329 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#331)` | `[{"name":"T","type":330},{"name":"S","type":null}]` |
| [RPC] | 330 | `pallet_agent_identity::types::AgentCapability` | `enum(0:TextGeneration(); 1:CodeGeneration(); 2:CodeReview(); 3:Translation(); 4:Summarization(); 5:QuestionAnswering(); 6:MathematicalReasoning(); 7:LogicalReasoning(); 8:Planning(); 9:ToolUse(); 10:ImageGeneration(); 11:ImageUnderstanding(); 12:AudioGeneration(); 13:AudioTranscription(); 14:Embeddings(); 15:FunctionCalling(); 16:StructuredOutput(); 17:Custom(None:#183))` | `[]` |
| [RPC] | 331 | `` | `sequence:330` | `[]` |
| [RPC] | 332 | `Option` | `enum(0:None(); 1:Some(None:#183))` | `[{"name":"T","type":183}]` |
| [RPC] | 333 | `Option` | `enum(0:None(); 1:Some(None:#329))` | `[{"name":"T","type":329}]` |
| [RPC] | 334 | `Option` | `enum(0:None(); 1:Some(None:#192))` | `[{"name":"T","type":192}]` |
| [RPC] | 335 | `Option` | `enum(0:None(); 1:Some(None:#180))` | `[{"name":"T","type":180}]` |
| [RPC] | 336 | `pallet_agent_identity::types::ReputationEventType` | `enum(0:TaskSuccess(); 1:TaskFailure(); 2:TaskTimeout(); 3:SecurityViolation(); 4:TeeVerified(); 5:TeeFailed(); 6:StakeIncreased(); 7:StakeDecreased(); 8:PositiveFeedback(); 9:NegativeFeedback(); 10:ProtocolReward(); 11:ProtocolPenalty(); 12:ManualAdjustment())` | `[]` |
| [RPC] | 337 | `pallet_agent_identity::types::VerificationType` | `enum(0:IntelSGX(); 1:IntelTDX(); 2:NvidiaCC(); 3:AMDSEVSNP(); 4:AWSNitro(); 5:CapabilityOracle(); 6:AuthorityVerification())` | `[]` |
| [RPC] | 338 | `pallet_agent_identity::types::VerificationResult` | `enum(0:Passed(); 1:Failed(); 2:Pending(); 3:Expired())` | `[]` |
| [RPC] | 339 | `pallet_agent_identity::types::AgentLicenseType` | `enum(0:Open(); 1:Commercial(); 2:Whitelist(); 3:PayPerUse())` | `[]` |
| [RPC] | 340 | `Option` | `enum(0:None(); 1:Some(None:#6))` | `[{"name":"T","type":6}]` |
| [RPC] | 341 | `pallet_verifiers::pallet::Call` | `enum(0:submit_proof(vk_or_hash:#342, proof:#348, pubs:#350, domain_id:#93); 1:register_vk(vk:#343); 2:disable(disabled:#8); 3:unregister_vk(vk_hash:#13))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 342 | `pallet_verifiers::pallet::VkOrHash` | `enum(0:Hash(None:#13); 1:Vk(None:#343))` | `[{"name":"K","type":343}]` |
| [RPC] | 343 | `pallet_groth16_verifier::groth16::VerificationKeyWithCurve` | `struct(curve:#344, alpha_g1:#345, beta_g2:#346, gamma_g2:#346, delta_g2:#346, gamma_abc_g1:#347)` | `[]` |
| [RPC] | 344 | `pallet_groth16_verifier::groth16::Curve` | `enum(0:Bn254(); 1:Bls12_381())` | `[]` |
| [RPC] | 345 | `hp_groth16::data_structures::G1` | `struct(None:#14)` | `[]` |
| [RPC] | 346 | `hp_groth16::data_structures::G2` | `struct(None:#14)` | `[]` |
| [RPC] | 347 | `` | `sequence:345` | `[]` |
| [RPC] | 348 | `pallet_groth16_verifier::groth16::ProofWithCurve` | `struct(curve:#344, proof:#349)` | `[]` |
| [RPC] | 349 | `hp_groth16::data_structures::Proof` | `struct(a:#345, b:#346, c:#345)` | `[]` |
| [RPC] | 350 | `` | `sequence:351` | `[]` |
| [RPC] | 351 | `hp_groth16::data_structures::Scalar` | `struct(None:#14)` | `[]` |
| [RPC] | 352 | `pallet_verifiers::pallet::Call` | `enum(0:submit_proof(vk_or_hash:#353, proof:#354, pubs:#355, domain_id:#93); 1:register_vk(vk:#13); 2:disable(disabled:#8); 3:unregister_vk(vk_hash:#13))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 353 | `pallet_verifiers::pallet::VkOrHash` | `enum(0:Hash(None:#13); 1:Vk(None:#13))` | `[{"name":"K","type":13}]` |
| [RPC] | 354 | `pallet_risc0_verifier::Proof` | `enum(0:V1_0(None:#14); 1:V1_1(None:#14); 2:V1_2(None:#14); 3:V2_0(None:#14); 4:V2_1(None:#14); 5:V2_2(None:#14); 6:V2_3(None:#14); 7:V3_0(None:#14))` | `[]` |
| [RPC] | 355 | `` | `sequence:2` | `[]` |
| [RPC] | 356 | `pallet_verifiers::pallet::Call` | `enum(0:submit_proof(vk_or_hash:#357, proof:#355, pubs:#359, domain_id:#93); 1:register_vk(vk:#358); 2:disable(disabled:#8); 3:unregister_vk(vk_hash:#13))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 357 | `pallet_verifiers::pallet::VkOrHash` | `enum(0:Hash(None:#13); 1:Vk(None:#358))` | `[{"name":"K","type":358}]` |
| [RPC] | 358 | `` | `array:{"len":1632,"type":2}` | `[]` |
| [RPC] | 359 | `` | `sequence:1` | `[]` |
| [RPC] | 360 | `pallet_verifiers::pallet::Call` | `enum(0:submit_proof(vk_or_hash:#361, proof:#364, pubs:#355, domain_id:#93); 1:register_vk(vk:#362); 2:disable(disabled:#8); 3:unregister_vk(vk_hash:#13))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 361 | `pallet_verifiers::pallet::VkOrHash` | `enum(0:Hash(None:#13); 1:Vk(None:#362))` | `[{"name":"K","type":362}]` |
| [RPC] | 362 | `pallet_plonky2_verifier::vk::VkWithConfig` | `struct(config:#363, bytes:#14)` | `[{"name":"T","type":null}]` |
| [RPC] | 363 | `pallet_plonky2_verifier::vk::Plonky2Config` | `enum(0:Keccak(); 1:Poseidon())` | `[]` |
| [RPC] | 364 | `pallet_plonky2_verifier::proof::Proof` | `struct(bytes:#14)` | `[{"name":"T","type":null}]` |
| [RPC] | 365 | `pallet_verifiers::pallet::Call` | `enum(0:submit_proof(vk_or_hash:#366, proof:#375, pubs:#1, domain_id:#93); 1:register_vk(vk:#367); 2:disable(disabled:#8); 3:unregister_vk(vk_hash:#13))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 366 | `pallet_verifiers::pallet::VkOrHash` | `enum(0:Hash(None:#13); 1:Vk(None:#367))` | `[{"name":"K","type":367}]` |
| [RPC] | 367 | `pallet_fflonk_verifier::vk::Vk` | `struct(power:#2, k1:#368, k2:#368, w:#368, w3:#368, w4:#368, w8:#368, wr:#368, x2:#371, c0:#374)` | `[]` |
| [RPC] | 368 | `pallet_fflonk_verifier::vk::Fr` | `struct(None:#369)` | `[]` |
| [RPC] | 369 | `primitive_types::U256` | `struct(None:#370)` | `[]` |
| [RPC] | 370 | `` | `array:{"len":4,"type":12}` | `[]` |
| [RPC] | 371 | `pallet_fflonk_verifier::vk::G2` | `struct(None:#372, None:#372, None:#372)` | `[]` |
| [RPC] | 372 | `pallet_fflonk_verifier::vk::Fq2` | `struct(None:#373, None:#373)` | `[]` |
| [RPC] | 373 | `pallet_fflonk_verifier::vk::Fq` | `struct(None:#369)` | `[]` |
| [RPC] | 374 | `pallet_fflonk_verifier::vk::G1` | `struct(None:#373, None:#373, None:#373)` | `[]` |
| [RPC] | 375 | `` | `array:{"len":768,"type":2}` | `[]` |
| [RPC] | 376 | `pallet_verifiers::pallet::Call` | `enum(0:submit_proof(vk_or_hash:#353, proof:#355, pubs:#355, domain_id:#93); 1:register_vk(vk:#13); 2:disable(disabled:#8); 3:unregister_vk(vk_hash:#13))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 377 | `pallet_verifiers::pallet::Call` | `enum(0:submit_proof(vk_or_hash:#378, proof:#382, pubs:#359, domain_id:#93); 1:register_vk(vk:#379); 2:disable(disabled:#8); 3:unregister_vk(vk_hash:#13))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 378 | `pallet_verifiers::pallet::VkOrHash` | `enum(0:Hash(None:#13); 1:Vk(None:#379))` | `[{"name":"K","type":379}]` |
| [RPC] | 379 | `pallet_ultrahonk_verifier::VersionedVk` | `enum(0:V0_84(None:#380); 1:V3_0(None:#381))` | `[]` |
| [RPC] | 380 | `` | `array:{"len":1760,"type":2}` | `[]` |
| [RPC] | 381 | `` | `array:{"len":1888,"type":2}` | `[]` |
| [RPC] | 382 | `pallet_ultrahonk_verifier::VersionedProof` | `enum(0:V0_84(None:#383); 1:V3_0(None:#383))` | `[]` |
| [RPC] | 383 | `pallet_ultrahonk_verifier::Proof` | `enum(0:ZK(None:#14); 1:Plain(None:#14))` | `[]` |
| [RPC] | 384 | `pallet_verifiers::pallet::Call` | `enum(0:submit_proof(vk_or_hash:#385, proof:#355, pubs:#359, domain_id:#93); 1:register_vk(vk:#386); 2:disable(disabled:#8); 3:unregister_vk(vk_hash:#13))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 385 | `pallet_verifiers::pallet::VkOrHash` | `enum(0:Hash(None:#13); 1:Vk(None:#386))` | `[{"name":"K","type":386}]` |
| [RPC] | 386 | `pallet_ezkl_verifier::EzklVk` | `struct(vk_bytes:#14)` | `[]` |
| [RPC] | 387 | `pallet_verifiers::pallet::Call` | `enum(0:submit_proof(vk_or_hash:#388, proof:#355, pubs:#355, domain_id:#93); 1:register_vk(vk:#389); 2:disable(disabled:#8); 3:unregister_vk(vk_hash:#13))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 388 | `pallet_verifiers::pallet::VkOrHash` | `enum(0:Hash(None:#13); 1:Vk(None:#389))` | `[{"name":"K","type":389}]` |
| [RPC] | 389 | `pallet_tee_verifier::Vk` | `enum(0:Intel(tcb_response:#14, certificates:#14); 1:Nitro())` | `[]` |
| [RPC] | 390 | `sp_runtime::traits::BlakeTwo256` | `struct()` | `[]` |
| [RPC] | 391 | `pallet_conviction_voting::types::Tally` | `struct(ayes:#6, nays:#6, support:#6)` | `[{"name":"Votes","type":6},{"name":"Total","type":null}]` |
| [RPC] | 392 | `pallet_bounties::pallet::Event` | `enum(0:BountyProposed(index:#4); 1:BountyRejected(index:#4, bond:#6); 2:BountyBecameActive(index:#4); 3:BountyAwarded(index:#4, beneficiary:#0); 4:BountyClaimed(index:#4, payout:#6, beneficiary:#0); 5:BountyCanceled(index:#4); 6:BountyExtended(index:#4); 7:BountyApproved(index:#4); 8:CuratorProposed(bounty_id:#4, curator:#0); 9:CuratorUnassigned(bounty_id:#4); 10:CuratorAccepted(bounty_id:#4, curator:#0); 11:DepositPoked(bounty_id:#4, proposer:#0, old_deposit:#6, new_deposit:#6))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 393 | `pallet_child_bounties::pallet::Event` | `enum(0:Added(index:#4, child_index:#4); 1:Awarded(index:#4, child_index:#4, beneficiary:#0); 2:Claimed(index:#4, child_index:#4, payout:#6, beneficiary:#0); 3:Canceled(index:#4, child_index:#4))` | `[{"name":"T","type":null}]` |
| [RPC] | 394 | `pallet_utility::pallet::Event` | `enum(0:BatchInterrupted(index:#4, error:#26); 1:BatchCompleted(); 2:BatchCompletedWithErrors(); 3:ItemCompleted(); 4:ItemFailed(error:#26); 5:DispatchedAs(result:#35); 6:IfElseMainSuccess(); 7:IfElseFallbackCalled(main_error:#26))` | `[]` |
| [RPC] | 395 | `pallet_multisig::pallet::Event` | `enum(0:NewMultisig(approving:#0, multisig:#0, call_hash:#1); 1:MultisigApproval(approving:#0, timepoint:#109, multisig:#0, call_hash:#1); 2:MultisigExecuted(approving:#0, timepoint:#109, multisig:#0, call_hash:#1, result:#35); 3:MultisigCancelled(cancelling:#0, timepoint:#109, multisig:#0, call_hash:#1); 4:DepositPoked(who:#0, call_hash:#1, old_deposit:#6, new_deposit:#6))` | `[{"name":"T","type":null}]` |
| [RPC] | 396 | `pallet_proxy::pallet::Event` | `enum(0:ProxyExecuted(result:#35); 1:PureCreated(pure:#0, who:#0, proxy_type:#112, disambiguation_index:#56, at:#4, extrinsic_index:#4); 2:PureKilled(pure:#0, spawner:#0, proxy_type:#112, disambiguation_index:#56); 3:Announced(real:#0, proxy:#0, call_hash:#13); 4:ProxyAdded(delegator:#0, delegatee:#0, proxy_type:#112, delay:#4); 5:ProxyRemoved(delegator:#0, delegatee:#0, proxy_type:#112, delay:#4); 6:DepositPoked(who:#0, kind:#397, old_deposit:#6, new_deposit:#6))` | `[{"name":"T","type":null}]` |
| [RPC] | 397 | `pallet_proxy::DepositKind` | `enum(0:Proxies(); 1:Announcements())` | `[]` |
| [RPC] | 398 | `pallet_identity::pallet::Event` | `enum(0:IdentitySet(who:#0); 1:IdentityCleared(who:#0, deposit:#6); 2:IdentityKilled(who:#0, deposit:#6); 3:JudgementRequested(who:#0, registrar_index:#4); 4:JudgementUnrequested(who:#0, registrar_index:#4); 5:JudgementGiven(target:#0, registrar_index:#4); 6:RegistrarAdded(registrar_index:#4); 7:SubIdentityAdded(sub:#0, main:#0, deposit:#6); 8:SubIdentitiesSet(main:#0, number_of_subs:#4, new_deposit:#6); 9:SubIdentityRenamed(sub:#0, main:#0); 10:SubIdentityRemoved(sub:#0, main:#0, deposit:#6); 11:SubIdentityRevoked(sub:#0, main:#0, deposit:#6); 12:AuthorityAdded(authority:#0); 13:AuthorityRemoved(authority:#0); 14:UsernameSet(who:#0, username:#156); 15:UsernameQueued(who:#0, username:#156, expiration:#4); 16:PreapprovalExpired(whose:#0); 17:PrimaryUsernameSet(who:#0, username:#156); 18:DanglingUsernameRemoved(who:#0, username:#156); 19:UsernameUnbound(username:#156); 20:UsernameRemoved(username:#156); 21:UsernameKilled(username:#156))` | `[{"name":"T","type":null}]` |
| [RPC] | 399 | `pallet_sudo::pallet::Event` | `enum(0:Sudid(sudo_result:#35); 1:KeyChanged(old:#165, new:#0); 2:KeyRemoved(); 3:SudoAsDone(sudo_result:#35))` | `[{"name":"T","type":null}]` |
| [RPC] | 400 | `pallet_vesting::pallet::Event` | `enum(0:VestingCreated(account:#0, schedule_index:#4); 1:VestingUpdated(account:#0, unvested:#6); 2:VestingCompleted(account:#0))` | `[{"name":"T","type":null}]` |
| [RPC] | 401 | `pallet_aggregate::pallet::Event` | `enum(0:NewDomain(id:#4); 1:DomainStateChanged(id:#4, state:#402); 2:NewProof(statement:#13, domain_id:#4, aggregation_id:#12); 3:AggregationComplete(domain_id:#4, aggregation_id:#12); 4:NewAggregationReceipt(domain_id:#4, aggregation_id:#12, receipt:#13); 5:CannotAggregate(statement:#13, cause:#403); 6:DomainFull(domain_id:#4))` | `[{"name":"T","type":null}]` |
| [RPC] | 402 | `pallet_aggregate::data::DomainState` | `enum(0:Ready(); 1:Hold(); 2:Removable(); 3:Removed())` | `[]` |
| [RPC] | 403 | `pallet_aggregate::pallet::CannotAggregateCause` | `enum(0:NoAccount(); 1:DomainNotRegistered(domain_id:#4); 2:DomainStorageFull(domain_id:#4); 3:InsufficientFunds(); 4:InvalidDomainState(domain_id:#4, state:#402); 5:UnauthorizedUser())` | `[]` |
| [RPC] | 404 | `pallet_token_claim::pallet::Event` | `enum(0:ClaimStarted(claim_id:#12, claim_message:#172); 1:Claimed(beneficiary:#168, amount:#6); 2:ClaimEnded(claim_id:#12, claim_message:#172); 3:BeneficiariesRemoved(remaining:#4); 4:NoMoreBeneficiaries())` | `[{"name":"T","type":null}]` |
| [RPC] | 405 | `pallet_crl::pallet::Event` | `enum(0:CaRegistered(name:#406); 1:CaUnregistered(name:#406); 2:CrlUpdated(ca_name:#406, issuer:#14, last_update:#12, revoked_count:#4))` | `[{"name":"T","type":null}]` |
| [RPC] | 406 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#14)` | `[{"name":"T","type":2},{"name":"S","type":null}]` |
| [RPC] | 407 | `pallet_has_station::pallet::Event` | `enum(0:HtlcCreated(htlc_id:#13, hash_lock:#13, agent:#14, reward_amount:#6, timeout_block:#4); 1:HtlcRedeemed(htlc_id:#13, hash_lock:#13, miner:#14, gn_used:#12, quote_digest:#102); 2:HtlcRefunded(htlc_id:#13, hash_lock:#13, agent:#14); 3:CrossChainHtlcCreated(htlc_id:#13, hash_lock:#13, btc_amount_sats:#12, flop_reward_amount:#6); 4:PreimageRelayed(htlc_id:#13, hash_lock:#13, relayer:#0); 5:RelayerRegistered(relayer:#0); 6:RelayerUnregistered(relayer:#0); 7:HtlcCommitCreated(hash_commitment:#13, committer:#0, expiry_block:#4); 8:HtlcRevealed(hash_commitment:#13, committer:#0, preimage:#14); 9:CommitExpired(hash_commitment:#13); 10:CircuitBreakerTriggered(divergence_pct:#4, block:#4); 11:SettlementResumed(block:#4); 12:ChainDivergenceUpdated(divergence_pct:#4, expected_btc_blocks:#12, actual_btc_blocks:#12); 13:EscrowOpened(escrow_id:#13, funder:#0, payee:#0, amount:#6, deadline:#4); 14:EscrowApproved(escrow_id:#13, approver:#0); 15:EscrowReleased(escrow_id:#13, payee:#0, amount:#6); 16:PointWitnessRevealed(escrow_id:#13, statement:#174, witness:#1); 17:EscrowRefunded(escrow_id:#13, funder:#0, amount:#6); 18:ControlledEscrowReleased(escrow_id:#13, amount:#6, remaining:#6); 19:ControlledEscrowSettled(escrow_id:#13, released_to_funder:#6, paid_out:#6); 20:HtlcWorkCreated(htlc_id:#13, hash_lock:#13, task_hash:#13, output_commitment:#13); 21:HtlcWorkClaimed(htlc_id:#13, hash_lock:#13, receipt_hash:#13, verifier_ref:#102); 22:HtlcTimeoutBurned(htlc_id:#13, amount:#6))` | `[{"name":"T","type":null}]` |
| [RPC] | 408 | `pallet_flop_poui::pallet::Event` | `enum(0:ProofSubmitted(who:#0, total_gn_weight:#12, success_count:#4, task_hash:#13, latency_ms:#12, model_hash:#13, output_hash:#13, decode_policy_hash:#13); 1:SimulatorModeChanged(enabled:#8); 2:GnTripwireRejected(who:#0, task_hash:#13, gn_weight:#12, latency_ms:#12, ceiling_gflops_per_sec:#12); 3:GnTripwireEnforcementChanged(enforced:#8); 4:HardwareKeyRegistered(key:#14); 5:ProofPendingVerification(who:#0, task_hash:#13, gn_weight_claimed:#12, latency_ms:#12, model_hash:#13, output_hash:#13, decode_policy_hash:#13); 6:ValidatorAttestationReceived(validator:#0, task_hash:#13, verified:#8, latency_ms:#12); 7:ValidatorAttestationThresholdUpdated(threshold:#208); 8:VerificationExpired(task_hash:#13); 9:MinerSlashed(miner:#0, reason:#409, gn_weight:#12, slash_percentage:#4); 10:MinerBlacklisted(miner:#0, reason:#409, gn_weight:#12); 11:ProofRejectedBlacklistedHardware(who:#0, task_hash:#13, hardware_id_hash:#13); 12:PouiTeeAttestClaimAccepted(task_hash:#13, profile:#410, verdict:#203); 13:PouiTeeAttestClaimRejected(task_hash:#13, profile:#410, verdict:#203))` | `[{"name":"T","type":null}]` |
| [RPC] | 409 | `pallet_flop_poui::types::BlacklistReason` | `enum(0:TeeVerificationFailed(); 1:TeeViolation(); 2:ReplayAttack(); 3:InvalidProof(); 4:OracleReportedForgery(); 5:RepeatedFailures(None:#4))` | `[]` |
| [RPC] | 410 | `hp_poui::AttestProfileRef` | `struct(profile_id:#13, version:#4)` | `[]` |
| [RPC] | 411 | `pallet_hw_calibration::pallet::Event` | `enum(0:AttestedGpuInventoryRecorded(who:#0, inventory:#210); 1:SkuCeilingSet(sku:#186, ceiling_gflops_per_sec:#213); 2:BenchmarkBurstAccepted(who:#0, cap_gflops_per_sec:#12, empirical_cap_gflops_per_sec:#12, assurance_tier:#412, calibration_version:#4, verified_jobs:#4, burst_elapsed_blocks:#12, expected_gn_sum:#6, expires_at:#4); 3:BenchmarkCapRenewed(who:#0, cap_gflops_per_sec:#12, assurance_tier:#412, calibration_version:#4, verified_jobs:#4, expected_gn_sum:#6, expires_at:#4); 4:BenchmarkCapInvalidated(who:#0, reason:#413); 5:BenchmarkCapPruned(who:#0); 6:HardwareFingerprintRecorded(who:#0, fingerprint:#13))` | `[{"name":"T","type":null}]` |
| [RPC] | 412 | `pallet_hw_calibration::pallet::AssuranceTier` | `enum(0:Soft(); 1:Hard())` | `[]` |
| [RPC] | 413 | `pallet_hw_calibration::pallet::CalibrationInvalidationReason` | `enum(0:AttestedInventoryChanged(); 1:HardwareFingerprintChanged())` | `[]` |
| [RPC] | 414 | `pallet_work_vesting::pallet::Event` | `enum(0:GrantCreated(miner:#0, amount:#6, pledge_baseline:#12); 1:TokensUnlocked(miner:#0, amount:#6, remaining_frozen:#6); 2:GrantFullyVested(miner:#0); 3:GrantRevoked(miner:#0, amount_to_treasury:#6, reason:#415); 4:EscrowSlashed(miner:#0, amount_slashed:#6, remaining_frozen:#6); 5:EpochRolledOver(epoch_start_block:#4); 6:BlackoutWarning(miner:#0, consecutive_failing_epochs:#4))` | `[{"name":"T","type":null}]` |
| [RPC] | 415 | `pallet_work_vesting::pallet::RevocationReason` | `enum(0:BlackoutClause(); 1:Governance())` | `[]` |
| [RPC] | 416 | `pallet_synthetic_tasks::pallet::Event` | `enum(0:GhostTaskIssued(task_hash:#13, target_miner:#0, gn_weight_expected:#12, deadline:#4); 1:GhostTaskCompleted(task_hash:#13, target_miner:#0); 2:GhostTaskExpired(task_hash:#13, target_miner:#0, gn_weight_expected:#12); 3:GhostTaskIncorrect(task_hash:#13, target_miner:#0, gn_weight_expected:#12); 4:CalibrationJobIssued(task_hash:#13, target_miner:#0, expected_gn:#12, pack_id:#4, deadline:#4, output_commitment:#13); 5:CalibrationJobResolved(task_hash:#13, target_miner:#0, expected_gn:#12, issued_at:#4, resolved_at:#4, deadline:#4, pack_id:#4, output_commitment:#13); 6:GhostTaskAttestClaimAccepted(task_hash:#13, profile:#410, verdict:#203); 7:GhostPreliminaryVerdict(task_hash:#13, outcome:#417, finalizes_at:#4, evidence_ok:#8); 8:GhostAppealSubmitted(task_hash:#13, appellant:#0, evidence_hash:#13); 9:GhostAppealResolved(task_hash:#13, overturned:#8); 10:GhostVerdictFinalized(task_hash:#13, outcome:#417, slashed:#8))` | `[{"name":"T","type":null}]` |
| [RPC] | 417 | `pallet_synthetic_tasks::pallet::GhostTaskOutcome` | `enum(0:Completed(); 1:Expired(); 2:Incorrect())` | `[]` |
| [RPC] | 418 | `pallet_attest::pallet::Event` | `enum(0:ProfileUpserted(profile_id:#13, version:#4, min_threshold:#4); 1:ClaimAccepted(profile_id:#13, profile_version:#4, subject:#13, verdict:#203))` | `[{"name":"T","type":null}]` |
| [RPC] | 419 | `pallet_airdrop_vesting::pallet::Event` | `enum(0:AirdropGrantCreated(beneficiary:#0, tier:#226, amount:#6, cliff_blocks:#4); 1:AirdropClaimed(beneficiary:#0, claimed_amount:#6, total_unlocked:#6); 2:MinerPerformanceUpdated(miner:#0, testnet_score:#4, mainnet_score:#4, adjustment_factor:#4); 3:BatchGrantsCreated(count:#4, total_amount:#6))` | `[{"name":"T","type":null}]` |
| [RPC] | 420 | `pallet_block_rewards::pallet::Event` | `enum(0:RewardsDistributed(period_blocks:#4, total_reward:#6, miner_share:#6, validator_share:#6, agent_share:#6, staker_share:#6, miners_paid:#4); 1:MinerRewarded(miner:#0, amount:#6, gn_contribution:#12); 2:AgentPoolRewarded(pool:#0, amount:#6); 3:StakerPoolRewarded(pool:#0, amount:#6); 4:MinerRewardFailed(miner:#0, amount:#6, gn_contribution:#12, error:#26); 5:DistributionFailed(error:#26))` | `[{"name":"T","type":null}]` |
| [RPC] | 421 | `pallet_flop_subsidy::pallet::Event` | `enum(0:SubsidyPaid(block_number:#4, labs_amount:#6, foundation_amount:#6); 1:SubsidiesEnded(final_block:#4, total_labs:#6, total_foundation:#6))` | `[{"name":"T","type":null}]` |
| [RPC] | 422 | `pallet_session_keys::pallet::Event` | `enum(0:SessionCreated(owner:#0, delegate:#0, spending_cap:#6, per_tx_limit:#6, daily_cap:#6, expires_at:#4); 1:SessionRevoked(owner:#0, delegate:#0); 2:SessionCallExecuted(owner:#0, delegate:#0, spent:#6, epoch_spent:#6); 3:SessionExpired(owner:#0, delegate:#0); 4:DailyCapReset(owner:#0, delegate:#0); 5:CircuitBreakerTripped(delegate:#0, tx_count:#4, total_spend:#6, period_start:#4); 6:CircuitBreakerReset(delegate:#0); 7:SessionRotationLimited(owner:#0, count_in_window:#4))` | `[{"name":"T","type":null}]` |
| [RPC] | 423 | `pallet_agent_wallet::pallet::Event` | `enum(0:WalletCreated(owner:#0, agent:#0, per_tx_limit:#6, daily_cap:#6); 1:WalletFunded(agent:#0, amount:#6); 2:AgentTransfer(agent:#0, destination:#0, amount:#6); 3:OwnerWithdraw(owner:#0, agent:#0, amount:#6); 4:WalletDeactivated(owner:#0, agent:#0); 5:WalletReactivated(owner:#0, agent:#0); 6:EpochReset(agent:#0); 7:SponsoredPaymentSettled(payment_id:#13, settlement_hash:#13, resource:#13, payer:#0, payee:#0, facilitator:#0, amount:#6); 8:SponsoredPaymentRevoked(payer:#0, payment_id:#13); 9:SponsoredPaymentRecordPruned(payer:#0, payment_id:#13))` | `[{"name":"T","type":null}]` |
| [RPC] | 424 | `pallet_validators::pallet::Event` | `enum(0:ValidatorRegistered(validator:#0, self_stake:#6, epoch:#12); 1:ValidatorDeregistered(validator:#0); 2:MinimumStakeUpdated(epoch:#12, old_minimum:#6, new_minimum:#6); 3:ValidatorSlashed(validator:#0, reason:#235, amount:#6, ejected:#8); 4:ValidatorBlacklisted(validator:#0, reason:#235); 5:PerformanceUpdated(validator:#0, new_score:#4); 6:RotationExecuted(epoch:#12, ejected_count:#4, promoted_count:#4); 7:EmergencyOverride(old_minimum:#6, new_minimum:#6, reason:#14); 8:ValueCoupledFloorSet(old_floor:#6, new_floor:#6, effective_minimum:#6, reason:#14); 9:Delegated(delegator:#0, validator:#0, amount:#6); 10:Undelegating(delegator:#0, validator:#0, amount:#6, unlock_block:#4); 11:RewardsClaimed(delegator:#0, validator:#0, amount:#6); 12:Withdrawn(delegator:#0, amount:#6); 13:CommissionUpdated(validator:#0, new_commission:#208); 14:ValidatorJailed(validator:#0, slash:#6, until_block:#4); 15:ValidatorKicked(validator:#0, slash:#6); 16:ValidatorUnjailed(validator:#0); 17:ConsensusRewardDistributed(total:#6, recipients:#4); 18:SponsorPositionCreated(position_id:#12, sponsor:#0, validator:#0, amount:#6, reward_policy:#236); 19:SponsorUnbondingStarted(position_id:#12, sponsor:#0, validator:#0, amount:#6, unlock_block:#4, source_position_id:#12, source_remaining:#6); 20:SponsorRefunded(position_id:#12, sponsor:#0, validator:#0, amount:#6); 21:SponsorStakeSlashed(position_id:#12, sponsor:#0, validator:#0, amount:#6); 22:SlashingLossBuckets(validator:#0, reason:#235, operator_loss:#6, delegator_loss:#6, sponsor_loss:#6); 23:CandidatePromotionDeferred(validator:#0); 24:SponsorPositionToppedUp(position_id:#12, sponsor:#0, validator:#0, amount:#6, remaining_principal:#6))` | `[{"name":"T","type":null}]` |
| [RPC] | 425 | `pallet_miner_staking::pallet::Event` | `enum(0:MinerRegistered(miner:#0, self_stake:#6, commission_rate:#208); 1:MinerDeregistered(miner:#0); 2:DelegatorStaked(delegator:#0, miner:#0, amount:#6); 3:DelegatorUnstaked(delegator:#0, miner:#0, amount:#6, unlock_block:#4); 4:UnbondingCompleted(delegator:#0, amount:#6); 5:MinerRewarded(miner:#0, total_reward:#6, commission:#6, delegator_rewards:#6); 6:CommissionUpdated(miner:#0, old_rate:#208, new_rate:#208); 7:MinerStatusUpdated(miner:#0, is_active:#8); 8:SelfStakeToppedUp(miner:#0, new_self_stake:#6); 9:HardwareBlacklisted(miner:#0, hardware_id:#13); 10:SponsorPositionCreated(position_id:#12, sponsor:#0, miner:#0, amount:#6, reward_policy:#238); 11:SponsorUnbondingStarted(position_id:#12, sponsor:#0, miner:#0, amount:#6, unlock_block:#4, source_position_id:#12, source_remaining:#6); 12:SponsorRefunded(position_id:#12, sponsor:#0, miner:#0, amount:#6); 13:SponsorStakeSlashed(position_id:#12, sponsor:#0, miner:#0, amount:#6); 14:DelegatorStakeSlashed(delegator:#0, miner:#0, amount:#6); 15:MinerRetired(miner:#0); 16:SponsorPositionToppedUp(position_id:#12, sponsor:#0, miner:#0, amount:#6, remaining_principal:#6))` | `[{"name":"T","type":null}]` |
| [RPC] | 426 | `pallet_miner_slashing::pallet::Event` | `enum(0:MinerSlashed(miner:#0, reason:#240, amount:#6, blacklisted:#8); 1:MinerBlacklisted(miner:#0, reason:#240); 2:InvalidProofWarning(miner:#0, strike_count:#4, task_hash:#13); 3:DelegatorsSlashed(miner:#0, total_delegator_slash:#6, delegators_count:#4); 4:SlashBurned(miner:#0, amount:#6); 5:SlashLossBuckets(miner:#0, reason:#240, operator_loss:#6, delegator_loss:#6, sponsor_loss:#6))` | `[{"name":"T","type":null}]` |
| [RPC] | 427 | `pallet_delegation_cap::pallet::Event` | `enum(0:NominationRejected(validator:#0, requested:#6, cap:#6, current_delegated:#6); 1:CapUpdated(validator:#0, self_stake:#6, new_cap:#6); 2:ValidatorRegistered(validator:#0, self_stake:#6, cap:#6); 3:ValidatorRemoved(validator:#0))` | `[{"name":"T","type":null}]` |
| [RPC] | 428 | `pallet_emergency_override::pallet::Event` | `enum(0:OverrideQueued(call_hash:#13, reason:#14, effective_at:#4, queued_by:#0); 1:OverrideExecuted(call_hash:#13, executed_at:#4); 2:OverrideCancelled(call_hash:#13, cancelled_at:#4))` | `[{"name":"T","type":null}]` |
| [RPC] | 429 | `pallet_model_registry::pallet::Event` | `enum(0:ModelRegistered(model_hash:#13, publisher:#0, model_name:#178); 1:ModelVerified(model_hash:#13, approved_by:#0); 2:ModelDeprecated(model_hash:#13, reason:#14); 3:ModelRevoked(model_hash:#13, reason:#14); 4:BenchmarkVerified(model_hash:#13, benchmark_name:#178, score:#4); 5:BenchmarkExpired(model_hash:#13, benchmark_name:#178); 6:MinerRegistered(model_hash:#13, miner:#0); 7:MinerAvailabilityUpdated(model_hash:#13, miner:#0, status:#259); 8:MinerUnregistered(model_hash:#13, miner:#0); 9:MarketStateUpdated(model_hash:#13, epoch:#12, price_per_gflop:#6, market_factor:#430); 10:PricingUpdated(model_hash:#13, avg_price_per_gflop:#6, avg_latency_ms:#12); 11:StatisticsUpdated(model_hash:#13, total_inferences:#12, success_rate:#430); 12:VersionRegistered(model_hash:#13, version:#183, parent_hash:#102); 13:VersionDeprecated(model_hash:#13, version:#183, migration_target:#102); 14:MeasuredRootSet(model_hash:#13, precision:#246, root:#13); 15:MeasuredRootRemoved(model_hash:#13, precision:#246); 16:MeasuredRootEnforcementSet(enabled:#8); 17:WeightMleCommitmentSet(model_hash:#13, precision:#246, root:#13); 18:ModelWeightsRefSet(model_hash:#13, commitment:#13); 19:AllowedDecodePoliciesSet(model_hash:#13, count:#4); 20:AllowedDecodePoliciesCleared(model_hash:#13); 21:ModelWorkloadClassSet(model_hash:#13, workload_class:#254); 22:MeteringBandSet(model_hash:#13, tokens_per_byte_band_ppm:#4); 23:ModelArchHashSet(model_hash:#13, arch_hash:#13); 24:ModelMirrorsSet(model_hash:#13, count:#4); 25:RegistrarAction(model_hash:#13, registrar:#0, action:#431); 26:ModelAdmissionRequirementsSet(model_hash:#13, weights_size_bytes:#12, requires_hybrid_profile:#8); 27:QualificationRequested(model_hash:#13, request_id:#13); 28:QualificationAdvanced(model_hash:#13, request_id:#13, state:#432); 29:QualificationSettled(model_hash:#13, request_id:#13, state:#432, execution:#6, checking:#6, storage:#6, refund:#6); 30:QualificationPinsReleased(model_hash:#13, request_id:#13); 31:QualificationProfileSet(profile_id:#13, active:#8); 32:QualificationCustodySet(account:#0, domain:#102); 33:QualificationCheckerSet(profile_id:#13, checker:#0, qualified:#8); 34:QualificationOptIn(profile_id:#13, miner:#0, enabled:#8))` | `[{"name":"T","type":null}]` |
| [RPC] | 430 | `sp_arithmetic::per_things::Permill` | `struct(None:#4)` | `[]` |
| [RPC] | 431 | `pallet_model_registry::types::RegistrarAction` | `enum(0:ApproveModel(); 1:SetMeasuredRoot(); 2:SetAllowedDecodePolicies(); 3:SetModelArchHash(); 4:SetModelWorkloadClass(); 5:SetModelAdmissionRequirements())` | `[]` |
| [RPC] | 432 | `pallet_model_registry::qualification::QualificationState` | `enum(0:Waiting(); 1:Loading(); 2:Ready(); 3:Checking(); 4:Passed(); 5:Failed(); 6:Unavailable(); 7:Cancelled(); 8:Expired())` | `[]` |
| [RPC] | 433 | `pallet_membership::pallet::Event` | `enum(0:MemberAdded(); 1:MemberRemoved(); 2:MembersSwapped(); 3:MembersReset(); 4:KeyChanged(); 5:Dummy())` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 434 | `pallet_da_registry::pallet::Event` | `enum(0:BlobRegistered(commitment:#13, publisher:#0, retention:#261, size_bytes:#12, deposit:#6, providers:#4, expires_at:#93); 1:AuditIssued(audit_id:#13, commitment:#13, provider:#0, deadline:#4); 2:AuditPassed(audit_id:#13, commitment:#13, provider:#0); 3:AuditAttestClaimAccepted(audit_id:#13, profile:#410, verdict:#203); 4:AuditMissed(audit_id:#13, commitment:#13, provider:#0, deadline:#4); 5:AuditSlashEnacted(audit_id:#13, commitment:#13, provider:#0, slashed:#6); 6:BlobPruned(commitment:#13); 7:BlobReassigned(commitment:#13, providers:#4); 8:RepairAssigned(commitment:#13, failed_shards:#4, deadline:#4); 9:BlobUnrecoverable(commitment:#13, failed_shards:#4, confirmations:#4); 10:LeaseExtended(commitment:#13, who:#0, new_lease_end:#4); 11:LeaseWithdrawn(commitment:#13, who:#0); 12:LeaseDepositRefunded(commitment:#13, who:#0, amount:#6); 13:LeaseExpiryWarning(commitment:#13, lease_end:#4); 14:LeasePruned(commitment:#13); 15:LeaseExpiredButPinned(commitment:#13, pin_count:#4); 16:BlobReactivated(commitment:#13, publisher:#0, lease_end:#4); 17:DepositPerByteSet(previous:#6, new:#6); 18:ReplicationFactorSet(previous:#4, new:#4); 19:EndpointAnnounced(provider:#0); 20:EndpointCleared(provider:#0))` | `[{"name":"T","type":null}]` |
| [RPC] | 435 | `pallet_paid_storage::pallet::Event` | `enum(0:ProfileSet(); 1:ProfileCleared(); 2:CapacityDeclared(epoch:#12, provider:#0, encoded_bytes:#12, collateral:#6); 3:TariffVoteRecorded(epoch:#12, provider:#0, vote:#276); 4:EpochTariffSet(epoch:#12, tariff:#436); 5:NoEpochTariff(epoch:#12, reason:#439); 6:EpochBoundarySkipped(epoch:#12); 7:ReservationPending(reservation:#12, payer:#0, escrow:#6); 8:ReservationActivated(reservation:#12, activation:#12, end:#12); 9:ReservationAborted(reservation:#12, payer:#0, refunded:#6); 10:ServiceLaneFunded(lane:#1, payer:#0, provider:#0, funded:#6); 11:ServicePaid(lane:#1, provider:#0, delta:#6, paid:#6, remaining:#6); 12:ServiceLaneClosing(lane:#1, boundary:#12, deadline:#12, remaining:#6); 13:ServiceLaneClosed(lane:#1, payer:#0, refunded:#6, paid:#6); 14:PolicyAdvanced(reservation:#12, scope:#290, epoch:#12); 15:PolicyRevoked(reservation:#12, scope:#290, epoch:#12); 16:RentProfileSet(); 17:CheckpointPosted(provider:#0, epoch:#12, root:#1, counters_commitment:#1); 18:RentReleased(reservation:#12, provider:#0, epoch:#12, delta:#6, audited:#8); 19:ReservationClosed(reservation:#12, payer:#0, paid:#6, refunded:#6); 20:MemoryProfileSet())` | `[{"name":"T","type":null}]` |
| [RPC] | 436 | `pallet_paid_storage::pallet::EpochTariff` | `struct(epoch:#12, rates:#276, rent_den:#12, retrieval_den:#12, previous_epoch:#213, step_bound:#437, profile_revision:#4, declarer_count:#4, declared_bytes:#12, free_bytes:#12, tripwire_counter:#4, source:#438)` | `[]` |
| [RPC] | 437 | `Option` | `enum(0:None(); 1:Some(None:#208))` | `[{"name":"T","type":208}]` |
| [RPC] | 438 | `pallet_paid_storage::pallet::TariffSource` | `enum(0:Median(); 1:Tripwire(); 2:CarriedForward())` | `[]` |
| [RPC] | 439 | `pallet_paid_storage::pallet::NoTariffReason` | `enum(0:NoDeclarers(); 1:NoVotes(); 2:Overflow(); 3:InconsistentPrevious())` | `[]` |
| [RPC] | 440 | `pallet_compute_channel::pallet::Event` | `enum(0:ChannelOpened(channel_id:#13, agent:#0, miner:#0, escrow:#6, measured_root:#13); 1:OfferAccepted(channel_id:#13, miner:#0, offer_nonce:#12, expiry:#4); 2:OfferOpenFailed(channel_id:#13, miner:#0, failed_offer_opens:#4); 3:ForwardOfferFunded(miner:#0, offer_nonce:#12, bond:#6, start_block:#4, end_block:#4); 4:ForwardOfferCancelled(miner:#0, offer_nonce:#12, bond_released:#6); 5:ForwardChannelOpened(channel_id:#13, agent:#0, miner:#0, start_block:#4, end_block:#4, duration_seconds:#12, quota_total:#6, price_per_gn:#6, payment:#6, bond:#6); 6:ForwardAvailabilityClaimed(channel_id:#13, amount:#6, cumulative:#6); 7:ForwardBondReleased(channel_id:#13, delivered_gn:#6, amount:#6, cumulative:#6); 8:ForwardAssigned(channel_id:#13, previous_agent:#0, new_agent:#0); 9:ForwardUnitsTransferred(channel_id:#13, from:#0, to:#0, units:#6, from_remaining:#6, to_total:#6); 10:ForwardDistributionClaimed(channel_id:#13, holder:#0, units:#6, amount:#6); 11:ForwardDrawOpened(channel_id:#13, draw_id:#13, holder:#0, units:#6, aggregate_units:#6); 12:ForwardDrawClosed(channel_id:#13, draw_id:#13, units:#6, aggregate_units:#6); 13:ForwardBidPosted(bid_id:#13, buyer:#0, payment:#6, commit_deadline:#4); 14:ForwardBidClaimCommitted(bid_id:#13, miner:#0, bond:#6); 15:ForwardBidClaimsSealed(bid_id:#13, claimant_count:#4, reveal_deadline:#4); 16:ForwardBidClaimRevealed(bid_id:#13, miner:#0); 17:ForwardBidCleared(bid_id:#13, channel_id:#13, winner:#0); 18:ForwardBidCancelled(bid_id:#13, buyer:#0, payment_released:#6); 19:ForwardSettled(channel_id:#13, outcome:#441, delivered_gn:#6, miner_paid:#6, buyer_refunded:#6, buyer_damages:#6, backup_bounty:#6, bond_released:#6, bond_slashed:#6); 20:ForceOpenRequested(channel_id:#13, agent:#0, miner:#0, escrow:#6, ack_deadline:#4); 21:ForceOpenExpired(channel_id:#13, miner:#0, refunded:#6, failed_acks:#4); 22:EscrowToppedUp(channel_id:#13, added:#6, total:#6); 23:Settled(channel_id:#13, miner_paid:#6, burned:#6, aggregate_gn:#6, cooperative:#8); 24:SettlementPosted(channel_id:#13, final_root:#13, aggregate_gn:#6, challenge_end:#4); 25:TimedOutRefunded(channel_id:#13, refunded:#6); 26:DisputeOpened(channel_id:#13, challenger:#0, contested_turn:#4); 27:BisectionOpened(channel_id:#13, challenger:#0, lo:#4, hi:#4); 28:BisectionResponded(channel_id:#13, lo:#4, hi:#4, left_root:#13, right_root:#13); 29:BisectionChallenged(channel_id:#13, lo:#4, hi:#4, rounds:#4); 30:DisputeDismissed(channel_id:#13); 31:FraudUpheld(channel_id:#13, miner:#0, slashed:#6); 32:ToplocModelToleranceSet(model_hash:#13, tolerance:#315); 33:ToplocModelBandConstantsSet(model_hash:#13, precision:#246, constants:#316); 34:ToplocFraudUpheld(channel_id:#13, turn_index:#4, miner:#0, slashed:#6, validators:#4); 35:ToplocEscalationRequested(channel_id:#13, turn_index:#4, miner:#0, milli_exponent_error:#12, validators:#4); 36:ToplocEscalationOpened(channel_id:#13, turn_index:#4, deadline:#4); 37:ToplocEscalationCleared(channel_id:#13, turn_index:#4, validators:#4); 38:ToplocEscalationTimedOut(channel_id:#13, turn_index:#4, refunded:#6); 39:CertificateSettled(channel_id:#13, aggregate_gn:#6, cert_commitment:#13); 40:CalibrationSnapshotted(channel_id:#13, miner:#0, cap_gflops_per_sec:#12, assurance_tier:#442, calibration_version:#4, soft_tier_spot_check_rate_ppm:#4); 41:ToplocAttestClaimAccepted(channel_id:#13, profile:#410, verdict:#203); 42:ChallengeWindowExtended(channel_id:#13, reason:#443, new_deadline:#4, extensions:#2); 43:DegradedRefunded(channel_id:#13, reason:#443, refunded:#6); 44:UnrecoverableTranscriptVoided(channel_id:#13, miner_paid:#6, agent_refunded:#6, aggregate_gn:#6); 45:AssuranceClassPinned(channel_id:#13, class:#444); 46:ToplocEvidenceSubmitted(channel_id:#13, miner:#0, commitment_ref:#13, turns_committed:#4); 47:AuditDataForfeited(channel_id:#13, miner:#0, agent_refunded:#6, slashed:#6, window_value:#6); 48:AuditFeeEarmarked(channel_id:#13, amount:#6); 49:AuditFeeClaimed(channel_id:#13, validator:#0, amount:#6, evidence:#13); 50:SessionEvidenceRegistered(channel_id:#13, slot:#314, commitment:#13, size_bytes:#4); 51:FcuEmpiricalParamsSet(params:#305); 52:FcuMassSlashPauseSet(paused:#8); 53:ForwardBidRegistrationSealed(bid_id:#13, authored_block:#4); 54:ForwardUnitsListed(channel_id:#13, seller:#0, listing_id:#13, units:#6, total_price:#6, expires_at:#4, delivered_gn:#6); 55:ForwardUnitsSold(channel_id:#13, seller:#0, buyer:#0, listing_id:#13, units:#6, total_price:#6); 56:ForwardListingCancelled(channel_id:#13, seller:#0, listing_id:#13); 57:FcuPrimaryAdmissionsPauseSet(paused:#8); 58:FcuServiceProfileRegistered(profile_hash:#13, qualification_hash:#13); 59:FcuServiceProfileStatusSet(profile_hash:#13, status:#310))` | `[{"name":"T","type":null}]` |
| [RPC] | 441 | `pallet_compute_channel::pallet::ForwardOutcome` | `enum(0:Delivered(); 1:TakeOrPay(); 2:Defaulted(); 3:Voided())` | `[]` |
| [RPC] | 442 | `pallet_compute_channel::AssuranceTier` | `enum(0:Soft(); 1:Hard())` | `[]` |
| [RPC] | 443 | `pallet_compute_channel::pallet::SettlementDegradeReason` | `enum(0:DaUnavailable(); 1:DaUnrecoverable())` | `[]` |
| [RPC] | 444 | `pallet_compute_channel::AssuranceClass` | `enum(0:TeeToploc(); 1:TeeToplocReexec())` | `[]` |
| [RPC] | 445 | `pallet_metering_verifier::pallet::Event` | `enum(0:GuestImageIdSet(image_id:#13); 1:GuestImageIdCleared(); 2:MeteringCertVerified(commitment:#13, channel_id:#13, aggregate_gn:#6); 3:StaleCertPruned(commitment:#13); 4:HybridProfileSet(arch_hash:#13, image_id:#102, epoch:#12); 5:HybridCertVerified(commitment:#13, channel_id:#13))` | `[{"name":"T","type":null}]` |
| [RPC] | 446 | `pallet_aleph::pallet::Event` | `enum(0:CommitteeRotated(size:#4, at:#4); 1:FinalizedReported(number:#4))` | `[{"name":"T","type":null}]` |
| [RPC] | 447 | `pallet_emergency_pause::pallet::Event` | `enum(0:PalletPaused(pallet:#14, expires_at:#4); 1:PalletResumed(pallet:#14); 2:PauseExpired(pallet:#14); 3:GlobalPauseActivated(expires_at:#4); 4:GlobalPauseDeactivated(); 5:GlobalPauseExpired())` | `[{"name":"T","type":null}]` |
| [RPC] | 448 | `pallet_agent_identity::pallet::Event` | `enum(0:AgentRegistered(agent_id:#13, owner:#0, name:#183, did:#180, agent_type:#328); 1:AgentUpdated(agent_id:#13, updated_by:#0); 2:AgentStatusChanged(agent_id:#13, old_status:#449, new_status:#449); 3:AgentVerified(agent_id:#13, verified_by:#0); 4:AgentRevoked(agent_id:#13, reason:#14); 5:StakeDeposited(agent_id:#13, amount:#6, new_total:#6); 6:StakeWithdrawn(agent_id:#13, amount:#6, new_total:#6); 7:ReputationEvent(agent_id:#13, event_type:#336, score_change:#450, new_score:#56); 8:TeeVerified(agent_id:#13, verification_type:#337, result:#338); 9:LicenseSet(agent_id:#13, license_type:#339); 10:CapabilityUpdated(agent_id:#13, capability:#330, score:#2); 11:TaskCompleted(agent_id:#13, success:#8, flop_volume:#6))` | `[{"name":"T","type":null}]` |
| [RPC] | 449 | `pallet_agent_identity::types::AgentStatus` | `enum(0:Active(); 1:Paused(); 2:Deprecated(); 3:Revoked(); 4:Pending())` | `[]` |
| [RPC] | 450 | `` | `primitive:"i16"` | `[]` |
| [RPC] | 451 | `pallet_verifiers::pallet::Event` | `enum(0:VkRegistered(hash:#13); 1:VkUnregistered(hash:#13); 2:ProofVerified(statement:#13))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 452 | `pallet_verifiers::pallet::Event` | `enum(0:VkRegistered(hash:#13); 1:VkUnregistered(hash:#13); 2:ProofVerified(statement:#13))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 453 | `pallet_verifiers::pallet::Event` | `enum(0:VkRegistered(hash:#13); 1:VkUnregistered(hash:#13); 2:ProofVerified(statement:#13))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 454 | `pallet_verifiers::pallet::Event` | `enum(0:VkRegistered(hash:#13); 1:VkUnregistered(hash:#13); 2:ProofVerified(statement:#13))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 455 | `pallet_verifiers::pallet::Event` | `enum(0:VkRegistered(hash:#13); 1:VkUnregistered(hash:#13); 2:ProofVerified(statement:#13))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 456 | `pallet_verifiers::pallet::Event` | `enum(0:VkRegistered(hash:#13); 1:VkUnregistered(hash:#13); 2:ProofVerified(statement:#13))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 457 | `pallet_verifiers::pallet::Event` | `enum(0:VkRegistered(hash:#13); 1:VkUnregistered(hash:#13); 2:ProofVerified(statement:#13))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 458 | `pallet_verifiers::pallet::Event` | `enum(0:VkRegistered(hash:#13); 1:VkUnregistered(hash:#13); 2:ProofVerified(statement:#13))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 459 | `pallet_verifiers::pallet::Event` | `enum(0:VkRegistered(hash:#13); 1:VkUnregistered(hash:#13); 2:ProofVerified(statement:#13))` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 460 | `frame_system::Phase` | `enum(0:ApplyExtrinsic(None:#4); 1:Finalization(); 2:Initialization())` | `[]` |
| [RPC] | 461 | `` | `sequence:33` | `[]` |
| [RPC] | 462 | `frame_system::LastRuntimeUpgradeInfo` | `struct(spec_version:#81, spec_name:#463)` | `[]` |
| [RPC] | 463 | `Cow` | `struct(None:#464)` | `[{"name":"T","type":464}]` |
| [RPC] | 464 | `` | `primitive:"str"` | `[]` |
| [RPC] | 465 | `frame_system::CodeUpgradeAuthorization` | `struct(code_hash:#13, check_version:#8)` | `[{"name":"T","type":null}]` |
| [RPC] | 466 | `frame_system::limits::BlockWeights` | `struct(base_block:#10, max_block:#10, per_class:#467)` | `[]` |
| [RPC] | 467 | `frame_support::dispatch::PerDispatchClass` | `struct(normal:#468, operational:#468, mandatory:#468)` | `[{"name":"T","type":468}]` |
| [RPC] | 468 | `frame_system::limits::WeightsPerClass` | `struct(base_extrinsic:#10, max_extrinsic:#469, max_total:#469, reserved:#469)` | `[]` |
| [RPC] | 469 | `Option` | `enum(0:None(); 1:Some(None:#10))` | `[{"name":"T","type":10}]` |
| [RPC] | 470 | `frame_system::limits::BlockLength` | `struct(max:#471, max_header_size:#93)` | `[]` |
| [RPC] | 471 | `frame_support::dispatch::PerDispatchClass` | `struct(normal:#4, operational:#4, mandatory:#4)` | `[{"name":"T","type":4}]` |
| [RPC] | 472 | `sp_weights::RuntimeDbWeight` | `struct(read:#12, write:#12)` | `[]` |
| [RPC] | 473 | `sp_version::RuntimeVersion` | `struct(spec_name:#463, impl_name:#463, authoring_version:#4, spec_version:#4, impl_version:#4, apis:#474, transaction_version:#4, system_version:#2)` | `[]` |
| [RPC] | 474 | `Cow` | `struct(None:#475)` | `[{"name":"T","type":475}]` |
| [RPC] | 475 | `` | `sequence:476` | `[]` |
| [RPC] | 476 | `` | `tuple:[125,4]` | `[]` |
| [RPC] | 477 | `frame_system::pallet::Error` | `enum(0:InvalidSpecName(); 1:SpecVersionNeedsToIncrease(); 2:FailedToExtractRuntimeVersion(); 3:NonDefaultComposite(); 4:NonZeroRefCount(); 5:CallFiltered(); 6:MultiBlockMigrationsOngoing(); 7:NothingAuthorized(); 8:Unauthorized())` | `[{"name":"T","type":null}]` |
| [RPC] | 478 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#481)` | `[{"name":"T","type":479},{"name":"S","type":null}]` |
| [RPC] | 479 | `Option` | `enum(0:None(); 1:Some(None:#480))` | `[{"name":"T","type":480}]` |
| [RPC] | 480 | `pallet_scheduler::Scheduled` | `struct(maybe_id:#34, priority:#2, call:#60, maybe_periodic:#67, origin:#98)` | `[{"name":"Name","type":1},{"name":"Call","type":60},{"name":"BlockNumber","type":4},{"name":"PalletsOrigin","type":98},{"name":"AccountId","type":0}]` |
| [RPC] | 481 | `` | `sequence:479` | `[]` |
| [RPC] | 482 | `pallet_scheduler::RetryConfig` | `struct(total_retries:#2, remaining:#2, period:#4)` | `[{"name":"Period","type":4}]` |
| [RPC] | 483 | `pallet_scheduler::pallet::Error` | `enum(0:FailedToSchedule(); 1:NotFound(); 2:TargetBlockNumberInPast(); 3:RescheduleNoChange(); 4:Named())` | `[{"name":"T","type":null}]` |
| [RPC] | 484 | `pallet_preimage::OldRequestStatus` | `enum(0:Unrequested(deposit:#485, len:#4); 1:Requested(deposit:#486, count:#4, len:#93))` | `[{"name":"AccountId","type":0},{"name":"Balance","type":6}]` |
| [RPC] | 485 | `` | `tuple:[0,6]` | `[]` |
| [RPC] | 486 | `Option` | `enum(0:None(); 1:Some(None:#485))` | `[{"name":"T","type":485}]` |
| [RPC] | 487 | `pallet_preimage::RequestStatus` | `enum(0:Unrequested(ticket:#489, len:#4); 1:Requested(maybe_ticket:#490, count:#4, maybe_len:#93))` | `[{"name":"AccountId","type":0},{"name":"Ticket","type":488}]` |
| [RPC] | 488 | `frame_support::traits::tokens::fungible::HoldConsideration` | `struct(None:#6)` | `[{"name":"A","type":null},{"name":"F","type":null},{"name":"R","type":null},{"name":"D","type":null},{"name":"Fp","type":null}]` |
| [RPC] | 489 | `` | `tuple:[0,488]` | `[]` |
| [RPC] | 490 | `Option` | `enum(0:None(); 1:Some(None:#489))` | `[{"name":"T","type":489}]` |
| [RPC] | 491 | `` | `tuple:[13,4]` | `[]` |
| [RPC] | 492 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#14)` | `[{"name":"T","type":2},{"name":"S","type":null}]` |
| [RPC] | 493 | `pallet_preimage::pallet::Error` | `enum(0:TooBig(); 1:AlreadyNoted(); 2:NotAuthorized(); 3:NotNoted(); 4:Requested(); 5:NotRequested(); 6:TooMany(); 7:TooFew())` | `[{"name":"T","type":null}]` |
| [RPC] | 494 | `bounded_collections::weak_bounded_vec::WeakBoundedVec` | `struct(None:#497)` | `[{"name":"T","type":495},{"name":"S","type":null}]` |
| [RPC] | 495 | `pallet_balances::types::BalanceLock` | `struct(id:#125, amount:#6, reasons:#496)` | `[{"name":"Balance","type":6}]` |
| [RPC] | 496 | `pallet_balances::types::Reasons` | `enum(0:Fee(); 1:Misc(); 2:All())` | `[]` |
| [RPC] | 497 | `` | `sequence:495` | `[]` |
| [RPC] | 498 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#500)` | `[{"name":"T","type":499},{"name":"S","type":null}]` |
| [RPC] | 499 | `pallet_balances::types::ReserveData` | `struct(id:#125, amount:#6)` | `[{"name":"ReserveIdentifier","type":125},{"name":"Balance","type":6}]` |
| [RPC] | 500 | `` | `sequence:499` | `[]` |
| [RPC] | 501 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#503)` | `[{"name":"T","type":502},{"name":"S","type":null}]` |
| [RPC] | 502 | `frame_support::traits::tokens::misc::IdAmount` | `struct(id:#40, amount:#6)` | `[{"name":"Id","type":40},{"name":"Balance","type":6}]` |
| [RPC] | 503 | `` | `sequence:502` | `[]` |
| [RPC] | 504 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#512)` | `[{"name":"T","type":505},{"name":"S","type":null}]` |
| [RPC] | 505 | `frame_support::traits::tokens::misc::IdAmount` | `struct(id:#506, amount:#6)` | `[{"name":"Id","type":506},{"name":"Balance","type":6}]` |
| [RPC] | 506 | `zkv_runtime::RuntimeFreezeReason` | `enum(88:WorkVesting(None:#507); 91:AirdropVesting(None:#508); 96:Validators(None:#509); 97:MinerStaking(None:#510); 100:MinerSlashing(None:#511))` | `[]` |
| [RPC] | 507 | `pallet_work_vesting::pallet::FreezeReason` | `enum(0:WorkVestingEscrow())` | `[]` |
| [RPC] | 508 | `pallet_airdrop_vesting::pallet::FreezeReason` | `enum(0:AirdropVesting())` | `[]` |
| [RPC] | 509 | `pallet_validators::pallet::FreezeReason` | `enum(0:ValidatorStake(); 1:DelegatorStake(); 2:SponsorStake())` | `[]` |
| [RPC] | 510 | `pallet_miner_staking::pallet::FreezeReason` | `enum(0:MinerSelfStake(); 1:DelegatorStake(); 2:Unbonding(); 3:SponsorStake(); 4:StakeLedger())` | `[]` |
| [RPC] | 511 | `pallet_miner_slashing::pallet::FreezeReason` | `enum(0:SlashedStake())` | `[]` |
| [RPC] | 512 | `` | `sequence:505` | `[]` |
| [RPC] | 513 | `pallet_balances::pallet::Error` | `enum(0:VestingBalance(); 1:LiquidityRestrictions(); 2:InsufficientBalance(); 3:ExistentialDeposit(); 4:Expendability(); 5:ExistingVestingSchedule(); 6:DeadAccount(); 7:TooManyReserves(); 8:TooManyHolds(); 9:TooManyFreezes(); 10:IssuanceDeactivated(); 11:DeltaZero())` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 514 | `sp_arithmetic::fixed_point::FixedU128` | `struct(None:#6)` | `[]` |
| [RPC] | 515 | `pallet_transaction_payment::Releases` | `enum(0:V1Ancient(); 1:V2())` | `[]` |
| [RPC] | 516 | `frame_support::traits::storage::NoDrop` | `struct(None:#517)` | `[{"name":"T","type":517}]` |
| [RPC] | 517 | `frame_support::traits::tokens::fungible::imbalance::Imbalance` | `struct(amount:#6)` | `[{"name":"B","type":6},{"name":"OnDrop","type":null},{"name":"OppositeOnDrop","type":null}]` |
| [RPC] | 518 | `sp_staking::offence::OffenceDetails` | `struct(offender:#519, reporters:#76)` | `[{"name":"Reporter","type":0},{"name":"Offender","type":519}]` |
| [RPC] | 519 | `` | `tuple:[0,36]` | `[]` |
| [RPC] | 520 | `` | `tuple:[51,14]` | `[]` |
| [RPC] | 521 | `bounded_collections::weak_bounded_vec::WeakBoundedVec` | `struct(None:#523)` | `[{"name":"T","type":522},{"name":"S","type":null}]` |
| [RPC] | 522 | `` | `tuple:[82,12]` | `[]` |
| [RPC] | 523 | `` | `sequence:522` | `[]` |
| [RPC] | 524 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#223)` | `[{"name":"T","type":1},{"name":"S","type":null}]` |
| [RPC] | 525 | `Option` | `enum(0:None(); 1:Some(None:#526))` | `[{"name":"T","type":526}]` |
| [RPC] | 526 | `sp_consensus_babe::digests::PreDigest` | `enum(1:Primary(None:#527); 2:SecondaryPlain(None:#529); 3:SecondaryVRF(None:#530))` | `[]` |
| [RPC] | 527 | `sp_consensus_babe::digests::PrimaryPreDigest` | `struct(authority_index:#4, slot:#83, vrf_signature:#528)` | `[]` |
| [RPC] | 528 | `sp_core::sr25519::vrf::VrfSignature` | `struct(pre_output:#1, proof:#154)` | `[]` |
| [RPC] | 529 | `sp_consensus_babe::digests::SecondaryPlainPreDigest` | `struct(authority_index:#4, slot:#83)` | `[]` |
| [RPC] | 530 | `sp_consensus_babe::digests::SecondaryVRFPreDigest` | `struct(authority_index:#4, slot:#83, vrf_signature:#528)` | `[]` |
| [RPC] | 531 | `sp_consensus_babe::BabeEpochConfiguration` | `struct(c:#86, allowed_slots:#87)` | `[]` |
| [RPC] | 532 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#534)` | `[{"name":"T","type":533},{"name":"S","type":null}]` |
| [RPC] | 533 | `` | `tuple:[12,4]` | `[]` |
| [RPC] | 534 | `` | `sequence:533` | `[]` |
| [RPC] | 535 | `pallet_babe::pallet::Error` | `enum(0:InvalidEquivocationProof(); 1:InvalidKeyOwnershipProof(); 2:DuplicateOffenceReport(); 3:InvalidConfiguration())` | `[{"name":"T","type":null}]` |
| [RPC] | 536 | `` | `sequence:537` | `[]` |
| [RPC] | 537 | `` | `tuple:[0,89]` | `[]` |
| [RPC] | 538 | `` | `sequence:539` | `[]` |
| [RPC] | 539 | `` | `tuple:[4,540]` | `[]` |
| [RPC] | 540 | `sp_staking::offence::OffenceSeverity` | `struct(None:#208)` | `[]` |
| [RPC] | 541 | `` | `tuple:[542,14]` | `[]` |
| [RPC] | 542 | `sp_core::crypto::KeyTypeId` | `struct(None:#18)` | `[]` |
| [RPC] | 543 | `pallet_session::pallet::Error` | `enum(0:InvalidProof(); 1:NoAssociatedValidatorId(); 2:DuplicatedKey(); 3:NoKeys(); 4:NoAccount())` | `[{"name":"T","type":null}]` |
| [RPC] | 544 | `bounded_collections::weak_bounded_vec::WeakBoundedVec` | `struct(None:#545)` | `[{"name":"T","type":90},{"name":"S","type":null}]` |
| [RPC] | 545 | `` | `sequence:90` | `[]` |
| [RPC] | 546 | `pallet_treasury::Proposal` | `struct(proposer:#0, value:#6, beneficiary:#0, bond:#6)` | `[{"name":"AccountId","type":0},{"name":"Balance","type":6}]` |
| [RPC] | 547 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#304)` | `[{"name":"T","type":4},{"name":"S","type":null}]` |
| [RPC] | 548 | `pallet_treasury::SpendStatus` | `struct(asset_kind:#36, amount:#6, beneficiary:#0, valid_from:#4, expire_at:#4, status:#549)` | `[{"name":"AssetKind","type":36},{"name":"AssetBalance","type":6},{"name":"Beneficiary","type":0},{"name":"BlockNumber","type":4},{"name":"PaymentId","type":36}]` |
| [RPC] | 549 | `pallet_treasury::PaymentState` | `enum(0:Pending(); 1:Attempted(id:#36); 2:Failed())` | `[{"name":"Id","type":36}]` |
| [RPC] | 550 | `frame_support::PalletId` | `struct(None:#125)` | `[]` |
| [RPC] | 551 | `pallet_treasury::pallet::Error` | `enum(0:InvalidIndex(); 1:TooManyApprovals(); 2:InsufficientPermission(); 3:ProposalNotApproved(); 4:FailedToConvertBalance(); 5:SpendExpired(); 6:EarlyPayout(); 7:AlreadyAttempted(); 8:PayoutError(); 9:NotAttempted(); 10:Inconclusive())` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 552 | `` | `tuple:[0,56]` | `[]` |
| [RPC] | 553 | `pallet_conviction_voting::vote::Voting` | `enum(0:Casting(None:#554); 1:Delegating(None:#560))` | `[{"name":"Balance","type":6},{"name":"AccountId","type":0},{"name":"BlockNumber","type":4},{"name":"PollIndex","type":4},{"name":"MaxVotes","type":null}]` |
| [RPC] | 554 | `pallet_conviction_voting::vote::Casting` | `struct(votes:#555, delegations:#558, prior:#559)` | `[{"name":"Balance","type":6},{"name":"BlockNumber","type":4},{"name":"PollIndex","type":4},{"name":"MaxVotes","type":null}]` |
| [RPC] | 555 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#557)` | `[{"name":"T","type":556},{"name":"S","type":null}]` |
| [RPC] | 556 | `` | `tuple:[4,57]` | `[]` |
| [RPC] | 557 | `` | `sequence:556` | `[]` |
| [RPC] | 558 | `pallet_conviction_voting::types::Delegations` | `struct(votes:#6, capital:#6)` | `[{"name":"Balance","type":6}]` |
| [RPC] | 559 | `pallet_conviction_voting::vote::PriorLock` | `struct(None:#4, None:#6)` | `[{"name":"BlockNumber","type":4},{"name":"Balance","type":6}]` |
| [RPC] | 560 | `pallet_conviction_voting::vote::Delegating` | `struct(balance:#6, target:#0, conviction:#95, delegations:#558, prior:#559)` | `[{"name":"Balance","type":6},{"name":"AccountId","type":0},{"name":"BlockNumber","type":4}]` |
| [RPC] | 561 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#563)` | `[{"name":"T","type":562},{"name":"S","type":null}]` |
| [RPC] | 562 | `` | `tuple:[56,6]` | `[]` |
| [RPC] | 563 | `` | `sequence:562` | `[]` |
| [RPC] | 564 | `pallet_conviction_voting::pallet::Error` | `enum(0:NotOngoing(); 1:NotVoter(); 2:NoPermission(); 3:NoPermissionYet(); 4:AlreadyDelegating(); 5:AlreadyVoting(); 6:InsufficientFunds(); 7:NotDelegating(); 8:Nonsense(); 9:MaxVotesReached(); 10:ClassNeeded(); 11:BadClass())` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 565 | `pallet_referenda::types::ReferendumInfo` | `enum(0:Ongoing(None:#566); 1:Approved(None:#4, None:#568, None:#568); 2:Rejected(None:#4, None:#568, None:#568); 3:Cancelled(None:#4, None:#568, None:#568); 4:TimedOut(None:#4, None:#568, None:#568); 5:Killed(None:#4))` | `[{"name":"TrackId","type":56},{"name":"RuntimeOrigin","type":98},{"name":"Moment","type":4},{"name":"Call","type":60},{"name":"Balance","type":6},{"name":"Tally","type":391},{"name":"AccountId","type":0},{"name":"ScheduleAddress","type":33}]` |
| [RPC] | 566 | `pallet_referenda::types::ReferendumStatus` | `struct(track:#56, origin:#98, proposal:#60, enactment:#101, submitted:#4, submission_deposit:#567, decision_deposit:#568, deciding:#569, tally:#391, in_queue:#8, alarm:#571)` | `[{"name":"TrackId","type":56},{"name":"RuntimeOrigin","type":98},{"name":"Moment","type":4},{"name":"Call","type":60},{"name":"Balance","type":6},{"name":"Tally","type":391},{"name":"AccountId","type":0},{"name":"ScheduleAddress","type":33}]` |
| [RPC] | 567 | `pallet_referenda::types::Deposit` | `struct(who:#0, amount:#6)` | `[{"name":"AccountId","type":0},{"name":"Balance","type":6}]` |
| [RPC] | 568 | `Option` | `enum(0:None(); 1:Some(None:#567))` | `[{"name":"T","type":567}]` |
| [RPC] | 569 | `Option` | `enum(0:None(); 1:Some(None:#570))` | `[{"name":"T","type":570}]` |
| [RPC] | 570 | `pallet_referenda::types::DecidingStatus` | `struct(since:#4, confirming:#93)` | `[{"name":"BlockNumber","type":4}]` |
| [RPC] | 571 | `Option` | `enum(0:None(); 1:Some(None:#572))` | `[{"name":"T","type":572}]` |
| [RPC] | 572 | `` | `tuple:[4,33]` | `[]` |
| [RPC] | 573 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#575)` | `[{"name":"T","type":574},{"name":"S","type":null}]` |
| [RPC] | 574 | `` | `tuple:[4,6]` | `[]` |
| [RPC] | 575 | `` | `sequence:574` | `[]` |
| [RPC] | 576 | `` | `sequence:577` | `[]` |
| [RPC] | 577 | `` | `tuple:[56,578]` | `[]` |
| [RPC] | 578 | `pallet_referenda::types::TrackDetails` | `struct(name:#464, max_deciding:#4, decision_deposit:#6, prepare_period:#4, decision_period:#4, confirm_period:#4, min_enactment_period:#4, min_approval:#579, min_support:#579)` | `[{"name":"Balance","type":6},{"name":"Moment","type":4},{"name":"Name","type":464}]` |
| [RPC] | 579 | `pallet_referenda::types::Curve` | `enum(0:LinearDecreasing(length:#208, floor:#208, ceil:#208); 1:SteppedDecreasing(begin:#208, end:#208, step:#208, period:#208); 2:Reciprocal(factor:#580, x_offset:#580, y_offset:#580))` | `[]` |
| [RPC] | 580 | `sp_arithmetic::fixed_point::FixedI64` | `struct(None:#581)` | `[]` |
| [RPC] | 581 | `` | `primitive:"i64"` | `[]` |
| [RPC] | 582 | `pallet_referenda::pallet::Error` | `enum(0:NotOngoing(); 1:HasDeposit(); 2:BadTrack(); 3:Full(); 4:QueueEmpty(); 5:BadReferendum(); 6:NothingToDo(); 7:NoTrack(); 8:Unfinished(); 9:NoPermission(); 10:NoDeposit(); 11:BadStatus(); 12:PreimageNotExist(); 13:PreimageStoredWithDifferentLength())` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 583 | `pallet_bounties::Bounty` | `struct(proposer:#0, value:#6, fee:#6, curator_deposit:#6, bond:#6, status:#584)` | `[{"name":"AccountId","type":0},{"name":"Balance","type":6},{"name":"BlockNumber","type":4}]` |
| [RPC] | 584 | `pallet_bounties::BountyStatus` | `enum(0:Proposed(); 1:Approved(); 2:Funded(); 3:CuratorProposed(curator:#0); 4:Active(curator:#0, update_due:#4); 5:PendingPayout(curator:#0, beneficiary:#0, unlock_at:#4); 6:ApprovedWithCurator(curator:#0))` | `[{"name":"AccountId","type":0},{"name":"BlockNumber","type":4}]` |
| [RPC] | 585 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#14)` | `[{"name":"T","type":2},{"name":"S","type":null}]` |
| [RPC] | 586 | `pallet_bounties::pallet::Error` | `enum(0:InsufficientProposersBalance(); 1:InvalidIndex(); 2:ReasonTooBig(); 3:UnexpectedStatus(); 4:RequireCurator(); 5:InvalidValue(); 6:InvalidFee(); 7:PendingPayout(); 8:Premature(); 9:HasActiveChildBounty(); 10:TooManyQueued(); 11:NotProposer())` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 587 | `pallet_child_bounties::ChildBounty` | `struct(parent_bounty:#4, value:#6, fee:#6, curator_deposit:#6, status:#588)` | `[{"name":"AccountId","type":0},{"name":"Balance","type":6},{"name":"BlockNumber","type":4}]` |
| [RPC] | 588 | `pallet_child_bounties::ChildBountyStatus` | `enum(0:Added(); 1:CuratorProposed(curator:#0); 2:Active(curator:#0); 3:PendingPayout(curator:#0, beneficiary:#0, unlock_at:#4))` | `[{"name":"AccountId","type":0},{"name":"BlockNumber","type":4}]` |
| [RPC] | 589 | `pallet_child_bounties::pallet::Error` | `enum(0:ParentBountyNotActive(); 1:InsufficientBountyBalance(); 2:TooManyChildBounties())` | `[{"name":"T","type":null}]` |
| [RPC] | 590 | `pallet_utility::pallet::Error` | `enum(0:TooManyCalls())` | `[{"name":"T","type":null}]` |
| [RPC] | 591 | `` | `tuple:[0,1]` | `[]` |
| [RPC] | 592 | `pallet_multisig::Multisig` | `struct(when:#109, deposit:#6, depositor:#0, approvals:#593)` | `[{"name":"BlockNumber","type":4},{"name":"Balance","type":6},{"name":"AccountId","type":0},{"name":"MaxApprovals","type":null}]` |
| [RPC] | 593 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#76)` | `[{"name":"T","type":0},{"name":"S","type":null}]` |
| [RPC] | 594 | `pallet_multisig::pallet::Error` | `enum(0:MinimumThreshold(); 1:AlreadyApproved(); 2:NoApprovalsNeeded(); 3:TooFewSignatories(); 4:TooManySignatories(); 5:SignatoriesOutOfOrder(); 6:SenderInSignatories(); 7:NotFound(); 8:NotOwner(); 9:NoTimepoint(); 10:WrongTimepoint(); 11:UnexpectedTimepoint(); 12:MaxWeightTooLow(); 13:AlreadyStored())` | `[{"name":"T","type":null}]` |
| [RPC] | 595 | `` | `tuple:[596,6]` | `[]` |
| [RPC] | 596 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#598)` | `[{"name":"T","type":597},{"name":"S","type":null}]` |
| [RPC] | 597 | `pallet_proxy::ProxyDefinition` | `struct(delegate:#0, proxy_type:#112, delay:#4)` | `[{"name":"AccountId","type":0},{"name":"ProxyType","type":112},{"name":"BlockNumber","type":4}]` |
| [RPC] | 598 | `` | `sequence:597` | `[]` |
| [RPC] | 599 | `` | `tuple:[600,6]` | `[]` |
| [RPC] | 600 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#602)` | `[{"name":"T","type":601},{"name":"S","type":null}]` |
| [RPC] | 601 | `pallet_proxy::Announcement` | `struct(real:#0, call_hash:#13, height:#4)` | `[{"name":"AccountId","type":0},{"name":"Hash","type":13},{"name":"BlockNumber","type":4}]` |
| [RPC] | 602 | `` | `sequence:601` | `[]` |
| [RPC] | 603 | `pallet_proxy::pallet::Error` | `enum(0:TooMany(); 1:NotFound(); 2:NotProxy(); 3:Unproxyable(); 4:Duplicate(); 5:NoPermission(); 6:Unannounced(); 7:NoSelfProxy())` | `[{"name":"T","type":null}]` |
| [RPC] | 604 | `pallet_identity::types::Registration` | `struct(judgements:#605, deposit:#6, info:#114)` | `[{"name":"Balance","type":6},{"name":"MaxJudgements","type":null},{"name":"IdentityInfo","type":114}]` |
| [RPC] | 605 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#607)` | `[{"name":"T","type":606},{"name":"S","type":null}]` |
| [RPC] | 606 | `` | `tuple:[4,151]` | `[]` |
| [RPC] | 607 | `` | `sequence:606` | `[]` |
| [RPC] | 608 | `` | `tuple:[6,609]` | `[]` |
| [RPC] | 609 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#76)` | `[{"name":"T","type":0},{"name":"S","type":null}]` |
| [RPC] | 610 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#613)` | `[{"name":"T","type":611},{"name":"S","type":null}]` |
| [RPC] | 611 | `Option` | `enum(0:None(); 1:Some(None:#612))` | `[{"name":"T","type":612}]` |
| [RPC] | 612 | `pallet_identity::types::RegistrarInfo` | `struct(account:#0, fee:#6, fields:#12)` | `[{"name":"Balance","type":6},{"name":"AccountId","type":0},{"name":"IdField","type":12}]` |
| [RPC] | 613 | `` | `sequence:611` | `[]` |
| [RPC] | 614 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#14)` | `[{"name":"T","type":2},{"name":"S","type":null}]` |
| [RPC] | 615 | `pallet_identity::types::AuthorityProperties` | `struct(account_id:#0, allocation:#4)` | `[{"name":"Account","type":0}]` |
| [RPC] | 616 | `pallet_identity::types::UsernameInformation` | `struct(owner:#0, provider:#617)` | `[{"name":"Account","type":0},{"name":"Balance","type":6}]` |
| [RPC] | 617 | `pallet_identity::types::Provider` | `enum(0:Allocation(); 1:AuthorityDeposit(None:#6); 2:System())` | `[{"name":"Balance","type":6}]` |
| [RPC] | 618 | `` | `tuple:[0,4,617]` | `[]` |
| [RPC] | 619 | `pallet_identity::pallet::Error` | `enum(0:TooManySubAccounts(); 1:NotFound(); 2:NotNamed(); 3:EmptyIndex(); 4:FeeChanged(); 5:NoIdentity(); 6:StickyJudgement(); 7:JudgementGiven(); 8:InvalidJudgement(); 9:InvalidIndex(); 10:InvalidTarget(); 11:TooManyRegistrars(); 12:AlreadyClaimed(); 13:NotSub(); 14:NotOwned(); 15:JudgementForDifferentIdentity(); 16:JudgementPaymentFailed(); 17:InvalidSuffix(); 18:NotUsernameAuthority(); 19:NoAllocation(); 20:InvalidSignature(); 21:RequiresSignature(); 22:InvalidUsername(); 23:UsernameTaken(); 24:NoUsername(); 25:NotExpired(); 26:TooEarly(); 27:NotUnbinding(); 28:AlreadyUnbinding(); 29:InsufficientPrivileges())` | `[{"name":"T","type":null}]` |
| [RPC] | 620 | `pallet_sudo::pallet::Error` | `enum(0:RequireSudo())` | `[{"name":"T","type":null}]` |
| [RPC] | 621 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#622)` | `[{"name":"T","type":159},{"name":"S","type":null}]` |
| [RPC] | 622 | `` | `sequence:159` | `[]` |
| [RPC] | 623 | `pallet_vesting::Releases` | `enum(0:V0(); 1:V1())` | `[]` |
| [RPC] | 624 | `pallet_vesting::pallet::Error` | `enum(0:NotVesting(); 1:AtMaxVestingSchedules(); 2:AmountLow(); 3:ScheduleIndexOutOfBounds(); 4:InvalidScheduleParams())` | `[{"name":"T","type":null}]` |
| [RPC] | 625 | `pallet_aggregate::pallet::Domain` | `struct(None:#626)` | `[{"name":"T","type":null}]` |
| [RPC] | 626 | `pallet_aggregate::data::DomainEntry` | `struct(id:#4, owner:#629, state:#402, next:#630, max_aggregation_size:#4, should_publish:#635, publish_queue_size:#4, ticket_domain:#639, ticket_allowlist:#640, aggregate_rules:#161, proof_rules:#162, delivery:#642)` | `[{"name":"A","type":0},{"name":"B","type":6},{"name":"S","type":null},{"name":"M","type":null},{"name":"T1","type":627},{"name":"T2","type":628}]` |
| [RPC] | 627 | `frame_support::traits::tokens::fungible::HoldConsideration` | `struct(None:#6)` | `[{"name":"A","type":null},{"name":"F","type":null},{"name":"R","type":null},{"name":"D","type":null},{"name":"Fp","type":null}]` |
| [RPC] | 628 | `frame_support::traits::tokens::fungible::HoldConsideration` | `struct(None:#6)` | `[{"name":"A","type":null},{"name":"F","type":null},{"name":"R","type":null},{"name":"D","type":null},{"name":"Fp","type":null}]` |
| [RPC] | 629 | `pallet_aggregate::data::User` | `enum(0:Account(None:#0); 1:Manager())` | `[{"name":"A","type":0}]` |
| [RPC] | 630 | `pallet_aggregate::data::AggregationEntry` | `struct(id:#12, size:#4, statements:#631)` | `[{"name":"A","type":0},{"name":"B","type":6},{"name":"S","type":null}]` |
| [RPC] | 631 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#634)` | `[{"name":"T","type":632},{"name":"S","type":null}]` |
| [RPC] | 632 | `pallet_aggregate::data::StatementEntry` | `struct(account:#0, reserve:#633, statement:#13)` | `[{"name":"A","type":0},{"name":"B","type":6}]` |
| [RPC] | 633 | `pallet_aggregate::data::Reserve` | `struct(aggregate:#6, delivery:#6)` | `[{"name":"B","type":6}]` |
| [RPC] | 634 | `` | `sequence:632` | `[]` |
| [RPC] | 635 | `bounded_collections::bounded_btree_map::BoundedBTreeMap` | `struct(None:#636)` | `[{"name":"K","type":12},{"name":"V","type":630},{"name":"S","type":null}]` |
| [RPC] | 636 | `BTreeMap` | `struct(None:#637)` | `[{"name":"K","type":12},{"name":"V","type":630}]` |
| [RPC] | 637 | `` | `sequence:638` | `[]` |
| [RPC] | 638 | `` | `tuple:[12,630]` | `[]` |
| [RPC] | 639 | `Option` | `enum(0:None(); 1:Some(None:#627))` | `[{"name":"T","type":627}]` |
| [RPC] | 640 | `Option` | `enum(0:None(); 1:Some(None:#641))` | `[{"name":"T","type":641}]` |
| [RPC] | 641 | `pallet_aggregate::data::CountableTicket` | `struct(ticket:#628, count:#4)` | `[{"name":"Ticket","type":628}]` |
| [RPC] | 642 | `pallet_aggregate::data::DeliveryParams` | `struct(owner:#0, data:#163)` | `[{"name":"A","type":0},{"name":"B","type":6}]` |
| [RPC] | 643 | `` | `tuple:[4,0]` | `[]` |
| [RPC] | 644 | `` | `sequence:645` | `[]` |
| [RPC] | 645 | `` | `tuple:[4,630]` | `[]` |
| [RPC] | 646 | `pallet_aggregate::pallet::Error` | `enum(0:UnknownDomainId(); 1:InvalidAggregationId(); 2:InvalidDomainParams(); 3:InvalidDomainState(); 4:MissedDeliveryOwnership(); 5:NextAggregationIdUnavailable())` | `[{"name":"T","type":null}]` |
| [RPC] | 647 | `` | `tuple:[12,172]` | `[]` |
| [RPC] | 648 | `pallet_token_claim::pallet::Error` | `enum(0:AlreadyStarted(); 1:NotEligible(); 2:NothingToClaim(); 3:MaxNumBeneficiariesReached(); 4:TooManyBeneficiaries(); 5:AlreadyPresent(); 6:AlreadyEnded(); 7:NonEmptyBeneficiaries(); 8:BadSignature(); 9:InvalidClaimMessage())` | `[{"name":"T","type":null}]` |
| [RPC] | 649 | `pallet_crl::pallet::CaInfo` | `struct(root_cert:#650, revoked_count:#4, crl_versions:#651)` | `[]` |
| [RPC] | 650 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#14)` | `[{"name":"T","type":2},{"name":"S","type":null}]` |
| [RPC] | 651 | `bounded_collections::bounded_btree_map::BoundedBTreeMap` | `struct(None:#652)` | `[{"name":"K","type":1},{"name":"V","type":12},{"name":"S","type":null}]` |
| [RPC] | 652 | `BTreeMap` | `struct(None:#653)` | `[{"name":"K","type":1},{"name":"V","type":12}]` |
| [RPC] | 653 | `` | `sequence:654` | `[]` |
| [RPC] | 654 | `` | `tuple:[1,12]` | `[]` |
| [RPC] | 655 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#657)` | `[{"name":"T","type":656},{"name":"S","type":null}]` |
| [RPC] | 656 | `pallet_crl::pallet::RevokedInfo` | `struct(issuer:#180, serial:#183)` | `[]` |
| [RPC] | 657 | `` | `sequence:656` | `[]` |
| [RPC] | 658 | `pallet_crl::pallet::Error` | `enum(0:CaNameTooLong(); 1:CaNameEmpty(); 2:RootCertEmpty(); 3:CaAlreadyRegistered(); 4:CaNotFound(); 5:MaxCasReached(); 6:RootCertTooLarge(); 7:CrlPemTooLarge(); 8:CertChainPemTooLarge(); 9:CrlValidationError(); 10:TooManyRevokedCerts(); 11:IssuerTooLarge(); 12:SerialNumberTooLarge(); 13:CrlTooLarge(); 14:NotNewerCrl(); 15:TooManyIssuers(); 16:EmptyCrl(); 17:CrlDerTooLarge(); 18:CertChainDerTooLarge())` | `[{"name":"T","type":null}]` |
| [RPC] | 659 | `pallet_has_station::pallet::HtlcRecord` | `struct(htlc_id:#13, agent:#178, task:#179, hash_lock:#13, reward_amount:#6, created_block:#4, timeout_block:#4, status:#660, miner:#661, gn_used:#213, quote_digest:#102)` | `[{"name":"BlockNumber","type":4}]` |
| [RPC] | 660 | `pallet_has_station::pallet::HtlcStatus` | `enum(0:Created(); 1:Settled(); 2:Refunded(); 3:Committed())` | `[]` |
| [RPC] | 661 | `Option` | `enum(0:None(); 1:Some(None:#178))` | `[{"name":"T","type":178}]` |
| [RPC] | 662 | `` | `tuple:[13,13]` | `[]` |
| [RPC] | 663 | `pallet_has_station::pallet::BtcSwapMeta` | `struct(btc_address:#178, btc_amount_sats:#12, btc_timelock_hours:#4, btc_txid:#185)` | `[]` |
| [RPC] | 664 | `pallet_has_station::pallet::CommitRecord` | `struct(committer:#0, hash_commitment:#13, expiry_block:#4, revealed:#8, preimage:#335)` | `[{"name":"BlockNumber","type":4},{"name":"AccountId","type":0}]` |
| [RPC] | 665 | `pallet_has_station::pallet::EscrowRecord` | `struct(id:#13, funder:#0, payee:#0, amount:#6, policy:#187, deadline:#4, status:#666, created_block:#4)` | `[{"name":"AccountId","type":0},{"name":"BlockNumber","type":4}]` |
| [RPC] | 666 | `pallet_has_station::pallet::EscrowStatus` | `enum(0:Open(); 1:Released(); 2:Refunded())` | `[]` |
| [RPC] | 667 | `` | `tuple:[13,0]` | `[]` |
| [RPC] | 668 | `pallet_has_station::pallet::Error` | `enum(0:InsufficientBalance(); 1:InvalidHashLock(); 2:InvalidRewardAmount(); 3:HtlcNotFound(); 4:InvalidPreImage(); 5:InvalidTeeQuote(); 6:AlreadyRedeemed(); 7:AlreadySettled(); 8:TimeoutNotReached(); 9:NotARelayer(); 10:NotTheAgent(); 11:RelayerAlreadyRegistered(); 12:TooManyRelayers(); 13:NotCrossChainHtlc(); 14:CommitAlreadyExists(); 15:CommitNotFound(); 16:CommitAlreadyRevealed(); 17:CommitExpired(); 18:TimelockSymmetryViolation(); 19:FinalitySafeMode(); 20:PreimageMismatch(); 21:NotTheCommitter(); 22:SettlementPaused(); 23:ChainDivergenceTooHigh(); 24:EscrowNotFound(); 25:EscrowNotOpen(); 26:PolicyNotSatisfied(); 27:DeadlineNotReached(); 28:NotTheFunder(); 29:InvalidPolicy(); 30:InvalidEscrowAmount(); 31:EscrowExpired(); 32:NotAnApprover(); 33:InvalidPointStatement(); 34:NotEscrowController(); 35:EscrowAccountingMismatch(); 36:InvalidHtlcBurnShare(); 37:WorkCommitmentNotFound())` | `[{"name":"T","type":null}]` |
| [RPC] | 669 | `pallet_flop_poui::pallet::PendingProof` | `struct(submitter:#0, gn_weight:#12, latency_ms:#12, model_hash:#13, output_hash:#13, submitted_at:#4, required_validators:#4, hardware_id_hash:#13)` | `[{"name":"T","type":null}]` |
| [RPC] | 670 | `` | `tuple:[4,409]` | `[]` |
| [RPC] | 671 | `pallet_flop_poui::types::SlashingStatistics` | `struct(total_miners_slashed:#12, total_gn_slashed:#12, tee_verification_failures:#12, replay_attacks_detected:#12, tee_violations:#12, last_slash_block:#4)` | `[]` |
| [RPC] | 672 | `pallet_flop_poui::pallet::Error` | `enum(0:BatchTooLarge(); 1:VerificationFailed(); 2:ReplayDetected(); 3:InvalidPayload(); 4:TeeBridgeError(); 5:ProductionModeRequiresValidatorAttestation(); 6:ValidatorNotActive(); 7:PendingVerificationNotFound(); 8:InvalidValidatorSignature(); 9:ValidatorAttestationThresholdNotMet(); 10:ValidatorAttestationMismatch(); 11:InvalidValidatorAttestationThreshold(); 12:GnWeightMismatch(); 13:GnTripwireImplausible(); 14:ModelHashMismatch(); 15:OutputHashMismatch(); 16:HardwareIdHashMismatch(); 17:MeasuredRootRejected(); 18:MinerBlacklisted(); 19:MinerUnderCapacityBonded(); 20:CalibrationGnCapUnavailable(); 21:GnWeightExceedsCalibrationCap(); 22:SlashingFailed(); 23:GnWeightExceedsMaximum(); 24:GnWeightTooLow(); 25:EmptyProofsNotAllowed(); 26:EpochLimitReached(); 27:SimulatorModeDisabled(); 28:MinerNotRegistered(); 29:PendingProofsLimitExceeded(); 30:GnWeightExceedsEfficiencyCeiling(); 31:NoEfficiencyCeiling(); 32:DecodePolicyRejected(); 33:DecodePolicyHashMismatch(); 34:PouiTeeProfileNotPinned(); 35:InvalidPouiTeeAttestClaim(); 36:PouiTeeClaimSubjectMismatch(); 37:InvalidPouiTeeVerdict(); 38:NonSlashablePouiTeeVerdict(); 39:WorkloadClassRequired(); 40:MinerRetired())` | `[{"name":"T","type":null}]` |
| [RPC] | 673 | `pallet_hw_calibration::pallet::BenchmarkBurstCap` | `struct(cap_gflops_per_sec:#12, empirical_cap_gflops_per_sec:#12, assurance_tier:#412, calibration_version:#4, accepted_at:#4, verified_jobs:#4, burst_elapsed_blocks:#12, expected_gn_sum:#6)` | `[{"name":"T","type":null}]` |
| [RPC] | 674 | `pallet_hw_calibration::pallet::Error` | `enum(0:InvalidBurstCap(); 1:TooFewVerifiedJobs(); 2:BurstTooShort(); 3:InsufficientBurstWork(); 4:UnverifiedThroughput(); 5:InsufficientCapacityBond(); 6:RecalibrationTooSoon(); 7:InvalidGpuInventory(); 8:MissingSkuCeiling(); 9:InvalidSkuCeiling(); 10:InvalidRenewalWindow(); 11:InsufficientRenewalWork(); 12:NoAcceptedCap(); 13:InvalidHardwareFingerprint(); 14:CalibrationRecordStale(); 15:CalibrationRecordRetained())` | `[{"name":"T","type":null}]` |
| [RPC] | 675 | `pallet_work_vesting::pallet::EscrowInfo` | `struct(grant_total:#6, unlocked:#6, frozen:#6, pledge_baseline:#12, created_at:#4, revoked:#8)` | `[{"name":"T","type":null}]` |
| [RPC] | 676 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#76)` | `[{"name":"T","type":0},{"name":"S","type":null}]` |
| [RPC] | 677 | `pallet_work_vesting::pallet::Error` | `enum(0:AlreadyHasGrant(); 1:NoActiveGrant(); 2:CalibrationNotComplete(); 3:GrantAlreadyRevoked(); 4:NothingToClaim(); 5:TooManyVestingMiners(); 6:ZeroPledgeBaseline(); 7:FullyVested(); 8:MinerRetired(); 9:RetirementLiabilitiesOutstanding())` | `[{"name":"T","type":null}]` |
| [RPC] | 678 | `pallet_synthetic_tasks::pallet::GhostTask` | `struct(target_miner:#0, gn_weight_expected:#12, issued_at:#4, deadline:#4)` | `[{"name":"T","type":null}]` |
| [RPC] | 679 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#69)` | `[{"name":"T","type":13},{"name":"S","type":null}]` |
| [RPC] | 680 | `pallet_synthetic_tasks::pallet::MinerGhostStats` | `struct(total_issued:#4, total_completed:#4, total_expired:#4, total_incorrect:#4)` | `[]` |
| [RPC] | 681 | `` | `tuple:[0,12]` | `[]` |
| [RPC] | 682 | `pallet_synthetic_tasks::pallet::CalibrationJob` | `struct(target_miner:#0, issued_at:#4, deadline:#4, expected_gn:#12, pack_id:#4, output_commitment:#13)` | `[{"name":"T","type":null}]` |
| [RPC] | 683 | `pallet_synthetic_tasks::pallet::ResolvedCalibrationJob` | `struct(target_miner:#0, issued_at:#4, resolved_at:#4, deadline:#4, expected_gn:#12, pack_id:#4, output_commitment:#13)` | `[{"name":"T","type":null}]` |
| [RPC] | 684 | `pallet_synthetic_tasks::pallet::PreliminaryVerdict` | `struct(target_miner:#0, gn_weight_expected:#12, outcome:#417, finalizes_at:#4, evidence_ok:#8)` | `[{"name":"T","type":null}]` |
| [RPC] | 685 | `pallet_synthetic_tasks::pallet::GhostAppeal` | `struct(appellant:#0, evidence_hash:#13, submitted_at:#4, overturn:#8)` | `[{"name":"T","type":null}]` |
| [RPC] | 686 | `pallet_synthetic_tasks::pallet::Error` | `enum(0:TaskAlreadyExists(); 1:TooManyPendingTasks(); 2:DeadlineInPast(); 3:EmptyBatch(); 4:BatchTooLarge(); 5:UnknownTask(); 6:MissingTaskProfile(); 7:ClaimSubjectMismatch(); 8:InvalidGhostCanaryReason(); 9:InvalidGhostProfile(); 10:AppealWindowClosed(); 11:NotTaskMiner(); 12:NoPreliminaryVerdict(); 13:NoEvidence(); 14:PreliminaryVerdictPending(); 15:MinerRetired())` | `[{"name":"T","type":null}]` |
| [RPC] | 687 | `pallet_attest::pallet::AttestProfile` | `struct(appraisal_policy_hash:#13, verifier_set_requirements:#688, assurance_tier:#224, version:#4)` | `[{"name":"T","type":null}]` |
| [RPC] | 688 | `pallet_attest::pallet::VerifierSetRequirements` | `struct(members:#689, min_threshold:#4)` | `[{"name":"T","type":null}]` |
| [RPC] | 689 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#223)` | `[{"name":"T","type":1},{"name":"S","type":null}]` |
| [RPC] | 690 | `pallet_attest::pallet::Error` | `enum(0:UnknownProfile(); 1:ProfileVersionMismatch(); 2:ProfileVersionNotIncreasing(); 3:EmptyVerifierSet(); 4:TooManyVerifierSetMembers(); 5:TooManySignatures(); 6:DuplicateVerifier(); 7:InvalidThreshold(); 8:EmptySignatures(); 9:ProfileIdMismatch(); 10:VerifierNotMember(); 11:InvalidSignature(); 12:QuorumNotMet())` | `[{"name":"T","type":null}]` |
| [RPC] | 691 | `pallet_airdrop_vesting::pallet::AirdropGrant` | `struct(tier:#226, total:#6, start_block:#4, end_block:#4, claimed:#6, testnet_performance:#93, mainnet_performance:#93)` | `[{"name":"T","type":null}]` |
| [RPC] | 692 | `pallet_airdrop_vesting::pallet::Error` | `enum(0:AlreadyHasGrant(); 1:NoGrant(); 2:AlreadyClaimed(); 3:CliffNotExpired(); 4:ZeroAmount(); 5:EmptyBatch(); 6:BatchTooLarge(); 7:NothingToClaim(); 8:InvalidPerformanceScore())` | `[{"name":"T","type":null}]` |
| [RPC] | 693 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#76)` | `[{"name":"T","type":0},{"name":"S","type":null}]` |
| [RPC] | 694 | `pallet_block_rewards::pallet::Error` | `enum(0:PeriodNotElapsed())` | `[{"name":"T","type":null}]` |
| [RPC] | 695 | `pallet_flop_subsidy::pallet::Error` | `enum(0:RecipientNotConfigured(); 1:SubsidyScheduleExhausted())` | `[{"name":"T","type":null}]` |
| [RPC] | 696 | `` | `tuple:[0,0]` | `[]` |
| [RPC] | 697 | `pallet_session_keys::pallet::SessionToken` | `struct(owner:#0, delegate:#0, spending_cap:#6, per_tx_limit:#6, daily_cap:#6, epoch_spent:#6, epoch_start:#4, spent:#6, expires_at:#4, allowed_pallets:#698, active:#8)` | `[{"name":"T","type":null}]` |
| [RPC] | 698 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#699)` | `[{"name":"T","type":186},{"name":"S","type":null}]` |
| [RPC] | 699 | `` | `sequence:186` | `[]` |
| [RPC] | 700 | `` | `sequence:696` | `[]` |
| [RPC] | 701 | `pallet_session_keys::pallet::CircuitBreakerState` | `struct(period_start:#4, tx_count:#4, total_spend:#6, tripped:#8)` | `[{"name":"T","type":null}]` |
| [RPC] | 702 | `pallet_session_keys::pallet::RotationHistoryEntry` | `struct(timestamps:#703)` | `[{"name":"T","type":null}]` |
| [RPC] | 703 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#304)` | `[{"name":"T","type":4},{"name":"S","type":null}]` |
| [RPC] | 704 | `pallet_session_keys::pallet::Error` | `enum(0:SessionAlreadyExists(); 1:SessionNotFound(); 2:SessionExpired(); 3:SessionRevoked(); 4:SpendingCapExceeded(); 5:PerTxLimitExceeded(); 6:DailyCapExceeded(); 7:PalletNotAllowed(); 8:TooManySessions(); 9:DurationTooLong(); 10:NotOwner(); 11:NotDelegate(); 12:SelfDelegation(); 13:CircuitBreakerTripped(); 14:SessionRotationLimited(); 15:InvalidSessionNonce(); 16:PalletNameTooLong(); 17:TooManyAllowedPallets(); 18:SpendExceedsDeclared())` | `[{"name":"T","type":null}]` |
| [RPC] | 705 | `pallet_agent_wallet::pallet::AgentWalletConfig` | `struct(owner:#0, per_tx_limit:#6, daily_cap:#6, epoch_spent:#6, epoch_start:#4, active:#8, allowed_destinations:#706)` | `[{"name":"T","type":null}]` |
| [RPC] | 706 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#76)` | `[{"name":"T","type":0},{"name":"S","type":null}]` |
| [RPC] | 707 | `` | `tuple:[0,13]` | `[]` |
| [RPC] | 708 | `pallet_agent_wallet::pallet::SponsoredSettlementRecord` | `struct(valid_before:#4, settled_at:#4, settlement_hash:#13)` | `[{"name":"T","type":null}]` |
| [RPC] | 709 | `pallet_agent_wallet::pallet::Error` | `enum(0:WalletAlreadyExists(); 1:WalletNotFound(); 2:WalletInactive(); 3:PerTxLimitExceeded(); 4:DailyCapExceeded(); 5:DestinationNotAllowed(); 6:NotOwner(); 7:NotAgent(); 8:TooManyDestinations(); 9:TooManyWallets(); 10:InsufficientBalance(); 11:SessionCapExceeded(); 12:DestinationNotApprovedComputeSink(); 13:WrongPaymentDomain(); 14:WrongNetwork(); 15:UnsupportedAsset(); 16:WrongFacilitator(); 17:AuthorizationNotYetValid(); 18:AuthorizationExpired(); 19:InvalidValidityWindow(); 20:InvalidAuthorizationSignature(); 21:PaymentAlreadySettled(); 22:PaymentRevoked(); 23:PaymentStateNotPrunable())` | `[{"name":"T","type":null}]` |
| [RPC] | 710 | `pallet_validators::pallet::ValidatorInfo` | `struct(total_stake:#6, self_stake:#6, delegated_stake:#6, delegators:#711, performance_score:#4, epoch_joined:#12, blacklisted:#8, commission:#208)` | `[{"name":"T","type":null}]` |
| [RPC] | 711 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#712)` | `[{"name":"T","type":485},{"name":"S","type":null}]` |
| [RPC] | 712 | `` | `sequence:485` | `[]` |
| [RPC] | 713 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#304)` | `[{"name":"T","type":4},{"name":"S","type":null}]` |
| [RPC] | 714 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#76)` | `[{"name":"T","type":0},{"name":"S","type":null}]` |
| [RPC] | 715 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#76)` | `[{"name":"T","type":0},{"name":"S","type":null}]` |
| [RPC] | 716 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#718)` | `[{"name":"T","type":717},{"name":"S","type":null}]` |
| [RPC] | 717 | `pallet_validators::pallet::SlashingRecord` | `struct(reason:#235, amount:#6, block:#4, ejected:#8)` | `[{"name":"T","type":null}]` |
| [RPC] | 718 | `` | `sequence:717` | `[]` |
| [RPC] | 719 | `pallet_validators::pallet::DelegationInfo` | `struct(validator:#0, amount:#6, rewards_earned:#6, is_unbonding:#8)` | `[{"name":"T","type":null}]` |
| [RPC] | 720 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#722)` | `[{"name":"T","type":721},{"name":"S","type":null}]` |
| [RPC] | 721 | `pallet_validators::pallet::UnbondingDelegation` | `struct(amount:#6, unlock_block:#4)` | `[{"name":"Balance","type":6},{"name":"BlockNumber","type":4}]` |
| [RPC] | 722 | `` | `sequence:721` | `[]` |
| [RPC] | 723 | `` | `tuple:[4,8]` | `[]` |
| [RPC] | 724 | `pallet_validators::pallet::SponsorPosition` | `struct(position_id:#12, sponsor:#0, operator:#0, amount:#6, remaining_principal:#6, started_at:#4, unlock_block:#93, status:#725, reward_policy:#236)` | `[{"name":"T","type":null}]` |
| [RPC] | 725 | `pallet_validators::pallet::SponsorPositionStatus` | `enum(0:Active(); 1:Unbonding(); 2:Withdrawn(); 3:Slashed())` | `[]` |
| [RPC] | 726 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#727)` | `[{"name":"T","type":12},{"name":"S","type":null}]` |
| [RPC] | 727 | `` | `sequence:12` | `[]` |
| [RPC] | 728 | `` | `tuple:[2,180]` | `[]` |
| [RPC] | 729 | `pallet_validators::pallet::Error` | `enum(0:AlreadyRegistered(); 1:NotRegistered(); 2:Blacklisted(); 3:InsufficientSelfStake(); 4:InsufficientStake(); 5:InsufficientSelfStakeRatio(); 6:MaxSlotsExceeded(); 7:NoValidators(); 8:QueueFull(); 9:InvalidScore(); 10:NotAValidator(); 11:NoContributions(); 12:AlreadyJailed(); 13:NotJailed(); 14:StillJailed(); 15:KickedMustRejoin(); 16:NotKicked(); 17:DowntimeTooShort(); 18:InsufficientTopUp(); 19:SelfStakeRatioBreached(); 20:InvalidSponsorAmount(); 21:SponsorPositionNotFound(); 22:NotSponsor(); 23:InvalidSponsorPositionStatus(); 24:SponsorUnlockNotFinalized(); 25:TooManySponsorPositions(); 26:ActiveSetFull(); 27:MinimumActiveValidators(); 28:SponsoredSelfStakeDisabled(); 29:StaleSponsorPositions(); 30:SponsorIsSlashProceedsAccount(); 31:SponsorStakeOverlap(); 32:WithdrawExceedsFrozenStake())` | `[{"name":"T","type":null}]` |
| [RPC] | 730 | `pallet_miner_staking::pallet::MinerInfo` | `struct(self_stake:#6, delegated_stake:#6, commission_rate:#208, is_active:#8, total_rewards_earned:#6, registered_at:#4)` | `[{"name":"T","type":null}]` |
| [RPC] | 731 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#76)` | `[{"name":"T","type":0},{"name":"S","type":null}]` |
| [RPC] | 732 | `pallet_miner_staking::pallet::DelegatorStake` | `struct(amount:#6, delegated_at:#4, rewards_earned:#6)` | `[{"name":"T","type":null}]` |
| [RPC] | 733 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#735)` | `[{"name":"T","type":734},{"name":"S","type":null}]` |
| [RPC] | 734 | `pallet_miner_staking::pallet::UnbondingRequest` | `struct(amount:#6, unlock_block:#4, delegator:#0, miner:#0)` | `[{"name":"T","type":null}]` |
| [RPC] | 735 | `` | `sequence:734` | `[]` |
| [RPC] | 736 | `pallet_miner_staking::pallet::SponsorPosition` | `struct(position_id:#12, sponsor:#0, operator:#0, amount:#6, remaining_principal:#6, started_at:#4, unlock_block:#93, status:#737, reward_policy:#238)` | `[{"name":"T","type":null}]` |
| [RPC] | 737 | `pallet_miner_staking::pallet::SponsorPositionStatus` | `enum(0:Active(); 1:Unbonding(); 2:Withdrawn(); 3:Slashed())` | `[]` |
| [RPC] | 738 | `pallet_miner_staking::pallet::Error` | `enum(0:AlreadyMiner(); 1:NotMiner(); 2:InsufficientSelfStake(); 3:MaxDelegatorsReached(); 4:NoStakeToUnbond(); 5:UnbondingPeriodNotElapsed(); 6:InvalidCommissionRate(); 7:MinerNotActive(); 8:NoUnbondingToClaim(); 9:UnbondBlockedByActiveUsage(); 10:InsufficientCapacityStake(); 11:HardwareBlacklisted(); 12:InvalidSponsorAmount(); 13:SponsorPositionNotFound(); 14:NotSponsor(); 15:InvalidSponsorPositionStatus(); 16:SponsorUnlockNotFinalized(); 17:TooManySponsorPositions(); 18:AlreadyRetired(); 19:MinerRetired(); 20:RetirementNotDrained(); 21:SponsoredSelfStakeDisabled(); 22:SponsorIsSlashProceedsAccount(); 23:SponsorStakeOverlap(); 24:StaleSponsorPositions(); 25:ClaimExceedsFrozenStake())` | `[{"name":"T","type":null}]` |
| [RPC] | 739 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#741)` | `[{"name":"T","type":740},{"name":"S","type":null}]` |
| [RPC] | 740 | `pallet_miner_slashing::pallet::SlashingRecord` | `struct(reason:#240, amount:#6, block:#4, task_hash:#102, blacklisted:#8)` | `[{"name":"T","type":null}]` |
| [RPC] | 741 | `` | `sequence:740` | `[]` |
| [RPC] | 742 | `pallet_miner_slashing::pallet::StrikeRecord` | `struct(strike_count:#4, last_strike_block:#4, total_slashed:#6)` | `[{"name":"T","type":null}]` |
| [RPC] | 743 | `pallet_miner_slashing::pallet::Error` | `enum(0:AlreadyBlacklisted(); 1:NotMiner(); 2:NotSlashable())` | `[{"name":"T","type":null}]` |
| [RPC] | 744 | `pallet_delegation_cap::pallet::Error` | `enum(0:DelegationCapExceeded(); 1:ValidatorNoSelfStake(); 2:NotAValidator())` | `[{"name":"T","type":null}]` |
| [RPC] | 745 | `pallet_emergency_override::pallet::PendingOverride` | `struct(call_hash:#13, call:#746, reason:#747, queued_at:#4, effective_at:#4, queued_by:#0)` | `[{"name":"T","type":null}]` |
| [RPC] | 746 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#14)` | `[{"name":"T","type":2},{"name":"S","type":null}]` |
| [RPC] | 747 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#14)` | `[{"name":"T","type":2},{"name":"S","type":null}]` |
| [RPC] | 748 | `pallet_emergency_override::pallet::Error` | `enum(0:OverrideAlreadyPending(); 1:NoOverridePending(); 2:TimelockNotElapsed(); 3:CooldownNotElapsed(); 4:CannotOverrideSelf(); 5:ReasonTooLong(); 6:CallTooLarge(); 7:CallDecodeFailed())` | `[{"name":"T","type":null}]` |
| [RPC] | 749 | `pallet_model_registry::types::ModelRegistryEntry` | `struct(model_hash:#13, model_name:#178, version:#183, publisher:#0, published_at:#12, model_uri:#184, license_hash:#13, architecture:#244, params_billion:#4, supported_precisions:#245, gflops_per_token:#12, min_vram_gb:#4, status:#750, approved_by:#751, supported_tee_platforms:#248, benchmark_scores:#255, registered_miners:#752, online_miner_count:#4, avg_price_per_gflop:#6, avg_latency_ms:#12, p99_latency_ms:#12, task_success_rate:#430, total_tasks_completed:#12, total_gflops_consumed:#12, task_types:#251)` | `[{"name":"AccountId","type":0}]` |
| [RPC] | 750 | `pallet_model_registry::types::VerificationStatus` | `enum(0:Pending(); 1:Verified(); 2:Deprecated(); 3:Revoked())` | `[]` |
| [RPC] | 751 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#76)` | `[{"name":"T","type":0},{"name":"S","type":null}]` |
| [RPC] | 752 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#754)` | `[{"name":"T","type":753},{"name":"S","type":null}]` |
| [RPC] | 753 | `pallet_model_registry::types::MinerAvailability` | `struct(miner:#0, gpu_model:#178, vram_gb:#4, tee_type:#249, availability:#259, last_active:#12, tasks_completed:#12, avg_latency_ms:#12, success_rate:#430)` | `[{"name":"AccountId","type":0}]` |
| [RPC] | 754 | `` | `sequence:753` | `[]` |
| [RPC] | 755 | `pallet_model_registry::types::ModelMarketState` | `struct(model_hash:#13, pending_task_count:#12, available_miner_count:#12, avg_pickup_time_blocks:#4, avg_completion_time_ms:#12, epoch_price_per_gflop:#6, epoch_volume_tasks:#12, epoch_volume_gflops:#12, market_factor:#430, epoch_number:#12)` | `[]` |
| [RPC] | 756 | `pallet_model_registry::types::ModelStatistics` | `struct(total_inferences:#12, total_gflops:#12, avg_latency_ms:#12, p99_latency_ms:#12, success_rate:#430, last_update_block:#12)` | `[]` |
| [RPC] | 757 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#69)` | `[{"name":"T","type":13},{"name":"S","type":null}]` |
| [RPC] | 758 | `pallet_model_registry::types::ModelLicense` | `struct(model_hash:#13, owner:#0, license_type:#759, royalty_per_inference:#6, royalty_per_gflop:#6, authorized_miners:#751, authorized_tee_platforms:#248, expires_at:#12, max_inferences:#213, min_fee_per_gflop:#6)` | `[{"name":"AccountId","type":0}]` |
| [RPC] | 759 | `pallet_model_registry::types::LicenseType` | `enum(0:Open(); 1:Commercial(); 2:Royalty(); 3:Whitelist())` | `[]` |
| [RPC] | 760 | `pallet_model_registry::types::ModelVersion` | `struct(model_hash:#13, version:#183, parent_hash:#102, registered_at:#12, status:#761, active_tasks:#4, deprecated_at:#213, archived_at:#213, migration_target:#102)` | `[]` |
| [RPC] | 761 | `pallet_model_registry::types::ModelVersionStatus` | `enum(0:Active(); 1:Deprecated(); 2:Archived())` | `[]` |
| [RPC] | 762 | `` | `tuple:[13,246]` | `[]` |
| [RPC] | 763 | `pallet_model_registry::types::MeteringBandParams` | `struct(tokens_per_byte_band_ppm:#4)` | `[]` |
| [RPC] | 764 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#69)` | `[{"name":"T","type":13},{"name":"S","type":null}]` |
| [RPC] | 765 | `pallet_model_registry::types::ModelAdmissionRequirements` | `struct(weights_size_bytes:#12, requires_hybrid_profile:#8)` | `[]` |
| [RPC] | 766 | `pallet_model_registry::qualification::QualificationRequest` | `struct(id:#13, generation:#12, publisher:#0, publisher_domain:#13, checker_domain:#13, executor:#165, executor_domain:#102, terms:#264, profile:#263, weights:#260, weights_size:#12, state:#432, result:#767, report_hash:#102, execution_paid:#6, checking_paid:#6, refunded:#6, pins_released:#8)` | `[{"name":"AccountId","type":0}]` |
| [RPC] | 767 | `Option` | `enum(0:None(); 1:Some(None:#768))` | `[{"name":"T","type":768}]` |
| [RPC] | 768 | `pallet_model_registry::qualification::QualificationResult` | `struct(output_hash:#13, evidence:#260, evidence_bytes:#12, commitment:#13)` | `[]` |
| [RPC] | 769 | `pallet_model_registry::pallet::Error` | `enum(0:ModelAlreadyRegistered(); 1:ModelNotFound(); 2:NotLeasedRetention(); 3:TooManyModels(); 4:TooManyBenchmarks(); 5:TooManyMinersPerModel(); 6:BenchmarkExpired(); 7:BenchmarkVerificationFailed(); 8:NotAuthorized(); 9:ModelNotVerified(); 10:ModelNotActive(); 11:MinerAlreadyRegistered(); 12:MinerNotFound(); 13:InvalidBenchmarkScore(); 14:InvalidMarketFactor(); 15:PriceTooLow(); 16:NoMinersAvailable(); 17:LicenseNotFound(); 18:MinerNotAuthorized(); 19:VersionNotFound(); 20:VersionAlreadyDeprecated(); 21:UriTooLong(); 22:NameTooLong(); 23:MeasuredRootMismatch(); 24:MeasuredRootRequired(); 25:PrecisionNotSupported(); 26:TooManyDecodePolicies(); 27:DecodePolicyNotAllowed(); 28:MeteringBandExceedsCeiling(); 29:RegistrarApproverMismatch(); 30:RegistrarSelfApproval(); 31:AdmissionMeasuredRootRequired(); 32:AdmissionArchHashRequired(); 33:EmptyDecodePolicies(); 34:AdmissionWeightsRefRequired(); 35:AdmissionRequirementsMissing(); 36:InvalidWeightsSize(); 37:AdmissionWeightsUnavailable(); 38:AdmissionHybridProfileRequired(); 39:QualificationMissing(); 40:QualificationIdentity(); 41:QualificationProfileUnavailable(); 42:QualificationIndependence(); 43:QualificationBudget(); 44:QualificationState(); 45:QualificationDeadline(); 46:QualificationNotPassed(); 47:QualificationEvidence(); 48:QualificationMinerUnavailable())` | `[{"name":"T","type":null}]` |
| [RPC] | 770 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#76)` | `[{"name":"T","type":0},{"name":"S","type":null}]` |
| [RPC] | 771 | `pallet_membership::pallet::Error` | `enum(0:AlreadyMember(); 1:NotMember(); 2:TooManyMembers())` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 772 | `pallet_da_registry::pallet::BlobMeta` | `struct(publisher:#0, size_bytes:#12, retention:#261, provider_id:#2, registered_at:#4, expires_at:#93, lease_end:#93, pin_count:#4, warned:#8, providers:#773, deposit:#6)` | `[{"name":"T","type":null}]` |
| [RPC] | 773 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#76)` | `[{"name":"T","type":0},{"name":"S","type":null}]` |
| [RPC] | 774 | `pallet_da_registry::pallet::Audit` | `struct(commitment:#13, provider:#0, expected:#13, issued_at:#4, deadline:#4)` | `[{"name":"T","type":null}]` |
| [RPC] | 775 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#69)` | `[{"name":"T","type":13},{"name":"S","type":null}]` |
| [RPC] | 776 | `pallet_da_registry::pallet::BlobRepairHealth` | `struct(failed_indices:#777, post_repair_successes:#777, repair_assigned_at:#93, repair_deadline:#93, unrecoverable:#8)` | `[{"name":"T","type":null}]` |
| [RPC] | 777 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#304)` | `[{"name":"T","type":4},{"name":"S","type":null}]` |
| [RPC] | 778 | `pallet_da_registry::pallet::BlobChunkCoverage` | `struct(assigned_at:#4, issued_after:#4, providers:#779)` | `[{"name":"T","type":null}]` |
| [RPC] | 779 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#781)` | `[{"name":"T","type":780},{"name":"S","type":null}]` |
| [RPC] | 780 | `pallet_da_registry::pallet::ProviderChunkCoverage` | `struct(index:#4, chunks:#650, count:#4, issued_after:#4)` | `[{"name":"T","type":null}]` |
| [RPC] | 781 | `` | `sequence:780` | `[]` |
| [RPC] | 782 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#14)` | `[{"name":"T","type":2},{"name":"S","type":null}]` |
| [RPC] | 783 | `pallet_da_registry::pallet::Error` | `enum(0:AlreadyRegistered(); 1:ZeroSize(); 2:InsufficientValidators(); 3:TooManyReplicas(); 4:UnknownBlob(); 5:AuditAlreadyExists(); 6:UnknownAudit(); 7:NotAssignedProvider(); 8:AuditExpired(); 9:RetrievalFailed(); 10:AuditProfileNotPinned(); 11:InvalidAuditAttestClaim(); 12:AuditClaimSubjectMismatch(); 13:InvalidAuditVerdict(); 14:NotExpired(); 15:TooManyPendingAudits(); 16:DepositFailed(); 17:DepositPerByteZero(); 18:InvalidReplicationFactor(); 19:DepositPerByteStepTooLarge(); 20:NotPublisher(); 21:NotLeased(); 22:BadLeaseTerm(); 23:LeaseNotExpired(); 24:BlobPinned(); 25:LeaseExpired(); 26:BadEndpoint(); 27:EndpointDepositFailed(); 28:UnknownEndpoint())` | `[{"name":"T","type":null}]` |
| [RPC] | 784 | `` | `tuple:[12,0]` | `[]` |
| [RPC] | 785 | `pallet_paid_storage::pallet::CapacityDeclaration` | `struct(offered_bytes:#12, assigned_bytes:#12, collateral_reserved:#6, vote:#275)` | `[]` |
| [RPC] | 786 | `pallet_paid_storage::reservations::CapacityReservation` | `struct(payer:#0, nonce:#12, opened_at:#12, pending_expiry:#12, term_blocks:#4, reserved_bytes:#12, provider_count:#4, tariff:#436, profile_version:#274, assignment_generation:#4, randomness:#787, activation:#213, end:#213, providers:#789, funded:#6, paid:#6, refunded:#6, remaining_escrow:#6, state:#792, termination_cause:#793)` | `[{"name":"T","type":null}]` |
| [RPC] | 787 | `Option` | `enum(0:None(); 1:Some(None:#788))` | `[{"name":"T","type":788}]` |
| [RPC] | 788 | `pallet_paid_storage::reservations::AssignmentSeed` | `struct(seed:#1, known_since:#12, observed_at:#12)` | `[]` |
| [RPC] | 789 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#791)` | `[{"name":"T","type":790},{"name":"S","type":null}]` |
| [RPC] | 790 | `pallet_paid_storage::reservations::ProviderAssignment` | `struct(provider:#0, reserved_bytes:#12, rent_budget:#6, collateral_reserved:#6)` | `[{"name":"AccountId","type":0}]` |
| [RPC] | 791 | `` | `sequence:790` | `[]` |
| [RPC] | 792 | `pallet_paid_storage::reservations::ReservationState` | `enum(0:Pending(); 1:Active(); 2:Aborted(); 3:Closing(); 4:Closed())` | `[]` |
| [RPC] | 793 | `Option` | `enum(0:None(); 1:Some(None:#794))` | `[{"name":"T","type":794}]` |
| [RPC] | 794 | `pallet_paid_storage::reservations::AbortCause` | `enum(0:PendingExpired(); 1:InsufficientCapacity())` | `[]` |
| [RPC] | 795 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#727)` | `[{"name":"T","type":12},{"name":"S","type":null}]` |
| [RPC] | 796 | `pallet_paid_storage::rent::RentContract` | `struct(epoch_length_blocks:#4, terms:#291, claim_deadline:#213)` | `[]` |
| [RPC] | 797 | `pallet_paid_storage::rent::RentSlot` | `struct(budget:#6, position:#4, paid:#6, forfeited:#6)` | `[]` |
| [RPC] | 798 | `pallet_paid_storage::rent::PostedCheckpoint` | `struct(namespace_root:#1, cumulative_counters_commitment:#1, posted_at:#12)` | `[]` |
| [RPC] | 799 | `pallet_paid_storage::rent::ReleaseCursor` | `struct(reservation:#12, slot:#4)` | `[]` |
| [RPC] | 800 | `pallet_paid_storage::lanes::ServiceLane` | `struct(payer:#0, provider:#0, reservation:#12, nonce:#12, profile_version:#274, tariff_epoch:#12, setup_fee:#6, retrieval_num:#12, request_fee:#6, retrieval_den:#12, claim_window:#4, budget:#6, last_sequence:#12, last_writes:#12, last_bytes:#12, last_requests:#12, last_amount:#6, close_boundary:#213, claim_deadline:#213, state:#801, funded:#6, paid:#6, refunded:#6, remaining:#6)` | `[{"name":"AccountId","type":0}]` |
| [RPC] | 801 | `pallet_paid_storage::lanes::LaneState` | `enum(0:Open(); 1:Closing(); 2:Closed())` | `[]` |
| [RPC] | 802 | `` | `tuple:[12,290]` | `[]` |
| [RPC] | 803 | `pallet_paid_storage::policy::ObjectPolicy` | `struct(reservation:#12, scope:#290, epoch:#12, revoked:#8)` | `[]` |
| [RPC] | 804 | `pallet_paid_storage::pallet::Error` | `enum(0:InactiveProfile(); 1:OpenWork(); 2:InvalidProfile(); 3:DenominatorChanged(); 4:NotActiveValidator(); 5:NotNextEpoch(); 6:EpochStarted(); 7:ZeroCapacity(); 8:DuplicateDeclaration(); 9:TooManyDeclarers(); 10:InsufficientCollateral(); 11:NoDeclaration(); 12:DuplicateVote(); 13:ArithmeticOverflow(); 14:InvalidReservation(); 15:NoCurrentTariff(); 16:MaxCostExceeded(); 17:InsufficientEscrow(); 18:DuplicateReservation(); 19:DuplicateNonce(); 20:TooManyReservations(); 21:UnknownReservation(); 22:NotExpiredPending(); 23:AlreadyFinalized(); 24:InconsistentReservation(); 25:UnknownLane(); 26:InvalidLane(); 27:DuplicateLane(); 28:TooManyLanes(); 29:NonceHistoryExhausted(); 30:InvalidVoucher(); 31:InvalidVoucherAmount(); 32:StaleVoucher(); 33:LaneBudgetExceeded(); 34:LaneClaimExpired(); 35:UnknownFinalizedHeight(); 36:LaneClaimPending(); 37:InconsistentLane(); 38:NotReservationOwner(); 39:ClosedReservation(); 40:InvalidPolicyScope(); 41:UnknownPolicy(); 42:RevokedPolicy(); 43:InconsistentPolicy(); 44:TooManyPolicies(); 45:MissingRentTerms(); 46:NotAssignedProvider(); 47:DuplicateCheckpoint(); 48:CheckpointOutsideGrace(); 49:RentPending(); 50:ReservationNotEnded())` | `[{"name":"T","type":null}]` |
| [RPC] | 805 | `pallet_compute_channel::pallet::Channel` | `struct(agent:#0, miner:#0, model_hash:#13, measured_root:#13, precision:#246, enclave_key:#1, agent_key:#1, escrow:#6, sla:#294, nonce:#12, opened_at:#4, last_attested_at:#4, state:#806, transcript_ref:#296, weights_pin:#102, locked_compute_consumed:#6)` | `[{"name":"T","type":null}]` |
| [RPC] | 806 | `pallet_compute_channel::pallet::ChannelState` | `enum(0:Open(); 1:Settling(final_root:#13, claimed_gn:#6, challenge_end:#4); 2:Closed(); 3:PendingAck(ack_deadline:#4))` | `[{"name":"BlockNumber","type":4}]` |
| [RPC] | 807 | `` | `tuple:[4,12]` | `[]` |
| [RPC] | 808 | `pallet_compute_channel::pallet::ForwardListing` | `struct(id:#13, units:#6, total_price:#6, expires_at:#4, terms_hash:#13, delivered_gn:#6)` | `[{"name":"T","type":null}]` |
| [RPC] | 809 | `pallet_compute_channel::pallet::Dispute` | `struct(challenger:#0, bond:#6, contested_turn:#4, lo:#4, hi:#4, parent_root:#13, rounds:#4, pending_left:#102, pending_right:#102, respond_by:#4)` | `[{"name":"T","type":null}]` |
| [RPC] | 810 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#304)` | `[{"name":"T","type":4},{"name":"S","type":null}]` |
| [RPC] | 811 | `pallet_compute_channel::ToplocEvidence` | `struct(commitment_ref:#13, turns_committed:#4, last_submitted:#4)` | `[{"name":"BlockNumber","type":4}]` |
| [RPC] | 812 | `` | `tuple:[813,816]` | `[]` |
| [RPC] | 813 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#815)` | `[{"name":"T","type":814},{"name":"S","type":null}]` |
| [RPC] | 814 | `` | `tuple:[4,13,4]` | `[]` |
| [RPC] | 815 | `` | `sequence:814` | `[]` |
| [RPC] | 816 | `Option` | `enum(0:None(); 1:Some(None:#491))` | `[{"name":"T","type":491}]` |
| [RPC] | 817 | `pallet_compute_channel::pallet::ToplocEscalation` | `struct(turn_index:#4, milli_exponent_error:#12, opened_at:#4, deadline:#4)` | `[{"name":"BlockNumber","type":4}]` |
| [RPC] | 818 | `` | `tuple:[12,13,4]` | `[]` |
| [RPC] | 819 | `pallet_compute_channel::pallet::FundedForwardOffer` | `struct(offer_hash:#13, expiry:#4, terms:#313, bond_escrow_id:#13)` | `[{"name":"T","type":null}]` |
| [RPC] | 820 | `pallet_compute_channel::pallet::ForwardPosition` | `struct(terms:#313, contract_payment:#6, bond_escrow_id:#13, bond_released:#6, delivered_gn:#6, delivery_root:#13, availability_paid:#6, liveness_completed:#4, liveness_missed:#4)` | `[{"name":"T","type":null}]` |
| [RPC] | 821 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#69)` | `[{"name":"T","type":13},{"name":"S","type":null}]` |
| [RPC] | 822 | `pallet_compute_channel::pallet::ForwardDistribution` | `struct(total_units:#6, remaining_units:#6, total_pool:#6, remaining_pool:#6)` | `[{"name":"T","type":null}]` |
| [RPC] | 823 | `pallet_compute_channel::pallet::ForwardDraw` | `struct(holder:#0, units:#6)` | `[{"name":"T","type":null}]` |
| [RPC] | 824 | `pallet_compute_channel::pallet::ForwardBid` | `struct(buyer:#0, model_hash:#13, measured_root:#13, decode_policy_hash:#13, precision:#246, agent_key:#1, sla:#294, terms:#313, payment_escrow_id:#13, nonce:#12, commit_deadline:#4, phase:#825, claimants:#770)` | `[{"name":"T","type":null}]` |
| [RPC] | 825 | `pallet_compute_channel::pallet::ForwardBidPhase` | `enum(0:Commit(); 1:Reveal(entropy:#13, deadline:#4))` | `[{"name":"T","type":null}]` |
| [RPC] | 826 | `pallet_compute_channel::pallet::ForwardBidClaim` | `struct(commitment:#13, bond_escrow_id:#13, enclave_key:#34)` | `[]` |
| [RPC] | 827 | `pallet_compute_channel::CalibrationSnapshot` | `struct(cap_gflops_per_sec:#12, assurance_tier:#442, calibration_version:#4)` | `[]` |
| [RPC] | 828 | `pallet_compute_channel::pallet::Error` | `enum(0:RequiredToplocEvidenceMissing(); 1:ToplocEvidenceChannelNotOpen(); 2:ZeroToplocCommitment(); 3:ToplocEscalationOpen(); 4:NoToplocEscalation(); 5:ToplocEscalationNotExpired(); 6:ChannelExists(); 7:ChannelNotFound(); 8:ZeroEscrow(); 9:TooManyActiveReservations(); 10:NotAParty(); 11:BadState(); 12:MeasuredRootMismatch(); 13:MeasuredRootRejected(); 14:BadReceiptSignature(); 15:AggregateGnMismatch(); 16:DuplicateVerifiedTurn(); 17:VerifiedTurnOutOfBounds(); 18:TooManySettlementTurns(); 19:MerklePathTooLong(); 20:SlaMaxTurnsTooLarge(); 21:VerifiedWorkOverflow(); 22:VerifiedWorkExceedsEscrow(); 23:TariffExceedsEscrow(); 24:TariffRegression(); 25:RefundPenaltyOverflow(); 26:BadEnclaveSignature(); 27:UnsupportedLeafVersion(); 28:LeafFieldsInconsistent(); 29:LeafNotInRoot(); 30:WindowNotElapsed(); 31:WindowElapsed(); 32:DisputeExists(); 33:DisputeNotFound(); 34:WrongTurnResponded(); 35:BisectionNotAtLeaf(); 36:BisectionNotAwaitingResponse(); 37:BisectionNotAwaitingChallenge(); 38:BisectionBadChildRoots(); 39:BisectionBadTurnCount(); 40:BisectionRoundCap(); 41:SessionNotExpired(); 42:GnRegression(); 43:TranscriptUnavailable(); 44:TranscriptNotUnrecoverable(); 45:ModelWeightsLeaseExpired(); 46:NotPendingAck(); 47:AckWindowElapsed(); 48:AckWindowNotElapsed(); 49:NotNamedMiner(); 50:OfferExpired(); 51:OfferNotExpired(); 52:OfferNonceUsed(); 53:BadOfferSignature(); 54:BadOfferAcceptanceSignature(); 55:OfferEscrowBelowMinimum(); 56:FcuNotActivated(); 57:InvalidForwardTerms(); 58:ForwardOfferNotFunded(); 59:ForwardOfferFundingMismatch(); 60:ForwardNotStarted(); 61:ForwardWindowNotElapsed(); 62:ForwardDeliveryOutOfBounds(); 63:NoForwardAvailabilityAccrued(); 64:FcuSlashPaused(); 65:TooManyForwardChannels(); 66:ForwardArithmeticOverflow(); 67:ForwardAssignmentLockedPrincipal(); 68:ForwardLotTooSmall(); 69:TooManyForwardHolders(); 70:ForwardHolderHasActiveDraw(); 71:ForwardHolderNotFound(); 72:ForwardDrawUnavailable(); 73:TooManyForwardDraws(); 74:ForwardBidExists(); 75:ForwardBidBadPhase(); 76:ForwardBidClaimInvalid(); 77:ForwardBidClaimantSetInvalid(); 78:ForwardBidEntropyUnavailable(); 79:FinalitySafeMode(); 80:ToplocToleranceNotCalibrated(); 81:ToplocBandUnavailable(); 82:ToplocEvidenceMismatch(); 83:ToplocEvidenceChannelMismatch(); 84:ToplocVerifierAccepted(); 85:ValidatorNotActive(); 86:InvalidValidatorSignature(); 87:ToplocQuorumNotMet(); 88:NotPremiumChannel(); 89:PremiumRequiresInt8Exact(); 90:PremiumRequiresWeightCommitment(); 91:PremiumPriceFloorNotMet(); 92:CertificateRejected(); 93:BookkeepingRejected(); 94:BookkeepingRequired(); 95:MeteringRejected(); 96:MeteringRequired(); 97:CalibrationUnavailable(); 98:SettlementExceedsCalibrationCap(); 99:ToplocProfileNotPinned(); 100:InvalidToplocAttestClaim(); 101:ToplocClaimSubjectMismatch(); 102:InvalidToplocVerdict(); 103:AttestationStale(); 104:DegradedWindowExtensionCapped(); 105:DecodePolicyRejected(); 106:DecodePolicyHashMismatch(); 107:NoDisputeStanding(); 108:MissingAuditEvidence(); 109:AuditAlreadyClaimed(); 110:AuditPoolInsufficient(); 111:DisputeTurnNotSettled(); 112:SettlementTariffMissing(); 113:MinerRetired(); 114:SessionEvidenceTooLarge(); 115:SessionEvidenceConflict(); 116:ForwardStateUpgradeRequired(); 117:ForwardListingLocked(); 118:ForwardListingUnavailable(); 119:ForwardSalePriceExceeded(); 120:FcuEconomicSnapshotMissing(); 121:FcuObligationsOutstanding(); 122:FcuPrimaryAdmissionsPaused(); 123:FcuInvalidServiceProfile(); 124:FcuInvalidQualification(); 125:FcuServiceProfileUnknown(); 126:FcuQualificationUnknown(); 127:FcuQualificationConflict(); 128:FcuServiceProfileUnavailable(); 129:FcuInvalidServiceWindow(); 130:FcuTimestampUnavailable(); 131:FcuNativeIntegrationRequired())` | `[{"name":"T","type":null}]` |
| [RPC] | 829 | `pallet_metering_verifier::HybridProfile` | `struct(image_id:#102, epoch:#12)` | `[]` |
| [RPC] | 830 | `pallet_metering_verifier::VerifiedCert` | `struct(record:#323, image_id:#13)` | `[]` |
| [RPC] | 831 | `` | `tuple:[13,13,6,13,4]` | `[]` |
| [RPC] | 832 | `pallet_metering_verifier::pallet::Error` | `enum(0:NoImageIdPinned(); 1:ReceiptVerificationFailed(); 2:ReceiptTooLarge(); 3:CertNotFound(); 4:CertNotStale(); 5:PinEpochExhausted(); 6:HybridProfileNotApproved(); 7:UnsupportedHybridVersion(); 8:HybridSessionIneligible())` | `[{"name":"T","type":null}]` |
| [RPC] | 833 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#76)` | `[{"name":"T","type":0},{"name":"S","type":null}]` |
| [RPC] | 834 | `` | `tuple:[4,13]` | `[]` |
| [RPC] | 835 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#14)` | `[{"name":"T","type":2},{"name":"S","type":null}]` |
| [RPC] | 836 | `pallet_emergency_pause::pallet::PauseInfo` | `struct(reason:#837, activated_at:#4, expires_at:#4)` | `[{"name":"T","type":null}]` |
| [RPC] | 837 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#14)` | `[{"name":"T","type":2},{"name":"S","type":null}]` |
| [RPC] | 838 | `pallet_emergency_pause::pallet::Error` | `enum(0:TooManyPausedPallets(); 1:NotPaused(); 2:EmptyPalletList(); 3:DurationTooLong(); 4:ReasonTooLong(); 5:PalletNameTooLong(); 6:Paused(); 7:ProtectedPallet())` | `[{"name":"T","type":null}]` |
| [RPC] | 839 | `pallet_agent_identity::types::AgentIdentityEntry` | `struct(agent_id:#13, owner:#0, did:#840, name:#183, agent_type:#328, status:#449, registered_at:#12, last_updated:#12, capabilities:#329, reputation_score:#56, reputation_history:#841, staked_amount:#6, endpoints:#192, metadata_uri:#180, metadata:#844, tee_verifications:#847, total_tasks_completed:#12, total_flop_volume:#6, success_rate:#430, verified:#8, verified_by:#165)` | `[{"name":"AccountId","type":0}]` |
| [RPC] | 840 | `pallet_agent_identity::types::AgentDID` | `struct(method:#183, identifier:#13, did_string:#180)` | `[]` |
| [RPC] | 841 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#843)` | `[{"name":"T","type":842},{"name":"S","type":null}]` |
| [RPC] | 842 | `pallet_agent_identity::types::ReputationEvent` | `struct(block_number:#12, event_type:#336, score_change:#450, reason:#184, reference:#102)` | `[]` |
| [RPC] | 843 | `` | `sequence:842` | `[]` |
| [RPC] | 844 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#846)` | `[{"name":"T","type":845},{"name":"S","type":null}]` |
| [RPC] | 845 | `pallet_agent_identity::types::MetadataEntry` | `struct(key:#183, value:#180)` | `[]` |
| [RPC] | 846 | `` | `sequence:845` | `[]` |
| [RPC] | 847 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#849)` | `[{"name":"T","type":848},{"name":"S","type":null}]` |
| [RPC] | 848 | `pallet_agent_identity::types::VerificationRecord` | `struct(verification_type:#337, verified_at:#12, verifier:#0, result:#338, expires_at:#213, proof_hash:#102)` | `[]` |
| [RPC] | 849 | `` | `sequence:848` | `[]` |
| [RPC] | 850 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#69)` | `[{"name":"T","type":13},{"name":"S","type":null}]` |
| [RPC] | 851 | `pallet_agent_identity::AgentGlobalStats` | `struct(total_agents:#4, total_tasks:#12, total_volume:#6, total_staked:#6)` | `[]` |
| [RPC] | 852 | `pallet_agent_identity::types::AgentLicense` | `struct(agent_id:#13, license_type:#339, issuer:#0, price_per_task:#340, authorized_users:#853, terms_uri:#180, license_hash:#13)` | `[{"name":"AccountId","type":0}]` |
| [RPC] | 853 | `bounded_collections::bounded_vec::BoundedVec` | `struct(None:#76)` | `[{"name":"T","type":0},{"name":"S","type":null}]` |
| [RPC] | 854 | `pallet_agent_identity::pallet::Error` | `enum(0:AgentAlreadyRegistered(); 1:AgentNotFound(); 2:TooManyAgents(); 3:NotAuthorized(); 4:AgentNotActive(); 5:AgentNotPending(); 6:InsufficientStake(); 7:InvalidReputationEvent(); 8:TooManyCapabilities(); 9:TooManyEndpoints(); 10:TooManyMetadata(); 11:TooManyVerifications(); 12:AgentAlreadyRevoked(); 13:InvalidDID(); 14:InvalidVerifier(); 15:NameTooLong(); 16:UriTooLong(); 17:LicenseNotFound(); 18:NotAuthorizedForAgent())` | `[{"name":"T","type":null}]` |
| [RPC] | 855 | `pallet_verifiers::pallet::VkEntry` | `struct(vk:#343, ref_count:#12)` | `[{"name":"V","type":343}]` |
| [RPC] | 856 | `frame_support::traits::tokens::fungible::HoldConsideration` | `struct(None:#6)` | `[{"name":"A","type":null},{"name":"F","type":null},{"name":"R","type":null},{"name":"D","type":null},{"name":"Fp","type":null}]` |
| [RPC] | 857 | `pallet_verifiers::pallet::Error` | `enum(0:InvalidInput(); 1:InvalidProofData(); 2:VerifyError(); 3:InvalidVerificationKey(); 4:VerificationKeyNotFound(); 5:DisabledVerifier(); 6:VerificationKeyAlreadyRegistered(); 7:UnsupportedVersion())` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 858 | `pallet_verifiers::pallet::VkEntry` | `struct(vk:#13, ref_count:#12)` | `[{"name":"V","type":13}]` |
| [RPC] | 859 | `pallet_verifiers::pallet::Error` | `enum(0:InvalidInput(); 1:InvalidProofData(); 2:VerifyError(); 3:InvalidVerificationKey(); 4:VerificationKeyNotFound(); 5:DisabledVerifier(); 6:VerificationKeyAlreadyRegistered(); 7:UnsupportedVersion())` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 860 | `pallet_verifiers::pallet::VkEntry` | `struct(vk:#358, ref_count:#12)` | `[{"name":"V","type":358}]` |
| [RPC] | 861 | `pallet_verifiers::pallet::Error` | `enum(0:InvalidInput(); 1:InvalidProofData(); 2:VerifyError(); 3:InvalidVerificationKey(); 4:VerificationKeyNotFound(); 5:DisabledVerifier(); 6:VerificationKeyAlreadyRegistered(); 7:UnsupportedVersion())` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 862 | `pallet_verifiers::pallet::VkEntry` | `struct(vk:#362, ref_count:#12)` | `[{"name":"V","type":362}]` |
| [RPC] | 863 | `pallet_verifiers::pallet::Error` | `enum(0:InvalidInput(); 1:InvalidProofData(); 2:VerifyError(); 3:InvalidVerificationKey(); 4:VerificationKeyNotFound(); 5:DisabledVerifier(); 6:VerificationKeyAlreadyRegistered(); 7:UnsupportedVersion())` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 864 | `pallet_verifiers::pallet::VkEntry` | `struct(vk:#367, ref_count:#12)` | `[{"name":"V","type":367}]` |
| [RPC] | 865 | `pallet_verifiers::pallet::Error` | `enum(0:InvalidInput(); 1:InvalidProofData(); 2:VerifyError(); 3:InvalidVerificationKey(); 4:VerificationKeyNotFound(); 5:DisabledVerifier(); 6:VerificationKeyAlreadyRegistered(); 7:UnsupportedVersion())` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 866 | `pallet_verifiers::pallet::Error` | `enum(0:InvalidInput(); 1:InvalidProofData(); 2:VerifyError(); 3:InvalidVerificationKey(); 4:VerificationKeyNotFound(); 5:DisabledVerifier(); 6:VerificationKeyAlreadyRegistered(); 7:UnsupportedVersion())` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 867 | `pallet_verifiers::pallet::VkEntry` | `struct(vk:#379, ref_count:#12)` | `[{"name":"V","type":379}]` |
| [RPC] | 868 | `pallet_verifiers::pallet::Error` | `enum(0:InvalidInput(); 1:InvalidProofData(); 2:VerifyError(); 3:InvalidVerificationKey(); 4:VerificationKeyNotFound(); 5:DisabledVerifier(); 6:VerificationKeyAlreadyRegistered(); 7:UnsupportedVersion())` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 869 | `pallet_verifiers::pallet::VkEntry` | `struct(vk:#386, ref_count:#12)` | `[{"name":"V","type":386}]` |
| [RPC] | 870 | `pallet_verifiers::pallet::Error` | `enum(0:InvalidInput(); 1:InvalidProofData(); 2:VerifyError(); 3:InvalidVerificationKey(); 4:VerificationKeyNotFound(); 5:DisabledVerifier(); 6:VerificationKeyAlreadyRegistered(); 7:UnsupportedVersion())` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 871 | `pallet_verifiers::pallet::VkEntry` | `struct(vk:#389, ref_count:#12)` | `[{"name":"V","type":389}]` |
| [RPC] | 872 | `pallet_verifiers::pallet::Error` | `enum(0:InvalidInput(); 1:InvalidProofData(); 2:VerifyError(); 3:InvalidVerificationKey(); 4:VerificationKeyNotFound(); 5:DisabledVerifier(); 6:VerificationKeyAlreadyRegistered(); 7:UnsupportedVersion())` | `[{"name":"T","type":null},{"name":"I","type":null}]` |
| [RPC] | 873 | `sp_runtime::generic::unchecked_extrinsic::UncheckedExtrinsic` | `struct(None:#14)` | `[{"name":"Address","type":72},{"name":"Call","type":61},{"name":"Signature","type":153},{"name":"Extra","type":874}]` |
| [RPC] | 874 | `` | `tuple:[875,876,877,878,879,881,882,883,884]` | `[]` |
| [RPC] | 875 | `frame_system::extensions::check_non_zero_sender::CheckNonZeroSender` | `struct()` | `[{"name":"T","type":null}]` |
| [RPC] | 876 | `frame_system::extensions::check_spec_version::CheckSpecVersion` | `struct()` | `[{"name":"T","type":null}]` |
| [RPC] | 877 | `frame_system::extensions::check_tx_version::CheckTxVersion` | `struct()` | `[{"name":"T","type":null}]` |
| [RPC] | 878 | `frame_system::extensions::check_genesis::CheckGenesis` | `struct()` | `[{"name":"T","type":null}]` |
| [RPC] | 879 | `frame_system::extensions::check_mortality::CheckMortality` | `struct(None:#880)` | `[{"name":"T","type":null}]` |
| [RPC] | 880 | `sp_runtime::generic::era::Era` | `enum(0:Immortal(); 1:Mortal1(None:#2); 2:Mortal2(None:#2); 3:Mortal3(None:#2); 4:Mortal4(None:#2); 5:Mortal5(None:#2); 6:Mortal6(None:#2); 7:Mortal7(None:#2); 8:Mortal8(None:#2); 9:Mortal9(None:#2); 10:Mortal10(None:#2); 11:Mortal11(None:#2); 12:Mortal12(None:#2); 13:Mortal13(None:#2); 14:Mortal14(None:#2); 15:Mortal15(None:#2); 16:Mortal16(None:#2); 17:Mortal17(None:#2); 18:Mortal18(None:#2); 19:Mortal19(None:#2); 20:Mortal20(None:#2); 21:Mortal21(None:#2); 22:Mortal22(None:#2); 23:Mortal23(None:#2); 24:Mortal24(None:#2); 25:Mortal25(None:#2); 26:Mortal26(None:#2); 27:Mortal27(None:#2); 28:Mortal28(None:#2); 29:Mortal29(None:#2); 30:Mortal30(None:#2); 31:Mortal31(None:#2); 32:Mortal32(None:#2); 33:Mortal33(None:#2); 34:Mortal34(None:#2); 35:Mortal35(None:#2); 36:Mortal36(None:#2); 37:Mortal37(None:#2); 38:Mortal38(None:#2); 39:Mortal39(None:#2); 40:Mortal40(None:#2); 41:Mortal41(None:#2); 42:Mortal42(None:#2); 43:Mortal43(None:#2); 44:Mortal44(None:#2); 45:Mortal45(None:#2); 46:Mortal46(None:#2); 47:Mortal47(None:#2); 48:Mortal48(None:#2); 49:Mortal49(None:#2); 50:Mortal50(None:#2); 51:Mortal51(None:#2); 52:Mortal52(None:#2); 53:Mortal53(None:#2); 54:Mortal54(None:#2); 55:Mortal55(None:#2); 56:Mortal56(None:#2); 57:Mortal57(None:#2); 58:Mortal58(None:#2); 59:Mortal59(None:#2); 60:Mortal60(None:#2); 61:Mortal61(None:#2); 62:Mortal62(None:#2); 63:Mortal63(None:#2); 64:Mortal64(None:#2); 65:Mortal65(None:#2); 66:Mortal66(None:#2); 67:Mortal67(None:#2); 68:Mortal68(None:#2); 69:Mortal69(None:#2); 70:Mortal70(None:#2); 71:Mortal71(None:#2); 72:Mortal72(None:#2); 73:Mortal73(None:#2); 74:Mortal74(None:#2); 75:Mortal75(None:#2); 76:Mortal76(None:#2); 77:Mortal77(None:#2); 78:Mortal78(None:#2); 79:Mortal79(None:#2); 80:Mortal80(None:#2); 81:Mortal81(None:#2); 82:Mortal82(None:#2); 83:Mortal83(None:#2); 84:Mortal84(None:#2); 85:Mortal85(None:#2); 86:Mortal86(None:#2); 87:Mortal87(None:#2); 88:Mortal88(None:#2); 89:Mortal89(None:#2); 90:Mortal90(None:#2); 91:Mortal91(None:#2); 92:Mortal92(None:#2); 93:Mortal93(None:#2); 94:Mortal94(None:#2); 95:Mortal95(None:#2); 96:Mortal96(None:#2); 97:Mortal97(None:#2); 98:Mortal98(None:#2); 99:Mortal99(None:#2); 100:Mortal100(None:#2); 101:Mortal101(None:#2); 102:Mortal102(None:#2); 103:Mortal103(None:#2); 104:Mortal104(None:#2); 105:Mortal105(None:#2); 106:Mortal106(None:#2); 107:Mortal107(None:#2); 108:Mortal108(None:#2); 109:Mortal109(None:#2); 110:Mortal110(None:#2); 111:Mortal111(None:#2); 112:Mortal112(None:#2); 113:Mortal113(None:#2); 114:Mortal114(None:#2); 115:Mortal115(None:#2); 116:Mortal116(None:#2); 117:Mortal117(None:#2); 118:Mortal118(None:#2); 119:Mortal119(None:#2); 120:Mortal120(None:#2); 121:Mortal121(None:#2); 122:Mortal122(None:#2); 123:Mortal123(None:#2); 124:Mortal124(None:#2); 125:Mortal125(None:#2); 126:Mortal126(None:#2); 127:Mortal127(None:#2); 128:Mortal128(None:#2); 129:Mortal129(None:#2); 130:Mortal130(None:#2); 131:Mortal131(None:#2); 132:Mortal132(None:#2); 133:Mortal133(None:#2); 134:Mortal134(None:#2); 135:Mortal135(None:#2); 136:Mortal136(None:#2); 137:Mortal137(None:#2); 138:Mortal138(None:#2); 139:Mortal139(None:#2); 140:Mortal140(None:#2); 141:Mortal141(None:#2); 142:Mortal142(None:#2); 143:Mortal143(None:#2); 144:Mortal144(None:#2); 145:Mortal145(None:#2); 146:Mortal146(None:#2); 147:Mortal147(None:#2); 148:Mortal148(None:#2); 149:Mortal149(None:#2); 150:Mortal150(None:#2); 151:Mortal151(None:#2); 152:Mortal152(None:#2); 153:Mortal153(None:#2); 154:Mortal154(None:#2); 155:Mortal155(None:#2); 156:Mortal156(None:#2); 157:Mortal157(None:#2); 158:Mortal158(None:#2); 159:Mortal159(None:#2); 160:Mortal160(None:#2); 161:Mortal161(None:#2); 162:Mortal162(None:#2); 163:Mortal163(None:#2); 164:Mortal164(None:#2); 165:Mortal165(None:#2); 166:Mortal166(None:#2); 167:Mortal167(None:#2); 168:Mortal168(None:#2); 169:Mortal169(None:#2); 170:Mortal170(None:#2); 171:Mortal171(None:#2); 172:Mortal172(None:#2); 173:Mortal173(None:#2); 174:Mortal174(None:#2); 175:Mortal175(None:#2); 176:Mortal176(None:#2); 177:Mortal177(None:#2); 178:Mortal178(None:#2); 179:Mortal179(None:#2); 180:Mortal180(None:#2); 181:Mortal181(None:#2); 182:Mortal182(None:#2); 183:Mortal183(None:#2); 184:Mortal184(None:#2); 185:Mortal185(None:#2); 186:Mortal186(None:#2); 187:Mortal187(None:#2); 188:Mortal188(None:#2); 189:Mortal189(None:#2); 190:Mortal190(None:#2); 191:Mortal191(None:#2); 192:Mortal192(None:#2); 193:Mortal193(None:#2); 194:Mortal194(None:#2); 195:Mortal195(None:#2); 196:Mortal196(None:#2); 197:Mortal197(None:#2); 198:Mortal198(None:#2); 199:Mortal199(None:#2); 200:Mortal200(None:#2); 201:Mortal201(None:#2); 202:Mortal202(None:#2); 203:Mortal203(None:#2); 204:Mortal204(None:#2); 205:Mortal205(None:#2); 206:Mortal206(None:#2); 207:Mortal207(None:#2); 208:Mortal208(None:#2); 209:Mortal209(None:#2); 210:Mortal210(None:#2); 211:Mortal211(None:#2); 212:Mortal212(None:#2); 213:Mortal213(None:#2); 214:Mortal214(None:#2); 215:Mortal215(None:#2); 216:Mortal216(None:#2); 217:Mortal217(None:#2); 218:Mortal218(None:#2); 219:Mortal219(None:#2); 220:Mortal220(None:#2); 221:Mortal221(None:#2); 222:Mortal222(None:#2); 223:Mortal223(None:#2); 224:Mortal224(None:#2); 225:Mortal225(None:#2); 226:Mortal226(None:#2); 227:Mortal227(None:#2); 228:Mortal228(None:#2); 229:Mortal229(None:#2); 230:Mortal230(None:#2); 231:Mortal231(None:#2); 232:Mortal232(None:#2); 233:Mortal233(None:#2); 234:Mortal234(None:#2); 235:Mortal235(None:#2); 236:Mortal236(None:#2); 237:Mortal237(None:#2); 238:Mortal238(None:#2); 239:Mortal239(None:#2); 240:Mortal240(None:#2); 241:Mortal241(None:#2); 242:Mortal242(None:#2); 243:Mortal243(None:#2); 244:Mortal244(None:#2); 245:Mortal245(None:#2); 246:Mortal246(None:#2); 247:Mortal247(None:#2); 248:Mortal248(None:#2); 249:Mortal249(None:#2); 250:Mortal250(None:#2); 251:Mortal251(None:#2); 252:Mortal252(None:#2); 253:Mortal253(None:#2); 254:Mortal254(None:#2); 255:Mortal255(None:#2))` | `[]` |
| [RPC] | 881 | `frame_system::extensions::check_nonce::CheckNonce` | `struct(None:#81)` | `[{"name":"T","type":null}]` |
| [RPC] | 882 | `frame_system::extensions::check_weight::CheckWeight` | `struct()` | `[{"name":"T","type":null}]` |
| [RPC] | 883 | `pallet_transaction_payment::ChargeTransactionPayment` | `struct(None:#75)` | `[{"name":"T","type":null}]` |
| [RPC] | 884 | `frame_metadata_hash_extension::CheckMetadataHash` | `struct(mode:#885)` | `[{"name":"T","type":null}]` |
| [RPC] | 885 | `frame_metadata_hash_extension::Mode` | `enum(0:Disabled(); 1:Enabled())` | `[]` |
| [RPC] | 886 | `zkv_runtime::Runtime` | `struct()` | `[]` |
