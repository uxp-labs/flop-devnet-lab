/**
 * Fail-first regression tests for IMD re-audit e99a2cf1 (imd-flop at 288a03e).
 * Each test asserts the SAFE outcome, so it fails on 288a03e and passes after fix-v7.
 * Test names start with the judge's finding number (TS-M1..M4 medium, TS-L5..L11 low, TS-I13/I14 info).
 * Mock providers only; no network (test/setup.ts disables fetch).
 */
import { readdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompleteReq, CompleteRes, Provider } from "../src/providers.js";
import { spentToday, utcDay } from "../src/ledger.js";
import { redactFlagged } from "../src/secrets.js";
import { mintChildKey, PreSendError } from "../src/gateway.js";
import { network } from "../src/networks.js";
import { cli, cliP, readLines, readySeat, tmpHome } from "./helpers.js";

const SEAT = "9001";
const HEX = "ee".repeat(32);
const quote = { estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: 8 };
type IdMode = "same" | "missing" | "null" | { value: unknown };
interface Opts {
  state?: unknown; settled?: unknown; settledRaw?: unknown; idMode?: IdMode; http?: number; correlation?: string;
  usage?: Record<string, unknown>; text?: string; complete?: (req: CompleteReq) => Promise<CompleteRes>;
}
class P implements Provider {
  readonly name = "mock" as const;
  calls = 0;
  constructor(private readonly o: Opts = {}) {}
  async estimate() { return quote; }
  async complete(req: CompleteReq): Promise<CompleteRes> {
    this.calls += 1;
    if (this.o.complete) return this.o.complete(req);
    return { request_id: req.requestId, text: this.o.text ?? "BENIGN-CONTROL-output", usage: (this.o.usage ?? { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }) as CompleteRes["usage"] };
  }
  async readReceipt(requestId: string) {
    if (this.o.http && this.o.http !== 200) return { http: this.o.http, receipt: null, error: this.o.http === 401 ? "api_key_expired" : "not_found" };
    const mode = this.o.idMode ?? "same";
    const receipt: Record<string, unknown> = {
      correlation_id: this.o.correlation ?? "imd-job-j1", model: "audit", reserved_spend: 0.186,
      settled_spend: this.o.settled === undefined ? null : this.o.settled, settled_spend_raw: this.o.settledRaw ?? null,
      terminal_event: null, channel_id: null, created_at: 0, state: this.o.state ?? "estimated", response_status: 200,
    };
    if (mode === "same") receipt.request_id = requestId;
    else if (mode === "null") receipt.request_id = null;
    else if (typeof mode === "object") receipt.request_id = mode.value;
    return { http: 200, error: null, receipt: receipt as never };
  }
}
const runArgs = (job = "j1", json = true) => ["run", "--seat", SEAT, "--job", job, "--prompt", "Say hi", "--max-tokens", "8", "--provider", "mock", ...(json ? ["--json"] : [])];
type Row = { request_id: string | null; state: string; spend: number | null; cap_charge: unknown; day: string; spent_before: number | null };
const ledger = (home: string) => (existsSync(join(home, "ledger.jsonl")) ? (readLines(join(home, "ledger.jsonl")) as Row[]) : []);
const rows = (home: string, id: string) => ledger(home).filter((r) => r.request_id === id);
const refresh = (home: string, id: string, p: Provider) => cli(home, ["receipt", id, "--refresh", "--json", "--seat", SEAT], { provider: p });

function seedRow(home: string, id: string, capCharge: unknown) {
  const row: Record<string, unknown> = { ts: new Date().toISOString(), day: utcDay(), request_id: id, seat: SEAT, did: "did:key:zseed", job: "seed", provider: "mock",
    network: "devnet", payer: "holder", model: "m", max_tokens: 8, prompt_sha256: "ab".repeat(32), quote_raw: 0.066, quote_padded: 0.186, per_call_cap: 5, daily_cap: 5,
    job_budget: null, spent_before: 0, state: "sent", reason: null, spend: null, cost_reported: null, http: null, mock: true };
  if (capCharge !== "missing") row.cap_charge = capCharge;
  writeFileSync(join(home, "ledger.jsonl"), JSON.stringify(row) + "\n");
}

afterEach(() => { vi.useRealTimers(); });

