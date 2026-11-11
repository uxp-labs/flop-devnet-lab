# Read-only proof of a FLOP gateway receipt

**Research date:** 2026-11-11. **Runtime checked:** `tzkv-runtime` spec `1014014`.

## Executive answer

A receipt is on-chain-provable only if its `terminal_event` identifies a finalized block and
event containing a compute-channel terminal event for the same `channel_id`, and the event's
terminal outcome is consistent with the receipt's claimed outcome. For cooperative settlement,
the chain proves a channel-level `Settled` amount, not (by itself) a per-request amount. Thus a
safe cap release is `min(receipt.settled_spend_raw, independently proven channel residual/settled
amount)` only when FLOP supplies a binding request-to-turn/accounting commitment. With the public
fields and pallet data found here, that binding is **not proven for a single request in a reused
channel**.

Evidence labels: **[RPC]** is a direct JSON-RPC/metadata observation; **[source]** is a public
source or specification; **[inference]** follows from those facts; **[unknown]** was not exposed.

## 1. Storage at spec 1014014

### Authoritative layout

The RPC metadata (`state_getMetadata`, decoded with the runtime registry) says pallet
`ComputeChannel` has index **103**, 63 storage items, and `Channels` is
`StorageMap<Blake2_128Concat, H256, Option<Channel>>` (metadata type IDs: key 15, value 820).
[RPC: `https://rpc.devnet.flop.network` JSON-RPC method `state_getMetadata`; the same metadata
can be reproduced with `state_getRuntimeVersion` and the Substrate metadata decoder.] The complete
storage names and metadata types are below; `BalanceOf=u128`, `BlockNumberFor=u32`, `AccountId`
is `AccountId32`, `H256` is 32 bytes. These aliases are direct metadata observations.

