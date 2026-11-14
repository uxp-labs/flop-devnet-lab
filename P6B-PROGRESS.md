# P6b progress (builder; removed in the last commit)

Done:
- read the brief, the facts file, src/miner, src/channel, the SDK files named.

Next:
- src/miner: client-errors.ts, calls.ts, endpoint.ts, requests.ts, timing.ts, http.ts, client.ts
- test/lib/scripted-miner.ts; tests miner-endpoint, miner-http-*, miner-client-*
- update the two P6a source tests' file lists (miner-source, review-p6a-source)
- README "Miner client" section

Open questions:
- exit code of a prove status other than 200: taken as 5 (refusal by rule); transport failures of prove 11.
