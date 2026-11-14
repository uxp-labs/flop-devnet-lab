# Review P6a progress (reviewer, independent)

Done:
- Read SDK: miner-admission.js, transcript.js, protocol.js, agent-client.js, chat-render.js, transport-http.js (parts).
- Third writing of the five layouts written BEFORE reading src/miner identity/input/leaf or miner-answers.ts: imd-flop/test/lib/review-p6a-third.ts.

- Attack 1 and 2: test/review-p6a-layouts.test.ts, 7 tests pass: all five layouts agree.
- Attacks 3 to 9 (Q3 Q4 Q5 Q6 Q9 Q7): test/review-p6a-attacks.test.ts, 76 tests, 6 DEFECT tests fail by design (RP6A-1 L1, RP6A-2 L2 x2, RP6A-3 L3 x2, RP6A-4 L4 prototype), 70 pass.
- Q8: test/review-p6a-source.test.ts, 3 pass.
- Q10: 81 own mutants in /tmp/rev-p6a (tools in /tmp/rev-p6a-tools), 73 killed by builder tests, 8 alive: v21 w4 w18 w22 equivalent; w10 i3 i5 w20 killed by test/review-p6a-edges.test.ts (4 HOLDS). Builder's 7 equivalents (F7 F10 C2 R3 R4 V23 V32) checked: hold.

Next:
- Q11 README and deviations are read (source only). Full npm test once, push, GitHub checks, report.
