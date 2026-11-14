# Review P5a progress (reviewer)

Done:
- Built observatory and imd-flop. Copies: /tmp/rev-p5a/main-imd (528aad0), /tmp/rev-p5a/br-imd (fcc0560), dist-chain in each.
- Attack 1 P8: harness /tmp/rev-p5a/h/diff.mjs, no difference but reviewedRuntime().rt (two calls, constants). Pinned digest test review-p5a-session.test.ts.
- Attacks 2, 3, 4, 7: review-p5a-bytes.test.ts. RP5A-1 (TextEncoder global builds the one list).
- Attacks 5, 6: review-p5a-input.test.ts. RP5A-2 (call name String() runs caller code, raw TypeError).
- Attack 8: /tmp/rev-p5a/h/reduce.mjs (only Vec<Vec<u8>> and MembershipProof change), /tmp/rev-p5a/h/table-mut.mjs (33 forged tables).
- Attacks 9, 10: review-p5a-table.test.ts.

Next:
- Attack 11 mutants against author tests (chain-owner-*.test.ts), attack 12 README, 13 deviations, full npm test, checks.