| Storage item | Key / hasher | value SCALE type (metadata) | meaning supported by metadata/docs |
|---|---|---|---|
| Channels | H256 / Blake2_128Concat | Option<Channel> (820) | channel record |
| FcuServiceProfiles | H256 / Blake2_128Concat | Option<FcuServiceProfile> (269) | FCU profile |
| FcuServiceQualifications | (H256,H256) / Blake2_128Concat×2 | Option<FcuProfileQualification> (270) | immutable qualification |
| FcuServiceProfileStatus | H256 / Blake2_128Concat | Option<FcuProfileStatus> (272) | profile status |
| FcuBlockTimestamp | plain | Option<u64> (822) | validated timestamp |
| ForwardOfferEconomics | (H256,u64) / Blake2_128Concat×2 | Option<ForwardEconomics> (268) | funded offer economics |
| ForwardBidEconomics | H256 / Blake2_128Concat | Option<ForwardEconomics> (268) | funded bid economics |
| ForwardEconomics | H256 / Blake2_128Concat | Option<ForwardEconomics> (268) | inherited economics |
| ForwardListings | (H256,H256) / Blake2_128Concat×2 | Option<ForwardListing> (823) | forward listing |
| ForwardListingNonce | H256 / Blake2_128Concat | u64 | channel sequence |
| ChannelAuthoredOpenedAt | H256 / Blake2_128Concat | Option<u32> | authored opening height |
| Disputes | H256 / Blake2_128Concat | Option<Dispute> (824) | dispute state |
| ToplocModelTolerance | H256 / Blake2_128Concat | Option<ToplocTolerance> (277) | model tolerance |
| ToplocModelBandConstants | (H256,ModelPrecision) / Blake2_128Concat×2 | Option<ToplocBandConstants> (278) | model band constants |
| SettlementClasses | H256 / Blake2_128Concat | Option<SettlementClass> (257) | pinned class |
| SettlementTariffPay | H256 / Blake2_128Concat | Option<u128> | unilateral tariff |
| LegacyTariffEligibilityEnabled | plain | bool | legacy switch |
| SettlementTariffInitialized | H256 / Blake2_128Concat | Option<u32> | tariff marker |
| SettledTurns | H256 / Blake2_128Concat | Option<u32> | settled tree size |
| SettledTurnIndices | H256 / Blake2_128Concat | Option<Vec<u32>> (825) | verified turn indices |
| ToplocMismatchProfiles | H256 / Blake2_128Concat | Option<ToplocMismatchProfile> (421) | pinned profile |
| ChannelAssuranceClass | H256 / Blake2_128Concat | Option<AssuranceClass> (455) | pinned assurance |
| ChannelToplocEvidence | H256 / Blake2_128Concat | Option<ToplocEvidence> (826) | TOPLOC evidence |
| SessionEvidenceRegistrations | H256 / Blake2_128Concat | Option<SessionEvidenceRegistrations> (827) | session commitments |
| ToplocEscalations | H256 / Blake2_128Concat | Option<ToplocEscalation> (832) | open escalation |
| FailedAcks | AccountId / Blake2_128Concat | u32 | miner missed-ack counter |
| UsedOfferNonces | (H256,u64) / Blake2_128Concat×2 | Option<H256> (15) | replay tombstone |
| FailedOfferOpens | AccountId / Blake2_128Concat | u32 | expired offer counter |
| FcuEmpiricalParameters | plain | Option<FcuEmpiricalParams> (268) | FCU parameters |
| FcuMassSlashPaused | plain | Option<bool> | pause |
| FcuPrimaryAdmissionsPaused | plain | bool | admission pause |
| ForwardBidSeals | H256 / Blake2_128Concat | Option<BidSeal> (822) | bid seal |
| ForwardBidEpochEntropy | u8 / Twox64Concat | Option<EpochEntropy> (833) | entropy ring |
| FundedForwardOffers | (H256,u64) / Blake2_128Concat×2 | Option<FundedOffer> (834) | funded offers |
| ForwardPositions | H256 / Blake2_128Concat | Option<ForwardPosition> (835) | forward accounting |
| ForwardChannelsByMiner | AccountId / Blake2_128Concat | Vec<H256> (836) | reverse index |
| ForwardHolderUnits | (H256,AccountId) / Blake2_128Concat×2 | u128 | holder units |
| ForwardHolderCount | H256 / Blake2_128Concat | u32 | holder count |
| ForwardDistributions | H256 / Blake2_128Concat | Option<ForwardDistribution> (837) | distributions |
| ForwardDraws | (H256,H256) / Blake2_128Concat×2 | Option<ForwardDraw> (838) | draw state |
| ForwardActiveUnits | H256 / Blake2_128Concat | u128 | active units |
| ForwardHolderActiveUnits | (H256,AccountId) / Blake2_128Concat×2 | u128 | active holder units |
| ForwardDrawCount | H256 / Blake2_128Concat | u32 | draw count |
| ForwardBids | H256 / Blake2_128Concat | Option<ForwardBid> (839) | bid |
| ForwardBidClaims | (H256,AccountId) / Blake2_128Concat×2 | Option<BidClaim> (841) | bid claim |
| UsedForwardBidNonces | (H256,u64) / Blake2_128Concat×2 | Option<u32> | bid replay guard |
| TotalEscrowReserved | plain | u128 | cumulative reservation |
| TotalMinerPaid | plain | u128 | cumulative miner payout |
| TotalBurned | plain | u128 | cumulative burn |
| TotalRefunded | plain | u128 | cumulative refund |
| TotalGnCredited | plain | u128 | historical Gn counter |
| TotalForwardBondLocked/Released/Slashed | plain | u128 each | forward bond counters |
| TotalAuditEarmarked/TotalAuditPaid | plain | u128 each | audit pool counters |
| AuditClaimed | (H256,AccountId) / Blake2_128Concat×2 | Option<u32> | audit double-claim guard |
| ActiveReservationCount | AccountId / Blake2_128Concat | u32 | active reservations |
| ChannelCalibrationSnapshots | H256 / Blake2_128Concat | Option<CalibrationSnapshot> (842) | opening calibration |
| ChannelModelArch | H256 / Blake2_128Concat | Option<ModelArch> (63) | architecture snapshot |
| ChannelDecodePolicies | H256 / Blake2_128Concat | Option<H256> | decode policy hash |
| ChannelWireProfiles | H256 / Blake2_128Concat | Option<u8> | wire profile |
| ChallengeWindowExtensions | H256 / Blake2_128Concat | u8 | extension count |

