/**
 * Independent review of the fixes for the swarm audit of 33f3b9f (branch claude/audit-33f3b9f at 23b8df3).
 * Each test is named DEFECT <n> (<severity>) and asserts today's wrong behavior: it passes now and fails once
 * the defect is fixed. Stub providers, stub fetch and library calls only; no network (test/setup.ts).
 * The viewer's side of DEFECT 1 and DEFECT 8 is viewer/test_review_audit2.py.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendLedger, jobSpent, spentToday, utcDay, type LedgerEntry } from "../src/ledger.js";
import { keyFile, ledgerFile, receiptsDir } from "../src/paths.js";
import { ceilMicro, floorMicro } from "../src/rounding.js";
import { checkBudget, roomLeft } from "../src/policy.js";
import { assertPaidNetwork, readEthereumChainId, type Fetch } from "../src/gateway.js";
import { network } from "../src/networks.js";
import { runJob } from "../src/run.js";
import { scanForSecrets } from "../src/secrets.js";
import { listReceipts } from "../src/receipt-store.js";
import type { CompleteReq, CompleteRes, Provider } from "../src/providers.js";
import { cli, tmpHome } from "./helpers.js";

/** A full ledger row as run writes it: seat 7, provider mock, today, state sent. */
function row(id: string, extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    ts: new Date().toISOString(), day: utcDay(), request_id: id, seat: "7", did: "did:key:z", job: "j1", provider: "mock", network: "devnet",
    payer: "holder", model: "m", max_tokens: 8, prompt_sha256: "0", quote_raw: 0.1, quote_padded: 0.4, per_call_cap: 1, daily_cap: 1,
    job_budget: null, spent_before: 0, job_spent_before: null, state: "sent", reason: null, spend: null, spend_raw: null, cost_reported: null,
    cap_charge: 0.4, http: null, mock: true, ...extra,
  };
}

/** A grid amount from its integer numerator in millionths, read as JSON.parse reads its decimal text. */
const grid = (micro: bigint): number => Number(micro.toString().padStart(7, "0").replace(/(\d{6})$/, ".$1"));

/** A chain id answer whose JSON-RPC error message is whatever `say` builds from the request URL. */
const echoing = (say: (url: string) => string): Fetch =>
  (async (input: string | URL | Request) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: say(String(input)) } }), { status: 200 })) as Fetch;
const chainIdError = (url: string, say: (url: string) => string) => readEthereumChainId(url, echoing(say)).then(() => "no error", (e: Error) => e.message);

describe("review defect 1 (medium), fixed: a grid amount gets its exact numerator, totals are exact, and status agrees with the cap check", () => {
  it("review defect 1, fixed: ceilMicro and floorMicro of 16385.147313 are its numerator, and every grid amount just above 16384 FLOP is exact", () => {
    expect(ceilMicro(16385.147313)).toBe(16385147313);
    expect(floorMicro(16385.147313)).toBe(16385147313);
    let wrong = 0;
    for (let k = 16384_000_000n; k < 16384_020_000n; k++) if (ceilMicro(grid(k)) !== Number(k) || floorMicro(grid(k)) !== Number(k)) wrong++;
    expect(wrong).toBe(0);
  });

  it("review defect 1, fixed: spentToday of three tool-shaped grid charges is their exact BigInt sum", () => {
    const h = tmpHome();
    const charges = [282652198067846n, 68491002523412n, 329838119579963n];
    charges.forEach((c, i) => appendLedger(h, row(`mock-7-${i}`, { cap_charge: grid(c), quote_padded: grid(c) })));
    const exact = grid(charges.reduce((a, b) => a + b, 0n));
    expect(exact).toBe(680981320.171221);
    expect(spentToday(h, "7", "mock")).toBe(680981320.171221);
  });

  it("review defect 1, fixed: a call admitted exactly at the cap leaves status at the cap, not OVER CAP", async () => {
    const h = tmpHome();
    const x = 16385.147313;
    expect((await cli(h, ["init", "--seat", "7"])).code).toBe(0);
    expect((await cli(h, ["cap", "set", String(x), "--seat", "7", "--per-call", String(x)])).code).toBe(0);
    const spentBefore = spentToday(h, "7", "mock");
    expect(checkBudget({ padded: x, cap: { daily: x, perCall: x }, payer: "holder", spentBefore })).toBeNull();
    appendLedger(h, row("mock-7-at-cap", { cap_charge: x, quote_padded: x, daily_cap: x, per_call_cap: x, spent_before: spentBefore }));
    const st = await cli(h, ["status", "--seat", "7", "--json"]);
    expect(st.code).toBe(0);
    expect({ charged: st.json().today_utc.mock, over: st.json().over_cap_today_utc.mock }).toEqual({ charged: x, over: false });
  });

  it("review defect 1, fixed: imd-flop admits these triples, and the viewer agrees (test_review_audit2.py)", () => {
    for (const [cap, spent, charge] of [[16385.147313, 0, 16385.147313], [586607958.833559, 517124896.785768, 69483062.047791]]) {
      expect(checkBudget({ padded: charge, cap: { daily: cap, perCall: cap }, payer: "holder", spentBefore: spent })).toBeNull();
      expect(checkBudget({ padded: grid(BigInt(Math.round(charge * 1e6)) + 1n), cap: { daily: cap, perCall: cap }, payer: "holder", spentBefore: spent })).not.toBeNull();
    }
  });
});

