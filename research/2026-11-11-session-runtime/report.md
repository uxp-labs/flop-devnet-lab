# FlopSessionKeys (pallet index 94) in tzkv-runtime spec 1014014: decided from the on-chain wasm

Inputs checked at block `0xbb72c322…b139ab` through the public node `https://rpc.devnet.flop.network`, using `scripts/fetch.sh`:
- `:code` is 2,538,890 bytes. blake2_256 = `0x6d47bb49…44c1df`, which equals `state_getStorageHash` [RPC]. The prefix `52bc537646db8e05` is followed by zstd `28b52ffd` [RPC].
- The decompressed module is 16,823,341 bytes with sha256 **`bb19074278e9e14e1a30a8be3399ae5fdb7b5cafbe57e297b49b150502aba2f0`** [code].
- Metadata is 482,132 bytes with sha256 `f4fd2add…3444`, which matches the brief [RPC]. The runtime version is tzkv-runtime / zkv-node, spec 1014014, tx 2 [RPC].
- The module has a **`name` custom section** (file offset 0xd29f80, 12,176 function names) [code]. The pallet crate is `pallet_session_keys`. Function indexes below are wasm function indexes, counting the 46 imports. Byte offsets are file offsets into the decompressed module.
- Key functions [code]:
  - **5182** = the `with_transaction` closure of `Pallet::execute_via_session`, body 0x624f..–0x625e.., disassembled with `scripts/disasm.py`.
  - 5183 = the `Iterator::any` closure over `allowed_pallets` (`BoundedVec<u8,64>` entries).
  - 11236 = `check_and_update_circuit_breaker`.
  - 4609 = `RuntimeCall::get_call_metadata`.
  - 4666 = `RuntimeCall::dispatch`.
  - 10588 / 10589 = `Currency::free_balance` / `total_balance`.
  - 12087 = `From<Error> for DispatchError`.
  - 11404 = `consume_session_spend` (the interface AgentWallet uses).
- Error mapping [code + RPC]: the argument passed to function 12087 is the metadata error index + 1. The check is that `i32.const 16` precedes InvalidSessionNonce (15) and `i32.const 19` precedes SpendExceedsDeclared (18).

## Short answer table

