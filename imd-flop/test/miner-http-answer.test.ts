/**
 * P6b, T5 to T7: how the one HTTP file reads an answer, over a fake fetch that returns a Response over a stream the
 * test controls. The bytes are bounded while they stream; a Content-Length above the limit refuses with no read;
 * UTF-8 is decoded fatally; a body is wanted only as JSON; a redirect is refused; one time limit ends a call that
 * never answers and one whose body never ends. No refusal carries the body, a header value or the URL.
 */
import { describe, expect, it } from "vitest";
import { CALLS, type CallName } from "../src/miner/calls.js";
import { minerEndpoint } from "../src/miner/endpoint.js";
import { minerHttp } from "../src/miner/http.js";
import { HEX_RUN } from "./lib/miner-answers.js";

const SIGNED = Object.freeze({ "x-flop-channel": `0x${"77".repeat(32)}`, "x-flop-timestamp": "1763100000700", "x-flop-nonce": `0x${"5a".repeat(16)}`, "x-flop-challenge": "ab".repeat(32), "x-flop-signature": `0x${"12".repeat(64)}` });
const requestFor = (call: CallName, over: Record<string, unknown> = {}) => ({
  call,
  body: CALLS[call].sends ? "{}" : null,
  signed: CALLS[call].signed ? { ...SIGNED } : null,
  maxBytes: CALLS[call].maxBytes,
  timeMs: CALLS[call].timeMs,
  ...over,
});

/** A stream the test controls: the chunks handed out one per pull, and how many were pulled. */
function controlled(chunks: Uint8Array[], o: { endless?: boolean } = {}) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (state.pulled < chunks.length) {
        c.enqueue(chunks[state.pulled] as Uint8Array);
        state.pulled += 1;
      } else if (!o.endless) c.close();
      else return new Promise(() => undefined);
    },
    cancel() {
      state.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { stream, state };
}

const JSON_HEADERS = { "content-type": "application/json" };
const transportOf = (res: () => Response | Promise<Response>) => minerHttp(minerEndpoint("https://miner.example"), async () => res());
const enc = new TextEncoder();

async function refusal(p: Promise<unknown>) {
  const e = await p.then(
    () => null,
    (x: unknown) => x as Error & { refusal: string; check: string; code: number },
  );
  expect(e, "must refuse").not.toBeNull();
  expect(e?.message).not.toMatch(HEX_RUN);
  expect(e?.message).not.toContain("miner.example");
  return e as Error & { refusal: string; check: string; code: number };
}

describe("T6: the answer's bytes are bounded while they stream", () => {
  it("a body over the limit refuses before its end is read", async () => {
    const big = new Uint8Array(1024).fill(0x20);
    const s = controlled(Array.from({ length: 100 }, () => big));
    const e = await refusal(transportOf(() => new Response(s.stream, { status: 200, headers: JSON_HEADERS }))(requestFor("turn", { maxBytes: 4096 }) as never));
    expect(e.check).toBe("http.turn.size");
    expect(s.state.pulled).toBeLessThan(10);
    expect(s.state.cancelled).toBe(true);
  });

  it("a body of exactly the limit is taken", async () => {
    const body = `{"a":"${"x".repeat(100 - 8)}"}`;
    expect(enc.encode(body).length).toBe(100);
    const a = await transportOf(() => new Response(body, { status: 200, headers: JSON_HEADERS }))(requestFor("turn", { maxBytes: 100 }) as never);
    expect(a).toEqual({ status: 200, body, challenge: null });
    await refusal(transportOf(() => new Response(body, { status: 200, headers: JSON_HEADERS }))(requestFor("turn", { maxBytes: 99 }) as never));
  });

  it("a Content-Length above the limit refuses with no read", async () => {
    const s = controlled([enc.encode("{}")]);
    const e = await refusal(transportOf(() => new Response(s.stream, { status: 200, headers: { ...JSON_HEADERS, "content-length": "5000" } }))(requestFor("proof", { maxBytes: 4096 }) as never));
    expect(e.check).toBe("http.proof.size");
    expect(s.state.pulled).toBe(0);
  });

  it("a body that is not wanted is still bounded (an ack's answer)", async () => {
    const e = await refusal(transportOf(() => new Response("x".repeat(20_000), { status: 200 }))(requestFor("ack") as never));
    expect(e.check).toBe("http.ack.size");
  });
});

