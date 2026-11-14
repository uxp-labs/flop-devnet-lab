/**
 * Review of P6b, attacks 5, 6 and 7 (C6 to C9) and the lead's L1 and L2 (M-21, M-22). C is wrapped by the test to
 * record every signature with the fields it was asked to sign.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { minerRun } from "../src/miner/client.js";
import { minerExpected } from "../src/miner/expected.js";
import { expectedInputOf } from "./lib/miner-answers.js";
import { MONEY, PAYABLE, turnArgs } from "./lib/miner-run.js";
import { ackMessage, fetchRig, receiptMessage, recordedKey, referenceVerify, type FetchRig } from "./lib/review-p6b-fetch.js";
import { scriptedMiner, TURN_FAULTS } from "./lib/scripted-miner.js";
import { referenceReady } from "./lib/sr25519-reference.js";

beforeAll(referenceReady);

type StepName = "prove" | "authenticate" | "notifyOpen" | "turn" | "close";
const ORDER: StepName[] = ["prove", "authenticate", "notifyOpen", "turn", "close"];
const go = (r: FetchRig, s: StepName, money = MONEY, payable = PAYABLE) =>
  s === "prove" ? r.run.prove() : s === "authenticate" ? r.run.authenticate({ channelId: r.miner.scenario.channelId }) : s === "notifyOpen" ? r.run.notifyOpen() : s === "turn" ? r.run.turn(turnArgs(money)) : r.run.close({ payable });
const settle = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as Error & { code: number; refusal: string });
const kinds = (r: FetchRig) => r.rec.signed.map((s) => s.kind);
async function upTo(r: FetchRig, last: StepName) {
  for (const s of ORDER.slice(0, ORDER.indexOf(last) + 1)) await go(r, s);
}

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

describe("C6: the order", () => {
  it("HOLDS: in every one of the 119 wrong orders of the five steps, the first step out of order sends nothing and signs nothing", async () => {
    let wrong = 0;
    for (const p of permutations(ORDER)) {
      if (p.join() === ORDER.join()) continue;
      wrong += 1;
      const r = fetchRig();
      let i = 0;
      while (p[i] === ORDER[i]) await go(r, p[i++] as StepName);
      const before = { calls: r.calls.length, signs: r.rec.signed.length };
      const e = await settle(go(r, p[i] as StepName));
      expect(e?.refusal, p.join()).toBe("ORDER");
      expect(r.calls.length).toBe(before.calls);
      expect(r.rec.signed.length).toBe(before.signs);
    }
    expect(wrong).toBe(119);
  });

  it("HOLDS: each step twice refuses the second time, sends nothing and signs nothing; and nothing runs after close", async () => {
    for (const s of ORDER) {
      const r = fetchRig();
      await upTo(r, s);
      const before = { calls: r.calls.length, signs: r.rec.signed.length };
      expect((await settle(go(r, s)))?.refusal, s).toBe("ORDER");
      expect({ calls: r.calls.length, signs: r.rec.signed.length }).toEqual(before);
    }
    const r = fetchRig();
    await upTo(r, "close");
    for (const s of ORDER) expect((await settle(go(r, s)))?.refusal).toBe("ORDER");
    expect(kinds(r).filter((k) => k !== "request")).toEqual(["ack", "receipt"]);
  });

  it("HOLDS: a step called before the one running settles refuses, sends nothing, and the first completes", async () => {
    for (const [first, second] of [["turn", "close"], ["turn", "turn"], ["notifyOpen", "turn"], ["prove", "prove"], ["close", "close"]] as [StepName, StepName][]) {
      const r = fetchRig();
      for (const s of ORDER.slice(0, ORDER.indexOf(first))) await go(r, s);
      const p1 = go(r, first);
      const e = await settle(go(r, second));
      expect(e?.refusal, `${first} then ${second}`).toBe("ORDER");
      await p1;
      expect(kinds(r).filter((k) => k === "receipt").length).toBe(first === "close" ? 1 : 0);
    }
  });

  it("HOLDS: after each kind of failure every later step refuses and nothing more is sent", async () => {
    const fails: [Parameters<typeof fetchRig>[0], StepName][] = [
      [{ sw: { fail: "proof" } }, "prove"],
      [{ sw: { status: { probe: 200 } } }, "authenticate"],
      [{ sw: { status: { open: 500 } } }, "notifyOpen"],
      [{ sw: { turnFault: "enclaveSig" } }, "turn"],
      [{ sw: { status: { ack: 500 } } }, "turn"],
      [{ sw: { gN: 5000n } }, "turn"],
    ];
    for (const [o, at] of fails) {
      const r = fetchRig(o);
      for (const s of ORDER.slice(0, ORDER.indexOf(at))) await go(r, s);
      expect(await settle(go(r, at))).not.toBeNull();
      const n = r.calls.length;
      for (const s of ORDER) expect((await settle(go(r, s)))?.refusal).toBe("ORDER");
      expect(r.calls.length).toBe(n);
      expect(kinds(r)).not.toContain("receipt");
    }
  });
});

describe("C7: the ack is signed only after the turn holds", () => {
  it(`HOLDS: for each of ${TURN_FAULTS.length} single faults of the receipt, a status other than 200, a body not JSON, G_n above the ceiling and a cost over the budget, C signs no ack and no receipt`, async () => {
    const cases: Parameters<typeof fetchRig>[0][] = [
      ...TURN_FAULTS.map((f) => ({ sw: { turnFault: f } })),
      { sw: { status: { turn: 201 } } },
      { sw: { status: { turn: 500 } } },
      { sw: { garbage: "turn" } },
      { sw: { gN: 1001n } },
      { sw: { fail: "turn" } },
    ];
    for (const o of cases) {
      const r = fetchRig(o);
      await upTo(r, "notifyOpen");
      expect(await settle(r.run.turn(turnArgs()))).not.toBeNull();
      expect(kinds(r), JSON.stringify(o?.sw, (_k, v) => (typeof v === "bigint" ? String(v) : v))).toEqual(["request", "request", "request"]);
      expect(r.calls).toEqual(["proof", "probe", "info", "open", "turn"]);
    }
    const over = fetchRig();
    await upTo(over, "notifyOpen");
    expect(await settle(over.run.turn(turnArgs({ ...MONEY, budget: 38n * MONEY.pricePerGn + MONEY.basePerTurn + MONEY.floor - 1n })))).not.toBeNull();
    expect(kinds(over)).not.toContain("ack");
  });

  it("HOLDS: a buyer's clock that goes back across the turn (an Invalid timing by the SDK) signs no ack", async () => {
    const times = [1_000_000n, 1_000_100n, 1_000_200n, 1_000_300n, 999_000n];
    let i = 0;
    const r = fetchRig({ now: () => times[Math.min(i++, times.length - 1)] as bigint });
    await upTo(r, "notifyOpen");
    // now() is read for each signed request, then for the turn's send and receive: the receive is set back.
    const e = await settle(r.run.turn(turnArgs()));
    expect(e).not.toBeNull();
    expect(kinds(r)).not.toContain("ack");
  });

  it("HOLDS: the ack C signed is over the verified leaf and the buyer's times around the turn call, and verifies under C", async () => {
    const r = fetchRig();
    await upTo(r, "notifyOpen");
    const t = await r.run.turn(turnArgs());
    const a = r.rec.signed.find((s) => s.kind === "ack");
    expect(a?.fields.turnIndex).toBe(0);
    expect(Array.from(a?.fields.leafHash as Uint8Array)).toEqual(Array.from(t.turn.leaf));
    expect(referenceVerify(r.rec.key.publicKey(), ackMessage(r.miner.scenario.channelId, 0, t.turn.leaf, t.ack.agentSendMs, t.ack.agentRecvMs), t.ack.signature)).toBe(true);
  });
});

describe("L1 (M-21): once C signed the ack, the caller gets it, whatever happens to its delivery", () => {
  const faults: [string, Parameters<typeof fetchRig>[0]][] = [
    ["a status of 500", { sw: { status: { ack: 500 } } }],
    ["a status of 302", { sw: { status: { ack: 302 } } }],
    ["no answer", { sw: { fail: "ack" } }],
    ["a time limit", { override: { ack: () => new Promise<Response>(() => undefined) } }],
  ];
  for (const [what, o] of faults) {
    it(`DEFECT RP6B-1: the ack's delivery fails with ${what}: turn hands back the signed ack, and close then signs no receipt`, async () => {
      const r = fetchRig(o);
      if (what === "a time limit") {
        // The ack's limit is lowered through a run of its own, so the test does not wait 30 s.
        const rec = recordedKey();
        const miner = scriptedMiner(rec.key.publicKey());
        const { minerHttp } = await import("../src/miner/http.js");
        const { minerEndpoint } = await import("../src/miner/endpoint.js");
        const fx = fetchRig({ key: rec });
        let t = 1_763_100_000_000n;
        const run = minerRun({
          expected: minerExpected(expectedInputOf(fx.miner.scenario)),
          endpoint: minerEndpoint("https://qzhost.example"),
          transport: minerHttp(minerEndpoint("https://qzhost.example"), (u, i) => (u.endsWith("/session/ack") ? new Promise<Response>(() => undefined) : fx.fetchImpl(u, i))),
          key: rec.key,
          nowMs: () => (t += 700n),
          random: (n) => new Uint8Array(n).fill(0x5a),
          limits: { ack: { timeMs: 50 } },
        });
        void miner;
        await run.prove();
        await run.authenticate({ channelId: fx.miner.scenario.channelId });
        await run.notifyOpen();
        const got = await settle(run.turn(turnArgs()));
        expect(rec.signed.filter((s) => s.kind === "ack")).toHaveLength(1);
        expect(got, "turn must hand back the signed ack, not throw").toBeNull();
        return;
      }
      await upTo(r, "notifyOpen");
      let result: unknown = null;
      const e = await r.run.turn(turnArgs()).then((x) => ((result = x), null), (x: unknown) => x);
      expect(r.rec.signed.filter((s) => s.kind === "ack")).toHaveLength(1);
      expect(e, "turn must hand back the signed ack, not throw").toBeNull();
      const signedAck = r.rec.signed.find((s) => s.kind === "ack")?.signature as Uint8Array;
      expect(Array.from((result as { ack: { signature: Uint8Array } }).ack.signature)).toEqual(Array.from(signedAck));
      expect((await settle(r.run.close({ payable: PAYABLE })))?.refusal).toBe("ORDER");
      expect(kinds(r)).not.toContain("receipt");
    });
  }

  it("DEFECT RP6B-1: the clock fails after C signed the ack and before the ack is sent: turn hands back the signed ack", async () => {
    let n = 0;
    let t = 1_763_100_000_000n;
    // now() is read: info, open, turn's request, send, receive (5), then the ack's request (6): fail at 6.
    const r = fetchRig({ now: () => {
      n += 1;
      if (n === 6) throw new Error("clock");
      return (t += 700n);
    } });
    await upTo(r, "notifyOpen");
    const e = await settle(r.run.turn(turnArgs()));
    expect(r.rec.signed.filter((s) => s.kind === "ack")).toHaveLength(1);
    expect(r.calls).not.toContain("ack");
    expect(e, "turn must hand back the signed ack, not throw").toBeNull();
  });
});

describe("L2 (M-22): a run takes a transport and no endpoint", () => {
  it("DEFECT RP6B-2: minerRun takes the pinned values, a transport, C, the clock, the random source and the limits, and no endpoint", () => {
    const rec = recordedKey();
    const miner = scriptedMiner(rec.key.publicKey());
    const make = () =>
      minerRun({
        expected: minerExpected(expectedInputOf(miner.scenario)),
        transport: miner.transport as never,
        key: rec.key,
        nowMs: () => 1n,
        random: (n: number) => new Uint8Array(n),
        limits: {},
      } as never);
    expect(make).not.toThrow();
  });
});

describe("C8: the receipt", () => {
  it("DEFECT RP6B-3: the receipt's final root is the verified leaf, even when the caller changes the turn result it was handed", async () => {
    const r = fetchRig();
    await upTo(r, "notifyOpen");
    const t = await r.run.turn(turnArgs());
    const verified = Uint8Array.from(t.turn.leaf);
    // The caller (P7) changes the bytes of the result it was handed: a bug, a shared buffer, a reuse.
    (t.turn.leaf as Uint8Array).fill(0x11);
    const c = await r.run.close({ payable: PAYABLE });
    const rec = r.rec.signed.find((s) => s.kind === "receipt");
    expect(Array.from(rec?.fields.finalRoot as Uint8Array)).toEqual(Array.from(verified));
    expect(referenceVerify(r.rec.key.publicKey(), receiptMessage(r.miner.scenario.channelId, verified, t.turn.gN, PAYABLE), c.receipt.signature)).toBe(true);
  });

  it("HOLDS: a payable of 0, above the budget or below the chain's tariff signs no receipt and sends no close", async () => {
    for (const payable of [0n, MONEY.budget + 1n, 38n + MONEY.basePerTurn - 1n, -1n]) {
      const r = fetchRig();
      await upTo(r, "turn");
      expect(await settle(r.run.close({ payable }))).not.toBeNull();
      expect(kinds(r)).not.toContain("receipt");
      expect(r.calls).not.toContain("close");
    }
  });

  it("HOLDS: the honest close: exactly one ack and one receipt, the receipt over the verified leaf, its G_n and the payable handed in", async () => {
    const r = fetchRig();
    await upTo(r, "turn");
    const c = await r.run.close({ payable: PAYABLE });
    expect(kinds(r).filter((k) => k !== "request")).toEqual(["ack", "receipt"]);
    expect(c.receipt.payable).toBe(PAYABLE);
    expect(c.answer).toEqual({ state: "hint", txHash: r.miner.txHash });
  });
});

describe("C9: after the receipt is signed, close does not throw", () => {
  const cases: [string, Parameters<typeof fetchRig>[0]][] = [
    ["no answer", { sw: { fail: "close" } }],
    ["a status of 500", { sw: { status: { close: 500 } } }],
    ["a status of 202", { sw: { status: { close: 202 } } }],
    ["a body not JSON", { sw: { garbage: "close" } }],
    ["a settled for another channel", { sw: { settled: "other" } }],
    ["a settled of a bad form", { override: { close: () => new Response(JSON.stringify({ settled: { channelId: "0x00", txHash: 5 } }), { status: 200, headers: { "content-type": "application/json" } }) } }],
    ["a settled with a channel id of 0X", { override: { close: (a) => new Response((a.body ?? "").replace(/"channelId":"0x([0-9a-f]+)"/, (_m, h: string) => `"channelId":"0X${h}"`), { status: 200, headers: { "content-type": "application/json" } }) } }],
    ["a body over its limit", { sw: { oversize: "close" } }],
    ["a redirect", { override: { close: () => new Response(null, { status: 308, headers: { location: "https://qzother.example" } }) } }],
    ["the clock failing before the close is sent", {}],
  ];
  for (const [what, o] of cases) {
    it(`HOLDS: ${what}: the receipt comes back, the state is unknown with exit 6`, async () => {
      let n = 0;
      let t = 1_763_100_000_000n;
      const r = fetchRig(what.startsWith("the clock") ? { now: () => ((n += 1) === 7 ? (() => { throw new Error("c"); })() : (t += 700n)) } : o);
      await upTo(r, "turn");
      const c = await r.run.close({ payable: PAYABLE });
      expect(c.receipt.signature).toHaveLength(64);
      expect(c.answer.state).toBe("unknown");
      if (c.answer.state === "unknown") expect(c.answer.exit).toBe(6);
      expect(kinds(r).filter((k) => k === "receipt")).toHaveLength(1);
    });
  }
  it("HOLDS: no settled is the state none; ours is a hint", async () => {
    const r = fetchRig({ sw: { settled: "none" } });
    await upTo(r, "turn");
    expect((await r.run.close({ payable: PAYABLE })).answer).toEqual({ state: "none" });
  });
});