For the 20 opaque custom types, the live node exposes the type ID and SCALE container, but no
field documentation in metadata. **[unknown]** I did not find public pallet source, so I do not
invent field-by-field layouts. The required exact `Channel` value is directly decoded by the
runtime for the worked example:

`agent AccountId32; miner AccountId32; modelHash H256; measuredRoot H256; precision ModelPrecision;
enclaveKey [u8;32]; agentKey [u8;32]; escrow u128; sla {maxTurns u32,maxDuration u32,reattestEvery u32};
nonce u64; openedAt u32; lastAttestedAt u32; state ChannelState; transcriptRef Option<DataRef>;
weightsPin H256; lockedComputeConsumed u128.` **[RPC]**

### Key construction and retention

For `Channels[channel_id]`, the full key for the requested channel is:

`0x130ba67ef498736437f36679a246a7547759ccc18de172078306ca5973251a7b4cbe4c8d8d511e4fa7196fdba7c3819c9f81f65bc93855d394329e4996bc78d949bb786178f3471c13d3853f9813ddd7`

This is `twox128("ComputeChannel") || twox128("Channels") || blake2_128(channel_id) ||
channel_id` (the last 32 bytes are the H256 bytes). **[RPC/metadata]**

The example remains in `Channels` at finalized head with `state=Closed`. **[RPC]** Thus
“settlement always removes `Channels`” is false for this observed runtime/channel. The metadata
docs explicitly say several auxiliary maps are removed on close (for example
`ChannelToplocEvidence`, `SessionEvidenceRegistrations`, `SettlementTariffPay`), while other
historical markers are retained. Whether every channel variant retains its `Channels` record is
not established by one example; exact cleanup must be checked at the terminal block and finalized
head for each item.

## 2. Events

Pallet index is **103**. Event variant indices are the metadata order below; fields are SCALE
order and types. This is the complete event enum at 1014014 [RPC metadata].

