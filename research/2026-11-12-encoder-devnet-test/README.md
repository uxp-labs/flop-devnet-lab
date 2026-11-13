# The chain encoder's devnet test (D1 and D2): prepared, not run

Nothing in this folder has been signed with a real key or sent to any network. It is the
preparation of a batch the lead carries out on the PC, after an independent review and the owner's
yes.

The batch sends at most nine transactions on FLOP Devnet at spec 1014020. It settles what the
encoder of `imd-flop/src/chain/` (PR 48) has never shown on chain: a mortal era signed by the lab, a
declared spend exactly equal to the escrow, and the layouts of `open_channel` (D2) and
`top_up_escrow`. Its balance reads show whether an open moves anything beyond the escrow out of the
owner's account. `plan.md` is the plan for a reader.

## What is here

| File | What |
|---|---|
| `steps.json` | The plan as data. Every value names the committed file and field it comes from, or says it is the plan's own choice and why. |
| `plan.md` | The plan for a reader. Its tables and command lines are printed from `steps.json` by `plan.mjs`. |
| `plan.mjs` | Prints the steps table, the cost tables, the stop table, the command lines and the results form. |
| `lib.mjs` | Reads `steps.json` and the files it names, resolves each `$NAME`. |
| `sign-device.mjs` | Signs one device step (T3 to T7) through `signSessionCall` of `imd-flop/dist/chain/`, and nothing else. |
| `pane-runner.js` | One file to paste into the browser pane: reads, submits once, waits for finality, returns raw values. |
| `results.template.json` | The empty record, as `node plan.mjs template` prints it. |
| `judge.mjs`, `check.mjs` | Judge a filled `results.json` against `steps.json`, with the rerun's library. |
| `*.test.mjs` | The offline tests. |
| `PROGRESS.md` | The builder's notes, for a successor. |

## The steps

- T1 and T2, the owner, with the research signer `../2026-11-11-session-deny-list/flop-sign.mjs`:
  fund the device, then create its session with the rerun's session A caps.
- T3 to T7, the device, with the encoder through `sign-device.mjs`: `force_open` declaring exactly
  its escrow, `top_up_escrow`, `open_channel`, then `expire_force_open` and `timeout` to bring the
  escrows back.
- T8, the owner, revokes the session. T9, the device, sweeps what it holds back to the owner. Both
  with the research signer, immortal.
- T4 and T5 are recorded, not expected. Each passes when it is included in a finalized block and
  its outcome is success or an error of `ComputeChannel` or `FlopSessionKeys` the 1014020 table names.
- The stop rule is in `plan.md`. After a stop the cleanup steps that apply still run.

## How the lead runs it, one step at a time

Once, on the PC: build the encoder (`cd imd-flop && npm ci && npm run build`), make the device key
with `node flop-sign.mjs keygen --out <file>`, and set `LAB`, `KEY_OWNER`, `KEY_DEVICE` and
`FLOP_SIGN_LIBS`. In the browser pane, paste `pane-runner.js` and make the runner with the line
`node plan.mjs commands` prints, so the endpoint and the events key come from `steps.json`. Read the
"before" state into `results.json`. Then for each step, in order, the lines of
`node plan.mjs commands --results results.json`.

A device step, T3:

```
# in the pane, moments before (the session nonce key is flop-sign.mjs keys --owner $OWNER --delegate $DEVICE, field session_nonce):
copy(JSON.stringify(await lab.deviceReads("<device ss58>", "<session_nonce key>")))
# on the PC; if session_nonce_raw is null (the node holds none), put "session_nonce": "0" in its place, as the plan expects before T3:
node "$LAB/research/2026-11-12-encoder-devnet-test/sign-device.mjs" T3 --key $KEY_DEVICE --results results.json --reads '<what deviceReads printed>'
# in the pane, before the last valid block it printed:
await lab.send(`<text of signed/T3.json>`, "<the sha256 it printed>")
```

An owner step, T2:

```
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call create-session --delegate $DEVICE --cap 50000000000000000 --per-tx 20000000000000000 --daily 25000000000000000 --blocks 7200 --allow ComputeChannel > calls/T2.json
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key $KEY_OWNER --call "$(node -p 'require("./calls/T2.json").call')" --nonce $((OWNER_NONCE+1)) --out signed/T2.json --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631
sha256sum signed/T2.json
# in the pane:
await lab.send(`<text of signed/T2.json>`, "<its sha256>")
```

After each step: the reads of the five keys at the block `send` returned (`lab.read(keys, block_hash)`),
written into that step's `after` and `raw_reads`, then `node check.mjs results.json`.

## How the record is made

The rerun's way, in one paragraph. At run time the lead kept each step's signer, nonce, call,
extrinsic hash, block number and hash, extrinsic index and the sha256 of the block's
`System.Events` bytes. The observatory's fourth request list then read every one of those blocks:
the hash at its height and one `state_queryStorageAt` at that hash for `System.Events`,
`System.LastRuntimeUpgrade` and the stored values the step names
(`observatory/fixtures/recording-20261112132634-0a472f1b49f7b661`). Then
`observatory/scripts/fill-rerun-results.mjs`, through `observatory/test/helpers/rerun-fill.ts`,
decoded the events, the outcome, the fee and the reads from that recording through the decoder's one
door, `observatory/src/scale/block.ts`, into the rerun's `results.json` (commit `7fb426a`, PR 43).

For this test the lead runs the same path: a new request list for this batch's blocks, its public
recording, and a fill helper for this folder's results form beside `rerun-fill.ts`. That is
observatory work, not in this folder. One part of it does not fit the door as it stands: the
reviewed shape (`observatory/src/scale/shape.ts`) states `Sessions`, `SessionNonces`,
`CircuitBreakers` and `Channels`, not `System.Account`. So the balances the check compares cannot be
decoded through the door yet. Either the shape gains `System.Account` with a new version and its
review, or the lead reads the balances by position as the rerun did for `owner_free_balance_raw`,
and says so in the record.

## What is not known

- What the chain answers to T4 and T5. Their fees: no like step was ever sent.
- Whether `top_up_escrow` is taken on a channel waiting for an ack. Its doc comment speaks of a live
  session, so a refusal such as `BadState` would not surprise.
- Whether `open_channel` checks anything `force_open` did not, such as the measured root against
  the registry ("verified against the registry now", its doc comment).
- Whether `opened_at` of T5's channel is T5's block, as T7's earliest block assumes.
- Whether an epoch boundary of the session falls inside the batch. So `epoch_spent` and the
  breaker's `tx_count` are recorded and not judged.
- The encoder's table holds only spec 1014020. If the devnet upgrades first, `sign-device.mjs`
  refuses with `RUNTIME_UNKNOWN`, and the batch waits for a new table and its review.

## Tests

`node --test` in this folder (Node 22). No network, no key file of the lab: the test key is made
inside the test in a temporary folder. `sign-device.mjs` and its tests need `imd-flop/dist/chain/`:
run `npm ci && npm run build` in `imd-flop/` first.
