# Review P4 progress (reviewer)

Done:
- read brief, CLAUDE.md, builder brief, facts, S35 to S45
- built observatory and imd-flop
- attack 1: main's tests at 2a6874f in /home/claude/wt-review-p4-part1 (node_modules linked): 70 files, 1636 passed, 1 skipped
- attack 1: differential /tmp/rv-diff/diff.mjs, old dist (56b900b) vs new: 5639 cases, 0 differences; a planted change gave 1388
- attack 7: test/review-p4-verify.test.ts (R4, R5 defects; bulk HOLDS; identity key disagreement; settle 3479299 HOLDS)

- test/review-p4-plain-input.test.ts (R1 returning refuse, R2 ChannelError open, R3 functions open)

Next:
- review-p4-plain-input (R1), review-p4-frozen (R2, R3), review-p4-secret (R6, R7, R8), review-p4-request, review-p4-layouts, review-p4-words (R9)
- deps (attack 9), scans and mutants in /tmp/rv-mut (attacks 10 to 12), typecheck, full npm test