describe("T6: decoding and the content type", () => {
  it("invalid UTF-8 refuses", async () => {
    const e = await refusal(transportOf(() => new Response(Uint8Array.of(0x7b, 0xff, 0x7d), { status: 200, headers: JSON_HEADERS }))(requestFor("info") as never));
    expect(e.check).toBe("http.info.utf8");
  });

  for (const type of ["text/html", "application/x-ndjson", "text/plain; charset=utf-8", "application/json; charset=latin1", "application/jsonx", null]) {
    it(`a content type of ${String(type)} refuses where a body is wanted`, async () => {
      const headers: Record<string, string> = type === null ? {} : { "content-type": type };
      const res = new Response("{}", { status: 200, headers });
      if (type === null) res.headers.delete("content-type");
      const e = await refusal(transportOf(() => res)(requestFor("turn") as never));
      expect(e.check).toBe("http.turn.type");
    });
  }

  for (const type of ["application/json", "application/json; charset=utf-8", "Application/JSON;charset=UTF-8"]) {
    it(`a content type of ${type} is taken`, async () => {
      const a = await transportOf(() => new Response("{}", { status: 200, headers: { "content-type": type } }))(requestFor("close") as never);
      expect(a.body).toBe("{}");
    });
  }

  it("where no body is wanted (open, ack, the probe), the body is neither decoded nor handed back, whatever its type", async () => {
    for (const call of ["open", "ack", "probe"] as const) {
      const a = await transportOf(() => new Response(Uint8Array.of(0xff, 0xfe), { status: call === "probe" ? 401 : 200, headers: { "content-type": "text/html" } }))(requestFor(call) as never);
      expect(a.body, call).toBeNull();
    }
  });

  it("a status other than 200 hands back no body, even to a call that reads one", async () => {
    const a = await transportOf(() => new Response('{"error":"x"}', { status: 400, headers: JSON_HEADERS }))(requestFor("turn") as never);
    expect(a).toEqual({ status: 400, body: null, challenge: null });
  });
});

describe("T4: a redirect is refused", () => {
  for (const status of [301, 302, 303, 307, 308]) {
    it(`status ${status}`, async () => {
      const e = await refusal(transportOf(() => new Response(null, { status, headers: { location: "https://elsewhere.example/" } }))(requestFor("turn") as never));
      expect(e.check).toBe("http.turn.redirect");
      expect(e.message).not.toContain("elsewhere");
    });
  }
});

describe("T1: the one answer header read is the session challenge", () => {
  it("it is handed back as it was sent, and no other header is", async () => {
    const a = await transportOf(() => new Response(null, { status: 401, headers: { "x-flop-session-challenge": "ab".repeat(32), "set-cookie": "a=b" } }))(requestFor("probe") as never);
    expect(a).toEqual({ status: 401, body: null, challenge: "ab".repeat(32) });
  });
  it("an absent challenge is null", async () => {
    const a = await transportOf(() => new Response(null, { status: 401 }))(requestFor("probe") as never);
    expect(a.challenge).toBeNull();
  });
});

describe("T5: one time limit for the whole exchange", () => {
  it("ends a call that never answers, even when the fetch ignores the signal", async () => {
    const t = minerHttp(minerEndpoint("https://miner.example"), () => new Promise<Response>(() => undefined));
    const started = performance.now();
    const e = await refusal(t(requestFor("turn", { timeMs: 30 }) as never));
    expect(e.check).toBe("http.turn.time");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("ends a call whose body never ends", async () => {
    const s = controlled([enc.encode('{"a":')], { endless: true });
    const e = await refusal(transportOf(() => new Response(s.stream, { status: 200, headers: JSON_HEADERS }))(requestFor("turn", { timeMs: 30 }) as never));
    expect(e.check).toBe("http.turn.time");
  });

  it("the signal handed to fetch is aborted when the limit passes", async () => {
    let signal: AbortSignal | undefined;
    const t = minerHttp(minerEndpoint("https://miner.example"), (_u, init) => {
      signal = init.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    await refusal(t(requestFor("ack", { timeMs: 20 }) as never));
    expect(signal?.aborted).toBe(true);
  });

  it("the proof's time limit is exit 11", async () => {
    const t = minerHttp(minerEndpoint("https://miner.example"), () => new Promise<Response>(() => undefined));
    const e = await refusal(t(requestFor("proof", { timeMs: 20 }) as never));
    expect(e.code).toBe(11);
  });
});

describe("T7: no refusal carries the body, a header value or the URL", () => {
  it("a body read that fails names the call and nothing of the body", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode("SECRET-BODY-TEXT"));
        c.error(new Error("SECRET-ERROR-TEXT"));
      },
    });
    const e = await refusal(transportOf(() => new Response(stream, { status: 200, headers: JSON_HEADERS }))(requestFor("turn") as never));
    expect(e.message).not.toContain("SECRET");
    expect(e.check).toBe("http.turn.transport");
  });

  it("a fetch that throws with the URL in its message: the refusal holds neither", async () => {
    const t = minerHttp(minerEndpoint("https://miner.example"), async (u) => {
      throw new Error(`could not reach ${u} SECRET`);
    });
    const e = await refusal(t(requestFor("turn") as never));
    expect(e.message).not.toContain("SECRET");
  });

  it("a status that is not a status this client reads refuses", async () => {
    const t = minerHttp(minerEndpoint("https://miner.example"), async () => ({ status: 7 }) as unknown as Response);
    const e = await refusal(t(requestFor("turn") as never));
    expect(e.check).toBe("http.turn.status");
  });
});
