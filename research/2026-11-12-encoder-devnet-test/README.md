# The chain encoder's devnet test (D1 and D2): prepared, not run

Nothing in this folder has been signed with a real key or sent to any network. It is the
preparation of a batch the lead carries out by hand, with real test money, after the independent
review of this work and its fixes. The owner gave devnet test batches to the lead on 2026-11-12;
the owner is told after the batch.

The batch sends at most nine transactions on FLOP Devnet at spec 1014020, and the attempts a
refused cleanup step allows. It settles what the encoder of `imd-flop/src/chain/` (PR 48) has never
shown on chain: a mortal era signed by the lab, a declared spend exactly equal to the escrow, and
the layouts of `open_channel` (D2) and `top_up_escrow`. `plan.md` is the plan for a reader.

## What is here

| File | What |
|---|---|
| `steps.json` | The plan as data. Every value names the committed file and field it comes from, or says it is the plan's own choice and why, or how it is computed. Also the send outcomes, the stop table and the caps rule. |
| `lead-measurements-2026-11-13.json` | The lead's measurements of 2026-11-13, reads only: block time, relay hops, sizes, the explorer's answer, the channel id formula. |
| `plan.md` | The plan for a reader. Its tables and command lines are printed from `steps.json` by `plan.mjs`. |
| `plan.mjs` | Prints the tables, the reader's list of command lines, the results form, the sha256 of the pasted files, and `next`: what the lead does next by the record. |
| `lib.mjs` | Reads `steps.json` and the files it names, resolves each `$NAME`; the channel id, SS58 and the session nonce key in our own lines. |
| `record.mjs` | Reads a record of either kind the same way for every tool. |
| `device-key.mjs` | The one loader of the device's key file. |
| `sign-device.mjs` | Signs one device step (T3 to T7, or an attempt) through `signSessionCall` of `imd-flop/dist/chain/`, and nothing else. |
| `record-step.mjs` | Writes the run time record from the texts the lead relays, each with its sha256. |
| `pane-runner.js` | Pasted into a tab on the node's own origin: reads, submits once, watches, finds, returns short texts to relay. |
| `explorer-reader.js` | Pasted into a tab on the explorer's own origin: reads one extrinsic's outcome and events. |
| `results.template.json` | The empty record, as `node plan.mjs template` prints it. |
| `judge.mjs`, `check.mjs` | Judge a record against `steps.json`: a run time record by order and outcomes, a final record whole. |
| `fixtures.mjs`, `*.test.mjs` | The offline tests and their fixtures. |
| `review-*` | The reviewer's tests and mutants, and `REVIEW-PROGRESS.md`. |
| `PROGRESS.md` | The builder's notes, for a successor. |

## How the lead runs it

Once, on the PC: build the encoder (`cd imd-flop && npm ci && npm run build`), make the device key
with `node flop-sign.mjs keygen --out <file>`, pick a run folder `RUN`, and set `LAB`, `KEY_OWNER`,
`KEY_DEVICE` and `FLOP_SIGN_LIBS`.

In the pane: `pane-runner.js` is pasted into a tab on the node's own origin,
`https://rpc.devnet.flop.network/`, and `explorer-reader.js` into a tab on the explorer's own
origin, `https://explorer.devnet.flop.network/`. Each pasted file is checked by its sha256 in the
pane before use. `node plan.mjs sha256s` prints both, and the reader's list prints them too:

```
# the node's tab, https://rpc.devnet.flop.network/: put the text of pane-runner.js in window.__src, check its sha256 there, then run it and make the runner
#   sha256 of pane-runner.js: 1708fd18d6a7dfbabe3aef835e41880e030b2478b8f398f47559c35c656a51ec
#   [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(window.__src)))].map((b) => b.toString(16).padStart(2, "0")).join("")
#   (0, eval)(window.__src); const lab = paneRunner.createRunner()
# the explorer's tab, https://explorer.devnet.flop.network/: the same with explorer-reader.js
#   sha256 of explorer-reader.js: ea4b8aab39fc180d070ac2dc2f8c5e37de2931f71ca372434c66c64da863d5af
#   (0, eval)(window.__src); const explorer = explorerReader.createReader()
```

Then `lab.accountReads("<the owner's SS58 address>")` in the node's tab, and on the PC
`node record-step.mjs start --run "$RUN" --key "$KEY_DEVICE" --reads '<relay>' --reads-sha256 <sha>`.
From there `node plan.mjs next --run "$RUN"` prints only what the lead does next, with every value
filled from the record: the next step's lines, or the wait, or the stop row and the cleanup steps
that apply. The lead runs those lines and asks again.

A pane call ends after 45 s, and a watch may take up to the runner's deadline of 120 s. So the pane
lines keep the promise on `window` and read it in a second call: `window.__s = lab.send(...)`, then
`await window.__s`.

A device step, T3, from the reader's list:

