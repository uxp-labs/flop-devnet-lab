/**
 * P6b, R2, R5 and M-9: for each fault of the scripted miner, the run stops at that step with its exit code, C signed
 * nothing it should not have, nothing more is sent, and every later step refuses.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { HEX_RUN } from "./lib/miner-answers.js";
import { MONEY, PAYABLE, rig, turnArgs, upTo, type Rig } from "./lib/miner-run.js";
import { TURN_FAULTS, type Switches } from "./lib/scripted-miner.js";
import { referenceReady } from "./lib/sr25519-reference.js";

beforeAll(referenceReady);

type StepName = "prove" | "authenticate" | "notifyOpen" | "turn" | "close";
const ORDER: StepName[] = ["prove", "authenticate", "notifyOpen", "turn", "close"];
const runStep = (r: Rig, s: StepName, money = MONEY) =>
  s === "prove" ? r.run.prove() : s === "authenticate" ? r.run.authenticate({ channelId: r.miner.scenario.channelId }) : s === "notifyOpen" ? r.run.notifyOpen() : s === "turn" ? r.run.turn(turnArgs(money)) : r.run.close({ payable: PAYABLE });

/** Runs the steps before `at`, then `at`, which must refuse; then checks that nothing more is sent and later steps refuse. */
async function stopsAt(sw: Switches, at: StepName, want: { code: number; refusal?: string; calls: string[]; signs: { request: number; ack: number; receipt: number } }, money = MONEY) {
  const r = rig(sw);
  for (const s of ORDER.slice(0, ORDER.indexOf(at))) await runStep(r, s, money);
  const e = await runStep(r, at, money).then(
    () => null,
    (x: unknown) => x as Error & { code: number; refusal: string },
  );
  expect(e, "the step must refuse").not.toBeNull();
  expect(e?.code).toBe(want.code);
  if (want.refusal !== undefined) expect(e?.refusal).toBe(want.refusal);
  expect(e?.message).not.toMatch(HEX_RUN);
  expect(r.miner.seen.map((x) => x.call)).toEqual(want.calls);
  expect(r.signs).toEqual(want.signs);
  for (const later of ORDER) {
    await expect(runStep(r, later, money)).rejects.toThrow(expect.objectContaining({ refusal: "ORDER" }));
  }
  expect(r.miner.seen.map((x) => x.call)).toEqual(want.calls);
  expect(r.signs).toEqual(want.signs);
  expect(r.miner.problems).toEqual([]);
  return e;
}

const NONE = { request: 0, ack: 0, receipt: 0 };

describe("step 1, prove: exit 5 for a refusal, 11 for no answer", () => {
  it("a proof signed by another key: PROOF, exit 5", () => stopsAt({ proofOtherKey: true }, "prove", { code: 5, refusal: "PROOF", calls: ["proof"], signs: NONE }));
  it("a status other than 200: exit 5", () => stopsAt({ status: { proof: 503 } }, "prove", { code: 5, refusal: "ANSWER", calls: ["proof"], signs: NONE }));
  it("garbage: WIRE, exit 5", () => stopsAt({ garbage: "proof" }, "prove", { code: 5, refusal: "WIRE", calls: ["proof"], signs: NONE }));
  it("an answer over its limit: exit 11", () => stopsAt({ oversize: "proof" }, "prove", { code: 11, refusal: "HTTP", calls: ["proof"], signs: NONE }));
  it("no answer: exit 11", () => stopsAt({ fail: "proof" }, "prove", { code: 11, refusal: "HTTP", calls: ["proof"], signs: NONE }));
});

