# Plan: the three session tests again, at spec 1014020

Prepared on 2026-11-12. Nothing in this folder has been signed or sent.

The three tests of 2026-11-11 (`../2026-11-11-session-probe/`, `../2026-11-11-session-escrow/`,
`../2026-11-11-session-deny-list/`) were measured at spec 1014014. The devnet runs spec 1014020
since block 3528529 (`../2026-11-12-runtime-upgrade/`). Metadata holds no logic, so every claim
about what the chain does is open again. This plan sends the fewest transactions that test each
such claim once more.

`steps.json` is the plan as data. The tables and command lines below are printed from it by
`plan.mjs`, and `check.test.mjs` fails if this file and that output part.

## How it is made small

Twenty eight transactions were sent at spec 1014014. This plan sends twenty three.

- The probe's two calls ride in the escrow test's session (session A). Both declared a spend of 0,
  so the session's caps do not bear on them. The allow list is `ComputeChannel` alone, as in both
  earlier tests, so `System.remark` is still a pallet not on the list.
- The deny list test keeps its own session (session B). Its allow list must name `System`, while
  session A must not. One session cannot be both.
- Two new device keys, one a session. A new session for a pair whose session was revoked is a
  path no test has taken, and the 1014020 metadata adds `RetiredSessionRecordMissing` for exactly
  such re-grants (its doc comment is in `errors-1014020.json`). So no key is used twice.
- Device 1 sends what it has left to device 2 (A11) in place of a second funding. One transaction
  saved. Device 2 returns everything to the owner at the end (B12).

## Who signs

- owner: the lab's FLOP identity, `$OWNER` (from `deny` `owner.public_key`). Five transactions.
- dev1: a new key the lead makes with `flop-sign.mjs keygen` for session A. Eight transactions.
- dev2: a new key the lead makes the same way for session B. Ten transactions.
- No key's bytes appear anywhere in this folder. The commands name key files by `$KEY_OWNER`,
  `$KEY_DEV1` and `$KEY_DEV2`.

The owner's account nonce at the start is read from the chain before A1. It should be 9: the deny
list test's last owner transaction (`deny` `steps[11].account_nonce`) had 8. If it is not 9,
something else was sent from the owner since, and the lead says so before going on.

## The signer

`../2026-11-11-session-deny-list/flop-sign.mjs` (version 3) makes every transaction of this plan
with flags. It is not copied and not changed.

- Calls: `transfer`, `sweep`, `create-session`, `revoke`, and `via-session` with the inner calls
  `timeout:`, `remark:`, `force-open:<file>`, `expire:` and the seven `denied:` calls. All are in
  its `call` command and in its `describe` reader.
- The spec: `sign --spec 1014020`. The transaction version (`--txv 2`) and the genesis
  (`--genesis`) are passed as well, from `upgrade` `transaction_version.after` and `upgrade`
  `genesis`, though they are its defaults.
- What did not change: the upgrade report found every call these signers encode to have the same
  pallet index, call index and fields at both specs (`upgrade`
  `what_changed_in_the_metadata.the_lab_signers`). Read, not run.
- Known from source only. Run with no key and no command, the signer stops while loading
  `@noble/curves`, before it reads any flag, because no library folder is installed here. So its
  flags were read from its source, not from a run.

The force_open files (`fo-1.json`, `fo-2.json`, `fo-3.json`) name dev1 as the agent key, as the
escrow test named its device. `plan.mjs commands --results <results> --fo-out <folder>` writes
them once dev1 is recorded in the results form. It refuses an escrow at or above
`MinForceOpenEscrowForFailedAck`, which is still 0.05 FLOP at spec 1014020 (`facts`
`constants.ComputeChannel.MinForceOpenEscrowForFailedAck`). The signer refuses it too.

## The claims

Each claim is a line of an earlier README (file and line). The plan tests it again or leaves it.

