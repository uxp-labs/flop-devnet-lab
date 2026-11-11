# imd-hire

An offline signer for hiring the IMD swarm. A job on IMD costs 0.5 IMD and is paid with two wallet
signatures ([API reference](https://imd.fun/docs/api/), "How paying works"). This tool makes those two
signatures and nothing else. It never touches the network.

## Why it is split this way

The machine that holds the key signs. Whatever has network access sends. The two meet through files:
this tool writes each HTTP request to a file, any HTTP client sends it, and the answer is saved beside
it for the next step. So the key never sits on a machine that talks to the internet for this, and the
sender never holds a key. A test fails if the package reaches for the network at all.

## The flow

A job is one folder that starts with `request.json`, the `{action, input}` to ask IMD for.

| Step | Command | Writes | Send it, then save the answer as |
|---|---|---|---|
| 1 | `imd-hire quote --dir <job>` | `1-quote.request.json` | `1-quote.response.json` |
| 2 | `imd-hire challenge --dir <job>` | `2-challenge.request.json` | `2-challenge.response.json` (a 402) |
| 3 | `imd-hire pay --dir <job> --key <file> --max-imd 0.5` | `3-submit.request.json`, `signed.json` | `3-submit.response.json` |
| 4 | `imd-hire order --dir <job>` | `4-order.request.json` | `4-order.response.json` |

Steps 1, 2 and 4 are free. Step 3 is the payment. A request file is `{method, url, headers, body}`. An
answer file is `{"status": <number>, "body": <the JSON that came back>}`.

Sending a request file and saving the answer, from a machine with network access (Node 18 or later):

```sh
node -e '
const fs = require("fs"), f = process.argv[1];
const r = JSON.parse(fs.readFileSync(f + ".request.json", "utf8"));
fetch(r.url, { method: r.method, headers: r.headers, body: r.body ?? undefined }).then(async (res) => {
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  fs.writeFileSync(f + ".response.json", JSON.stringify({ status: res.status, body }));
  console.log(f, res.status);
});' 1-quote
```

A quote lasts 600 seconds and the payment window is 300, so run steps 2 and 3 within about four
minutes of the quote. If it expires, `quote --new` starts another order. Nothing is charged for a quote
that is never paid.

## What `pay` checks before it signs

It signs only when the challenge asks for exactly what the folder and the flags say. Otherwise it
exits 3 and writes nothing to send. It refuses when:

- the payment is on another chain or in another asset than the IMD token
- the price is above `--max-imd`
- the quote and the payment requirement disagree on amount, asset, recipient or network
- the order is not the one that was quoted in this folder, or the quote answer is a stale one
- the quoted input is not the `request.json` in the folder (the server may add defaults, never change
  or drop a field)
- the quote has expired, or is too close to its expiry for the payment window
- a payment for this order is already signed (send `3-submit.request.json` again, it is safe to resend)

The payment itself is built by the x402 client libraries, pinned to the version IMD's server pins,
with the owner's asset and maximum set as the library's own spend control. Before it is written it is
checked field by field: payer, token, amount, spender (the x402 exact Permit2 proxy), recipient,
window, and that the signature is this wallet's over those fields. Then the quote approval is signed
over the hash of that exact payment and checked to recover to the same wallet.

## The allowance

Payments are signatures and IMD's server pays their gas. The wallet sends one transaction ever: an
approval that lets Permit2 move IMD on its behalf.

```sh
imd-hire approve --key <file> --allowance-imd 5 --nonce 0 --gas 60000 --max-fee-gwei 0.2 --priority-fee-gwei 0.01
```

It prints a signed raw transaction and does not send it. The spender is fixed to the canonical Permit2
contract, the amount is a cap you choose (5 IMD covers ten jobs), and it refuses when the most the
transaction could cost is above `--max-cost-eth` (0.001 by default). `--allowance-imd 0` revokes.

## The key file

`imd-hire wallet new --key <file>` makes one: owner only, never overwritten, never printed. Loading
refuses a file that others can read. Keep small amounts in this wallet. It is a hot wallet.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | done |
| 1 | an unexpected error |
| 2 | bad arguments, or a file the step needs is missing or malformed |
| 3 | refused: nothing was signed |

## Run it

```sh
npm ci
npm test        # tsc and vitest, no network
npm run build   # then: node dist/bin.js help
```

`test/fixtures/job-open/` holds a real quote and its 402 challenge from api.imd.fun, never paid and
long expired, so the tests sign against the real shapes.

## Not built

- It does not send anything. A sender for machines with network access would be a separate small
  driver on top of the same request files.
- Only the IMD token is paid, on Ethereum mainnet or Robinhood Chain. Only ordinary key wallets sign.
- The onchain intake route (one transaction, no signatures) is not covered.
