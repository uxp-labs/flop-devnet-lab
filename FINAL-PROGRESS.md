# Piece F progress (claude/encoder-test-final-record)

Done:
- D2 refactor (57ff02a): test/helpers/block-fill.ts holds what both fills need (pinBlock, extrinsicFill, readThroughDoor, errorRows); rerun-fill.ts uses it. The rerun's results.json refills byte for byte (sha256 47292f1e...). Mutants whose find text moved follow their code.
- A1 (fixture commit): fixtures/recording-20261113182100-8769e8d2841bf49a, byte for byte from observatory-data 210688b, meta.json with provenance.
- A2, B1 to B6 (d8195b2): test/encoder-recording.test.ts, test/helpers/recorded-encoder.ts; the fifth list's tests read the fixture's copies. All of B2 to B6 hold.

Lead ruled (brief's last section): C5 words { absent: true } for session, "absent" for session_nonce and breaker_tx_count; C9 the fall is all eight fees; this piece is round 32.

Was stopped at:
- C5: the record's form gives no word for a session, a session nonce or a breaker the node holds nothing for.
  FlopSessionKeys.Sessions, SessionNonces and CircuitBreakers of (owner, device) / device are not stored
  at the start block 3654783 (before) and at T1's block 3654835 (after of T1).
- C9: the owner's free balance fell by 49390869035000000, the sum of all eight fees (owner's 13042937475000000
  plus device's 36347931560000000), not by the owner's fees alone as C9 words it.

Done also: test/helpers/encoder-fill.ts, scripts/fill-encoder-results.mjs, results.final.json (check.mjs: passed as planned (balances: decoder), exit 0; same statuses as the draft, one new info line at T1).

Next: test/helpers/encoder-fill.ts, scripts/fill-encoder-results.mjs, results.final.json,
test/encoder-results.test.ts, cli-checks case, mutants, research folder test, words (W1, W2).

Done also: test/encoder-results.test.ts (127750e), cli-checks cases (D4), mutants/encoder-fill.json (17).

STOPPED again (a rule cannot be met as written):
- judge.mjs imports lib.mjs, which loads @noble/hashes from imd-flop/node_modules. The observatory check
  (observatory-check.yml: npm run check in observatory only) and mutate.mjs (links only observatory/node_modules)
  have no imd-flop install. So encoder-results.test.ts (it imports judge.mjs for the verdict, T2) and the cli-checks
  case running check.mjs (D4) fail there: mutate.mjs control fails with "Cannot find module '@noble/hashes/blake2.js'".
  Local runs pass only because imd-flop is built here. Waiting for the lead's rule.
