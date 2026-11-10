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
| test | unit, boundary and consistency tests; any network, write, sign or spend attempt fails its file |
| canary | the harness itself fails a test that leaves a forbidden attempt behind |
| mutants | every injected bug (reset ignored, stale RPC, conflicts dropped, malformed escrow accepted, partial census shown complete, ...) makes its test fail, and the clean tree passes |
| recount | the TypeScript census and an independent Python recount agree on every census fixture |
| snapshot, mcp | one snapshot rendered as feeds, page, snapshot log and a real MCP stdio transcript |
| consistency | page, feeds and MCP agree on state, observed_at and trust labels; nulls are blank |

`SHA256SUMS` shows files were not changed after the run. It does not prove the run was honest.
For that, rerun on the same revision in a fresh clone (or read the CI artifact) and compare
`outputs/`, which is byte-identical for the same revision and Node version.

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
| `scripts/check.sh` | the check |
