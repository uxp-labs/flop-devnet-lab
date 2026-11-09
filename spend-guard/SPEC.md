# FLOP spend guard: spec v0 (Anvil, 2026-11-09)

Local only. No repo, no posts. This version makes no paid calls and does no sign-ups.

## What it does
1. **Quote first.** Call the free `POST /v1/models/estimate`. Pad the input by the chat template (the Qwen wrap measured 23 tokens against 3 for raw "Be brief.\nHi") so the quote matches what really gets billed.
2. **Refuse before sending.** If the padded quote is over the caller's cap, stop locally and send nothing.
3. **Child key only.** Every paid call goes through `POST /v1/keys/ephemeral` with `uses=1`, `max_spend=<cap>`, one model, and the shortest expiry. The broad sign-up key (up to 20,000 FLOP) only mints child keys and never pays.
4. **No timeout retries.** A timeout or dropped connection doesn't prove no paid work happened. The guard records `spend=unknown`, keeps the request_id, and stops. A resend needs a human or a receipt showing `released`.
5. **Reconcile.** Poll `GET /v1/keys/me/receipts/{request_id}` and report the state as given. `settled_spend: null` stays null and never becomes 0. "Gateway settled" is not "chain final": `terminal_event` can be pooled across several requests and isn't a per-request tx hash.
6. **Ledger.** Append one JSON line per attempt to `ledger.jsonl` with the quote, cap, child-key scope (never the token), request_id, state, and spend. Tokens are never written down.

## States
`quoted, refused_local, minted, sent, timeout_unknown, reserved, estimated, settled, released, error`

## Gateway gaps the guard works around (for the bug report)
- The 503 `wallet_enrollment_cap_reached` error has no reset time or remaining count.
- An expired key gets 401 on its own receipts, so old spend (our 0.432, pending since Nov 7) can't be checked.
- The spec says child keys refuse past `max_spend` before any work, but nobody has verified it yet. That's the 0.05 test.

## Next (each needs a go)
- Live mode. It runs only after the 0.05 refusal test passes on PRODY's wallet.
- Open-sourcing it, after ultrapara reviews.
