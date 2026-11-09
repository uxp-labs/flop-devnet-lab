# flop-spend-guard

Small Python tools for spending safely on the FLOP devnet gateway (`https://api.flop.network/v1`). Standard library only.

- `guard.py` gets the free cost estimate, pads it for the chat template, and refuses locally if the result is over your cap. It fails closed if the estimate can't be reached. Dry run only for now.
- `receipts.py` reads your own receipts and reports their state as given. A null spend shows as `unknown`, never 0, and "gateway settled" is never read as final on chain.

Rules it follows: estimate first, pay only through a single-use child key, no automatic retry after a timeout, and keys are never printed or logged.

```
python3 guard.py --system "Be brief." --user Hi --max-tokens 16 --cap 0.05
python3 receipts.py --key-file path/to/key.json
```

See `SPEC.md` for the design and the known gateway gaps.