describe("review defect 1 (medium), fixed: properties and the 1e9 bound", () => {
  const CONTRACT = join(import.meta.dirname, "..", "..", "contract");

  it("every random triple around the cap in contract/fixtures/cap-triples gets the shared answer (the viewer checks the same file)", () => {
    const { triples } = JSON.parse(readFileSync(join(CONTRACT, "fixtures", "cap-triples", "triples.json"), "utf8")) as { triples: [number, number, number, boolean, number, number][] };
    expect(triples.length).toBe(2000);
    const bad = triples.filter(([cap, spent, charge, over, , room]) => (checkBudget({ padded: charge, cap: { daily: cap, perCall: cap }, payer: "holder", spentBefore: spent }) !== null) !== over || roomLeft({ allowed: cap, spent }) !== room);
    expect(bad.slice(0, 3)).toEqual([]);
  });

  it("property: random ledgers of grid charges total exactly their BigInt sum", () => {
    let seed = 99;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const failures: string[] = [];
    for (let c = 0; c < 300; c++) {
      const h = tmpHome();
      const n = 1 + Math.floor(rnd() * 20);
      const micros = Array.from({ length: n }, () => BigInt(Math.floor(rnd() * (1e15 / n))));
      writeFileSync(ledgerFile(h), micros.map((m, i) => JSON.stringify(row(`mock-7-p${i}`, { cap_charge: grid(m) }))).join("\n") + "\n");
      const want = grid(micros.reduce((a, b) => a + b, 0n));
      const got = spentToday(h, "7", "mock");
      if (got !== want) failures.push(`${micros.join(",")}: ${got} != ${want}`);
    }
    expect(failures.slice(0, 3)).toEqual([]);
  });

  it("the bound is exact: a total of exactly AMOUNT_MAX is a known amount, one millionth above is not", () => {
    const at = tmpHome();
    writeFileSync(ledgerFile(at), [row("mock-7-a", { cap_charge: 999999999.999999 }), row("mock-7-b", { cap_charge: 0.000001 })].map((r) => JSON.stringify(r)).join("\n") + "\n");
    expect(spentToday(at, "7", "mock")).toBe(1e9);
    const above = tmpHome();
    writeFileSync(ledgerFile(above), [row("mock-7-a", { cap_charge: 1e9 }), row("mock-7-b", { cap_charge: 0.000001 })].map((r) => JSON.stringify(r)).join("\n") + "\n");
    expect(() => spentToday(above, "7", "mock")).toThrow(/above 1000000000 FLOP/);
  });
});

