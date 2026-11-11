/**
 * Reproduce-only probes for the PR6 audit. Each defect test expects the safe
 * outcome, so it fails if that defect is present. Controls expect behavior the
 * current code already implements. Mock provider only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CompleteReq, CompleteRes, Provider } from "../src/providers.js";
import { latestAttempts } from "../src/ledger.js";
import { RECEIPT_IDENTITY_STATUS, matchReceipt } from "../src/match.js";
import { padQuote } from "../src/run.js";
import { scanForSecrets } from "../src/secrets.js";
import { cli, cliP, readLines, readySeat, tmpHome } from "./helpers.js";

const SEAT = "9001";
const BENIGN = "BENIGN-CONTROL-output";

class AuditProvider implements Provider {
  readonly name = "mock" as const;
  calls = 0;
  constructor(
    private readonly opts: {
      estimate: { estimated_cost_flop?: number; estimated_input_tokens?: unknown; estimated_output_tokens?: unknown };
      text?: string;
      usage?: CompleteRes["usage"] | "missing";
      state?: "reserved" | "estimated" | "settled";
      settled?: number | null;
      foreignRequestId?: string;
      /** How the receipt identifies itself. `same` uses the call id. */
      idMode?: "same" | "missing" | "null" | "empty" | "num42" | "num123";
      job?: string;
    },
  ) {}
  estimate() {
    return Promise.resolve(this.opts.estimate as { estimated_cost_flop?: number; estimated_input_tokens?: number; estimated_output_tokens?: number });
  }
  async complete(req: CompleteReq): Promise<CompleteRes> {
    this.calls += 1;
    const text = this.opts.text ?? BENIGN;
    if (this.opts.usage === "missing") return { request_id: req.requestId, text } as CompleteRes;
    return {
      request_id: req.requestId,
      text,
      usage: this.opts.usage ?? { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }
  readReceipt(requestId: string) {
    const job = this.opts.job ?? "job";
    const mode = this.opts.idMode ?? "same";
    const request_id =
      mode === "missing" ? undefined
      : mode === "null" ? null
      : mode === "empty" ? ""
      : mode === "num42" ? 42
      : mode === "num123" ? 123
      : this.opts.foreignRequestId ?? requestId;
    const receipt: Record<string, unknown> = {
      correlation_id: `imd-job-${job}`,
      model: "audit",
      reserved_spend: 0.186,
      settled_spend: this.opts.settled === undefined ? null : this.opts.settled,
      settled_spend_raw: null,
      terminal_event: null,
      channel_id: null,
      created_at: 0,
      state: this.opts.state ?? "estimated",
      response_status: 200,
    };
    if (mode !== "missing") receipt.request_id = request_id;
    return Promise.resolve({ http: 200, error: null, receipt: receipt as never });
  }
}

const quote = { estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: 8 };

function runArgs(job: string): string[] {
  return ["run", "--seat", SEAT, "--job", job, "--prompt", "Say hi", "--max-tokens", "8", "--provider", "mock", "--json"];
}

describe("audit claim 1 non-numeric token counts", () => {
  it("refuses a non-numeric token estimate before any call, including three runs under cap 0.2", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "0.2");
    const provider = new AuditProvider({ estimate: { estimated_cost_flop: 50, estimated_input_tokens: "n/a" } });
    const codes: number[] = [];
    for (const job of ["cap-a", "cap-b", "cap-c"]) codes.push((await cliP(home, runArgs(job), provider)).code);
    const budgetHome = tmpHome();
    await readySeat(budgetHome, SEAT, "0.2");
    await cli(budgetHome, ["config", "set", "payer", "requester"]);
    const budget = new AuditProvider({ estimate: { estimated_cost_flop: 50, estimated_input_tokens: "n/a" } });
    const budgetRun = await cliP(budgetHome, [...runArgs("cap-budget"), "--job-budget", "0.2"], budget);
    expect({ codes, calls: provider.calls, budgetCode: budgetRun.code, budgetCalls: budget.calls, budgetErr: budgetRun.err }).toEqual({
      codes: [7, 7, 7],
      calls: 0,
      budgetCode: 7,
      budgetCalls: 0,
      budgetErr: expect.stringMatching(/estimate returned no usable cost/),
    });
  });

  it("still enforces the cap when token counts are numeric", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "0.2");
    const provider = new AuditProvider({ estimate: { estimated_cost_flop: 50, estimated_input_tokens: 1, estimated_output_tokens: 1 } });
    const run = await cliP(home, runArgs("numeric-cap"), provider);
    expect(run.code).toBe(3);
    expect(provider.calls).toBe(0);
  });
});