| Claim | What it says | Rerun |
|---|---|---|
| probe:12 | a session with allow list `["ComputeChannel"]` is created | A2 |
| probe:14 | a `ComputeChannel` call passes the session and fails in the pallet with `ChannelNotFound` | A3 |
| probe:17 | `System.remark`, not on the list, fails with `PalletNotAllowed` | A4 |
| probe:19 | `ComputeChannel` is not denied | A3 |
| probe:23 | a failed inner call rolls back: nonce, counters, breaker unchanged | A3 (events and reads) |
| probe:25 | the device pays the fee of a failed call | A3, A4 (fee payer judged; amount compared, not judged) |
| probe:27 | creating and revoking cost a fee, no deposit | A2, A10 (no `Reserved` or `Held`; amount compared) |
| probe:28 | after revoke the record stays with `active` false, `DelegateSessions` empty | A10 (reads) |
| escrow:18 | declared 0 for an escrow of 0.01 fails with `SpendExceedsDeclared`, nothing moves | A5 |
| escrow:19 | declared 0.012 succeeds, 0.01 moves, counters rise by 0.012 | A6 |
| escrow:20 | 0.03 over the 0.02 per call fails with `PerTxLimitExceeded` | A7 |
| escrow:21 | 0.019 over what is left of 0.025 a day fails with `DailyCapExceeded` | A8 |
| escrow:22 | the refund after the ack window returns 0.01, counters stay | A9 |
| escrow:26 | a device cannot move more than it declares | A5 |
| escrow:28 | the limits count what is declared, not what moves | A6 |
| escrow:30 | the per call limit and the daily cap refuse | A7, A8 |
| escrow:31 | a refund gives no room back | A9 |
| escrow:33 | the owner pays the escrow and gets the refund, the device pays every fee | A6, A9 |
| escrow:35 | a failed call leaves nonce, counters and breaker | A5, A8 (reads) |
| escrow:44 | a `force_open` naming a non miner is accepted | A6 (event only, see below) |
| escrow:46 | an unanswered `force_open` below 0.05 adds no `FailedAcks` | A9 (event and read) |
| escrow:94 | `SessionCallExecuted` carries running totals | A6, A9 |
| escrow:96 | the ack deadline is counted from a height behind the block of inclusion | A6 (deadline less than `AckWindow` after inclusion) |
| escrow:99 | the breaker counts calls that succeed | A8 (read `tx_count` 1) |
| deny:12 | the seven pallets are refused even when listed | B2 to B8 |
| deny:28 | `System.remark`, listed, succeeds | B10 |
| deny:32 | no wrapper call gets through | B2 to B8 |
| deny:35 | a denied pallet gives the same error as an unlisted one | A4 with B2 to B8 |
| deny:37 | `create_session` takes a list naming denied pallets | B1 |
| deny:39 | the allow list ignores case | B9 |
| deny:41 | a refused call leaves the session nonce; only a success moves it | B9, B10 (reads) |

Left, and why:

- The fee amounts (probe:25 to 27, escrow:33, deny:43). Fees depend on weights and length, which
  an upgrade may change. They are recorded and set beside the 1014014 fee by `check.mjs`, not
  judged.
- escrow:44, the channel's state `PendingAck`, and escrow:96, the value of `opened_at`. No read of
  the `Channels` record is planned. The events show acceptance and the deadline.
- escrow:99 to 101, a new breaker period at the refund. It turns on how many blocks pass, against
  `CircuitBreakerPeriod`, not on the runtime alone.
- deny:37 to 38, that the stored record holds the names as given. No read of the record's allow
  list is planned. That the names have no effect is tested.
- escrow:38 to 40, the doc comment of `execute_via_session`. Source only: its sha256 is the same
  at both specs (`facts` `call_docs`). The doc comments of `create_session`, `revoke_session`,
  `force_open`, `expire_force_open` and `timeout` are unchanged too.
