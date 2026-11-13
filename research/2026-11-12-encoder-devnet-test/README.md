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
| `record-step.mjs` | Writes the run time record from the texts the lead relays, each with its sha256; writes the send file of a research signer step; records the lead's stop. |
| `research-signed.mjs` | The check of a research signer step's signed file: its extrinsic's bytes must be the plan's step. |
| `lead-stop.mjs` | The lead's stop at a step that will not come on chain, and when it is allowed. |
| `pane-runner.js` | Pasted into a tab on the node's own origin: reads, submits once, watches, finds, returns short texts to relay. |
| `explorer-reader.js` | Pasted into a tab on the explorer's own origin: reads one extrinsic's outcome and events. |
| `results.template.json` | The empty record, as `node plan.mjs template` prints it. |
| `judge.mjs`, `check.mjs` | Judge a record against `steps.json`: a run time record by order and outcomes, a final record whole. |
| `fixtures.mjs`, `*.test.mjs` | The offline tests and their fixtures. |
| `review-*`, `review2-*` | The two reviewers' tests and mutants, and `REVIEW-PROGRESS.md`, `REVIEW2-PROGRESS.md`. |
| `PROGRESS.md` | The builder's notes, for a successor. |

## How the lead runs it

Once, on the PC: build the encoder (`cd observatory && npm ci && npm run build`, then `cd ../imd-flop && npm ci && npm run build`), make the device key
with `node flop-sign.mjs keygen --out <file>`, pick a run folder `RUN`, and set `LAB`, `KEY_OWNER`,
`KEY_DEVICE` and `FLOP_SIGN_LIBS`.

In the pane: `pane-runner.js` is pasted into a tab on the node's own origin,
`https://rpc.devnet.flop.network/`, and `explorer-reader.js` into a tab on the explorer's own
origin, `https://explorer.devnet.flop.network/`. Each pasted file is checked by its sha256 in the
pane before use. `node plan.mjs sha256s` prints both, and the reader's list prints them too:

```
# the node's tab, https://rpc.devnet.flop.network/: put the text of pane-runner.js in window.__src, check its sha256 there, then run it and make the runner
#   sha256 of pane-runner.js: f034f6edc5d3a81218b67c3545bc5ba43d363ffd0fbd39a625c315cf235b5a78
#   [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(window.__src)))].map((b) => b.toString(16).padStart(2, "0")).join("")
#   (0, eval)(window.__src); const lab = paneRunner.createRunner()
# the explorer's tab, https://explorer.devnet.flop.network/: the same with explorer-reader.js
#   sha256 of explorer-reader.js: 26a479201af916eb7f0896e173fc7d89bb95b4bdac0e6f106caf5cf06e6c2c33
#   (0, eval)(window.__src); const explorer = explorerReader.createReader()
```

Then `lab.accountReads("<the owner's SS58 address>")` in the node's tab, and on the PC
`node record-step.mjs start --run "$RUN" --key "$KEY_DEVICE" --reads '<relay>' --reads-sha256 <sha>`.
From there `node plan.mjs next --run "$RUN"` prints only what the lead does next, with every value
filled from the record: the next step's lines, or the wait, or the stop row and the cleanup steps
that apply. The lead runs those lines and asks again.

A pane call ends after 45 s, and a watch may take up to the runner's deadline of 120 s. So the pane
lines keep the promise on `window` and read it in a second call: `window.__s = lab.send(...)`, then
`await window.__s`. `lab.find` ends within the same deadline: if it has not finished, its outcome is
`find-deadline` with the blocks it read, and the lead calls it again from the block after them.
Every result of `send`, `sendSame` and `find` names its call in `sent_by`, also those that submit
nothing.

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
different bytes: `lab.find`, then `lab.sendSame`. A refusal at submission is read by the node's
code (the rows of `send_outcomes`): 1010, the node judged it invalid and it is not in the pool;
1013, it is already in the pool, so it is treated as sent; 1014, another transaction of the same
signer and nonce is in the pool, so the lead stops signing and finds out which; any other code, not
in the pool by the node's word. The codes are from the lead's knowledge of Substrate's author RPC,
not from a committed file (`steps.json` `node_codes_source`).

### The check of a research signer's file