describe("audit claim 2 settled zero before settlement", () => {
  it("keeps the reservation when state is reserved or estimated and settled_spend is 0", async () => {
    const observed: { state: string; cap: number | null; spend: number | null }[] = [];
    for (const state of ["reserved", "estimated"] as const) {
      const home = tmpHome();
      await readySeat(home, SEAT, "5");
      const provider = new AuditProvider({
        estimate: quote,
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_flop: 0.01 },
        state,
        settled: 0,
        job: state,
      });
      const run = await cliP(home, runArgs(state), provider);
      expect(run.code, run.err).toBe(0);
      const rows = readLines(join(home, "ledger.jsonl")) as { request_id: string | null; cap_charge: number | null; spend: number | null }[];
      const latest = rows.filter((row) => row.request_id === run.json().request_id).at(-1);
      observed.push({ state, cap: latest?.cap_charge ?? null, spend: latest?.spend ?? null });
    }
    expect(observed).toEqual([
      { state: "reserved", cap: 0.186, spend: null },
      { state: "estimated", cap: 0.186, spend: null },
    ]);
  });

  // Swarm audit of 8ddc5d2, finding 2: this test expected cap_charge 0. The completion reported
  // cost_flop 0.01, and a reported cost may raise the charge and never lower it, also after settlement.
  // The settled zero is still honoured as the spend. The cap charge is the reported 0.01.
  it("honours an explicit settled zero when the receipt state is settled", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    const provider = new AuditProvider({
      estimate: quote,
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_flop: 0.01 },
      state: "settled",
      settled: 0,
      job: "settled-zero",
    });
    const run = await cliP(home, runArgs("settled-zero"), provider);
    expect(run.code, run.err).toBe(0);
    const rows = readLines(join(home, "ledger.jsonl")) as { request_id: string | null; cap_charge: number | null; spend: number | null }[];
    const latest = rows.filter((row) => row.request_id === run.json().request_id).at(-1);
    expect(latest).toMatchObject({ cap_charge: 0.01, spend: 0 });
  });
});

describe("audit claim 3 receipt request id", () => {
  it("does not settle or match a receipt whose request_id is not the call", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    const provider = new AuditProvider({
      estimate: quote,
      state: "settled",
      settled: 0.05,
      foreignRequestId: "foreign-request",
      job: "foreign",
    });
    const run = await cliP(home, runArgs("foreign"), provider);
    expect(run.code, run.err).toBe(0);
    const printed = run.json() as { request_id: string; cap_charge: number; receipt: { request_id: string; chain_final: boolean; match: { match: string; fields: string[] } } };
    const rows = readLines(join(home, "ledger.jsonl")) as { request_id: string | null; cap_charge: number | null; spend: number | null }[];
    const latest = rows.filter((row) => row.request_id === printed.request_id).at(-1);
    expect(printed.receipt.request_id).toBe("foreign-request");
    expect(printed.receipt.chain_final).toBe(false);
    expect(printed.receipt.match).toEqual({ match: "mismatch", fields: ["receipt identity mismatch; chain-final green blocked"] });
    expect(latest?.spend).toBeNull();
    expect(latest?.cap_charge).toBe(0.186);
    expect(Number.isFinite(latest?.cap_charge)).toBe(true);
  });

  it("settles a receipt whose request_id is the call", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    const provider = new AuditProvider({ estimate: quote, state: "settled", settled: 0.05, job: "same-id" });
    const run = await cliP(home, runArgs("same-id"), provider);
    expect(run.code, run.err).toBe(0);
    const printed = run.json() as { request_id: string; cap_charge: number; receipt: { request_id: string; match: { match: string } } };
    expect(printed.receipt.request_id).toBe(printed.request_id);
    expect(printed.receipt.match.match).toBe("matches");
    expect(printed.cap_charge).toBe(0.05);
  });
});

