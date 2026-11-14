# P6a progress (builder, removed in the last commit)

Brief: /mnt/user-data/outputs/briefs/2026-11-14-p6a-miner-words.md

## Done
- Read the brief, CLAUDE.md, the facts file, the SDK sources it names, src/channel and the shared helpers.
- Built observatory and imd-flop.
- T2 measured on the two real turns: gateway recv 1904971, done 1905558, latency 587; second recv 1886797067,
  done 1886800931, latency 3864. Both hold done >= recv and latency = done - recv. No stop at X1.

- src/miner written (10 files), tests T1 to T7 written and passing, README section added. All pushed.

## Next
- T8: mutants by hand in /tmp/p6a (git archive copy), count killed.
- full npm run check once, GitHub checks, remove this file in the last commit, report.

## Open questions
- none yet
