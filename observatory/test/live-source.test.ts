// LiveSource over synthetic tapes (fixtures/live-*, each marked synthetic in its meta.json),
// read by the existing networkStatus. Each case states the whole status it must give.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { census } from "../src/census.js";
import { escrowStates } from "../src/escrow.js";
import { LiveSource } from "../src/live-source.js";
import { DEVNET_GENESIS, networkStatus } from "../src/status.js";
import { TapeError, TapeTransport } from "../src/tape.js";
import type { Transport } from "../src/transport.js";
import type { NetworkStatus, Trust } from "../src/types.js";
import { withAnchorAnswer } from "./helpers/tapes.js";

const FIXTURES = new URL("../fixtures/", import.meta.url);
const OTHER = "0x1111111111111111111111111111111111111111111111111111111111111111";
const F = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
const T = (s: string) => `2026-11-11T06:00:${s}Z`;
const LIMITS = { addressCooldownMs: 86400000, dailyCapExemptionConfigured: true, dailyCapFlop: 10000000, ipCooldownMs: 10000, ipGrantsPerDay: 300 };

const tapeOf = (name: string) => TapeTransport.fromFile(new URL(`${name}/tape.jsonl`, FIXTURES).pathname, `tape:${name}`);

/** A transport that answers from a tape but carries another trust, to show trust follows the transport. */
function withTrust(inner: TapeTransport, trust: Trust): Transport {
  return { trust, label: inner.label, rpc: (m, p) => inner.rpc(m, p), httpGet: (u) => inner.httpGet(u), now: () => inner.now(), close: () => inner.close() };
}

/** The status a tape gives: read once, then the snapshot time from the tape's last entry. */
async function statusOf(t: Transport): Promise<NetworkStatus> {
  const source = new LiveSource(t);
  await source.read();
  const now = t.now();
  return networkStatus(source, { pinnedGenesis: DEVNET_GENESIS, now });
}

function healthy(trust: Trust): NetworkStatus {
  return {
    schema: "flop-observatory/network-status@0",
    observed_at: T("01.000"),
    trust,
    genesis: { pinned: DEVNET_GENESIS, faucet: DEVNET_GENESIS, rpc: DEVNET_GENESIS },
    reset_detected: false,
    conflicts: [],
    finalized_height: 3430000,
    finalized_hash: F,
    best_height: 3430002,
    finality_lag: 2,
    runtime_version: 1014014,
    rpc: { health: "ok", http: null, detail: null, observed_at: T("00.400"), stale: false },
    gateway: { health: "ok", http: 200, detail: null, observed_at: T("00.360") },
    faucet: { health: "ok", http: 200, detail: null, observed_at: T("00.120"), ready: true, limits: LIMITS },
  };
}