describe("DEFECT 2 (low): forms of the Ethereum RPC URL that outsideText does not replace reach stderr and the ledger reason raw", () => {
  const TOKEN = "AbCdEf0123456789xyzQ";
  it("DEFECT 2 (low): the path token alone, a query value without '?', a query cut after the key, a percent escape in other case, a cut URL and a host token are all kept", async () => {
    expect(await chainIdError(`https://eth.example.invalid/v2/${TOKEN}`, () => `invalid project id ${TOKEN}`)).toContain(TOKEN);
    expect(await chainIdError(`https://eth.example.invalid/rpc?apikey=${TOKEN}`, () => `bad apikey=${TOKEN}`)).toContain(TOKEN);
    expect(await chainIdError(`https://eth.example.invalid/rpc?apikey=${TOKEN}&chain=1`, (u) => `for ${u.replace("&chain=1", "")}`)).toContain(`?apikey=${TOKEN}`);
    expect(await chainIdError(`https://eth.example.invalid/v2/Ab%2F${TOKEN}`, () => `for https://eth.example.invalid/v2/Ab%2f${TOKEN}`)).toContain(TOKEN);
    expect(await chainIdError(`https://eth.example.invalid/v2/${TOKEN}`, (u) => `for ${u.slice(0, u.length - 2)}`)).toContain(TOKEN.slice(0, -2));
    expect(await chainIdError(`https://${TOKEN.toLowerCase()}.eth.example.invalid/`, () => `unknown host ${TOKEN.toLowerCase()}.eth.example.invalid`)).toContain(TOKEN.toLowerCase());
  });

  it("DEFECT 2 (low): at the pre-mint recheck the token lands in the refused_local reason in ledger.jsonl and on stderr", async () => {
    const h = tmpHome();
    expect((await cli(h, ["init", "--seat", "7"])).code).toBe(0);
    expect((await cli(h, ["cap", "set", "1", "--seat", "7"])).code).toBe(0);
    const rpc = `https://eth.example.invalid/v2/${TOKEN}`;
    const provider: Provider = {
      name: "mock",
      estimate: async () => ({ estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: 8 }),
      // The recheck FlopProvider.complete runs before the mint: a PaidGateError, a PreSendError.
      complete: async (_req: CompleteReq): Promise<CompleteRes> => {
        await assertPaidNetwork(network("devnet"), rpc, echoing(() => `project ${TOKEN} is over its limit`));
        throw new Error("unreachable");
      },
      readReceipt: async () => ({ http: 0, receipt: null, error: null }),
    } as unknown as Provider;
    let stderr = "";
    let code = 0;
    try {
      await runJob(h, provider, { job: "j1", prompt: "hi", maxTokens: 8, seat: "7", noLink: true, timeoutMs: 5000 }, { warn() {} });
    } catch (e) {
      stderr = (e as Error).message;
      code = (e as { code: number }).code;
    }
    expect(code).toBe(5);
    expect(stderr).toContain(TOKEN);
    const last = JSON.parse(readFileSync(ledgerFile(h), "utf8").trim().split("\n").at(-1)!);
    expect({ state: last.state, has: String(last.reason).includes(TOKEN) }).toEqual({ state: "refused_local", has: true });
  });
});

describe("DEFECT 3 (low): short URL forms are replaced everywhere in server text, before the secret scan", () => {
  it("DEFECT 3 (low): a one character password turns every digit 1 into the mark, so 'HTTP 401' reads 'HTTP 40[ETH_RPC_URL]'", async () => {
    expect(await chainIdError("https://user:1@eth.example.invalid/", () => "HTTP 401 for user at 10:15")).toBe("eth_chainId error: HTTP 40[ETH_RPC_URL] for [ETH_RPC_URL] at [ETH_RPC_URL]0:[ETH_RPC_URL]5");
  });

  it("DEFECT 3 (low): a short path such as /v2 hides the same text in an unrelated message", async () => {
    expect(await chainIdError("https://eth.example.invalid/v2", () => "endpoint /v2 retired, use /v3")).toBe("eth_chainId error: endpoint [ETH_RPC_URL] retired, use /v3");
  });

  it("DEFECT 3 (low): a short username form splits a 64 hex key in the server text, so the scan passes it and 60 of its 64 digits reach the message", async () => {
    const key = "0123456789abcdef".repeat(4);
    const msg = await chainIdError("https://a@eth.example.invalid/v2/tok", () => `leaked ${key}`);
    expect(scanForSecrets({ reason: key })).not.toEqual([]);
    expect(scanForSecrets({ reason: msg })).toEqual([]);
    expect(msg).toBe(`eth_chainId error: le[ETH_RPC_URL]ked ${key.split("a").join("[ETH_RPC_URL]")}`);
  });
});

