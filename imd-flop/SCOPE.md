# imd-flop: reference CLI for the "FLOP, by choice" proposal (scope v0)

Status: scope only. No signing with real wallets, no buying, no posting, no live imd job payments.
Source: ultrapara's proposal page (flop-by-choice-an-imd-worker-pro.imd.site), Sonar's map
(imdfun-bridge-research-2026-11-09.md), spend-guard/, receipts.py, tclk-rehearsal-clean/.

## Why a companion, not a worker plugin
The imd worker has no custom-provider setting today (Venice is the only opt-in, via `imd venice key`).
So this ships as a standalone `imd-flop` CLI that mirrors the proposed `imd flop ...` commands,
so the imd team can lift it into the worker as is.

## Commands (v0)
| Command | Does | Reuses | Live calls |
|---|---|---|---|
| `imd-flop setup` | Make one local Ed25519 key per seat (0600 file, never printed). Show the did:key and SS58 forms of the same key. | new | none |
| `imd-flop link draft --seat <tokenId> --agent <erc8004Id>` | Build the seat to DID link statement (EIP-712 typed data for the seat wallet plus an Ed25519 signature for the FLOP key). The FLOP side gets signed locally; the wallet side is only *emitted* for the holder to sign. | new | none |
| `imd-flop link verify <file>` | Check both signatures and that the SS58 equals the did:key. | new | none |
| `imd-flop cap set <flop/day>` / `cap show` | Required daily cap. No cap means FLOP is off; at the cap, the CLI refuses new calls. | spend-guard SPEC + ledger.jsonl | none |
| `imd-flop run --job <id> --prompt ...` | Quote first (template pad), refuse over the per-call or daily cap, call through a child key only, no retry on timeout, then write a receipt. | guard.py | FLOP gateway, only with a working capped key |
| `imd-flop receipt <request_id>` | Show the receipt beside the job, labeled "gateway observed" until chain settlement is checked. | receipts.py, classify_receipt | FLOP gateway read |
| `imd-flop provider mock` | Local OpenAI-shaped stub so the flow can be demoed with no key and no spend. | new | none |

Optional: `imd-flop pay` wraps the tclk hash-lock swap (PaperRail first; FlopRail only under Chief's ≤0.25 rule).

## Rules built in (the proposal's five, enforced in code)
1. Keys stay local: the key file is 0600, and logs and receipts hold only DID, SS58, signatures and IDs. A pre-write scan rejects anything shaped like a key.
2. One seat, one DID: `setup` refuses a second key for a seat id unless `--rotate` is passed, and rotation writes a revocation record.
3. Faucet: the CLI has no faucet command at all.
4. Real work only: `run` requires an imd job id, and it is checked against public `GET /jobs/:id` before spend (read-only).
5. A broken link means no route: `run` refuses when `link verify` fails.

## Demo path (no spend, no signing with real wallets)
mock provider, then setup, a link draft signed with an anvil test wallet, cap, run against the mock,
then the receipt. When a working FLOP key exists, the same run goes against the devnet gateway under the existing cap.

## Open items
- Key type: resolved. The live OpenAPI for /enroll/wallet accepts sr25519, ed25519 or ecdsa (per PRODY), so one Ed25519 key per seat works.
- Payer model (Sonar's top open question): whether imd requesters or seat holders pay for FLOP calls. Until it's answered, the cap is per seat and funded by the holder; the ledger keeps a payer field so it can change later.
- Section F CLI spec: if ultrapara shares the companion report, the command names and flags follow it over this scope.
- InferenceReceipt is still unseen. Receipts stay labeled "gateway observed" with no proof claim.
- The link statement format is ours until imd adopts one.

## Size
About one day. Python (matches guard.py), plus pynacl/eth-account for verification only. Lives in uxp-labs/flop-devnet-lab under `imd-flop/` after Chief's review.
