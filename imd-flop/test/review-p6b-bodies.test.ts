/**
 * Review of P6b, attack 1 (C10): the reviewer's own writing of the five request bodies and of the ack's timing rule,
 * from FLOP's SDK 0.6.0 source as read (`transport-http.js` notifyMinerOpen, serveTurn, recordAck,
 * cooperativeCloseBody; `miner-admission.js` fetchSessionInfoProof; `protocol.js` evaluateReceiptTiming;
 * `agent-client.js` buildTurnAck), written before src/miner/requests.ts and timing.ts were read. Then a whole run
 * through the one HTTP file: what C signed for each request is the method, the path and the exact body sent.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ackBody, closeBody, openBody, proofBody, turnBody } from "../src/miner/requests.js";
import { ackTiming } from "../src/miner/timing.js";
import { PAYABLE, turnArgs } from "./lib/miner-run.js";
import { referenceReady } from "./lib/sr25519-reference.js";
import { ackMessage, fetchRig, receiptMessage, referenceVerify, reqMessage, rfromHex, rhex, rhex0x } from "./lib/review-p6b-fetch.js";

beforeAll(referenceReady);

const U64 = (1n << 64n) - 1n;
const U128 = (1n << 128n) - 1n;
const bytes = (n: number, f: (i: number) => number) => Uint8Array.from({ length: n }, (_, i) => f(i) & 0xff);

/** The reviewer's writing of the SDK's bodies. */
const mine = {
  proof: (c: Uint8Array) => JSON.stringify({ challenge: rhex(c) }),
  open: (id: Uint8Array, k: Uint8Array) => JSON.stringify({ channelId: rhex0x(id), agentKey: rhex0x(k) }),
  turn: (id: Uint8Array, input: Uint8Array) => JSON.stringify({ channelId: rhex0x(id), input: rhex0x(input) }),
  ack: (a: { id: Uint8Array; ti: number; leaf: Uint8Array; send: bigint; recv: bigint; sig: Uint8Array; status: string; scored: bigint }) =>
    JSON.stringify({ channelId: rhex0x(a.id), turnIndex: a.ti, leafHash: rhex0x(a.leaf), agentSendMs: a.send.toString(), agentRecvMs: a.recv.toString(), agentSig: rhex0x(a.sig), timingStatus: a.status, scoredLatencyMs: a.scored.toString() }),
  close: (c: { id: Uint8Array; root: Uint8Array; gn: bigint; payable: bigint; sig: Uint8Array; mr: Uint8Array }) =>
    JSON.stringify({ channelId: rhex0x(c.id), finalRoot: rhex0x(c.root), aggregateGn: c.gn.toString(), payable: c.payable.toString(), agentReceiptSig: rhex0x(c.sig), claimedMeasuredRoot: rhex0x(c.mr), transcriptRef: null }),
};

/** evaluateReceiptTiming with the SDK's default bounds (250 + 100), as the reviewer reads it. */
function myTiming(send: bigint, recv: bigint, mRecv: bigint, mDone: bigint, lat: bigint): { status: string; scored: bigint } {
  const observed = recv >= send ? recv - send : 0n;
  const runtime = mDone >= mRecv ? mDone - mRecv : 0n;
  if (recv < send) return { status: "Invalid", scored: 0n };
  if (mDone < mRecv) return { status: "Invalid", scored: 0n };
  if (lat !== runtime) return { status: "Invalid", scored: 0n };
  const pad = 350n;
  if (observed + pad < lat) return { status: "Ambiguous", scored: lat };
  const capped = lat + pad;
  return { status: "Eligible", scored: observed < capped ? observed : capped };
}

const FILLS = [0x00, 0xff, 0x0a, 0xa0];
const IDS = FILLS.map((f) => bytes(32, (i) => f ^ i));