describe("DEFECT 4 (low): a damaged seat key file puts part of the seed on stderr", () => {
  it("DEFECT 4 (low): link, init --rotate and run print JSON.parse's quote of the key file, ten characters of the base64 seed", async () => {
    const h = tmpHome();
    expect((await cli(h, ["init", "--seat", "7"])).code).toBe(0);
    expect((await cli(h, ["cap", "set", "1", "--seat", "7"])).code).toBe(0);
    const kf = keyFile(h, "7");
    const text = readFileSync(kf, "utf8");
    const seed = (JSON.parse(text) as { seed_b64: string }).seed_b64;
    writeFileSync(kf, text.replace(`"${seed}"`, seed)); // the quotes around the seed lost
    chmodSync(kf, 0o600);
    for (const args of [["link", "--token", "7"], ["init", "--seat", "7", "--rotate"], ["run", "--job", "j1", "--prompt", "hi", "--seat", "7", "--no-link"]]) {
      const r = await cli(h, args);
      expect({ args, code: r.code, leaks: r.err.includes(seed.slice(0, 10)) }).toEqual({ args, code: 1, leaks: true });
    }
  });
});

describe("DEFECT 5 (low): enroll --live puts the gateway's own text on stdout and stderr without outsideText", () => {
  const enrollFetch = (challengeBody: (ss58: string) => string, enrollBody: string): Fetch =>
    (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/enroll/wallet/challenge")) {
        const ss58 = decodeURIComponent(url.split("address=")[1]);
        return new Response(challengeBody(ss58), { status: 200 });
      }
      return new Response(enrollBody, { status: 403 });
    }) as Fetch;

  it("DEFECT 5 (low): a refused enroll prints the server's error field raw on stdout, a bearer token included", async () => {
    const h = tmpHome();
    expect((await cli(h, ["init", "--seat", "7"])).code).toBe(0);
    const bearer = "Bearer sk_live_0123456789abcdefXYZ";
    const r = await cli(h, ["enroll", "--live"], { fetch: enrollFetch((ss58) => JSON.stringify({ message: `enroll ${ss58}`, nonce: "n", expires_at: 1 }), JSON.stringify({ error: `wallet_unfunded; retry with ${bearer}` })) });
    expect(r.code).toBe(1);
    expect(scanForSecrets({ reason: bearer })).not.toEqual([]);
    expect(r.out).toContain(bearer);
  });

  it("DEFECT 5 (low): a challenge body that is not JSON is quoted on stderr through JSON.parse's message", async () => {
    const h = tmpHome();
    expect((await cli(h, ["init", "--seat", "7"])).code).toBe(0);
    const r = await cli(h, ["enroll", "--live"], { fetch: enrollFetch(() => "<html>proxy SeCrEtTiCkEt-42</html>", "{}") });
    expect(r.code).toBe(1);
    expect(r.err).toContain("<html>pro");
  });
});

describe("DEFECT 6 (low): receipt --refresh takes its seat from a ledger row without the seat rule and picks the gateway key by that text", () => {
  it("DEFECT 6 (low): a row whose seat is '../elsewhere' sends the bearer stored at <home>/elsewhere/gateway.key", async () => {
    const h = tmpHome();
    expect((await cli(h, ["init", "--seat", "42"])).code).toBe(0);
    mkdirSync(join(h, "elsewhere"), { recursive: true });
    writeFileSync(join(h, "elsewhere", "gateway.key"), "flop_ek_OTHERSEATBEARER0123456789\n", { mode: 0o600 });
    const rid = "imdflop-42-00112233aabbccdd";
    appendLedger(h, row(rid, { seat: "../elsewhere", provider: "flop", mock: false }));
    const auth: (string | null)[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      auth.push(new Request(input, init).headers.get("authorization"));
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }) as Fetch;
    const r = await cli(h, ["receipt", rid, "--refresh", "--live"], { fetch });
    expect(r.code).toBe(0);
    expect(auth).toEqual(["Bearer flop_ek_OTHERSEATBEARER0123456789"]);
  });
});

describe("DEFECT 7 (low): a job total above AMOUNT_MAX refuses that job on every later day, and the message names no line and no way back", () => {
  it("DEFECT 7 (low): requester rows of past days lock job j1 today; the exit 3 message has no ledger line and no repair step", async () => {
    const h = tmpHome();
    expect((await cli(h, ["init", "--seat", "7"])).code).toBe(0);
    expect((await cli(h, ["cap", "set", "1", "--seat", "7"])).code).toBe(0);
    expect((await cli(h, ["config", "set", "payer", "requester"])).code).toBe(0);
    // Two sent rows of earlier days whose charges a gateway amount raised (each a known amount, at most AMOUNT_MAX).
    appendLedger(h, row("mock-7-old-a", { day: "2026-01-01", payer: "requester", job_budget: 1e9, cap_charge: 6e8 }));
    appendLedger(h, row("mock-7-old-b", { day: "2026-01-02", payer: "requester", job_budget: 1e9, cap_charge: 6e8 }));
    expect(() => jobSpent(h, "j1", "mock")).toThrow(/above 1000000000 FLOP/);
    const r = await cli(h, ["run", "--job", "j1", "--prompt", "hi", "--seat", "7", "--no-link", "--job-budget", "1"]);
    expect(r.code).toBe(3);
    expect(r.err).not.toMatch(/ledger line \d+/);
    expect(r.err).not.toMatch(/repair|remove|new job/i);
  });
});

