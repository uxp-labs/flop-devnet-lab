# Which pallets can a session never call? A devnet test

On 2026-11-11 we sent thirteen transactions on FLOP Devnet to check one thing on chain: the list of
pallets a `FlopSessionKeys` session can never reach. The chain's metadata says such a list exists
(`DENIED_PALLETS`) and does not print it. A swarm report read it out of the runtime code
(`../2026-11-11-session-runtime/`). That was a lead. This is the reading.

## The answer

The seven pallets the report named are refused, also when the session's own allow list names them:

`Utility`, `Proxy`, `Multisig`, `Sudo`, `Scheduler`, `EmergencyOverride`, `FlopSessionKeys`.

The owner gave a device key a session whose allow list held those seven names, plus `System` and
`computechannel` written in lower case. `create_session` accepted the list as given. Through that
session the device sent one call of each pallet:

| The device called | On the allow list as | What the chain did |
|---|---|---|
| `Utility.batch` | `Utility` | failed with `FlopSessionKeys.PalletNotAllowed` |
| `Proxy.remove_proxies` | `Proxy` | failed with `FlopSessionKeys.PalletNotAllowed` |
| `Multisig.cancel_as_multi` | `Multisig` | failed with `FlopSessionKeys.PalletNotAllowed` |
| `Sudo.remove_key` | `Sudo` | failed with `FlopSessionKeys.PalletNotAllowed` |
| `Scheduler.cancel` | `Scheduler` | failed with `FlopSessionKeys.PalletNotAllowed` |
| `EmergencyOverride.queue_override` | `EmergencyOverride` | failed with `FlopSessionKeys.PalletNotAllowed` |
| `FlopSessionKeys.revoke_session` | `FlopSessionKeys` | failed with `FlopSessionKeys.PalletNotAllowed` |
| `ComputeChannel.timeout` on a channel that does not exist | `computechannel` | passed the session and failed in the pallet with `ComputeChannel.ChannelNotFound` |
| `System.remark` | `System` | success |

So:

- A session cannot wrap a call in a batch, a proxy, a multisig, a scheduled task or another session
  call, and it cannot reach `Sudo` or `EmergencyOverride`. Putting those names on the allow list
  changes nothing. The whole extrinsic is refused.
- The refusal is the same error as for a pallet that is simply not on the allow list
  (`PalletNotAllowed`). A caller cannot tell the two apart from the error.
- `create_session` does not refuse an allow list that names a denied pallet. The names are stored
  and have no effect.
- The allow list does not care about case: the entry `computechannel` let a `ComputeChannel` call
  through to the pallet.
- A refused call leaves the session's nonce where it was. The nonce moved from 0 to 1 only at the one
  call that succeeded.
- The device pays the fee for a refused call too (0.0042 to 0.0059 FLOP each here).

## Nothing could go wrong

Each call was chosen so that it would change nothing even if the chain had let it through:

| Call | Why it is harmless |
|---|---|
| `Utility.batch` with no calls in it | an empty batch does nothing |
| `Proxy.remove_proxies` | the owner has no proxies |
| `Multisig.cancel_as_multi` | for a multisig operation that does not exist |
| `Sudo.remove_key` | only the sudo key may call it |
| `Scheduler.cancel` of task (1, 0) | root only |
| `EmergencyOverride.queue_override` with an empty call and an empty reason | root only, and an empty call cannot decode |
| `FlopSessionKeys.revoke_session` | of a delegate whose session was already revoked |

`flop-sign.mjs` signs exactly these and refuses any other call of those pallets. It never signs
`EmergencyOverride.execute_override`, which the chain lets anyone call once a queued override's
timelock has passed.

The session's caps were 0.01 FLOP, every call declared a spend of 0, and nothing left the owner's
account but fees.

## What it does not show

- That these seven are the whole list. A pallet we did not try could be denied too.
- That `Balances` is not denied. The swarm report says it is not, and that with an empty allow list
  a session can move the owner's funds up to its caps. We did not try it. A session for real use
  should always carry an allow list, with `ComputeChannel` alone.
- What an empty allow list permits.
- Anything about the hosted gateway.

## What was sent