describe("step 2, authenticate: exit 1", () => {
  it("a probe status other than 401", () => stopsAt({ status: { probe: 200 } }, "authenticate", { code: 1, refusal: "ANSWER", calls: ["proof", "probe"], signs: NONE }));
  it("a probe status of 403, which FLOP's CLI takes for paid admission", () => stopsAt({ status: { probe: 403 } }, "authenticate", { code: 1, refusal: "ANSWER", calls: ["proof", "probe"], signs: NONE }));
  it("no challenge header", () => stopsAt({ challenge: null }, "authenticate", { code: 1, refusal: "ANSWER", calls: ["proof", "probe"], signs: NONE }));
  for (const bad of ["AB".repeat(32), "ab".repeat(31), `0x${"ab".repeat(32)}`, `${"ab".repeat(32)} `]) {
    it(`a challenge of another form (${bad.length} characters)`, () => stopsAt({ challenge: bad }, "authenticate", { code: 1, refusal: "ANSWER", calls: ["proof", "probe"], signs: NONE }));
  }
  it("an info that names another account: INFO", () => stopsAt({ infoOtherAccount: true }, "authenticate", { code: 1, refusal: "INFO", calls: ["proof", "probe", "info"], signs: { request: 1, ack: 0, receipt: 0 } }));
  it("an info status other than 200", () => stopsAt({ status: { info: 401 } }, "authenticate", { code: 1, refusal: "ANSWER", calls: ["proof", "probe", "info"], signs: { request: 1, ack: 0, receipt: 0 } }));
  it("an info of garbage", () => stopsAt({ garbage: "info" }, "authenticate", { code: 1, refusal: "WIRE", calls: ["proof", "probe", "info"], signs: { request: 1, ack: 0, receipt: 0 } }));
  it("an info over its limit", () => stopsAt({ oversize: "info" }, "authenticate", { code: 1, refusal: "HTTP", calls: ["proof", "probe", "info"], signs: { request: 1, ack: 0, receipt: 0 } }));
});

describe("step 3, notifyOpen: exit 1", () => {
  it("a status that is not 2xx", () => stopsAt({ status: { open: 500 } }, "notifyOpen", { code: 1, refusal: "ANSWER", calls: ["proof", "probe", "info", "open"], signs: { request: 2, ack: 0, receipt: 0 } }));
  it("no answer", () => stopsAt({ fail: "open" }, "notifyOpen", { code: 1, refusal: "HTTP", calls: ["proof", "probe", "info", "open"], signs: { request: 2, ack: 0, receipt: 0 } }));
  it("any 2xx is taken", async () => {
    const r = rig({ status: { open: 204 } });
    await upTo(r, "notifyOpen");
  });
});

const TURN_CALLS = ["proof", "probe", "info", "open", "turn"];
const TURN_SIGNS = { request: 3, ack: 0, receipt: 0 };