- That the signer's bytes equal a reference encoder at spec 1014020 (probe:69, escrow:197,
  deny:336). The earlier `check.mjs` files are pinned to the 1014014 fixture. The upgrade report
  read it, did not run it. The gate before each send is the node's
  `TaggedTransactionQueue_validate_transaction`, as before.

## The transactions

| # | Signs | Call | Moves | Declared | Expected | If not |
|---|---|---|---|---|---|---|
| A1 | owner | transfer | 150000000000000000 (0.15 FLOP) owner to dev1; at B12, less the devices' fees | none | success | stop |
| A2 | owner | create-session | nothing | none | success | stop |
| A3 | dev1 | via-session timeout:$CH_PROBE | nothing | 0 (0 FLOP) | refused: ComputeChannel.ChannelNotFound (pallet 103, error 7) | continue |
| A4 | dev1 | via-session remark:$REMARK_PROBE | nothing | 0 (0 FLOP) | refused: FlopSessionKeys.PalletNotAllowed (pallet 94, error 7) | continue |
| A5 | dev1 | via-session force-open:fo-1.json | 10000000000000000 (0.01 FLOP) owner to ComputeChannel pallet account; never moves: expected refused | 0 (0 FLOP) | refused: FlopSessionKeys.SpendExceedsDeclared (pallet 94, error 20) | stop |
| A6 | dev1 | via-session force-open:fo-1.json | 10000000000000000 (0.01 FLOP) owner to ComputeChannel pallet account; at A9, after the ack window | 12000000000000000 (0.012 FLOP) | success | stop |
| A7 | dev1 | via-session force-open:fo-2.json | 30000000000000000 (0.03 FLOP) owner to ComputeChannel pallet account; never moves: expected refused | 30000000000000000 (0.03 FLOP) | refused: FlopSessionKeys.PerTxLimitExceeded (pallet 94, error 5) | stop |
| A8 | dev1 | via-session force-open:fo-3.json | 19000000000000000 (0.019 FLOP) owner to ComputeChannel pallet account; never moves: expected refused | 19000000000000000 (0.019 FLOP) | refused: FlopSessionKeys.DailyCapExceeded (pallet 94, error 6) | stop |
| A9 | dev1 | via-session expire:… | 10000000000000000 (0.01 FLOP) ComputeChannel pallet account to owner; this is the return | 0 (0 FLOP) | success | stop |
| A10 | owner | revoke | nothing | none | success | stop |
| A11 | dev1 | sweep | all dev1 holds dev1 to dev2; at B12 | none | success | stop |
| B1 | owner | create-session | nothing | none | success | stop |
| B2 | dev2 | via-session denied:Utility | nothing | 0 (0 FLOP) | refused: FlopSessionKeys.PalletNotAllowed (pallet 94, error 7) | continue |
| B3 | dev2 | via-session denied:Proxy | nothing | 0 (0 FLOP) | refused: FlopSessionKeys.PalletNotAllowed (pallet 94, error 7) | continue |
| B4 | dev2 | via-session denied:Multisig:$NAMED | nothing | 0 (0 FLOP) | refused: FlopSessionKeys.PalletNotAllowed (pallet 94, error 7) | continue |
| B5 | dev2 | via-session denied:Sudo | nothing | 0 (0 FLOP) | refused: FlopSessionKeys.PalletNotAllowed (pallet 94, error 7) | continue |
| B6 | dev2 | via-session denied:Scheduler | nothing | 0 (0 FLOP) | refused: FlopSessionKeys.PalletNotAllowed (pallet 94, error 7) | continue |
| B7 | dev2 | via-session denied:EmergencyOverride | nothing | 0 (0 FLOP) | refused: FlopSessionKeys.PalletNotAllowed (pallet 94, error 7) | continue |
| B8 | dev2 | via-session denied:FlopSessionKeys:$NAMED | nothing | 0 (0 FLOP) | refused: FlopSessionKeys.PalletNotAllowed (pallet 94, error 7) | continue |
| B9 | dev2 | via-session timeout:$CH_DENY | nothing | 0 (0 FLOP) | refused: ComputeChannel.ChannelNotFound (pallet 103, error 7) | continue |
| B10 | dev2 | via-session remark:$REMARK_DENY | nothing | 0 (0 FLOP) | success | continue |
| B11 | owner | revoke | nothing | none | success | stop |
| B12 | dev2 | sweep | all dev2 holds dev2 to owner; this is the return | none | success | stop |

