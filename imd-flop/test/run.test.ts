import { checkLinkForRun } from "../src/run.js";
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, cliP, readLines, readySeat, tmpHome } from "./helpers.js";
import { MockProvider } from "../src/providers.js";
import { padQuote } from "../src/run.js";

const RUN = ["run", "--job", "job-abc", "--prompt", "Say hi", "--max-tokens", "8"];

describe("cap is required and enforced", () => {
  it("no cap: run refuses", async () => {
    const h = tmpHome();
    await cli(h, ["init", "--seat", "42"]);
    await cli(h, ["link", "--token", "42"]);
    const r = await cli(h, RUN);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/no daily cap/);
  });

  it("over the per-call cap: refused locally, nothing sent, ledger says refused_local", async () => {
    const h = tmpHome();
    await readySeat(h, "42", "1");
    await cli(h, ["cap", "set", "1", "--per-call", "0.05"]);
    const p = new MockProvider();
    const r = await cliP(h, RUN, p);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/per-call cap/);
    expect(p.calls).toBe(0);
    const l = readLines(join(h, "ledger.jsonl"));
    expect(l.at(-1)).toMatchObject({ state: "refused_local", request_id: null, cap_charge: 0, seat: "42", job: "job-abc" });
  });

  it("at the cap: refuses the next call", async () => {
    const h = tmpHome();
    await readySeat(h, "42", "0.4");
    const p = new MockProvider();
    // each call costs ~0.15-0.2 padded; spend until refused
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await cliP(h, RUN, p)).code);
    expect(codes[0]).toBe(0);
    expect(codes).toContain(3);
    const okCalls = codes.filter((c) => c === 0).length;
    expect(p.calls).toBe(okCalls);
    const s = (await cli(h, ["status", "--json"])).json();
    expect(s.today_utc.mock).toBeLessThanOrEqual(0.4);
    expect(s.today_utc.flop).toBe(0); // mock spend never eats the real cap
  });

  it("pads the quote by 20 template tokens (matches spend-guard: 0.066 -> 0.186)", () => {
    expect(padQuote({ estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: 8 })).toEqual({ raw: 0.066, padded: 0.186 });
    expect(padQuote({})).toBeNull();
  });

  it("fails closed when the estimate errors", async () => {
    const h = tmpHome();
    await readySeat(h);
    const p = new MockProvider("estimate_error");
    const r = await cliP(h, RUN, p);
    expect(r.code).toBe(7);
    expect(p.calls).toBe(0);
    expect(readLines(join(h, "ledger.jsonl")).at(-1)).toMatchObject({ state: "refused_local", quote_padded: null });
  });
});

describe("payer switch", () => {
  it("records the payer on every entry; requester needs --job-budget and does not use the holder cap", async () => {
    const h = tmpHome();
    await readySeat(h, "42", "0.2");
    expect((await cli(h, ["config", "set", "payer", "requester"])).code).toBe(0);
    expect((await cli(h, ["config", "set", "payer", "someone"])).code).toBe(2);
    const noBudget = await cli(h, RUN);
    expect(noBudget.code).toBe(3);
    expect(noBudget.err).toMatch(/--job-budget/);
    const ok = await cli(h, [...RUN, "--job-budget", "0.3", "--json"]);
    expect(ok.code).toBe(0);
    expect(ok.json().payer).toBe("requester");
    const over = await cli(h, [...RUN, "--job-budget", "0.3"]);
    expect(over.code).toBe(3);
    expect(over.err).toMatch(/requester budget/);
    // holder daily spend untouched
    expect((await cli(h, ["status", "--json"])).json().today_utc.mock).toBe(0);
    await cli(h, ["config", "set", "payer", "holder"]);
    const held = await cli(h, [...RUN, "--json"]);
    expect(held.json().payer).toBe("holder");
    const rows = readLines(join(h, "ledger.jsonl"));
    expect(rows.every((e) => e.payer === "holder" || e.payer === "requester")).toBe(true);
    expect(rows.filter((e) => e.payer === "requester").every((e) => e.job_budget === 0.3 || e.job_budget === null)).toBe(true);
    expect((await cli(h, ["status", "--json"])).json().today_utc.mock).toBeGreaterThan(0);
  });
});

describe("timeouts", () => {
  it("a timeout records spend null with the request_id and is not retried", async () => {
    const h = tmpHome();
    await readySeat(h);
    const p = new MockProvider("timeout");
    const r = await cliP(h, [...RUN, "--timeout-ms", "50"], p);
    expect(r.code).toBe(6);
    expect(r.err).toMatch(/UNKNOWN/);
    expect(p.calls).toBe(1);
    const last = readLines(join(h, "ledger.jsonl")).at(-1);
    expect(last.state).toBe("timeout_unknown");
    expect(last.spend).toBeNull();
    expect(last.request_id).toMatch(/^mock-42-/);
    expect(last.cap_charge).toBeGreaterThan(0); // unknown spend counts as the padded quote against the cap
    const rc = await cli(h, ["receipt", last.request_id, "--json"]);
    expect(rc.json().match.match).toBe("pending");
    expect(rc.json().settled).toBeNull();
    const txt = await cli(h, ["receipt", last.request_id]);
    expect(txt.out).toMatch(/settled=\s/);
    expect(txt.out).not.toMatch(/settled=0/);
    expect(txt.out).toMatch(/match=pending/);
  });
});

