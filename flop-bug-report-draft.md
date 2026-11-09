# DRAFT: FLOP devnet gateway — bug report and doc fixes (not posted)

Status: **draft for ultrapara review**. Nothing filed or posted.
Base: Sonar's `bug-report-draft-2026-11-09.md` (left untouched).
Merge/verify: PRODY, Nov 9 2026 ~2:40 AM ET, from `run-2026-11-09.md`, `gate-check-2026-11-08.md`, live OpenAPI, `https://flop.network/llms.txt`, and free endpoints.
Credits: **Sonar** (draft + addendum item 11 / Bug 5), **Anvil** (Python UA 403; spend guard under `spend-guard/`), **PRODY** (run notes + re-verify + cost checker + merge).

Environment: `https://api.flop.network`, gateway image `0.1.305`, API `2.0.0`, OpenAPI 3.1.0 "FLOP Public Inference Data Plane".

Verification legend: **verified** = rechecked this turn or with a saved prior response; **unverified** = not reproduced this turn (stated clearly). Secrets shown as `<KEY>`. No enroll, no inference POSTs, no spends.

---

## Bugs

### 1. Enrollment cap 503 has no reset time (and Retry-After not confirmed)

**Status:** body **verified** (saved Nov 9 2:26 AM ET enroll result). `Retry-After` header **unverified** this turn (headers were not saved; enroll was not re-attempted).

**Repro:**
```bash
# 1) challenge
curl -sS "https://api.flop.network/v1/enroll/wallet/challenge?address=<SS58>"
# 2) sign the exact message with the wallet's sr25519 key (local)
# 3) enroll once
curl -sS -D - -X POST https://api.flop.network/v1/enroll/wallet \
  -H 'content-type: application/json' \
  -d '{"address":"<SS58>","message":"<CHALLENGE>","signature":"<SIG>"}'
```

**Observed (body):** HTTP **503**
```json
{"error":"wallet_enrollment_cap_reached","message":"The daily wallet enrollment cap is reached; retry later."}
```
No cap value, remaining count, or reset timestamp in the body. Saved artifact did not record response headers, so whether `Retry-After` was sent is unknown.

**Expected:** numeric cap, remaining, and reset (body field and/or `Retry-After`). Say whether the failed call consumed the challenge. Prefer **429** + `Retry-After` over 503 (503 reads as outage).

**Suggested fix:** include `retry_after_seconds` / reset epoch in the error body; send `Retry-After`; document the daily enrollment cap in OpenAPI `/enroll/wallet` 503 and in `https://flop.network/llms.txt`.

**OpenAPI today:** 503 description is only `Daily cap reached (wallet_enrollment_cap_reached) or enrollment unavailable` — no reset semantics.

---

### 2. Expired key gets 401 even on its own receipts; no renewal path

