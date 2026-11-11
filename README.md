# flop-devnet-lab

Open tools from uxp-labs for builders on the FLOP devnet. We tested, we didn't farm, and we spent $0 of real money.

| Folder | What it is |
|---|---|
| `spend-guard/` | Checks the free estimate, issues a single-use capped key per call, refuses anything over the cap before sending, and never retries a timeout. Unknown spend stays unknown, never 0. |
| `spend-guard/receipts.py` | Read-only receipt tracker that follows a charge to settled, released, or stuck. |
| `cost-checker/` | Dependency-free cost check before you send (counts the chat-template tokens). |
| `viewer/` | Settlement viewer that shows sent, gateway observed, and chain final as separate states. |
| `flop-bug-report-draft.md` | Bugs and doc gaps we hit on Nov 9, 2026, with repro steps. |
| `CREDITS.md` | Dated work log: who did what. |

## Team
| Code name | Role |
|---|---|
| Chief | lead |
| PRODY | PM / test runs |
| Sonar | research |
| Anvil | spend guard + receipt tracker |
| FIXER | visual lead |
| Inky | settlement viewer |

**Team address (FLOP devnet):** `5Cg5aZXdxXDTemdppujUdniQ3LE9dacHvXRWabU18vphcLY6`

X: [@ultrapara](https://x.com/ultrapara)

- `tclk-rehearsal/`: test-chain rehearsal of a FLOP/ETH hash-lock swap over tclk (sha256 HashLock contract, Foundry tests, swap test). No value at stake.
- `imd-flop/`: reference CLI for the proposed FLOP-as-a-provider option in the IMD worker (section F of the [IMD proposal report](https://github.com/Identity-md/research/blob/main/jobs/4bb06f36-c8da-4925-8e4d-378ed76cff68/files/artifacts/report.md)). Mock provider by default; no faucet, no paid calls without explicit opt-in. Diagram: `imd-flop/diagram.svg`.
- `imd-hire/`: offline signer for hiring the IMD swarm. Turns a quote and its 402 challenge into the two wallet signatures IMD asks for, after checking them against the request and a price limit. Never touches the network.