/** Each scenario and the whole status it must give, written out from the healthy one. */
const CASES: [string, (s: NetworkStatus) => NetworkStatus][] = [
  ["live-healthy", (s) => s],
  [
    "live-other-genesis",
    (s) => ({
      ...s,
      genesis: { ...s.genesis, rpc: OTHER },
      reset_detected: true,
      conflicts: [`faucet genesis ${DEVNET_GENESIS} differs from rpc genesis ${OTHER}`],
    }),
  ],
  [
    "live-faucet-disagrees",
    (s) => ({
      ...s,
      genesis: { ...s.genesis, faucet: OTHER },
      reset_detected: true,
      conflicts: [`faucet genesis ${OTHER} differs from rpc genesis ${DEVNET_GENESIS}`],
    }),
  ],
  [
    "live-rpc-down",
    (s) => ({
      ...s,
      genesis: { ...s.genesis, rpc: null },
      reset_detected: null,
      finalized_height: null,
      finalized_hash: null,
      best_height: null,
      finality_lag: null,
      runtime_version: null,
      rpc: {
        health: "down",
        http: null,
        detail: "chain_getBlockHash(0): rpc socket error; chain_getFinalizedHead(): rpc socket error; chain_getHeader(): rpc socket error",
        observed_at: T("00.400"),
        stale: null,
      },
    }),
  ],
  [
    "live-faucet-down",
    (s) => ({
      ...s,
      genesis: { ...s.genesis, faucet: null },
      reset_detected: null,
      faucet: {
        health: "down",
        http: 503,
        detail: "http 503 with no readable body; read error: the body is not valid JSON; the /chain reading does not count: http 503",
        observed_at: T("00.120"),
        ready: null,
        limits: null,
      },
    }),
  ],
  [
    "live-gateway-down",
    (s) => ({ ...s, gateway: { health: "down", http: 502, detail: "http 502; read error: the body is not valid JSON", observed_at: T("00.360") } }),
  ],
  [
    "live-malformed-header",
    (s) => ({
      ...s,
      reset_detected: null,
      finalized_height: null,
      finalized_hash: null,
      finality_lag: null,
      rpc: { ...s.rpc, health: "degraded", detail: "no valid finalized head" },
    }),
  ],
  ["live-runtime-not-number", (s) => ({ ...s, runtime_version: null })],
  [
    "live-oversize",
    (s) => ({
      ...s,
      reset_detected: null,
      best_height: null,
      finality_lag: null,
      runtime_version: null,
      rpc: {
        ...s.rpc,
        health: "degraded",
        detail:
          "read error: chain_getHeader(): an rpc answer is larger than 1048576 bytes; state_getRuntimeVersion(finalized): an rpc answer is larger than 1048576 bytes; no valid best height",
      },
      gateway: { ...s.gateway, health: "degraded", detail: "read error: the body is larger than 1048576 bytes" },
    }),
  ],
  [
    "live-timeout",
    (s) => ({
      ...s,
      genesis: { ...s.genesis, faucet: null },
      reset_detected: null,
      finalized_height: null,
      finalized_hash: null,
      finality_lag: null,
      runtime_version: null,
      rpc: { ...s.rpc, health: "degraded", detail: "read error: chain_getFinalizedHead(): rpc chain_getFinalizedHead timed out after 15000 ms; no valid finalized head" },
      faucet: { ...s.faucet, detail: "the /chain reading does not count: GET timed out after 15000 ms" },
    }),
  ],
];

