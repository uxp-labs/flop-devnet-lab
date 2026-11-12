# The session tests again, at spec 1014020

**Nothing has been run yet.** No key was used, nothing was signed and no transaction was sent.
This folder is prepared for the lead to run once the owner says yes. Until then every claim of the
three earlier tests stays measured at spec 1014014 only.

## What will be run

Twenty three transactions on FLOP Devnet, in the order of `plan.md`:

- Session A (owner and a new device key): the probe's two calls and the escrow test's five, in
  one session with `ComputeChannel` as the only allowed pallet and the escrow test's caps.
- Session B (owner and a second new device key): the deny list test's nine calls, with its allow
  list of nine names and its caps.
- Each session is revoked, and the devices return what they hold to the owner.

About 0.135 FLOP in fees if they are as at spec 1014014, 0.15 FLOP sent to the devices and back,
0.01 FLOP of escrow locked for at least 600 blocks. `plan.md` has the totals and where each comes
from.

## What is prepared

- `plan.md`: the claims, the transactions, the command lines, the totals, the guesses.
- `steps.json`: the plan as data, every value with the file and field it comes from.
- `plan.mjs`: prints the command lines and writes the force_open files once the devices exist.
- `check.mjs`: says for each recorded transaction whether the chain answered as planned.
- `errors-1014020.json`, `facts-1014020.json`: errors, events and constants of spec 1014020,
  built by `build-tables.mjs` from the observatory's third recording.
- `results.template.json`: the form the lead fills while running.
- The signer is `../2026-11-11-session-deny-list/flop-sign.mjs`, unchanged, with `--spec 1014020`.

## Results

Not run. To be written from `results.json` and the output of `node check.mjs results.json`.

| Group | Step | Expected at 1014020 | Seen |
|---|---|---|---|
| Session A | A1 to A11 | see `plan.md` | not run |
| Session B | B1 to B12 | see `plan.md` | not run |

## Tested

- `node --test research/2026-11-12-session-rerun-1014020/check.test.mjs`: 41 tests, 41 pass. A
  synthetic run built from `steps.json` passes; 30 kinds of wrong outcome are each caught (among
  them `SpendExceedsDeclared` recorded at its old index 18, a block executed by spec 1014014, a
  refusal that still moved escrow, a fee paid by the wrong account, a step sent after a stop).
- Eight of `check.mjs`'s rules were taken out one at a time; each time a test failed.
- `node build-tables.mjs --tape <tape>`: read both metadata blobs of the recording to their last
  byte. The 1014014 blob names all 13 errors the earlier tests recorded, at the indexes they
  recorded. The 1014020 table agrees with the index moves the upgrade report lists.

## Source only

- `flop-sign.mjs` makes every call of the plan with flags: read from its source. Run with no key
  and no command, it stops while loading its libraries, before reading any flag.
- That its bytes are valid at spec 1014020: the upgrade report's reading, not run.
- The doc comments of the six calls the plan sends are the same at both specs (sha256 in
  `facts-1014020.json`).

## Unresolved

- What the new capacity floor and tariff do to a `force_open` naming an account that is not a
  miner. `plan.md` says what is guessed and how the run would show it.
- Whether the owner's account nonce is still 9.
- No reference encoder check of the signer at spec 1014020 is prepared.

## Not done

- No transaction, no signature, no key.
- No read of the chain.
- Claims left out of the rerun, with the reason for each, are listed in `plan.md`.