`0 ChannelOpened(H256,AccountId,AccountId,u128,H256); 1 OfferAccepted(H256,AccountId,u64,u32);
2 OfferOpenFailed(H256,AccountId,u32); 3 ForwardOfferFunded(AccountId,u64,u128,u32,u32);
4 ForwardOfferCancelled(AccountId,u64,u128); 5 ForwardChannelOpened(H256,AccountId,AccountId,u32,u32,u64,u128,u128,u128,u128);
6 ForwardAvailabilityClaimed(H256,u128,u128); 7 ForwardBondReleased(H256,u128,u128,u128);
8 ForwardAssigned(H256,AccountId,AccountId); 9 ForwardUnitsTransferred(H256,AccountId,AccountId,u128,u128,u128);
10 ForwardDistributionClaimed(H256,AccountId,u128,u128); 11 ForwardDrawOpened(H256,H256,AccountId,u128,u128);
12 ForwardDrawClosed(H256,H256,u128,u128); 13 ForwardBidPosted(H256,AccountId,u128,u32);
14 ForwardBidClaimCommitted(H256,AccountId,u128); 15 ForwardBidClaimsSealed(H256,u32,u32);
16 ForwardBidClaimRevealed(H256,AccountId); 17 ForwardBidCleared(H256,H256,AccountId);
18 ForwardBidCancelled(H256,AccountId,u128); 19 ForwardSettled(H256,ForwardOutcome,u128,u128,u128,u128,u128,u128,u128);
20 ForceOpenRequested(H256,AccountId,AccountId,u128,u32); 21 ForceOpenExpired(H256,AccountId,u128,u32);
22 EscrowToppedUp(H256,u128,u128); 23 Settled(H256,u128,u128,u128,bool); 24 SettlementPosted(H256,H256,u128,u32);
25 TimedOutRefunded(H256,u128); 26 DisputeOpened(H256,AccountId,u32); 27 BisectionOpened(H256,AccountId,u32,u32);
28 BisectionResponded(H256,u32,u32,H256,H256); 29 BisectionChallenged(H256,u32,u32,u32); 30 DisputeDismissed(H256);
31 FraudUpheld(H256,AccountId,u128); 32 ToplocModelToleranceSet(H256,ToplocTolerance);
33 ToplocModelBandConstantsSet(H256,ModelPrecision,ToplocBandConstants); 34 ToplocFraudUpheld(H256,u32,AccountId,u128,u32);
35 ToplocEscalationRequested(H256,u32,AccountId,u64,u32); 36 ToplocEscalationOpened(H256,u32,u32);
37 ToplocEscalationCleared(H256,u32,u32); 38 ToplocEscalationTimedOut(H256,u128);
39 CertificateSettled(H256,u128,H256); 40 CalibrationSnapshotted(H256,AccountId,u64,AssuranceTier,u32,u32);
41 ToplocAttestClaimAccepted(H256,AttestProfileRef,AttestVerdict); 42 ChallengeWindowExtended(H256,SettlementDegradeReason,u32,u8);
43 DegradedRefunded(H256,SettlementDegradeReason,u128); 44 UnrecoverableTranscriptVoided(H256,u128,u128,u128);
45 AssuranceClassPinned(H256,AssuranceClass); 46 ToplocEvidenceSubmitted(H256,AccountId,H256,u32);
47 AuditDataForfeited(H256,AccountId,u128,u128,u128); 48 AuditFeeEarmarked(H256,u128);
49 AuditFeeClaimed(H256,AccountId,u128,H256); 50 SessionEvidenceRegistered(H256,SessionEvidenceSlot,H256,u32);
51 FcuEmpiricalParamsSet(Option<FcuEmpiricalParams>); 52 FcuMassSlashPauseSet(bool);
53 ForwardBidRegistrationSealed(H256,u32); 54 ForwardUnitsListed(H256,AccountId,H256,u128,u128,u32,u128);
55 ForwardUnitsSold(H256,AccountId,AccountId,H256,u128,u128); 56 ForwardListingCancelled(H256,AccountId,H256);
57 FcuPrimaryAdmissionsPauseSet(bool); 58 FcuServiceProfileRegistered(H256,H256); 59 FcuServiceProfileStatusSet(H256,FcuProfileStatus)`.

Calls are also metadata-confirmed: `open_channel` emits ChannelOpened; `top_up_escrow` emits
EscrowToppedUp; `settle` emits Settled; `force_settle` emits SettlementPosted and later
Settled/other terminal events; `timeout` emits TimedOutRefunded; `force_open` emits
ForceOpenRequested; `expire_force_open` emits ForceOpenExpired; evidence calls emit their named
events. The exact emitted subset must be read from the block’s `System.Events`; a failed extrinsic
can emit fee events but is not a successful pallet transition.

## 3. State machine and funds

`Absent -> Open` by `open_channel` (agent funds escrow; ChannelOpened).
`Absent -> PendingAck -> Open` by `force_open` then `force_ack` (agent funds; ForceOpenRequested;
no separate ForceAck event was present in this metadata).
`PendingAck -> Absent/Closed` by `expire_force_open` (agent refund; ForceOpenExpired).
`Open -> Open` by `top_up_escrow` (agent adds funds; EscrowToppedUp).
`Open -> Closed` by cooperative `settle` (escrow pays miner, burn and audit earmark; Settled and
AuditFeeEarmarked).
`Open -> Settling -> Closed` by `force_settle`, `finalize` after challenge window (event sequence
SettlementPosted, then Settled or a dispute/fraud/degraded terminal event).
`Open -> Closed` by `timeout` (refund; TimedOutRefunded).
Dispute paths (`open_dispute`, bisection, TOPLOC escalation) can dismiss and continue, or uphold
fraud/degradation and refund/slash. This state graph is **[RPC metadata + yellowpaper design]**;
the exact authorization and deadlines are **[unknown without pallet source]**.

