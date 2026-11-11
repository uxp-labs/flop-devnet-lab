/**
 * Non-finite numbers in JSON this tool did not write (brief 2026-11-11, non-finite reads). JSON.parse reads
 * 1e999 as Infinity and -1e999 as -Infinity, and JSON.stringify writes both as null. null means "unknown" in
 * this tool, so a body that holds such a number must never be stored with null in its place.
 *
 * One block per place the tool parses JSON it did not write: the Ethereum RPC (eth_chainId, eth_call), the
 * faucet, the FLOP RPC WebSocket frame, the estimate, the child key mint, the paid call's answer, the receipt
 * read and the enroll answers. Each block has the control (a body that is not JSON at that place) and the cases
 * with 1e999 and -1e999. Every answer is scripted text (test/lib/scripted-gateway.ts), so nothing leaves the
 * process.
 *
 * Step 1 of the brief pinned what the code did, and a name that started with "TODAY (wrong)" said the behavior
 * broke the rule. Step 2 applied the rule where gateway.ts reads the body (outside-json.ts readOutsideJson): such
 * a body takes exactly the path of a body that is not JSON at that place, with the fixed reason
 * non_finite_number. Those tests are now named "fixed". The paid call's answer and the receipt read are parsed
 * by @flop-labs/client: since KD-17 (contract/rules.json) the client's fetch is outside-json.ts nonFiniteSeam,
 * and their tests, "TODAY (KD-17)" before, are named "fixed (KD-17)".
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { holdsNonFiniteNumber, NonFiniteNumber, nonFiniteSeam, readOutsideJson } from "../src/outside-json.js";
import { gatewayKeyFile } from "../src/paths.js";
import { NETWORKS } from "../src/networks.js";
import { FlopProvider } from "../src/providers.js";
import { writeSecretFile } from "../src/store.js";
import { clearSecretRegistry } from "../src/secrets.js";
import { cli, readLines, readySeat, tmpHome } from "./helpers.js";
import { ETH, failingStream, NOT_TEXT, paidRun, paidSeat, PIN, receiptText, refresh, type Answer } from "./lib/scripted-gateway.js";

afterEach(() => clearSecretRegistry());

type Row = { state: string; reason: string | null; cap_charge: number; spend: number | null; cost_reported: number | null; flag?: string | null };
const ledger = (h: string): Row[] => (existsSync(join(h, "ledger.jsonl")) ? (readLines(join(h, "ledger.jsonl")) as Row[]) : []);
const files = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")) : []);
const responses = (h: string) => files(join(h, "responses"));
const receipts = (h: string) => files(join(h, "receipts")).map((t) => JSON.parse(t) as Record<string, unknown>);
const ok = (text: string, status = 200): Answer => ({ status, text });
const NOT_JSON = "{nope";

const COMPLETION = (usage: string, extra = "") =>
  `{"id":"x","object":"chat.completion","created":1,"model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}],"usage":${usage}${extra}}`;
const USAGE = (extra = "") => `{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2,"cost_flop":0.01${extra}}`;

/** Every step of a paid run that reached the receipt read, in order. */
const ALL_SENT = ["chainId", "faucet", "chainId", "ownerOf", "estimate", "chainId", "faucet", "mint", "completion", "receipt"];

describe("non-finite reads: the one reader (outside-json.ts)", () => {
  it("control: a paid run whose every answer is finite JSON reaches every step and settles", async () => {
    const r = await paidRun();
    expect(r.code).toBe(0);
    expect(r.gw.seen).toEqual(ALL_SENT);
    expect(ledger(r.h).at(-1)).toMatchObject({ state: "settled", spend: 0.01 });
  });
  it("finds a number past a double anywhere outside a string, and nothing inside one", () => {
    const hits = ["1e999", "-1e999", "[1,2,1E400]", '{"a":{"b":[0,-1e+999]}}', "1" + "0".repeat(400), String.raw`{"s":"\\","n":1e999}`];
    const misses = ['"1e999"', '{"1e999":"-1e999"}', String.raw`{"s":"\"1e999"}`, "1e-999", "-0", "1.7976931348623157e308", "[]", "true", "null"];
    expect(hits.filter((t) => !holdsNonFiniteNumber(t))).toEqual([]);
    expect(misses.filter((t) => holdsNonFiniteNumber(t))).toEqual([]);
  });
  it("reads a body nested 100000 levels with no recursion of its own, and keeps JSON.parse's error for a text that is not JSON", () => {
    expect(() => readOutsideJson("[".repeat(100000) + "1e999" + "]".repeat(100000))).toThrow(NonFiniteNumber);
    expect(readOutsideJson("[".repeat(100000) + "1" + "]".repeat(100000))).toBeInstanceOf(Array);
    expect(() => readOutsideJson(NOT_JSON)).toThrow(SyntaxError);
    expect(() => readOutsideJson("NaN")).toThrow(SyntaxError);
    expect(new NonFiniteNumber().message).toBe("non_finite_number");
  });
});

