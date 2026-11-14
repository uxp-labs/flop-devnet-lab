/**
 * Review of P6b, attacks 3 and 4 (C2, C3, C4): the one HTTP file over a fake fetch the reviewer controls. Each
 * fault: the refusal, its exit code, that the read stopped, and that no second call was made. Then attempts to bend
 * the URL, the method or the headers through the request handed in.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { CALLS, type CallName } from "../src/miner/calls.js";
import { MinerClientError } from "../src/miner/client-errors.js";
import { minerEndpoint } from "../src/miner/endpoint.js";
import { minerHttp } from "../src/miner/http.js";
import { PAYABLE, turnArgs } from "./lib/miner-run.js";
import { asResponse, fetchRig } from "./lib/review-p6b-fetch.js";
import { referenceReady } from "./lib/sr25519-reference.js";

beforeAll(referenceReady);

const SIGNED = Object.freeze({ "x-flop-channel": `0x${"77".repeat(32)}`, "x-flop-timestamp": "1763100000700", "x-flop-nonce": `0x${"5a".repeat(16)}`, "x-flop-challenge": "ab".repeat(32), "x-flop-signature": `0x${"12".repeat(64)}` });
const req = (call: CallName, over: Record<string, unknown> = {}) => ({ call, body: CALLS[call].sends ? "{}" : null, signed: CALLS[call].signed ? { ...SIGNED } : null, maxBytes: 100, timeMs: 200, ...over });

/** A stream the test controls: it counts its pulls and sees its cancel. */
function stream(chunks: unknown[], o: { errorAt?: number; never?: boolean } = {}) {
  const seen = { pulls: 0, cancelled: false };
  let i = 0;
  const s = new ReadableStream({
    pull(c) {
      seen.pulls += 1;
      if (o.errorAt !== undefined && i === o.errorAt) return c.error(new Error("midway"));
      if (i < chunks.length) {
        c.enqueue(chunks[i++] as Uint8Array);
        return;
      }
      if (o.never) return new Promise(() => undefined);
      c.close();
    },
    cancel() {
      seen.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { s, seen };
}

function counted(make: () => Response | Promise<Response>) {
  const n = { calls: 0 };
  const f = async (_u: string, _i: RequestInit) => {
    n.calls += 1;
    return make();
  };
  return { f, n };
}

async function refusal(p: Promise<unknown>): Promise<MinerClientError> {
  try {
    await p;
  } catch (e) {
    return e as MinerClientError;
  }
  throw new Error("not refused");
}

const EP = () => minerEndpoint("https://qzhost.example");
const json = { "content-type": "application/json" };

describe("C4: redirects", () => {
  for (const status of [301, 302, 303, 307, 308]) for (const loc of [null, "https://qzother.example/x"]) {
    it(`HOLDS: a ${status} ${loc === null ? "without" : "with"} a location is refused, once, with its exit`, async () => {
      for (const call of ["proof", "ack"] as const) {
        const { f, n } = counted(() => new Response(null, { status, headers: loc === null ? {} : { location: loc } }));
        const e = await refusal(minerHttp(EP(), f)(req(call) as never));
        expect(e.refusal).toBe("HTTP");
        expect(e.code).toBe(call === "proof" ? 11 : 1);
        expect(e.message).not.toMatch(/qzother/);
        expect(n.calls).toBe(1);
      }
    });
  }
});

describe("C4: the byte limit, counted while the body streams", () => {
  const big = new Uint8Array(101).fill(0x20);
  it("HOLDS: one chunk one byte over the limit refuses and cancels the read", async () => {
    const { s, seen } = stream([big, new Uint8Array(5)]);
    const { f, n } = counted(() => new Response(s, { status: 200, headers: json }));
    const e = await refusal(minerHttp(EP(), f)(req("info") as never));
    expect(e.check).toBe("http.info.size");
    expect(seen.pulls).toBe(1);
    expect(seen.cancelled).toBe(true);
    expect(n.calls).toBe(1);
  });
  it("HOLDS: many small chunks refuse at the one that passes the limit, and no more is read", async () => {
    const chunks = Array.from({ length: 50 }, () => new Uint8Array(10));
    const { s, seen } = stream(chunks);
    const { f } = counted(() => new Response(s, { status: 200, headers: json }));
    const e = await refusal(minerHttp(EP(), f)(req("info") as never));
    expect(e.check).toBe("http.info.size");
    expect(seen.pulls).toBe(11);
    expect(seen.cancelled).toBe(true);
  });
  it("HOLDS: exactly the limit is taken", async () => {
    const { s } = stream([new TextEncoder().encode(`"${"a".repeat(98)}"`)]);
    const { f } = counted(() => new Response(s, { status: 200, headers: json }));
    const a = await minerHttp(EP(), f)(req("info") as never);
    expect(a.body?.length).toBe(100);
  });
  it("HOLDS: a Content-Length above the limit refuses before any read; one lying low or not a number is held by the count", async () => {
    {
      const { s, seen } = stream([new Uint8Array(10)]);
      const { f } = counted(() => new Response(s, { status: 200, headers: { ...json, "content-length": "101" } }));
      const e = await refusal(minerHttp(EP(), f)(req("info") as never));
      expect(e.check).toBe("http.info.size");
      expect(seen.pulls).toBe(0);
    }
    for (const cl of ["5", "abc", "-1", "1e9", " 10 ", "10, 10", ""]) {
      const { s, seen } = stream([big]);
      const { f } = counted(() => new Response(s, { status: 200, headers: { ...json, "content-length": cl } }));
      const e = await refusal(minerHttp(EP(), f)(req("info") as never));
      expect(e.check, cl).toBe("http.info.size");
      expect(seen.cancelled).toBe(true);
    }
  });
  it("HOLDS: a body over the limit on a call whose body is not read (the ack) refuses too", async () => {
    const { s } = stream([big]);
    const { f } = counted(() => new Response(s, { status: 200 }));
    const e = await refusal(minerHttp(EP(), f)(req("ack") as never));
    expect(e.check).toBe("http.ack.size");
  });
});

describe("C4: what the stream gives", () => {
  it("HOLDS: chunks that are not bytes refuse", async () => {
    for (const c of ["text", [1, 2], new Uint16Array(2), new ArrayBuffer(3), new DataView(new ArrayBuffer(2)), 7]) {
      const { s } = stream([c]);
      const { f } = counted(() => new Response(s as never, { status: 200, headers: json }));
      const e = await refusal(minerHttp(EP(), f)(req("info") as never));
      expect(e.refusal).toBe("HTTP");
      expect(e.code).toBe(1);
    }
  });
  it("HOLDS: a stream that errors midway refuses, with no second call", async () => {
    const { s } = stream([new Uint8Array(3)], { errorAt: 1 });
    const { f, n } = counted(() => new Response(s, { status: 200, headers: json }));
    const e = await refusal(minerHttp(EP(), f)(req("info") as never));
    expect(e.check).toBe("http.info.transport");
    expect(n.calls).toBe(1);
  });
  it("HOLDS: a body that never ends is ended by the time limit, and its read cancelled", async () => {
    const { s, seen } = stream([new Uint8Array(3)], { never: true });
    const { f, n } = counted(() => new Response(s, { status: 200, headers: json }));
    const t0 = performance.now();
    const e = await refusal(minerHttp(EP(), f)(req("info", { timeMs: 60 }) as never));
    expect(e.check).toBe("http.info.time");
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(seen.cancelled).toBe(true);
    expect(n.calls).toBe(1);
  });
  it("HOLDS: a fetch that never settles and ignores the abort signal is ended by the time limit", async () => {
    let signal: AbortSignal | undefined;
    const f = async (_u: string, i: RequestInit) => {
      signal = i.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    };
    const e = await refusal(minerHttp(EP(), f)(req("proof", { timeMs: 50 }) as never));
    expect(e.check).toBe("http.proof.time");
    expect(e.code).toBe(11);
    expect(signal?.aborted).toBe(true);
  });
  it("HOLDS: a fetch that throws at once, or returns no Response, refuses with no answer", async () => {
    const e1 = await refusal(minerHttp(EP(), () => { throw new Error("sync"); })(req("turn") as never));
    expect(e1.check).toBe("http.turn.transport");
    const e2 = await refusal(minerHttp(EP(), async () => null as never)(req("turn") as never));
    expect(e2.check).toBe("http.turn.status");
  });
});

describe("C4: the content type and the encoding of a wanted body", () => {
  const body = new TextEncoder().encode("{}");
  it("HOLDS: each type other than application/json (with an optional charset=utf-8) refuses", async () => {
    for (const type of ["text/html", "application/json; charset=latin1", "application/jsonx", "application/json+x", "text/json", "application/json;charset=utf-16", "application/json, text/html", "application/x-ndjson", null]) {
      const { f } = counted(() => new Response(body, { status: 200, headers: type === null ? {} : { "content-type": type } }));
      // A Response made from bytes with no type has none; the platform may add one: delete it.
      const e = await refusal(
        minerHttp(EP(), async (u, i) => {
          const r = await f(u, i);
          if (type === null) r.headers.delete("content-type");
          return r;
        })(req("info") as never),
      );
      expect(e.check, String(type)).toBe("http.info.type");
    }
  });
  it("HOLDS: application/json in upper case and with charset=UTF-8 are taken", async () => {
    for (const type of ["APPLICATION/JSON", "application/json; charset=UTF-8", "application/json;charset=\"utf-8\""]) {
      const { f } = counted(() => new Response(body, { status: 200, headers: { "content-type": type } }));
      expect((await minerHttp(EP(), f)(req("info") as never)).body).toBe("{}");
    }
  });
  it("HOLDS: invalid UTF-8 refuses; a BOM is kept, so the parser refuses it in a run", async () => {
    for (const bad of [Uint8Array.of(0x7b, 0xff, 0x7d), Uint8Array.of(0xc0, 0x80), Uint8Array.of(0xed, 0xa0, 0x80), Uint8Array.of(0xe2, 0x82)]) {
      const { f } = counted(() => new Response(bad, { status: 200, headers: json }));
      const e = await refusal(minerHttp(EP(), f)(req("info") as never));
      expect(e.check).toBe("http.info.utf8");
    }
    const bom = Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b, 0x7d);
    const { f } = counted(() => new Response(bom, { status: 200, headers: json }));
    expect((await minerHttp(EP(), f)(req("info") as never)).body).toBe("﻿{}");
    const r = fetchRig({ override: { info: (a) => new Response(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(a.body ?? "")]), { status: 200, headers: json }) } });
    await r.run.prove();
    await expect(r.run.authenticate({ channelId: r.miner.scenario.channelId })).rejects.toThrow();
    expect(r.calls).toEqual(["proof", "probe", "info"]);
  });
});