## 4. Conservation

For the ordinary channel, in base units:

`E_open + Σ topups = M_miner + B_burn + A_audit + R_refund + U_other + D_residual`.

At a closed channel `D_residual=0`; for a live channel it is the current stored `escrow`. The
runtime’s events expose `E_open`, each top-up total, `M_miner`, `B_burn`, `A_audit`, and `R_refund`
where those paths occur. `aggregateGn` is work/credit, not a balance. Side payouts such as audit
claims are separate from the channel escrow and can make “minerPaid + audit fee = escrow” an
incorrect general identity if `B` or `R` is nonzero. **[inference from event fields and storage]

Worked example: `EscrowToppedUp.total = 114000000000000002`; `Settled.minerPaid =
112860000000000002`; `AuditFeeEarmarked.amount = 1140000000000000`; `burned=0`. Therefore
`112860000000000002 + 1140000000000000 = 114000000000000002` exactly. The apparent 2-base-unit
oddity is real input/total data, not rounding; no rounding rule was exposed in the public metadata.
The event is the authoritative proof of these numbers; `escrow` is also in `Channels` storage.

I re-read `System.Events` at block 3479299 (archive RPC) and matched both terminal events by
channel ID: `AuditFeeEarmarked(amount=1140000000000000)` and
`Settled(minerPaid=112860000000000002, burned=0, aggregateGn=38, cooperative=true)`.
`chain_getBlockHash(3479299)` returned
`0xeba1182c9f2bbf5a8fd012afddc201c2ebed11b64f59b10c1d3c4fcc4b2ee18e`;
the live archive read should be treated as authoritative if a reset changes that result.

## 5. Receipt-to-channel limits

The gateway OpenAPI (`https://api.flop.network/openapi.json`, `CredentialReceipt`) confirms fields
`request_id`, `correlation_id`, `reserved_spend`, `settled_spend`, `settled_spend_raw`,
`terminal_event`, `channel_id`, state and response status. It does **not** define that a channel is
one request, nor a canonical terminal-event grammar beyond the published string field.
**[source: OpenAPI]**

Observed terminal-event notation in public FLOP material is `blockHash:eventIndex:phase/index`;
the exact grammar and whether it names an extrinsic event or event position are **[unknown]**.
Resolve it by `chain_getBlockHash(height)` if a height is supplied, then `state_getStorage` of
`System.Events` at that block and decode event records with metadata. A block hash alone is not
enough to identify a pallet event without its event index.

The public chain observation shows a shared gateway agent account on many channels, so the safe
model is “channel is a session/payment reservation, potentially reused by gateway policy,” not
“one channel equals one request.” **[RPC observation / inference]** The chain’s `aggregateGn` and
terminal payout are channel totals; without a signed per-request leaf/turn commitment that names
the request ID, `settled_spend_raw` cannot be attributed exactly to one request. It can be compared
to a channel total only as an upper bound, never as proof of equality.

## 6. Finality

The node identifies itself as zkVerify/tzkv runtime and exposes Aleph finality through finalized
heads. Read-only calls are:

1. `chain_getFinalizedHead()` → finalized block hash.
2. `chain_getHeader(hash)` → finalized height and header.
3. `state_getRuntimeVersion(hash)` → runtime spec at that block.

For a receipt block, compare its hash to the finalized head ancestry (or use the node’s archive
finalized-height method if available). Do not infer finality from explorer status. **[RPC]**

## 7. Minimal procedure

### Variant A: finalized storage (fewest calls)

