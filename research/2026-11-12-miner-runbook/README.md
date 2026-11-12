# Running one FLOP devnet miner on a rented GPU: a swarm report, and what we checked

`report.md` is a research report bought from the IMD swarm on 2026-11-11 and delivered on
2026-11-12. It is kept here as it was delivered, byte for byte. It is a lead, not a rule: almost
all of it is read from FLOP's public pages, and we have not rerun those reads ourselves. What our
own reads confirm is listed below, and so is what they do not.

Nothing here was run on a GPU. No miner was registered and no transaction was sent.

## Where it came from

- Question: in November 2026, what does FLOP require of an operator who runs one GPU miner on
  devnet (spec 1014014) with a public HTTPS session endpoint on a rented cloud GPU, and what does
  it cost and risk?
- Why we asked: our session tests (`../2026-11-11-session-escrow/`,
  `../2026-11-11-session-deny-list/`) show a session can cap what a device key moves through
  `ComputeChannel`. We cannot test that end to end, because no public miner endpoint or session
  offer exists on devnet. A miner of our own might unblock it.
- IMD job: `8adf109a-f694-4221-8c9c-386edf044c29` (a written report, `skill: research-report`).
- Paid: 0.5 IMD on Ethereum mainnet, transaction
  `0xc9a9fa2b63724fc12a84321f5eb68f83ff2b60b33b48d346d3b9a0017e08ce2f`, block 26395029.
- Delivered to the public repository `Identity-md/research`, path
  `jobs/8adf109a-f694-4221-8c9c-386edf044c29/files/artifacts/report.md`, at commit
  `5f2ddf6aca426f04b1d5efca59fcd5d457ad65c9`.
- sha256 of `report.md`: `252fef8647e8e9924a6b3aa45c2cb88736682d29ead71a7ab4738a7e42abaaec`
  (18061 bytes). The delivery's manifest gives the same hash.
- IMD accepted the artifact on structure only. Its own note says acceptance does not establish
  that the claims are right. The swarm sent no transaction.
- Paid 23:39 UTC, delivered 00:22 UTC: about 43 minutes.

## What was delivered, and what was not

- Delivered: all seven parts asked for (A procedure, B hardware, C stake and slashing, D direct
  sessions, E cloud prices, F a runbook, G who runs miners now), each statement marked CONFIRMED,
  INFERRED or UNKNOWN.
- Not delivered: the sources it says it kept "beside this report" (downloaded pages, the raw RPC
  snapshot, `scripts/rpc-snapshot.mjs`). Only `report.md` was published. Its links to
  `/home/imd-worker/...` are paths on the worker's machine and open nothing.
- So the page reads cannot be rerun from the delivery. The chain reads can: see below.

## What it says, in short

- **A miner today does not give a paid session.** The miner guide says paid sessions are not open
  yet, and gateway admission for public miners is unfinished. The session offer list was empty.
- **It may not be runnable from the public pack alone.** The report says the worker and backend
  images must be version and digest pins from an approved release, and that the placeholder in the
  public template is not usable. It lists the image pins and a DA URL among the things only FLOP
  Labs can supply.
- **Hardware.** An NVIDIA GPU with at least 16 GB VRAM, Ubuntu 22.04 or 24.04, Docker, Compose and
  the NVIDIA Container Toolkit, a public DNS name, inbound 80 and 443. FLOP validated one card, an
  A40. The one model is `Qwen/Qwen2.5-0.5B-Instruct` in BF16.
- **Stake.** Sponsorship is automatic: about 1 million test FLOP, owned by the sponsor, plus a small
  fee grant. No invitation is needed while at most 100 sponsored miners are uncalibrated.
- **Risk.** A calibration job not answered within 600 blocks slashes the miner, so the machine has
  to stay up. The stake is the sponsor's test FLOP. Whose loss a slash is, the report does not say.
  The exact slash amounts and constants are not public.
- **Calibration takes about a day**, maybe much longer: 64 verified jobs over at least 600 blocks
  in the source, with a warning that the deployment may ask for 512 jobs over 21,600 blocks.