describe("non-finite reads: the Ethereum RPC answers (eth_chainId, eth_call ownerOf)", () => {
  it("control: an eth_chainId answer that is not JSON refuses the paid run, exit 5, nothing sent", async () => {
    const r = await paidRun({ chainId: ok(NOT_JSON) });
    expect(r.code).toBe(5);
    expect(r.err).toContain("eth_chainId returned malformed JSON");
    expect(r.gw.seen).toEqual(["chainId"]);
    expect(ledger(r.h)).toEqual([]);
  });
  for (const n of ["1e999", "-1e999"]) {
    it(`fixed: an eth_chainId answer with ${n} in its id takes the not-JSON path, exit 5, nothing sent, reason non_finite_number`, async () => {
      const r = await paidRun({ chainId: ok(`{"jsonrpc":"2.0","id":${n},"result":"0x1"}`) });
      expect(r.code).toBe(5);
      expect(r.err).toContain("eth_chainId returned malformed JSON (non_finite_number)");
      expect(r.err).not.toContain("999");
      expect(r.gw.seen).toEqual(["chainId"]);
      expect(ledger(r.h)).toEqual([]);
    });
  }
  it("control: an eth_call ownerOf answer that is not JSON fails the owner check, exit 4, nothing sent", async () => {
    const r = await paidRun({ ownerOf: ok(NOT_JSON) });
    expect(r.code).toBe(4);
    expect(r.err).toContain("eth_call returned malformed JSON");
    expect(r.gw.seen).not.toContain("estimate");
  });
  for (const n of ["1e999", "-1e999"]) {
    it(`fixed: an eth_call ownerOf answer with ${n} in its id takes the not-JSON path, exit 4, nothing sent, reason non_finite_number`, async () => {
      const seat = await paidSeat();
      const r = await paidRun({ ownerOf: ok(`{"jsonrpc":"2.0","id":${n},"result":"0x${"0".repeat(24)}${seat.owner.slice(2).toLowerCase()}"}`) }, undefined, seat);
      expect(r.code).toBe(4);
      expect(r.err).toContain("eth_call returned malformed JSON (non_finite_number)");
      expect(r.gw.seen).not.toContain("estimate");
    });
  }
});

describe("non-finite reads: the faucet /chain answer", () => {
  it("control: a faucet answer that is not JSON fails the genesis check, exit 5, nothing sent", async () => {
    const r = await paidRun({ faucet: ok(NOT_JSON) });
    expect(r.code).toBe(5);
    expect(r.err).toContain("(faucet returned malformed JSON)");
    expect(r.gw.seen).toEqual(["chainId", "faucet"]);
  });
  for (const n of ["1e999", "-1e999"]) {
    it(`fixed: a faucet answer with ${n} beside the genesis takes the not-JSON path, exit 5, nothing sent, reason non_finite_number`, async () => {
      const r = await paidRun({ faucet: ok(`{"genesisHash":"${PIN}","height":${n}}`) });
      expect(r.code).toBe(5);
      expect(r.err).toContain("(faucet returned malformed JSON (non_finite_number))");
      expect(r.gw.seen).toEqual(["chainId", "faucet"]);
    });
  }
});

describe("non-finite reads: the FLOP RPC WebSocket frame", () => {
  it("control: a frame that is not JSON fails the genesis check, exit 5, nothing sent", async () => {
    const r = await paidRun({}, NOT_JSON);
    expect(r.code).toBe(5);
    expect(r.err).toContain("(rpc unavailable: rpc returned malformed JSON)");
    expect(r.gw.seen).toEqual(["chainId", "faucet"]);
  });
  for (const n of ["1e999", "-1e999"]) {
    it(`fixed: a frame with ${n} in its id takes the not-JSON path, exit 5, nothing sent, reason non_finite_number`, async () => {
      const r = await paidRun({}, `{"jsonrpc":"2.0","id":${n},"result":"${PIN}"}`);
      expect(r.code).toBe(5);
      expect(r.err).toContain("(rpc unavailable: rpc returned malformed JSON (non_finite_number))");
      expect(r.gw.seen).toEqual(["chainId", "faucet"]);
    });
  }
});