`record-step.mjs send-file` writes the send file of T1, T2, T8 or T9 only when the extrinsic's own
bytes are the plan's step (`research-signed.mjs`): the signer (OWNER, or the recorded device for
T9), the account nonce by the record (the start nonce plus the owner transactions the record holds
as finalized; for T9 the device's), an immortal era, no tip, and the call our research signer
prints for the step's line of `steps.json`. It builds the envelope exactly as `flop-sign.mjs sign`
writes it, takes the 64 signature bytes from the file, and requires the file's extrinsic to equal
it byte for byte and its `extrinsic_hash` to be its blake2b-256. Anything else is refused with what
differs. `record-step.mjs step` runs the same check before it records a reading of such a step. The
signature itself is not checked: a wrong one is refused by the node at no cost.

### The lead's stop

A step that will not come on chain would make the record wait for ever. The lead may then record a
stop: `record-step.mjs stop <id> --run "$RUN" --why '<words>' [--reads '<text>' --reads-sha256 <sha>]`.
It is allowed only at the step `plan.mjs next` names, with no finalized reading of it, and only
when its copy cannot land without being sent again:

- a: nothing was signed for it, and the record holds no runner reading of it, current or earlier
  (with a reading and no file the record says something was sent and the file is gone: the lead
  rules);
- b: a device step whose signed copy's era is over by the device's reads (a finalized head above
  its last valid block) and whose next nonce is the device transactions the record holds;
- c: an owner step or the sweep whose only runner reading is refused at submission with code 1010,
  from a first `send` (the runner's `sent_by`). After a deadline, a lost connection or an ended
  watch, a 1010 to `sendSame` can mean the first copy is in a block: no stop, the lead uses
  `lab.find` from the block before the first send;
- d: an owner step or the sweep with a signed copy and no runner reading: the record says the lead
  says this copy was never sent.

Cases c and d also need the node's own count. `--reads` and `--reads-sha256` are then the
`lab.accountReads` relay of the step's signer (the owner for T1, T2, T8; the device for T9), of
the plan's runtime; `signed/<id>.json` must pass the check of a research signer's file, so its
nonce is the one the plan gives the id; and the next nonce of the reads must equal that nonce.
`system_accountNextIndex` counts the chain and the node's pool, so an equal nonce shows that no
transaction with it is in a block or in the pool. A next nonce above it refuses the stop: the
nonce is used, or a transaction with it is in the pool, by this copy or another; the lead uses
`lab.find` from the block before the first send, then `lab.sendSame`. A next nonce below it
refuses too: the record and the chain disagree. When the find readings in the record cover every
finalized block from the record's start to the head without the copy, and the nonce is above, a
transaction that is not of this batch used the signer's nonce: these tools go no further at that
step and record no stop, and the stop table's row "nonce" says what is left. A signed file that is
not the plan's is refused with the check's words; the lead moves a wrong file aside by hand. The
stop's evidence holds the finalized head and the next nonce of the reads, and the copy's extrinsic
hash and nonce.

The pane's `already-sent` is a reading: the pane's sent list holds these bytes, so they were
written to a socket before. `record-step.mjs step` records it, and `nextOf` takes the step as sent
and not in a finalized block. With it in the record neither c nor d holds, and the stop names
`lab.find` and `lab.sendSame`.

After a stop by c or d what is left names the copy: its files, its extrinsic hash, its signer and
its nonce. It stays valid until that signer's nonce is used and must never be sent; the next
transaction this signer sends ends it.

Anything else is refused and names the row of `send_outcomes` to follow. After a stop no tool signs
the step or writes a send file for it. A stopped test step is a stop of the batch there, and the
cleanup steps that apply follow; a stopped cleanup step counts as not bringing back what it should,
and the steps after it go on.

## The record at run time

`results.json` in the run folder is a run time record (`record: "run-time"`). For each step it
holds what the runner relayed (the block's hash and number, the extrinsic's index, the sha256 and
length of the block's `System.Events`) and what the explorer relayed (its source and `read_utc`,
the outcome, the error named by the 1014020 table, the events of `ComputeChannel` and
`FlopSessionKeys` in the record's form). Nothing in it is called verified, and no balance is in it.
An explorer reading is taken only when its `success` agrees with the one `System.ExtrinsicSuccess`
or `System.ExtrinsicFailed` among its names, and a failed one's error is the one that event gives.
A channel id the explorer gives that is not the derived one is recorded with both ids
(`channel_mismatch`): the judge stops at that step, and what is under the explorer's id is left for
a later piece of work. Only a mismatch at the step that opens a channel (T3 for `CH_T3`, T5 for
`CH_T5`) drops the cleanup step that names it. After a mismatch at T4, T6 still applies. The run time judge
reads the refund of T6 and T7 where the explorer's events give it.
`node check.mjs "$RUN/results.json"` says go on, wait or stop at a step; it never says passed.

`check.mjs` exits 0 when the record is right and nothing is left on chain; 4 when it is right and
something is left, stopped or not; 1 when it is wrong; 3 for a run time record; 2 for its own
refusals. In a final record every step is run, left out by its own `only_if`, or after a recorded
stop (a stop by outcome at an earlier step, or a `lead_stop` carried over from the run time
record). A test step that is missing with no stop recorded makes the record wrong: failed, exit 1. No verdict begins with "passed" when something is left: a top up left after T6 says
`as planned, left: ...`.

## The run of 2026-11-13

The lead ran the batch on 2026-11-13. Its record is `results.json` in this folder, committed byte
for byte as the run left it. `results.test.mjs` holds it.
The folder `run-2026-11-13` holds what the lab's tools wrote on the lead's machine when the lead
signed: the calls of the research signer's steps (`calls/`), each signed extrinsic with its hash and
era, and the exact text sent (`signed/`), with their `SHA256SUMS`, byte for byte. It holds no key.
`run-files.test.mjs` holds it. Each value below is read from that file,
with its field named. A field `steps.N` is the step at position N of `steps`, counted from 0.

- Eight transactions of nine planned were sent. Each is in a block the node reported finalized
  (`steps.N.run_time.sent.status` is `finalized`, with `steps.N.run_time.sent.block_hash` beside it).
- The blocks run from 3654835 (`steps.0.run_time.sent.block_number`, T1) to 3655782
  (`steps.8.run_time.sent.block_number`, T9).
- The runtime was spec 1014020 (`spec_version`).
- T1, T2, T3, T6, T8 and T9 succeeded (`steps.N.run_time.explorer.success` is `true`).
- T4 was refused by the chain with `ComputeChannel.BadState` (`steps.3.run_time.explorer.error.name`).
- T5 was refused with `ComputeChannel.CalibrationUnavailable` (`steps.4.run_time.explorer.error.name`).
- T7 was not needed: T5 opened no channel. It has no run time reading (`steps.6.run_time` is null).

T3 is the result the test was made for. The chain accepted a session call that the device signed
through the lab's encoder:
- with a mortal era: `era` of `run-2026-11-13/signed/T3.json` gives a period of 64 blocks, the birth
  number, the birth hash the signature binds, and the last valid block, at or above the block T3
  landed in (`run-files.test.mjs` holds it; T4, T5 and T6 likewise, T1, T2, T8 and T9 immortal);
- with a declared spend equal to the escrow: the escrow of `ComputeChannel.ForceOpenRequested`,
  10000000000000000 (`steps.2.run_time.explorer.events.1.fields.escrow`), is what the session spent,
  10000000000000000 (`steps.2.run_time.explorer.events.2.fields.spent`);
- with the channel id the plan derived:
  0xd8ae28f57ec645b73a4ea6deaa2d0b1f9228b93b08eb77779481898d371b8480
  (`steps.2.run_time.explorer.events.1.fields.channel_id`), the value of `CH_T3` in `steps.json`,
  and `steps.2.run_time.explorer.channel_mismatch` is empty.

What the run does not show:
- a top up on an open channel;
- an `open_channel` that succeeds (it needs a miner with a calibration);
- whether an expiry refunds a top up;
- the fee of each step.

How it was read: the node's finalized status and FLOP's explorer API, through the pane. It is not
yet decoded with the lab's decoder. The record is a run time record (`record` is `run-time`).

The owner's free balance, read by the lead through the pane, by position, at the start block 3654783
(`start.finalized.number`) and at the block of T9 3655782 (`steps.8.run_time.sent.block_number`):
- before: 24708267321505000000 raw;
- after: 24658876452470000000 raw;
- down 49390869035000000 raw (0.049390869035 FLOP).

These three numbers are the lead's reading by position. They are in no committed file but this README.

## Not done here: the final record

The final record is not made in this folder and nothing here promises it. It needs a new
observatory request list for the batch's blocks, its recording, a fill helper beside
`observatory/test/helpers/rerun-fill.ts`, and `System.Account` read by position and marked so, or a
new reviewed shape (the reviewed shape in `observatory/src/scale/shape.ts` does not state
`System.Account`). That is a later piece of work with its own brief. `check.mjs` judges a final
record when one exists: it requires `record: "final"` and `balances_source` (`decoder` or
`by position`) and prints the verdict with it.

The fifth request list of the observatory records the run's blocks
(`observatory/test/helpers/requests/list-5.ts`, branch `claude/observatory-list-5`).

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
inside the tests in temporary folders. The check of a research signer's file runs our own
`flop-sign.mjs call` (no key) in the tests too. `sign-device.mjs` and its tests need `imd-flop/dist/chain/`:
run `npm ci && npm run build` in `observatory/` and then in `imd-flop/` first. `.github/workflows/research-offline.yml` runs
them on GitHub. `node mutants.mjs` runs the mutants of `mutants.json`: the reviewer's R-M1 to
R-M18, adapted to this code (the reviewer's own `review-mutants.json` names finds of `fcfb8b5`), and
the fix round's own. Each is killed or listed as equivalent with its reason.