describe("audit claim 4 missing usage", () => {
  it("records a final reservation row when the completion has no usage object", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    const provider = new AuditProvider({ estimate: quote, usage: "missing" });
    const run = await cliP(home, runArgs("no-usage"), provider);
    expect(run.code, run.err).toBe(0);
    const rows = readLines(join(home, "ledger.jsonl")) as { state: string; cap_charge: number | null; spend: number | null }[];
    const latest = rows.at(-1);
    expect(latest).toMatchObject({ cap_charge: 0.186, spend: null });
    expect(Number.isFinite(latest?.cap_charge)).toBe(true);
    expect(rows.filter((row) => row.state !== "sent").length).toBeGreaterThan(0);
  });

  it("retains the reservation when usage exists and cost_flop is omitted", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    const provider = new AuditProvider({ estimate: quote, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    const run = await cliP(home, runArgs("usage-omit"), provider);
    expect(run.code, run.err).toBe(0);
    expect(run.json().cap_charge).toBe(0.186);
  });
});

describe("audit claim 5 padQuote rounding", () => {
  it("does not round a tiny positive quote to zero or below its raw cost", () => {
    const tiny = padQuote({ estimated_cost_flop: 4e-7, estimated_input_tokens: 1_000_000_000, estimated_output_tokens: 0 });
    const below = padQuote({ estimated_cost_flop: 1.4e-6, estimated_input_tokens: 1_000_000_000, estimated_output_tokens: 0 });
    expect(tiny).not.toBeNull();
    expect(below).not.toBeNull();
    expect({ tiny: tiny!.padded, below: below!.padded }).toEqual({
      tiny: expect.any(Number),
      below: expect.any(Number),
    });
    expect(tiny!.padded).toBeGreaterThan(0);
    expect(tiny!.padded).toBeGreaterThanOrEqual(tiny!.raw);
    expect(below!.padded).toBeGreaterThan(0);
    expect(below!.padded).toBeGreaterThanOrEqual(below!.raw);
  });

  it("pads the known 0.066 quote to 0.186", () => {
    expect(padQuote(quote)).toEqual({ raw: 0.066, padded: 0.186 });
  });
});

describe("audit claim 6 secret scan length", () => {
  it("withholds a 128-hex completion from stdout and the response file", async () => {
    const hex = "cd".repeat(64);
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    const provider = new AuditProvider({ estimate: quote, text: `SYNTHETIC-NOT-A-KEY ${hex}` });
    const run = await cliP(home, runArgs("hex128"), provider);
    expect(run.code, run.err).toBe(0);
    const printed = run.json() as { text: string | null; response_file: string };
    const file = readFileSync(printed.response_file, "utf8");
    expect(run.out.includes(hex)).toBe(false);
    expect(file.includes(hex)).toBe(false);
    expect(printed.text).toBeNull();
  });

  it("withholds a 64-hex completion from stdout and the response file", async () => {
    const hex = "ee".repeat(32);
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    const provider = new AuditProvider({ estimate: quote, text: `SYNTHETIC-NOT-A-KEY ${hex}` });
    const run = await cliP(home, runArgs("hex64"), provider);
    expect(run.code, run.err).toBe(0);
    const printed = run.json() as { text: string | null; response_file: string };
    const file = readFileSync(printed.response_file, "utf8");
    expect(run.out.includes(hex)).toBe(false);
    expect(file.includes(hex)).toBe(false);
    expect(printed.text).toBeNull();
  });
});

const IDENTITY = "receipt identity mismatch; chain-final green blocked";

