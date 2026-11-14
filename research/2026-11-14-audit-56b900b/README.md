# The chain path at 56b900b: a swarm audit

`report.md` is an audit bought from the IMD swarm on 2026-11-14. It is kept here as it was
delivered, byte for byte. It is a lead, not a rule: nothing in it is taken as true until our own
read of the code and our own test confirm it. Its reproduction lines were not run by us. A script
that comes from outside is a report (CLAUDE.md rule 2): each finding is reproduced from its
description with our own input before a fix is written.

## Where it came from

- What was asked: an audit of the chain path of this repository at commit
  `56b900b2f92b16e212afeb962883bd02dcc21d80`. That is the encoder (`imd-flop/src/chain/`), the chain
  reads (`imd-flop/src/chain-read/` and `imd-flop/src/node-rpc.ts`) and the decoder they rest on
  (`observatory/src/scale/` with the reviewed shape files). Nine points to look for. Every statement
  marked confirmed, inferred or unknown. The whole request is quoted at the top of the report.
- IMD job: `8bdcca82-782f-442e-bc78-7c6e5321b501` (`template: audit`). Order
  `ad4570f9-df82-4f17-bdce-2e9e41bd681e`.
- Paid: 0.5 IMD on Ethereum mainnet, transaction
  `0x80a9144b0a269d77ab29f3b07c4500880f53886ba306c3b8a86e190c3aebc68d` (block 26409942).
- How IMD did it, in the report's own words: four agents, each in one area (math, permissions,
  economics, control flow), and a judge that reproduced, merged and ranked what they found. Judged
  2026-11-14 02:17 UTC. The judge's submission is
  `4b91defa3fa887ba309514f4beb6544f52596341db43e57add85f69a7a717233`.
- Delivered at `https://api.imd.fun/jobs/8bdcca82-782f-442e-bc78-7c6e5321b501/report.md`. The lead
  fetched it in a browser on 2026-11-14 at 02:40 UTC. The copy here was checked against sha256
  digests computed in that page, part by part and whole.
- `report.md`: 31030 bytes, sha256
  `21df87752f4147b643dded52fdb08e47c1ea39c0b33b78cfbc299dc504f69585`.
- The job was not sealed. The report is public at IMD.

## What it says, in short

Four findings of low severity and five notes. None of them names a way to sign or send bytes other
than the ones the encoder describes, and none names a read that answers a value the node did not
state for plain input.

1. Low. `readBlockEvents` reads `block.number` and `block.hash` from the caller's object many
   times. An object with an accessor could answer the canonical hash once and another hash after.
2. Low. The encoder reads the signer's `publicKey` and `sign` and the runtime id's four names by
   plain property access. The README says a getter is refused and a Proxy's get trap is not used.
3. Low. The README says everything `src/chain` exports is frozen. The exported classes
   (`ByteReader`, `ChainEncodeError`) and their prototypes are not, and the test skips functions.
4. Low. `observatory/RULES.md` section 9 says in one sentence that the decoder reads six storage
   entries. It reads 16, and the same section lists the 16 further down.
5. Note. The fourth refusal of the pin (the shape derived again from the metadata differs from the
   file) has no test that fails without it.
6. Note. The strict reader's rule that an era's phase is below its period has no test that fails
   without it.
7. Note. `answerOf` says "Never throws" and throws for an object whose property is a throwing
   accessor. A node cannot send such an object.
8. Note. Two property tests can pass 20 seconds when the whole suite runs on a loaded machine.
9. Note, inferred by the report, not run: `rpcCall` parses a whole frame before any cap, and has
   no handler for a clean close, so a closed socket waits out the timeout.

## What we confirmed ourselves

Tested (run by us):

- Nothing yet. No reproduction of ours has run.

Source only (read by the lead at `56b900b`, not run):

- Finding 1: `imd-flop/src/chain-read/read.ts` lines 123 to 137 read `block.number` and
  `block.hash` from the argument each time, as the report says.
- Finding 2: `imd-flop/src/chain/extrinsic.ts` lines 130 and 131 and `imd-flop/src/chain/table.ts`
  lines 75 to 78 are plain property reads. `imd-flop/README.md` lines 135, 136 and 139 hold the
  sentences quoted.
- Finding 3: `ByteReader` is an exported class (`imd-flop/src/chain/scale.ts` line 52) and no line
  under `imd-flop/src` freezes it or `ChainEncodeError`. `imd-flop/test/chain-frozen.test.ts` line
  55 skips every exported function.
- Finding 4: `observatory/RULES.md` lines 1073 to 1075 name six entries and lines 1140 to 1144 name
  16. This sentence was left behind by the round that took the stated entries from 6 to 16.
- Finding 5: the line is at `observatory/src/scale/shape.ts` 561. No file under `observatory/test`
  or `observatory/mutants` holds the words "derived from the metadata differs".
- Finding 6: the line is at `imd-flop/src/chain/era.ts` 43. No file under `imd-flop/test` holds the
  words "not below its period".
- Finding 7: the comment and the plain reads are at `imd-flop/src/node-rpc.ts` lines 19 to 34.
- Finding 9: `rpcCall` (`imd-flop/src/node-rpc.ts`) sets `onopen`, `onmessage` and `onerror` and no
  `onclose`, and parses `String(ev.data)` with no length check before it.

Unresolved:

- Whether the two changed lines of findings 5 and 6 really leave every test passing. We read that no
  test names the words. We did not make the change and run the suites.
- Finding 8. GitHub's workflow `imd-flop offline` passed on `56b900b`, so the two tests did not
  time out there. We have not run the suite on a loaded machine to see them fail.
- Finding 9 is the report's own inference. Nobody has seen the memory or the 15 second wait happen.

Not done:

- No fix. The fixes are their own piece of work, each with a test of ours that fails without it.
  It follows the channel key piece, which moves the encoder's input checks into a shared module
  that the fixes of findings 1, 2 and 7 use.

## What it does not cover

- Only commit `56b900b`. Work merged after it is not in it.
- Not the spend path (booking, ledger, caps), `viewer/`, `spend-guard/`, `imd-hire/` or
  `tclk-rehearsal/`: the request left them out.
- It ran offline. No node was called, so nothing in it is a statement about the live devnet.
- IMD's acceptance means the report met the job's checks. It is not a guarantee that the code has
  no other defects. The report says so itself.