1. Parse and validate `channel_id` as 32-byte H256; reject malformed receipt values.
2. Call `chain_getFinalizedHead` and `chain_getHeader(finalizedHash)`.
3. Call `state_getStorage(ChannelsKey(channel_id), finalizedHash)`.
4. Decode with metadata fetched at that hash. If `state=Closed`, use the receipt terminal type
   only after independently validating its block/event; a closed record alone does not identify
   which terminal event closed it.
5. Return `proven settled for at most X` only if a finalized `Settled`/certificate terminal event
   for this channel is also proven and `X` is the lesser of the receipt raw amount and the proven
   channel-level amount. Return `proven refunded` for finalized refund terminal events. Otherwise
   `cannot be proven`; if the named block is not finalized, `not yet final`.

### Variant B: named event (stronger, usually more calls)

1. Call `chain_getFinalizedHead`.
2. Resolve the terminal event’s block hash/height with `chain_getBlockHash` (or use the supplied
   hash directly).
3. If not finalized, return `not yet final`.
4. Call `chain_getBlock(blockHash)` only to locate the extrinsic if needed, and
   `state_getStorage(System.EventsKey, blockHash)`; decode with `state_getMetadata(blockHash)`.
5. Require successful extrinsic disposition, pallet index 103, event variant and channel ID.
   Check `Settled.minerPaid`, `AuditFeeEarmarked`, refund/degraded/fraud events and conservation.
   Return the result categories above.

After a runtime upgrade, fetch metadata at the exact block being decoded, re-check pallet index,
variant indices, storage type IDs, event field order and alias widths. Never carry 1014014 indices
forward; a receipt proof must pin the runtime metadata hash/spec used for decoding.

## 8. Failure modes

* **Reused channel:** channel payout is aggregate; per-request release is unprovable without a
  request-bound commitment.
* **Top-up after receipt:** current escrow/total can include later funds; use the terminal event’s
  historical block, not only finalized-head storage.
* **Force-open:** `ForceOpenRequested` may be pending; expiry refunds rather than settling.
* **Dispute/fraud/degraded verdict:** a later finalized event can supersede an apparent posted
  settlement; scan the complete terminal path and challenge window.
* **Chain reset with same genesis:** genesis equality is not continuity. Pin the receipt’s block
  hash, finalized ancestry, runtime spec and (where possible) finalized checkpoint; a reset can
  replay heights under the same genesis.
* **Indexer-only evidence:** explorer API transaction/event JSON is useful discovery, not proof;
  only archive-node RPC state/block/event decoding is proof.

## Could not be confirmed / questions for FLOP

1. Publish the pallet source or a versioned source/metadata bundle so all 63 storage values,
   especially `Channel` and dispute/evidence structs, can be documented field by field.
2. Specify the exact `terminal_event` grammar and whether it binds block hash, extrinsic index,
   event index and phase.
3. State whether gateway channels are per request, per session, or reused, and publish the signed
   request-to-turn/channel accounting commitment.
4. Define the exact relationship between `settled_spend_raw`, miner payment, audit fee, burn and
   `aggregateGn`, including integer rounding and dust handling.
5. Define the authoritative finality RPC/ancestry check for Aleph archive nodes and reset policy.
6. Document all cleanup-on-close side maps and the precise dispute/fraud precedence rules.

## Sources

* Live RPC: `https://rpc.devnet.flop.network` (JSON-RPC `state_getRuntimeVersion`,
  `state_getMetadata`, `chain_getFinalizedHead`, `chain_getHeader`, `chain_getBlockHash`,
  `state_getStorage`, `chain_getBlock`).
* Gateway schema: `https://api.flop.network/openapi.json` (`CredentialReceipt`).
* Explorer discovery API (not proof): `https://explorer.devnet.flop.network/api/transactions?limit=100&offset=0&section=computeChannel`.
* FLOP normative/background source: `https://github.com/flop-labs/yellowpaper` (especially
  `yellowpaper.md`, `yellowpaper-attribution.md`, and `evidence/wire-format-v1.json`).
* FLOP public organisation/source index: `https://github.com/flop-labs`.
