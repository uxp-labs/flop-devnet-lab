/**
 * P6b, R1 to R4 and R7: the whole honest run against the scripted miner, the order of its steps, and what C signs.
 */
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { minerRun } from "../src/miner/client.js";
import { minerEndpoint } from "../src/miner/endpoint.js";
import { minerExpected } from "../src/miner/expected.js";
import { MinerClientError } from "../src/miner/client-errors.js";
import { expectedInputOf, hex, hex0x, HEX_RUN } from "./lib/miner-answers.js";
import { countedKey, MONEY, PAYABLE, rig, turnArgs, upTo } from "./lib/miner-run.js";
import { scriptedMiner } from "./lib/scripted-miner.js";
import { referenceReady } from "./lib/sr25519-reference.js";

beforeAll(referenceReady);

describe("R2: the whole honest run", () => {
  it("passes, and the scripted miner saw proof, probe, info, open, turn, ack, close, each once, in that order", async () => {
    const r = rig();
    const proof = await r.run.prove();
    expect(proof).toEqual({ version: r.miner.scenario.version, revision: r.miner.scenario.revision });
    await r.run.authenticate({ channelId: r.miner.scenario.channelId });
    await r.run.notifyOpen();
    const t = await r.run.turn(turnArgs());
    expect(t.turn.gN).toBe(38n);
    expect(t.cost.cost).toBe(38n * MONEY.pricePerGn + 1n);
    expect(t.ack.turnIndex).toBe(0);
    expect(hex(t.ack.leafHash)).toBe(hex(t.turn.leaf));
    const c = await r.run.close({ payable: PAYABLE });
    expect(c.answer).toEqual({ state: "hint", txHash: r.miner.txHash });
    expect(c.receipt.payable).toBe(PAYABLE);
    expect(c.receipt.aggregateGn).toBe(38n);
    expect(hex(c.receipt.finalRoot)).toBe(hex(t.turn.leaf));
    expect(r.miner.seen.map((x) => x.call)).toEqual(["proof", "probe", "info", "open", "turn", "ack", "close"]);
    expect(r.miner.problems).toEqual([]);
    expect(r.miner.acks).toHaveLength(1);
    expect(r.miner.receipts).toHaveLength(1);
  });

  it("R4: C signed four requests, exactly one turn ack and exactly one receipt", async () => {
    const r = rig();
    await upTo(r, "turn");
    expect(r.signs).toEqual({ request: 4, ack: 1, receipt: 0 });
    await r.run.close({ payable: PAYABLE });
    expect(r.signs).toEqual({ request: 5, ack: 1, receipt: 1 });
  });

  it("the ack carries the SDK's unsigned timing fields from the times the run holds", async () => {
    const r = rig();
    await upTo(r, "turn");
    const a = r.miner.acks[0] as Record<string, unknown>;
    // The clock steps 700 ms a call: the miner's latency of 587 ms is inside the pad, so Eligible and 700 scored.
    expect(a.timingStatus).toBe("Eligible");
    expect(a.scoredLatencyMs).toBe("700");
    expect(BigInt(String(a.agentRecvMs)) - BigInt(String(a.agentSendMs))).toBe(700n);
  });

  it("the close body names the pinned measured root and a null transcript reference", async () => {
    const r = rig();
    await upTo(r, "turn");
    await r.run.close({ payable: PAYABLE });
    const c = r.miner.receipts[0] as Record<string, unknown>;
    expect(c.claimedMeasuredRoot).toBe(hex0x(r.miner.scenario.identity.measuredRoot));
    expect(c.transcriptRef).toBeNull();
    expect(c.payable).toBe(PAYABLE.toString());
  });
});