| # | Question | Answer | Label | Confidence |
|---|---|---|---|---|
| A1 | Deny list | Pallets **Utility, Proxy, Multisig, Sudo, Scheduler, EmergencyOverride, FlopSessionKeys** are refused with PalletNotAllowed (7), whatever `allowed_pallets` says. The refusal is per pallet, not per call. | [code] | high |
| A2 | How the pallet is matched | Through `GetCallMetadata::pallet_name`, the construct_runtime/metadata name as bytes. The deny list is an exact byte compare. For the allow list, the name is ASCII-lowercased into a 64-byte buffer. The comparison closure (fn 5183) also contains the A–Z lowercasing constants (`-65`, `26`), so the match is **ASCII case-insensitive**. | [code] | high / medium-high |
| A3 | Wrapping calls | Utility (batch, batch_all, force_batch, as_derivative), Proxy.*, Multisig.*, Sudo.*, Scheduler.* and a nested execute_via_session are all refused as wrappers. Inner calls are never inspected or let through. | [code] | high |
| A4 | Can a session manage sessions? | No. Every FlopSessionKeys call (create_session, update_session_limits, revoke_session, …) is on the deny list. | [code] | high |
| B1 | What is metered | The **owner's** `free_balance` and `total_balance`, read before and after the dispatch (saturating falls). SpendExceedsDeclared is raised if a fall exceeds `spend_amount`. | [code] | high (owner as the measured account: medium-high) |
| B2 | Inner call origin | `RuntimeOrigin::from(OriginCaller)` built just before dispatch, i.e. Signed(owner). | [code] + [RPC probe] / [inference] | medium-high |
| B3 | Reserves and holds | A reserve or hold lowers free but not total, so it is seen through the free-balance fall. | [code] / [inference] | medium |
| B4 | Outer fee | Paid by the delegate (the signer) before dispatch. It is outside the measured window and not counted. | [inference] + lab probe | high |
| B5 | Which amount is counted | The **declared `spend_amount`**. The session record (lifetime, daily, per-tx) and the nonce are written *before* the dispatch. The post-dispatch step only compares. | [code] | high |
| B6 | Real fall > declared | Error SpendExceedsDeclared. The whole extrinsic's storage layer is rolled back (`with_transaction`). | [code] | high |
| B7 | Owner balance rises | The saturating subtraction gives 0, so no error and no credit. | [code] / [inference] | medium |
| B8 | Later refunds | No call path from ComputeChannel into FlopSessionKeys counters was found. Counters are never lowered. | [inference] | medium |
| C | Order of checks | Session exists → not revoked → nonce == expected → not expired (`System::Number`) → per-tx limit → daily cap (86,400-block epoch, lazy reset) → lifetime cap → deny list → allow list → circuit breaker → write session + nonce+1 → measure → dispatch → measure → compare → event. | [code] | high for the order |
| C2 | After a failed inner call | Everything is rolled back, including nonce, counters and breaker. Only the delegate's fee and the extrinsic's own system events remain. | [code] + lab probe | high |
| C3 | Circuit breaker | Per delegate; `MaxTxs` 100 / `MaxSpend` 250 FLOP per `CircuitBreakerPeriod` 60 blocks; error 13 CircuitBreakerTripped; cleared by period reset or `force_reset_circuit_breaker`. Internals of function 11236 were not read. | [RPC]+[inference] | medium |
| D | ComputeChannel money flows, force_open preconditions, penalties | Not read from code in this run. | [unknown] | — |

## A. Deny list and pallet matching (function 5182)

- [code] At 0x6254fa the code calls `get_call_metadata` (fn 4609) on the inner call. It then switches on the pallet-name length (`br_table` at **0x625520**, length − 4) and compares the bytes against inline constants:

  | Length | Constant compared | Offset |
  |---|---|---|
  | 4 | `0x6F647553` = "Sudo" | 0x62558c |
  | 5 | `0x786F7250` + `y` = "Proxy" | 0x625558 |
  | 7 | `0x6C697455` / `0x7974696C` = "Utility" | 0x625537 |
  | 8 | i64 `7451613955223221581` = "Multisig" | 0x625576 |
  | 9 | i64 `7308345369373991763` + `r` = "Scheduler" | 0x62559d |
  | 15 | data at linear address 0x19251c (file 0xceb7bd) = "FlopSessionKeys" | 0x6255fd |
  | 17 | "EmergencyOverrid" + `e` = "EmergencyOverride" | 0x6255c2 |

  A match falls through to `i32.const 8; call 12087` at **0x62561e**, which raises PalletNotAllowed. Every other length (`br_table` target 9) goes on to the allow list.
- [code] The function name is not consulted, so the deny list covers whole pallets. As a result:
  - Utility.batch, batch_all, force_batch and as_derivative are refused at the wrapper. Inner calls are not inspected.
  - Proxy.proxy, Multisig.* and Scheduler.* are refused.
  - Sudo.* is refused, if Sudo exists in this runtime.
  - Nested execute_via_session and every create_session, update_session_limits or revoke_session made through a session are refused.
  - Balances, System and others are **not** on the deny list. They are blocked only when absent from `allowed_pallets`, which matches the lab's System.remark result.
- [code] Allow list: from 0x62563c a 64-byte zeroed buffer is filled with the pallet name. Bytes 'A'..'Z' (`-65`, `<26`) are OR-ed with 0x20, i.e. lowercased (0x6256c7–0x6256db). `Iterator::any` (fn 5183) is called at 0x625764. On no match it raises `i32.const 8` → PalletNotAllowed (0x625770).
  - [code] fn 5183 contains the same `i32.const -65` / `i32.const 26` lowercasing pattern (6 hits), so entries are lowercased before comparing. [inference] The match is case-insensitive. The lab's "ComputeChannel" entry passed. **Store entries exactly as the metadata name ("ComputeChannel")**, which works under either reading.
  - Test E1 confirms this cheaply.