describe("C10 by the reviewer's own writing: the five bodies on a grid", () => {
  it("HOLDS: proof, open and turn, at every edge of their bytes", () => {
    let n = 0;
    for (const id of IDS) {
      expect(proofBody({ challenge: id })).toBe(mine.proof(id));
      for (const k of IDS) {
        expect(openBody({ channelId: id, agentKey: k })).toBe(mine.open(id, k));
        n += 1;
      }
      for (const len of [1, 2, 31, 32, 33, 255, 256, 4096]) for (const f of FILLS) {
        const input = bytes(len, (i) => f + i * 7);
        expect(turnBody({ channelId: id, input })).toBe(mine.turn(id, input));
        n += 1;
      }
    }
    expect(n).toBe(4 * 4 + 4 * 8 * 4);
  });

  it("HOLDS: the ack, at every edge of its numbers and both statuses", () => {
    const times = [0n, 1n, 9n, 10n, (1n << 53n) + 1n, (1n << 63n), U64];
    let n = 0;
    for (const id of IDS.slice(0, 2)) for (const ti of [0, 1, 0xffffffff]) for (const send of times) for (const recv of times) for (const status of ["Eligible", "Ambiguous"] as const) {
      const leaf = bytes(32, (i) => i * 3);
      const sig = bytes(64, (i) => 255 - i);
      const scored = recv;
      const theirs = ackBody({ channelId: id, turnIndex: ti, leafHash: leaf, agentSendMs: send, agentRecvMs: recv, agentSig: sig, timingStatus: status, scoredLatencyMs: scored });
      expect(theirs).toBe(mine.ack({ id, ti, leaf, send, recv, sig, status, scored }));
      n += 1;
    }
    expect(n).toBe(2 * 3 * 7 * 7 * 2);
  });

  it("HOLDS: the close, at every edge of its counts", () => {
    const counts = [0n, 1n, 10n, U64, U64 + 1n, U128];
    let n = 0;
    for (const id of IDS) for (const gn of counts) for (const payable of counts) {
      const root = bytes(32, (i) => i);
      const sig = bytes(64, (i) => i * 5);
      const mr = bytes(32, (i) => 200 - i);
      expect(closeBody({ channelId: id, finalRoot: root, aggregateGn: gn, payable, agentReceiptSig: sig, claimedMeasuredRoot: mr })).toBe(mine.close({ id, root, gn, payable, sig, mr }));
      n += 1;
    }
    expect(n).toBe(4 * 6 * 6);
  });
});

describe("C10 by the reviewer's own writing: the ack's timing rule at each side of each comparison", () => {
  it("HOLDS: equal to the SDK's rule on a grid; Invalid refuses", () => {
    const base = 1_763_100_000_000n;
    const cases: [bigint, bigint, bigint, bigint, bigint][] = [];
    for (const lat of [0n, 1n, 349n, 350n, 351n, 1000n, U64 - 400n]) {
      const mRecv = 5n;
      const mDone = mRecv + lat;
      // observed around lat - 350 (Ambiguous edge) and around lat + 350 (cap edge) and lat
      for (const obs of [0n, 1n, lat, lat - 351n, lat - 350n, lat - 349n, lat + 349n, lat + 350n, lat + 351n, lat + 1000n]) {
        if (obs < 0n || obs > U64 - base) continue;
        cases.push([base, base + obs, mRecv, mDone, lat]);
      }
      // the three Invalid sides
      cases.push([base, base - 1n, mRecv, mDone, lat]);
      cases.push([base, base, mDone + 1n, mDone, lat]);
      cases.push([base, base, mRecv, mDone, lat + 1n]);
      if (lat > 0n) cases.push([base, base, mRecv, mDone, lat - 1n]);
    }
    let n = 0;
    for (const [send, recv, mRecv, mDone, lat] of cases) {
      const want = myTiming(send, recv, mRecv, mDone, lat);
      const run = () => ackTiming({ agentSendMs: send, agentRecvMs: recv, minerRecvMs: mRecv, minerDoneMs: mDone, latencyMs: lat });
      if (want.status === "Invalid") expect(run).toThrow();
      else expect(run()).toEqual({ timingStatus: want.status, scoredLatencyMs: want.scored });
      n += 1;
    }
    expect(n).toBeGreaterThan(50);
  });
});

