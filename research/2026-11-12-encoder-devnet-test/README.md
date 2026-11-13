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
| `results.json`, `results.final.json` | The run time record of the run of 2026-11-13, and its final record filled from the observatory's fifth recording. |
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
for byte as the run left it. `results.test.mjs` holds it. A field `steps.N` is the step at position
N of `steps` in `results.json`, counted from 0.

The folder `run-2026-11-13` holds what the lab's tools wrote on the lead's machine when the lead
signed: the calls of the research signer's steps (`calls/`), each signed extrinsic with its hash and
era, and the exact text sent (`signed/`), with their `SHA256SUMS`, byte for byte. It holds no key.
`run-files.test.mjs` holds it.

Each value below is read from `results.json` or from a file of `run-2026-11-13`, with its field
named. `results.test.mjs` builds each line of outcome from those files and holds the README to it
word for word.

- Eight transactions of nine planned were sent. Each is in a block the node reported finalized
  (`steps.N.run_time.sent.status` is `finalized`, with `steps.N.run_time.sent.block_hash` beside it).
- The blocks run from 3654835 (`steps.0.run_time.sent.block_number`, T1) to 3655782
  (`steps.8.run_time.sent.block_number`, T9).
- The runtime was spec 1014020 (`spec_version`).
- T1, T2, T3, T6, T8 and T9 succeeded (`steps.N.run_time.explorer.success` is `true`).
- T4 was refused by the chain with `ComputeChannel.BadState` (`steps.3.run_time.explorer.error.name`).
- T5 was refused by the chain with `ComputeChannel.CalibrationUnavailable`
  (`steps.4.run_time.explorer.error.name`).
- T7 was not needed: T5 opened no channel. It has no run time reading (`steps.6.run_time` is null).

T3 is the result the test was made for. The chain accepted a session call that the device signed
through the lab's encoder (`tool` of `run-2026-11-13/signed/T3.json` is "chain encoder,
imd-flop/dist/chain signSessionCall"):
- with a mortal era: `era` of `run-2026-11-13/signed/T3.json` gives a period of 64 blocks
  (`era.period`), born at block 3654995 (`era.birth_number`), binding the hash
  0x3467bbce5dc0eb5267fdf1c3abc12fd30f87e82a13bdaea77ec78ed4a106226f (`era.birth_hash`), valid
  until block 3655058 (`era.last_valid_block`). The era is read from the bytes the tool signed: the
  blake2b-256 of that file's `extrinsic` is its `extrinsic_hash` (`steps.2.run_time.extrinsic_hash`),
  the hash of the signed file that was sent, as `run_time_form` of `results.json` says, not a reading
  of the node. The explorer reported a transaction of that hash in the block
  (`steps.2.run_time.explorer.hash` and `steps.2.run_time.explorer.block_hash`). The node reported the
  bytes it was sent as finalized in the same block (`steps.2.run_time.sent.status` and
  `steps.2.run_time.sent.block_hash`). The bytes it was sent are `run-2026-11-13/signed/T3.send.json`,
  whose sha256 is `steps.2.run_time.sent.bundle_sha256`. The block's own bytes are read in the final
  record, from the observatory's recording of the block;
- with a declared spend equal to the escrow: the tool signed a declared spend of 10000000000000000
  (`declared_spend_raw` of `run-2026-11-13/signed/T3.json`) and an escrow of 10000000000000000
  (`fields.inner.escrow`); the escrow of `ComputeChannel.ForceOpenRequested`, 10000000000000000
  (`steps.2.run_time.explorer.events.1.fields.escrow`), is what the session spent,
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

These three numbers are the lead's reading by position. The number before is also in a committed
file: it is `owner_free_balance_raw.after` of `research/2026-11-12-session-rerun-1014020/results.json`,
the owner's free balance at block 3553688 after that rerun (its `owner_free_balance_raw.read`), also
read by position. The number after and the difference are in no other committed file.

## The final record

`results.final.json` in this folder is the final record of the run (`record` is `final`,
`balances_source` is `decoder`). It is the run time record, `results.json`, with its fill fields
filled from the observatory's fifth recording, and `filled_from` at the end. `results.json` is not
changed: a record of its day is not rewritten. The sha256 of `results.final.json` is
496accd3c706d4c4f3b7d5a699a891dc91bfbdfe1b81ea13067c5a5cadc27573. `final-record.test.mjs` holds it and each claim below by its
field. A field `steps.N` is the step at position N of `steps` in `results.final.json`, counted from 0.