## B. Spend meter (fn 5182)

- [code] 0x6259ab / 0x6259c6: `free_balance` and `total_balance` of the account at frame slot 320. This is the same slot the origin is built from at 0x625a19 (`RuntimeOrigin::from(OriginCaller)`). After `dispatch` (0x625a3d), the same two reads happen at 0x625a8f / 0x625aaa.
  - Code 0x625aaf–0x625b4b computes saturating `before − after` for both values and compares with `spend_amount`. If greater, `i32.const 19` → **SpendExceedsDeclared** (0x625b54).
  - [inference + lab probe] That account is the owner S, and the inner call runs as Signed(S). The ComputeChannel.timeout probe reached the pallet's own ChannelNotFound check, which needs a signed origin.
- [code] Before the dispatch, at 0x625988, `SessionTokens::insert` writes the updated session record. At 0x6259a0 the nonce map is written with nonce + 1 (`i64.const 1; i64.add`). Both happen after the cap checks at 0x625403–0x6254e7, and those checks add the declared amount. So **the declared `spend_amount` is what is added** to the counters, never the measured fall.
- [inference] Over-declaring is safe but consumes cap. Under-declaring aborts the call.
- [inference] Reserves and holds lower free balance and are caught. A transfer lowers both values. A balance rise saturates to 0.
- [inference] Fee: transaction-payment withdraws the fee from the signer D before dispatch. D is not the measured account, so the fee is not metered.
- Refunds: [inference] fn 5182 is the only writer of session spend seen besides `consume_session_spend` (fn 11404, for AgentWallet). No ComputeChannel function calls into `pallet_session_keys` by name. Refunds therefore do not lower counters. Not exhaustively proven.

## C. Order of checks and side effects (fn 5182, in code order)

1. [code] `SessionTokens::get(owner, delegate)` (0x6251c2). If missing → SessionNotFound (arg 2, 0x62562d).
2. [code] Revoked flag (`& 1`) → **SessionRevoked** (arg 4, 0x625305).
3. [code] Nonce (double map, u64, 0x625330) must equal the supplied nonce → **InvalidSessionNonce** (arg 16, 0x625382).
4. [code] Expiry: compared against `System::Number` (raw key built from i64 constants at 0x62538a) → **SessionExpired** (arg 3, 0x6253f9).
5. [code] Per-tx limit (`spend_amount ≤ per_tx_limit`) → **PerTxLimitExceeded** (arg 6, 0x625429).
6. [code] Daily cap: uses constant **86400** (0x625460). If `now ≥ day_start + 86400` the daily counter is treated as 0 and `day_start` is reset; otherwise `daily_spent + spend` is compared with `daily_cap` → **DailyCapExceeded** (arg 7, 0x625498).
   - [inference] The reset is lazy and happens only inside execute_via_session. The epoch start is the block of the first call after expiry, not aligned to a multiple of 86400. To be confirmed by test E3.
7. [code] Lifetime: `total_spent + spend ≤ spending_cap` → **SpendingCapExceeded** (arg 5, 0x6254e7).
8. [code] Deny list, then allow list (section A).
9. [code] `check_and_update_circuit_breaker` (fn 11236, 0x62578e). Its error is propagated.
   - [RPC] constants: 100 tx / 250 FLOP per 60-block period, per delegate (storage `CircuitBreakers`).
   - [inference] It counts the declared amount and resets by period. `force_reset_circuit_breaker` (call 4, root) clears it.