"If not" is the rule when the chain answers otherwise: stop means send nothing more and report;
continue means record it and go on (those calls move nothing and declare 0). `check.mjs` flags any
transaction recorded after a stop step went wrong.

What else `check.mjs` judges for each transaction, besides the outcome:

- that the block was executed by spec 1014020 (`System.LastRuntimeUpgrade` at the block), since
  the error names are only right for that spec;
- the signer and its account nonce;
- every event name and field name against the 1014020 metadata;
- the events and fields `steps.json` expects, with amounts from the earlier results;
- for a refusal, that nothing of the inner call happened: no `Balances.Transfer`, `Reserved` or
  `Held`, no `SessionCallExecuted`, no `ComputeChannel` event;
- that the signer paid the fee and that `fee_raw` is the fee event's;
- the reads after the step;
- for the whole run, that the owner's balance fell by exactly the sum of all fees.

Reads after a step, at its block hash: `FlopSessionKeys.Sessions(owner, device)` for `active`,
`spent` and `epoch_spent`; `SessionNonces(owner, device)`; `CircuitBreakers(device)` for
`tx_count`; `DelegateSessions(device)`; `ComputeChannel.FailedAcks(named)`. The storage keys come
from the signer's `keys` and `channel-keys` commands, which need no key.

A9 waits until the chain is past the ack deadline that A6's `ForceOpenRequested` names. The ack
window is 600 blocks (`facts` `constants.ComputeChannel.AckWindow`). At 1014014 that took about
ten minutes. Session B can wait too: dev2 is funded only at A11.

## The command lines

Printed by `node plan.mjs commands`. A `$NAME` in single quotes is not known before the run (a
device key, or the channel id A6 makes); the signer refuses it as it is not hex. Once dev1, dev2
and the owner's nonce are in the results form, `node plan.mjs commands --results <results>` prints
them filled, and A9 once A6's events are recorded.