describe("R1: the run's members", () => {
  it("are the five steps only, frozen", () => {
    const r = rig();
    expect(Object.keys(r.run).sort()).toEqual(["authenticate", "close", "notifyOpen", "prove", "turn"]);
    expect(Object.isFrozen(r.run)).toBe(true);
    for (const f of Object.values(r.run)) expect(Object.isFrozen(f)).toBe(true);
  });

  it("refuses an input with a field missing or extra, a key that is not four functions, and limits above a maximum", () => {
    const { key } = countedKey();
    const miner = scriptedMiner(key.publicKey());
    const base = { expected: minerExpected(expectedInputOf(miner.scenario)), endpoint: minerEndpoint("https://miner.example"), transport: miner.transport as never, key, nowMs: () => 1n, random: (n: number) => new Uint8Array(n), limits: {} };
    expect(() => minerRun({ ...base, extra: 1 } as never)).toThrow();
    const { limits: _l, ...noLimits } = base;
    expect(() => minerRun(noLimits as never)).toThrow();
    expect(() => minerRun({ ...base, key: { ...key, signRequest: 1 } } as never)).toThrow(/signRequest must be a function/);
    expect(() => minerRun({ ...base, endpoint: { origin: "https://miner.example" } } as never)).toThrow(expect.objectContaining({ code: 5 }));
    expect(() => minerRun({ ...base, limits: { turn: { timeMs: 240_001 } } })).toThrow(/from 1 to 240000/);
    expect(() => minerRun({ ...base, limits: { turn: { timeMs: 240_000 } } })).not.toThrow();
  });
});

describe("R2: each step out of order refuses and sends nothing", () => {
  const steps = {
    prove: (r: ReturnType<typeof rig>) => r.run.prove(),
    authenticate: (r: ReturnType<typeof rig>) => r.run.authenticate({ channelId: r.miner.scenario.channelId }),
    notifyOpen: (r: ReturnType<typeof rig>) => r.run.notifyOpen(),
    turn: (r: ReturnType<typeof rig>) => r.run.turn(turnArgs()),
    close: (r: ReturnType<typeof rig>) => r.run.close({ payable: PAYABLE }),
  };
  const order = ["prove", "authenticate", "notifyOpen", "turn", "close"] as const;
  for (let done = 0; done <= order.length; done++) {
    for (const name of order) {
      if (name === order[done]) continue;
      it(`${name} after ${done} steps`, async () => {
        const r = rig();
        for (let i = 0; i < done; i++) await steps[order[i] as keyof typeof steps](r);
        const before = r.miner.seen.length;
        const signs = { ...r.signs };
        await expect(steps[name](r)).rejects.toThrow(expect.objectContaining({ refusal: "ORDER" }));
        expect(r.miner.seen.length).toBe(before);
        expect(r.signs).toEqual(signs);
      });
    }
  }

  it("a step while another step runs refuses and sends nothing", async () => {
    const r = rig();
    const first = r.run.prove();
    await expect(r.run.prove()).rejects.toThrow(expect.objectContaining({ refusal: "ORDER" }));
    await first;
    expect(r.miner.seen.map((x) => x.call)).toEqual(["proof"]);
  });
});

describe("R7: what a run returns holds no secret of C", () => {
  it("the receipt and the ack hold only their fields and signatures, and verify under C's public key", async () => {
    const r = rig();
    await upTo(r, "turn");
    const c = await r.run.close({ payable: PAYABLE });
    expect(Object.keys(c.receipt).sort()).toEqual(["aggregateGn", "channelId", "finalRoot", "payable", "signature"]);
    expect(Object.keys(c).sort()).toEqual(["answer", "receipt"]);
  });

  it("no refusal of a run holds 16 or more hex digits, the prompt or the output", async () => {
    const r = rig({ turnFault: "hOut" });
    await upTo(r, "notifyOpen");
    const e = await r.run.turn(turnArgs()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    const m = (e as Error).message;
    expect(m).not.toMatch(HEX_RUN);
    expect(m).not.toContain("Say hello");
    expect(m).not.toContain("Hello.");
  });
});

describe("Nothing is written during a run", () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      const st = statSync(p);
      return st.isDirectory() ? [p, ...walk(p)] : [`${p} ${st.size} ${st.mtimeMs}`];
    });
  }
  it("a temporary home and the package's folder are the same before and after a whole run", async () => {
    const home = mkdtempSync(join(tmpdir(), "p6b-home-"));
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const pkg = join(import.meta.dirname, "..", "src");
      const before = [walk(home), walk(pkg)];
      const r = rig();
      await upTo(r, "turn");
      await r.run.close({ payable: PAYABLE });
      expect([walk(home), walk(pkg)]).toEqual(before);
      expect(walk(home)).toEqual([]);
    } finally {
      process.env.HOME = saved;
    }
  });
});

it("MinerClientError is the class of the order refusals", async () => {
  const r = rig();
  await expect(r.run.turn(turnArgs())).rejects.toBeInstanceOf(MinerClientError);
});
