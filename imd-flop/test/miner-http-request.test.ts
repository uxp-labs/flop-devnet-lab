/**
 * P6b, T1 to T5 and T8: what the one HTTP file asks, over a fake fetch handed in. The URL is the origin and the
 * call's fixed path; the headers are exactly the fixed set; redirect is error, credentials omitted, no cache, no
 * referrer; a request out of its form is refused before anything is sent; one call is one attempt.
 */
import { describe, expect, it } from "vitest";
import { CALLS, CALL_NAMES, PATHS, callLimits, type CallName } from "../src/miner/calls.js";
import { minerEndpoint } from "../src/miner/endpoint.js";
import { minerHttp } from "../src/miner/http.js";

interface Asked {
  url: string;
  init: RequestInit;
}

function fakeFetch(answer: () => Response = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) {
  const asked: Asked[] = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    asked.push({ url, init });
    return answer();
  };
  return { asked, fetchImpl };
}

const SIGNED = Object.freeze({ "x-flop-channel": `0x${"77".repeat(32)}`, "x-flop-timestamp": "1763100000700", "x-flop-nonce": `0x${"5a".repeat(16)}`, "x-flop-challenge": "ab".repeat(32), "x-flop-signature": `0x${"12".repeat(64)}` });

const requestFor = (call: CallName, over: Record<string, unknown> = {}) => ({
  call,
  body: CALLS[call].sends ? '{"a":1}' : null,
  signed: CALLS[call].signed ? { ...SIGNED } : null,
  maxBytes: CALLS[call].maxBytes,
  timeMs: CALLS[call].timeMs,
  ...over,
});

describe("T2: the URL is the origin and the call's fixed path", () => {
  const want: Record<CallName, [string, string]> = {
    proof: ["POST", "/session/info-proof"],
    probe: ["GET", "/session/info"],
    info: ["GET", "/session/info"],
    open: ["POST", "/session/open"],
    turn: ["POST", "/session/turn"],
    ack: ["POST", "/session/ack"],
    close: ["POST", "/session/close"],
  };
  for (const call of CALL_NAMES) {
    it(`${call}: ${want[call].join(" ")}`, async () => {
      const f = fakeFetch(() => new Response(null, { status: call === "probe" ? 401 : 204 }));
      const t = minerHttp(minerEndpoint("https://miner.example:8443/"), f.fetchImpl);
      await t(requestFor(call) as never);
      expect(f.asked).toHaveLength(1);
      expect(f.asked[0]?.url).toBe(`https://miner.example:8443${want[call][1]}`);
      expect(f.asked[0]?.init.method).toBe(want[call][0]);
    });
  }

  it("the six fixed paths are the only ones, and neither checkpoint nor prepare-retirement is one", () => {
    expect([...new Set(CALL_NAMES.map((c) => CALLS[c].path))].sort()).toEqual([...PATHS].sort());
    expect(PATHS).toHaveLength(6);
    expect(PATHS.some((p) => /checkpoint|retirement/.test(p))).toBe(false);
  });

  it("a call that is not one of the seven is refused and nothing is sent", async () => {
    const f = fakeFetch();
    const t = minerHttp(minerEndpoint("https://miner.example"), f.fetchImpl);
    for (const call of ["checkpoint", "prepare-retirement", "/session/checkpoint", "__proto__", "toString"]) {
      await expect(t(requestFor("ack", { call }) as never)).rejects.toThrow(expect.objectContaining({ refusal: "REQUEST" }));
    }
    expect(f.asked).toHaveLength(0);
  });
});