What it is filled from (`filled_from`):
- The chain facts come from the recording `observatory/fixtures/recording-20261113182100-8769e8d2841bf49a`
  (`filled_from.recording`), decoded through the lab's decoder's one door,
  `observatory/src/scale/block.ts`, at the spec each block's `System.LastRuntimeUpgrade` names
  (`filled_from.from_the_recording`), with the reviewed shape of format `flop-observatory/decoder-shape@3`
  (`filled_from.shape`). The fill is `observatory/scripts/fill-encoder-results.mjs` (`filled_from.by`).
- What the lab signed and sent (signer, account nonce, call, era, extrinsic hash, time of sending)
  comes from the signed files of `run-2026-11-13/signed/` and from `results.json`
  (`filled_from.from_the_run`).
- The recording is one RPC endpoint's answers. It is evidence for the record, not proof of chain
  state. The observatory's `test/encoder-recording.test.ts` holds it to `results.json` and the signed
  files: each block's hash, each signed extrinsic byte for byte at its index, the birth hashes of T3
  to T6, the events' sha256 and length the runner relayed, and spec 1014020 at every block.

The verdict of `node check.mjs results.final.json`, exit 0:
- `8 pass, 0 differ, 0 incomplete, 1 not needed, 0 not run`
- `verdict: passed as planned (balances: decoder)`

Each step's block is called finalized as the run time record reports it (`steps.N.run_time.sent.status`
is `finalized`), with its hash beside it. The columns are `steps.N.finalized_in_block`,
`steps.N.block_hash`, `steps.N.result`, `steps.N.fee_raw`, `steps.N.after.accounts.owner.free` and
`steps.N.after.accounts.device.free`, or `absent` where `steps.N.after.accounts.device` is
`{ "absent": true }`. The start row is `before`. T7 was not needed and has no block.

| Step | Block | Block hash | Result | Fee raw | Owner free after | Device free after |
|---|---|---|---|---|---|---|
| start | 3654783 | 0xafded080999d0fc05b3c6f5d3f1579fd59b6cbe9829e1a9c52ff99a08a0d134d | | | 24708267321505000000 | absent |
| T1 | 3654835 | 0x05a8b32e2f9ef401e147d7594e0f09348ba4a310568356edeb70c827e72853e0 | success | 2723545745000000 | 24555543775760000000 | 150000000000000000 |
| T2 | 3654914 | 0xc36ced0ba0f84bbcafbe8a1a34508a32cd40e5b1849d737d9d8c81ff3cb197c8 | success | 6413391035000000 | 24549130384725000000 | 150000000000000000 |
| T3 | 3655037 | 0x9045529eb1c4e8eaf063c9d1ca63702c26f6c434989408b0b04dc4933ecc3957 | success | 9422731815000000 | 24539130384725000000 | 140577268185000000 |
| T4 | 3655115 | 0xb9b084f43fa77338fa9f329d5208551eb92d084004c56923997a986f358255ee | failed: ComputeChannel.BadState (pallet 103, error 11) | 5219861070000000 | 24539130384725000000 | 135357407115000000 |
| T5 | 3655185 | 0xce1b29311dcb8eea6438d8d7972290967a20ec881970d1e111ab9a3856fcea85 | failed: ComputeChannel.CalibrationUnavailable (pallet 103, error 97) | 10295621980000000 | 24539130384725000000 | 125061785135000000 |
| T6 | 3655678 | 0x8225561fd91aa365f80f81a3fde5f3ab9bab65a79e81aa87dc0345c983fc4a49 | success | 8639685990000000 | 24549130384725000000 | 116422099145000000 |
| T8 | 3655735 | 0xebfabc3ede98df1965b89d9273c021e2c88708cf3ecef0c53744226b0eb68c41 | success | 3906000695000000 | 24545224384030000000 | 116422099145000000 |
| T9 | 3655782 | 0xce99b03c34850c1ef31e8d9eb9c8cf9a2f58bc204f86cd98e40d791a180a9300 | success | 2770030705000000 | 24658876452470000000 | absent |

The cost and the balances:
- The cost is the sum of `steps.N.fee_raw` over the eight steps sent: 49390869035000000 raw.
- The owner signed T1, T2 and T8 (`steps.N.signer` is `accounts.owner.public_key`) and paid their fees,
  13042937475000000 raw.
