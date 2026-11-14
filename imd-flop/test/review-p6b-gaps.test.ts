/**
 * Review of P6b, by the second reviewer: two parts of attacks 3 and 4 that no other review test covered.
 * Attack 3: the URL, the method and every header name of every call, recorded under each fault (the bodies test
 * records them for the honest run only).
 * Attack 4: a JSON lone surrogate escape (valid UTF-8 bytes, so the fatal decode takes it) in a wanted answer,
 * through the one HTTP file in a run.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { PAYABLE, turnArgs } from "./lib/miner-run.js";
import { fetchRig, type FetchRig } from "./lib/review-p6b-fetch.js";
import { TURN_FAULTS, type Switches } from "./lib/scripted-miner.js";
import { referenceReady } from "./lib/sr25519-reference.js";

beforeAll(referenceReady);

type StepName = "prove" | "authenticate" | "notifyOpen" | "turn" | "close";
const ORDER: StepName[] = ["prove", "authenticate", "notifyOpen", "turn", "close"];
const go = (r: FetchRig, s: StepName) =>
  s === "prove" ? r.run.prove() : s === "authenticate" ? r.run.authenticate({ channelId: r.miner.scenario.channelId }) : s === "notifyOpen" ? r.run.notifyOpen() : s === "turn" ? r.run.turn(turnArgs()) : r.run.close({ payable: PAYABLE });
const settle = (p: Promise<unknown>) => p.then((v) => ({ v, e: null }), (e: unknown) => ({ v: null, e: e as Error & { code: number } }));

const ORIGIN = "https://qzgaps.example:9443";
/** The reviewer's table: the method of each path. */
const METHOD: Record<string, string> = {
  "/session/info-proof": "POST",
  "/session/info": "GET",
  "/session/open": "POST",
  "/session/turn": "POST",
  "/session/ack": "POST",
  "/session/close": "POST",
};
const SIGNED = ["x-flop-challenge", "x-flop-channel", "x-flop-nonce", "x-flop-signature", "x-flop-timestamp"];
const json = { "content-type": "application/json" };

describe("C2, C3 under each fault: every call fetch is asked", () => {
  it("HOLDS: under each fault of each step, every call goes to the origin and a fixed path by its fixed method, with exactly the fixed headers", async () => {
    const faults: [string, Parameters<typeof fetchRig>[0], StepName][] = [
      ...TURN_FAULTS.map((f) => [`turn ${f}`, { sw: { turnFault: f } as Switches }, "turn"] as [string, Parameters<typeof fetchRig>[0], StepName]),
      ["proof other key", { sw: { proofOtherKey: true } }, "prove"],
      ["proof 503", { sw: { status: { proof: 503 } } }, "prove"],
      ["proof none", { sw: { fail: "proof" } }, "prove"],
      ["probe 200", { sw: { status: { probe: 200 } } }, "authenticate"],
      ["info other", { sw: { infoOtherAccount: true } }, "authenticate"],
      ["info oversize", { sw: { oversize: "info" } }, "authenticate"],
      ["open 500", { sw: { status: { open: 500 } } }, "notifyOpen"],
      ["turn 500", { sw: { status: { turn: 500 } } }, "turn"],
      ["turn oversize", { sw: { oversize: "turn" } }, "turn"],
      ["turn redirect", { override: { turn: () => new Response(null, { status: 307, headers: { location: "https://qzother.example/session/turn" } }) } }, "turn"],
      ["ack 500", { sw: { status: { ack: 500 } } }, "turn"],
      ["ack none", { sw: { fail: "ack" } }, "turn"],
      ["close 500", { sw: { status: { close: 500 } } }, "close"],
      ["close redirect", { override: { close: () => new Response(null, { status: 308, headers: { location: "https://qzother.example/x" } }) } }, "close"],
      ["close other", { sw: { settled: "other" } }, "close"],
    ];
    let calls = 0;
    const bad: string[] = [];
    for (const [what, o, at] of faults) {
      const r = fetchRig({ ...o, origin: ORIGIN });
      for (const s of ORDER.slice(0, ORDER.indexOf(at))) await go(r, s);
      await settle(go(r, at));
      // After the fault, every later step is tried: none may add a call.
      const n = r.asked.length;
      for (const s of ORDER) await settle(go(r, s));
      if (r.asked.length !== n) bad.push(`${what}: a call after the fault`);
      for (const a of r.asked) {
        calls += 1;
        const u = new URL(a.url);
        const path = a.url.slice(ORIGIN.length);
        if (!a.url.startsWith(`${ORIGIN}/`) || u.origin !== ORIGIN) bad.push(`${what}: origin ${u.origin}`);
        if (!(path in METHOD) || u.search !== "" || u.hash !== "") bad.push(`${what}: path ${path}`);
        if (METHOD[path] !== a.method) bad.push(`${what}: method ${a.method} for ${path}`);
        const unsigned = path === "/session/info-proof" || (path === "/session/info" && !("x-flop-signature" in a.headers));
        const want = ["Accept", ...(a.body === null ? [] : ["Content-Type"]), ...(unsigned ? [] : SIGNED)].sort();
        if (JSON.stringify(Object.keys(a.headers).sort()) !== JSON.stringify(want)) bad.push(`${what}: headers ${Object.keys(a.headers).join(",")}`);
        if (a.init.redirect !== "error" || a.init.credentials !== "omit") bad.push(`${what}: redirect or credentials`);
      }
    }
    expect(bad).toEqual([]);
    expect(calls).toBeGreaterThan(80);
  });
});

describe("C4: a lone surrogate escape in a wanted answer, through a run", () => {
  const inject = (body: string | null): string => {
    const b = body ?? "";
    const out = b.replace(/":"0x/, '":"\\ud8000x');
    if (out === b) throw new Error("the test found no field to put the escape in");
    return out;
  };
  const answer = (a: { status: number; body: string | null }) => new Response(inject(a.body), { status: a.status, headers: json });

  it("HOLDS: at the info, authenticate refuses and nothing more is sent", async () => {
    const r = fetchRig({ override: { info: answer } });
    await r.run.prove();
    expect((await settle(r.run.authenticate({ channelId: r.miner.scenario.channelId }))).e).not.toBeNull();
    expect(r.calls).toEqual(["proof", "probe", "info"]);
  });

  it("HOLDS: at the turn, turn refuses and C signs no ack", async () => {
    const r = fetchRig({ override: { turn: answer } });
    for (const s of ORDER.slice(0, 3)) await go(r, s);
    expect((await settle(r.run.turn(turnArgs()))).e).not.toBeNull();
    expect(r.rec.signed.map((s) => s.kind)).not.toContain("ack");
    expect(r.calls).not.toContain("ack");
  });

  it("HOLDS: at the close, the receipt comes back and the state is unknown with exit 6, not a hint", async () => {
    const r = fetchRig({ override: { close: answer } });
    for (const s of ORDER.slice(0, 4)) await go(r, s);
    const c = await r.run.close({ payable: PAYABLE });
    expect(c.receipt.signature).toHaveLength(64);
    expect(c.answer.state).toBe("unknown");
    expect(c.answer.state === "unknown" && c.answer.exit).toBe(6);
  });
});