```sh
# run in a working folder outside the repo that holds the force_open files (--fo-out), after: mkdir calls signed
# LAB is the repo checkout; KEY_OWNER, KEY_DEV1, KEY_DEV2 name the key files; FLOP_SIGN_LIBS names the libraries
# a $NAME in single quotes is not known yet: the signer refuses it. Rerun with --results once it is recorded.

# A1: signed by the owner key, account nonce $((OWNER_NONCE+0)), expect success
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call transfer --to '$DEV1' --amount 150000000000000000 > calls/A1.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_OWNER --call "$(node -p 'require("./calls/A1.json").call')" --nonce $((OWNER_NONCE+0)) --out signed/A1.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631

# A2: signed by the owner key, account nonce $((OWNER_NONCE+1)), expect success
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call create-session --delegate '$DEV1' --cap 50000000000000000 --per-tx 20000000000000000 --daily 25000000000000000 --blocks 7200 --allow ComputeChannel > calls/A2.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_OWNER --call "$(node -p 'require("./calls/A2.json").call')" --nonce $((OWNER_NONCE+1)) --out signed/A2.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631

# A3: signed by the dev1 key, account nonce 0, expect ComputeChannel.ChannelNotFound
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call via-session --owner 0xe462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2 --inner timeout:0x696d642d666c6f702d73657373696f6e2d70726f62652d32303236313131312e --spend 0 --nonce 0 > calls/A3.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_DEV1 --call "$(node -p 'require("./calls/A3.json").call')" --nonce 0 --out signed/A3.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631

# A4: signed by the dev1 key, account nonce 1, expect FlopSessionKeys.PalletNotAllowed
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call via-session --owner 0xe462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2 --inner 'remark:imd-flop session probe' --spend 0 --nonce 0 > calls/A4.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_DEV1 --call "$(node -p 'require("./calls/A4.json").call')" --nonce 1 --out signed/A4.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631

# A5: signed by the dev1 key, account nonce 2, expect FlopSessionKeys.SpendExceedsDeclared
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call via-session --owner 0xe462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2 --inner force-open:fo-1.json --spend 0 --nonce 0 > calls/A5.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_DEV1 --call "$(node -p 'require("./calls/A5.json").call')" --nonce 2 --out signed/A5.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631

# A6: signed by the dev1 key, account nonce 3, expect success
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call via-session --owner 0xe462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2 --inner force-open:fo-1.json --spend 12000000000000000 --nonce 0 > calls/A6.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_DEV1 --call "$(node -p 'require("./calls/A6.json").call')" --nonce 3 --out signed/A6.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631

# A7: signed by the dev1 key, account nonce 4, expect FlopSessionKeys.PerTxLimitExceeded
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call via-session --owner 0xe462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2 --inner force-open:fo-2.json --spend 30000000000000000 --nonce 1 > calls/A7.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_DEV1 --call "$(node -p 'require("./calls/A7.json").call')" --nonce 4 --out signed/A7.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631

# A8: signed by the dev1 key, account nonce 5, expect FlopSessionKeys.DailyCapExceeded
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call via-session --owner 0xe462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2 --inner force-open:fo-3.json --spend 19000000000000000 --nonce 1 > calls/A8.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_DEV1 --call "$(node -p 'require("./calls/A8.json").call')" --nonce 5 --out signed/A8.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631

# A9: signed by the dev1 key, account nonce 6, expect success
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call via-session --owner 0xe462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2 --inner 'expire:$A6.ComputeChannel.ForceOpenRequested.channel_id' --spend 0 --nonce 1 > calls/A9.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_DEV1 --call "$(node -p 'require("./calls/A9.json").call')" --nonce 6 --out signed/A9.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631

# A10: signed by the owner key, account nonce $((OWNER_NONCE+2)), expect success
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call revoke --delegate '$DEV1' > calls/A10.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_OWNER --call "$(node -p 'require("./calls/A10.json").call')" --nonce $((OWNER_NONCE+2)) --out signed/A10.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631

# A11: signed by the dev1 key, account nonce 7, expect success
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call sweep --to '$DEV2' > calls/A11.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_DEV1 --call "$(node -p 'require("./calls/A11.json").call')" --nonce 7 --out signed/A11.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631

# B1: signed by the owner key, account nonce $((OWNER_NONCE+3)), expect success
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call create-session --delegate '$DEV2' --cap 10000000000000000 --per-tx 10000000000000000 --daily 10000000000000000 --blocks 3600 --allow Utility,Proxy,Multisig,Sudo,Scheduler,EmergencyOverride,FlopSessionKeys,System,computechannel > calls/B1.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_OWNER --call "$(node -p 'require("./calls/B1.json").call')" --nonce $((OWNER_NONCE+3)) --out signed/B1.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631

# B2: signed by the dev2 key, account nonce 0, expect FlopSessionKeys.PalletNotAllowed
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call via-session --owner 0xe462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2 --inner denied:Utility --spend 0 --nonce 0 > calls/B2.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_DEV2 --call "$(node -p 'require("./calls/B2.json").call')" --nonce 0 --out signed/B2.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631

# B3: signed by the dev2 key, account nonce 1, expect FlopSessionKeys.PalletNotAllowed
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call via-session --owner 0xe462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2 --inner denied:Proxy --spend 0 --nonce 0 > calls/B3.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_DEV2 --call "$(node -p 'require("./calls/B3.json").call')" --nonce 1 --out signed/B3.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631

# B4: signed by the dev2 key, account nonce 2, expect FlopSessionKeys.PalletNotAllowed
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call via-session --owner 0xe462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2 --inner denied:Multisig:0x1ec8abdfa88707679f8a2fbfc0bcd80184e2f731d91bb9fa152b750210556c7f --spend 0 --nonce 0 > calls/B4.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_DEV2 --call "$(node -p 'require("./calls/B4.json").call')" --nonce 2 --out signed/B4.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631

# B5: signed by the dev2 key, account nonce 3, expect FlopSessionKeys.PalletNotAllowed
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call via-session --owner 0xe462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2 --inner denied:Sudo --spend 0 --nonce 0 > calls/B5.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_DEV2 --call "$(node -p 'require("./calls/B5.json").call')" --nonce 3 --out signed/B5.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631

# B6: signed by the dev2 key, account nonce 4, expect FlopSessionKeys.PalletNotAllowed
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call via-session --owner 0xe462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2 --inner denied:Scheduler --spend 0 --nonce 0 > calls/B6.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_DEV2 --call "$(node -p 'require("./calls/B6.json").call')" --nonce 4 --out signed/B6.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631

# B7: signed by the dev2 key, account nonce 5, expect FlopSessionKeys.PalletNotAllowed
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call via-session --owner 0xe462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2 --inner denied:EmergencyOverride --spend 0 --nonce 0 > calls/B7.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_DEV2 --call "$(node -p 'require("./calls/B7.json").call')" --nonce 5 --out signed/B7.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631

# B8: signed by the dev2 key, account nonce 6, expect FlopSessionKeys.PalletNotAllowed
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call via-session --owner 0xe462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2 --inner denied:FlopSessionKeys:0x1ec8abdfa88707679f8a2fbfc0bcd80184e2f731d91bb9fa152b750210556c7f --spend 0 --nonce 0 > calls/B8.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_DEV2 --call "$(node -p 'require("./calls/B8.json").call')" --nonce 6 --out signed/B8.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631

# B9: signed by the dev2 key, account nonce 7, expect ComputeChannel.ChannelNotFound
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call via-session --owner 0xe462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2 --inner timeout:0x696d642d666c6f702d64656e792d6c6973742d636f6e74726f6c2d323032362e --spend 0 --nonce 0 > calls/B9.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_DEV2 --call "$(node -p 'require("./calls/B9.json").call')" --nonce 7 --out signed/B9.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631

# B10: signed by the dev2 key, account nonce 8, expect success
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call via-session --owner 0xe462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2 --inner 'remark:imd-flop deny list control' --spend 0 --nonce 0 > calls/B10.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_DEV2 --call "$(node -p 'require("./calls/B10.json").call')" --nonce 8 --out signed/B10.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631

# B11: signed by the owner key, account nonce $((OWNER_NONCE+4)), expect success
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call revoke --delegate '$DEV2' > calls/B11.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_OWNER --call "$(node -p 'require("./calls/B11.json").call')" --nonce $((OWNER_NONCE+4)) --out signed/B11.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631

# B12: signed by the dev2 key, account nonce 9, expect success
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call sweep --to 0xe462d014cab1239a123233647052f4e3b572322e982441d6b7a5c1694d8419e2 > calls/B12.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_DEV2 --call "$(node -p 'require("./calls/B12.json").call')" --nonce 9 --out signed/B12.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631
```

