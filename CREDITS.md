# FLOP devnet: team work log and credits
Team: uxp-labs (GitHub). ultrapara's first agent fleet (PRODY, Chief, Sonar, Anvil, FIXER, Inky) started the repo on Nov 8 to 10, 2026. Claude, an AI agent (Anthropic's Claude) working for ultrapara, has been the one lead since Nov 10. Public identity: GitHub uxp-labs, X @ultrapara, and the lead's FLOP devnet address in README.md. Nothing is posted in public without ultrapara's OK.

| Date (ET) | Who | What | Path |
|---|---|---|---|
| Nov 8 | PRODY (+exec) | Gateway gate check, cost math | gate-check-2026-11-08.md |
| Nov 9 2:14 to 2:30 AM | PRODY | Capped run: sign-up cap 503, expired-key receipts 401, $0 spent | run-2026-11-09.md |
| Nov 9 | PRODY | Briefs B1–B3 | briefs-2026-11-09.md |
| Nov 9 | Sonar | Bug report draft (3 bugs + 10 doc mismatches) | bug-report-draft-2026-11-09.md |
| Nov 9 | Anvil | Spend guard v0 (dry run) + read-only receipt tracker; found the Python UA 403 | spend-guard/ |
| Nov 9 | FIXER | Settlement viewer brief (combined limits + receipt card) | settlement-viewer-brief-2026-11-09.md |
| Nov 9 | Inky | Settlement viewer (in progress) | |
| Nov 9 | PRODY | Merged bug report (from Sonar) + free cost checker | flop-bug-report-draft.md, cost-checker/ |
| Nov 9 ~3:08 AM | PRODY (+exec) | Merged Sonar addendum: estimate ignores chat `messages` (Bug 5); noted `/v1/openapi.json` 404 | flop-bug-report-draft.md |
| Nov 10 (UTC) | Claude | Took over as the one lead. Observatory milestone 0 closed at review round 16 and merged | observatory/ |
| Nov 10 (UTC) | Claude | Triage of the swarm audit at 8b5a068: fixes with tests that fail first, contract vectors, offline CI for the Python suites | imd-flop/, contract/, .github/workflows/ |
| Nov 11 (UTC) | Claude | imd-hire: offline signer for paid IMD requests, reviewed by a second agent before first use | imd-hire/ |
| Nov 11 (UTC) | Claude | First swarm audit paid by the agent's own wallet (0.5 IMD), of main at 8ddc5d2: job 769d5aeb-83f2-4d1b-b7d1-2549abca21c1 | imd-hire/README.md |
| Nov 11 (UTC) | Claude | Second swarm audit, of main at 33f3b9f: job b4e8e103-53a5-4c65-a67f-f10a5ea50542 (1 high, 1 medium, 9 low, 2 info). Report: https://api.imd.fun/jobs/b4e8e103-53a5-4c65-a67f-f10a5ea50542/report.md | imd-flop/, viewer/, contract/ |
| Nov 11 (UTC) | Claude | Three research reports bought from the IMD swarm (0.5 IMD each): how a receipt's settlement can be proven on chain, how a seat can limit an agent's spend on chain, and FlopSessionKeys read out of the runtime code. Kept as delivered, with what we confirmed ourselves | research/ |
| Nov 11 (UTC) | Claude | Two devnet tests of FlopSessionKeys with ComputeChannel, 15 transactions, no miner touched: a session may call ComputeChannel, and its limits count the escrow a call declares | research/2026-11-11-session-probe/, research/2026-11-11-session-escrow/ |
| Nov 11 (UTC) | Claude | The ledger lock rewritten after the audit's high finding: steps that yield before every file operation, checked over every interleaving of three waiters with crashes | imd-flop/src/lock.ts |
| Nov 11 (UTC) | Claude | Observatory decoder: hashes, SCALE, metadata V14, events, storage keys, pinned to a reviewed shape of the runtime | observatory/src/scale/ |
| Nov 11 (UTC) | Claude | All 13 findings of the second swarm audit fixed (PRs 25 and 28). Three independent reviews by agents that wrote none of the code (lock, audit fixes, decoder) proved 29 more defects with tests; all fixed | imd-flop/, viewer/, contract/, observatory/ |

## The first team (code names)
Chief (lead), PRODY (PM / test runs), Sonar (research), Anvil (spend guard + receipt tracker), FIXER (visual lead), Inky (settlement viewer). Team address: see README.md. Their per-agent devnet wallets are not listed.

## Public filings on flop-labs/network (posted by uxp-labs with ultrapara's OK)
Nov 9, 2026:
- #141 comment (sign-up cap): https://github.com/flop-labs/network/issues/141#issuecomment-6735529403
- #122 comment (expired keys and receipts): https://github.com/flop-labs/network/issues/122#issuecomment-6735529767
- New issue #160 (estimate, cost cap, quota, doc gaps): https://github.com/flop-labs/network/issues/160
- #49 comment (receipt tracker): https://github.com/flop-labs/network/issues/49#issuecomment-6735530429

Nov 11, 2026:
- New issue #231 (FlopSessionKeys with ComputeChannel on devnet 1014014: what we measured, and three questions): https://github.com/flop-labs/network/issues/231

## Reports from outside
- Nov 11, 2026: issue #18 by sunriseblack. The receipt tracker ended with a traceback on a receipt holding a number that is not finite, and printed none of the receipts after it. Confirmed with our own reproduction, fixed with our own code and tests in `spend-guard/receipts.py`. A patch offered from outside is read as a report: it is not applied and not run.
