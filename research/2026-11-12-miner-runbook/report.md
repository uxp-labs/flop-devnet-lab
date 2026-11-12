# FLOP devnet: one public HTTPS GPU miner

**Research cut:** 12 November 2026, Europe/Berlin. Scope is only `tzkv-runtime` spec `1014014`, genesis `0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631`. “CONFIRMED” has adjacent public evidence; “INFERRED” states its basis; “UNKNOWN” is deliberately not guessed. This is devnet research, not earning advice.

## Executive finding

**CONFIRMED —** FLOP documents a persistent Ubuntu 22.04/24.04 Docker/Compose/NVIDIA-Container-Toolkit host, a distinct sr25519 miner account, at least 16 GB VRAM, the public miner pack, a measured BF16 Qwen checkpoint, and a public HTTPS endpoint. Caddy uses inbound 80/443 and forwards to private 8645; a trusted tunnel is an alternative. The worker signs chain/mailbox work and a GPU backend performs inference. [Miner pack README](https://flop.network/releases/cli/miner-pack-devnet-ts-20261106/README.md), read 2026-11-12.

**CONFIRMED —** this does not presently yield a usable public paid miner. The guide says “**Paid sessions are not open yet**”; DA endpoints are still opening and public-miner gateway admission is unfinished. The required indexer `session-offers` response was empty. [Miner guide](https://docs.flop.network/docs/run-miner), read 2026-11-12; retained [offer response](/home/imd-worker/.identitymd/work/8adf109a-f694-4221-8c9c-386edf044c29/307b0a4d-dd26-497d-8781-db2479aee2ea/artifacts/sources/session-offers-now.json).

**CONFIRMED —** major risk is uptime/state loss: a calibration job unanswered beyond 600 blocks “expires and slashes the miner”; preserve signer, session/Ghost keys and worker volume. Published retirement refuses open sessions/disputes, and sponsored stake returns to its sponsor after seven days. Exact slashes/constants are not public. [Miner guide](https://docs.flop.network/docs/run-miner); [retire.mjs](https://flop.network/releases/cli/miner-pack-devnet-ts-20261106/retire.mjs).

## A. Procedure, configuration, on-chain role

**CONFIRMED — preflight/install.** Download `flop-miner-pack-devnet-ts-20261106.tar.gz`, verify SHA-256 `35f222f748447a8aabdd015d94260d8facfd29305691c3cf7ed033cbb2b514b1`, extract in `/opt/flop-miner`, then check RPC/genesis, `nvidia-smi`, Docker/Compose, and Docker GPU access. Generic CLI is `ghcr.io/flop-labs/flop-core/cli:stable` (documented 0.4.0); worker/backend deployment refs must be version-and-digest pins in the approved release. `vX.Y.Z@sha256:REPLACE` is explicitly not usable. [Miner guide](https://docs.flop.network/docs/run-miner).

**CONFIRMED — account/components.** Generate a dedicated sr25519 account with the pack command `zkv-relay key generate --scheme sr25519 --output-type json`; never use validator account or `//Alice`. Make root-only signer and encrypted `miner.json` with `flop keys import`. The miner account signs sponsor request, a private `miner register`, GPU declaration, Ghost/calibration answers, and `minerStaking.deregisterMiner`; worker consumes `MINER_SIGNER_FILE`. `MINER_ENCLAVE_KEY_FILE` is an independent persistent session-signing seed. [Pack README](https://flop.network/releases/cli/miner-pack-devnet-ts-20261106/README.md); [env template](https://flop.network/releases/cli/miner-pack-devnet-ts-20261106/miner.env.example).

**CONFIRMED — sponsor.** Exact message bytes are `flop-sponsor/v1|miner|<genesis hash>|<miner address>|<issuedAt ms>`, signed by miner sr25519 key. POST `{"address":"…","issuedAt":"…","signature":"0x…"}` to `https://faucet.flop.network/sponsor/miner`; an operator grant adds `grant`. Retained `sponsor-request.mjs` obtains genesis, signs and posts this shape. Sponsorship registers the miner—do not run `miner register` afterward—posts about 1m locked test FLOP owned by sponsor, and adds a separate small fee grant. [sponsor-request.mjs](https://flop.network/releases/cli/miner-pack-devnet-ts-20261106/sponsor-request.mjs).

**CONFIRMED — limits/fallback.** Since 2 November no invitation is needed while at most 100 automatic miners are uncalibrated; otherwise 429. Documented limits: 100 miners/rolling 24h, 200m FLOP stake/rolling 24h, one sponsorship/account, six requests/min/address. Read `/limits`, respect `reason`, `action`, `retryAfterSeconds`; no retry loop. `503` means retry later. Private fallback funds **10,000 FLOP base self-stake**, capacity stake, and fees then signs `miner register`; runtime decides exact self/capacity requirements. [Miner guide](https://docs.flop.network/docs/run-miner).

**CONFIRMED — model.** Pre-registered model is `Qwen/Qwen2.5-0.5B-Instruct`, MODEL_HASH `0x1a52c1abe781db051e70ae357f72bb70161ca0c092df0b618f22a9292ba63306`, BF16, revision `7ae557604adf67be50417f59c2c2f167def9a775`, decode-policy hash `0xeca6a3f9c5a9fa1556892182ffef15b1273c075146a2d1a87814ae83ecea3053`. `fetch-model.sh` fetches the revision; `decode-policy.sh` hashes JSON then checks finalized `modelRegistry.allowedDecodePolicies`. The retained runtime-API models response at finalized block 3,514,591 matches model hash, Qwen name, BF16 and measured-root enforcement: it is Qwen, not a guess. [Pack README](https://flop.network/releases/cli/miner-pack-devnet-ts-20261106/README.md); [retained model read](/home/imd-worker/.identitymd/work/8adf109a-f694-4221-8c9c-386edf044c29/307b0a4d-dd26-497d-8781-db2479aee2ea/artifacts/sources/explorer-models.json).

**CONFIRMED — services/HTTPS.** Set RPC `wss://rpc.devnet.flop.network`, mailbox `https://mailbox.devnet.flop.network`, model/hash/BF16/policy, private backend bearer, loopback `SESSION_BIND_IP=127.0.0.1`, 8645, public DNS host and session bearer. Run `./decode-policy.sh miner.env && $C pull && $C up -d`; require backend `/health` to say `model_identity: "measured"`. Caddy needs public DNS and 80/443; otherwise use trusted TLS tunnel to 127.0.0.1:8645. Do not expose backend/raw worker. Outside no-token `/session/info` returns 401; bearer response includes miner/model/calibration/readiness. Compose performs no extrinsic; worker signs declaration, mailbox answers and endpoint ad. [Miner guide](https://docs.flop.network/docs/run-miner).

**CONFIRMED — calibration.** Worker publishes Ghost key and signed endpoint ad; issuer enrols bonded miner and sends jobs. Worker signs answers, measures whole-host throughput and tops capacity stake. Docs specify source requirement 64 verified jobs/at least 600 finalized blocks, warn deployment may require 512/21,600, renewal after eight fresh jobs plus work, seven-day cap expiry, and a day-long process. Pass = `/session/info.is_ready` plus `flop miner status`/`hwCalibration.benchmarkBurstCaps`. **UNKNOWN —** current enforced job count/window and issuer enrollment extrinsic are not public.

## B. Hardware and tiers

**CONFIRMED —** stated minimum is NVIDIA GPU with **at least 16 GB VRAM**, Ubuntu 22.04/24.04, Docker/Compose/NVIDIA toolkit, `jq curl openssl`, persistent storage and public DNS. The validated drill used A40; remote-Pod example says 60 GB disk for Qwen2.5-0.5B. No CPU/RAM minimum, model memory-used figure, or tokens/sec/TOPLOC threshold is stated. [Pack README](https://flop.network/releases/cli/miner-pack-devnet-ts-20261106/README.md); [Miner guide](https://docs.flop.network/docs/run-miner).

**INFERRED —** 16GB and 24GB cards meet published prerequisite but are not confirmed to pass; docs require each card’s own throughput/TOPLOC check and validate only A40. GPU is required for this GPU miner route; CPU worker can only front a remote GPU backend.

**CONFIRMED —** SOFT is default non-confidential route: measured checkpoint/policy and TOPLOC. HARD is specified but “bridge is not deployable”; SOFT full settlement/dispute path remains open. Neither is production-ready. [Miner guide](https://docs.flop.network/docs/run-miner).

## C. Stake, fees, slashing, exit

**CONFIRMED —** initial sponsored stake is “about 1 million FLOP,” top-up cap 2m, fallback self-stake 10,000, capacity stake is measured later, and a fee grant is separate. Sponsor starts 10% commission. Deregistration starts seven-day sponsored unbond back to sponsor. [Miner guide](https://docs.flop.network/docs/run-miner); [retire.mjs](https://flop.network/releases/cli/miner-pack-devnet-ts-20261106/retire.mjs).

**UNKNOWN —** exact chain constants/names/values for base self/capacity stake, fee grant, `ComputeChannel.AckWindow`, `MinForceOpenEscrowForFailedAck`, and `FailedAcks`. Public guide expressly says full stake/cap/renewal/slashing rules are private. Raw V14 metadata was retained but no public decoder/source exposes requested values; do not borrow another runtime’s values.

**CONFIRMED —** known exposure: unanswered calibration >600 blocks slashes. Direct guide says forced open waits AckWindow; it emits `ChannelOpened` (no separate ForceAcked). `expire_force_open` refunds expired PendingAck, `timeout` refunds expired zero-turn Open, and permissionless `finalize` completes force-settle after challenge; fees remain spent. **UNKNOWN —** pallet/error/event/amount for failed attestation, downtime, restart, lost key, failed ack or deadline slash. [Direct guide](https://docs.flop.network/docs/send-to-specific-miner).

**CONFIRMED — clean exit.** Drain/disable matching, retain state until channels/disputes settle, stop worker, run `sudo ./retire.sh` (miner signs `minerStaking.deregisterMiner`), wait finality and sponsor’s seven days, then delete VM/check billing. Script refuses open session, dispute or native delegation. **UNKNOWN —** separate unstake operation/wait for private self/capacity stake; public pack supplies only deregister.

## D. Direct sessions

**CONFIRMED — discovery/open.** Discover endpoint from signed mailbox ad, signed offer (opt-in `SESSION_OFFER_INDEXER_URL`) or explorer offers. CLI shape:

```sh
flop --network devnet --keystore agent.json --password-env FLOP_KEY_PASSWORD session run \
  --miner '<SS58>' --model qwen/qwen2.5-0.5b-instruct --prompt 'Say hello.' \
  --max-flop 0.01 --via auto --endpoint https://host --json
```

`auto` tries offer then `force_open`; `offer` requires match; `force` awaits acknowledgement. SDK is `runDirectSession({api,signer,miner,model,messages,maxFlop,via,endpoint,indexerUrl})`. [Direct guide](https://docs.flop.network/docs/send-to-specific-miner).

**CONFIRMED — auth/lifecycle.** Broker and `/session/info` use `Authorization: Bearer <SESSION_AUTH_TOKEN>`. Direct SDK/local MCP use channel-bound signatures over channel/method/path/body/timestamp/nonce/server challenge; MCP tool `flop_run_session` takes miner/model/prompt/decimal max_flop/via/endpoint/optional auth_token_env. Smallest run: open/ack, verified turn, cooperative settlement or `forceSettle`, then `finalize`; expiry paths above refund. **UNKNOWN —** exact worker route JSON/signature-header shapes; public gateway OpenAPI is gateway bearer API, not worker wire protocol. [OpenAPI](https://api.flop.network/openapi.json); [Direct guide](https://docs.flop.network/docs/send-to-specific-miner).

**CONFIRMED — current gate.** Paid session/DA/public gateway admission are closed. **INFERRED —** on-chain direct calls can still be constructed against calibrated reachable worker because the public CLI documents them, but no source proves outside-miner paid settlement today.

**UNKNOWN — FlopSessionKeys.** Listed public FLOP repos/docs do not mention `execute_via_session`, session owner/device-key mapping or `FlopSessionKeys`; public miner/SDK code is unavailable. Cannot establish whether device key can dispatch ComputeChannel or what code breaks when owner differs from `agent_key`.

## E. Cloud comparison (prices read 2026-11-12)

**INFERRED —** monthly is 730 × listed hourly and excludes disk/IP/egress/tax; each selected SKU still needs FLOP preflight.

| Provider / GPU | hourly → month | full host / endpoint / automation / stopped charge |
|---|---:|---|
| RunPod L4 24GB Pod | $0.44 → $321.20 | **CONFIRMED:** container Pod, not same-host Compose; FLOP says use separate worker + remote backend; bills until terminate. API/public proxy documented. |
| TensorDock RTX A4000 16GB | typical $0.10 GPU → $73 GPU-only | **CONFIRMED:** VM docs, SSH/cloud-init/API; public port eligibility must be checked. Dashboard result: stopped base $0.005/h ($3.65/mo), before resources. |
| Lambda A10 24GB | $1.29 → $941.70 | **CONFIRMED:** published VM SKU/price. **UNKNOWN:** selected-region public IP/cloud-init/API/stopped terms. |
| Scaleway L4-1-24G | €0.79 → €576.70 | **CONFIRMED:** 8 vCPU/48GB GPU instance rate. **UNKNOWN:** selected-SKU public IP/firewall/stop storage terms. |
| OVH rtx5000-28 16GB | $0.60 → $438 | **CONFIRMED:** published public-cloud GPU price. **UNKNOWN:** region-specific provisioning/stopped extras. |
| Vast.ai 16GB offer | dynamic → UNKNOWN | **CONFIRMED:** Docker container, SSH/Jupyter/custom entrypoint/API; therefore nested Compose/stable inbound HTTPS are not assumed. Price is marketplace-variable. |

Sources: [RunPod](https://www.runpod.io/pricing), [TensorDock](https://www.tensordock.com/cloud-gpus.html), [Lambda](https://lambdalabs.com/service/gpu-cloud/pricing), [Scaleway](https://www.scaleway.com/en/pricing/gpu/), [OVH](https://www.ovhcloud.com/en/public-cloud/prices/), [Vast](https://docs.vast.ai/guides/instances/overview).

**INFERRED — recommendation for devnet testing only:** cheapest stated seven-day starting point is TensorDock A4000 ($16.80 GPU-only), only after VM/Docker/public-HTTPS verification. Continuous use: Scaleway L4-1-24G is clearest single public-cloud VM SKU, €576.70 compute/month plus extras, but no FLOP A40-equivalence claim. No rental guarantees calibration or paid work.

## F. Self-contained runbook and kit boundary

1. **CONFIRMED:** compare faucet/RPC genesis, runtime/spec, GPU host/container access, persistent disk, DNS/80/443; read sponsor limits and budget continuous VM time.
2. **CONFIRMED:** verify pack checksum; create/offline-backup separate miner key; import encrypted keystore.
3. **CONFIRMED:** submit one signed sponsorship request; honor refusal guidance. Private route funds first, then `miner register`.
4. **CONFIRMED:** fetch exact Qwen revision; set model, policy, RPC/mailbox, persistent enclave key and private tokens; resolve policy. Stop on missing pinned images/DA values.
5. **CONFIRMED:** start backend and require measured health; start worker/TLS; require external 401 and authenticated session-info; retain endpoint-ad log.
6. **CONFIRMED:** stay up for calibration; daily inspect finalized head, `miner status`, `HwCalibration.BenchmarkBurstCaps`, `/session/info`, TLS, GPU/disk, channels, provider billing. Public paid health test is **UNKNOWN/unavailable**.
7. **CONFIRMED:** drain, settle, stop worker, `retire.sh`, wait finality/unbond, terminate VM and verify invoice.

**CONFIRMED — one-command kit may** perform non-secret preflight, checksum/env validation, Compose lifecycle, TLS/status reads, sponsor-request submission and calibration polling. **It must never** create/export keys, log/read seed/bearers, retain secrets, or sign without owner action. It must fail closed on genesis/image/policy/DA/gateway gates.

## G. Who runs miners at cut; repeatable reads

**CONFIRMED — raw RPC at block 3,514,668 (`0x35a12c`).** Genesis and runtime matched. Storage prefix `MinerStaking.Miners` `0xdf6dc59751a8ca58ebdcde156d51fc383c8312b14d47df66cbccdda7f2601ff7` returned **242** keys. `HwCalibration.BenchmarkBurstCaps` `0x539f98b909cfe8e8302962f85ef79ea25bb3ebca2f8052bb57cc401c9814665f` returned **222**. `ModelRegistry.AllowedDecodePolicies` `0xf44e28338f6c2c13df9858869ef65eaad1d3392c115363088bb00608b8a5f64a` returned three. Exact keys/SCALE values: [snapshot](/home/imd-worker/.identitymd/work/8adf109a-f694-4221-8c9c-386edf044c29/307b0a4d-dd26-497d-8781-db2479aee2ea/artifacts/raw-chain/rpc-storage-snapshot-v2.json); rerun `scripts/rpc-snapshot.mjs`.

**CONFIRMED — indexer view.** `/api/stats` says 242 registered; `/api/calibrations` has 222 Active records. Paged `/api/miners` has 265 historical rows, 242 `isActive`, and 208 rows whose current embedded calibration is Active: this is an indexer representation/timing discrepancy, not a merged metric. Offers = 0. Monitor says it “runs no live probe,” so it cannot establish endpoint count. [Stats](https://explorer.devnet.flop.network/api/stats); [calibrations](https://explorer.devnet.flop.network/api/calibrations?limit=100); [monitor](https://docs.flop.network/monitor?network=devnet).

**UNKNOWN — per-miner served model and endpoint-ad count.** Miner rows lack model/endpoint ad; empty offers do not prove absence of private mailbox ads. Registry contains five models at retained finalized head, including Qwen2.5 BF16, but does not map a model to miner.

## FLOP Labs questions

**UNKNOWN — only FLOP Labs can supply:** reviewed clean-host image pins and DA URL; decoded/current constants/errors/events for stake/slash/AckWindow; paid public admission and direct-worker signature wire spec; FlopSessionKeys device-key compatibility; public model-to-miner/endpoint inventory.

## Source register

**CONFIRMED — read 2026-11-12:** [miner](https://docs.flop.network/docs/run-miner), [operator](https://docs.flop.network/docs/run-operator), [validator](https://docs.flop.network/docs/run-validator), [monitor](https://docs.flop.network/monitor?network=devnet), [direct sessions](https://docs.flop.network/docs/send-to-specific-miner), [pack](https://flop.network/releases/cli/miner-pack-devnet-ts-20261106/), [manifest](https://flop.network/releases.json), [OpenAPI](https://api.flop.network/openapi.json), public [network](https://github.com/flop-labs/network) at `b8a9a88359f2dcf45153e9684650956995a051de`, [yellowpaper](https://github.com/flop-labs/yellowpaper) at retained `artifacts/repos/yellowpaper.COMMIT`, RPC `wss://rpc.devnet.flop.network`, and provider URLs in section E. Downloaded copies, response headers, public repository clones, raw RPC calls and script are retained beside this report.