describe("T3: the headers are exactly the fixed set", () => {
  it("a signed POST: Accept, Content-Type and the five signed headers", async () => {
    const f = fakeFetch(() => new Response(null, { status: 200 }));
    await minerHttp(minerEndpoint("https://miner.example"), f.fetchImpl)(requestFor("ack") as never);
    expect(f.asked[0]?.init.headers).toEqual({ Accept: "application/json", "Content-Type": "application/json", ...SIGNED });
    expect(f.asked[0]?.init.body).toBe('{"a":1}');
  });

  it("the proof: Accept and Content-Type only", async () => {
    const f = fakeFetch();
    await minerHttp(minerEndpoint("https://miner.example"), f.fetchImpl)(requestFor("proof") as never);
    expect(f.asked[0]?.init.headers).toEqual({ Accept: "application/json", "Content-Type": "application/json" });
  });

  it("the probe: Accept only, and no body", async () => {
    const f = fakeFetch(() => new Response(null, { status: 401 }));
    await minerHttp(minerEndpoint("https://miner.example"), f.fetchImpl)(requestFor("probe") as never);
    expect(f.asked[0]?.init.headers).toEqual({ Accept: "application/json" });
    expect("body" in (f.asked[0]?.init ?? {})).toBe(false);
  });

  it("the init holds no key but the fixed ones", async () => {
    const f = fakeFetch();
    await minerHttp(minerEndpoint("https://miner.example"), f.fetchImpl)(requestFor("proof") as never);
    expect(Object.keys(f.asked[0]?.init ?? {}).sort()).toEqual(["body", "cache", "credentials", "headers", "method", "redirect", "referrer", "referrerPolicy", "signal"]);
  });

  const extras: [string, Record<string, unknown>][] = [
    ["an extra field (headers)", { headers: { authorization: "Bearer x" } }],
    ["an extra field (cookie)", { cookie: "a=b" }],
  ];
  for (const [what, extra] of extras) {
    it(`a request with ${what} is refused and nothing is sent`, async () => {
      const f = fakeFetch();
      await expect(minerHttp(minerEndpoint("https://miner.example"), f.fetchImpl)({ ...requestFor("ack"), ...extra } as never)).rejects.toThrow(expect.objectContaining({ refusal: "REQUEST" }));
      expect(f.asked).toHaveLength(0);
    });
  }

  const badSigned: [string, Record<string, unknown> | null][] = [
    ["a sixth header (Authorization)", { ...SIGNED, Authorization: "Bearer x" }],
    ["a sixth header (Cookie)", { ...SIGNED, Cookie: "a=b" }],
    ["a sixth header (proxy-authorization)", { ...SIGNED, "proxy-authorization": "x" }],
    ["one of the five missing", { ...SIGNED, "x-flop-nonce": undefined }],
    ["a value with a line break", { ...SIGNED, "x-flop-nonce": "0xab\r\nCookie: a=b" }],
    ["a value in upper case hex", { ...SIGNED, "x-flop-signature": `0x${"AB".repeat(64)}` }],
    ["none on a signed call", null],
  ];
  for (const [what, signed] of badSigned) {
    it(`signed headers with ${what} are refused and nothing is sent`, async () => {
      const f = fakeFetch();
      const s = signed === null ? null : Object.fromEntries(Object.entries(signed).filter(([, v]) => v !== undefined));
      await expect(minerHttp(minerEndpoint("https://miner.example"), f.fetchImpl)(requestFor("ack", { signed: s }) as never)).rejects.toThrow(expect.objectContaining({ refusal: "REQUEST" }));
      expect(f.asked).toHaveLength(0);
    });
  }

  it("signed headers on a call that is not signed are refused", async () => {
    const f = fakeFetch();
    await expect(minerHttp(minerEndpoint("https://miner.example"), f.fetchImpl)(requestFor("proof", { signed: { ...SIGNED } }) as never)).rejects.toThrow(expect.objectContaining({ refusal: "REQUEST" }));
    expect(f.asked).toHaveLength(0);
  });

  it("a body on a GET, and no body on a POST, are refused", async () => {
    const f = fakeFetch();
    const t = minerHttp(minerEndpoint("https://miner.example"), f.fetchImpl);
    await expect(t(requestFor("info", { body: "" }) as never)).rejects.toThrow(expect.objectContaining({ refusal: "REQUEST" }));
    await expect(t(requestFor("turn", { body: null }) as never)).rejects.toThrow(expect.objectContaining({ refusal: "REQUEST" }));
    expect(f.asked).toHaveLength(0);
  });
});

describe("T4: redirect error, credentials omitted, no cache, no referrer", () => {
  it("each call", async () => {
    for (const call of CALL_NAMES) {
      const f = fakeFetch(() => new Response(null, { status: 204 }));
      await minerHttp(minerEndpoint("https://miner.example"), f.fetchImpl)(requestFor(call) as never).catch(() => undefined);
      const init = f.asked[0]?.init as RequestInit;
      expect(init.redirect, call).toBe("error");
      expect(init.credentials, call).toBe("omit");
      expect(init.cache, call).toBe("no-store");
      expect(init.referrer, call).toBe("");
      expect(init.referrerPolicy, call).toBe("no-referrer");
      expect(init.signal, call).toBeInstanceOf(AbortSignal);
    }
  });
});