- **Exit.** Drain, settle, stop the worker, deregister, wait seven days for the sponsored stake to
  go back to the sponsor, then delete the machine.
- **Price.** From about 0.10 USD an hour for a 16 GB card on a marketplace to about 1.29 USD an hour
  for a 24 GB card on a large cloud, before disk, address and traffic. Its cheapest week is about
  17 USD. Its clearest single machine is about 577 EUR a month.
- **FlopSessionKeys.** The report found no public page or repository that mentions
  `execute_via_session` or how a device key maps to a session owner. As far as it could find, the
  tests in this repository are the only public record of how sessions behave.

## What we confirmed ourselves

Read only, through the public RPC, at finalized block 3514668
(`0xa0d28689e28d0ca1726d77eef1897df41d02074792ba380e5780b16c07fd96f0`). The reads are in
`results.json`.

| Claim in section G | Our read |
|---|---|
| `MinerStaking.Miners` holds 242 keys | 242 |
| `HwCalibration.BenchmarkBurstCaps` holds 222 keys | 222 |
| `ModelRegistry.AllowedDecodePolicies` holds 3 keys | 3 |
| The three storage prefixes it prints | the same three, computed with the reference library |

Our own read of the miner guide on 2026-11-11 agrees with the report on these points: no
invitation since 2 November, the cap of 100 uncalibrated sponsored miners, the Qwen model
validated on an A40, inbound 80 and 443, the slash after the 600 block deadline, and paid sessions
not open yet. That read went through a fetch that summarizes the page, so it is a second reading,
not a copy of the page.

## What we read ourselves in FLOP's miner guide (2026-11-12)

The first check we named, the image pins, is done. We read
`https://docs.flop.network/docs/run-miner` ourselves on 2026-11-12, through a fetch that summarizes
the page. It agrees with the report on every point below.

- Paid sessions are not open yet.
- Gateway admission of public miners is still being finished.
- The data availability endpoints are not public yet. The compose file asks for a `DA_URL`, and the
  template holds a placeholder.
- Real pinned images exist for one path only, the Qwen hybrid path: a worker
  `miner-worker-hybrid:v0.1.211` and a backend `miner-vllm-toploc`, each by digest. The guide says
  anonymous access to the hybrid worker image is not yet established.
- The general template holds placeholders (`vX.Y.Z@sha256:REPLACE`). The real values come in a
  reviewed release bundle from the devnet operator or FLOP Labs.
- The validated card is the A40 with `Qwen2.5-0.5B-Instruct` in BF16, on Ubuntu 24.04. The guide
  page gives no minimum GPU memory; the 16 GB figure is the report's, from the pack's README.
- Calibration is 64 verified jobs over at least 600 finalized blocks in the source, and the guide
  warns a deployed devnet may ask for 512 jobs over 21,600 blocks.
- A job not answered by its 600 block deadline expires and the miner is slashed.
- Sponsored stake is about 1 million FLOP, owned by the sponsor, with top ups to 2 million. The
  unbond period is not on that page.

So an outsider cannot count on starting a worker from the public pack alone today. The advice
below stands.

## What we have not checked

- Every price in section E. Prices move, and marketplace prices move by the hour.
- The pack's checksum, the sponsor message format, the model and policy hashes.
- The calibration counts and the stake amounts.
- Whether a 16 GB or 24 GB card passes calibration. FLOP validated only the A40.
- Whether a session opened through `FlopSessionKeys` can be served by a miner. No public source
  says.

## What it means for the lab

- A miner would not close our end to end gap today. The gap is on FLOP's side: paid sessions and
  public miner admission are not open.
- What a miner could give now: a calibrated, reachable worker to aim a direct session at. The
  report marks even that as inferred, not shown.
- So the order is: ask FLOP Labs the open questions first (the image pins, whether a direct session
  to an outside miner settles today, whether a session key may open a channel). Rent a GPU only
  once the answers say a test can finish.
- If a rental is tried before that, it is a one week test on the cheapest 16 GB machine that gives
  a full VM with a public address, with the stop conditions in section F of the report.