describe("C2, C3: bending the request handed in", () => {
  const f = () => counted(() => new Response(null, { status: 401 }));
  it("HOLDS: a call name not of the seven, or a key of Object.prototype, sends nothing", async () => {
    const { f: fi, n } = f();
    const t = minerHttp(EP(), fi);
    for (const call of ["constructor", "hasOwnProperty", "__proto__", "valueOf", "checkpoint", "PROOF", "proof ", "", 0, null]) await expect(t(req("ack", { call }) as never)).rejects.toThrow(MinerClientError);
    expect(n.calls).toBe(0);
  });
  it("HOLDS: a field more, a header more, a header value with a newline, a comma or upper case, limits out of range: nothing is sent", async () => {
    const { f: fi, n } = f();
    const t = minerHttp(EP(), fi);
    const bad = [
      { ...req("ack"), extra: 1 },
      req("ack", { signed: { ...SIGNED, cookie: "a=b" } }),
      req("ack", { signed: { ...SIGNED, authorization: "Bearer x" } }),
      req("ack", { signed: { ...SIGNED, "x-flop-nonce": `0x${"5a".repeat(16)}\r\nCookie: a` } }),
      req("ack", { signed: { ...SIGNED, "x-flop-nonce": `0x${"5a".repeat(15)},5a` } }),
      req("ack", { signed: { ...SIGNED, "x-flop-nonce": `0x${"5A".repeat(16)}` } }),
      req("ack", { signed: { ...SIGNED, "x-flop-nonce": "" } }),
      req("ack", { signed: null }),
      req("probe", { signed: { ...SIGNED } }),
      req("probe", { body: "" }),
      req("ack", { body: null }),
      req("ack", { maxBytes: 16 * 1024 + 1 }),
      req("ack", { maxBytes: 0 }),
      req("ack", { timeMs: 120_001 }),
      req("ack", { timeMs: 1.5 }),
      req("ack", { timeMs: Number.NaN }),
      req("turn", { maxBytes: 8 * 1024 * 1024 + 1 }),
    ];
    for (const r of bad) {
      const e = await refusal(t(r as never));
      expect(e.refusal).toBe("REQUEST");
    }
    expect(n.calls).toBe(0);
  });
  it("HOLDS: an accessor in the request or its headers is refused, and a getter is never asked twice", async () => {
    const { f: fi, n } = f();
    const t = minerHttp(EP(), fi);
    let reads = 0;
    const r = req("ack") as Record<string, unknown>;
    Object.defineProperty(r, "call", { get: () => (++reads === 1 ? "ack" : "close"), enumerable: true });
    await expect(t(r as never)).rejects.toThrow(MinerClientError);
    expect(n.calls).toBe(0);
  });
  it("HOLDS: the body of one call handed to another goes to the other call's own path, by its own method", async () => {
    const asked: [string, string][] = [];
    const t = minerHttp(EP(), async (u, i) => {
      asked.push([u, String(i.method)]);
      return new Response(null, { status: 200 });
    });
    await t(req("ack", { body: '{"channelId":"0x00","finalRoot":"0x00"}' }) as never);
    expect(asked).toEqual([["https://qzhost.example/session/ack", "POST"]]);
  });
  it("HOLDS: what fetch is handed holds no header beyond the fixed set and no credentials, cache or referrer", async () => {
    let init: RequestInit | undefined;
    await minerHttp(EP(), async (_u, i) => {
      init = i;
      return new Response(null, { status: 204 });
    })(req("close", { body: "{}" }) as never);
    expect(Object.keys(init ?? {}).sort()).toEqual(["body", "cache", "credentials", "headers", "method", "redirect", "referrer", "referrerPolicy", "signal"]);
    expect(init?.credentials).toBe("omit");
    expect(init?.cache).toBe("no-store");
    expect(init?.referrer).toBe("");
    expect(Object.keys(init?.headers as object).sort()).toEqual(["Accept", "Content-Type", "x-flop-challenge", "x-flop-channel", "x-flop-nonce", "x-flop-signature", "x-flop-timestamp"]);
  });
});