describe("TS-M1 receipt --refresh identity comes from the raw gateway receipt", () => {
  for (const idMode of ["missing", "null"] as const) {
    it(`TS-M1 refresh with request_id ${idMode}, settled 0: reservation kept, match mismatch`, async () => {
      const home = tmpHome();
      await readySeat(home, SEAT, "5");
      const opened = await cliP(home, runArgs(), new P());
      expect(opened.code, opened.err).toBe(0);
      const id = opened.json().request_id as string;
      expect(rows(home, id).at(-1)).toMatchObject({ state: "estimated", spend: null, cap_charge: 0.186 });
      const refreshed = await refresh(home, id, new P({ state: "settled", settled: 0, idMode }));
      expect(refreshed.code, refreshed.err).toBe(0);
      const latest = rows(home, id).at(-1)!;
      const today = (await cli(home, ["status", "--seat", SEAT, "--json"])).json().today_utc.mock;
      expect({ cap: latest.cap_charge, spend: latest.spend, match: refreshed.json().match.match, today }).toEqual({ cap: 0.186, spend: null, match: "mismatch", today: 0.186 });
    });
  }
  it("TS-M1 a non-200 refresh must not flip an identity-mismatch receipt to matches", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    const opened = await cliP(home, runArgs(), new P({ idMode: "missing" }));
    expect(opened.code, opened.err).toBe(0);
    const id = opened.json().request_id as string;
    expect(opened.json().receipt.match.match).toBe("mismatch");
    for (const http of [404, 401]) {
      const refreshed = await refresh(home, id, new P({ http }));
      expect(refreshed.code, refreshed.err).toBe(0);
      expect(refreshed.json().match.match).toBe("mismatch");
    }
    expect((await cli(home, ["receipt", id, "--json", "--seat", SEAT])).json().match.match).toBe("mismatch");
  });
});

describe("TS-M2 receipt --refresh must not rewrite an unusable cap_charge as 0", () => {
  for (const bad of ["missing", null, "nope"] as const) {
    it(`TS-M2 cap_charge ${String(bad)}: run refuses before and still refuses after a refresh`, async () => {
      const home = tmpHome();
      await readySeat(home, SEAT, "5");
      seedRow(home, "seed-bad", bad);
      const first = new P();
      expect((await cliP(home, runArgs(), first)).code).toBe(3);
      expect(first.calls).toBe(0);
      const refreshed = await refresh(home, "seed-bad", new P({ state: "estimated" }));
      expect(refreshed.code, refreshed.err).toBe(0);
      const second = new P();
      const r2 = await cliP(home, runArgs(), second);
      expect({ code: r2.code, calls: second.calls, latestCapIsZero: rows(home, "seed-bad").at(-1)!.cap_charge === 0 }).toEqual({ code: 3, calls: 0, latestCapIsZero: false });
    });
  }
});

describe("TS-M3 a flagged key containing '.' or '[' is still redacted", () => {
  it("TS-M3 unit: redactFlagged nulls usage['a.b'] and leaves no finding", () => {
    const { copy } = redactFlagged({ usage: { "a.b": HEX, "c[0]": HEX } });
    expect((copy as { usage: Record<string, unknown> }).usage).toEqual({ "a.b": null, "c[0]": null });
  });
  it("TS-M3 run keeps the paid response, receipt and final ledger row", async () => {
    const h = tmpHome();
    await readySeat(h, SEAT, "5");
    const p = new P({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, "a.b": HEX } });
    const r = await cliP(h, runArgs("j"), p);
    const resp = existsSync(join(h, "responses")) ? readdirSync(join(h, "responses")) : [];
    const rec = existsSync(join(h, "receipts")) ? readdirSync(join(h, "receipts")) : [];
    const states = ledger(h).map((x) => x.state);
    expect({ calls: p.calls, code: r.code, resp: resp.length, rec: rec.length, last: states.at(-1) }).toEqual({ calls: 1, code: 0, resp: 1, rec: 1, last: "estimated" });
    expect(readFileSync(join(h, "responses", resp[0]!), "utf8")).not.toContain(HEX);
  });
});