describe("DEFECT 8 (info): a receipt nested 10000 deep is read by imd-flop and unreadable to the viewer", () => {
  it("DEFECT 8 (info): listReceipts reads it as a receipt (viewer side in test_review_audit2.py)", () => {
    const h = tmpHome();
    mkdirSync(receiptsDir(h), { recursive: true });
    writeFileSync(join(receiptsDir(h), "mock-7-deep.json"), `{"request_id":"mock-7-deep","seat":"7","job":"j1","x":${"[".repeat(10000)}${"]".repeat(10000)}}`);
    const l = listReceipts(h);
    expect({ read: l.receipts.length, unreadable: l.unreadable }).toEqual({ read: 1, unreadable: [] });
  });
});

describe("DEFECT 9 (low): a canonical seat of 64 to 78 digits passes the seat rule, then the secret scan blocks it and leaves a seat no command can use", () => {
  it("DEFECT 9 (low): init exits 5, leaves flop.key without identity.json, then init says pass --rotate and --rotate says run init", async () => {
    const h = tmpHome();
    const seat = (2n ** 256n - 1n).toString();
    const first = await cli(h, ["init", "--seat", seat]);
    expect({ code: first.code, blocked: first.err.includes("secret scan blocked writing identity.json: seat") }).toEqual({ code: 5, blocked: true });
    expect(readFileSync(keyFile(h, seat), "utf8")).toContain("seed_b64");
    const again = await cli(h, ["init", "--seat", seat]);
    expect({ code: again.code, says: again.err.includes("pass --rotate") }).toEqual({ code: 5, says: true });
    const rotate = await cli(h, ["init", "--seat", seat, "--rotate"]);
    expect({ code: rotate.code, says: rotate.err.includes(`run \`imd-flop init --seat ${seat}\``) }).toEqual({ code: 2, says: true });
    // The shortest such seat: 64 digits.
    expect((await cli(tmpHome(), ["init", "--seat", "1" + "0".repeat(63)])).code).toBe(5);
  });
});

describe("DEFECT 10 (low): outsideText keeps control characters, so server text writes its own lines and terminal escapes to stderr", () => {
  it("DEFECT 10 (low): a JSON-RPC error message with a newline and ESC reaches the message as is", async () => {
    const msg = await chainIdError("https://eth.example.invalid/v2/tok", () => "x\n\u001b[1Aimd-flop: link verified, owner ok");
    expect(msg).toBe("eth_chainId error: x\n\u001b[1Aimd-flop: link verified, owner ok");
  });
});

describe("DEFECT 11 (low): the cut in outsideText splits a surrogate pair, so the ledger gets a lone surrogate the viewer cannot write", () => {
  it("DEFECT 11 (low): a 200 character cut through an emoji stores \\ud83d alone in the refused_local reason (viewer side in test_review_audit2.py)", async () => {
    const h = tmpHome();
    expect((await cli(h, ["init", "--seat", "7"])).code).toBe(0);
    expect((await cli(h, ["cap", "set", "1", "--seat", "7"])).code).toBe(0);
    const provider = {
      name: "mock",
      estimate: async () => ({ estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: 8 }),
      complete: async () => {
        await assertPaidNetwork(network("devnet"), "https://eth.example.invalid/v2/tok", echoing(() => "z".repeat(199) + "\u{1F600} after"));
        throw new Error("unreachable");
      },
      readReceipt: async () => ({ http: 0, receipt: null, error: null }),
    } as unknown as Provider;
    await expect(runJob(h, provider, { job: "j1", prompt: "hi", maxTokens: 8, seat: "7", noLink: true, timeoutMs: 5000 }, { warn() {} })).rejects.toThrow(/nothing sent/);
    const text = readFileSync(ledgerFile(h), "utf8");
    expect(text).toContain("z\\ud83d[cut]");
    expect(text).not.toContain("\\ude00");
  });
});
