# P6b progress (builder; removed in the last commit)

Done:
- read the brief, the facts file, src/miner, src/channel, the SDK files named (first builder, then the second).
- second builder: read the five drafts against the SDK source; committed them (calls, client-errors, endpoint, requests, timing). They typecheck.

Next:
- src/miner: http.ts, client.ts
- test/lib/scripted-miner.ts; tests miner-endpoint, miner-http-*, miner-client-*
- the two P6a source tests: file lists gain the new files; their content scans held to the ten P6a files; a P6b source test holds S1 for all
- README "Miner client" section

Open questions:
- none open. Lead ruled: a prove status other than 200 is exit 5; a transport failure of prove is 11.