## Totals

Printed by `node plan.mjs totals`:

```json
{
 "transactions": 23,
 "by_signer": {
  "owner": 5,
  "dev1": 8,
  "dev2": 10
 },
 "fee_estimate_raw": "134752084785000000",
 "sent_to_devices_raw": "150000000000000000",
 "escrow_locked_raw": "10000000000000000",
 "escrow_locked_for_blocks_at_least": "600",
 "owner_net_cost_estimate_raw": "134752084785000000",
 "owner_before_raw": "24847973306290000000",
 "owner_after_estimate_raw": "24713221221505000000",
 "fee_estimate_flop": "0.134752084785",
 "sent_to_devices_flop": "0.15",
 "escrow_locked_flop": "0.01",
 "owner_before_flop": "24.84797330629",
 "owner_after_estimate_flop": "24.713221221505"
}
```

- 23 transactions: 5 by the owner, 8 by dev1, 10 by dev2.
- Sent out of the owner's account: `sent_to_devices` to dev1 at A1 (`escrow` `steps[0].what`). It
  comes back at B12, less the devices' fees.
- Locked: `escrow_locked` from A6 to A9, at least the ack window of 600 blocks. It comes back in
  full at A9 if 1014020 does as 1014014 did.
- Fee estimate: `fee_estimate`, the sum of the fee each matching transaction paid at spec 1014014
  (`fee_raw` of the step named in `fee_like`). The owner pays all of it in the end, since the
  devices' fees come out of what was sent to them.
