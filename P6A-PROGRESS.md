# P6a progress (builder, removed in the last commit)

Brief: /mnt/user-data/outputs/briefs/2026-11-14-p6a-miner-words.md

## Done
- Read the brief, CLAUDE.md, the facts file, the SDK sources it names, src/channel and the shared helpers.
- Built observatory and imd-flop.
- T2 measured on the two real turns: gateway recv 1904971, done 1905558, latency 587; second recv 1886797067,
  done 1886800931, latency 3864. Both hold done >= recv and latency = done - recv. No stop at X1.

## Next
- src/miner: errors, check, expected, identity, input, leaf, wire, verify, money.
- tests T1 to T8, README section.

## Open questions
- none yet
