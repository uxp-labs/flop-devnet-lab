# The tool's grant on FLOP devnet (decision G-19): prepared, not run

Nothing in this folder has been signed with a real key or sent to any network. It is the harness
of a small batch the lead runs by hand on the owner's PC, through the browser pane, after an
independent review of this work (B-11). The rehearsal in it ran offline over the session rerun's
recording.

## What the batch is for

`imd-flop session grant` prints the call an owner signs to give a seat's device key a session with
caps. No grant printed by the tool has landed on chain yet. The batch shows it, between the lab's
own accounts, with test tokens: G1 the grant lands as `SessionCreated` with exactly the caps the
tool derived; R1 the revoke lands as `SessionRevoked`; G2 a second grant for the same pair after
the revoke (U1), taken or refused; R2 a revoke if G2 was taken. Four owner transactions at most,
and the cleanup tries of a revoke. No FLOP moves to any device. `plan.md` is the plan for a reader,
with the steps, the stop rule, the fence and the pane, printed from `steps.json`.

The fence (`node plan.mjs fence`): expected fees 20638783460000000 raw (0.02063878346 FLOP) if G2 is
taken; the worst case, 8 sends at the most per step, 84467887880000000 raw (0.08446788788 FLOP);
the fence 0.15 FLOP. The planner's and B-10's worst case, 63350915910000000 raw, counts two revoke
retries in all; this one counts three tries of each revoke, as H12 asks.

## How the lead runs it

