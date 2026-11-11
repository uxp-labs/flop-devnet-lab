# What a session may never call: a swarm report read from the runtime code

`report.md` is a research report bought from the IMD swarm on 2026-11-11. It is kept here as it was
delivered, byte for byte. It is a lead, not a rule: its `[code]` claims come from a disassembly of
the runtime that we have not rerun ourselves. What our own tests and metadata confirm is listed
below, and so is what they do not.

## Where it came from

- Question: in the FLOP devnet runtime (spec 1014014), how does `FlopSessionKeys` decide what a
  session's delegate may call and spend, and how are `ComputeChannel` payments counted? The pallet
  source is not published, so the answer had to be read out of the runtime code the chain serves.
- IMD job: `8a993c60-141a-49e4-aea6-73b79304bf25` (a written report, `skill: research-report`).
- Paid: 0.5 IMD on Ethereum mainnet, transaction
  `0xf7613ff3c45d84c00006935a2f66e69d5128295a83ba50d3b9b38aeb08967537`.
- Delivered to the public repository `Identity-md/research`, path
  `jobs/8a993c60-141a-49e4-aea6-73b79304bf25/files/artifacts/report.md`, at commit
  `f0ff3c24af5afe7876d323002379fe66d31f9a0d`.
- sha256 of `report.md`: `a7c51bf4c390d5ce3f8e9bce23d34af3cdf3ae869d552c3b2e70f31de8752054`
  (14734 bytes).
- IMD accepted the artifact. IMD says itself that acceptance is not an independent check of the
  claims. The swarm sent no transaction.

## What was delivered, and what was not

- Delivered: answers to parts A (the deny list), B (the spend meter) and C (the order of checks),
  with function indexes and file offsets in the decompressed module.
- Not delivered: part D (how `ComputeChannel` moves money). The report says it ran out of time
  before disassembling that pallet. Our own test in `../2026-11-11-session-escrow/` answers the
  parts of D that matter for a cap.
- Not delivered: the scripts. The report names `scripts/fetch.sh`, `scripts/wasm_sections.py` and
  `scripts/disasm.py`, and the job's manifest lists them as changed files, but only `report.md` was
  published. So the disassembly cannot be rerun from the delivery.
- The job finished about four minutes after it was paid.

## What it says, in short

- **The deny list.** Whatever `allowed_pallets` says, a session can never call these seven pallets:
  `Utility`, `Proxy`, `Multisig`, `Sudo`, `Scheduler`, `EmergencyOverride` and `FlopSessionKeys`
  itself. The refusal is by pallet, not by call, and it is `PalletNotAllowed`. So a batch, a proxy
  call, a multisig call or a nested session call is refused as a whole. Its inner calls are never
  looked at and never let through. A session cannot create, change or revoke a session.
- `Balances` and `System` are not on the deny list. They are refused only when they are not in
  `allowed_pallets`. So a session with an empty allow list (which the chain reads as "all") can
  transfer the owner's funds, up to its caps.
- **The allow list** is matched on the pallet's name as the metadata spells it. The report reads
  the comparison as not sensitive to ASCII case, and is less sure of that.
- **The meter.** The owner's free balance and total balance are read before and after the inner
  call. If either falls by more than the declared `spend_amount`, the call fails with
  `SpendExceedsDeclared` and everything is rolled back. The declared amount is what the counters
  add, and they add it before the call runs. A rise in the owner's balance gives no credit.
- **The order of checks:** the session exists, is not revoked, the nonce matches, it has not
  expired, the limit per call, the cap per day (86400 blocks, reset lazily at the next call), the
  lifetime cap, the deny list, the allow list, the circuit breaker. Then the session record and the
  nonce are written, the call is dispatched, and the balances are compared.
- The whole of it runs in one storage transaction, so a failure leaves nothing but the delegate's
  fee.
- The decompressed runtime is 16823341 bytes with sha256
  `bb19074278e9e14e1a30a8be3399ae5fdb7b5cafbe57e297b49b150502aba2f0`, and it carries a name section
  with 12176 function names. The pallet's crate is `pallet_session_keys`.

## What we confirmed ourselves

From our own recording of the metadata (`observatory` fixture
`recording-20261111160917-3c228907aa129a01`, sha256 `f4fd2add…3444`):

- All seven names on the deny list are pallets of this runtime with calls: `Scheduler` 1,
  `Utility` 30, `Multisig` 31, `Proxy` 32, `Sudo` 50, `FlopSessionKeys` 94, `EmergencyOverride` 99.
  Our question named only four of them. `Scheduler` and `EmergencyOverride` came from the report.
- The constants the report says the code compares are the ASCII of those names: `0x6F647553` is
  "Sudo", the 64 bit number 7451613955223221581 is "Multisig", 7308345369373991763 is "Schedule".
- The doc comment of `execute_via_session` in the metadata says the same about the meter: the
  declared amount is charged against the caps, and it must cover the larger of the fall of the free
  balance and of free plus reserved.

From our own transactions on devnet (`../2026-11-11-session-probe/`, `../2026-11-11-session-escrow/`):

- `System.remark` through a session that allows only `ComputeChannel` fails with
  `PalletNotAllowed`.
- An inner call that moves more than declared fails with `SpendExceedsDeclared`, and the session's
  nonce and counters stay.
- The counters rise by the declared amount, not by what moved (declared 0.012 FLOP, moved 0.01).
- A declared amount above the limit per call fails with `PerTxLimitExceeded`, above the cap per day
  with `DailyCapExceeded`.
- A refund to the owner inside a session call succeeds and lowers no counter.
- The delegate pays the fee, also for a failed call.

## What is not confirmed

- The deny list itself. Nothing we sent tried a denied pallet. It rests on the report's reading of
  the code, and we cannot rerun that reading. One devnet call would settle each entry: a session
  that lists the pallet as allowed, then a call to it through the session, which should fail with
  `PalletNotAllowed`.
- That the allow list ignores case.
- The order of the checks beyond what our failures show.
- The sha256 of the decompressed runtime. We have the hash of the compressed code from the node
  (`0x6d47bb49…44c1df`), not the code itself in this repo.

## What it means for this repo

- The design keeps `ComputeChannel` as the only allowed pallet. It never uses an empty allow list:
  that would let the device transfer the owner's funds up to the caps.
- A session provider in `imd-flop` declares exactly what its call moves, and treats the order of
  checks and the deny list as leads until a test pins them.
- The question to FLOP Labs changes from "which pallets are denied" to "is this the list".
