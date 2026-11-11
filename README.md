# flop-devnet-lab

Open tools from uxp-labs for builders on the FLOP devnet, and the reference build for
"[FLOP, by choice](https://flop-by-choice-an-imd-worker-pro.imd.site/)": an opt in FLOP provider for
the IMD worker. One identity per seat, a daily cap, a receipt beside every job.

We test, we do not farm. Devnet FLOP has no value. The only real spend in this repo's history is IMD
paid to the IMD swarm to audit it.

## What is here

| Folder | What it is | Check |
|---|---|---|
| `imd-flop/` | Reference CLI for FLOP as a provider in the IMD worker. Links one seat to one FLOP identity, caps daily spend, keeps a receipt next to each job. Mock provider by default. A paid call needs explicit opt in. | `npm run check` |
| `imd-hire/` | Offline signer for hiring the IMD swarm. Makes the two wallet signatures a paid IMD request needs, after checking them against the request and a price limit. Never touches the network. | `npm test` |
| `observatory/` | Read only view of the devnet: network status, reset detection, spec drift, an event census and escrow states. A scheduled run reads network status about hourly and publishes it to the `observatory-data` branch, with recordings of what the RPC answered. A decoder turns recorded metadata, events and storage keys into values, pinned to a reviewed shape of the runtime. Everything else still runs on saved fixtures. | `npm run check` |
| `interfaces/` | The JSON schemas the tools share: `escrowState` and `networkStatus`. | |
| `contract/` | The spend rules and test vectors that `imd-flop`, `spend-guard` and `viewer` must agree on. | |
| `spend-guard/` | Gets the free estimate and refuses anything over the cap before sending. Unknown spend stays unknown, never 0. Includes a read only receipt tracker. | `python3 -m unittest discover -s . -p "test_*.py"` |
| `viewer/` | Settlement viewer that shows sent, gateway observed and chain final as separate states. | `python3 -m unittest discover -s . -p "test_*.py"` |
| `cost-checker/` | Dependency free cost check before you send. | |
| `testlib/` | The Python loader for the contract vectors. Test code only. | |
| `tclk-rehearsal/` | Test chain rehearsal of a FLOP and ETH hash lock swap. No value at stake. | `forge test` |
| `research/` | Research reports bought from the IMD swarm, kept as delivered with where they came from and what we confirmed ourselves, and our own devnet tests with every transaction and the tool that signed it. Reports are leads, not rules. Tests say what was measured and what was not. | |

Also at the root: `flop-bug-report-draft.md` (bugs and doc gaps we hit on Nov 9, 2026, with repro
steps) and `CREDITS.md` (dated work log and public filings).

Every package runs its tests offline. CI runs them on each push.

## How this repo is run

ultrapara owns it. One lead agent does the work and merges when the checks pass.
Nothing here spends, signs with a wallet or posts in public without ultrapara's yes.
Audits of the spend path are bought from the IMD swarm with `imd-hire`, and each report is triaged
into fixes with a test that fails first.

## Who works here

ultrapara owns the repo and decides what spends, what signs and what is posted. X: [@ultrapara](https://x.com/ultrapara)

**Claude** has been the one lead since Nov 10, 2026. Claude is an AI agent (Anthropic's Claude) that
works for ultrapara. It writes the code, has other agents that wrote none of it review it, buys
audits and research from the IMD swarm, runs the lab's devnet tests, and merges when the checks pass.

Claude's public identity on FLOP devnet, one key made for this lab:

| | |
|---|---|
| FLOP devnet address | `5HEA8QECFwBg1F9cxoXzvQzryu2d5qj5zASJS7owNW2zebBz` |
| DID | `did:key:z6MkupnPdzwmSg8eN4qgqhhT3ciNQuApTMQt1u5gHDCqhqmB` |

The devnet tests under `research/` are run from that address. It is the owner account in each, and
the device keys a test uses are funded from it and emptied again. It claimed the faucet once and does
not claim again. Its key stays on ultrapara's machine and is never printed.

**The first team.** ultrapara's first agent fleet started this repo on Nov 8 to 10, 2026:

| Code name | Role |
|---|---|
| Chief | lead |
| PRODY | PM / test runs |
| Sonar | research |
| Anvil | spend guard + receipt tracker |
| FIXER | visual lead |
| Inky | settlement viewer |

Their team address on FLOP devnet: `5Cg5aZXdxXDTemdppujUdniQ3LE9dacHvXRWabU18vphcLY6`

`CREDITS.md` is the dated log of who did what, with the public filings.

## License

MIT. See `LICENSE`.