10. [code] Writes: session record, nonce + 1, then pre-balance reads, dispatch, post-balance reads, SpendExceedsDeclared check, then an event (`deposit_event_indexed` at 0x625bee).
11. [code] The body runs inside `frame_support::storage::transactional::with_transaction` (fn 5182 is its closure). A dispatch error (result tag check at 0x625a48) returns Err, so **all writes (nonce, counters, breaker) are rolled back**. This agrees with the lab probe. The delegate's fee stays charged.

## D. ComputeChannel

[unknown] — the ComputeChannel functions (`pallet_compute_channel`, about 790 name matches) were not disassembled in this run because of the time limit. The following stay open:
- Which account pays escrow, and whether it is a transfer or a reserve.
- force_open preconditions, how the channel id is derived, and what the nonce guards.
- expire_force_open refund versus RefundPenalty.
- How MinForceOpenEscrowForFailedAck gates the failed-ack count, and the failed-ack penalty.
- Who may call timeout and expire_force_open.

What the B findings imply anyway [inference]:
- If escrow is either transferred to `modlflop/chn` or reserved on S, the fall in S's free balance is metered. `spend_amount` must therefore be ≥ escrow + any deposit.
- Refunds later are not credited back to the session.

To read these next: `python3 scripts/disasm.py runtime.wasm names.tsv <idx>` for `grep -n 'pallet_compute_channel.*\(force_open\|expire_force_open\|timeout\|top_up_escrow\|open_channel\)' names.tsv`.

## E. Test plan (read-only reads first; transactions only after you decide to send them)

- **E1 (case):** session with allowed_pallets `["computechannel"]` → `ComputeChannel.timeout(nonexistent)` via the session.
  - Result ChannelNotFound means the entries are lowercased too.
  - Result PalletNotAllowed means the comparison is exact against the lowercased name, and only lowercase entries work. In that case "ComputeChannel" passing would mean entries are lowercased.
- **E2 (deny):** allowed_pallets `["Utility","ComputeChannel"]`, then `Utility.batch([ComputeChannel.timeout(x)])`. Expect PalletNotAllowed (index 7) from the deny list, not ChannelNotFound.
- **E3 (daily reset):** read `SessionTokens(S,D)` via `state_getStorage` before and after a successful call and note the day-start field. The day-start field changing to the current block after more than 86,400 blocks would confirm the lazy, call-anchored reset.
- **E4 (declared vs real):** `Balances.transfer_keep_alive(X, 1 FLOP)` via the session with `spend_amount` 2 FLOP (Balances allowed).
  - Expect success, with the session's `total_spent` up by 2 FLOP.
  - With `spend_amount` 0.5 FLOP, expect SpendExceedsDeclared (18) and an unchanged nonce.
- **E5 (escrow visibility):** `ComputeChannel.force_open(..., escrow = 0.05 FLOP)` via the session with `spend_amount` 0.04 FLOP. SpendExceedsDeclared means the escrow leaves S's free balance. Do this only after D has been read from code, because a force_open can count a failed ack against a miner.
- **Smallest harmless test available now:** `ComputeChannel.timeout(<non-existent id>)` through the session with `spend_amount = 0`. It returns ChannelNotFound and does not touch a miner.

## Reproduce
```
bash scripts/fetch.sh data                      # fetch, verify blake2 hash, strip prefix, zstd -d, print sha256
python3 scripts/wasm_sections.py data/runtime.wasm data/names.tsv
python3 scripts/disasm.py data/runtime.wasm data/names.tsv 5182 > f5182.txt
```

## Sources
- [RPC] https://rpc.devnet.flop.network: `state_getStorage`/`state_getStorageHash`/`state_getMetadata`/`state_getRuntimeVersion` at block 0xbb72c32265f39382b97e3b438c6cda181cf64fdb4015534457259d43a5b139ab.
- Lab probe: https://github.com/uxp-labs/flop-devnet-lab/tree/main/research/2026-11-11-session-probe (as described in the brief; not re-read in this run).
- [source] No public FLOP pallet source was looked up in this run. All [code] claims come from the wasm alone.
