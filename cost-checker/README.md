# FLOP free cost checker

Local only. No auth, no enroll, no inference spend. Node built-ins only (`fetch`, `node:util`).

Calls:
- `GET https://api.flop.network/v1/models` — catalog price (FLOP per token)
- `POST https://api.flop.network/v1/models/estimate` — free gateway quote

Sets `User-Agent: flop-cost-checker/0` so Cloudflare does not 403 Python/default-blocked clients (Anvil finding).

## Usage

```bash
node cost-check.mjs --system "Be brief." --user "Hi" --max-tokens 8 --cap 0.25
node cost-check.mjs --prompt "Hi" --max-tokens 40 --cap 0.25
node cost-check.mjs --model qwen/qwen2.5-0.5b-instruct --user "…" --max-tokens 8 --cap 0.25
```

- `--user` / `--system` wrap the text in a Qwen chat template before calling estimate (matches billed prompt shape).
- `--prompt` sends the string as-is to estimate; local worst-case still adds a +20 template pad.
- Default `--cap` is `0.25`.
- Prints gateway estimate, local worst-case, largest `max_tokens` that still fits the cap, and **PASS/FAIL**.
- Exit `0` only if **both** gateway and local are under the cap; otherwise `1`.

Agrees with Anvil's spend guard on the probe: padded / chat-template cost **0.186** for `Be brief.` + `Hi` + `max_tokens 8`.

## Test outputs (Nov 9 2026, America/New_York)

### Probe (system Be brief. / user Hi / max_tokens 8 / cap 0.25)
```
model=qwen/qwen2.5-0.5b-instruct
mode=chat-template
cap=0.25
price_per_token=0.006
gateway_estimate: input=23 output=8 cost=0.186
local_worst_case: input=23 output=8 cost=0.186
largest_max_tokens_under_cap=18
gateway=PASS local=PASS → PASS
exit=0
```

### 41-token request (raw prompt Hi / max_tokens 40 / cap 0.25)
Gateway total tokens = 41 (1+40). Local pads +20 for chat template, so local FAIL is expected.
```
model=qwen/qwen2.5-0.5b-instruct
mode=raw-prompt
cap=0.25
price_per_token=0.006
gateway_estimate: input=1 output=40 cost=0.246
local_worst_case: input=21 output=40 cost=0.366 (raw input 1 + template pad 20)
largest_max_tokens_under_cap=20
gateway=PASS local=FAIL → FAIL
exit=1
```

### Docs-style sample (prompt Write a Python function… / max_tokens 64 / cap 0.25)
```
model=qwen/qwen2.5-0.5b-instruct
mode=raw-prompt
cap=0.25
price_per_token=0.006
gateway_estimate: input=10 output=64 cost=0.444
local_worst_case: input=30 output=64 cost=0.564 (raw input 10 + template pad 20)
largest_max_tokens_under_cap=11
gateway=FAIL local=FAIL → FAIL
exit=1
```

## Notes

- Catalog price for `qwen/qwen2.5-0.5b-instruct` is 0.006 FLOP per token (prompt and completion).
- Under a 0.25 cap at that price, total tokens must be ≤ 41 before template overhead.
- `max_tokens` bounds completion only; chat templates add prompt tokens.
