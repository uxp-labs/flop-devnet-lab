/**
 * Independent review of the fixes for the swarm audit of 33f3b9f (branch claude/audit-33f3b9f at 23b8df3).
 * Each test is named DEFECT <n> (<severity>) and asserts today's wrong behavior: it passes now and fails once
 * the defect is fixed. Stub providers, stub fetch and library calls only; no network (test/setup.ts).
 * The viewer's side of DEFECT 1 and DEFECT 8 is viewer/test_review_audit2.py.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendLedger, jobSpent, spentToday, utcDay, type LedgerEntry } from "../src/ledger.js";
import { identityFile, keyFile, ledgerFile, receiptsDir } from "../src/paths.js";
import { ceilMicro, floorMicro } from "../src/rounding.js";
import { checkBudget, roomLeft } from "../src/policy.js";
import { assertPaidNetwork, ethRpcUrlMark, readEthereumChainId, type Fetch } from "../src/gateway.js";
import { network } from "../src/networks.js";
import { runJob } from "../src/run.js";
import { PreSendError } from "../src/gateway.js";
import { OUTSIDE_WITHHELD, outsideText, scanForSecrets } from "../src/secrets.js";
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

describe("review defect 2 (low), fixed: no form of the Ethereum RPC URL reaches a sink, because RPC server text is never quoted", () => {
  const TOKEN = "AbCdEf0123456789xyzQ";
  it("review defect 2, fixed: the path token, a query value, a cut query, an escape in other case, a cut URL and a host token are all gone", async () => {
    const cases: [string, (u: string) => string][] = [
      [`https://eth.example.invalid/v2/${TOKEN}`, () => `invalid project id ${TOKEN}`],
      [`https://eth.example.invalid/rpc?apikey=${TOKEN}`, () => `bad apikey=${TOKEN}`],
      [`https://eth.example.invalid/rpc?apikey=${TOKEN}&chain=1`, (u) => `for ${u.replace("&chain=1", "")}`],
      [`https://eth.example.invalid/v2/Ab%2F${TOKEN}`, () => `for https://eth.example.invalid/v2/Ab%2f${TOKEN}`],
      [`https://eth.example.invalid/v2/${TOKEN}`, (u) => `for ${u.slice(0, u.length - 2)}`],
      [`https://${TOKEN.toLowerCase()}.eth.example.invalid/`, () => `unknown host ${TOKEN.toLowerCase()}.eth.example.invalid`],
    ];
    for (const [url, say] of cases) expect(await chainIdError(url, say), url).toBe("eth_chainId error: JSON-RPC error code -32000");
  });

  it("review defect 2, fixed: at the pre-mint recheck neither the refused_local reason nor stderr holds the token", async () => {
    const h = tmpHome();
    expect((await cli(h, ["init", "--seat", "7"])).code).toBe(0);
    expect((await cli(h, ["cap", "set", "1", "--seat", "7"])).code).toBe(0);
    const rpc = `https://eth.example.invalid/v2/${TOKEN}`;
    const provider: Provider = {
      name: "mock",
      estimate: async () => ({ estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: 8 }),
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
    expect(stderr).toBe("nothing sent: eth_chainId error: JSON-RPC error code -32000");
    const last = JSON.parse(readFileSync(ledgerFile(h), "utf8").trim().split("\n").at(-1)!);
    expect({ state: last.state, reason: last.reason }).toEqual({ state: "refused_local", reason: stderr });
  });
});

describe("review defect 3 (low), fixed: a mark form shorter than 8 characters is not used, and the scan runs before the marks", () => {
  const mark = (rpc: string) => ethRpcUrlMark(rpc)!;
  it("review defect 3, fixed: a one character password does not touch 'HTTP 401'", () => {
    expect(outsideText("HTTP 401 for user at 10:15", { marks: [mark("https://user:1@eth.example.invalid/")] })).toBe("HTTP 401 for user at 10:15");
  });

  it("review defect 3, fixed: a short path such as /v2 is not hidden in other text", () => {
    expect(outsideText("endpoint /v2 retired, use /v3", { marks: [mark("https://eth.example.invalid/v2")] })).toBe("endpoint /v2 retired, use /v3");
  });

  it("review defect 3, fixed: a key in the text is withheld before any mark could split it", () => {
    const key = "0123456789abcdef".repeat(4);
    expect(outsideText(`leaked ${key}`, { marks: [mark("https://abcdefgh@eth.example.invalid/v2/tok")] })).toBe(OUTSIDE_WITHHELD);
    expect(outsideText(`leaked ${key}`)).toBe(OUTSIDE_WITHHELD);
  });

  it("review defect 3, fixed: an RPC error message is never quoted, whatever the URL", async () => {
    expect(await chainIdError("https://user:1@eth.example.invalid/", () => "HTTP 401 for user at 10:15")).toBe("eth_chainId error: JSON-RPC error code -32000");
  });
});

describe("review defect 4 (low), fixed: a damaged seat key file is named, never quoted", () => {
  it("review defect 4, fixed: link, init --rotate and run say the key file is malformed and print no character of it", async () => {
    const h = tmpHome();
    expect((await cli(h, ["init", "--seat", "7"])).code).toBe(0);
    expect((await cli(h, ["cap", "set", "1", "--seat", "7"])).code).toBe(0);
    const kf = keyFile(h, "7");
    const text = readFileSync(kf, "utf8");
    const seed = (JSON.parse(text) as { seed_b64: string }).seed_b64;
    for (const damaged of [text.replace(`"${seed}"`, seed), text.replace(seed, "!!" + seed.slice(2))]) {
      writeFileSync(kf, damaged);
      chmodSync(kf, 0o600);
      for (const args of [["link", "--token", "7"], ["init", "--seat", "7", "--rotate"], ["run", "--job", "j1", "--prompt", "hi", "--seat", "7", "--no-link"]]) {
        const r = await cli(h, args);
        expect({ args, code: r.code, malformed: r.err.includes(`key file for seat 7 ${kf} is malformed`), leaks: [seed.slice(2, 12), seed.slice(-10)].some((p) => r.err.includes(p)) }).toEqual({ args, code: 1, malformed: true, leaks: false });
      }
    }
  });
});

describe("review defect 5 (low), fixed: enroll --live shows the gateway's text only through outsideText", () => {
  const enrollFetch = (challengeBody: (ss58: string) => string, enrollBody: string): Fetch =>
    (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/enroll/wallet/challenge")) {
        const ss58 = decodeURIComponent(url.split("address=")[1]);
        return new Response(challengeBody(ss58), { status: 200 });
      }
      return new Response(enrollBody, { status: 403 });
    }) as Fetch;

  it("review defect 5, fixed: a refused enroll prints the server's error field through outsideText: a bearer in it is withheld", async () => {
    const h = tmpHome();
    expect((await cli(h, ["init", "--seat", "7"])).code).toBe(0);
    const bearer = "Bearer sk_live_0123456789abcdefXYZ";
    const r = await cli(h, ["enroll", "--live"], { fetch: enrollFetch((ss58) => JSON.stringify({ message: `enroll ${ss58}`, nonce: "n", expires_at: 1 }), JSON.stringify({ error: `wallet_unfunded; retry with ${bearer}` })) });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("sk_live");
    expect(r.json()).toMatchObject({ enrolled: false, http: 403, error: OUTSIDE_WITHHELD });
  });

  it("review defect 5, fixed: an error field with control characters or of another type is shown as safe text", async () => {
    const h = tmpHome();
    expect((await cli(h, ["init", "--seat", "7"])).code).toBe(0);
    const r = await cli(h, ["enroll", "--live"], { fetch: enrollFetch((ss58) => JSON.stringify({ message: `enroll ${ss58}`, nonce: "n", expires_at: 1 }), JSON.stringify({ error: { code: "wallet_unfunded" } })) });
    expect(r.json()).toMatchObject({ enrolled: false, error: '{"code":"wallet_unfunded"}' });
  });

  it("review defect 5, fixed: a challenge body that is not JSON is reported with a fixed sentence", async () => {
    const h = tmpHome();
    expect((await cli(h, ["init", "--seat", "7"])).code).toBe(0);
    const r = await cli(h, ["enroll", "--live"], { fetch: enrollFetch(() => "<html>proxy SeCrEtTiCkEt-42</html>", "{}") });
    expect(r.code).toBe(1);
    expect(r.err).toContain("the enroll challenge was not JSON");
    expect(r.err).not.toContain("<html");
    expect(r.err).not.toContain("SeCrEt");
  });
});

describe("review defect 6 (low), fixed: receipt --refresh uses a seat only when it passes the seat rule", () => {
  for (const seat of ["../elsewhere", "042"]) {
    it(`review defect 6, fixed: a row whose seat is ${JSON.stringify(seat)} is refused with exit 3, names the line, and sends nothing`, async () => {
      const h = tmpHome();
      expect((await cli(h, ["init", "--seat", "42"])).code).toBe(0);
      mkdirSync(join(h, "elsewhere"), { recursive: true });
      writeFileSync(join(h, "elsewhere", "gateway.key"), "flop_ek_OTHERSEATBEARER0123456789\n", { mode: 0o600 });
      const rid = "imdflop-42-00112233aabbccdd";
      appendLedger(h, row(rid, { seat, provider: "flop", mock: false }));
      const auth: (string | null)[] = [];
      const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        auth.push(new Request(input, init).headers.get("authorization"));
        return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      }) as Fetch;
      const r = await cli(h, ["receipt", rid, "--refresh", "--live"], { fetch });
      expect({ code: r.code, auth, named: r.err.includes("ledger line 1 has seat") }, r.err).toEqual({ code: 3, auth: [], named: true });
    });
  }

  it("review defect 6, fixed: a stored receipt whose seat is not usable is refused the same way and named", async () => {
    const h = tmpHome();
    expect((await cli(h, ["init", "--seat", "42"])).code).toBe(0);
    const rid = "mock-42-00112233aabbccdd";
    appendLedger(h, row(rid, { seat: "42" }));
    mkdirSync(receiptsDir(h), { recursive: true });
    writeFileSync(join(receiptsDir(h), `${rid}.json`), JSON.stringify({ request_id: rid, job: "j1", seat: "../x", provider: "mock", state: "estimated" }));
    const r = await cli(h, ["receipt", rid, "--refresh"]);
    expect({ code: r.code, named: r.err.includes(`the receipt file of ${rid} has seat "../x"`) }, r.err).toEqual({ code: 3, named: true });
  });
});

describe("review defect 7 (low), fixed: a job total above AMOUNT_MAX names the job, its rows and lines, and the way back", () => {
  it("review defect 7, fixed: the exit 3 message names job j1, two rows on lines 1 and 2, and a new job id or a repair", async () => {
    const h = tmpHome();
    expect((await cli(h, ["init", "--seat", "7"])).code).toBe(0);
    expect((await cli(h, ["cap", "set", "1", "--seat", "7"])).code).toBe(0);
    expect((await cli(h, ["config", "set", "payer", "requester"])).code).toBe(0);
    appendLedger(h, row("mock-7-old-a", { day: "2026-01-01", payer: "requester", job_budget: 1e9, cap_charge: 6e8 }));
    appendLedger(h, row("mock-7-old-b", { day: "2026-01-02", payer: "requester", job_budget: 1e9, cap_charge: 6e8 }));
    const r = await cli(h, ["run", "--job", "j1", "--prompt", "hi", "--seat", "7", "--no-link", "--job-budget", "1"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("the requester total of job j1 (mock) is above 1000000000 FLOP");
    expect(r.err).toContain("It is made of 2 rows, ledger lines 1 and 2. The way back: use a new job id, or repair those lines.");
    const other = await cli(h, ["run", "--job", "j2", "--prompt", "hi", "--seat", "7", "--no-link", "--job-budget", "1"]);
    expect(other.code, other.err).toBe(0);
  });

  it("review defect 7, fixed: more than five rows are named by the first and the last line", () => {
    const h = tmpHome();
    for (let i = 0; i < 7; i++) appendLedger(h, row(`mock-7-r${i}`, { day: `2026-01-0${i + 1}`, payer: "requester", job_budget: 1e9, cap_charge: 2e8 }));
    expect(() => jobSpent(h, "j1", "mock")).toThrow("It is made of 7 rows, ledger lines 1 (the first) to 7 (the last).");
  });
});

describe("review defect 8 (info), fixed: receipt files follow the depth rule in both readers", () => {
  const DIR = join(import.meta.dirname, "..", "..", "contract", "fixtures", "receipt-text");
  it("review defect 8, fixed: every receipt fixture is read as contract/fixtures/receipt-text/expectations.json says (the viewer reads the same files)", () => {
    const files = JSON.parse(readFileSync(join(DIR, "expectations.json"), "utf8")).files as Record<string, { readable: boolean }>;
    expect(readdirSync(DIR).filter((f) => f !== "expectations.json").sort()).toEqual(Object.keys(files).sort());
    for (const [name, want] of Object.entries(files)) {
      const h = tmpHome();
      mkdirSync(receiptsDir(h), { recursive: true });
      writeFileSync(join(receiptsDir(h), "r1.json"), readFileSync(join(DIR, name)));
      const l = listReceipts(h);
      expect({ name, read: l.receipts.length === 1 }).toEqual({ name, read: want.readable });
    }
  });

  it("review defect 8, fixed: listReceipts lists a receipt nested 10000 deep as unreadable", () => {
    const h = tmpHome();
    mkdirSync(receiptsDir(h), { recursive: true });
    writeFileSync(join(receiptsDir(h), "mock-7-deep.json"), `{"request_id":"mock-7-deep","seat":"7","job":"j1","x":${"[".repeat(10000)}${"]".repeat(10000)}}`);
    const l = listReceipts(h);
    expect({ read: l.receipts.length, unreadable: l.unreadable }).toEqual({ read: 0, unreadable: ["mock-7-deep.json"] });
  });
});

describe("review defect 9 (low), fixed: a seat has at most 63 digits, and init never strands a seat", () => {
  it("review defect 9, fixed: a seat of 64 to 78 digits is exit 2 with the reason in plain words, and writes nothing", async () => {
    for (const seat of [(2n ** 256n - 1n).toString(), "1" + "0".repeat(63)]) {
      const h = tmpHome();
      const r = await cli(h, ["init", "--seat", seat]);
      expect({ code: r.code, says: r.err.includes("a number that long cannot be told from a key by the secret scan") }).toEqual({ code: 2, says: true });
      expect(existsSync(keyFile(h, seat))).toBe(false);
    }
    expect((await cli(tmpHome(), ["init", "--seat", "9".repeat(63)])).code).toBe(0);
  });

  it("review defect 9, fixed: a key file with no identity.json is completed from that key, with no second key", async () => {
    const h = tmpHome();
    const first = await cli(h, ["init", "--seat", "7", "--json"]);
    expect(first.code).toBe(0);
    const did = first.json().did as string;
    const key = readFileSync(keyFile(h, "7"), "utf8");
    unlinkSync(identityFile(h, "7"));
    const again = await cli(h, ["init", "--seat", "7", "--json"]);
    expect({ code: again.code, did: again.json().did, completed: typeof again.json().completed }).toEqual({ code: 0, did, completed: "string" });
    expect(readFileSync(keyFile(h, "7"), "utf8")).toBe(key);
    // Now whole: a second init refuses as for any seat with a key.
    expect((await cli(h, ["init", "--seat", "7"])).code).toBe(5);
    expect((await cli(h, ["link", "--token", "7"])).code).toBe(0);
  });

  it("review defect 9, fixed: a seat that is not canonical says where it came from", async () => {
    const h = tmpHome();
    expect((await cli(h, ["cap", "set", "1", "--seat", "042"])).err).toContain("seat from the command line must be written without leading zeros");
    expect((await cli(h, ["init", "--seat", "7"])).code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(h, "config.json"), "utf8"));
    writeFileSync(join(h, "config.json"), JSON.stringify({ ...cfg, seat: "07" }));
    expect((await cli(h, ["cap", "show"])).err).toContain("seat from config.json must be written without leading zeros: write 7, not 07");
  });
});

describe("review defect 10 (low), fixed: outside text cannot write its own lines or terminal escapes", () => {
  it("review defect 10, fixed: a newline and ESC each become one space", () => {
    expect(outsideText("x\n\u001b[1Aimd-flop: link verified, owner ok")).toBe("x  [1Aimd-flop: link verified, owner ok");
  });

  it("review defect 10, fixed: every Cc, Cf, Zl and Zp code point and a lone surrogate become one space, before the cut", () => {
    expect(outsideText("a\r\tb\u0085c\u200bd\u202ee\u2028f\u2029g\ud800h\udfffi")).toBe("a  b c d e f g h i");
    expect(outsideText("\u{1F600} keeps its pair")).toBe("\u{1F600} keeps its pair");
    expect(outsideText("\u0007".repeat(10) + "tail", { max: 12 })).toBe("          ta[cut]");
  });

  it("review defect 10, fixed: a pre-send failure with a newline reaches stderr and the ledger on one line", async () => {
    const h = tmpHome();
    expect((await cli(h, ["init", "--seat", "7"])).code).toBe(0);
    expect((await cli(h, ["cap", "set", "1", "--seat", "7"])).code).toBe(0);
    const provider = {
      name: "mock",
      estimate: async () => ({ estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: 8 }),
      complete: async () => { throw new PreSendError("mint failed\nimd-flop: all good"); },
      readReceipt: async () => ({ http: 0, receipt: null, error: null }),
    } as unknown as Provider;
    const err = await runJob(h, provider, { job: "j1", prompt: "hi", maxTokens: 8, seat: "7", noLink: true, timeoutMs: 5000 }, { warn() {} }).then(() => null, (e: Error) => e.message);
    expect(err).toBe("nothing sent: mint failed imd-flop: all good");
  });
});

describe("review defect 11 (low), fixed: the cut is on code point boundaries", () => {
  it("review defect 11, fixed: a cut through an emoji keeps it whole or drops it, never half (viewer side in test_review_audit2.py)", async () => {
    const h = tmpHome();
    expect((await cli(h, ["init", "--seat", "7"])).code).toBe(0);
    expect((await cli(h, ["cap", "set", "1", "--seat", "7"])).code).toBe(0);
    const provider = {
      name: "mock",
      estimate: async () => ({ estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: 8 }),
      complete: async () => { throw new PreSendError("z".repeat(999) + "\u{1F600} after"); },
      readReceipt: async () => ({ http: 0, receipt: null, error: null }),
    } as unknown as Provider;
    await expect(runJob(h, provider, { job: "j1", prompt: "hi", maxTokens: 8, seat: "7", noLink: true, timeoutMs: 5000 }, { warn() {} })).rejects.toThrow(/nothing sent/);
    const text = readFileSync(ledgerFile(h), "utf8");
    expect(text).toContain("z\u{1F600}[cut]");
    expect(text).not.toMatch(/\\ud83d|\\ude00/);
    expect(outsideText("ab\u{1F600}cd", { max: 3 })).toBe("ab\u{1F600}[cut]");
  });
});

describe("surviving mutants of the review: gateway.ts", () => {
  const BEARER = "Bearer sk_live_0123456789abcdefXYZ";

  it("the decoded form of the URL is a mark: a password escaped in the URL and repeated decoded is hidden", () => {
    const m = ethRpcUrlMark("https://user:p%40ssw0rd-long@eth.example.invalid/v2/x")!;
    expect(outsideText("rejected p@ssw0rd-long here", { marks: [m] })).toBe("rejected [ETH_RPC_URL] here");
  });

  it("the query is a mark of its own", () => {
    const m = ethRpcUrlMark("https://eth.example.invalid/rpc?apikey=QQQQ1234")!;
    expect(outsideText("bad ?apikey=QQQQ1234 given", { marks: [m] })).toBe("bad [ETH_RPC_URL] given");
  });

  it("a path of / is never a mark: it would replace every slash", () => {
    const m = ethRpcUrlMark("https://eth.example.invalid/")!;
    expect(outsideText("a/b and c/d", { marks: [m] })).toBe("a/b and c/d");
  });

  it("the FLOP RPC's error text goes through outsideText: a bearer in it is withheld", async () => {
    const real = globalThis.WebSocket;
    class WS {
      onopen?: () => void;
      onmessage?: (ev: { data: string }) => void;
      constructor() { setTimeout(() => this.onopen?.(), 0); }
      static data = "";
      send() { setTimeout(() => this.onmessage?.({ data: WS.data }), 0); }
      close() {}
    }
    (globalThis as { WebSocket: unknown }).WebSocket = WS;
    try {
      const { checkGenesis } = await import("../src/gateway.js");
      const faucet500 = (async () => new Response("{}", { status: 500 })) as Fetch;
      WS.data = JSON.stringify({ error: { message: `denied ${BEARER}` } });
      const g = await checkGenesis(network("devnet"), faucet500);
      expect(g.error).toContain("rpc unavailable: rpc error: [withheld by the secret scan]");
      expect(g.error).not.toContain("sk_live");
      // A frame that is not JSON: JSON.parse's own message would quote it. Only a fixed sentence is given.
      WS.data = `<html>${BEARER}</html>`;
      const raw = await checkGenesis(network("devnet"), faucet500);
      expect(raw.error).toContain("rpc unavailable: rpc returned malformed JSON");
      expect(raw.error).not.toContain("<html");
      // Any other error on the way (here the socket itself fails) is outside text too: through outsideText.
      (globalThis as { WebSocket: unknown }).WebSocket = class { constructor() { throw new Error(`socket said\n${BEARER}`); } };
      const thrown = await checkGenesis(network("devnet"), faucet500);
      expect(thrown.error).toContain("rpc unavailable: [withheld by the secret scan]");
    } finally {
      globalThis.WebSocket = real;
    }
  });

  it("a child key mint transport error goes through outsideText: a bearer in it is withheld", async () => {
    const { mintChildKey } = await import("../src/gateway.js");
    const f = (async () => { throw new Error(`proxy said ${BEARER}`); }) as Fetch;
    const m = await mintChildKey(network("devnet"), "flop_ek_PARENTPARENTPARENT00", { model: "m", maxSpend: 0.1 }, f).then(() => "ok", (e: Error) => e.message);
    expect(m).toBe("child key mint failed (Error: [withheld by the secret scan])");
  });
});

describe("surviving mutants of the review: store.ts, keys.ts, ledger-text.ts, secrets.ts, run.ts", () => {
  it("store.ts: a file of one byte that is not a newline still gets a newline first; a final \\r is not a fresh line", async () => {
    const { appendJsonlSafe } = await import("../src/store.js");
    const h = tmpHome();
    for (const [start, want] of [["{", '{\n{"a":1}\n'], ["\n", '\n{"a":1}\n'], ['{"b":2}\r', '{"b":2}\r\n{"a":1}\n']]) {
      const p = join(h, `f${start.charCodeAt(0)}.jsonl`);
      writeFileSync(p, start);
      appendJsonlSafe(p, { a: 1 });
      expect(readFileSync(p, "utf8"), JSON.stringify(start)).toBe(want);
    }
  });

  it("keys.ts: a seat id is the whole string, so a newline before or after the digits is not a seat", async () => {
    const { isSeatId } = await import("../src/keys.js");
    for (const v of ["42\n", "x\n42", "\n42", "42\nx"]) expect(isSeatId(v), JSON.stringify(v)).toBe(false);
  });

  it("ledger-text.ts: each ] and } closes a level, and the count is never floored at 0 (the fixtures depth-siblings and depth-unbalanced-closers pin both readers)", async () => {
    const { nestedTooDeep } = await import("../src/ledger-text.js");
    expect(nestedTooDeep(`{"x":[${Array(40).fill("[1]").join(",")}]}`)).toBe(false);
    expect(nestedTooDeep(`{"x":[${Array(40).fill('{"a":1}').join(",")}]}`)).toBe(false);
    expect(nestedTooDeep("]]]]" + "[".repeat(33))).toBe(false);
    expect(nestedTooDeep("[".repeat(33))).toBe(true);
  });

  it("secrets.ts: the longest form of a mark is replaced first, whatever order the forms come in", () => {
    expect(outsideText("at abcdefghijkl now", { marks: [{ forms: ["abcdefgh", "abcdefghijkl"], mark: "[M]" }] })).toBe("at [M] now");
  });

  it("secrets.ts: the scan runs before the cut, so a key past the cut still withholds the text", () => {
    expect(outsideText("y".repeat(995) + " Bearer abcdefgh12345678")).toBe(OUTSIDE_WITHHELD);
    expect(outsideText("y".repeat(995) + " " + "ab".repeat(32))).toBe(OUTSIDE_WITHHELD);
  });

  it("run.ts: a timeout's error name goes through outsideText too", async () => {
    const h = tmpHome();
    expect((await cli(h, ["init", "--seat", "7"])).code).toBe(0);
    expect((await cli(h, ["cap", "set", "1", "--seat", "7"])).code).toBe(0);
    const provider = {
      name: "mock",
      estimate: async () => ({ estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: 8 }),
      complete: async () => { const e = new Error("gone"); e.name = "Time\nout Bearer abcdefgh12345678"; throw e; },
      readReceipt: async () => ({ http: 0, receipt: null, error: null }),
    } as unknown as Provider;
    const code = await runJob(h, provider, { job: "j1", prompt: "hi", maxTokens: 8, seat: "7", noLink: true, timeoutMs: 5000 }, { warn() {} }).then(() => 0, (e: { code: number }) => e.code);
    const last = JSON.parse(readFileSync(ledgerFile(h), "utf8").trim().split("\n").at(-1)!);
    expect({ code, state: last.state, reason: last.reason }).toEqual({ code: 6, state: "timeout_unknown", reason: `${OUTSIDE_WITHHELD}: no answer; spend unknown, not retried` });
  });
});
