# observatory-data

Live readings of FLOP devnet network status, published by the read only FLOP Observatory.
The code is in uxp-labs/flop-devnet-lab on main: observatory/ and .github/workflows/observatory-live.yml.
Every file here is written by that workflow. Nothing here holds a key or anything personal.

- latest/ holds the newest reading: snapshot.json, the feeds, snapshots.jsonl, tape.jsonl, run.json and SHA256SUMS.
- log/<UTC date>.jsonl holds one snapshot per line, one line for each reading of that day.

The trust is "trusted RPC": one RPC endpoint was trusted. It is not proof.
A reader must check every file against SHA256SUMS, check observed_at, and refuse a reading that is stale.
judgeLatest in observatory/src/published.ts does all of that.
