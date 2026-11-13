# Review 3 progress (third independent review, fix round 2, a9442dd)

Reviewer branch `claude/review3-encoder-devnet-test`, from `a9442dd`. No source file changed.
Tests run under setpriv, in this folder, after `cd imd-flop && npm ci && npm run build`.
Baseline at a9442dd: 229 of 229 pass.

## Findings so far (each DEFECT test fails on a9442dd)

1. medium V2. Case c takes a lone first-send 1010 whatever the node's words. A 1010 "Transaction is
   outdated" means the nonce is used: by this copy (an earlier send whose result was lost) or by a
   transaction the record does not hold. Path shown with the runner on a page with no localStorage.
   review3-stop.test.mjs "case c takes a lone first-send 1010 whose node words say the nonce is used".
2. medium V2. already-sent is not recordable, so after the pane says the bytes went out the record
   still holds no reading and case d ("never sent") is recorded.
   review3-stop.test.mjs "the record cannot hold the pane's already-sent".
3. low V2. Case a ignores the record: with signed/T2.json gone and a deadline reading in the record,
   case a says nothing was signed. review3-stop.test.mjs "case a says nothing was signed".
4. low V3. After case c (an immortal copy the node was given, nonce unused) what is left says
   nothing of it. review3-stop.test.mjs "after case c on T1 for a fee".

## Held

- Table of attack B (21 rows) in review3-stop.test.mjs: allowed exactly at a, b, c, d as ruled;
  refused for 1013, 1014, other code, deadline, connection-lost, ended, deadline then sendSame 1010,
  find not-found, sent_by missing, sent_by find, code as text, finalized. Cleanup after each stop right.
- A device 1010 needs case b's reads. sent_by edited in the relay text is refused by its sha256.

## Next

A (research signer bytes, compact forms, callOf), C (submit), D (preflight, dead files), E, F mutants.