- `owner_before` is the owner's balance after the deny list test (`deny`
  `owner_balance.after_raw`); `owner_after_estimate` is that less the fee estimate. The live
  balance is read before A1.

## What the new errors and constants suggest could differ

All of this is a guess from names and doc comments in the 1014020 metadata. Only the run shows it.

- Guess: `force_open` to the named account may now meet a capacity floor. `EscrowBelowCapacityFloor`
  (pallet 103, error 136) says an open the miner did not sign must escrow at least "reserved rate
  x window x `UnconsentedReservationTariff`". The tariff is 41335978835 raw. The named account is
  not a miner and set no reservation rate, so the floor may be nothing. If a default rate applies,
  A6 could be refused. It stops the run with 0.01 FLOP still in the owner's account.
- Guess: the tariff's doc says it is "a minimum capacity payment, not refundable collateral". If
  A6 now pays such a charge on top of the escrow, the owner's `Balances.Transfer` would not be
  0.01, A9 would not return all of it, and `check.mjs` says so. The declared 0.012 leaves 0.002 of
  room for such a charge.
- Guess: `UnconsentedSessionTooLong` (103/135) refuses an unsigned open whose window is above
  `MaxUnconsentedSessionBlocks`, 14400. The SLA here asks 1200 blocks (`escrow`
  `force_open.sla.max_duration`). It should not apply.
- Guess: `MinerCapacityFullyReserved` (103/132) and `TooManyCapacityReservations` (103/133) are
  about a miner's live reservations. The named account has none.
- Guess: `RetiredSessionRecordMissing` (94/17) says expired session records were once removed by a
  cleanup. A revoked record may now be handled differently too; A10's reads show it.
- Guess: `SessionNonceExhausted` (94/16) is about a nonce at its maximum. Nonces here stay below 3.
- Guess: `MaxSessionsPerOwner` is 10 (`facts` `constants.FlopSessionKeys`). The owner holds three
  revoked records already. If revoked records count, five is still under ten.
- Known: the refusals that remain name new indexes. `SpendExceedsDeclared` is now 94/20, not
  94/18. `PalletNotAllowed` (94/7), `PerTxLimitExceeded` (94/5), `DailyCapExceeded` (94/6) and
  `ChannelNotFound` (103/7) kept theirs.

## Files

- `steps.json`: the plan as data.
- `plan.mjs`: prints the commands, the table, the totals and the results form; writes the force_open files.
- `check.mjs`: judges the recorded results. `rerun-lib.mjs` holds its rules.
- `check.test.mjs`: `node --test research/2026-11-12-session-rerun-1014020/check.test.mjs`.
- `build-tables.mjs` and `metadata-v14.mjs`: build `errors-1014020.json` and `facts-1014020.json`
  from the recorded metadata.
- `results.template.json`: the form the lead fills.
