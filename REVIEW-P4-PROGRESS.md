# Review P4 progress (reviewer)

Done:
- read brief, CLAUDE.md, builder brief, facts, S35 to S45; built observatory and imd-flop
- attack 1: main's tests at 2a6874f (/home/claude/wt-review-p4-part1, node_modules linked): 70 files, 1636 passed, 1 skipped; differential /tmp/rv-diff/diff.mjs 5639 cases 0 differences (control: 1388)
- test files: review-p4-verify (R4 R5), review-p4-plain-input (R1 R2 R3), review-p4-secret (R6 R7 R8), review-p4-layouts (HOLDS), review-p4-words (R9), review-p4-channel-id (HOLDS)
- attack 9: integrity of 4 packages equals registry; 16 added lock entries, none with install script, all reference dev; npm ci --engine-strict exit 0
- attacks 10 to 12: mutants in /tmp/rv-mut-tools (mutants.json 70, mutants2.json 13); alive: PI16 (equiv), T15 (equiv), B3, B4 (equiv), K3, E4, K18, S1, S2, S3, S6
- L1: original className is private in src/chain/extrinsic.ts lines 196 to 214, same body

Next:
- typecheck src and review tests, full npm test, push, gh checks, report
