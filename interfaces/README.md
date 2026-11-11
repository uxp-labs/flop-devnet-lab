# Interfaces between the tools

Shared contracts in uxp-labs/flop-devnet-lab. FLOP Observatory produces these. imd-flop and Seat
Court may import them. A schema change is its own commit, with the consumers changed in the same
pull request.

Status: v0. The observatory's live command reads `networkStatus()` from FLOP devnet, read only, with
`trust: "trusted RPC"` (observatory/README.md, Live network status). Every escrow state is still
computed from saved fixtures, so it has `trust: "fixture"`. Do not use a fixture result to decide a
real spend or release.

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
  hash and index) disagree on section, method, escrow id, block number or account, every escrow
  they name is `unverified`.
- If any copy of an event is not finalized, the event is pending and is not evidence.
- If any event page could not be read, or is structurally invalid, every escrow in that result is
  `unverified`. The missing page could hold a conflicting event.
- Genesis and block hashes are compared exactly as written and must be lower case hex. A page whose
  genesis is spelled differently is another genesis. Escrow ids are matched without regard to case.
- An event whose block number is outside its page's block range is never evidence, and it is
  suspect: a finalized release or refund out of range that names an escrow leaves it `unverified`.
- When `finalized_height` is `null` and there is evidence, a note says the evidence is not bounded
  by a finalized height. Treat such a result as weaker. Do not act on it for a real spend.
- Integers beyond 2^53 - 1 are not trusted: such an event is malformed and such a page is invalid.
- Two distinct finalized opens for one escrow are conflicting evidence, whatever else exists.
- A finalized release or refund above the finalized height is not evidence yet, and it leaves the
  escrow it names `unverified`.
- A page file that is not strict UTF-8 JSON, a page whose block range starts below 0, and an
  `event-pages` that is not a real folder, or cannot be read or listed, each leave every escrow
  `unverified`.
- So do a page file name that is not UTF-8, a key repeated in one JSON object, JSON nested deeper
  than 64 levels, and a broken page chain on the pinned genesis (census clause 2). An event on a
  page that the walk from page 0 never reaches is not evidence.
- An event with no `block_number` key is malformed. One whose `block_number` is `null` is kept,
  with a note that the finalized height cannot bound it.
- A malformed finalized release or refund that could be about an escrow leaves it `unverified`,
  whatever state the clean evidence would give: it could be a second release or refund.
- `finalized_height` bounds the evidence only when it comes from a usable RPC head on the pinned
  genesis (no read error, fresh, not later than the snapshot, and not contradicting itself or an
  earlier snapshot: no rollback, no changed finalized hash, best height not below finalized, nor
  more than the lag limit below a best height an earlier snapshot saw). Otherwise it is `null`.
  A height handed to `escrowState` that is not a whole number from 0 bounds nothing and reads as
  `null` too.
- The same escrow id listed twice (in either case) is refused by the command line, never shown as
  two results, and so is an escrow id that is not 0x plus 64 hex, which the MCP server could not
  look up. The MCP server checks every field of the snapshot, its pin, the status and every
  escrow for its type (the census and the drift report for their schema only) and the agreements
  observatory/RULES.md section 5 lists, but its hash is no signature: serve only a snapshot the
  snapshot command wrote.
- Amount, payee and policy are not checked here. FlopRail's `verifyLock` does that. Use both.

## NetworkStatus

What it answers: is this still the chain we pinned, how far is finality, and are the services up?

| Field | Meaning |
|---|---|
| `schema` | Always `flop-observatory/network-status@0`. |
| `genesis.pinned`, `.faucet`, `.rpc` | The pinned genesis and what each source reported. `null` means unread. |
| `reset_detected` | `true`: a usable reading reports another genesis. `false`: a usable faucet `/chain` reading and a usable RPC head both report the pinned one. `null`: not enough evidence. A reading with an error (or no error field), a stale one, one later than the snapshot, an RPC head with no valid finalized head or best height, or one that contradicts itself or an earlier snapshot counts for neither. An RPC head whose finalized height is stuck, or whose stuck check cannot run, never counts toward `false`. |
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

Known limits (v0):

- A genesis must be `0x` plus 64 lower case hex. Any other spelling, upper case included, reads as
  `null`, so it never makes `reset_detected` `false`.
- A reading whose `error` holds any value but `null`, an empty string included, is never `ok`, and
  neither is a reading with no `error` field at all.
- `genesis.faucet` and `genesis.rpc` show what each reading said, even when that reading does not
  count. Only `reset_detected` says whether it counted. When the faucet `/chain` reading does not
  count, the faucet `detail` says why, and a reading that names another genesis is a conflict. A
  usable `/chain` reading that names no genesis leaves `reset_detected` `null`, and the `detail`
  says that too.
- An RPC head whose best height is below a finalized height an earlier snapshot saw on the same
  genesis is a conflict, even with no finalized head of its own: that is what a chain restarted
  from the same spec looks like. So is a best height more than the lag limit (30 blocks) below a
  best height an earlier snapshot saw on the same genesis, with or without a finalized head. After
  a finality stall, a long fork that falls away reads the same way, since a restart looks the
  same: `reset_detected` stays `null` until the best height is back within the limit.
- Those checks against earlier snapshots run in the snapshot command, which reads its log. The
  `status` command reads no log, and neither does the live command, which keeps nothing between
  runs: their `reset_detected` speaks for that one reading only, so a gate should read the status
  the snapshot command writes.
- A field of the wrong type (a number for `observed_at`, a string for `http`, a nested object in
  `limits`) reads as `null`, and so does a field an RPC head leaves out.
- A saved reading that cannot be read (not strict UTF-8 JSON, a key twice in one object, nested
  deeper than 64 levels, or not a regular file) counts as nothing read: that service is `unknown`, and its `detail` names
  the file and why.
- Times are compared to the millisecond. A reading less than 1 ms after the snapshot time is not
  "later".
- The census also has a field named `reset_detected`. It speaks of its event pages only and is not
  this value. Branch on this one.

## Versioning

- v0 may change. A breaking change gets a new file (`*.v1.schema.json`).
- The Observatory reads imd-flop's ledger and Seat Court's verdict record unchanged. A change to
  those formats changes the Observatory's reader in the same pull request.