describe("receipts", () => {
  it("labels 'gateway observed', chain_final false, blank (not 0) unknown spend, records job/seat/DID, matches", async () => {
    const h = tmpHome();
    await readySeat(h);
    const r = await cli(h, [...RUN, "--json"]);
    expect(r.code).toBe(0);
    const rec = r.json().receipt;
    expect(rec).toMatchObject({ stage: "gateway observed", chain_final: false, settled: null, flag: null, job: "job-abc", seat: "42", mock: true });
    expect(rec.did).toMatch(/^did:key:z6Mk/);
    expect(rec.match).toEqual({ match: "matches", fields: [] });
    const row = readLines(join(h, "ledger.jsonl")).at(-1);
    expect(row).toMatchObject({ job: "job-abc", seat: "42", did: rec.did });
    const txt = await cli(h, ["receipt", rec.request_id]);
    expect(txt.out).toMatch(/stage=gateway observed/);
    expect(txt.out).toMatch(/settled=\s/);
    expect(txt.out).toMatch(/match=matches/);
    const st = await cli(h, ["status"]);
    expect(st.out + JSON.stringify(readdirSync(join(h, "receipts")).map((f) => readFileSync(join(h, "receipts", f), "utf8")))).not.toMatch(/gateway settled/);
  });

  it("settled on the gateway is still not chain final", async () => {
    const h = tmpHome();
    await readySeat(h);
    const r = await cliP(h, [...RUN, "--json"], new MockProvider("settled"));
    const rec = r.json().receipt;
    expect(rec.state).toBe("settled");
    expect(typeof rec.settled).toBe("number");
    expect(rec.stage).toBe("gateway observed");
    expect(rec.chain_final).toBe(false);
  });

  it("401 api_key_expired gets its own key_expired flag", async () => {
    const h = tmpHome();
    await readySeat(h);
    const r = await cliP(h, [...RUN, "--json"], new MockProvider("key_expired"));
    expect(r.code).toBe(0);
    expect(r.json().receipt).toMatchObject({ flag: "key_expired", http: 401, settled: null, stage: "gateway observed" });
    const ref = await cli(h, ["receipt", r.json().request_id, "--refresh", "--json"]);
    expect(ref.json()).toMatchObject({ flag: "key_expired", settled: null });
  });

  it("a receipt that disagrees with its ledger row shows mismatch with the field, never OK", async () => {
    const h = tmpHome();
    await readySeat(h);
    const r = await cli(h, [...RUN, "--json"]);
    const rid = r.json().request_id;
    const f = join(h, "receipts", `${rid}.json`);
    const saved = JSON.parse(readFileSync(f, "utf8"));
    writeFileSync(f, JSON.stringify({ ...saved, job: "some-other-job" }));
    const rc = await cli(h, ["receipt", rid, "--json"]);
    expect(rc.json().match.match).toBe("mismatch");
    expect(rc.json().match.fields).toContain("job");
    const txt = await cli(h, ["receipt", rid]);
    expect(txt.out).toMatch(/match=mismatch\(job/);
    expect(txt.out).not.toMatch(/match=matches/);
    const st = (await cli(h, ["status", "--json"])).json();
    const row = st.recent_receipts.find((x: { request_id: string }) => x.request_id === rid);
    expect(row.match.match).toBe("mismatch");
  });

  it("rotating the seat key makes old receipts mismatch the current link", async () => {
    const h = tmpHome();
    await readySeat(h);
    const rid = (await cli(h, [...RUN, "--json"])).json().request_id;
    await cli(h, ["init", "--seat", "42", "--rotate"]);
    await cli(h, ["link", "--token", "42"]);
    const m = (await cli(h, ["receipt", rid, "--json"])).json().match;
    expect(m.match).toBe("mismatch");
    expect(m.fields).toContain("did(link)");
  });
});

describe("rules in run", () => {
  it("rule 4: no --job, no run", async () => {
    const h = tmpHome();
    await readySeat(h);
    const r = await cli(h, ["run", "--prompt", "hi"]);
    expect(r.code).toBe(5);
    expect(r.err).toMatch(/real IMD jobs/);
  });

  it("rule 5: a broken link refuses; --no-link only for mock, clearly labeled", async () => {
    const h = tmpHome();
    await readySeat(h);
    const lf = join(h, "seats", "42", "link.json");
    const link = JSON.parse(readFileSync(lf, "utf8"));
    writeFileSync(lf, JSON.stringify({ ...link, statement: { ...link.statement, erc8004AgentId: "999" } }));
    const p = new MockProvider();
    const r = await cliP(h, RUN, p);
    expect(r.code).toBe(4);
    expect(p.calls).toBe(0);
    const bypass = await cli(h, [...RUN, "--no-link"]);
    expect(bypass.code).toBe(0);
    expect(bypass.err).toMatch(/--no-link: link check bypassed/);
    expect(bypass.out).toMatch(/LINK BYPASSED/);
    expect(bypass.out).toMatch(/match=mismatch/); // never OK without a verifying link
  });

  it("flop provider is gated: needs --live, and --no-link is refused", async () => {
    const h = tmpHome();
    await readySeat(h);
    expect((await cli(h, [...RUN, "--provider", "flop"])).code).toBe(5);
    const r = await cli(h, [...RUN, "--provider", "flop", "--live"]);
    expect(r.code).not.toBe(0); // no gateway key, no wallet-signed link: refused before any network
    expect(existsSync(join(h, "responses"))).toBe(false);
  });

  it("the live-run link check fails closed without ETH_RPC_URL and after a sale", async () => {
    const h = tmpHome();
    await readySeat(h);
    const noRpc = await checkLinkForRun(h, "42", true);
    expect(noRpc.ok).toBe(false);
    expect(noRpc.why.join()).toMatch(/ETH_RPC_URL/);
    const down = await checkLinkForRun(h, "42", true, { ethRpc: "https://rpc.example", fetch: (async () => { throw new Error("offline"); }) as typeof fetch });
    expect(down.ok).toBe(false);
    expect(down.why.join()).toMatch(/owner check failed/);
  });
});