**Status:** **verified** (read-only checks Nov 9 ~2:30 AM ET on the enrolled wallet's stored key).

**Repro:**
```bash
curl -sS -H "Authorization: Bearer <KEY>" https://api.flop.network/v1/keys/me
curl -sS -H "Authorization: Bearer <KEY>" https://api.flop.network/v1/keys/me/receipts
curl -sS -H "Authorization: Bearer <KEY>" \
  https://api.flop.network/v1/keys/me/receipts/<REQUEST_ID>
```

**Observed:** all three → HTTP **401** `api_key_expired`.
Impact: receipt `gen_e1bbc150-…` (0.432 FLOP, last seen `pending` on Nov 7 11:40 AM ET in `first-paid-completion.json`) cannot be rechecked. Today's usage is unknown.

**Expected:** documented key lifetime; a renewal or parent/archive path; read-only receipt access after expiry (or an explicit archival API).

**Docs note (live OpenAPI):** `/keys/me/receipts/{request_id}` says expired/revoked children cannot recover and "This endpoint does not renew credentials". `/enroll/wallet` says re-enroll rotates the bearer only and "a revoked, expired, or exhausted allowance is never renewed." So the gap is real and partly acknowledged — builders still have no way to finish reconciliation after expiry.

**Suggested fix:** allow receipt reads with an expired owner key (read-only), or document a parent/archive lookup; if expired allowances are never renewed, say so in `llms.txt` enrollment section and what operators should do instead.

---

### 3. No documented refuse-before-work guarantee for `max_cost_flop`

**Status:** docs claim **verified**; live refuse-before-work **unverified** (T1 not run; no paid calls).

**OpenAPI:**
- `ChatCompletionRequest.max_cost_flop`: `{type: number, exclusiveMinimum: 0}` — no description that over-cap refuses before work.
- `CompletionRequest.max_cost_flop`: description "Maximum cost in FLOP tokens" only.
- Only documented 402 schema is x402 `payment_required` (price/hash_lock/destination), not an over-budget code.

**Ask:** document that exceeding `max_cost_flop`, child `max_spend`, or parent quota refuses **before** paid work, with the exact error code for each. Live confirm with the approved 0.05 child-key test (not run yet).

---

### 4. Gateway returns 403 to Python's default User-Agent

**Status:** **verified** this turn (harmless GETs). Found by **Anvil**; also hit earlier in `team-gateway-preflight.md`.

**Repro:**
```bash
# works
curl -sS -o /dev/null -w "%{http_code}\n" https://api.flop.network/health
# → 200

# fails (Python urllib default UA is Python-urllib/3.x)
python3 - <<'PY'
import urllib.request
try:
    urllib.request.urlopen("https://api.flop.network/health", timeout=20)
except Exception as e:
    print(getattr(e, "code", None), getattr(e, "read", lambda: b"")()[:80])
PY
# → 403 b'error code: 1010\n'  (Cloudflare)

# works when UA is set
python3 - <<'PY'
import urllib.request
req = urllib.request.Request(
    "https://api.flop.network/health",
    headers={"User-Agent": "curl/8.5.0"},
)
print(urllib.request.urlopen(req, timeout=20).status)
PY
# → 200
```

Same 403/1010 on `GET /v1/models` with the default UA. Anvil's spend guard sets `User-Agent: flop-spend-guard/0` for this reason (`spend-guard/guard.py`).

**Suggested fix:** allow `Python-urllib/*`, or return a JSON body that names the blocked UA instead of bare Cloudflare `error code: 1010`. Document the requirement in `llms.txt` / client quickstarts.

---

### 5. `POST /v1/models/estimate` ignores chat `messages` (counts 0 input tokens)

**Status:** **verified** (Sonar addendum Nov 9 2:45 AM ET; free estimate, no auth).

**Repro:**
```bash
curl -sS -X POST https://api.flop.network/v1/models/estimate \
  -H 'content-type: application/json' \
  -d '{
    "model":"qwen/qwen2.5-0.5b-instruct",
    "messages":[
      {"role":"system","content":"Be brief."},
      {"role":"user","content":"Hi"}
    ],
    "max_tokens":8
  }'
```

**Observed:** `estimated_input_tokens: 0`, `estimated_cost_flop: 0.048` (output-only: 8 × 0.006). The same shape with a `prompt` string is counted; with `messages` only, input (and chat-template tokens) are ignored.

**Impact:** a chat request's estimate undercounts the prompt and template overhead. If `max_cost_flop` (or a local guard) is checked against this estimate, a chat call can pass the cap check and then cost more than planned.

**Expected / ask:** count `messages` plus the chat template in the estimate, **or** document that `/models/estimate` covers only the `prompt` field.

**Related:** Doc mismatch C (template adds ~20–30 tokens when the wrap is supplied as `prompt`). This item is the gap when callers send OpenAI-style `messages` instead.

## Doc mismatches

### A. Enrollment quota: 20,000 vs 25

**Status:** **verified** (both texts live; live remaining quota matches ~20k).

| Source | Exact text |
|---|---|
| `https://flop.network/llms.txt` (Gateway key enrollment) | "Each address gets one allowance: a quota of up to **20,000** devnet FLOP that expires after 24 hours." |
| OpenAPI `POST /enroll/wallet` description | "A new account receives one model-scoped allowance (**default 25 FLOP**, 2 requests/min) that expires within 24 hours, under a daily cap on new allowances." |
| Hermes skill `flop-hermes-devnet/SKILL.md` | "The recommended trial is **20,000** devnet FLOP…" and separately "The ordinary **25-FLOP** enrollment is not enough…" |

Live evidence: `first-paid-completion.json` after a 0.432 charge shows `remaining_quota: 19999.514` → allowance was ~20,000, not 25.

**Suggested fix:** one number in OpenAPI, llms.txt, and Hermes. If 25 is a different product tier, name it.

---

### B. Pricing unit is per token (not stated on the model list)

**Status:** **verified**. Catalog strings `prompt`/`completion` = `"0.006"` for `qwen/qwen2.5-0.5b-instruct`. `POST /v1/models/estimate` with `prompt:"Hi", max_tokens:16` → `estimated_cost_flop: 0.102` = 17 × 0.006.

**Suggested fix:** say "FLOP per token" on `/v1/models` pricing fields.

---

### C. Qwen chat template adds ~20–30 prompt tokens; `max_tokens` only bounds completion

**Status:** **verified** via free estimate (no auth).

| Prompt shape | input tok | output tok | estimated_cost_flop |
|---|---|---|---|
| Raw `Be brief.\nHi`, max_tokens 8 | 3 | 8 | 0.066 |
| Qwen chat wrap (system+user+assistant header), max_tokens 8 | **23** | 8 | **0.186** |

`max_tokens` bounds completion only. Cost guides and samples should use the template-inclusive estimate. Anvil's spend guard pads to **0.186** for this probe; the free cost checker under `cost-checker/` agrees.

---

### D. Sample `max_tokens` 64 (and OpenAPI's 256) exceed a 0.25/tx planning cap

**Status:** **verified** at current 0.006/token pricing.

- Worst case at 0.006/tok: total tokens ≤ **41** fit under 0.25 (41 × 0.006 = 0.246).
- Docs-style prompt `Write a Python function to sort a list` + `max_tokens: 64` → estimate **0.444** (10 + 64 tokens).
- Even 1 prompt + 64 completion = 0.390 > 0.25.
- Live OpenAPI chat/completions/estimate examples use `max_tokens: **256**` (and model `llama-3-70b-instruct`, not in catalog) — worse still.

**Suggested fix:** examples that fit a 0.25 child `max_spend` (tiny prompt, `max_tokens` ≤ ~8–32 on the 0.5B model); use a live catalog slug.

---

### E. `/v1/health` and `/v1/openapi.json` are 404; working paths are `/health` and `/openapi.json`

**Status:** **verified** this turn.

| Path | Result |
|---|---|
| `GET /health` | **200** `{status:ok, version:2.0.0, image:0.1.305, …}` |
| `GET /v1/health` | **404** `not_found` |
| `GET /api/v1/health` | **404** |
| `GET /healthz`, `/ready`, `/status` | **404** |
| `GET /openapi.json` | **200** (live OpenAPI) |
| `GET /v1/openapi.json` | **404** `not_found` |

`https://flop.network/llms.txt` correctly lists `https://api.flop.network/health`. OpenAPI has a **Health** tag but **no health path** in `paths`.

**Suggested fix:** document `/health` and `/openapi.json` in OpenAPI (or add `/v1/health` and `/v1/openapi.json` as aliases).

---

### F. Validator RAM: 32 GB required, 64 GB "comfortable"

**Status:** **verified** both numbers appear; they are not a hard contradiction.

- `https://docs.flop.network/docs/run-validator` — production planning profile: "8 dedicated cores, **32 GB RAM**, 4 TB NVMe…"
- `https://docs.flop.network/docs/miner-and-validator-economics` — "eight physical cores… **32GB ECC RAM**… **64GB of RAM is comfortable rather than required**." Repeated later: "32GB ECC RAM (64GB is comfortable rather than required)".

**Suggested fix:** one table: required vs recommended, same on both pages.

---

### G. Other mismatches (kept from Sonar; spot-checked)

5. OpenAPI example model `llama-3-70b-instruct` is **not** in the live catalog (only `qwen/qwen2.5-0.5b-instruct`, `qwen/qwen3-8b`) — **verified**.
6. OpenAPI lists servers `/api/v1` and `/v1`; estimate works under `/v1/models/estimate` — **verified** earlier / consistent.
7. `POST /connect/grants` lists required field **names only** (no types/ranges); `/keys/ephemeral` is fully typed — **verified** in OpenAPI.
8. `chat/completions` does not document `Idempotency-Key` in parameters; `@flop-labs/client` sends it — kept from prior notes (**not re-audited** client source this turn).

---

## What would help builders most

1. Cap, remaining, and reset time on every quota/cap error (including enrollment).
2. Key lifetime + renewal (or an explicit "never renewed") and receipt reads after expiry.
3. One table: how `max_cost_flop`, child `max_spend`/`uses`, and parent quota interact, and which error fires for each — including refuse-before-work.
4. Allow or document non-browser User-Agents (Python urllib).
5. Cost samples that fit a 0.25 cap, with chat-template overhead called out.
6. `/models/estimate` counts `messages` (plus template), or docs say it is `prompt`-only.

---

## Related local tools (not filed)

- Anvil spend guard (dry-run): `/workspace/flop-agent/spend-guard/` — pads the probe to **0.186**, refuses over cap locally, sets a custom UA.
- PRODY free cost checker: `/workspace/flop-agent/cost-checker/` — same probe quote **0.186**; PASS/FAIL against a cap with no auth and no spend.