On the PC, once: build `observatory/` and then `imd-flop/` (`npm ci && npm run build` in each),
pick a run folder `RUN`, and set `LAB` (the repo checkout) and `KEY_OWNER` (the owner's key file).
Then, again and again:

```
node "$LAB/research/2026-11-14-session-grant-devnet-test/plan.mjs" next --run "$RUN"
```

It prints the one next action with every value filled from `steps.json`, the run folder's files
and the record: the lines for the pane and for the PC, or the action the row of `send_outcomes`
names, or STOP and why, or the end and the line of `check.mjs`. Its first word is `NEXT`, `END` or
`STOP`. It exits 0 for `NEXT` and `END` and 3 for `STOP`. The lead runs those lines and asks again. The first answer makes the seat home with the tool itself:

```
mkdir -p "$RUN"
IMD_FLOP_HOME="$RUN/seat" node "$LAB/imd-flop/dist/bin.js" init --network devnet --seat unassigned
IMD_FLOP_HOME="$RUN/seat" node "$LAB/imd-flop/dist/bin.js" cap set 0.025 --per-call 0.02 --seat unassigned
```

The seat is `unassigned` (`steps.json` `SEAT`, B-6): the tool's own word for a seat with no token,
so no line of the record can be read as a claim about a real seat. The device's key file stays in
`$RUN/seat` and is never read by a script of this folder: the device's account comes from the
seat's `identity.json` `did`.

The pane: `pane-runner.js` of the last batch (unchanged) and then `session-reads.js` are pasted
into the node's tab, and `explorer-reader.js` of the last batch into the explorer's tab, each
checked by its sha256 (`node plan.mjs sha256s`). A pane call ends after 45 s; each promise is kept
on `window` and read in a second call, as in the last batch. In `session-reads.js` each question
to the node has a limit of 12 s, kept in the tape as "no answer in 12 s", and a whole read ends
within 40 s whatever the node does.

Relays come from files. For each relay `plan.mjs next` prints the pane line, the line that shows
the relay's sha256 in the pane, a line that writes the relay into `<run>/relays/<step>.<name>.txt`
(`relay.mjs write`, from a here document with the quoted delimiter `RELAY_END`), and the command
that reads the file with `--<name>-file` and `--<name>-sha256`. The file, less one trailing newline,
must have that sha256. No command takes a relay's text as an argument. A relay is one line of
JSON; the write refuses an empty relay, a line equal to `RELAY_END` and more than one line.

## The facts of the place, and how the harness meets them

- The keys are files on the owner's PC only. Only `flop-sign.mjs sign` opens the owner's key, by
  path. No script of this folder opens a key file or prints key material.
- The PC's shell cannot reach the node. So the tool cannot ask the node itself on the PC. It gets
  its chain answers from a tape: the node's raw answers to the tool's own questions at one
  finalized head, read by `session-reads.js` in the pane, relayed with their sha256, and served to
  the tool by `tape.mjs`, a transport that answers only from the tape and throws on any other
  question.
- The metadata answer is 487100 bytes. The pane relays its sha256 and length only, and the PC
  answers that question with the committed 1014020 metadata
  (`imd-flop/scripts/chain-table.mjs` `readSource`) only when the two are the committed ones.
- `tool-run.mjs` runs the tool's own built code, `imd-flop/dist`: `main` with the seat home as
  `IMD_FLOP_HOME`, `--json` and the tape's transport, or chain-read's `readBlockEvents`. It
  refuses, and writes nothing, for a wrong genesis, a stale tape, a metadata sha256 that is not
  the committed one, a tape used a second time, a question the tape does not answer, and a head
  the tool printed that is not the tape's. It refuses a tape that holds a node error, a question
  with no answer, two different answers to one question, or a read the time ended, before the tape
  counts as used: the words say to read a fresh tape, which is then taken for the same step. It
  runs only at the id and the phase `plan.mjs next` names (P0's show only before the start). An
  after read needs a tape whose head is at or above the step's block.

## What is here

| File | What |
|---|---|
| `steps.json` | The plan as data. Every value names the committed file and field it comes from, or says how it is computed or that it is decided and by which decision. |
| `plan.md` | The plan for a reader; its blocks are printed by `plan.mjs`. |
| `plan.mjs` | Prints the plan, the fence, the stop rule, the immortal rows, the sha256 of the pasted files, and `next`. |
| `outcomes.mjs` | The immortal rows of the last batch's `send_outcomes`, and the one action each row names (the lead's stop, a find, the same bytes again). |
| `relay.mjs` | Writes a relay file from a here document, and reads one against its sha256. |
| `next.mjs` | The next action by the record (H10): every stop, both branches of G2, the revoke's tries. |
| `session-reads.js` | Pasted into the node's tab after `pane-runner.js`: the session tape, the block tape, the free read of H7. |
| `tape.mjs` | A relayed tape, and the transport that answers only from it. |
| `tool-run.mjs` | Runs the tool once over one tape and writes one output file and the tape. |
| `owner-call.mjs` | The tool's call held to the plan, the second encoder, the check of a signed file. |
| `events.mjs` | One extrinsic's events, outcome and fee from the tool's `readBlockEvents`. |
| `record-step.mjs` | Writes the run time record from relays and the run folder's files; the lead's stop. |
| `run.mjs` | The run folder and the record, read the same way by every tool. |
| `judge.mjs`, `check.mjs` | Judge a results file: each claim pass, differ, incomplete, not run, not needed or not judged, and a verdict. |
| `replay.mjs` | Runs the tool again over each committed tape of a committed run folder (H16). |
| `walk.mjs`, `rehearsal-run/` | The rehearsal's walk of the record over the rerun's recording, and the run folder it wrote. |
| `lib.mjs`, `fixtures.mjs`, `rerun-node.mjs`, `pane.mjs`, `records.mjs`, `*.test.mjs` | Helpers and the offline tests. |

What this folder imports from the last batch's folder, `research/2026-11-12-encoder-devnet-test/`,
which is a reviewed record and does not change: from `lib.mjs` the pure helpers (sha256 of a text,
SS58, blake2b-256, paths in JSON, values from a source file, FLOP text); from `record.mjs` the
readers of a record (the entry and view of an id, the ids recorded, the attempts of a cleanup step,
the send file's text); from `record-step.mjs` `takeRelay` (in `relay.mjs`), `explorerReading` and
`NOTHING_SUBMITTED`; from `research-signed.mjs` `checkResearchSigned` with its `expected`
parameter, `nonceOf`, `partsOf` and `compact`; from `lead-stop.mjs` `takeSignerReads`; from
`plan.mjs` `outcomeRow` (in `outcomes.mjs`); from `steps.json` the rows of `send_outcomes`; and `pane-runner.js` and
`explorer-reader.js`, pasted by the same sha256.

## The record at run time

`$RUN/results.json` is a run time record (`record` is `run-time`): one node, read by the lead
through the pane; each step's events and fee decoded by the lab's own decoder (the tool's
`readBlockEvents` over a block tape, with the tape's sha256); the session after each step by the
tool's `session show` over an after tape, with its sha256; and the explorer's reading beside them
as a second, weaker source, marked so. Where the decoder and the explorer differ the record says so
(`sources_differ`), and the judge, which works that out again from the events and the readings,
says differ. A block is called finalized only where the node
reported it so, with its hash beside it. Nothing is called verified. A public recording of the
batch's blocks is not part of this piece (B-8, stage 2).

The run folder holds the seat home, `tapes/`, `tool/`, `calls/`, `signed/` and `results.json`.
After the run the lead commits, in a folder here, `results.json`, `tapes/`, `tool/` and the seat's
`config.json` and `identity.json`, and names the folder in `replay.mjs` `COMMITTED`. Never the
seat's key file: `replay.mjs` refuses a folder that holds any other file, by name, without opening
it.

`node check.mjs "$RUN/results.json"` judges the claims: G1's `SessionCreated` fields equal the
derived caps, owner and delegate; its `expires_at` is its block plus 86400; show after G1 says
active with those caps; R1's `SessionRevoked`; show after R1 says revoked; G2's outcome (taken,
refused with `FlopSessionKeys.SessionAlreadyExists`, or another error, U1 then open); R2 if G2 was
taken; every fee at or under the most per step; the explorer's reading agrees. Each claim is
computed from the record's events and readings, never from the record's own words (`success`,
`error`, `fee_raw`, `sources_differ`); a word that is not what the events give makes its claim
differ, and a step with no System outcome event is incomplete. G2 refused with any error but
`FlopSessionKeys.SessionAlreadyExists`, named or not, differs, and U1 stays open. It exits 0
(passed) only when `plan.mjs next` says the end for the record and every claim the record judges
passes or is not needed; 1 when a claim differs; 4 in every other case; 2 for a file it cannot read
as a run time record.

The owner's balance before and after is not read in this batch: `lab.accountReads` gives the nonce
and no balance. It comes with the public recording of the batch's blocks (stage 2), through the
observatory's decoder. What holds the money side here: each step's fee and its payer are read from
the step's own events, each fee is at or under the most per step, and no step of the plan moves
funds. A `balances` field in a record is reported as not judged in this record, never as a pass or
a differ.

The stop rule, as it now is (`node plan.mjs stops`, in `plan.md`): among the rest, a record with an
id twice, an id the plan does not have or ids out of order stops before any nonce is counted; a fee
above the most per step stops in every branch, the refused G2 included; a show after the last step
that says a session is active stops, names the session and prints the cleanup revoke's next try
(three at most); a send outcome follows only the action its row names.

## What the batch will show, and what it will not

It will show, by one node's answers at run time and the lab's own decoder: whether the grant the
tool printed landed with the caps the tool derived and the expiry of one epoch; whether the
revoke the tool printed landed; and how the chain answers a second grant over a revoked record
(U1). It will not show: the expiry's edge (U2, out by B-4); a session call of the device (D signs
nothing); the chain state by a second source of the same weight; whether `SessionCount` counts
revoked records.

## The rehearsal

`rehearsal.test.mjs` runs the tool's own code over tapes `session-reads.js` makes from the rerun's
recording, with a seat whose identity names the rerun's dev1: grant prints at A1 and its hex is the
second encoder's for 86400 blocks; grant refuses at A2 with exit 5; at A10 grant prints with the
stored record line and revoke's hex is the rerun's recorded revoke call; show at A6 gives the
recorded values; at A10 the tape holds the node's error for the nonce and the breaker, so
`tool-run` refuses it, and with those two set as nothing stored show gives active false; `readBlockEvents` over a block tape of A2 gives the recorded `SessionCreated`
and fee. The recording holds no session key of dev1 before A2, so the pair's absence at A1 is set
in the test, as the tool's own tests set it. Where the recording holds no breaker (A2) or no nonce
and no breaker (A10), the tests set them as nothing stored and say so, since a tape with a node
error is refused. `rehearsal-run/` was written again by `node walk.mjs` in the fix round (the
record keeps the send text's sha256, and the probe's refusal is the one of F8). `record-flow.test.mjs` walks the whole record over the
same recording: the rerun's A2 grant was for 7200 blocks with a lifetime cap of 0.05 FLOP, so the
tools find G1 not the plan's, say R1, and then stop.

## Tests

`node --test` in this folder (Node 22), after `npm ci && npm run build` in `observatory/` and then
in `imd-flop/`. No network, no key file of the lab: the test keys come from fixed seeds and are
written in temporary folders. The signer's guard of H2 (86400 blocks signs, 86401 refuses) is
`signer-guard.test.mjs`. `.github/workflows/research-offline.yml` runs this folder's tests too.
