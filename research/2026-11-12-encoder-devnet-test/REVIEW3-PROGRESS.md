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

5. low V5. refused-bundle, not-in-sent-list and already-sent carry no sent_by.
   review3-pane.test.mjs "the results of send and sendSame that submit nothing".

6. low V6. A lone signed/T3.dead-1.send.json beside signed/T3.json: --again opens the key file,
   then retire refuses ("dead-1.json exists"). review3-preflight.test.mjs "a lone dead send file".

## Held

- Table of attack B (21 rows) in review3-stop.test.mjs: allowed exactly at a, b, c, d as ruled;
  refused for 1013, 1014, other code, deadline, connection-lost, ended, deadline then sendSame 1010,
  find not-found, sent_by missing, sent_by find, code as text, finalized. Cleanup after each stop right.
- A device 1010 needs case b's reads. sent_by edited in the relay text is refused by its sha256.

- Attack A held (review3-research-signed.test.mjs, 9): nonce and length in longer compact modes,
  a hash right for other bytes, lying fields beside right bytes, attempt and sweep nonces, a
  repeated owner step, a device value beginning with -- in callOf. Info: $DEVICE of T1, T2, T8 is
  taken from the record unchecked (only T9 checks it is 32 bytes).

- Attack C held (review3-pane.test.mjs, 5, a driven fake WebSocket): close between write and
  answer, late open, a throwing write, finalized with no block read, sendSame after a deadline.
  Writes and marks counted in each: one mark per first write, none for sendSame, none on a throw.

- Attack D held (review3-preflight.test.mjs, 2): two dead copies and no signed file; the newest
  dead copy's era decides; the nonce refuses before the key; a lone send file refused before the key.

## Next

E, F mutants.