Owner: the lab's FLOP identity, `5HEA8QECFwBg1F9cxoXzvQzryu2d5qj5zASJS7owNW2zebBz`.
Device: a key made for this test, `5Fq51jK1yw2VzfeWjAjo1RCsDeCALYVX81n72oGtxTj8Nkd5`.
Chain: genesis `0x99c172c0…2d631`, spec 1014014, metadata sha256 `f4fd2add…3444`.
Since then the devnet has moved to spec 1014020 (2026-11-12, see `../2026-11-12-runtime-upgrade/`).
What is measured here is for spec 1014014 until it is run again.

| # | Signed by | Call | Finalized in block | Result |
|---|---|---|---|---|
| 1 | owner | `Balances.transfer_keep_alive`: 0.15 FLOP to the device, for its fees | 3513176 | success |
| 2 | owner | `FlopSessionKeys.create_session`: caps of 0.01 FLOP, 3600 blocks, allowed `Utility`, `Proxy`, `Multisig`, `Sudo`, `Scheduler`, `EmergencyOverride`, `FlopSessionKeys`, `System`, `computechannel` | 3513199 | success |
| 3 | device | `execute_via_session` running `Utility.batch` of no calls | 3513325 | failed with `PalletNotAllowed` |
| 4 | device | running `Proxy.remove_proxies` | 3513347 | failed with `PalletNotAllowed` |
| 5 | device | running `Multisig.cancel_as_multi` | 3513370 | failed with `PalletNotAllowed` |
| 6 | device | running `Sudo.remove_key` | 3513389 | failed with `PalletNotAllowed` |
| 7 | device | running `Scheduler.cancel` | 3513408 | failed with `PalletNotAllowed` |
| 8 | device | running `EmergencyOverride.queue_override` | 3513427 | failed with `PalletNotAllowed` |
| 9 | device | running `FlopSessionKeys.revoke_session` | 3513446 | failed with `PalletNotAllowed` |
| 10 | device | running `ComputeChannel.timeout` on a made up channel | 3513466 | failed with `ComputeChannel.ChannelNotFound` |
| 11 | device | running `System.remark` | 3513488 | success, `SessionCallExecuted` |
| 12 | owner | `FlopSessionKeys.revoke_session` | 3513523 | success |
| 13 | device | `Balances.transfer_all` back to the owner | 3513543 | success |

`results.json` has every block hash, extrinsic hash, call and fee, and the sha256 of each events
value as we read it. The cost was 0.06335181249 devnet FLOP in fees, which is exactly the fall of
the owner's balance from 24.91132511878 to 24.84797330629 FLOP. The device account is empty and
gone from chain state. The revoked session record and the device's circuit breaker record stay on
chain.

## How it was done

- `flop-sign.mjs` here is version 3 of the signer of the two earlier tests. It adds the seven fixed
  calls above as things a session may carry, and nothing else. It still talks to no network, signs
  only the shapes it lists, and prints in plain words what it signs. The keys stayed in files on
  the operator's computer and were never printed.
- `check.mjs` compared every new call with the polkadot-api reference encoder on the metadata we
  recorded ourselves, before any key was used. All were byte for byte the same, and each refusal
  was seen (a batch that holds a call, `Sudo.sudo`, `execute_override`, any of these outside a
  session).
- Each signed extrinsic was first checked by the node with
  `TaggedTransactionQueue_validate_transaction`, then sent with `author_submitAndWatchExtrinsic`,
  and read back from `System.Events` at the block that finalized it.
- Events were decoded with the polkadot-api reference decoder and the same metadata.
- The extrinsics use an immortal era. That is acceptable for a throwaway test on a devnet. A tool
  for real use signs with a mortal era.

To check it yourself: read `System.Events` at the thirteen block hashes in `results.json` from an
archive node and decode them with the metadata of spec 1014014.

## What it means for this repo

- The session design holds up one step further. A device key with a session cannot escape the
  session's limits by wrapping its call: every wrapper the runtime has is on the deny list.
- The provider we build declares one pallet on the allow list, `ComputeChannel`, spelled as the
  metadata spells it. The chain would take another spelling, and we do not rely on that.
- A tool that shows a seat's session should not present a denied name on an allow list as a
  permission. The chain stores it and ignores it.
- Open, and asked of FLOP Labs in `flop-labs/network` issue 231: whether the list is published
  anywhere, and whether these seven are all of it.

Rerun at spec 1014020 on 2026-11-12: `../2026-11-12-session-rerun-1014020/README.md` says which of these claims hold there.