describe("C10, C2, C3: a whole run through the one HTTP file over a fake fetch", () => {
  it("HOLDS: each call goes to the origin and its path by its method, with exactly the fixed headers, and C signed the method, the path and the exact body sent", async () => {
    const r = fetchRig();
    await r.run.prove();
    await r.run.authenticate({ channelId: r.miner.scenario.channelId });
    await r.run.notifyOpen();
    const t = await r.run.turn(turnArgs());
    const c = await r.run.close({ payable: PAYABLE });
    expect(c.answer.state).toBe("hint");
    expect(r.miner.problems).toEqual([]);
    expect(r.calls).toEqual(["proof", "probe", "info", "open", "turn", "ack", "close"]);
    const want: [string, string][] = [["POST", "/session/info-proof"], ["GET", "/session/info"], ["GET", "/session/info"], ["POST", "/session/open"], ["POST", "/session/turn"], ["POST", "/session/ack"], ["POST", "/session/close"]];
    const pub = r.rec.key.publicKey();
    const id = r.miner.scenario.channelId;
    r.asked.forEach((a, i) => {
      const [method, path] = want[i] as [string, string];
      expect(a.url).toBe(`https://miner.example:8443${path}`);
      expect(a.method).toBe(method);
      expect(a.init.redirect).toBe("error");
      expect(a.init.credentials).toBe("omit");
      const names = Object.keys(a.headers).sort();
      const signedNames = ["x-flop-challenge", "x-flop-channel", "x-flop-nonce", "x-flop-signature", "x-flop-timestamp"];
      const expectNames = ["Accept", ...(a.body === null ? [] : ["Content-Type"]), ...(i <= 1 ? [] : signedNames)].sort();
      expect(names).toEqual(expectNames);
      expect(a.headers.Accept).toBe("application/json");
      if (a.body !== null) expect(a.headers["Content-Type"]).toBe("application/json");
      if (i >= 2) {
        const h = a.headers;
        const msg = reqMessage(h["x-flop-channel"] as string, method, path, a.body ?? "", h["x-flop-timestamp"] as string, h["x-flop-nonce"] as string, h["x-flop-challenge"] as string);
        expect(referenceVerify(pub, msg, rfromHex(h["x-flop-signature"] as string)), `${method} ${path}`).toBe(true);
      }
    });
    // The bodies, by the reviewer's writing, from what C signed and what the run returned.
    expect(r.asked[0]?.body).toBe(mine.proof(new Uint8Array(32).fill(0x5a)));
    expect(r.asked[3]?.body).toBe(mine.open(id, pub));
    const ack = JSON.parse(r.asked[5]?.body as string) as Record<string, string>;
    const timing = myTiming(t.ack.agentSendMs, t.ack.agentRecvMs, t.turn.minerRecvMs, t.turn.minerDoneMs, t.turn.latencyMs);
    expect(r.asked[5]?.body).toBe(mine.ack({ id, ti: 0, leaf: t.turn.leaf, send: t.ack.agentSendMs, recv: t.ack.agentRecvMs, sig: t.ack.signature, status: timing.status, scored: timing.scored }));
    expect(referenceVerify(pub, ackMessage(id, 0, t.turn.leaf, BigInt(ack.agentSendMs as string), BigInt(ack.agentRecvMs as string)), rfromHex(ack.agentSig as string))).toBe(true);
    expect(r.asked[6]?.body).toBe(mine.close({ id, root: t.turn.leaf, gn: t.turn.gN, payable: PAYABLE, sig: c.receipt.signature, mr: r.miner.scenario.identity.measuredRoot }));
    expect(referenceVerify(pub, receiptMessage(id, t.turn.leaf, t.turn.gN, PAYABLE), c.receipt.signature)).toBe(true);
    // C signed five requests, one ack, one receipt.
    expect(r.rec.signed.map((s) => s.kind)).toEqual(["request", "request", "request", "ack", "request", "receipt", "request"]);
  });
});
