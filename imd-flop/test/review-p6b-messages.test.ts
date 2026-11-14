/**
 * Review of P6b, attack 8 (C11): every refusal message and every reason of an unknown close that the reviewer's
 * faults raise, scanned for the prompt's text, the output's text, the endpoint's text, any header value sent, and 16
 * or more hex digits in a row. The whole error is scanned: its message, its stack's first line and its own fields.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { minerEndpoint } from "../src/miner/endpoint.js";
import { MONEY, PAYABLE, turnArgs } from "./lib/miner-run.js";
import { fetchRig, rhex, type FetchRig } from "./lib/review-p6b-fetch.js";
import { TURN_FAULTS, type Switches } from "./lib/scripted-miner.js";
import { referenceReady } from "./lib/sr25519-reference.js";

beforeAll(referenceReady);

type StepName = "prove" | "authenticate" | "notifyOpen" | "turn" | "close";
const ORDER: StepName[] = ["prove", "authenticate", "notifyOpen", "turn", "close"];
const go = (r: FetchRig, s: StepName, payable = PAYABLE) =>
  s === "prove" ? r.run.prove() : s === "authenticate" ? r.run.authenticate({ channelId: r.miner.scenario.channelId }) : s === "notifyOpen" ? r.run.notifyOpen() : s === "turn" ? r.run.turn(turnArgs()) : r.run.close({ payable });

const json = { "content-type": "application/json" };
const ORIGIN = "https://qzendpoint.example:8443";

/** All texts of an error: its message, its first stack line, and every own string field. */
function textsOf(e: unknown): string[] {
  if (!(e instanceof Error)) return [String(e)];
  const out = [e.message, (e.stack ?? "").split("\n")[0] as string];
  for (const k of Object.getOwnPropertyNames(e)) {
    const v = (e as unknown as Record<string, unknown>)[k];
    if (typeof v === "string" && k !== "stack") out.push(v);
  }
  return out;
}

describe("C11 by the reviewer's own scan", () => {
  it("HOLDS: no refusal and no unknown reason holds a prompt, an output, the endpoint, a header value sent or 16 hex digits", async () => {
    const collected: { what: string; text: string; sent: string[] }[] = [];
    const faults: [string, Parameters<typeof fetchRig>[0], StepName][] = [
      ...TURN_FAULTS.map((f) => [`turn ${f}`, { sw: { turnFault: f } as Switches }, "turn"] as [string, Parameters<typeof fetchRig>[0], StepName]),
      ["proof other key", { sw: { proofOtherKey: true } }, "prove"],
      ["proof garbage", { sw: { garbage: "proof" } }, "prove"],
      ["proof 503", { sw: { status: { proof: 503 } } }, "prove"],
      ["proof none", { sw: { fail: "proof" } }, "prove"],
      ["probe 200", { sw: { status: { probe: 200 } } }, "authenticate"],
      ["probe challenge upper", { sw: { challenge: "AB".repeat(32) } }, "authenticate"],
      ["info other", { sw: { infoOtherAccount: true } }, "authenticate"],
      ["info garbage", { sw: { garbage: "info" } }, "authenticate"],
      ["open 500", { sw: { status: { open: 500 } } }, "notifyOpen"],
      ["turn 500", { sw: { status: { turn: 500 } } }, "turn"],
      ["turn garbage", { sw: { garbage: "turn" } }, "turn"],
      ["turn gN", { sw: { gN: 5000n } }, "turn"],
      ["turn oversize", { sw: { oversize: "turn" } }, "turn"],
      ["turn html", { override: { turn: (a) => new Response(a.body, { status: 200, headers: { "content-type": "text/html; Say hello." } }) } }, "turn"],
      ["turn 500 with prompt text", { override: { turn: () => new Response("Say hello. Hello. " + "ab".repeat(40), { status: 500 }) } }, "turn"],
      ["ack 500", { sw: { status: { ack: 500 } } }, "turn"],
      ["ack none", { sw: { fail: "ack" } }, "turn"],
      ["close none", { sw: { fail: "close" } }, "close"],
      ["close 500", { sw: { status: { close: 500 } } }, "close"],
      ["close garbage", { sw: { garbage: "close" } }, "close"],
      ["close other", { sw: { settled: "other" } }, "close"],
      ["close echo", { override: { close: (a) => new Response((a.body ?? "").replace("{", '{"x":"Say hello. Hello.",'), { status: 200, headers: json }) } }, "close"],
      ["close bad settled", { override: { close: () => new Response(JSON.stringify({ settled: { channelId: "Say hello. " + "ab".repeat(32), txHash: "Hello." } }), { status: 200, headers: json }) } }, "close"],
      ["close redirect", { override: { close: () => new Response(null, { status: 302, headers: { location: `${ORIGIN}/x` } }) } }, "close"],
    ];
    for (const [what, o, at] of faults) {
      const r = fetchRig({ ...o, origin: ORIGIN });
      for (const s of ORDER.slice(0, ORDER.indexOf(at))) await go(r, s);
      try {
        const out = await go(r, at);
        if (at === "close") {
          const c = out as Awaited<ReturnType<FetchRig["run"]["close"]>>;
          if (c.answer.state === "unknown") collected.push({ what, text: c.answer.reason, sent: [] });
        }
      } catch (e) {
        for (const t of textsOf(e)) collected.push({ what, text: t, sent: [] });
      }
      const sent = r.asked.flatMap((a) => Object.values(a.headers));
      for (const c of collected) if (c.what === what) c.sent = sent;
    }
    // Refusals of the run's own inputs, with the prompt in them.
    {
      const r = fetchRig({ origin: ORIGIN });
      for (const s of ORDER.slice(0, 3)) await go(r, s);
      try {
        await r.run.turn({ messages: [{ role: "robot" as never, content: "Say hello. Hello." }], maxTokens: 64, money: MONEY });
      } catch (e) {
        for (const t of textsOf(e)) collected.push({ what: "turn input", text: t, sent: [] });
      }
    }
    for (const t of ["http://qzendpoint.example", "https://qzendpoint.example/Say hello."]) {
      try {
        minerEndpoint(t);
      } catch (e) {
        for (const x of textsOf(e)) collected.push({ what: `endpoint ${t}`, text: x, sent: [] });
      }
    }
    expect(collected.length).toBeGreaterThan(45);
    const bad: string[] = [];
    for (const c of collected) {
      if (/Say hello|Hello\./.test(c.text)) bad.push(`${c.what}: prompt or output`);
      if (/qzendpoint/.test(c.text)) bad.push(`${c.what}: endpoint`);
      if (/[0-9a-fA-F]{16,}/.test(c.text)) bad.push(`${c.what}: 16 hex digits`);
      for (const v of c.sent) if (v.length >= 8 && v !== "application/json" && c.text.includes(v.replace(/^0x/, ""))) bad.push(`${c.what}: a header value`);
    }
    expect(bad).toEqual([]);
    void rhex;
  });
});
