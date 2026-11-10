# FLOP Observatory

Read-only observatory for FLOP devnet: network status, reset detection, spec drift, an event
census, and escrow states from finalized blocks. Output as a page, JSON feeds and an MCP server.

M0 runs on saved fixtures only. No network, no keys, no spend, no signatures. Live reads (M1)
wait for ultrapara's approval.

## Check

```sh
cd observatory
npm run check
```

One command. Each run writes `check-runs/<source-sha>/<run>/` with a pinned report, every log,
and `SHA256SUMS`:

| Step | Proves |
|---|---|
| install, typecheck, build | clean install from the lockfile and a clean compile |
| test | unit, boundary and consistency tests. Every network and child process path is blocked at runtime (fetch, WebSocket, node:http, https, http2, net, tls, dgram, dns, child_process, worker threads, and the lower layers: dgram and dns resolver objects, ChildProcess spawn, native bindings, process.dlopen, inspector), and any attempt left in the log, or any refused write, signature or spend, fails its file. Every attempt is also written to a journal the moment it happens, and the journal is checked once every file has ended |
| attempts | the journal again, after the test run has exited: no attempt left in a file's log, nothing at all after a file's final check (a blocked call fired from a timer, say), and every test file reached that check |
| canary | the harness fails a throwaway test that leaves a fetch, an https request, a net connection, a child process, a refused RPC write, a refused signature or a refused spend, and two that make their attempt from a timer after the file's final check; a clean throwaway test passes, and so does the late timer once the journal check is taken out, so that check is what catches it |
| mutants | in a copy of every file git tracks (nothing untracked), an unmutated control passes, then each injected bug (reset ignored, stale RPC, conflicts dropped, malformed escrow accepted, one event claiming two escrows, an unreadable page dropped, a partial census shown complete, ...) makes at least one test fail. A mutant that only breaks loading is never counted as caught, and a copy that cannot be made is reported as setup-failed |
| mutants-canary | the mutation runner classifies a real bug, an equivalent change, a syntax error and a missing test correctly; its copy holds exactly the tracked files of a throwaway repo; a copy it cannot make is reported as setup-failed |
| recount | the TypeScript census and an independent Python recount agree on every census fixture, including the ones both must refuse, and a nudged total is caught in every fixture that produces totals |
| cli-checks | the command line passes unreadable pages to the census and escrows, refuses parts pinned to another chain, and reports the health rules |
| snapshot, mcp, consistency | five real snapshots (healthy, reset, nothing read, degraded faucet, conflicting evidence), each rendered as feeds, page, snapshot log and a real MCP stdio transcript. Every page cell is resolved in the snapshot and compared, in data-v and in its whole visible text; every td and span must carry data-k; each row's label must name its cell, and each escrow card and drift row may hold only its own cells; each table holds only its own section's cells, under that section's heading, and the drift columns come in the order every row holds its cells; nothing is hidden (no comment, only the elements and attributes the page writes, only its own stylesheet); feeds equal the snapshot exactly; MCP equals the feeds byte for byte; the snapshot hash verifies |
| consistency-canary | clean copies pass, and 34 tampered copies (a reset flipped on the page or in the feed, stale flipped, a conflict dropped, a census total nudged, an empty list shown blank, a key dropped or invented, a wrong value hidden in a nested span or shown in a cell without data-k, value cells swapped between rows or escrow cards, a row label renamed, a row commented out, hidden or styled away, a section folded or rewritten by a script, a row moved to another section, headings swapped, drift columns swapped or dropped, the snapshot edited after hashing, ...) each fail, the newer ones by the check they name |

`SHA256SUMS` shows files were not changed after the run. It does not prove the run was honest.
For that, rerun on the same revision in a fresh clone (or read the CI artifact) and compare
`outputs/`. They are byte-identical for the same revision on the same Node version only: each
snapshot's pin records `process.version`, so a published outputs digest holds for the exact Node
version stated beside it (v22.23.4 so far), and a run on any other version differs in `pin.node`
and in every hash that covers it.

## Commands

```sh
node dist/cli.js status   --fixtures fixtures/status-healthy
node dist/cli.js escrow   --fixtures fixtures/escrows-verification
node dist/cli.js census   --fixtures fixtures/census-complete
node dist/cli.js drift    --fixtures fixtures/drift-seeded
node dist/cli.js snapshot --status fixtures/status-healthy --escrows fixtures/escrows-verification \
  --census fixtures/census-complete --drift fixtures/drift-seeded --out out --log out/snapshots.jsonl
node dist/mcp-bin.js out/snapshot.json    # MCP over stdio, read-only tools
```

## Rules

[RULES.md](RULES.md) is the spec: unknown is never good news, only finalized events on the pinned
genesis are evidence, gateway reports are not chain proof, settlement says nothing about output
quality, partial counts are never complete, and nothing signs, spends or writes.

The two interfaces other teams import are in [../interfaces](../interfaces).

## Layout

| Path | What |
|---|---|
| `src/status.ts` | network status, reset, stale and conflict detection |
| `src/escrow.ts` | escrow state from finalized events |
| `src/census.ts`, `src/drift.ts` | event census and spec drift |
| `src/store.ts`, `src/feed.ts`, `src/page.ts`, `src/mcp.ts` | snapshot log, feeds, page, MCP |
| `src/guard.ts` | the read-only guard every transport must pass through |
| `src/snapshot.ts`, `src/cli.ts` | one pass and the command line |
| `tools/recount.py` | independent census recount, written from RULES.md alone |
| `fixtures/` | saved scenarios; `meta.json` says which values are real and which are made up |
| `mutants/` | the injected bugs and the tests that must catch them |
| `test/setup.ts` | the runtime block on every network and process path, the leftover attempt check, and the attempts journal |
| `test/global-setup.ts`, `scripts/attempts-check.mjs` | the journal check once every test file has ended, and again after the run |
| `scripts/tracked.mjs` | the copy of exactly the tracked files that the mutation runner and the canary work in |
| `scripts/check.sh` | the check |
| `scripts/mutate.mjs`, `scripts/mutate-canary.mjs` | the mutation runner and its self-test |
| `scripts/canary.mjs` | the harness canary |
| `scripts/compare-recount.mjs` | TypeScript census against the Python recount, per fixture |
| `scripts/cli-checks.mjs` | the command line wiring, end to end |
| `scripts/consistency.mjs`, `scripts/consistency-canary.mjs` | page, feeds and MCP against the snapshot, and the tampers that prove it bites |
| `scripts/mcp-transcript.mjs` | drives the real MCP binary over stdio |