describe("TS-M4 a scan hit outside text keeps the clean completion text", () => {
  it("TS-M4 hit only in usage.note: text kept, usage.note nulled", async () => {
    const h = tmpHome();
    await readySeat(h, SEAT, "5");
    const r = await cliP(h, runArgs("j"), new P({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, note: HEX } }));
    expect(r.code, r.err).toBe(0);
    const file = JSON.parse(readFileSync(r.json().response_file, "utf8"));
    expect(file.usage.note).toBeNull();
    expect(file.text).toBe("BENIGN-CONTROL-output");
    expect(r.json().text).toBe("BENIGN-CONTROL-output");
  });
  it("TS-M4 control: a hit in text still withholds text on file and stdout", async () => {
    const h = tmpHome();
    await readySeat(h, SEAT, "5");
    const r = await cliP(h, runArgs("j"), new P({ text: `leak ${HEX}` }));
    expect(r.code, r.err).toBe(0);
    const file = JSON.parse(readFileSync(r.json().response_file, "utf8"));
    expect(file.text).toBeNull();
    expect(r.json().text).toBeNull();
    expect(r.out).not.toContain(HEX);
  });
});

describe("TS-L5 refresh books a settlement learned under an unchanged state", () => {
  it("TS-L5 settled NaN at run, settled 0.05 on refresh: ledger settles to 0.05", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    const opened = await cliP(home, runArgs(), new P({ state: "settled", settled: Number.NaN }));
    const id = opened.json().request_id as string;
    expect(rows(home, id).at(-1)).toMatchObject({ state: "settled", spend: null, cap_charge: 0.186 });
    const refreshed = await refresh(home, id, new P({ state: "settled", settled: 0.05 }));
    expect(refreshed.code, refreshed.err).toBe(0);
    expect(rows(home, id).at(-1)).toMatchObject({ state: "settled", spend: 0.05, cap_charge: 0.05 });
    expect(refreshed.json().ledger_spend).toBe(0.05);
  });
});

describe("TS-L6 refresh has a redaction fallback", () => {
  it("TS-L6 key-shaped settled_spend_raw: refresh exits 0, raw nulled, settlement booked", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    const opened = await cliP(home, runArgs(), new P());
    const id = opened.json().request_id as string;
    for (let i = 0; i < 2; i++) {
      const refreshed = await refresh(home, id, new P({ state: "settled", settled: 0.05, settledRaw: HEX }));
      expect(refreshed.code, refreshed.err).toBe(0);
    }
    const file = JSON.parse(readFileSync(join(home, "receipts", `${id}.json`), "utf8"));
    expect(file.settled_raw).toBeNull();
    expect(rows(home, id).at(-1)).toMatchObject({ state: "settled", spend: 0.05, cap_charge: 0.05 });
  });
});

describe("TS-L7 final ledger row never carries a key-shaped receipt state", () => {
  it("TS-L7 state 'cd'x32: run exits 0 with output and a final ledger row", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    const p = new P({ state: "cd".repeat(32) });
    const r = await cliP(home, runArgs("c"), p);
    expect(r.code, r.err).toBe(0);
    const id = r.json().request_id as string;
    expect(rows(home, id).length).toBe(2);
    expect(rows(home, id).at(-1)!.cap_charge).toBe(0.186);
    expect(readFileSync(join(home, "ledger.jsonl"), "utf8")).not.toContain("cd".repeat(32));
  });
});

describe("TS-L8 stdout never shows receipt fields the receipt file redacted", () => {
  it("TS-L8 foreign 64-hex request_id and bearer correlation_id stay off stdout", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    const p = new P({ idMode: { value: HEX }, state: "settled", settled: 0.05 });
    const run = await cliP(home, runArgs("hexid"), p);
    expect(run.code, run.err).toBe(0);
    const file = readFileSync(join(home, "receipts", `${run.json().request_id}.json`), "utf8");
    const plain = await cliP(home, runArgs("hexid2", false), p);
    const bearer = "Bearer SYNTHETICNOTAKEY0123456789";
    const run2 = await cliP(home, runArgs("bearercorr"), new P({ correlation: bearer }));
    const file2 = readFileSync(join(home, "receipts", `${run2.json().request_id}.json`), "utf8");
    expect({ fileHasHex: file.includes(HEX), jsonOutHasHex: run.out.includes(HEX), plainOutHasHex: plain.out.includes(HEX), file2HasBearer: file2.includes(bearer), out2HasBearer: run2.out.includes(bearer) })
      .toEqual({ fileHasHex: false, jsonOutHasHex: false, plainOutHasHex: false, file2HasBearer: false, out2HasBearer: false });
  });
});