describe("LiveSource over synthetic tapes", () => {
  it("every live fixture is a tape marked synthetic, and every one has a case here", () => {
    const dirs = readdirSync(FIXTURES).filter((d) => d.startsWith("live-")).sort();
    expect(dirs).toEqual(CASES.map(([n]) => n).sort());
    for (const d of dirs) {
      const meta = JSON.parse(readFileSync(new URL(`${d}/meta.json`, FIXTURES), "utf8")) as { scenario: string; synthetic: unknown };
      expect([meta.scenario, meta.synthetic], d).toEqual([d, true]);
      expect(readdirSync(new URL(`${d}/`, FIXTURES)).sort(), d).toEqual(["meta.json", "tape.jsonl"]);
    }
  });

  it.each(CASES)("%s gives its whole status, trust fixture, and reads the whole tape", async (name, change) => {
    const t = tapeOf(name);
    expect(await statusOf(t)).toEqual(change(healthy("fixture")));
    expect(t.remaining()).toBe(0);
  });

  it.each(CASES)("%s: the trust is the transport's, and nothing else changes with it", async (name, change) => {
    expect(await statusOf(withTrust(tapeOf(name), "trusted RPC"))).toEqual(change(healthy("trusted RPC")));
  });

  it("is kind rpc, takes its trust and label from the transport, and reads no runtime constants", async () => {
    const s = new LiveSource(tapeOf("live-healthy"));
    expect([s.kind, s.trust, s.label]).toEqual(["rpc", "fixture", "live:tape:live-healthy"]);
    const live = new LiveSource(withTrust(tapeOf("live-healthy"), "trusted RPC"));
    expect(live.trust).toBe("trusted RPC");
    expect(await s.runtimeConstants()).toBeNull();
  });

  it("reads once: every method answers from the one reading, which reads the tape once", async () => {
    const t = tapeOf("live-healthy");
    const s = new LiveSource(t);
    const [a, b] = await Promise.all([s.rpcHead(), s.faucetHealth(), s.faucetChain(), s.gatewayModels(), s.read()]);
    // Only the snapshot clock read is left.
    expect(t.remaining()).toBe(1);
    expect(await s.rpcHead()).toBe(a);
    expect(await s.faucetHealth()).toBe(b);
    expect(t.remaining()).toBe(1);
  });

  it("reads the head at the finalized head, by its hash, in a fixed order", async () => {
    const calls: string[] = [];
    const t = tapeOf("live-healthy");
    const spy: Transport = { ...withTrust(t, "fixture"), rpc: (m, p) => (calls.push(`${m} ${JSON.stringify(p)}`), t.rpc(m, p)) };
    await new LiveSource(spy).read();
    expect(calls).toEqual([
      "system_chain []",
      "chain_getBlockHash [0]",
      "chain_getFinalizedHead []",
      `chain_getHeader ["${F}"]`,
      "chain_getHeader []",
      `state_getRuntimeVersion ["${F}"]`,
    ]);
  });

  describe("the anchor: one earlier finalized block read back by its height, after the head (RULES.md 1.1)", () => {
    // live-healthy is a first run's tape: it holds no anchor call. Each test adds the answer, synthetic.
    const text = () => readFileSync(new URL("live-healthy/tape.jsonl", FIXTURES), "utf8");
    const anchored = (answer: Parameters<typeof withAnchorAnswer>[2]) => TapeTransport.parse(withAnchorAnswer(text(), 3429000, answer), "tape:live-healthy+anchor");

    it("with an anchor, calls chain_getBlockHash at its height after every head call, and only then", async () => {
      const calls: string[] = [];
      const t = anchored({ result: F });
      const spy: Transport = { ...withTrust(t, "fixture"), rpc: (m, p) => (calls.push(`${m} ${JSON.stringify(p)}`), t.rpc(m, p)) };
      const s = new LiveSource(spy, 3429000);
      await s.read();
      expect(calls).toEqual(["system_chain []", "chain_getBlockHash [0]", "chain_getFinalizedHead []", `chain_getHeader ["${F}"]`, "chain_getHeader []", `state_getRuntimeVersion ["${F}"]`, "chain_getBlockHash [3429000]"]);
      expect(await s.anchorBlock()).toEqual({ height: 3429000, hash: F, error: null });
      // Only the snapshot clock read is left.
      expect(t.remaining()).toBe(1);
    });

    it("keeps the answer as given, null included, and a failure on the way as the read's error", async () => {
      for (const [answer, reading] of [
        [{ result: null }, { height: 3429000, hash: null, error: null }],
        [{ result: 42 }, { height: 3429000, hash: 42, error: null }],
        [{ error: "rpc socket error" }, { height: 3429000, hash: null, error: "rpc socket error" }],
      ] as const) {
        const s = new LiveSource(anchored(answer), 3429000);
        expect(await s.anchorBlock()).toEqual(reading);
      }
    });

    it("with none, makes no call and reads none", async () => {
      const t = tapeOf("live-healthy");
      const s = new LiveSource(t);
      await s.read();
      expect([await s.anchorBlock(), t.remaining()]).toEqual([null, 1]);
    });

    it("a tape recorded with no anchor call is never read as one that answered: the replay refuses", async () => {
      await expect(new LiveSource(tapeOf("live-healthy"), 3429000).read()).rejects.toThrow(
        "request 10 is rpc chain_getBlockHash [3429000], but the next one on the tape is the clock",
      );
    });
  });

  it("reads no event pages, so a census is partial over its whole range and every escrow unverified, never no events", async () => {
    const s = new LiveSource(tapeOf("live-healthy"));
    const pages = await s.eventPages();
    expect([pages, await s.eventPageErrors()]).toEqual([[], []]);
    const c = census(pages, { pinnedGenesis: DEVNET_GENESIS, requested: { from_block: 0, to_block: 99 }, observedAt: T("01.000"), trust: s.trust, unreadablePages: await s.eventPageErrors() });
    expect([c.complete, c.status, c.totals_label, c.covered_blocks, c.gaps]).toEqual([false, "partial", "partial", 0, [{ from_block: 0, to_block: 99 }]]);
    const [e] = escrowStates([F], pages, { pinnedGenesis: DEVNET_GENESIS, finalizedHeight: 3430000, observedAt: T("01.000"), trust: s.trust });
    expect([e?.state, e?.evidence]).toEqual(["unverified", []]);
  });

  it("stops on anything but a failed read: a tape that does not match is never read as the RPC being down", async () => {
    const t = TapeTransport.parse(readFileSync(new URL("live-healthy/tape.jsonl", FIXTURES), "utf8").replace('"params":[0]', '"params":[1]'));
    await expect(new LiveSource(t).read()).rejects.toBeInstanceOf(TapeError);
  });
});