describe("T5: the limits of a call", () => {
  it("each call's default and its hard maximum, four times the default (M-12)", () => {
    const seconds = Object.fromEntries(CALL_NAMES.map((c) => [c, CALLS[c].timeMs / 1000]));
    expect(seconds).toEqual({ proof: 10, probe: 10, info: 30, open: 30, turn: 60, ack: 30, close: 60 });
    for (const c of CALL_NAMES) expect(CALLS[c].maxTimeMs).toBe(4 * CALLS[c].timeMs);
    const kib = Object.fromEntries(CALL_NAMES.map((c) => [c, CALLS[c].maxBytes / 1024]));
    expect(kib).toEqual({ proof: 16, probe: 16, info: 64, open: 16, turn: 8192, ack: 16, close: 16 });
  });

  it("callLimits gives the defaults, takes a lower limit, and refuses one above the maximum", () => {
    expect(callLimits({}).turn).toEqual({ timeMs: 60_000, maxBytes: 8 * 1024 * 1024 });
    expect(callLimits({ turn: { timeMs: 5 } }).turn).toEqual({ timeMs: 5, maxBytes: 8 * 1024 * 1024 });
    expect(callLimits({ turn: { timeMs: 240_000 } }).turn.timeMs).toBe(240_000);
    expect(() => callLimits({ turn: { timeMs: 240_001 } })).toThrow();
    expect(() => callLimits({ turn: { maxBytes: 8 * 1024 * 1024 + 1 } })).toThrow();
    expect(() => callLimits({ turn: { timeMs: 0 } })).toThrow();
    expect(() => callLimits({ checkpoint: {} } as never)).toThrow();
  });

  it("the transport refuses a request whose limit is above its call's maximum, and sends nothing", async () => {
    const f = fakeFetch();
    const t = minerHttp(minerEndpoint("https://miner.example"), f.fetchImpl);
    await expect(t(requestFor("proof", { timeMs: 40_001 }) as never)).rejects.toThrow(expect.objectContaining({ refusal: "REQUEST" }));
    await expect(t(requestFor("proof", { maxBytes: 16 * 1024 + 1 }) as never)).rejects.toThrow(expect.objectContaining({ refusal: "REQUEST" }));
    expect(f.asked).toHaveLength(0);
  });
});

describe("T8: one call, one attempt", () => {
  it("a fetch that throws is called once, and the call is refused", async () => {
    let n = 0;
    const t = minerHttp(minerEndpoint("https://miner.example"), async () => {
      n += 1;
      throw new Error("connection reset");
    });
    await expect(t(requestFor("turn") as never)).rejects.toThrow(expect.objectContaining({ refusal: "HTTP", code: 1 }));
    expect(n).toBe(1);
  });

  it("a status of 500 is answered once, as a status, not retried", async () => {
    const f = fakeFetch(() => new Response("{}", { status: 500, headers: { "content-type": "application/json" } }));
    const a = await minerHttp(minerEndpoint("https://miner.example"), f.fetchImpl)(requestFor("turn") as never);
    expect(a).toEqual({ status: 500, body: null, challenge: null });
    expect(f.asked).toHaveLength(1);
  });

  it("the proof's failure is exit 11, every other call's is 1", async () => {
    const t = minerHttp(minerEndpoint("https://miner.example"), async () => {
      throw new Error("x");
    });
    await expect(t(requestFor("proof") as never)).rejects.toThrow(expect.objectContaining({ code: 11 }));
    for (const c of CALL_NAMES.filter((x) => x !== "proof")) await expect(t(requestFor(c) as never)).rejects.toThrow(expect.objectContaining({ code: 1 }));
  });
});

describe("T1: the transport is made only for an endpoint value and a fetch function", () => {
  it("refuses a lookalike endpoint (exit 5) and a fetch that is not a function", () => {
    expect(() => minerHttp({ origin: "https://miner.example" }, (async () => new Response()) as never)).toThrow(expect.objectContaining({ code: 5 }));
    expect(() => minerHttp(minerEndpoint("https://miner.example"), "fetch" as never)).toThrow(expect.objectContaining({ refusal: "REQUEST" }));
  });
});
