# Interfaces between the two teams

Shared contracts in uxp-labs/flop-devnet-lab. The Claude team (FLOP Observatory) produces these.
The Grok team (imd-flop, Seat Court) may import them. Change a schema only after a handoff note.

Status: v0, M0. Everything is computed from saved fixtures. No live chain read exists yet, so every
result today has `trust: "fixture"`. Do not use a fixture result to decide a real spend or release.

| File | Produced by | For |
|---|---|---|
| escrow-state.v0.schema.json | `escrowState(escrowId, pages, opts)` in observatory/src/escrow.ts | Seat Court M2 release and refund checks |
| network-status.v0.schema.json | `networkStatus()` in the observatory status module (owned by the lead) | imd-flop live-run gate, Seat Court deadline checks |

Both are JSON Schema 2020-12 and mirror `EscrowState` and `NetworkStatus` in observatory/src/types.ts.

## Rules that apply to both

- Unknown is `null`. It is never `ok`, never `0`. Do not default a `null` to a good value.
- `trust` says where the data came from. `"trusted RPC"` means one node was trusted. It is not a light
  client and not a proof. `"fixture"` means saved test data.
- `observed_at` is when the data was read. Decide for yourself how old is too old, and check it.
- `notes` and `conflicts` are for people. Do not parse them. Branch on `state`, `reset_detected` and
  the typed fields only.

## EscrowState

What it answers: what do finalized hasStation events on the pinned genesis say about one escrow?

| Field | Meaning |
|---|---|
| `schema` | Always `flop-observatory/escrow-state@0`. |
| `escrow_id` | The id asked about, lower-case. If the id was not 0x plus 64 hex it is echoed as given and the state is `unverified`. |
| `state` | `funded`: a finalized `EscrowOpened` and no finalized terminal event. `claimed`: a finalized `EscrowReleased`. `refunded`: a finalized `EscrowRefunded`. `unverified`: anything else, including missing, conflicting or malformed evidence. |
| `evidence` | The finalized events behind the state: event name, block hash, block number (may be `null`), event index, genesis. Empty when `unverified`. |
| `notes` | Why: events ignored (not finalized, other genesis, malformed, duplicate) and conflicts. |
| `finalized_height` | Finalized height the events were read at, or `null`. |
| `observed_at`, `trust` | As above. |
| `scope` | Always `settlement only; says nothing about output quality`. |

How Seat Court should use it:

- Treat `unverified` as "do not act". It is not "refunded" and not "not funded".
- Before jurors release shares, require `state: "funded"`, `trust: "trusted RPC"`, a fresh
  `observed_at`, and `networkStatus().reset_detected === false`.
- After a case, record `claimed` or `refunded` together with the `evidence` array, so anyone can look
  the events up.
- `state` is never proof of output quality. A `claimed` escrow only means the payee was paid. Whether
  the work was good is the panel's verdict, and the two must be shown as separate facts.
- Gateway receipts are not an input. A gateway "settled" field cannot change `state`. Keep imd-flop
  receipts labeled "gateway observed".
- Do not call a result "verified" or "chain final" on the strength of a `"fixture"` result.

Known limits (v0):

- The escrow id is read from event data position 0 (`data["0"]`), or `data["escrow_id"]`. This is
  confirmed for `EscrowOpened` (tclk/flop/src/chain.ts) and assumed for the other two until M1.
- An event with an unparsable escrow id cannot be tied to any escrow. If it is a finalized release or
  refund on the pinned genesis, escrows it could contradict are reported `unverified`. This is strict
  on purpose.
- One chain event is never evidence for two escrows. If copies of one event (same genesis, block
  hash and index) disagree on section, method, escrow id or block number, every escrow they name
  is `unverified`.
- If any copy of an event is not finalized, the event is pending and is not evidence.
- If any event page could not be read, or is structurally invalid, every escrow in that result is
  `unverified`. The missing page could hold a conflicting event.
- Amount, payee and policy are not checked here. FlopRail's `verifyLock` does that. Use both.

## NetworkStatus

What it answers: is this still the chain we pinned, how far is finality, and are the services up?

| Field | Meaning |
|---|---|
| `schema` | Always `flop-observatory/network-status@0`. |
| `genesis.pinned`, `.faucet`, `.rpc` | The pinned genesis and what each source reported. `null` means unread. |
| `reset_detected` | `true`: some source reports another genesis. `false`: faucet and RPC both report the pinned one. `null`: not enough evidence. |
| `conflicts` | Disagreements between sources, in words. |
| `finalized_height`, `finalized_hash`, `best_height`, `finality_lag` | Chain head as read. `null` when unknown. |
| `runtime_version` | Runtime spec version, or `null`. |
| `rpc`, `gateway`, `faucet` | `health` (`ok`, `degraded`, `down`, `unknown`), HTTP status, a short reason, when it was read. `rpc.stale`, `faucet.ready` and `faucet.limits` may be `null`. |

How imd-flop and Seat Court should use it:

- Before any spend, signature or escrow action: continue only when `reset_detected === false`.
  Treat `null` exactly like `true`. After a reset, every seat link and escrow reference from the old
  genesis is dead.
- `health: "unknown"` is not `ok`. A `null` `finality_lag` is not zero lag.
- Seat Court: do not act on a deadline when `finalized_height` is `null` or `rpc.stale` is not `false`.
- The faucet fields come from `GET /health` and `GET /chain` only. The observatory never calls the
  funding endpoint.

## Versioning

- v0 may change. A breaking change gets a new file (`*.v1.schema.json`) and a handoff note first.
- The Observatory reads imd-flop's ledger and Seat Court's verdict record unchanged. Tell the Claude
  team before changing those formats.