- The device signed T3, T4, T5, T6 and T9 (`steps.N.signer` is `accounts.device.public_key`) and paid
  their fees, 36347931560000000 raw, from what T1 sent it: 150000000000000000 raw
  (`steps.0.events.3.fields.amount`, `Balances.Transfer`).
- The owner's free balance went from 24708267321505000000 raw (`before.accounts.owner.free`) to
  24658876452470000000 raw (`steps.8.after.accounts.owner.free`): down by 49390869035000000 raw, the eight fees.
  Nothing else was lost. These are the lead's two readings by position in the section above, now
  read through the decoder.
- The escrow of T3, 10000000000000000 raw (`steps.2.events.3.fields.escrow`, `ComputeChannel.ForceOpenRequested`),
  left the owner at T3 and came back at T6 (`steps.5.events.1.fields.amount`, `Balances.Transfer`).
- The device's account is absent at the start (`before.accounts.device`) and after T9
  (`steps.8.after.accounts.device`): T9 sent all it held back to the owner, and the owner's free
  balance rose at T9 by what T1 sent less the device's five fees.
- At the start and after T1 the node holds no session, no session nonce and no breaker for the
  device: `before.session` and `steps.0.after.session` are `{ "absent": true }`, and
  `session_nonce` and `breaker_tx_count` are `"absent"` (`filled_from.words.absent`). From T2 on
  they are stored.

The channel of T3 (`after.channel`, the fill's own field, `filled_from.channel`):
- absent at the start, after T1 and after T2 (`before.channel`, `steps.0.after.channel`,
  `steps.1.after.channel`);
- after T3, T4 and T5: waiting for its ack, `PendingAck` (`steps.2.after.channel.state.type`) with
  ack deadline 3655633 (`steps.2.after.channel.state.value.ack_deadline`) and escrow 10000000000000000 raw
  (`steps.2.after.channel.escrow`), the same in `steps.3` and `steps.4`;
- after T6: `Closed` (`steps.5.after.channel.state.type`). The closed record stays stored after T6,
  T8 and T9 (`steps.8.after.channel.state.type` is `Closed`), and it still says escrow 10000000000000000 raw
  (`steps.8.after.channel.escrow`), though the owner's balance shows the escrow came back at T6.

What the record shows: the eight transactions as the chain executed them, their events, results and
fees, and the two accounts, the session and the channel after each, read through the lab's decoder.
What it does not show:
- proof of chain state: one endpoint answered, and nothing here checks it against another;
- `epoch_spent_raw` and `breaker_tx_count` are recorded and not judged (see below);
- a top up on an open channel, an `open_channel` that succeeds, and whether an expiry refunds a top up;
- a like step in the session rerun for T4 and T5, so their fees are compared with nothing.

## What is not known

Written before the run and brought up to the final record. A field named here is a field of
`results.final.json`.

Answered by the run:

- What the chain answers to T4: `failed: ComputeChannel.BadState (pallet 103, error 11)`
  (`steps.3.result`), while the channel of T3 was waiting for its ack
  (`steps.2.after.channel.state.type` is `PendingAck`). So `top_up_escrow` through a session was
  not taken on a channel waiting for an ack.
- What the chain answers to T5 (`steps.4.result`):
  `failed: ComputeChannel.CalibrationUnavailable (pallet 103, error 97)`.
- The fees of T4 and T5: 5219861070000000 raw and 10295621980000000 raw (`steps.3.fee_raw`,
  `steps.4.fee_raw`), paid by the device though both calls were refused. No like step was sent
  before, so they are compared with nothing.
- The session nonce did not move at the two refused calls: it is 1 after T3, T4 and T5 and 2
  after T6 (`steps.2.after.session_nonce` to `steps.5.after.session_nonce`).

Still not known:

- Whether `expire_force_open` refunds a top up. T4's top up was refused, so there was none to
  refund.
- Whether T5's `opened_at` is T5's block, as T7's earliest block assumes. T5 was refused, so no
  channel was opened by it and T7 was not needed.
- The channel id formula for `open_channel`. It is shown for `force_open` only: T5 was refused.
- Whether an epoch boundary of the session or a new breaker period fell inside the batch.
  `epoch_spent_raw` and `breaker_tx_count` are recorded and not judged. The record holds
  `breaker_tx_count` 1 after T3 and 1 after T6, the second session call that was executed
  (`steps.2.after.breaker_tx_count`, `steps.5.after.breaker_tx_count`). Why it is not 2 the
  batch does not show.
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
