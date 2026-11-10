# imd-flop

A reference build of the companion CLI from the "FLOP, by choice" proposal ([report, section F](https://github.com/Identity-md/research/blob/main/jobs/4bb06f36-c8da-4925-8e4d-378ed76cff68/files/artifacts/report.md#f-stopgap-imd-flop-companion-cli-spec)).
It gives one imd seat one FLOP identity, links the two with signatures, caps daily spend, runs model
calls for real imd jobs, and keeps a receipt next to each job. It does not change or wrap the imd worker.

Status: devnet rehearsal. The default provider is a **mock**, so everything below runs with no key,
no network and no spend.

## Commands

| Command | What it does |
|---|---|
| `init [--network devnet] [--seat <tokenId>] [--rotate] [--check-genesis]` | Makes one Ed25519 key for the seat (file mode 600, never printed). Prints the SS58 address (prefix 42, the devnet faucet's `ss58Format`) and the `did:key`. Refuses a second key for a seat unless `--rotate`, which writes a signed revocation record. `--check-genesis` compares the pinned genesis, the faucet's `/chain` genesis, and the RPC's block 0. The flag stays optional on init. |
| `link --token <id> [--agent <erc8004Id>]` | Builds the v1 statement `{tokenId, erc8004AgentId, flopDid, ss58, network, genesisHash, issuedAt}`, signs it with the FLOP key, and prints EIP-712 typed data for the seat holder to sign in their own wallet. |
| `link verify <file> [--wallet-sig <sig> --wallet <addr>] [--save] [--eth-rpc <url>]` | Checks the Ed25519 signature, that the SS58 and the DID are the same key, that `genesisHash` is the FLOP network's genesis, that the EIP-712 data matches the statement, and the wallet signature if given. With `--eth-rpc` (or `ETH_RPC_URL`) it reads `eth_chainId` and, only when that is 1, `ownerOf(tokenId)` on the seat collection. It fails unless the signer still owns the seat, so a sale kills the link. A wrong, missing, or malformed chain id fails the verify. |
| `cap set <FLOP/day> [--per-call <FLOP>]`, `cap show` | Required. No cap means `run` refuses. The day resets at 00:00 UTC. |
| `config set payer <holder\|requester>`, `config show` | Who pays. Every ledger row records it. |
| `run --job <id> --prompt <text> \| --prompt-file <path>` | Gets a quote, pads it, checks the caps, makes the call, and saves the response and receipt. Nothing is sent to imd. Options: `--max-tokens`, `--system`, `--provider mock\|flop`, `--live`, `--job-budget`, `--timeout-ms`, `--check-job`, `--no-link` (mock only), `--mock-scenario`. `--provider flop` requires `ETH_RPC_URL` to report chain id 1 and the live faucet and RPC genesis to equal the pinned hash, and it refuses before any quote or paid call when they do not. The mock provider does not make those calls. |
| `status [--json]` | Network, seat, address, link state, payer, today's spend against the cap, and recent receipts with their `match` field. |
| `receipt <request_id> [--refresh] [--json]` | Shows one receipt and its `match` field. |
| `quote --prompt <text> [--provider flop]` | Free cost estimate. With `--provider flop`, it calls the gateway's free `/models/estimate`. |
| `faucet [--dry-run]` | Refuses with exit code 9, because our team doesn't use faucets. `--dry-run` prints the request it would have made. |
| `enroll [--dry-run \| --live]` | Dry run by default: prints the challenge and enroll calls it would make. `--live` does real devnet enrollment and is meant for a human on the holder's machine. |

Data lives in `~/.imd-flop/`, or in `$IMD_FLOP_HOME` if that's set. Exit codes are listed below.

## Exit codes

The process exit code is the `EXIT` value in `src/errors.ts`. `src/bin.ts` assigns it to `process.exitCode`. These numbers are stable so a script can branch on them.

| Code | Name | Meaning |
|---|---|---|
| 0 | `OK` | The command finished successfully. |
| 1 | `ERROR` | A general failure. Used for a failed `init --check-genesis`, a failed `enroll --live`, a failed child-key mint or a run aborted before send (`nothing sent`), a gateway HTTP error after the call was sent, and any unexpected error that is not a `CliError`. A ledger lock timeout *after* the paid call also exits 1: `appendLedger` takes the lock itself, and a `LedgerLockError` is not a `CliError`. |
| 2 | `USAGE` | Bad arguments, a missing seat or key, or a value the command will not accept. |
| 3 | `REFUSED_CAP` | Refused locally, nothing sent. Used when there is no usable cap, the padded quote is over the per-call, daily, or job budget, or a ledger `cap_charge` is unusable. |
| 4 | `REFUSED_LINK` | The seat-to-DID link is missing or does not verify, or `--no-link` was used with a non-mock provider. |
| 5 | `REFUSED_RULE` | A section E rule (including a second key for a seat, a secret scan hit, a missing job id, or a live-run gate) or a paid-run chain/genesis refusal, at the first check and at the recheck before the child-key mint alike (`nothing sent`). |
| 6 | `TIMEOUT_UNKNOWN` | The paid call timed out. Spend is recorded as unknown and is not retried. |
| 7 | `ESTIMATE_FAILED` | The cost estimate failed or returned no usable cost. Nothing was sent. |
| 8 | `VERIFY_FAILED` | `link verify` found a bad signature, a mismatch, or a failed owner check. |
| 9 | `FAUCET_REFUSED` | `faucet` without `--dry-run` always refuses (team rule). `--dry-run` exits 0 and does not send. |
| 10 | `REFUSED_LOCK` | The ledger lock could not be taken *before* the paid call (`LedgerLockError`: timeout or contested). Nothing was sent. This code is not shared with cap refusals (3) or a broken link (4). |

Lock-timeout rule: if the ledger lock cannot be taken before the paid call, the CLI exits 10 and nothing is sent. If the lock cannot be taken after the paid call, while writing the result row, the CLI exits 1. Exit 3 stays cap refusals only. Exit 4 stays a broken link. Codes 0–10 are the only values the CLI returns.

Known gap: if the estimate step fails while another process holds the ledger lock, the CLI exits 1, not 10. Exit 10 covers only a lock that could not be taken before the paid call.

## Mocked vs live

- **Mocked (default):** `run`, receipts and `status` use a local stub shaped like OpenAI's API. It returns
  fixed output, a fake `request_id` and a fake receipt. `--mock-scenario` can simulate a timeout,
  a settled receipt, `key_expired`, or a failed estimate. Mock spend is tracked separately and never counts
  against the real FLOP cap.
- **Live, free, opt-in:** `quote --provider flop` (estimate), `init --check-genesis`, and `run --check-job` (public `GET api.imd.fun/jobs/:id`). `quote` stays a free estimate. It does not spend, and it does not run the paid-run gate.
- **Live, required before a paid flop run:** `run --provider flop` reads `eth_chainId` on `ETH_RPC_URL` and the devnet faucet `/chain` plus RPC block 0. The chain id must be 1. Both live genesis values must equal the hash pinned in `src/networks.ts`. The same check runs again inside the provider immediately before the child-key mint. A wrong chain, a reset (including the faucet and the RPC agreeing on some other hash), or an unavailable or malformed response refuses the run. There is no fallback that skips a source or trusts a prefix of the hash.
- **Live, built but never run by us:** `run --provider flop --live` (spends devnet FLOP) and `enroll --live`.
  The flop provider requires a gateway key from enrollment, a cap, and a link signed by both the FLOP key
  and the seat wallet. Each call mints a single-use child key capped at the padded quote and also sends
  `max_cost_flop`. Enrollment is unchanged and is not a paid inference call.
- Every request uses the User-Agent `uxp-labs-imd-flop/0 (+https://github.com/uxp-labs)`.

## Rules enforced in code (proposal section E)

1. **Keys stay local.** The seat key file is mode 600 and is never printed. Before anything is written to the ledger, a receipt, a link, a response or the config, a scan rejects anything that looks like a key: loaded secrets in any encoding, bearer tokens, `flop_ek_…` tokens, PEM keys, any 64-hex value outside a short list of known public hash fields, and fields with secret names. Public keys are only written as SS58 or `did:key`.
2. **One DID per seat.** `init` refuses a second key for a seat. Rotating writes a revocation signed by the old key and retires the old link. A receipt made under a revoked or rotated DID shows `match=mismatch`.
3. **No faucet.** `faucet` refuses.
4. **Real work only.** `run` requires `--job`. `--check-job` checks that the job exists on imd.
5. **A broken link means no route.** `run` refuses unless the link verifies, the DID is the seat's current one and the DID hasn't been revoked. `--provider flop` also requires the wallet signature, `eth_chainId` 1, and a passing `ownerOf` check through `ETH_RPC_URL`. `ownerOf` is sent only after the chain id matches. The same run requires the faucet and the RPC block 0 to equal the pinned genesis. Without an RPC, or if a read fails or disagrees, it refuses before any quote or paid call. `--no-link` works only with the mock and labels its output as bypassed.

Spend-guard rules, ported from `spend-guard/`:
- The quote is padded by 20 tokens for the Qwen chat template. On a paid flop run, the chain-id and genesis checks come before that quote. If the estimate fails, nothing is sent.
- If the pre-mint chain-id or genesis recheck fails, the latest ledger line is `refused_local` with cap charge 0. Status does not list that attempt as pending. The earlier `sent` line is the crash marker written before the call; the latest line is the one the cap uses. A crash between those two lines can leave `sent` as the latest line.
- A call is refused locally if it's over the per-call cap or what's left of the daily cap.
- A timeout is never retried. Its spend is recorded as `null` with its `request_id`. For the cap, unknown spend counts as the padded quote.
- Receipts are labeled `gateway observed` and `chain_final=false`, because nothing verifies chain settlement yet. A `null` settled spend shows blank, never 0. A 401 `api_key_expired` gets its own `key_expired` flag.
- The `match` field says whether a receipt agrees with its records. It's `matches` only when the receipt's job, seat and DID all equal the ledger row and the seat's current link, and that link verifies. Otherwise it's `mismatch`, listing the fields that disagree, or `pending` if there's no receipt yet.

## Payer assumption

`holder` (the default): the seat's daily cap applies.
`requester`: the daily cap doesn't count these calls, and each `run` needs `--job-budget <FLOP>`, which caps the
total requester-paid spend on that job. **Assumption:** the FLOP still comes out of the seat's own gateway key,
because the gateway has no way for a third party to pay today, so "requester" only means the call is billed
to the job. The per-call cap still applies in both modes.

## Run it

```
npm install
npm test          # tsc + vitest: 61 tests, no network (fetch and WebSocket are disabled in tests)
./demo.sh         # init, link, cap, run (mock), status, receipt in a temp IMD_FLOP_HOME
```

## Open questions

- **Who pays** for FLOP calls on testnet and mainnet: imd requesters or seat holders? Until that's answered, this is a config switch.
- **Testnet** has no date, and its identity requirements (did:key, SS58 sr25519/ed25519, or both) are unpublished. Only `devnet` is accepted.
- **Explorer URL formats** for FLOP sessions and settlements aren't documented, so receipts don't link to the explorer yet.
- **InferenceReceipt** (in the OpenAPI) hasn't been seen on a real response yet, so no receipt is ever marked chain-final.
- The link statement format and its EIP-712 domain (`imd-flop seat link`, chainId 1, the seat collection) are ours until imd adopts one.
- The owner check reads `eth_chainId`, then `ownerOf` at `latest`, through an RPC you supply. The chain id must be 1, the chain of the seat collection in `src/networks.ts`. Plain `link verify` skips the RPC unless you pass one. A paid run requires it. The check runs when a run starts, so after a sale the link dies at the next run, not the moment the seat changes hands. Only normal (EOA) wallets are supported, not smart wallets like a Safe (ERC-1271). The supplied RPC is trusted for the chain id it reports. Its URL often carries a key, so no message quotes it: a URL that is not a valid http(s) URL is refused before any request, and a transport error that repeats the URL shows `[ETH_RPC_URL]` in its place.
- The link statement stores the devnet genesis hash pinned in `src/networks.ts` (the full `faucet.flop.network/chain` value read on 2026-11-09). `verify` compares the statement to that pin. A paid run also reads the live faucet and the RPC block 0 and continues only when both equal that same full pin. A reset that moves both to a new hash fails the check while this program still carries the old pin. `init --check-genesis` is the optional form of the live comparison; a paid run always runs it. The device-key vouch in `DEVICE-KEY-PROPOSAL.md` is still a design note and is not built here.
- Proposed for the version imd would ship (not built here): imd already binds an Ed25519 device key to each seat with the holder's EIP-712 signature (`GET https://api.imd.fun/pair/wallet/:address`). Having that device key sign the FLOP DID would mean holders sign nothing new, and re-pairing or selling the seat revokes the link. The FLOP key stays separate; the device key only vouches for it.

## Source

Built to section F of the [Identity-md research job report](https://github.com/Identity-md/research/blob/main/jobs/4bb06f36-c8da-4925-8e4d-378ed76cff68/files/artifacts/report.md) (the "FLOP as an opt-in provider in the IMD worker" proposal). Credit to its authors; it is linked, not copied.