describe("step 4, turn: no ack on a bad turn, exit 1", () => {
  const CHECK: Record<(typeof TURN_FAULTS)[number], string> = {
    leafVersion: "turn.leafVersion",
    turnIndex: "turn.turnIndex",
    hIn: "turn.hIn",
    decodePolicyHash: "turn.decodePolicyHash",
    hIds: "turn.hIds",
    identity: "turn.identity.registryVersion",
    finishReason: "turn.finishReason",
    completionTokens: "turn.completionTokens",
    notUtf8: "turn.output",
    framedOutput: "turn.output",
    hOut: "turn.hOut",
    timingOrder: "turn.timing.order",
    timingLatency: "turn.timing.latency",
    gNOverU64: "turn.gN",
    runningRoot: "turn.runningRoot",
    enclaveSig: "turn.enclaveSig",
    missingProviderField: "turn.promptTokens",
    upperHex: "turn.hOut",
  };
  for (const fault of TURN_FAULTS) {
    const wire = fault === "missingProviderField" || fault === "upperHex";
    it(`the receipt's fault ${fault}: ${wire ? "WIRE" : "TURN"} at ${CHECK[fault]}, no ack`, async () => {
      const e = await stopsAt({ turnFault: fault }, "turn", { code: 1, refusal: wire ? "WIRE" : "TURN", calls: TURN_CALLS, signs: TURN_SIGNS });
      expect((e as unknown as { check: string }).check).toBe(CHECK[fault]);
    });
  }
  it("G_n above the ceiling: MONEY, no ack", () => stopsAt({ gN: MONEY.gnCeiling + 1n }, "turn", { code: 1, refusal: "MONEY", calls: TURN_CALLS, signs: TURN_SIGNS }));
  it("the floor plus the cost above the budget: MONEY, no ack", () => stopsAt({}, "turn", { code: 1, refusal: "MONEY", calls: TURN_CALLS, signs: TURN_SIGNS }, { ...MONEY, budget: 38n * MONEY.pricePerGn + 1n }));
  it("a cost equal to the budget is taken", async () => {
    const r = rig();
    await upTo(r, "notifyOpen");
    await r.run.turn(turnArgs({ ...MONEY, budget: MONEY.floor + 38n * MONEY.pricePerGn + 1n }));
    expect(r.signs.ack).toBe(1);
  });
  it("a turn status other than 200", () => stopsAt({ status: { turn: 429 } }, "turn", { code: 1, refusal: "ANSWER", calls: TURN_CALLS, signs: TURN_SIGNS }));
  it("a turn of garbage", () => stopsAt({ garbage: "turn" }, "turn", { code: 1, refusal: "WIRE", calls: TURN_CALLS, signs: TURN_SIGNS }));
  it("a turn over its limit", () => stopsAt({ oversize: "turn" }, "turn", { code: 1, refusal: "HTTP", calls: TURN_CALLS, signs: TURN_SIGNS }));
  it("no turn answer", () => stopsAt({ fail: "turn" }, "turn", { code: 1, refusal: "HTTP", calls: TURN_CALLS, signs: TURN_SIGNS }));
  it("money of another form refuses before the turn is sent", () => stopsAt({}, "turn", { code: 1, refusal: "BAD_INPUT", calls: ["proof", "probe", "info", "open"], signs: { request: 2, ack: 0, receipt: 0 } }, { ...MONEY, budget: 1 as unknown as bigint }));
  it("an ack not taken: the run stops after the one ack, and no receipt can be signed", () =>
    stopsAt({ status: { ack: 500 } }, "turn", { code: 1, refusal: "ANSWER", calls: [...TURN_CALLS, "ack"], signs: { request: 4, ack: 1, receipt: 0 } }));
  it("no answer to the ack", () => stopsAt({ fail: "ack" }, "turn", { code: 1, refusal: "HTTP", calls: [...TURN_CALLS, "ack"], signs: { request: 4, ack: 1, receipt: 0 } }));

  it("the buyer's clock reversed around the turn: no ack", async () => {
    let t = 10_000n;
    let n = 0;
    // Calls of the clock: info's request, open's request, turn's request, then the send and receive times.
    const r = rig({}, { now: () => (++n === 5 ? (t = 1n) : (t += 1000n)) });
    await upTo(r, "notifyOpen");
    await expect(r.run.turn(turnArgs())).rejects.toThrow(expect.objectContaining({ refusal: "TURN", check: "turn.timing.agent" }));
    expect(r.signs.ack).toBe(0);
    expect(r.miner.seen.map((x) => x.call)).toEqual(TURN_CALLS);
  });
});

describe("step 5, close: no receipt for a payable out of the bounds", () => {
  const CLOSE_SIGNS = { request: 4, ack: 1, receipt: 0 };
  const CLOSE_CALLS = [...TURN_CALLS, "ack"];
  async function closeRefuses(payable: bigint) {
    const r = rig();
    await upTo(r, "turn");
    await expect(r.run.close({ payable })).rejects.toThrow(expect.objectContaining({ refusal: "RECEIPT", code: 1 }));
    expect(r.signs).toEqual(CLOSE_SIGNS);
    expect(r.miner.seen.map((x) => x.call)).toEqual(CLOSE_CALLS);
    await expect(r.run.close({ payable: PAYABLE })).rejects.toThrow(expect.objectContaining({ refusal: "ORDER" }));
    expect(r.signs).toEqual(CLOSE_SIGNS);
  }
  it("a payable of 0", () => closeRefuses(0n));
  it("a payable above the budget", () => closeRefuses(MONEY.budget + 1n));
  it("a payable below the chain's tariff (basePerTurn plus G_n)", () => closeRefuses(38n));
  it("a payable equal to the chain's tariff is signed", async () => {
    const r = rig();
    await upTo(r, "turn");
    const c = await r.run.close({ payable: 39n });
    expect(c.receipt.payable).toBe(39n);
    expect(r.signs.receipt).toBe(1);
  });
});
