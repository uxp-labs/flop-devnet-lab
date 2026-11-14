# Review P6a progress (reviewer, independent)

Done:
- Read SDK: miner-admission.js, transcript.js, protocol.js, agent-client.js, chat-render.js, transport-http.js (parts).
- Third writing of the five layouts written BEFORE reading src/miner identity/input/leaf or miner-answers.ts: imd-flop/test/lib/review-p6a-third.ts.

- Attack 1 and 2: test/review-p6a-layouts.test.ts, 7 tests pass: all five layouts agree.
- Attacks 3 to 9 (Q3 Q4 Q5 Q6 Q9 Q7): test/review-p6a-attacks.test.ts, 76 tests, 6 DEFECT tests fail by design (RP6A-1 L1, RP6A-2 L2 x2, RP6A-3 L3 x2, RP6A-4 L4 prototype), 70 pass.

Next:
- Q8 own source scan, Q10 mutants in /tmp/rev-p6a, Q11 README, deviations, full npm test, checks.