async function identityCase(label: string, idMode: "missing" | "null" | "empty" | "num42" | "num123") {
  const home = tmpHome();
  await readySeat(home, SEAT, "5");
  const provider = new AuditProvider({ estimate: quote, state: "settled", settled: 0, idMode, job: label });
  const run = await cliP(home, runArgs(label), provider);
  expect(run.code, run.err).toBe(0);
  const printed = run.json() as { request_id: string; receipt: { did: string; request_id: string; chain_final: boolean; match: { match: string; fields: string[] } } };
  const row = latestAttempts(home).find((entry) => entry.request_id === printed.request_id) ?? null;
  const rawId = idMode === "missing" ? undefined : idMode === "null" ? null : idMode === "empty" ? "" : idMode === "num42" ? 42 : 123;
  const direct = await matchReceipt(home, {
    job: label,
    seat: SEAT,
    did: printed.receipt.did,
    correlation_id: `imd-job-${label}`,
    request_id: rawId as string,
  }, row);
  const rows = readLines(join(home, "ledger.jsonl")) as { request_id: string | null; cap_charge: number | null; spend: number | null }[];
  const latest = rows.filter((entry) => entry.request_id === printed.request_id).at(-1);
  expect({
    runMatch: printed.receipt.match,
    directMatch: direct.match,
    directFields: direct.fields,
    chain_final: printed.receipt.chain_final,
    cap: latest?.cap_charge,
    spend: latest?.spend,
    finite: Number.isFinite(latest?.cap_charge),
  }).toEqual({
    runMatch: { match: "mismatch", fields: [IDENTITY] },
    directMatch: "mismatch",
    directFields: [IDENTITY],
    chain_final: false,
    cap: 0.186,
    spend: null,
    finite: true,
  });
  expect(IDENTITY).toBe(RECEIPT_IDENTITY_STATUS);
}

describe("audit identity request_id", () => {
  it("does not settle when the receipt request_id is missing", async () => {
    await identityCase("id-missing", "missing");
  });
  it("does not settle when the receipt request_id is null", async () => {
    await identityCase("id-null", "null");
  });
  it("does not settle when the receipt request_id is 42", async () => {
    await identityCase("id-42", "num42");
  });
  it("does not settle when the receipt request_id is empty", async () => {
    await identityCase("id-empty", "empty");
  });
  it("does not settle when the receipt request_id is 123", async () => {
    await identityCase("id-123", "num123");
  });
  it("settles and matches when the receipt request_id is exactly the call id", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    const provider = new AuditProvider({ estimate: quote, state: "settled", settled: 0.05, idMode: "same", job: "id-exact" });
    const run = await cliP(home, runArgs("id-exact"), provider);
    expect(run.code, run.err).toBe(0);
    const printed = run.json() as { request_id: string; cap_charge: number; receipt: { request_id: string; match: { match: string } } };
    expect(printed.receipt.request_id).toBe(printed.request_id);
    expect(printed.receipt.match.match).toBe("matches");
    expect(printed.cap_charge).toBe(0.05);
    const rows = readLines(join(home, "ledger.jsonl")) as { request_id: string | null; cap_charge: number | null; spend: number | null }[];
    expect(rows.filter((entry) => entry.request_id === printed.request_id).at(-1)).toMatchObject({ cap_charge: 0.05, spend: 0.05 });
  });
});

describe("audit hex-scan exemption", () => {
  it("withholds 64-or-more hex outside signature fields and still writes a link", async () => {
    const hex = "cd".repeat(64);
    expect(scanForSecrets({ note: hex }).length).toBeGreaterThan(0);
    expect(scanForSecrets({ outer: { inner: hex } }).length).toBeGreaterThan(0);
    expect(scanForSecrets({ sig: "0x" + hex })).toEqual([]);
    expect(scanForSecrets({ signature: hex })).toEqual([]);
    expect(scanForSecrets({ nested: { flopSignature: hex } })).toEqual([]);
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    const provider = new AuditProvider({ estimate: quote, text: `SYNTHETIC-NOT-A-KEY ${hex}` });
    const run = await cliP(home, runArgs("hex-other-field"), provider);
    expect(run.code, run.err).toBe(0);
    const printed = run.json() as { text: string | null; response_file: string };
    const file = readFileSync(printed.response_file, "utf8");
    expect(run.out.includes(hex)).toBe(false);
    expect(file.includes(hex)).toBe(false);
    expect(printed.text).toBeNull();
  });
});