describe("non-finite reads: the estimate", () => {
  it("control: an estimate that is not JSON fails, exit 7, nothing sent, the row records why", async () => {
    const r = await paidRun({ estimate: ok(NOT_JSON) });
    expect(r.code).toBe(7);
    expect(r.err).toMatch(/refused locally, nothing sent: estimate failed \(/);
    expect(r.gw.seen.at(-1)).toBe("estimate");
    expect(ledger(r.h)).toMatchObject([{ state: "refused_local", cap_charge: 0 }]);
    expect(ledger(r.h)[0].reason).toMatch(/^estimate failed \(/);
  });
  for (const n of ["1e999", "-1e999"]) {
    for (const [where, body] of [
      ["whose cost is", `{"estimated_input_tokens":1,"estimated_output_tokens":1,"estimated_cost_flop":${n}}`],
      ["with, in a field it does not read,", `{"estimated_input_tokens":1,"estimated_output_tokens":1,"estimated_cost_flop":0.012,"spare":${n}}`],
    ]) {
      it(`fixed: an estimate ${where} ${n} takes the not-JSON path: estimate failed (non_finite_number), exit 7, nothing sent`, async () => {
        const r = await paidRun({ estimate: ok(body) });
        expect(r.code).toBe(7);
        expect(r.err).toContain("refused locally, nothing sent: estimate failed (non_finite_number)");
        expect(r.gw.seen.at(-1)).toBe("estimate");
        expect(ledger(r.h)).toMatchObject([{ state: "refused_local", reason: "estimate failed (non_finite_number)", cap_charge: 0 }]);
      });
    }
  }
});

describe("non-finite reads: the child key mint", () => {
  it("control: a mint answer that is not JSON is a pre send failure, exit 11, reservation released", async () => {
    const r = await paidRun({ mint: ok(NOT_JSON, 201) });
    expect(r.code).toBe(11);
    expect(r.err).toContain("nothing sent: child key mint returned an unparsable body");
    expect(r.gw.seen).not.toContain("completion");
    expect(ledger(r.h).at(-1)).toMatchObject({ state: "refused_local", reason: "nothing sent: child key mint returned an unparsable body", cap_charge: 0 });
  });
  for (const n of ["1e999", "-1e999"]) {
    it(`fixed: a mint answer whose expires_at is ${n} takes the not-JSON path, exit 11, reservation released, reason non_finite_number`, async () => {
      const r = await paidRun({ mint: ok(`{"token":"flop_ek_SYNTHETICCHILD0123456789","expires_at":${n}}`, 201) });
      expect(r.code).toBe(11);
      expect(r.err).toContain("nothing sent: child key mint returned an unparsable body (non_finite_number)");
      expect(r.gw.seen).not.toContain("completion");
      expect(ledger(r.h).at(-1)).toMatchObject({ state: "refused_local", reason: "nothing sent: child key mint returned an unparsable body (non_finite_number)", cap_charge: 0 });
    });
  }
});

describe("non-finite reads: the paid call's answer (parsed by @flop-labs/client, through the KD-17 seam)", () => {
  it("control: an answer that is not JSON leaves the spend unknown and the reservation held, exit 6", async () => {
    const r = await paidRun({ completion: ok(NOT_JSON) });
    expect(r.code).toBe(6);
    expect(r.err).toContain("Spend is UNKNOWN");
    expect(ledger(r.h).at(-1)).toMatchObject({ state: "timeout_unknown", reason: "FlopValidationError: no answer; spend unknown, not retried", cap_charge: 0.132, spend: null });
    expect(responses(r.h)).toEqual([]);
    expect(r.gw.seen).not.toContain("receipt");
  });
  for (const n of ["1e999", "-1e999"]) {
    for (const [where, body] of [
      ["whose usage.cost_flop is", COMPLETION(`{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2,"cost_flop":${n}}`)],
      ["with, in a usage field the client does not check,", COMPLETION(USAGE(`,"spare":${n}`))],
      ["with, outside usage,", COMPLETION(USAGE(), `,"spare":${n}`)],
    ]) {
      it(`fixed (KD-17): a 200 answer ${where} ${n} takes the not-JSON path: reservation held (timeout_unknown, exit 6), never booked as trusted, no response file, reason non_finite_number`, async () => {
        const r = await paidRun({ completion: ok(body) });
        expect(r.code).toBe(6);
        expect(r.err).toContain("(non_finite_number). Spend is UNKNOWN");
        expect(r.err).not.toContain("999");
        const rows = ledger(r.h);
        expect(rows.at(-1)).toMatchObject({ state: "timeout_unknown", reason: "FlopValidationError: no answer; spend unknown, not retried (non_finite_number)", cap_charge: 0.132, spend: null, cost_reported: null });
        expect(rows.some((row) => row.state === "settled" || row.state === "refused_local")).toBe(false);
        expect(responses(r.h)).toEqual([]);
        expect(r.gw.seen).not.toContain("receipt");
      });
    }
  }
  it("control: an HTTP 500 answer that is not JSON is a gateway error, exit 1, reservation held", async () => {
    const r = await paidRun({ completion: ok(NOT_JSON, 500) });
    expect(r.code).toBe(1);
    expect(ledger(r.h).at(-1)).toMatchObject({ state: "error", reason: "HTTP 500", cap_charge: 0.132 });
  });
  it("fixed (KD-17): an HTTP 500 answer with 1e999 in it is the same gateway error, exit 1, reason HTTP 500 (non_finite_number)", async () => {
    const r = await paidRun({ completion: ok(`{"error":"busy","retry":1e999}`, 500) });
    expect(r.code).toBe(1);
    expect(r.err).toContain("gateway refused the call (HTTP 500 (non_finite_number)); spend recorded as unknown");
    expect(ledger(r.h).at(-1)).toMatchObject({ state: "error", reason: "HTTP 500 (non_finite_number)", cap_charge: 0.132 });
  });
});

describe("non-finite reads: the receipt read (parsed by @flop-labs/client, through the KD-17 seam)", () => {
  it("control: a receipt that is not JSON is not a trusted read: nothing is booked and the stored receipt says why", async () => {
    const r = await paidRun({ receipt: ok(NOT_JSON) });
    expect(r.code).toBe(0);
    expect(ledger(r.h).at(-1)).toMatchObject({ state: "sent", cap_charge: 0.132, spend: null });
    expect(receipts(r.h)).toMatchObject([{ http: 0, error: "Gateway response is not valid JSON", settled: null, reserved: null }]);
  });
  for (const [field, n] of [["settled_spend", "1e999"], ["reserved_spend", "-1e999"], ["spare", "1e999"], ["spare", "-1e999"]] as const) {
    it(`fixed (KD-17): a receipt whose ${field} is ${n} is not a trusted read: nothing booked, the stored receipt records the reason, not a null spend`, async () => {
      const r = await paidRun({ receipt: ok(receiptText({ [field]: n })) });
      expect(r.code).toBe(0);
      expect(ledger(r.h).at(-1)).toMatchObject({ state: "sent", cap_charge: 0.132, spend: null });
      expect(receipts(r.h)).toMatchObject([{ http: 0, error: "Gateway response is not valid JSON (non_finite_number)", state: null, settled: null, reserved: null }]);
    });
  }
  it("fixed (KD-17): receipt --refresh of a receipt with 1e999 in a field the client does not check books nothing and keeps the reservation", async () => {
    const first = await paidRun({ receipt: ok(NOT_JSON) });
    const rid = first.gw.requestId()!;
    expect(ledger(first.h).at(-1)).toMatchObject({ state: "sent" });
    const before = ledger(first.h).length;
    const r = await refresh(first.h, first.owner, rid, ok(receiptText({ spare: "1e999" })));
    expect(r.code).toBe(0);
    expect(ledger(first.h).length).toBe(before);
    expect(ledger(first.h).at(-1)).toMatchObject({ state: "sent", cap_charge: 0.132, spend: null });
    expect(receipts(first.h)).toMatchObject([{ http: 0, error: "Gateway response is not valid JSON (non_finite_number)", settled: null }]);
    expect(JSON.parse(r.out).error).toBe("Gateway response is not valid JSON (non_finite_number)");
  });
  it("control: an HTTP 401 receipt answer that is not JSON keeps no error and sets no flag", async () => {
    const r = await paidRun({ receipt: ok(NOT_JSON, 401) });
    expect(receipts(r.h)).toMatchObject([{ http: 401, error: null, flag: null }]);
  });
  it("fixed (KD-17): an HTTP 401 receipt answer with 1e999 in it is not read: no key_expired flag, error non_finite_number, nothing booked", async () => {
    const r = await paidRun({ receipt: ok(`{"error":"api_key_expired","retry":1e999}`, 401) });
    expect(receipts(r.h)).toMatchObject([{ http: 401, error: "non_finite_number", flag: null }]);
    expect(ledger(r.h).map((row) => row.reason)).not.toContain("key_expired");
    expect(ledger(r.h).at(-1)).toMatchObject({ state: "sent", cap_charge: 0.132 });
  });
});

describe("non-finite reads: the KD-17 seam itself (outside-json.ts nonFiniteSeam)", () => {
  const answer = (text: string, status = 200) => (async () => new Response(text, { status, headers: { "content-type": "application/json", "x-a": "b" } })) as typeof fetch;
  it("hands on a fine body as the same Response, and one with a number that is not finite as a new one with the same status and headers and the body non_finite_number", async () => {
    const fine = new Response('{"a":1}', { status: 201, headers: { "x-a": "b" } });
    const seam = nonFiniteSeam((async () => fine) as typeof fetch);
    const got = await seam.fetch("https://g.example/v1/x");
    expect(got).toBe(fine);
    expect(await got.text()).toBe('{"a":1}');
    expect(seam.met()).toBe(false);
    const bad = nonFiniteSeam(answer('{"a":1e999}', 402));
    const res = await bad.fetch("https://g.example/v1/x");
    expect([res.status, res.headers.get("x-a"), res.headers.get("content-type"), await res.text()]).toEqual([402, "b", "application/json", "non_finite_number"]);
    expect(bad.met()).toBe(true);
  });
  it("never throws because of what a body holds, and calls the real fetch first, once", async () => {
    let calls = 0;
    for (const body of ["", NOT_JSON, "<html>1e999</html>", '"1e999"']) {
      const seam = nonFiniteSeam((async () => { calls++; return new Response(body); }) as typeof fetch);
      await expect(seam.fetch("https://g.example/v1/x")).resolves.toBeInstanceOf(Response);
      expect({ body, met: seam.met() }).toEqual({ body, met: false });
    }
    const failing = nonFiniteSeam((async () => { calls++; return new Response(failingStream()); }) as typeof fetch);
    const res = await failing.fetch("https://g.example/v1/x");
    await expect(res.text()).rejects.toThrow();
    expect(failing.met()).toBe(false);
    expect(calls).toBe(5);
  });
  it("two calls at once each see only their own note", async () => {
    const h = tmpHome();
    writeSecretFile(gatewayKeyFile(h, "9001"), "flop_sk_SYNTHETICPARENT0123456789\n");
    const f = (async (input: unknown) => {
      const rid = decodeURIComponent(String(input).split("/").at(-1)!);
      await new Promise((r) => setTimeout(r, rid === "req-bad" ? 5 : 0));
      return new Response(receiptText(rid === "req-bad" ? { spare: "1e999" } : {}, rid), { status: 200 });
    }) as typeof fetch;
    const p = new FlopProvider(NETWORKS.devnet, gatewayKeyFile(h, "9001"), f, ETH);
    const [bad, good] = await Promise.all([p.readReceipt("req-bad"), p.readReceipt("req-good")]);
    expect(bad).toMatchObject({ http: 0, receipt: null, error: "Gateway response is not valid JSON (non_finite_number)" });
    expect(good).toMatchObject({ http: 200, error: null, receipt: { request_id: "req-good", state: "settled" } });
  });
});

describe("non-finite reads: the enroll answers", () => {
  const enrollFetch = (challenge: (ss58: string) => string, enroll: Answer) =>
    (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/enroll/wallet/challenge")) {
        const ss58 = decodeURIComponent(url.split("address=")[1]);
        return new Response(challenge(ss58), { status: 200 });
      }
      return new Response(enroll.text, { status: enroll.status });
    }) as typeof fetch;
  /** A seat with a key and no gateway key yet, so enroll --live may run. */
  const enrollSeat = async () => {
    const h = tmpHome();
    await readySeat(h);
    return h;
  };
  const challenge = (n: string) => (ss58: string) => `{"message":"enroll ${ss58}","nonce":"n","expires_at":${n}}`;

  it("control: a challenge that is not JSON fails the enroll, exit 1, nothing signed or posted", async () => {
    const h = await enrollSeat();
    const r = await cli(h, ["enroll", "--live"], { fetch: enrollFetch(() => NOT_JSON, ok("{}")) });
    expect(r.code).toBe(1);
    expect(r.err).toContain("the enroll challenge was not JSON");
  });
  it("fixed: a challenge whose expires_at is 1e999 takes the not-JSON path, exit 1, nothing signed or posted, reason non_finite_number", async () => {
    const h = await enrollSeat();
    let posted = 0;
    const f = enrollFetch(challenge("1e999"), ok(`{"error":"wallet_unfunded"}`, 403));
    const r = await cli(h, ["enroll", "--live"], { fetch: (async (u: unknown, i?: RequestInit) => { if (!String(u).includes("challenge")) posted++; return f(u as string, i); }) as typeof fetch });
    expect(r.code).toBe(1);
    expect(r.err).toContain("the enroll challenge was not JSON (non_finite_number)");
    expect(posted).toBe(0);
  });
  it("control: an enroll answer that is not JSON enrolls nothing and prints no error, exit 1", async () => {
    const h = await enrollSeat();
    const r = await cli(h, ["enroll", "--live"], { fetch: enrollFetch(challenge("1"), ok(NOT_JSON, 200)) });
    expect(r.code).toBe(1);
    expect(r.json()).toEqual({ enrolled: false, http: 200, error: null });
  });
  it("fixed: an enroll answer whose remaining_quota is 1e999 takes the not-JSON path: nothing enrolled or stored, exit 1, error non_finite_number", async () => {
    const h = await enrollSeat();
    const r = await cli(h, ["enroll", "--live"], { fetch: enrollFetch(challenge("1"), ok(`{"key":"flop_sk_SYNTHETICNEWBEARER0123456789","model":"m","remaining_quota":1e999,"expires_at":1}`, 201)) });
    expect(r.code).toBe(1);
    expect(r.json()).toEqual({ enrolled: false, http: 201, error: "non_finite_number" });
    expect(existsSync(gatewayKeyFile(h, "42"))).toBe(false);
  });
});