```
# T3: device signs with the encoder; expect success
#  mortal, 64 blocks: read, sign and send it within a minute
#  pane, tab on the node (https://rpc.devnet.flop.network/):
window.__r = lab.deviceReads("$DEVICE_SS58", "<session_nonce of flop-sign.mjs keys --owner $OWNER --delegate $DEVICE>")
await window.__r   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/sign-device.mjs" T3 --run "$RUN" --key "$KEY_DEVICE" --reads '<relay>' --reads-sha256 <relay_sha256>
#  pane, tab on the node (https://rpc.devnet.flop.network/):
window.__s = lab.send('<the second line sign-device printed: the text of signed/T3.send.json>', "<its send_sha256>")
await window.__s   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" step T3 --run "$RUN" --sent '<relay>' --sent-sha256 <relay_sha256>
#  pane, tab on the explorer (https://explorer.devnet.flop.network/):
window.__e = explorer.read("<extrinsic_hash of signed/T3.json>")
await window.__e   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" step T3 --run "$RUN" --explorer '<relay>' --explorer-sha256 <relay_sha256>
```

An owner step, T2:

```
# T2: owner signs with the research-signer; expect success
#  immortal: never signed to different bytes
#  PC:
mkdir -p "$RUN/calls" "$RUN/signed"
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" call create-session --delegate $DEVICE --cap 50000000000000000 --per-tx 20000000000000000 --daily 25000000000000000 --blocks 7200 --allow ComputeChannel > "$RUN/calls/T2.json"
node "$LAB/research/2026-11-11-session-deny-list/flop-sign.mjs" sign --key "$KEY_OWNER" --call "$(node -p 'require(process.argv[1]).call' "$RUN/calls/T2.json")" --nonce $((OWNER_NONCE+1)) --out "$RUN/signed/T2.json" --spec 1014020 --txv 2 --genesis 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" send-file T2 --run "$RUN"
#  pane, tab on the node (https://rpc.devnet.flop.network/):
window.__s = lab.send('<the second line send-file printed: the text of signed/T2.send.json>', "<its send_sha256>")
await window.__s   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" step T2 --run "$RUN" --sent '<relay>' --sent-sha256 <relay_sha256>
#  pane, tab on the explorer (https://explorer.devnet.flop.network/):
window.__e = explorer.read("<extrinsic_hash of signed/T2.json>")
await window.__e   (its relay and relay_sha256)
#  PC:
node "$LAB/research/2026-11-12-encoder-devnet-test/record-step.mjs" step T2 --run "$RUN" --explorer '<relay>' --explorer-sha256 <relay_sha256>
```

The device step is mortal: it lives about a minute from the read of its birth block
(`lead-measurements-2026-11-13.json` `measurements.mortal_life_blocks`). If it is not in a
finalized block, the send outcomes table of `plan.md` says what is known, what the lead does, and
when a second copy may be signed: only by `sign-device.mjs --again` (S4), never two live copies,
because the device's next nonce counts the pool. An owner step is immortal and never signed to
different bytes: `lab.find`, then `lab.sendSame`.

## The record at run time

`results.json` in the run folder is a run time record (`record: "run-time"`). For each step it
holds what the runner relayed (the block's hash and number, the extrinsic's index, the sha256 and
length of the block's `System.Events`) and what the explorer relayed (its source and `read_utc`,
the outcome, the error named by the 1014020 table, the events of `ComputeChannel` and
`FlopSessionKeys` in the record's form). Nothing in it is called verified, and no balance is in it.
`node check.mjs "$RUN/results.json"` says go on, wait or stop at a step; it never says passed.

## Not done here: the final record

The final record is not made in this folder and nothing here promises it. It needs a new
observatory request list for the batch's blocks, its recording, a fill helper beside
`observatory/test/helpers/rerun-fill.ts`, and `System.Account` read by position and marked so, or a
new reviewed shape (the reviewed shape in `observatory/src/scale/shape.ts` does not state
`System.Account`). That is a later piece of work with its own brief. `check.mjs` judges a final
record when one exists: it requires `record: "final"` and `balances_source` (`decoder` or
`by position`) and prints the verdict with it.

## What is not known

- Whether `expire_force_open` refunds a top up. If it does not, the top up stays in the pallet
  account under the channel of T3, and no step of this batch brings it back.
- Whether T5's `opened_at` is T5's block, as T7's earliest block assumes.
- The fees of T4 and T5: no like step was ever sent.
- The channel id formula is shown for `force_open` only. T5 shows it for `open_channel` or refutes it.
- What the chain answers to T4 and T5, and whether `top_up_escrow` is taken on a channel waiting
  for an ack.
- Whether an epoch boundary of the session falls inside the batch. So `epoch_spent` and the
  breaker's `tx_count` are recorded and not judged.
- The shapes of the node's transaction statuses: from the lead's and the reviewer's knowledge of
  Substrate, not from a committed file.
- The encoder's table holds only spec 1014020. If the devnet upgrades first, `sign-device.mjs`
  refuses with `RUNTIME_UNKNOWN`, and the batch waits for a new table and its review.

## Tests

`node --test` in this folder (Node 22). No network, no key file of the lab: the test keys are made
inside the tests in temporary folders. `sign-device.mjs` and its tests need `imd-flop/dist/chain/`:
run `npm ci && npm run build` in `imd-flop/` first. `.github/workflows/research-offline.yml` runs
them on GitHub. `node mutants.mjs` runs the mutants of `mutants.json`: the reviewer's R-M1 to
R-M18, adapted to this code (the reviewer's own `review-mutants.json` names finds of `fcfb8b5`), and
the fix round's own. Each is killed or listed as equivalent with its reason.