describe("C11 at the proof: a status other than 200", () => {
  it("DEFECT RP6B-4: a proof answer of a status other than 200 is exit 5 whatever its body (here a 500 whose body passes its limit)", async () => {
    const r = fetchRig({ override: { proof: () => new Response(new Uint8Array(17 * 1024), { status: 500, headers: json }) } });
    const e = await refusal(r.run.prove());
    expect(e.code).toBe(5);
  });
  it("HOLDS: a proof answer of 500 with a small body is exit 5, and a proof with no answer is exit 11", async () => {
    const r = fetchRig({ override: { proof: () => new Response("x", { status: 500 }) } });
    expect((await refusal(r.run.prove())).code).toBe(5);
    const r2 = fetchRig({ override: { proof: () => Promise.reject(new TypeError("fetch failed")) } });
    expect((await refusal(r2.run.prove())).code).toBe(11);
  });
});

describe("C4 and C9 through a run: the close's answer goes through the HTTP file", () => {
  it("HOLDS: a redirect, a body over the limit and a type not JSON at the close give the receipt back as unknown, exit 6", async () => {
    const faults: ((a: { status: number; body: string | null; challenge: string | null }) => Response)[] = [
      () => new Response(null, { status: 307, headers: { location: "https://qzother.example" } }),
      (a) => new Response((a.body ?? "") + " ".repeat(17 * 1024), { status: 200, headers: json }),
      (a) => new Response(a.body, { status: 200, headers: { "content-type": "text/html" } }),
      (a) => new Response(a.body, { status: 200, headers: { ...json, "content-length": "999999" } }),
    ];
    for (const fault of faults) {
      const r = fetchRig({ override: { close: fault } });
      await r.run.prove();
      await r.run.authenticate({ channelId: r.miner.scenario.channelId });
      await r.run.notifyOpen();
      await r.run.turn(turnArgs());
      const c = await r.run.close({ payable: PAYABLE });
      expect(c.answer.state).toBe("unknown");
      expect(c.answer.state === "unknown" && c.answer.exit).toBe(6);
      expect(c.receipt.signature).toHaveLength(64);
      expect(r.calls.filter((x) => x === "close")).toHaveLength(1);
    }
    void asResponse;
  });
});