describe("non-finite reads: bodies of the paid call and the receipt read that hold no number at all (pinned before the KD-17 seam, unchanged by it)", () => {
  const BODIES: [string, (status: number) => Answer][] = [
    ["an empty body", (status) => ({ status, text: "" })],
    ["a body that is not text", (status) => ({ status, body: NOT_TEXT })],
    ["a body whose stream fails while it is read", (status) => ({ status, body: failingStream })],
  ];
  for (const [what, body] of BODIES) {
    const transport = what.includes("stream");
    it(`the paid call's 200 answer is ${what}: spend unknown, reservation held, exit 6, no response file`, async () => {
      const r = await paidRun({ completion: body(200) });
      expect(r.code).toBe(6);
      expect(ledger(r.h).at(-1)).toMatchObject({ state: "timeout_unknown", reason: `${transport ? "FlopTransportError" : "FlopValidationError"}: no answer; spend unknown, not retried`, cap_charge: 0.132, spend: null });
      expect(responses(r.h)).toEqual([]);
    });
    it(`the paid call's HTTP 401 answer is ${what}: a gateway error, exit 1, reservation held`, async () => {
      const r = await paidRun({ completion: body(401) });
      expect(r.code).toBe(1);
      expect(r.err).toContain("gateway refused the call (HTTP 401); spend recorded as unknown");
      expect(ledger(r.h).at(-1)).toMatchObject({ state: "error", reason: "HTTP 401", cap_charge: 0.132 });
    });
    it(`the receipt read's 200 answer is ${what}: not a trusted read, nothing booked, the stored receipt says why`, async () => {
      const r = await paidRun({ receipt: body(200) });
      expect(r.code).toBe(0);
      expect(ledger(r.h).at(-1)).toMatchObject({ state: "sent", cap_charge: 0.132, spend: null });
      expect(receipts(r.h)).toMatchObject([{ http: 0, error: transport ? "FLOP gateway request did not complete" : "Gateway response is not valid JSON", flag: null, settled: null }]);
    });
    it(`the receipt read's HTTP 401 answer is ${what}: no error, no flag, nothing booked`, async () => {
      const r = await paidRun({ receipt: body(401) });
      expect(ledger(r.h).at(-1)).toMatchObject({ state: "sent", cap_charge: 0.132 });
      expect(receipts(r.h)).toMatchObject([{ http: 401, error: null, flag: null }]);
    });
  }
});