describe("TS-L9 the UTC day is fixed once inside the ledger lock", () => {
  it("TS-L9 a run whose estimate crosses 00:00 UTC is not checked against one day and booked to another", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "0.2");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T23:59:59.000Z"));
    expect((await cliP(home, runArgs("d0"), new P())).code).toBe(0);
    vi.setSystemTime(new Date("2026-11-10T23:59:59.900Z"));
    const crossing = new P();
    crossing.estimate = async () => { vi.setSystemTime(new Date("2026-11-11T00:00:00.100Z")); return quote; };
    const r = await cliP(home, runArgs("d1"), crossing);
    const old = spentToday(home, SEAT, "mock", "2026-11-10");
    const d1Days = ledger(home).filter((x) => x.request_id && x.request_id !== ledger(home)[0]!.request_id).map((x) => x.day);
    expect(old).toBeLessThanOrEqual(0.2);
    if (r.code === 0) expect(new Set(d1Days)).toEqual(new Set(["2026-11-11"]));
    else expect(r.code).toBe(3);
  });
});

describe("TS-L10 a malformed cap object fails closed", () => {
  for (const bad of [{}, { daily: "abc", perCall: "abc" }, { daily: 5, perCall: 6 }, { daily: 0, perCall: 0 }] as const) {
    it(`TS-L10 caps[seat] = ${JSON.stringify(bad)}: every run refused with exit 3, nothing sent`, async () => {
      const home = tmpHome();
      await readySeat(home, SEAT, "0.1");
      const cfgPath = join(home, "config.json");
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      cfg.caps[SEAT] = bad;
      writeFileSync(cfgPath, JSON.stringify(cfg));
      const codes: number[] = [];
      const p = new P();
      for (const j of ["f1", "f2", "f3"]) codes.push((await cliP(home, runArgs(j), p)).code);
      expect({ codes, calls: p.calls }).toEqual({ codes: [3, 3, 3], calls: 0 });
    });
  }
});

describe("TS-L11 a transport failure while minting the child key is pre-send", () => {
  const net = network("devnet");
  it("TS-L11 unit: a rejected mint fetch and an unparsable mint body reject with PreSendError", async () => {
    await expect(mintChildKey(net, "parent", { model: "m", maxSpend: 0.186 }, (async () => { throw new TypeError("fetch failed"); }) as never)).rejects.toBeInstanceOf(PreSendError);
    await expect(mintChildKey(net, "parent", { model: "m", maxSpend: 0.186 }, (async () => new Response("not json", { status: 201 })) as never)).rejects.toBeInstanceOf(PreSendError);
  });
  it("TS-L11 end to end: ledger latest refused_local with cap_charge 0; next run allowed", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "0.186");
    const p = new P({ complete: async (req) => { await mintChildKey(net, "parent", { model: req.model, maxSpend: req.maxCostFlop }, (async () => { throw new TypeError("fetch failed"); }) as never); throw new Error("unreachable"); } });
    const r = await cliP(home, runArgs("m1"), p);
    expect(r.code).not.toBe(6);
    expect(ledger(home).at(-1)).toMatchObject({ state: "refused_local", cap_charge: 0 });
    expect((await cliP(home, runArgs("m2"), new P())).code).toBe(0);
  });
});

describe("TS-I13 a 64-hex job id is a usage error, not a secret-scan exit", () => {
  it("TS-I13 --job of 64 hex chars exits 0 or 2, never 5", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    const p = new P();
    const r = await cliP(home, runArgs("ab".repeat(32)), p);
    expect([0, 2]).toContain(r.code);
    if (r.code === 2) expect(p.calls).toBe(0);
  });
});

describe("TS-I14 a ledger lock timeout before the call is a local refusal", () => {
  it("TS-I14 lock held by a live owner: exit 3 'refused locally, nothing sent', nothing sent", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    writeFileSync(join(home, "ledger.jsonl.lock"), JSON.stringify({ pid: process.pid, host: hostname(), token: "other" }));
    const p = new P();
    const r = await cliP(home, runArgs("o1", false), p);
    expect({ code: r.code, calls: p.calls, refused: r.err.includes("refused locally, nothing sent") }).toEqual({ code: 3, calls: 0, refused: true });
  });
});
